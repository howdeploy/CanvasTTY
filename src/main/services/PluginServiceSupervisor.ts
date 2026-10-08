import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type {
  PluginPermission,
  PluginServiceLogEntry,
  PluginServiceReport,
  PluginServiceState,
  PluginServiceStatus
} from "../../shared/contracts";
import { MAX_DECIDE_TIMEOUT_MS } from "../../agent-runtime/runtime-protocol.mjs";
import { NdjsonLineReader } from "../../agent-runtime/ndjson.mjs";

/** One trusted service the supervisor should keep running. Built by PluginManager. */
export interface PluginServiceSpec {
  pluginId: string;
  serviceId: string;
  /** Plugin package root: the process working directory. */
  root: string;
  /** Absolute entry path inside `root`. */
  entryPath: string;
  /** SHA-256 of the entry recorded when the user trusted it; checked before every start. */
  sha256: string;
  /** `<userData>/plugin-data/<pluginId>`, created before start and removed on uninstall. */
  dataDir: string;
  permissions: readonly PluginPermission[];
}

/** Host calls a service may make back. Everything else is rejected. */
export interface PluginServiceHost {
  storageGet(pluginId: string, key: string): Promise<unknown>;
  storageSet(pluginId: string, key: string, value: unknown): Promise<void>;
  emit(pluginId: string, serviceId: string, event: string, data: unknown): void;
  /** Adds values to the redaction registry: they are masked in every text another agent reads. */
  registerSecrets?(pluginId: string, values: string[]): void;
  maskSecrets?(text: string): string;
  /** One of the plugin's own secrets (already checked for `secrets`), or null when it is not set. */
  secretGet?(pluginId: string, key: string): Promise<string | null>;
  /**
   * Session events and plugin-owned session control (`sessions.*`, EP-4). Returns undefined for a method it
   * does not know. `permissions` are the plugin's active manifest permissions; it checks them per method.
   */
  sessions?(pluginId: string, serviceId: string, method: string, params: unknown, permissions: readonly PluginPermission[]): unknown;
  /** `cards.setBadge` (EP-7), already checked for `cards:decorate`. */
  setBadge?(pluginId: string, params: unknown): unknown;
  /** The service process ended (stopped, crashed or removed): its subscriptions end with it. */
  stopped?(pluginId: string, serviceId: string): void;
}

