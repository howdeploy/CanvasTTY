import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
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
import { contributedAccountHome } from "./isolation/accountHomeIsolation.ts";

/** A trusted plugin service that declared launch options (PluginManager.launchContributors). */
export interface LaunchContributor {
  pluginId: string;
  pluginName: string;
  serviceId: string;
  launch: PluginServiceLaunch;
  /** The plugin's private data folder, set by the host; never sent to the plugin or taken from its answer. */
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
}

export type LaunchSessionContext = Omit<LaunchContext, "options" | "chosen"> & { options: Record<string, PluginLaunchValues> };

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
    /** Plugin ids whose contribution decides the model: it passes the CLI's model flag or runs a third-party model. */
    modelSetBy: string[];
    /** This run's own folder below the card's folder; `cleanup` removes it. */
    runDirectory: string;
    /**
     * The CLI home a chosen contributor started this launch with inside its own data folder (an account it selected):
     * the one folder of plugin data the isolation layer reopens for this agent. Derived by the host, never a grant a
     * plugin can name.
     */
    accountHome?: string;
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

  /** Removes file folders left by a previous run of the app. */
  clearRuns(): Promise<void> {
    return rm(this.dependencies.runsRoot, { recursive: true, force: true });
  }

  /**
   * Removes a closed card's run folders that this pipeline prepared for it, then the card's folder if nothing else
   * is left in it. A card brought back under the same id may already be writing a new run folder there; it is kept.
   */
  async forgetSession(sessionId: string, runDirectories: Iterable<string>): Promise<void> {
    const parent = join(this.dependencies.runsRoot, safeSegment(sessionId));
    const errors: unknown[] = [];
    for (const runDirectory of new Set(runDirectories)) {
      // Only a run folder directly below this card's folder is ever removed here.
      if (dirname(resolve(runDirectory)) !== resolve(parent)) continue;
      try { await removeRunFolder(runDirectory); } catch (error) { errors.push(error); }
    }
    try {
      await rmdir(parent);
    } catch (error) {
      // Still in use by a newer run of the same card, or already gone; the startup sweep removes what is left.
      if (!PARENT_KEPT_CODES.has((error as NodeJS.ErrnoException).code ?? "")) errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Launch run folders could not be removed.");
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
  normalizeOptions(provider: ProviderId, candidate: unknown, context?: {
    delegated?: boolean;
    /** The orchestrator's own options: repeating them for its subagent is the person's choice, not the orchestrator's. */
    inherited?: Readonly<Record<string, Readonly<PluginLaunchValues>>>;
  }): Record<string, PluginLaunchValues> | undefined {
    if (candidate === undefined) return undefined;
    if (!isRecord(candidate) || Object.keys(candidate).length > MAX_OPTION_PLUGINS) throw new Error("Launch options are invalid.");
    if (Object.keys(candidate).length === 0) return undefined;
    if (provider === "terminal") throw new Error("A plain terminal takes no launch options.");
    const contributors = new Map(this.dependencies.contributors().map((contributor) => [contributor.pluginId, contributor]));
    const options: Record<string, PluginLaunchValues> = {};
    for (const [pluginId, requested] of Object.entries(candidate)) {
      let raw = requested;
      const contributor = contributors.get(pluginId);
      if (!contributor) throw new Error(unavailableReason(pluginId));
      // An orchestrator picks options for its subagents only where the plugin said that is safe.
      const notDelegable = `${contributor.pluginName} has not declared its launch options safe for an orchestrator to choose; only the person chooses them, in the launcher.`;
      // Without the declaration a subagent may only repeat the orchestrator's own values: the keys it leaves out are
      // the inherited ones, never the plugin's defaults, and the result is checked against them below.
      const inherited = context?.delegated && contributor.launch.delegable !== true ? context.inherited?.[pluginId] : undefined;
      if (context?.delegated && contributor.launch.delegable !== true) {
        if (!inherited || !sameAsInherited(raw, inherited)) throw new LaunchRefusal(notDelegable);
        raw = { ...inherited, ...(raw as Record<string, unknown>) };
      }
      if (!inherited) {
        options[pluginId] = launchValues(contributor, provider, raw);
        continue;
      }
      // The person's earlier choice no longer fits the plugin (it changed its fields or what it applies to): a subagent
      // never gets other values than its orchestrator's, so it is refused with that reason.
      const changed = `${contributor.pluginName} launch options changed since this orchestrator started, so its subagents cannot repeat the person's choice. `
        + "The person can start the orchestrator again with the new options.";
      let values: PluginLaunchValues;
      try {
        values = launchValues(contributor, provider, raw);
      } catch {
        throw new LaunchRefusal(changed);
      }
      if (!sameValues(values, inherited)) throw new LaunchRefusal(changed);
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
  async prepare(context: LaunchSessionContext, launch: { model?: string } = {}): Promise<PreparedLaunch> {
    const contributors = new Map(this.dependencies.contributors().map((contributor) => [contributor.pluginId, contributor]));
    // Only a subagent's launch is refused for a second model; it was chosen for it, not by the person.
    const delegated = context.role === "subagent";
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
    const cleanup = (): Promise<void> => removeRunFolder(runDirectory);
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
    const modelSetBy: string[] = [];
    let accountHome: string | undefined;
    for (const answer of answers) {
      if ("refuse" in answer) return refuse(answer.refuse);
    }
    for (const answer of answers as Array<{ contributor: LaunchContributor; contribution: Contribution }>) {
      const { contributor, contribution } = answer;
      const name = contributor.pluginName;
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
      const modelFlag = modelSettingArgument(context.provider, contributedArgs);
      if (modelFlag !== undefined || contribution.thirdPartyModel === true) {
        // A subagent's CLI gets one model: a second model flag next to the launch's own made OpenCode crash at start.
        // A person's own launches (and their restores) start as they always did; the person chose both.
        if (delegated && modelFlag !== undefined && launch.model !== undefined) {
          return refuse(`${name} sets the model of this launch, and the launch also asks for model ${launch.model.slice(0, 80)}. Omit the model, or choose ${name} options for the model you want.`);
        }
        if (delegated && modelSetBy.length > 0) {
          const first = contributors.get(modelSetBy[0]!)?.pluginName ?? modelSetBy[0]!;
          return refuse(`${first} and ${name} both set the model of this launch; choose launch options from only one of them.`);
        }
        modelSetBy.push(contributor.pluginId);
      }
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
        env[key] = expand(value);
        accountHome = contributedAccountHome(context.provider, contributor.dataDir, key, env[key]) ?? accountHome;
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
    return { ok: true, env, args, secrets, envSources, thirdPartyModel, modelSetBy, runDirectory, ...(accountHome ? { accountHome } : {}), cleanup };
  }

  private async ask(
    contributor: LaunchContributor,
    context: LaunchSessionContext,
    chosen: boolean
  ): Promise<{ contributor: LaunchContributor; contribution: Contribution } | { refuse: string }> {
    const name = contributor.pluginName;
    const params: LaunchContext = { ...context, options: chosen ? context.options[contributor.pluginId]! : {}, chosen };
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
  refuse?: string;
}

/** Strict shape check of a service's answer; returns the problem as text when invalid. */
function validContribution(value: unknown): Contribution | string {
  if (value === null) return { env: {}, secretEnv: {}, args: [], files: [] };
  if (!isRecord(value)) return "not an object";
  const unknown = Object.keys(value).find((key) => !["env", "secretEnv", "args", "files", "thirdPartyModel", "refuse"].includes(key));
  if (unknown) return `unknown key ${unknown.slice(0, 40)}`;
  if (value.refuse !== undefined) {
    const reason = isRecord(value.refuse) ? value.refuse.reason : undefined;
    if (typeof reason !== "string" || reason.trim().length === 0) return "refuse needs a reason";
    return { env: {}, secretEnv: {}, args: [], files: [], refuse: reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_REASON) };
  }
  if (value.thirdPartyModel !== undefined && typeof value.thirdPartyModel !== "boolean") return "thirdPartyModel must be true or false";
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
  return { env, secretEnv, args: args as string[], files, ...(value.thirdPartyModel === true ? { thirdPartyModel: true } : {}) };
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

/** Errors that leave a card's folder in place on purpose: another run still uses it, or it is gone. */
const PARENT_KEPT_CODES = new Set(["ENOENT", "ENOTEMPTY", "EEXIST", "EBUSY", "EPERM"]);

/**
 * Removes one run folder. On Windows the agent may still hold a file there for a moment after its PTY exits, so
 * busy/permission errors are retried briefly before giving up.
 */
function removeRunFolder(runDirectory: string): Promise<void> {
  return rm(runDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

/** A plugin's launch values checked against its declared fields, with defaults filled in. Throws with a person-readable reason. */
function launchValues(contributor: LaunchContributor, provider: ProviderId, raw: unknown): PluginLaunchValues {
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
  return values;
}

/** The orchestrator's own choice repeated for its subagent: only keys it chose, each with the same value. */
function sameAsInherited(raw: unknown, inherited: Readonly<PluginLaunchValues> | undefined): boolean {
  if (!inherited || !isRecord(raw)) return false;
  const keys = Object.keys(raw);
  // An empty choice repeats only an empty one (a plugin without fields, chosen in the launcher).
  if (keys.length === 0) return Object.keys(inherited).length === 0;
  return keys.every((key) => Object.hasOwn(inherited, key) && inherited[key] === raw[key]);
}

/** Exactly the same keys and values. */
function sameValues(values: Readonly<PluginLaunchValues>, inherited: Readonly<PluginLaunchValues>): boolean {
  const keys = Object.keys(values);
  return keys.length === Object.keys(inherited).length
    && keys.every((key) => Object.hasOwn(inherited, key) && inherited[key] === values[key]);
}

/**
 * How each CLI's arguments choose its model. Every CLI here takes `--model`; `short` are its short model flags,
 * `profile` flags that select a configuration profile (which may name a model), and `config` flags that set a
 * configuration key, with the keys that decide the model.
 */
const MODEL_ARGUMENTS: Readonly<Partial<Record<ProviderId, { short?: readonly string[]; profile?: readonly string[]; config?: { flags: readonly string[]; keys: readonly string[] } }>>> = {
  codex: { short: ["-m"], profile: ["--profile", "-p"], config: { flags: ["-c", "--config"], keys: ["model", "model_provider", "profile"] } },
  opencode: { short: ["-m"] },
  qwen: { short: ["-m"] },
  kimi: { short: ["-m"] },
  grok: { short: ["-m"] }
};

/**
 * The first argument that chooses the CLI's model, in any form: `--model x`, `--model=x`, a short `-m x` or `-mx`,
 * and for Codex `--profile`/`-p` and `-c`/`--config` setting `model`, `model_provider` or `profile`. Undefined when none does.
 */
export function modelSettingArgument(provider: ProviderId, args: readonly string[]): string | undefined {
  const table = MODEL_ARGUMENTS[provider] ?? {};
  const valueFlags = ["--model", ...(table.short ?? []), ...(table.profile ?? [])];
  const configKeys = new Set(table.config?.keys ?? []);
  const configSetsModel = (value: string | undefined): boolean => {
    if (value === undefined) return false;
    const key = value.split("=", 1)[0]!.trim().replace(/^["']|["']$/gu, "");
    return value.includes("=") && configKeys.has(key);
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (valueFlags.some((flag) => argument === flag || attachedValue(argument, flag) !== undefined)) return argument;
    for (const flag of table.config?.flags ?? []) {
      const value = argument === flag ? args[index + 1] : attachedValue(argument, flag);
      if (configSetsModel(value)) return argument === flag ? `${argument} ${value}` : argument;
    }
  }
  return undefined;
}

/** The value written into the flag's own argument: `--flag=value`, or `-fvalue` for a short flag. */
function attachedValue(argument: string, flag: string): string | undefined {
  if (flag.startsWith("--")) return argument.startsWith(`${flag}=`) ? argument.slice(flag.length + 1) : undefined;
  return argument.length > flag.length && argument.startsWith(flag) ? argument.slice(flag.length) : undefined;
}
