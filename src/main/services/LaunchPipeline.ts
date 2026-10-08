import { publicEndpoint } from "../../shared/executionPolicy.ts";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  LaunchProfileId,
  PluginLaunchFieldOptions,
  PluginLaunchValues,
  PluginServiceLaunch,
  ProviderId,
  SessionRole
} from "../../shared/contracts.ts";
import { claudeCoreSettingsKey, coreOwnedLaunchArgument, parseInlineSettings } from "./terminalLaunch.ts";
import { MAX_PLUGIN_SLOT_BYTES } from "./TerminalSessionStore.ts";
import { LaunchRefusal } from "./launchRefusal.ts";
import { MAX_INSPECTED_CONFIG_BYTES, parseJsonc, readInspectedFile } from "./inspectedConfig.ts";
import { selectedAccountHome, selectedAccountId, ACCOUNTS_PLUGIN_ID } from "./accountHomeIsolation.ts";
import { accountContributionDomains } from "./isolation/configuredApiDomains.ts";

/** A trusted plugin service that declared launch options (PluginManager.launchContributors). */
export interface LaunchContributor {
  pluginId: string;
  pluginName: string;
  serviceId: string;
  launch: PluginServiceLaunch;
  /** Host-computed private data directory. Never sent to the plugin or accepted from its RPC response. */
  dataDir?: string;
  /** The plugin holds the `secrets` permission, so `secretEnv` may name its secrets. */
  secrets: boolean;
}

export interface LaunchPipelineDependencies {
  contributors(): LaunchContributor[];
  call(pluginId: string, serviceId: string, method: "canvastty.launch.prepare" | "canvastty.launch.options", params: unknown, timeoutMs: number): Promise<unknown>;
  /** Reads one of the plugin's own secrets in this process; the value never reaches plugin code or UI. */
  secret(pluginId: string, key: string): Promise<string | null>;
  /** Per-run file folders live below this directory; it is emptied at startup. */
  runsRoot: string;
  timeoutMs?: number;
}

/** What a launch service receives (`canvastty.launch.prepare`). */
export interface LaunchContext {
  sessionId: string;
  provider: ProviderId;
  profile: LaunchProfileId;
  role: SessionRole;
  cwd: string;
  /** Original person-selected task project, retained when an environment relocates cwd. Host-owned. */
  projectRoot?: string;
  parentSessionId?: string;
  /** True when the app is bringing back a saved session. */
  restoring: boolean;
  /** True when the provider continues an earlier conversation. */
  resume: boolean;
  /** This plugin's saved option values for this session; empty when `chosen` is false. */
  options: PluginLaunchValues;
  /** The person chose this plugin for the launch; false for a launch policy check, whose answer may only refuse. */
  chosen: boolean;
  /** Where the card runs (the chosen or saved environment), or null on this computer. */
  environment: { pluginId: string; kind: string } | null;
  /**
   * A subagent on this computer whose folder is the one the person chose for its top-level agent, or inside it: that
   * folder's real path, which the person already vouched for. A plugin that keeps the agent's own config home may mark
   * it trusted there for this run's agent; absent otherwise.
   */
  trustedFolder?: string;
  /** Host capability: request public route evidence from the selected Accounts producer. */
  accountRouteEvidence?: true;
}

export type LaunchSessionContext = Omit<LaunchContext, "options" | "chosen"> & { options: Record<string, PluginLaunchValues> };

export interface AccountRouteEvidence {
  model: string;
  endpoint: string;
  kind: "ollama" | "ollama-cloud" | "api-key";
}

export type PreparedLaunch =
  | {
    ok: true;
    env: Record<string, string>;
    args: string[];
    /** Values of `secretEnv`, masked in every agent-readable text for the session's lifetime. */
    secrets: string[];
    /** Env name -> plugin name, to name the plugin when a core variable collides. */
    envSources: Record<string, string>;
    /** A contributor runs the agent on another model than its vendor's: "auto" becomes accept-edits. */
    thirdPartyModel: boolean;
    /** Host-derived selected Accounts CLI home, passed transiently to AgentIsolation for exact-path validation. */
    accountHome?: string;
    accountId?:string;
    accountRoute?: AccountRouteEvidence;
    /** Model API hosts of the selected model account (allowed-domains mode keeps them reachable). */
    apiDomains?: string[];
    cleanup(): Promise<void>;
  }
  | { ok: false; reason: string };