export interface PluginServiceSupervisorOptions {
  /** Executable that runs JavaScript: Electron's `process.execPath` with ELECTRON_RUN_AS_NODE. */
  command: string;
  hostVersion: string;
  locale(): string;
  host: PluginServiceHost;
  /** Environment the minimal child environment is picked from (default `process.env`). */
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  stopGraceMs?: number;
  restartDelaysMs?: readonly number[];
  maxRestarts?: number;
  restartWindowMs?: number;
  maxFrameBytes?: number;
  /**
   * Cap on bytes handed to a service's stdin that have not yet been accepted by the OS pipe. `write()`
   * (node's Writable) queues without bound when a service does not read its stdin as fast as the host
   * writes to it; a slow or stuck service otherwise lets buffered bytes grow forever even though
   * MAX_PENDING_REQUESTS bounds only the number of *logical* in-flight requests, not their bytes, and a
   * request timeout frees its logical slot without retracting the bytes already queued for it.
   */
  maxQueuedBytes?: number;
  /**
   * Services start only after hostReady(): the host APIs they may call on initialize (sessions, cards, secrets)
   * must exist first. Without it services start at once.
   */
  waitForHost?: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * The longest budget a host call may carry: the largest budget a manifest can declare (`decide.timeoutMs`, 60 s).
 * Host calls keep their own validated budget up to this bound; surface requests keep `requestTimeoutMs`. The decision
 * gate's gateway and helper deadlines (permissionGateTimings) are sized from the same budget and stay longer.
 */
export const MAX_HOST_CALL_TIMEOUT_MS = MAX_DECIDE_TIMEOUT_MS;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 10 * 60_000;
const PLUGIN_SERVICE_MAX_FRAME_BYTES = 1024 * 1024;
/** Default stdin queue cap: enough for a handful of max-size frames, bounded regardless of how slow the service reads. */
const DEFAULT_MAX_QUEUED_BYTES = 4 * PLUGIN_SERVICE_MAX_FRAME_BYTES;
const MAX_PENDING_REQUESTS = 64;
const MAX_LOG_ENTRIES = 300;
const MAX_LOG_MESSAGE = 2_000;
const HOST_METHOD_PREFIX = "canvastty.";

/**
 * Variables a service inherits. Everything else (provider keys, tokens, CANVASTTY_* runtime
 * internals, NODE_OPTIONS) is dropped: a service gets what it needs to find system tools, no more.
 */
const INHERITED_ENVIRONMENT = new Set([
  "PATH", "Path", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ",
  "TMPDIR", "TMP", "TEMP", "SSH_AUTH_SOCK",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "HOMEDRIVE", "HOMEPATH"
]);

/**
 * Module hooks for the service process: the entry is loaded from bytes the
 * hook read and hashed itself, and a mismatch stops the load. They run
 * before the entry through `--import`, off the main thread (module.register).
 *
 * The entry checked is the main module node actually resolved (the one
 * resolve without a parent), not only the URL the host computed: when the
 * entry or a folder above it is replaced by a symlink after the host's check,
 * node resolves the main module to another file, and that file must match the
 * hash too. The host's URL stays checked as well.
 *
 * The hooks take their modules with `await import(...)`, never a static
 * `import ... from`: electron-vite puts its CommonJS shim (`__dirname`,
 * `require`) after the last static import it finds in the main bundle, and a
 * static import inside this string would pull the shim into the string, which
 * leaves the whole main process without `__dirname`.
 */
const ENTRY_GUARD_HOOKS = `
const { createHash } = await import("node:crypto");
const { readFile } = await import("node:fs/promises");
let entryUrl = null;
let mainUrl = null;
let expected = null;
export function initialize(data) { entryUrl = data.url; expected = data.sha256; }
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (mainUrl === null && context.parentURL === undefined) mainUrl = resolved.url;
  return resolved;
}
export async function load(url, context, nextLoad) {
  if (url !== entryUrl && url !== mainUrl) return nextLoad(url, context);
  const source = await readFile(new URL(url));
  if (createHash("sha256").update(source).digest("hex") !== expected) {
    throw new Error("The service entry changed after it was trusted.");
  }
  const loaded = await nextLoad(url, context);
  return { format: loaded.format, source, shortCircuit: true };
}
`;

export function entryGuardArguments(entryUrl: string, sha256: string): string[] {
  const boot = [
    'import { register } from "node:module";',
    `register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(ENTRY_GUARD_HOOKS)}`)},`
      + ` { data: ${JSON.stringify({ url: entryUrl, sha256 })} });`
  ].join("\n");
  return ["--import", `data:text/javascript,${encodeURIComponent(boot)}`];
}

export function pluginServiceEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && (INHERITED_ENVIRONMENT.has(name) || name.startsWith("LC_"))) {
      environment[name] = value;
    }
  }
  environment.ELECTRON_RUN_AS_NODE = "1";
  return environment;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ServiceRecord {
  spec: PluginServiceSpec;
  state: PluginServiceState;
  child: ChildProcess | null;
  pending: Map<number, PendingRequest>;
  nextId: number;
  crashes: number[];
  restarts: number;
  restartTimer: NodeJS.Timeout | null;
  removed: boolean;
  exited: Promise<void> | null;
  lastError?: string;
  /** Bytes handed to stdin.write() that have not yet drained (accepted by the OS pipe). */
  queuedBytes: number;
}

/**
 * Runs trusted plugin services as separate processes and speaks newline-delimited JSON-RPC 2.0
 * with them over stdio. Plugin code never runs in the Electron main process.
 */
export class PluginServiceSupervisor {
  private readonly services = new Map<string, ServiceRecord>();
  private readonly logs = new Map<string, PluginServiceLogEntry[]>();
  private readonly options: Required<Omit<PluginServiceSupervisorOptions, "environment">> & {
    environment: NodeJS.ProcessEnv;
  };
  private syncing = Promise.resolve();
  private disposed = false;
  private readonly hostGate: Promise<void>;
  private openHost: () => void = () => undefined;

  constructor(options: PluginServiceSupervisorOptions) {
    this.hostGate = options.waitForHost ? new Promise((resolve) => { this.openHost = resolve; }) : Promise.resolve();
    this.options = {
      environment: process.env,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      stopGraceMs: DEFAULT_STOP_GRACE_MS,
      restartDelaysMs: DEFAULT_RESTART_DELAYS_MS,
      maxRestarts: DEFAULT_MAX_RESTARTS,
      restartWindowMs: DEFAULT_RESTART_WINDOW_MS,
      maxFrameBytes: PLUGIN_SERVICE_MAX_FRAME_BYTES,
      maxQueuedBytes: DEFAULT_MAX_QUEUED_BYTES,
      waitForHost: false,
      ...options
    };
  }

  /** Makes the running set equal to `specs`: stops removed or changed services, starts new ones. */
  sync(specs: readonly PluginServiceSpec[]): Promise<void> {
    const next = this.syncing.catch(() => undefined).then(async () => {
      const desired = new Map(specs.map((spec) => [serviceKey(spec.pluginId, spec.serviceId), spec]));
      const stops: Promise<void>[] = [];
      for (const [key, record] of this.services) {
        const spec = desired.get(key);
        if (!spec || !sameSpec(spec, record.spec) || this.disposed) stops.push(this.remove(key, record));
      }
      await Promise.all(stops);
      if (this.disposed) return;
      for (const [key, spec] of desired) {
        if (this.services.has(key)) continue;
        const record: ServiceRecord = {
          spec,
          state: "stopped",
          child: null,
          pending: new Map(),
          nextId: 1,
          crashes: [],
          restarts: 0,
          restartTimer: null,
          removed: false,
          exited: null,
          queuedBytes: 0
        };
        this.services.set(key, record);
        await this.start(record);
      }
    });
    this.syncing = next;
    return next;
  }

  /** Sends a request from the plugin's own UI to its own service. */
  request(pluginId: string, serviceId: string, method: string, params: unknown): Promise<unknown> {
    if (typeof method !== "string" || !/^[A-Za-z0-9_.:/-]{1,80}$/.test(method) || method.startsWith(HOST_METHOD_PREFIX)) {
      return Promise.reject(new Error("Plugin service method is invalid."));
    }
    return this.send(pluginId, serviceId, method, params, this.options.requestTimeoutMs);
  }

  /** A host notification (`canvastty.*`, no answer); false when the service is not running. */
  notify(pluginId: string, serviceId: string, method: `canvastty.${string}`, params: unknown): boolean {
    const record = this.services.get(serviceKey(pluginId, serviceId));
    if (!record?.child || record.state !== "running") return false;
    let frame: string;
    try {
      frame = JSON.stringify({ jsonrpc: "2.0", method, params: params === undefined ? null : params });
    } catch {
      return false;
    }
    if (Buffer.byteLength(frame, "utf8") >= this.options.maxFrameBytes) return false;
    return this.write(record, frame);
  }

  /**
   * A host-initiated call (`canvastty.*`, which plugin surfaces cannot send) with its own time budget, bounded by
   * MAX_HOST_CALL_TIMEOUT_MS (not by the surface request default, which would cut a longer decision budget short).
   */
  hostCall(pluginId: string, serviceId: string, method: `canvastty.${string}`, params: unknown, timeoutMs: number): Promise<unknown> {
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_HOST_CALL_TIMEOUT_MS) : this.options.requestTimeoutMs;
    return this.send(pluginId, serviceId, method, params, budget);
  }

  private send(pluginId: string, serviceId: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const record = this.services.get(serviceKey(pluginId, serviceId));
    if (!record || !record.child || (record.state !== "running" && record.state !== "starting")) {
      return Promise.reject(new Error("Plugin service is not running."));
    }
    if (record.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Plugin service is busy."));
    }
    const id = record.nextId++;
    let frame: string;
    try {
      frame = JSON.stringify({ jsonrpc: "2.0", id, method, params: params === undefined ? null : params });
    } catch {
      return Promise.reject(new Error("Plugin service request must be JSON serializable."));
    }
    if (Buffer.byteLength(frame, "utf8") >= this.options.maxFrameBytes) {
      return Promise.reject(new Error("Plugin service request exceeds the 1 MB message limit."));
    }
    // Same backpressure check `write()` makes, done up front so a request that cannot be queued
    // right now is rejected as "busy" rather than silently added to `pending` and only timing out.
    if (record.queuedBytes + Buffer.byteLength(frame, "utf8") + 1 > this.options.maxQueuedBytes) {
      return Promise.reject(new Error("Plugin service is busy."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.pending.delete(id);
        reject(new Error("Plugin service request timed out."));
      }, timeoutMs);
      timer.unref();
      record.pending.set(id, { resolve, reject, timer });
      if (!this.write(record, frame)) {
        clearTimeout(timer);
        record.pending.delete(id);
        reject(new Error("Plugin service is not running."));
      }
    });
  }

  /** The service is running (or starting): what it declares may be offered now. */
  running(pluginId: string, serviceId: string): boolean {
    const state = this.services.get(serviceKey(pluginId, serviceId))?.state;
    return state === "running" || state === "starting";
  }

  report(pluginId: string): PluginServiceReport {
    const services: PluginServiceStatus[] = [];
    for (const record of this.services.values()) {
      if (record.spec.pluginId !== pluginId) continue;
      services.push({
        serviceId: record.spec.serviceId,
        state: record.state,
        restarts: record.restarts,
        ...(record.lastError ? { lastError: record.lastError } : {})
      });
    }
    return { services, log: structuredClone(this.logs.get(pluginId) ?? []) };
  }

  /** Drops the in-memory log of an uninstalled plugin. */
  forget(pluginId: string): void {
    this.logs.delete(pluginId);
  }

  /** The host APIs services may call exist now (waitForHost): services start, and the ones waiting start now. */
  hostReady(): void {
    this.openHost();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // A start still waiting for the host ends without spawning anything.
    this.openHost();
    await this.sync([]);
  }

  private async start(record: ServiceRecord): Promise<void> {
    const { spec } = record;
    record.restartTimer = null;
    await this.hostGate;
    if (record.removed || this.disposed) return;
    record.state = "starting";
    let entryUrl: string;
    try {
      // Node loads the main entry by its real path; the guard matches that URL.
      entryUrl = pathToFileURL(await realpath(spec.entryPath)).href;
      const content = await readFile(spec.entryPath);
      if (createHash("sha256").update(content).digest("hex") !== spec.sha256) {
        // The file changed after the user trusted it: never run it, and do not retry.
        this.fail(record, "The service entry changed after it was trusted. Trust the plugin's native code again.");
        return;
      }
      await mkdir(spec.dataDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.fail(record, `The service could not start: ${errorText(error)}`);
      return;
    }
    if (record.removed || this.disposed) {
      record.state = "stopped";
      return;
    }

    // The check above and node's own read of the entry are separate reads: a file
    // replaced in between would run as trusted. The guard makes node run only
    // bytes it read and hashed itself, so what runs is what matched the hash,
    // wherever node resolves `spec.entryPath` by then.
    const child = spawn(this.options.command, [...entryGuardArguments(entryUrl, spec.sha256), spec.entryPath], {
      cwd: spec.root,
      env: pluginServiceEnvironment(this.options.environment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    record.child = child;
    record.exited = new Promise((resolve) => {
      let settled = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        resolve();
        this.exited(record, child, code, signal, error);
      };
      child.once("error", (error) => finish(null, null, error));
      child.once("exit", (code, signal) => finish(code, signal));
    });
    child.once("spawn", () => {
      if (record.child === child) record.state = "running";
      this.log(spec, "host", "info", `Started (pid ${child.pid ?? "?"}).`);
    });
    child.stdin?.on("error", () => undefined);
    // Frames over the limit are dropped up to their newline instead of buffered.
    const frames = new NdjsonLineReader({ maxLineBytes: this.options.maxFrameBytes, onOversize: () => this.dropFrame(record) });
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of frames.push(chunk)) this.frame(record, child, line.toString("utf8"));
    });
    child.stderr?.setEncoding("utf8");
    let stderr = "";
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      const lines = stderr.split("\n");
      stderr = lines.pop() ?? "";
      if (stderr.length > MAX_LOG_MESSAGE) {
        lines.push(stderr);
        stderr = "";
      }
      for (const line of lines) if (line.trim()) this.log(spec, "stderr", "warn", line);
    });
    this.write(record, JSON.stringify({
      jsonrpc: "2.0",
      method: "canvastty.initialize",
      params: {
        apiVersion: 2,
        pluginId: spec.pluginId,
        serviceId: spec.serviceId,
        dataDir: spec.dataDir,
        locale: this.options.locale(),
        hostVersion: this.options.hostVersion
      }
    }));
  }

  private exited(
    record: ServiceRecord,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error
  ): void {
    if (record.child !== child) return;
    record.child = null;
    this.options.host.stopped?.(record.spec.pluginId, record.spec.serviceId);
    for (const [id, pending] of record.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Plugin service stopped."));
      record.pending.delete(id);
    }
    if (record.removed || this.disposed) {
      record.state = "stopped";
      this.log(record.spec, "host", "info", "Stopped.");
      return;
    }
    const reason = error ? errorText(error) : signal ? `signal ${signal}` : `exit code ${code ?? "?"}`;
    const now = Date.now();
    record.crashes = record.crashes.filter((at) => now - at < this.options.restartWindowMs);
    record.crashes.push(now);
    if (record.crashes.length > this.options.maxRestarts) {
      this.fail(record, `The service stopped unexpectedly (${reason}) too often and will not be restarted.`);
      return;
    }
    const delays = this.options.restartDelaysMs;
    const delay = delays[Math.min(record.crashes.length - 1, delays.length - 1)] ?? 1_000;
    record.state = "backoff";
    record.lastError = `The service stopped unexpectedly (${reason}).`;
    this.log(record.spec, "host", "warn", `${record.lastError} Restarting in ${Math.round(delay / 1000)} s.`);
    record.restartTimer = setTimeout(() => {
      record.restarts += 1;
      void this.start(record);
    }, delay);
    record.restartTimer.unref();
  }

  private fail(record: ServiceRecord, message: string): void {
    record.state = "failed";
    record.lastError = message;
    this.log(record.spec, "host", "error", message);
  }

  private async remove(key: string, record: ServiceRecord): Promise<void> {
    record.removed = true;
    this.services.delete(key);
    if (record.restartTimer) clearTimeout(record.restartTimer);
    record.restartTimer = null;
    const child = record.child;
    if (!child) {
      record.state = "stopped";
      return;
    }
    // Polite first: a shutdown notification and closed stdin, then SIGTERM, then SIGKILL.
    this.write(record, JSON.stringify({ jsonrpc: "2.0", method: "canvastty.shutdown", params: {} }));
    child.stdin?.end();
    const exited = record.exited ?? Promise.resolve();
    if (await settlesWithin(exited, this.options.stopGraceMs)) return;
    child.kill("SIGTERM");
    if (await settlesWithin(exited, this.options.stopGraceMs)) return;
    child.kill("SIGKILL");
    await settlesWithin(exited, this.options.stopGraceMs);
  }

  /**
   * Writes one frame to the service's stdin, honoring backpressure: bytes already queued (written but
   * not yet drained by the OS pipe) count against maxQueuedBytes, and a write that would exceed the cap
   * is refused instead of piling up in node's unbounded internal write queue. A stuck or slow-reading
   * service therefore bounds memory growth instead of accepting requests indefinitely; the caller sees
   * false exactly as it would for a dead stdin, and rejects or drops the message accordingly.
   */
  private write(record: ServiceRecord, frame: string): boolean {
    const stdin = record.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    const bytes = Buffer.byteLength(frame, "utf8") + 1; // +1 for the newline
    if (record.queuedBytes + bytes > this.options.maxQueuedBytes) return false;
    record.queuedBytes += bytes;
    stdin.write(`${frame}\n`, () => {
      record.queuedBytes = Math.max(0, record.queuedBytes - bytes);
    });
    return true;
  }

  private dropFrame(record: ServiceRecord): void {
    this.log(record.spec, "host", "warn", "Dropped a service message larger than 1 MB.");
  }

  private frame(record: ServiceRecord, child: ChildProcess, line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(record.spec, "stdout", "info", line);
      return;
    }
    if (!isRecord(message)) return;
    const id = message.id;
    if (typeof message.method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        // The answer belongs to the process that asked. If it exited while the host was working,
        // a restarted process has its own request ids and must not receive this reply.
        const reply = (frame: string): void => {
          if (record.child === child) this.write(record, frame);
        };
        void this.hostRequest(record, message.method, message.params).then(
          (result) => reply(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null })),
          (error: unknown) => reply(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: error instanceof UnknownMethodError ? -32601 : -32000, message: errorText(error) }
          }))
        );
      } else {
        this.hostNotification(record, message.method, message.params);
      }
      return;
    }
    if (typeof id !== "number") return;
    const pending = record.pending.get(id);
    if (!pending) return;
    record.pending.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      const text = typeof message.error.message === "string" ? message.error.message : "Plugin service request failed.";
      pending.reject(new Error(text.slice(0, 240)));
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  /** The complete host API a service can call. Each method is checked against the manifest. */
  private async hostRequest(record: ServiceRecord, method: string, params: unknown): Promise<unknown> {
    const { spec } = record;
    const values = isRecord(params) ? params : {};
    if (method === "log") {
      this.serviceLog(spec, values);
      return null;
    }
    if (method === "storage.get" || method === "storage.set") {
      if (!spec.permissions.includes("storage")) throw new Error("Plugin does not have the storage permission.");
      if (typeof values.key !== "string") throw new Error("Plugin storage key is invalid.");
      if (method === "storage.get") return this.options.host.storageGet(spec.pluginId, values.key);
      await this.options.host.storageSet(spec.pluginId, values.key, values.value);
      return null;
    }
    if (method === "secrets.get" && this.options.host.secretGet) {
      // The plugin's own secrets only, to its own trusted native code; never to a web surface of another plugin.
      if (!spec.permissions.includes("secrets")) throw new Error("Plugin does not have the secrets permission.");
      if (typeof values.key !== "string") throw new Error("Plugin secret key is invalid.");
      const value = await this.options.host.secretGet(spec.pluginId, values.key);
      // A secret a service read is masked in everything agents read from then on, like launch secrets.
      if (typeof value === "string" && value.length >= 8) this.options.host.registerSecrets?.(spec.pluginId, [value]);
      return value;
    }
    if (method === "redaction.register") {
      // Only ever hides text; any service may use it. Values stay in memory and are never logged.
      if (!Array.isArray(values.values) || values.values.length > 32
        || values.values.some((value) => typeof value !== "string" || value.length > 4_096)) {
        throw new Error("Redaction values must be at most 32 strings of up to 4096 characters.");
      }
      this.options.host.registerSecrets?.(spec.pluginId, values.values as string[]);
      return null;
    }
    if (method === "redaction.mask") {
      if (typeof values.text !== "string" || values.text.length > 65_536) throw new Error("Redaction text must be at most 64 KiB.");
      if (!this.options.host.maskSecrets) throw new Error("Redaction is unavailable.");
      return {text: this.options.host.maskSecrets(values.text)};
    }
    if (method === "cards.setBadge" && this.options.host.setBadge) {
      if (!spec.permissions.includes("cards:decorate")) throw new Error("Plugin does not have the cards:decorate permission.");
      return this.options.host.setBadge(spec.pluginId, params);
    }
    if (method.startsWith("sessions.") && this.options.host.sessions) {
      const result = this.options.host.sessions(spec.pluginId, spec.serviceId, method, params, spec.permissions);
      if (result !== undefined) return result;
    }
    throw new UnknownMethodError(`Unknown host method: ${method.slice(0, 80)}.`);
  }

  private hostNotification(record: ServiceRecord, method: string, params: unknown): void {
    const values = isRecord(params) ? params : {};
    if (method === "log") {
      this.serviceLog(record.spec, values);
      return;
    }
    if (method === "event" && typeof values.event === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(values.event)) {
      this.options.host.emit(record.spec.pluginId, record.spec.serviceId, values.event, values.data ?? null);
    }
  }

  private serviceLog(spec: PluginServiceSpec, values: Record<string, unknown>): void {
    const level = values.level === "warn" || values.level === "error" ? values.level : "info";
    const message = typeof values.message === "string" ? values.message : JSON.stringify(values.message ?? "");
    this.log(spec, "service", level, message);
  }

  private log(
    spec: PluginServiceSpec,
    source: PluginServiceLogEntry["source"],
    level: PluginServiceLogEntry["level"],
    message: string
  ): void {
    const entries = this.logs.get(spec.pluginId) ?? [];
    entries.push({ at: Date.now(), serviceId: spec.serviceId, source, level, message: message.slice(0, MAX_LOG_MESSAGE) });
    if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
    this.logs.set(spec.pluginId, entries);
  }
}

class UnknownMethodError extends Error {}

function serviceKey(pluginId: string, serviceId: string): string {
  return `${pluginId}:${serviceId}`;
}

function sameSpec(left: PluginServiceSpec, right: PluginServiceSpec): boolean {
  return left.root === right.root
    && left.entryPath === right.entryPath
    && left.sha256 === right.sha256
    && left.dataDir === right.dataDir
    && left.permissions.length === right.permissions.length
    && left.permissions.every((permission) => right.permissions.includes(permission));
}

function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
