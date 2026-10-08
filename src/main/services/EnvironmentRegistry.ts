import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  PluginEnvironmentKeeps,
  PluginEnvironmentKind,
  PluginLaunchValues,
  ProviderId,
  SessionEnvironmentChoice
} from "../../shared/contracts.ts";
import { envKey, errorText, isRecord, MAX_ENV, MAX_ENV_VALUE_BYTES, MAX_SECRET_ENV, stringMap } from "./LaunchPipeline.ts";
import { MAX_PLUGIN_SLOT_BYTES, type PersistedEnvironmentRef } from "./TerminalSessionStore.ts";

/** A trusted plugin service that provides session environments (PluginManager.environmentProviders). */
export interface EnvironmentProvider {
  pluginId: string;
  pluginName: string;
  /** Canonical host install-record provenance, never supplied by a launcher choice. */
  sourceUrl?: string;
  serviceId: string;
  kinds: PluginEnvironmentKind[];
  /** The plugin holds the `secrets` permission, so `wrap` may name its secrets in `secretEnv`. */
  secrets: boolean;
}

export type EnvironmentStep = "prepare" | "wrap" | "resume" | "release" | "describe";
export type EnvironmentMethod = `canvastty.environment.${EnvironmentStep}`;

export interface EnvironmentRegistryDependencies {
  providers(): EnvironmentProvider[];
  experimentalEnabled?: () => boolean;
  call(pluginId: string, serviceId: string, method: EnvironmentMethod, params: unknown, timeoutMs: number): Promise<unknown>;
  /** Reads one of the plugin's own secrets in this process; the value never reaches plugin code or UI. */
  secret(pluginId: string, key: string): Promise<string | null>;
  timeouts?: Partial<Record<EnvironmentStep, number>>;
  platform?: NodeJS.Platform;
  onRetained?(sessionId:string,environment:PersistedEnvironmentRef,reason:string):void;
}

/** The core never waits longer and never falls back to a local launch when a step runs out. */
const ENVIRONMENT_TIMEOUTS: Record<EnvironmentStep, number> = {
  prepare: 15_000,
  wrap: 5_000,
  resume: 10_000,
  release: 10_000,
  describe: 3_000
};

/**
 * How long a prepare or resume that ran out of time may still answer: the plugin call itself keeps this budget (the
 * host call maximum), so an environment it creates or starts late is still heard of and released instead of left
 * running.
 */
const LATE_ANSWER_BUDGET_MS = 60_000;

/** What the host would spawn without an environment; `wrap` returns its replacement. */
export interface EnvironmentLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type PreparedEnvironment =
  | { ok: true; environment: PersistedEnvironmentRef; cwd?: string }
  | { ok: false; reason: string };

export type WrappedLaunch =
  | { ok: true; command: string; args: string[]; env: Record<string, string>; cwd: string; secrets: string[] }
  | { ok: false; reason: string };