const LAUNCH_PREPARE_TIMEOUT_MS = 5_000;
/** How long the launcher waits for a service's extra select choices before showing the declared ones only. */
const LAUNCH_OPTIONS_TIMEOUT_MS = 3_000;
const MAX_SERVICE_OPTIONS = 64;
/** Replaced in env values and args with the plugin's folder of written files for this run. */
const LAUNCH_FILES_TOKEN = "{launchFiles}";
const MAX_OPTION_PLUGINS = 16;
export const MAX_ENV = 32;
export const MAX_ENV_VALUE_BYTES = 8 * 1024;
export const MAX_SECRET_ENV = 16;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 1_024;
const MAX_FILES = 16;
const MAX_FILES_BYTES = 256 * 1024;
const MAX_REASON = 240;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/**
 * How the operating system tells environment names apart: Windows ignores case (`Path` and `PATH` are one
 * variable), so two spellings of one name must collide there.
 */
export function envKey(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

/** Names that steer CanvasTTY itself or the process loader, never a plugin's to set. */
export const RESERVED_ENV = /^(?:CANVASTTY_|ELECTRON_|DYLD_|LD_)|^(?:NODE_OPTIONS|PATH|TERM|COLORTERM)$/i;

export class LaunchPipeline {
  private readonly dependencies: LaunchPipelineDependencies;
  private readonly timeoutMs: number;

  constructor(dependencies: LaunchPipelineDependencies) {
    this.dependencies = dependencies;
    this.timeoutMs = dependencies.timeoutMs ?? LAUNCH_PREPARE_TIMEOUT_MS;
  }

  /** Whether this plugin declared its launch options safe for an orchestrator to choose (`launch.delegable`). */
  delegable(pluginId: string): boolean {
    return this.dependencies.contributors().some((candidate) => candidate.pluginId === pluginId && candidate.launch.delegable === true);
  }

  /** Removes file folders left by a previous run of the app. */
  clearRuns(): Promise<void> {
    return rm(this.dependencies.runsRoot, { recursive: true, force: true });
  }

  /** Removes a closed session's file folders. */
  forgetSession(sessionId: string): Promise<void> {
    return rm(join(this.dependencies.runsRoot, safeSegment(sessionId)), { recursive: true, force: true });
  }

  /** Launch policies that apply to this agent: every launch of it asks them, chosen or not. */
  hasPolicy(provider: ProviderId): boolean {
    return provider !== "terminal" && this.policies(provider, []).length > 0;
  }

  private policies(provider: ProviderId, selected: readonly string[]): LaunchContributor[] {
    if (provider === "terminal") return [];
    return this.dependencies.contributors().filter((contributor) => contributor.launch.policy === true
      && !selected.includes(contributor.pluginId)
      && (!contributor.launch.appliesTo || contributor.launch.appliesTo.includes(provider as never)));
  }

  /** Plugin ids among saved options that cannot prepare a launch now. */
  unavailable(options: Record<string, unknown>): string[] {
    const available = new Set(this.dependencies.contributors().map((contributor) => contributor.pluginId));
    return Object.keys(options).filter((pluginId) => !available.has(pluginId)).sort();
  }

  /**
   * Checks launcher values against each plugin's declared fields and fills defaults.
   * Throws with a person-readable reason; returns undefined when nothing was chosen.
   */
  normalizeOptions(provider: ProviderId, candidate: unknown,
    context?: { delegated?: boolean; inherited?: Readonly<Record<string, Readonly<Record<string, boolean | string>>>> }): Record<string, PluginLaunchValues> | undefined {
    if (candidate === undefined) return undefined;
    if (!isRecord(candidate) || Object.keys(candidate).length > MAX_OPTION_PLUGINS) throw new Error("Launch options are invalid.");
    if (Object.keys(candidate).length === 0) return undefined;
    if (provider === "terminal") throw new Error("A plain terminal takes no launch options.");
    const contributors = new Map(this.dependencies.contributors().map((contributor) => [contributor.pluginId, contributor]));
    const options: Record<string, PluginLaunchValues> = {};
    for (const [pluginId, raw] of Object.entries(candidate)) {
      const contributor = contributors.get(pluginId);
      if (!contributor) throw new Error(unavailableReason(pluginId));
      // An orchestrator picks options for its subagents only where the plugin said that is safe.
      if (context?.delegated && contributor.launch.delegable !== true && !sameAsInherited(raw, context.inherited?.[pluginId])) {
        throw new LaunchRefusal(`${contributor.pluginName} has not declared its launch options safe for an orchestrator to choose; only the person chooses them, in the launcher.`);
      }
      const { appliesTo, fields } = contributor.launch;
      if (appliesTo && !appliesTo.includes(provider as never)) {
        throw new Error(`${contributor.pluginName} launch options do not apply to ${provider}.`);
      }
      if (!isRecord(raw)) throw new Error(`${contributor.pluginName} launch options are invalid.`);
      const known = new Set(fields.map((field) => field.key));
      const unknown = Object.keys(raw).find((key) => !known.has(key));
      if (unknown) throw new Error(`${contributor.pluginName} has no launch option ${unknown.slice(0, 40)}.`);
      const values: PluginLaunchValues = {};
      for (const field of fields) {
        const value = raw[field.key] ?? field.default
          ?? (field.kind === "boolean" ? false : field.kind === "select" ? field.options?.[0]?.value ?? "" : "");
        const plainText = (limit: number): boolean => typeof value === "string" && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
        // A service-provided choice may have changed since the launcher showed it: the service checks it when it prepares.
        const valid = field.kind === "boolean"
          ? typeof value === "boolean"
          : field.kind === "select"
            ? typeof value === "string" && (Boolean(field.options?.some((option) => option.value === value)) || (field.optionsFrom === "service" && plainText(200)))
            : plainText(field.maxLength ?? 200);
        if (!valid) throw new Error(`${contributor.pluginName} launch option ${field.label} is invalid.`);
        values[field.key] = value as boolean | string;
      }
      if (Buffer.byteLength(JSON.stringify(values), "utf8") > MAX_PLUGIN_SLOT_BYTES) {
        throw new Error(`${contributor.pluginName} launch options exceed 4 KB.`);
      }
      options[pluginId] = values;
    }
    return options;
  }

  /**
   * The extra choices a plugin's service offers for its `optionsFrom: "service"` selects, for the launcher. Any
   * failure (no such fields, not running, timeout, invalid answer) leaves only the declared choices.
   */
  async fieldOptions(pluginId: string, provider: ProviderId): Promise<PluginLaunchFieldOptions> {
    const contributor = this.dependencies.contributors().find((candidate) => candidate.pluginId === pluginId);
    if (!contributor || provider === "terminal") return {};
    if (contributor.launch.appliesTo && !contributor.launch.appliesTo.includes(provider as never)) return {};
    const fields = contributor.launch.fields.filter((field) => field.kind === "select" && field.optionsFrom === "service");
    if (fields.length === 0) return {};
    let timer: NodeJS.Timeout | undefined;
    let answer: unknown;
    try {
      answer = await Promise.race([
        this.dependencies.call(pluginId, contributor.serviceId, "canvastty.launch.options",
          { provider, fields: fields.map((field) => field.key) }, LAUNCH_OPTIONS_TIMEOUT_MS),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new TimeoutError()), LAUNCH_OPTIONS_TIMEOUT_MS); })
      ]);
    } catch {
      return {};
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!isRecord(answer)) return {};
    const result: PluginLaunchFieldOptions = {};
    for (const field of fields) {
      const offered = answer[field.key];
      if (!Array.isArray(offered)) continue;
      const seen = new Set(field.options?.map((option) => option.value));
      const choices: Array<{ value: string; label: string }> = [];
      for (const option of offered.slice(0, MAX_SERVICE_OPTIONS)) {
        if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") continue;
        const { value, label } = option;
        if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value) || seen.has(value)) continue;
        const shown = label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
        if (!shown) continue;
        seen.add(value);
        choices.push({ value, label: shown });
      }
      if (choices.length > 0) result[field.key] = choices;
    }
    return result;
  }

  /**
   * Asks every selected plugin to prepare this launch, and every launch policy that applies. Contributors run
   * side by side and are merged in plugin-id order. Any refusal, timeout, error, invalid answer or conflict
   * refuses the whole launch with a reason; nothing is ever launched without a contribution the person selected,
   * or past a policy that did not answer.
   */
  async prepare(context: LaunchSessionContext): Promise<PreparedLaunch> {
    const contributors = new Map(this.dependencies.contributors().map((contributor) => [contributor.pluginId, contributor]));
    const selected = Object.keys(context.options).sort();
    for (const pluginId of selected) {
      if (!contributors.has(pluginId)) return { ok: false, reason: unavailableReason(pluginId) };
    }
    const policies = this.policies(context.provider, selected).sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    const answers = await Promise.all([
      ...selected.map((pluginId) => this.ask(contributors.get(pluginId)!, context, true)),
      ...policies.map((contributor) => this.ask(contributor, context, false))
    ]);
    const runDirectory = join(this.dependencies.runsRoot, safeSegment(context.sessionId), randomUUID());
    const cleanup = (): Promise<void> => rm(runDirectory, { recursive: true, force: true });
    const refuse = async (reason: string): Promise<PreparedLaunch> => {
      await cleanup().catch(() => undefined);
      return { ok: false, reason };
    };

    const env: Record<string, string> = {};
    const envSources: Record<string, string> = {};
    /**
     * Who set each name, by how the operating system compares names (envKey). A Map, so a name like `constructor`
     * is never mistaken for an inherited value.
     */
    const claimed = new Map<string, string>();
    const args: string[] = [];
    const secrets: string[] = [];
    let thirdPartyModel = false;
    let accountHome: string | undefined;
    let accountId:string|undefined;
    let accountRoute: AccountRouteEvidence | undefined;
    const apiDomains = new Set<string>();
    for (const answer of answers) {
      if ("refuse" in answer) return refuse(answer.refuse);
    }
    for (const answer of answers as Array<{ contributor: LaunchContributor; contribution: Contribution }>) {
      const { contributor, contribution } = answer;
      const name = contributor.pluginName;
      if (contribution.accountRoute !== undefined) {
        if (contributor.pluginId !== ACCOUNTS_PLUGIN_ID || !context.accountRouteEvidence || !contribution.accountId) {
          return refuse(`${name} cannot supply account route evidence for this launch.`);
        }
        accountRoute = { ...contribution.accountRoute };
      }
      if(contribution.accountId!==undefined) {
        if(contributor.pluginId!==ACCOUNTS_PLUGIN_ID)return refuse(`${name} cannot attribute the selected model account.`);
        if(contribution.accountId!==selectedAccountId(context.options))return refuse(`${name} returned an account attribution that differs from the selected account.`);
        accountId=contribution.accountId;
      }
      if (contributor.pluginId === ACCOUNTS_PLUGIN_ID) for (const host of accountContributionDomains(contribution)) apiDomains.add(host);
      if (context.provider === "terminal" && contribution.args.length > 0) {
        return refuse(`${name} added arguments to a plain terminal, which takes none.`);
      }
      // Claude settings are checked as option/value pairs in every form and passed on as one inline JSON each.
      let contributedArgs = contribution.args;
      if (context.provider === "claude") {
        const normalized = claudeSettingsArguments(contribution.args, contribution.files);
        if (typeof normalized === "string") return refuse(`${name} ${normalized}`);
        contributedArgs = normalized;
      }
      const forbidden = contributedArgs.find((argument) => coreOwnedLaunchArgument(context.provider, argument));
      if (forbidden) return refuse(`${name} added ${forbidden.slice(0, 60)}, which only CanvasTTY may pass.`);
      // A configuration a CLI reads from the environment or an argument may not decide its approvals either.
      const widening = permissionConfigProblem(context.provider, contribution, context.cwd);
      if (widening) return refuse(`${name} ${widening}`);
      let filesDirectory: string | null = null;
      if (contribution.files.length > 0) {
        filesDirectory = join(runDirectory, safeSegment(contributor.pluginId));
        try {
          for (const file of contribution.files) {
            const path = join(filesDirectory, ...file.relPath.split("/"));
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await writeFile(path, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
          }
        } catch (error) {
          return refuse(`${name}'s launch files could not be written: ${errorText(error)}`);
        }
      }
      const expand = (value: string): string => filesDirectory ? value.split(LAUNCH_FILES_TOKEN).join(filesDirectory) : value;
      const claim = (key: string): string | null => {
        const owner = claimed.get(envKey(key));
        if (owner) return owner === name ? `${name} sets ${key} twice.` : `${owner} and ${name} both set ${key}.`;
        claimed.set(envKey(key), name);
        envSources[key] = name;
        return null;
      };
      for (const [key, value] of Object.entries(contribution.env)) {
        const conflict = claim(key);
        if (conflict) return refuse(conflict);
        const expanded = expand(value);
        env[key] = expanded;
        // Only the host's Accounts service may reopen its selected provider home below plugin-data. This value is
        // derived from the trusted contributor record, not a plugin-returned grant or an inherited environment.
        accountHome = selectedAccountHome(context.provider, contributor.pluginId, contributor.dataDir,
          context.options[contributor.pluginId]?.account, { [key]: expanded }) ?? accountHome;
      }
      for (const [key, secretKey] of Object.entries(contribution.secretEnv)) {
        const conflict = claim(key);
        if (conflict) return refuse(conflict);
        if (!contributor.secrets) return refuse(`${name} asked for a secret without the secrets permission.`);
        const value = await this.dependencies.secret(contributor.pluginId, secretKey).catch(() => null);
        if (typeof value !== "string" || value.length === 0) return refuse(`${name}: its secret ${secretKey} is not set.`);
        if (value.includes("\u0000")) return refuse(`${name}: its secret ${secretKey} cannot be passed in the environment.`);
        env[key] = value;
        secrets.push(value);
      }
      args.push(...contributedArgs.map(expand));
      thirdPartyModel ||= contribution.thirdPartyModel === true;
    }
    return { ok: true, env, args, secrets, envSources, thirdPartyModel, ...(accountHome ? { accountHome } : {}), ...(accountId ? {accountId} : {}),
      ...(accountRoute ? { accountRoute } : {}), ...(apiDomains.size ? { apiDomains: [...apiDomains] } : {}), cleanup };
  }

  private async ask(
    contributor: LaunchContributor,
    context: LaunchSessionContext,
    chosen: boolean
  ): Promise<{ contributor: LaunchContributor; contribution: Contribution } | { refuse: string }> {
    const name = contributor.pluginName;
    const params: LaunchContext = { ...context, options: chosen ? context.options[contributor.pluginId]! : {}, chosen };
    if (contributor.pluginId !== ACCOUNTS_PLUGIN_ID || !chosen) delete params.accountRouteEvidence;
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        this.dependencies.call(contributor.pluginId, contributor.serviceId, "canvastty.launch.prepare", params, this.timeoutMs),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TimeoutError()), this.timeoutMs);
        })
      ]);
      const contribution = validContribution(answer);
      if (typeof contribution === "string") return { refuse: `${name} answered with an invalid launch contribution: ${contribution}` };
      if (contribution.refuse !== undefined) return { refuse: `${name}: ${contribution.refuse}` };
      if (!chosen && (Object.keys(contribution.env).length || Object.keys(contribution.secretEnv).length || contribution.args.length || contribution.files.length)) {
        return { refuse: `${name} answered its launch policy with a contribution; a policy may only refuse.` };
      }
      return { contributor, contribution };
    } catch (error) {
      if (error instanceof TimeoutError || /timed out/i.test(errorText(error))) {
        return { refuse: `${name} did not ${chosen ? "prepare the launch" : "answer its launch policy"} within ${Number((this.timeoutMs / 1000).toFixed(1))} s, so it was not started.` };
      }
      return { refuse: `${name} could not prepare the launch: ${errorText(error)}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

interface Contribution {
  env: Record<string, string>;
  secretEnv: Record<string, string>;
  args: string[];
  files: Array<{ relPath: string; content: string }>;
  /** Only ever restricts (auto → accept-edits), so a launch policy may set it too. */
  thirdPartyModel?: boolean;
  accountId?:string;
  accountRoute?: AccountRouteEvidence;
  refuse?: string;
}

/** Strict shape check of a service's answer; returns the problem as text when invalid. */
function validContribution(value: unknown): Contribution | string {
  if (value === null) return { env: {}, secretEnv: {}, args: [], files: [] };
  if (!isRecord(value)) return "not an object";
  const unknown = Object.keys(value).find((key) => !["env", "secretEnv", "args", "files", "thirdPartyModel", "refuse", "accountId", "accountRoute"].includes(key));
  if (unknown) return `unknown key ${unknown.slice(0, 40)}`;
  if (value.refuse !== undefined) {
    const reason = isRecord(value.refuse) ? value.refuse.reason : undefined;
    if (typeof reason !== "string" || reason.trim().length === 0) return "refuse needs a reason";
    return { env: {}, secretEnv: {}, args: [], files: [], refuse: reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_REASON) };
  }
  if (value.thirdPartyModel !== undefined && typeof value.thirdPartyModel !== "boolean") return "thirdPartyModel must be true or false";
  if(value.accountId!==undefined && (typeof value.accountId!=="string" || !/^[\w-]{1,80}$/.test(value.accountId)))return "accountId must be a bounded account identifier";
  let accountRoute: AccountRouteEvidence | undefined;
  if (value.accountRoute !== undefined) {
    const route = value.accountRoute;
    if (!isRecord(route) || Object.keys(route).sort().join(",") !== "endpoint,kind,model"
      || typeof route.model !== "string" || !route.model || route.model.length > 200 || /[\x00-\x1f\x7f]/u.test(route.model)
      || !publicEndpoint(route.endpoint) || !["ollama", "ollama-cloud", "api-key"].includes(route.kind as string)) {
      return "accountRoute needs a bounded model, public host:port and account kind";
    }
    accountRoute = { model: route.model, endpoint: publicEndpoint(route.endpoint)!, kind: route.kind as AccountRouteEvidence["kind"] };
  }
  const env = stringMap(value.env, MAX_ENV, "env");
  if (typeof env === "string") return env;
  for (const [key, entry] of Object.entries(env)) {
    if (entry.includes("\u0000") || Buffer.byteLength(entry, "utf8") > MAX_ENV_VALUE_BYTES) return `env ${key} value is invalid or larger than 8 KB`;
  }
  const secretEnv = stringMap(value.secretEnv, MAX_SECRET_ENV, "secretEnv");
  if (typeof secretEnv === "string") return secretEnv;
  for (const [key, entry] of Object.entries(secretEnv)) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(entry)) return `secretEnv ${key} must name a plugin secret key`;
  }
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS) return `args must be an array of at most ${MAX_ARGS}`;
  for (const argument of args) {
    if (typeof argument !== "string" || argument.length === 0 || argument.length > MAX_ARG_LENGTH || /[\u0000-\u001f\u007f]/.test(argument)) {
      return "every arg must be non-empty text without control characters, at most 1024 characters";
    }
  }
  const filesValue = value.files ?? [];
  if (!Array.isArray(filesValue) || filesValue.length > MAX_FILES) return `files must be an array of at most ${MAX_FILES}`;
  const files: Contribution["files"] = [];
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of filesValue) {
    if (!isRecord(file) || typeof file.relPath !== "string" || typeof file.content !== "string") return "every file needs relPath and content";
    const segments = file.relPath.split("/");
    if (segments.length > 4 || segments.some((segment) => !/^[A-Za-z0-9._-]{1,64}$/.test(segment) || /^\.+$/.test(segment))) {
      return `file path ${file.relPath.slice(0, 80)} is not a plain relative path`;
    }
    if (paths.has(file.relPath)) return `file ${file.relPath} is listed twice`;
    paths.add(file.relPath);
    bytes += Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILES_BYTES) return "files exceed 256 KB";
    files.push({ relPath: file.relPath, content: file.content });
  }
  return { env, secretEnv, args: args as string[], files, ...(accountRoute ? { accountRoute } : {}), ...(value.thirdPartyModel === true ? { thirdPartyModel: true } : {}),...(typeof value.accountId==="string" ? {accountId:value.accountId} : {}) };
}

/**
 * A contributor's Claude arguments with every `--settings` value as one checked inline JSON: `--settings <json>`,
 * `--settings=<json>`, or `--settings {launchFiles}/<file>` naming one of its own launch files (read from the
 * contribution, not from disk). Any other file, a value that is not a JSON object, or core-owned keys (hooks,
 * permissions, sandbox, …) are refused: Claude keeps only its last `--settings`, so an unchecked one could replace
 * CanvasTTY's. Returns the problem as text.
 */
function claudeSettingsArguments(args: readonly string[], files: Contribution["files"]): string[] | string {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    let value: string | undefined;
    if (argument === "--settings") {
      value = args[index + 1];
      if (value === undefined) return "passes --settings without a value.";
      index++;
    } else if (argument.startsWith("--settings=")) {
      value = argument.slice("--settings=".length);
    } else {
      result.push(argument);
      continue;
    }
    const launchFile = value.startsWith(`${LAUNCH_FILES_TOKEN}/`);
    let settings = launchFile ? null : parseInlineSettings(value);
    if (!settings && !launchFile && value.trimStart().startsWith("{")) return "passes Claude --settings that is not a JSON object.";
    if (!settings) {
      const file = launchFile ? files.find((candidate) => candidate.relPath === value!.slice(LAUNCH_FILES_TOKEN.length + 1)) : undefined;
      if (!file) {
        return `passes a Claude settings file CanvasTTY cannot check (${value.slice(0, 80)}); pass the settings as inline JSON or as one of its launch files.`;
      }
      settings = parseInlineSettings(file.content);
      if (!settings) return `passes Claude --settings (${file.relPath}) that is not a JSON object.`;
    }
    const key = claudeCoreSettingsKey(settings);
    if (key) return `sets ${key} in its Claude settings, which only CanvasTTY may set.`;
    result.push("--settings", JSON.stringify(settings));
  }
  return result;
}

/** Keys of a CLI configuration that decide approvals, the sandbox or bypasses (anywhere in the object). */
const PERMISSION_CONFIG_KEY = /permission|approv|yolo|sandbox|dangerous|bypass|auto_?accept|trust/i;

function permissionKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PERMISSION_CONFIG_KEY.test(key)) return key;
    const nested = permissionKey(entry, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** JSONC, or null when malformed. */
function parseConfigText(text: string): unknown {
  const parsed = parseJsonc(text);
  return parsed.ok ? parsed.value : null;
}

/**
 * The contribution hands the CLI a configuration (OpenCode's OPENCODE_CONFIG file, OPENCODE_CONFIG_DIR, Kimi's
 * `--config` JSON or `--config-file`) that sets approval, permission or sandbox keys: those are CanvasTTY's (the
 * person's profile). A file must be one of the contribution's own launch files or a readable file; one CanvasTTY
 * cannot read and check is refused. Returns the problem as text.
 */
export function permissionConfigProblem(provider: ProviderId, contribution: Pick<Contribution, "env" | "args" | "files">, cwd?: string): string | null {
  const fromFile = (value: string): { kind: "text"; text: string } | { kind: "absent" } | { kind: "uninspectable" } => {
    if (value.startsWith(`${LAUNCH_FILES_TOKEN}/`)) {
      const file = contribution.files.find((candidate) => candidate.relPath === value.slice(LAUNCH_FILES_TOKEN.length + 1));
      return file ? { kind: "text", text: file.content } : { kind: "absent" };
    }
    const file = readInspectedFile(resolve(cwd ?? process.cwd(), value), MAX_INSPECTED_CONFIG_BYTES);
    if (file.kind === "text") return file;
    return file;
  };
  const check = (label: string, text: string): string | null => {
    const parsed = parseConfigText(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return `hands the CLI ${label} that is not a JSON object.`;
    const key = permissionKey(parsed);
    return key ? `sets ${key} in ${label}, which decides approvals; only the person's profile does.` : null;
  };
  if (provider === "opencode") {
    for (const name of Object.keys(contribution.env)) {
      if (/^OPENCODE_PERMISSION$/iu.test(name)) return `sets ${name}, which decides approvals; only the person's profile does.`;
    }
    const file = contribution.env.OPENCODE_CONFIG;
    if (file !== undefined) {
      const read = fromFile(file);
      if (read.kind !== "text") return `hands the CLI a configuration file CanvasTTY cannot check (${file.slice(0, 80)}).`;
      const problem = check("its OpenCode configuration (OPENCODE_CONFIG)", read.text);
      if (problem) return problem;
    }
    const folder = contribution.env.OPENCODE_CONFIG_DIR;
    if (folder !== undefined) {
      for (const name of ["opencode.json", "opencode.jsonc"]) {
        const path = folder.startsWith(`${LAUNCH_FILES_TOKEN}/`) ? `${folder}/${name}` : resolve(cwd ?? process.cwd(), folder, name);
        const read = fromFile(path);
        if (read.kind === "absent") continue;
        if (read.kind === "uninspectable") return `hands the CLI a configuration file CanvasTTY cannot check (${path.slice(0, 80)}).`;
        const problem = check(`its OpenCode configuration (OPENCODE_CONFIG_DIR/${name})`, read.text);
        if (problem) return problem;
      }
    }
  }
  if (provider === "kimi") {
    for (let index = 0; index < contribution.args.length; index++) {
      const argument = contribution.args[index]!;
      const inline = argument === "--config" ? contribution.args[index + 1] : argument.startsWith("--config=") ? argument.slice("--config=".length) : undefined;
      const file = argument === "--config-file" ? contribution.args[index + 1] : argument.startsWith("--config-file=") ? argument.slice("--config-file=".length) : undefined;
      if (inline !== undefined) {
        const problem = check("its Kimi --config", inline);
        if (problem) return problem;
      }
      if (file !== undefined) {
        const read = fromFile(file);
        if (read.kind !== "text") return `hands the CLI a configuration file CanvasTTY cannot check (${file.slice(0, 80)}).`;
        const problem = check("its Kimi --config-file", read.text);
        if (problem) return problem;
      }
    }
  }
  return null;
}

/** Env names a plugin may set: valid, not reserved for CanvasTTY or the loader, text values. */
export function stringMap(value: unknown, limit: number, field: string): Record<string, string> | string {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > limit) return `${field} must be an object of at most ${limit} entries`;
  for (const [key, entry] of Object.entries(value)) {
    if (!ENV_NAME.test(key) || key === "__proto__") return `${field} name ${key.slice(0, 40)} is invalid`;
    if (RESERVED_ENV.test(key)) return `${field} ${key} is reserved for CanvasTTY`;
    if (typeof entry !== "string") return `${field} ${key} must be text`;
  }
  return value as Record<string, string>;
}

function unavailableReason(pluginId: string): string {
  return `Needs plugin ${pluginId} for its launch options; it is disabled, removed, or its native code is not trusted.`;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 128) || "_";
}

class TimeoutError extends Error {}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_REASON);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** The orchestrator's own choice repeated for its subagent: only values it inherited, each one the same. */
function sameAsInherited(raw: unknown, inherited: Readonly<Record<string, boolean | string>> | undefined): boolean {
  if (!inherited || !isRecord(raw)) return false;
  const keys = Object.keys(raw);
  return keys.length > 0 && keys.every((key) => Object.hasOwn(inherited, key) && inherited[key] === raw[key]);
}