const MAX_LABEL = 80;
const MAX_DETAIL = 240;
const MAX_REASON = 240;
const MAX_WRAP_ARGS = 256;
const MAX_WRAP_ARG_BYTES = 8 * 1024;
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export class EnvironmentRegistry {
  private readonly dependencies: EnvironmentRegistryDependencies;
  private readonly timeouts: Record<EnvironmentStep, number>;
  /** The latest resume asked per session: a late answer to an earlier one never stops what a newer one started. */
  private readonly resumes = new Map<string, number>();
  private resumeSerial = 0;

  constructor(dependencies: EnvironmentRegistryDependencies) {
    this.dependencies = dependencies;
    this.timeouts = { ...ENVIRONMENT_TIMEOUTS, ...dependencies.timeouts };
  }

  /** What the plugin declared its environment keeps of CanvasTTY's protection (nothing when it declared nothing). */
  keeps(environment: Pick<PersistedEnvironmentRef, "pluginId" | "kind">): PluginEnvironmentKeeps {
    return { ...(this.lookup(environment.pluginId, environment.kind)?.kind.keeps ?? {}) };
  }

  /** True when the plugin named by a saved ref can serve that kind now. */
  available(environment: Pick<PersistedEnvironmentRef, "pluginId" | "kind">): boolean {
    return Boolean(this.lookup(environment.pluginId, environment.kind));
  }

  unavailableReason(environment: Pick<PersistedEnvironmentRef, "pluginId" | "kind" | "label">): string {
    if (this.lookup(environment.pluginId, environment.kind, true) && this.remoteDisabled(environment.pluginId, environment.kind)) return "Experimental remote or unclassified environments are disabled; not available without opt-in. It was not started locally.";
    return `Needs plugin ${environment.pluginId} (${environment.label}); it is disabled, removed, or its native code is not trusted. It was not started locally.`;
  }

  /**
   * Checks a launcher choice against the provider's declared kinds and fields and fills defaults.
   * Throws with a person-readable reason; returns undefined for "this computer".
   */
  normalizeChoice(provider: ProviderId, candidate: unknown): SessionEnvironmentChoice | undefined {
    if (candidate === undefined || candidate === null) return undefined;
    if (!isRecord(candidate) || typeof candidate.pluginId !== "string" || typeof candidate.kind !== "string") {
      throw new Error("Environment choice is invalid.");
    }
    if (this.remoteDisabled(candidate.pluginId, candidate.kind)) throw new Error("Experimental remote or unclassified environments are disabled; not available without opt-in.");
    const found = this.lookup(candidate.pluginId, candidate.kind);
    if (!found) throw new Error(`Environment ${candidate.kind.slice(0, 32)} from plugin ${candidate.pluginId.slice(0, 80)} is not available.`);
    const { provider: owner, kind } = found;
    if (kind.appliesTo && !kind.appliesTo.includes(provider)) throw new Error(`${kind.label} does not apply to ${provider}.`);
    const raw = candidate.options ?? {};
    if (!isRecord(raw)) throw new Error(`${kind.label} options are invalid.`);
    const fields = kind.fields ?? [];
    const known = new Set(fields.map((field) => field.key));
    const unknown = Object.keys(raw).find((key) => !known.has(key));
    if (unknown) throw new Error(`${kind.label} has no option ${unknown.slice(0, 40)}.`);
    const options: PluginLaunchValues = {};
    for (const field of fields) {
      const value = raw[field.key] ?? field.default
        ?? (field.kind === "boolean" ? false : field.kind === "select" ? field.options?.[0]?.value ?? "" : "");
      const valid = field.kind === "boolean"
        ? typeof value === "boolean"
        : field.kind === "select"
          ? typeof value === "string" && Boolean(field.options?.some((option) => option.value === value))
          : typeof value === "string" && value.length <= (field.maxLength ?? 200) && !/[\u0000-\u001f\u007f]/.test(value);
      if (!valid) throw new Error(`${kind.label} option ${field.label} is invalid.`);
      options[field.key] = value as boolean | string;
    }
    return { pluginId: owner.pluginId, kind: kind.kind, ...(fields.length ? { options } : {}) };
  }

  /** `canvastty.environment.prepare`: creates the place (a worktree, a container) and returns its ref. */
  async prepare(request: {
    sessionId: string;
    provider: ProviderId;
    cwd: string;
    choice: SessionEnvironmentChoice;
    projectRoot?:string;
  }): Promise<PreparedEnvironment> {
    if (this.remoteDisabled(request.choice.pluginId, request.choice.kind)) return { ok: false, reason: "Experimental remote or unclassified environments are disabled; not available without opt-in." };
    const found = this.lookup(request.choice.pluginId, request.choice.kind);
    if (!found) return { ok: false, reason: `Environment ${request.choice.kind} from plugin ${request.choice.pluginId} is not available.` };
    const answer = await this.ask(found.provider, "prepare", {
      sessionId: request.sessionId,
      kind: request.choice.kind,
      provider: request.provider,
      cwd: request.cwd,
      ...(request.projectRoot ? {projectRoot:request.projectRoot} : {}),
      options: request.choice.options ?? {}
    }, undefined, {
      budgetMs: LATE_ANSWER_BUDGET_MS,
      // The launch already failed as timed out and nothing holds this ref: release it, data included.
      late: (value) => {
        if (!isRecord(value) || value.refuse !== undefined || value.ref === undefined || !fitsSlot(value.ref)) return;
        const environment = { pluginId: found.provider.pluginId, kind: request.choice.kind, ref: structuredClone(value.ref), label: plainText(value.label, MAX_LABEL) || request.choice.kind };
        void this.release(environment, request.sessionId, { keepData: false, reason: "closed" });
      }
    });
    if (!answer.ok) return answer;
    const value = answer.value;
    const name = found.provider.pluginName;
    if (isRecord(value) && value.refuse !== undefined) return { ok: false, reason: `${name}: ${refusal(value.refuse)}` };
    if (!isRecord(value)) return { ok: false, reason: `${name} answered with an invalid environment: not an object` };
    const unknown = Object.keys(value).find((key) => !["ref", "label", "cwd"].includes(key));
    if (unknown) return { ok: false, reason: `${name} answered with an invalid environment: unknown key ${unknown.slice(0, 40)}` };
    if (value.ref === undefined || !fitsSlot(value.ref)) {
      return { ok: false, reason: `${name} answered with an invalid environment: ref must be JSON of at most 4 KB` };
    }
    const label = plainText(value.label, MAX_LABEL);
    if (!label) return { ok: false, reason: `${name} answered with an invalid environment: label is required` };
    if (value.cwd !== undefined && !isDirectory(value.cwd)) {
      return { ok: false, reason: `${name} answered with an invalid environment: cwd must be an existing absolute folder` };
    }
    if (this.remoteDisabled(request.choice.pluginId, request.choice.kind)) {
      await this.release({ pluginId: found.provider.pluginId, kind: request.choice.kind, ref: structuredClone(value.ref), label }, request.sessionId, { keepData: true, reason: "closed" });
      return { ok: false, reason: "Experimental remote or unclassified environments are disabled; not available without opt-in." };
    }
    return {
      ok: true,
      environment: { pluginId: found.provider.pluginId, kind: request.choice.kind, ref: structuredClone(value.ref), label },
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {})
    };
  }

  /** `canvastty.environment.resume`: on restore and before relaunching a card from an earlier run. */
  async resume(environment: PersistedEnvironmentRef, sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const found = this.lookup(environment.pluginId, environment.kind);
    if (!found) return { ok: false, reason: this.unavailableReason(environment) };
    const serial = ++this.resumeSerial;
    this.resumes.set(sessionId, serial);
    const answer = await this.ask(found.provider, "resume", refParams(environment, sessionId), undefined, {
      budgetMs: LATE_ANSWER_BUDGET_MS,
      // The launch already failed as timed out, yet the plugin started the environment: stop it again. The card still
      // holds the ref (a restart resumes it), so its data is kept.
      late: (value) => {
        if (this.resumes.get(sessionId) !== serial) return;
        this.resumes.delete(sessionId);
        if (isRecord(value) && value.ok === true) void this.release(environment, sessionId, { keepData: true, reason: "closed" });
      }
    });
    if (answer.ok && this.resumes.get(sessionId) === serial) this.resumes.delete(sessionId);
    if (!answer.ok) return answer;
    const value = answer.value;
    const name = found.provider.pluginName;
    if (this.remoteDisabled(environment.pluginId, environment.kind)) {
      if (isRecord(value) && value.ok === true) await this.release(environment, sessionId, { keepData: true, reason: "closed" });
      return { ok: false, reason: this.unavailableReason(environment) };
    }
    if (isRecord(value) && value.ok === true && Object.keys(value).length === 1) return { ok: true };
    if (isRecord(value) && value.stopped !== undefined) return { ok: false, reason: `${name}: ${refusal(value.stopped)}` };
    return { ok: false, reason: `${name} answered resume with neither ok nor stopped.` };
  }

  /**
   * `canvastty.environment.wrap`: turns the host's launch into the one that runs inside the environment.
   * The host still spawns the PTY; the answer is validated and merged under the launch-contributor rules.
   */
  async wrap(environment: PersistedEnvironmentRef, request: {
    sessionId: string;
    provider: ProviderId;
    launch: EnvironmentLaunch;
    /** Names the host sets for this launch whose values the environment never sees (secrets). */
    secretEnvNames: string[];
    /** Names CanvasTTY or a launch contributor sets for this launch; the environment may not set them. */
    takenEnv: ReadonlySet<string>;
    /** PATH used to resolve a bare command name. */
    path: string | undefined;
  }): Promise<WrappedLaunch> {
    const found = this.lookup(environment.pluginId, environment.kind);
    if (!found) return { ok: false, reason: this.unavailableReason(environment) };
    const { provider } = found;
    const name = provider.pluginName;
    const answer = await this.ask(provider, "wrap", {
      ...refParams(environment, request.sessionId),
      provider: request.provider,
      command: request.launch.command,
      args: request.launch.args,
      env: request.launch.env,
      secretEnvNames: request.secretEnvNames,
      cwd: request.launch.cwd
    });
    if (!answer.ok) return answer;
    if (this.remoteDisabled(environment.pluginId, environment.kind)) {
      await this.release(environment, request.sessionId, { keepData: true, reason: "closed" });
      return { ok: false, reason: this.unavailableReason(environment) };
    }
    const invalid = (problem: string): WrappedLaunch => ({ ok: false, reason: `${name} answered with an invalid launch: ${problem}` });
    const value = answer.value;
    if (isRecord(value) && value.refuse !== undefined) return { ok: false, reason: `${name}: ${refusal(value.refuse)}` };
    if (!isRecord(value)) return invalid("not an object");
    const unknown = Object.keys(value).find((key) => !["command", "args", "env", "secretEnv", "cwd"].includes(key));
    if (unknown) return invalid(`unknown key ${unknown.slice(0, 40)}`);
    if (typeof value.command !== "string" || value.command.length === 0 || value.command.length > 1_024) return invalid("command is required");
    const command = resolveCommand(value.command, request.path, this.dependencies.platform ?? process.platform);
    if (!command) {
      return invalid(`command ${value.command.slice(0, 80)} must be an absolute path to a program or a bare program name on PATH; CanvasTTY runs no shell string`);
    }
    const args = value.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_WRAP_ARGS) return invalid(`args must be an array of at most ${MAX_WRAP_ARGS}`);
    for (const argument of args) {
      if (typeof argument !== "string" || argument.includes("\u0000") || Buffer.byteLength(argument, "utf8") > MAX_WRAP_ARG_BYTES) {
        return invalid("every arg must be text without NUL, at most 8 KB");
      }
    }
    if (value.cwd !== undefined && !isDirectory(value.cwd)) return invalid("cwd must be an existing absolute folder");
    const env = stringMap(value.env, MAX_ENV, "env");
    if (typeof env === "string") return invalid(env);
    for (const [key, entry] of Object.entries(env)) {
      if (entry.includes("\u0000") || Buffer.byteLength(entry, "utf8") > MAX_ENV_VALUE_BYTES) return invalid(`env ${key} value is invalid or larger than 8 KB`);
    }
    const secretEnv = stringMap(value.secretEnv, MAX_SECRET_ENV, "secretEnv");
    if (typeof secretEnv === "string") return invalid(secretEnv);
    const merged: Record<string, string> = {};
    const secrets: string[] = [];
    const platform = this.dependencies.platform ?? process.platform;
    const taken = new Set([...request.takenEnv].map((key) => envKey(key, platform)));
    const seen = new Set<string>();
    for (const key of [...Object.keys(env), ...Object.keys(secretEnv)]) {
      if (taken.has(envKey(key, platform))) return { ok: false, reason: `${name} sets ${key}, which CanvasTTY or a launch option already sets for this launch.` };
      if (seen.has(envKey(key, platform))) return { ok: false, reason: `${name} sets ${key} twice.` };
      seen.add(envKey(key, platform));
      merged[key] = env[key] ?? "";
    }
    for (const [key, secretKey] of Object.entries(secretEnv)) {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(secretKey)) return invalid(`secretEnv ${key} must name a plugin secret key`);
      if (!provider.secrets) return { ok: false, reason: `${name} asked for a secret without the secrets permission.` };
      const secret = await this.dependencies.secret(provider.pluginId, secretKey).catch(() => null);
      if (typeof secret !== "string" || secret.length === 0) return { ok: false, reason: `${name}: its secret ${secretKey} is not set.` };
      if (secret.includes("\u0000")) return { ok: false, reason: `${name}: its secret ${secretKey} cannot be passed in the environment.` };
      merged[key] = secret;
      secrets.push(secret);
    }
    if (this.remoteDisabled(environment.pluginId, environment.kind)) {
      await this.release(environment, request.sessionId, { keepData: true, reason: "closed" });
      return { ok: false, reason: this.unavailableReason(environment) };
    }
    return {
      ok: true,
      command,
      args: args as string[],
      env: merged,
      cwd: typeof value.cwd === "string" ? value.cwd : request.launch.cwd,
      secrets
    };
  }

  /** `canvastty.environment.release`: the card was closed (or the app quit with saving off). Never throws. */
  async release(environment: PersistedEnvironmentRef, sessionId: string, options: { keepData: boolean; reason: "closed" | "quit"; timeoutMs?: number }): Promise<void> {
    // Cleanup remains possible after the opt-in is switched off.
    const found = this.lookup(environment.pluginId, environment.kind, true);
    if (!found) return;
    const answer = await this.ask(found.provider, "release", {
      ...refParams(environment, sessionId),
      keepData: options.keepData,
      reason: options.reason
    }, options.timeoutMs);
    if (!answer.ok) console.warn(`CanvasTTY environment ${environment.label} could not be released: ${answer.reason}`);
    else if(isRecord(answer.value) && answer.value.released===false) {
      const reason=plainText(answer.value.reason,500) ?? "Unreviewed work was kept.";
      console.warn(`CanvasTTY environment ${environment.label} retained: ${reason}`);
      this.dependencies.onRetained?.(sessionId,environment,reason);
    }
  }

  /** `canvastty.environment.describe`: the card badge text; null when the plugin gave none. */
  async describe(environment: PersistedEnvironmentRef, sessionId: string): Promise<{ label: string; detail?: string } | null> {
    const found = this.lookup(environment.pluginId, environment.kind);
    if (!found) return null;
    const answer = await this.ask(found.provider, "describe", refParams(environment, sessionId));
    if (!answer.ok || !isRecord(answer.value)) return null;
    const label = plainText(answer.value.label, MAX_LABEL);
    if (!label) return null;
    const detail = plainText(answer.value.detail, MAX_DETAIL);
    return { label, ...(detail ? { detail } : {}) };
  }

  private remoteDisabled(pluginId: string, kindId: string): boolean {
    if (this.dependencies.experimentalEnabled?.() === true) return false;
    const found = this.lookup(pluginId, kindId, true);
    if (!found) return true;
    if (found.kind.executionLocation !== undefined) return found.kind.executionLocation !== "local";
    // Only these audited legacy services run locally. IDs alone are self-declared and confer no provenance.
    return !(found.provider.sourceUrl?.toLowerCase() === "https://github.com/biackfiame/canvastty-plugin-environments.git"
      && pluginId === "canvastty-environments"
      && ((found.provider.serviceId === "worktree" && kindId === "worktree")
        || (found.provider.serviceId === "container" && kindId === "container")));
  }

  private lookup(pluginId: string, kindId: string, cleanup = false): { provider: EnvironmentProvider; kind: PluginEnvironmentKind } | null {
    if (!cleanup && this.remoteDisabled(pluginId, kindId)) return null;
    // Kinds are unique within a plugin, whichever of its services lists them.
    const provider = this.dependencies.providers()
      .find((candidate) => candidate.pluginId === pluginId && candidate.kinds.some((kind) => kind.kind === kindId));
    const kind = provider?.kinds.find((candidate) => candidate.kind === kindId);
    return provider && kind ? { provider, kind } : null;
  }

  /**
   * One plugin call within `timeoutMs`. With `lateAnswer`, the call itself may run for `budgetMs` and an answer that
   * comes after the timeout goes to `late` (the caller has already been told it timed out).
   */
  private async ask(
    provider: EnvironmentProvider,
    step: EnvironmentStep,
    params: unknown,
    timeoutMs = this.timeouts[step],
    lateAnswer?: { budgetMs: number; late(value: unknown): void }
  ): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const call = this.dependencies.call(provider.pluginId, provider.serviceId, `canvastty.environment.${step}`, params,
      lateAnswer ? Math.max(timeoutMs, lateAnswer.budgetMs) : timeoutMs);
    if (lateAnswer) call.then((value) => { if (timedOut) lateAnswer.late(value); }, () => undefined);
    try {
      const value = await Promise.race([
        call,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Error("timed out")); }, timeoutMs);
        })
      ]);
      return { ok: true, value };
    } catch (error) {
      const text = errorText(error);
      if (/timed out/i.test(text)) {
        return { ok: false, reason: `${provider.pluginName} did not answer ${step} within ${Number((timeoutMs / 1000).toFixed(1))} s; nothing was started locally.` };
      }
      return { ok: false, reason: `${provider.pluginName} could not ${step} the environment: ${text}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function refParams(environment: PersistedEnvironmentRef, sessionId: string): Record<string, unknown> {
  return { sessionId, kind: environment.kind, ref: structuredClone(environment.ref) };
}

function refusal(value: unknown): string {
  const reason = isRecord(value) ? value.reason : value;
  return plainText(reason, MAX_REASON) || "no reason given";
}

function plainText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : "";
}

function fitsSlot(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && Buffer.byteLength(json, "utf8") <= MAX_PLUGIN_SLOT_BYTES;
  } catch {
    return false;
  }
}

function isDirectory(value: unknown): value is string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\u0000")) return false;
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/**
 * An absolute path to an executable file, or a bare program name found on PATH. Anything else
 * (a relative path, a command line with spaces or shell syntax) is refused: the host spawns the
 * program directly with an argv and never through a shell.
 */
export function resolveCommand(command: string, path: string | undefined, platform: NodeJS.Platform = process.platform): string | null {
  if (command.includes("\u0000")) return null;
  if (isAbsolute(command)) return isExecutable(command, platform) ? command : null;
  if (!BARE_COMMAND.test(command)) return null;
  const extensions = platform === "win32" && !/\.(?:exe|com)$/iu.test(command) ? [".exe", ".com"] : [""];
  for (const directory of (path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
