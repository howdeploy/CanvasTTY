export {};

declare global {
  interface Window {
    CanvasTTYPlugin: CanvasTTYPluginHost;
  }
}

export interface CanvasTTYPluginHost {
  ready(): void;
  request(method: "host.getContext"): Promise<CanvasTTYPluginContext>;
  request(method: "sessions.list"): Promise<CanvasTTYPluginSession[]>;
  request(method: "limits.get"): Promise<CanvasTTYPluginLimitsResult>;
  request(method: "launcher.open", params: { provider: "terminal" | "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" }): Promise<null>;
  request(method: "canvas.open", params: { contributionId: string }): Promise<null>;
  request(method: "external.open", params: { url: string }): Promise<null>;
  request(method: "browser.open", params: { url: string }): Promise<null>;
  request(method: "window.open", params: { contributionId: string }): Promise<null>;
  request(method: "media.pickLibrary"): Promise<CanvasTTYPluginMediaLibrary | null>;
  request(method: "media.listLibraries"): Promise<CanvasTTYPluginMediaLibrary[]>;
  request(method: "media.scanLibrary", params: { libraryId: string }): Promise<CanvasTTYPluginMediaTrack[]>;
  request(method: "media.revokeLibrary", params: { libraryId: string }): Promise<null>;
  request(method: "playlists.list", params: { libraryId: string }): Promise<CanvasTTYPluginPlaylistFile[]>;
  request(method: "playlists.read", params: { libraryId: string; playlistId: string }): Promise<string>;
  request(method: "playlists.write", params: { libraryId: string; name: string; content: string }): Promise<CanvasTTYPluginPlaylistFile>;
  request(method: "hermesHud.getState"): Promise<CanvasTTYPluginHermesHudSnapshot>;
  request(method: "hermesHud.open"): Promise<CanvasTTYPluginHermesHudSnapshot>;
  request(method: "hermesHud.close"): Promise<CanvasTTYPluginHermesHudSnapshot>;
  request(method: "secrets.get", params: { key: string }): Promise<string | null>;
  request(method: "secrets.set", params: { key: string; value: string }): Promise<null>;
  request(method: "secrets.delete", params: { key: string }): Promise<null>;
  request(method: "service.request", params: { serviceId: string; method: string; params?: unknown }): Promise<unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  canvas: {
    open(contributionId: string): Promise<void>;
  };
  media: {
    pickLibrary(): Promise<CanvasTTYPluginMediaLibrary | null>;
    listLibraries(): Promise<CanvasTTYPluginMediaLibrary[]>;
    scanLibrary(libraryId: string): Promise<CanvasTTYPluginMediaTrack[]>;
    revokeLibrary(libraryId: string): Promise<null>;
  };
  playlists: {
    list(libraryId: string): Promise<CanvasTTYPluginPlaylistFile[]>;
    read(libraryId: string, playlistId: string): Promise<string>;
    write(libraryId: string, name: string, content: string): Promise<CanvasTTYPluginPlaylistFile>;
  };
  hermesHud: {
    getState(): Promise<CanvasTTYPluginHermesHudSnapshot>;
    open(): Promise<CanvasTTYPluginHermesHudSnapshot>;
    close(): Promise<CanvasTTYPluginHermesHudSnapshot>;
  };
  /** Talks to this plugin's own services only (apiVersion 2 `services`). */
  service: {
    /** Rejects when the service is not running (native code not trusted, disabled, restarting, failed) or after 15 s. */
    request(serviceId: string, method: string, params?: unknown): Promise<unknown>;
    onEvent(listener: (event: CanvasTTYPluginServiceEvent) => void): () => void;
  };
  onContext(listener: (context: CanvasTTYPluginContext) => void): () => void;
  onStorageChange(listener: (key: string, value: unknown) => void): () => void;
  /** "hidden" while the plugin's card is not drawn (summary zoom, HOME editing, off-screen, minimized window). */
  visibility(): "visible" | "hidden";
  /** Called on every change of `visibility()`; the same moment `document` fires `visibilitychange`. */
  onVisibilityChange(listener: (state: "visible" | "hidden") => void): () => void;
}

export interface CanvasTTYPluginContext {
  apiVersion: 1;
  plugin: {
    id: string;
    name: string;
    version: string;
    permissions: Array<"storage" | "secrets" | "sessions:read" | "limits:read" | "launcher:open" | "external:open" | "browser:open" | "media:library" | "playlists:read" | "playlists:write" | "hermes:hud" | "network" | "launch:contribute" | "environment:provide" | "decision:provide" | "tools:agents" | "sessions:events" | "sessions:read-screen" | "sessions:launch" | "sessions:control" | "cards:decorate" | "browser:engine">;
    modules: string[];
  };
  contribution: {
    id: string;
    kind: "home-widget" | "canvas-app" | "window";
    title: string;
  };
  appearance: {
    locale: "ru" | "en";
    palette: "sage" | "lilac" | "night";
  };
}

export interface CanvasTTYPluginSession {
  id: string;
  provider: "terminal" | "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi";
  title: string;
  status: "idle" | "working" | "needs_approval" | "unavailable" | "done" | "failed";
  startedAt: number;
  exitCode: number | null;
}

export interface CanvasTTYPluginMediaLibrary {
  id: string;
  name: string;
}

export interface CanvasTTYPluginMediaTrack {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
  streamUrl: string;
}

export interface CanvasTTYPluginPlaylistFile {
  id: string;
  name: string;
  relativePath: string;
  size: number;
}

export type CanvasTTYPluginHermesHudSnapshot =
  | { state: "unavailable"; reason: "cli-not-found"; message: string }
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "stopping" }
  | { state: "running"; hudOpen: boolean }
  | { state: "error"; message: string };

export type CanvasTTYPluginLimitsResult =
  | { state: "loading"; snapshot: null }
  | { state: "ready"; snapshot: unknown };

/** Stdin payload for an explicitly enabled native agent hook entry. */
export interface CanvasTTYAgentHookInput {
  apiVersion: 1;
  pluginId: string;
  hookId: string;
  terminalSessionId: string;
  provider: "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok";
  event: "session-start" | "prompt-submit" | "permission-request" | "permission-result" | "after-tool" | "stop" | "session-end";
  providerEvent: string;
  payload: unknown;
}

export interface CanvasTTYPluginServiceEvent {
  serviceId: string;
  event: string;
  data: unknown;
}

/**
 * Plugin services (manifest apiVersion 2). A service is a bundled single-file Node.js program that
 * CanvasTTY runs as a separate process after the user trusts the plugin's native code. It speaks
 * newline-delimited JSON-RPC 2.0 over stdin/stdout, at most 1 MB per message.
 */
export interface CanvasTTYPluginServiceManifestEntry {
  id: string;
  title: string;
  description?: string;
  /** `.js`, `.mjs` or `.cjs` inside the plugin; integrity-declared in modular plugins. */
  entry: string;
  module?: string;
  /** Launch contributor; needs `launch:contribute`. At most one service per plugin. */
  launch?: CanvasTTYServiceLaunch;
  /** Session environments; needs `environment:provide`. At most 8 kinds per plugin, unique across its services. */
  environments?: CanvasTTYEnvironmentKind[];
  /** Decision hooks; needs `decision:provide`. At most one service per plugin. */
  decide?: CanvasTTYServiceDecide;
  /** Agent tools in canvastty_agents; needs `tools:agents`. Up to 16; names unique within the plugin. */
  tools?: CanvasTTYAgentTool[];
  /** Card actions; needs `cards:decorate`. Up to 8; ids unique within the plugin. */
  cardActions?: CanvasTTYCardAction[];
  /** A browser engine for agents' background tabs; needs `browser:engine`. Ids unique within the plugin. */
  browserEngine?: CanvasTTYBrowserEngine;
}

/**
 * The host calls `canvastty.browserEngine.openTab` `{ engineId, tabId }` for each agent background tab and expects
 * `{ webSocketUrl }`: a `ws://` CDP endpoint on 127.0.0.1, [::1] or localhost with a port, one page per connection.
 * `canvastty.browserEngine.closeTab` `{ engineId, tabId }` is a notification.
 */
export interface CanvasTTYBrowserEngine {
  /** What agents pass as `engine` to browser_new_tab: `^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`, never `auto` or `chromium`. */
  id: string;
  title: string;
  description?: string;
  /** Real layout (boxes, viewport). Omitted or false: observation skips geometry, clicks and hovers go through the DOM. */
  layout?: boolean;
}

export type CanvasTTYSessionRole = "agent" | "orchestrator" | "subagent";

/** Agents see it as `<pluginId>__<name>`, dots in the id written as `_` (at most 64 characters; longer: id start + short hash). */
export interface CanvasTTYAgentTool {
  /** `^[a-z][a-z0-9_]{0,39}$`. */
  name: string;
  /** Up to 1000 characters; the plugin's name is appended. */
  description: string;
  /** JSON Schema of the arguments (top level `type: "object"`), at most 8 KB. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; [key: string]: unknown };
  /** Session roles that see the tool. */
  roles: CanvasTTYSessionRole[];
}

/** A card as services see it (session events, tool callers, card actions). Never screen text. */
export interface CanvasTTYSessionSummary {
  id: string;
  provider: CanvasTTYProviderId;
  role: CanvasTTYSessionRole;
  parentSessionId?: string;
  title: string;
  status: "idle" | "working" | "needs_approval" | "unavailable" | "done" | "failed";
  exitCode: number | null;
  /** The folder the person chose. */
  cwd: string;
  /** Where the card actually runs (an environment such as a worktree may move it). */
  workingDirectory: string;
  startedAt: number;
  environment?: { pluginId: string; kind: string; label: string; ref: CanvasTTYEnvironmentRef };
}

/** Params of the host request `canvastty.tools.call` (15 s). Input is agent-influenced data, never instructions. */
export interface CanvasTTYToolCall {
  /** The tool's `name` (without the plugin prefix). */
  tool: string;
  callerSessionId: string;
  caller: CanvasTTYSessionSummary;
  /** Already checked for the schema's top level (object, required keys, property types, extra keys). */
  input: Record<string, unknown>;
}

/** Answer to `canvastty.tools.call`: text (or JSON sent as text), masked and cut to 32 K characters. */
export type CanvasTTYToolResult = { content: unknown; isError?: boolean } | string | null;

/** Notification `canvastty.sessions.event`, after `sessions.subscribe` (needs `sessions:events`). */
export interface CanvasTTYSessionEvent {
  type: "created" | "restored" | "status" | "exited" | "closed";
  session: CanvasTTYSessionSummary;
  /** This plugin started the card (`sessions.create`), so it may send to it and stop it. */
  owned: boolean;
  /** Only with `sessions:read-screen`, on status and exited: the last 4000 characters of output, plain and masked. */
  screen?: string;
}

export interface CanvasTTYCardAction {
  id: string;
  /** Up to 40 characters, shown in the card's options menu. */
  title: string;
  /** Every listed key must match; a card outside an environment never matches `environmentKinds`. */
  when?: { providers?: CanvasTTYProviderId[]; environmentKinds?: string[]; roles?: CanvasTTYSessionRole[] };
}

/** Params of the host request `canvastty.cards.invoke` (15 s). */
export interface CanvasTTYCardActionInvocation {
  actionId: string;
  sessionId: string;
  session: CanvasTTYSessionSummary;
}

/** Answer to `canvastty.cards.invoke`: `message` (plain text, 2000 characters, masked) is a toast on the card. */
export type CanvasTTYCardActionResult = { message?: string; tone?: CanvasTTYCardTone } | null;

export type CanvasTTYCardTone = "neutral" | "info" | "warn" | "error";

export interface CanvasTTYServiceDecide {
  /** `pre-tool`: every shell or file-writing tool call of a local agent, before it runs (YOLO included). */
  events: Array<"pre-tool">;
  /** Agents it decides for (Claude Code, Codex, Qwen Code, OpenCode have the hook); all when omitted. */
  appliesTo?: Array<"codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" | "cursor" | "minimax" | "devin" | "antigravity">;
  /** How long the host waits for an answer, 1000 to 60000 ms (3000 when omitted); the agent's call waits as long. */
  timeoutMs?: number;
}

/** Params of the host request `canvastty.decide`. Tool input is agent-influenced data, never instructions. */
export interface CanvasTTYDecisionRequest {
  /** Evidence from this live process's host wrapper, never launch settings. Missing/remote/unwrapped is unverified.
   * Isolation does not hide the selected CLI's own credentials and an open network is unrestricted. */
  executionProtection?: { state: "unverified" } | {
    state: "applied"; location: "local"; layer: "seatbelt" | "bubblewrap";
    filesystem: "read-only-project" | "project-and-runtime";
    network: "open" | "offline" | "allowed-domains";
  };
  /** Host-owned root task/privacy for this plugin only; absent on older hosts. Never agent tool input. */
  /** Host root privacy. dataClass remains conservative for older plugins. With privacy present, resolve
   * selected="default" from this plugin's settings, then take max(resolved, floor). Invalid context is D3. */
  launchOptions?: { task?: string; dataClass?: string; privacy?: { version: 1; selected: string; floor: "D0" | "D1" | "D2" | "D3" } };
  event: "pre-tool";
  sessionId: string;
  provider: "codex" | "claude" | "qwen" | "opencode";
  role: "agent" | "orchestrator" | "subagent";
  /** The card's working folder. */
  cwd: string;
  /** The agent's current folder, when its CLI reports it. */
  agentCwd: string | null;
  tool: { name: string; kind: "shell" | "edit" | "other"; command: string | null; paths: string[] };
  /** The tool input as the agent sent it; null when it was over 40 KB (then `truncated`). */
  input: unknown;
  truncated: boolean;
  /** How long the host waits for this answer (the service's `timeoutMs`). */
  budgetMs: number;
}

/**
 * Answer to `canvastty.decide` within `budgetMs`; `null` (or `verdict: "none"`) is no opinion. Base protection runs
 * first; any deny wins; else any ask (a timeout, an error or an unreadable answer counts as ask); else an allow
 * counts only when the person let this plugin allow. `reason` (500 characters) reaches the model.
 */
export type CanvasTTYDecision = { verdict: "deny" | "ask" | "allow" | "none"; reason?: string } | null;

export type CanvasTTYProviderId = "terminal" | "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" | "cursor" | "minimax" | "devin" | "antigravity";

export interface CanvasTTYEnvironmentKind {
  /** `^[a-z0-9][a-z0-9-]{0,31}$`, unique within the service. */
  kind: string;
  label: string;
  description?: string;
  /** Providers it applies to ("terminal" included); all when omitted. */
  appliesTo?: CanvasTTYProviderId[];
  /** At most 8 launcher fields; values reach `prepare` only. */
  fields?: CanvasTTYLaunchField[];
  /** What of CanvasTTY's protection reaches the agent there; undeclared means no (see docs/plugins.md). */
  keeps?: { launch?: boolean; isolated?: boolean; confines?: boolean };
}

/** Opaque to CanvasTTY: saved with the card (at most 4 KB of JSON) and handed back unchanged. */
export type CanvasTTYEnvironmentRef = unknown;

/** `canvastty.environment.prepare` (15 s): create the place once, when the card first starts. */
export interface CanvasTTYEnvironmentPrepareParams {
  sessionId: string;
  kind: string;
  provider: CanvasTTYProviderId;
  cwd: string;
  options: Record<string, boolean | string>;
}
export type CanvasTTYEnvironmentPrepareResult =
  /** `label` is the card badge (80 characters); `cwd` (an existing absolute folder) becomes the card's folder. */
  | { ref: CanvasTTYEnvironmentRef; label: string; cwd?: string }
  | { refuse: { reason: string } };

/** `canvastty.environment.wrap` (5 s): before every start; the host still spawns the PTY. */
export interface CanvasTTYEnvironmentWrapParams {
  sessionId: string;
  kind: string;
  ref: CanvasTTYEnvironmentRef;
  provider: CanvasTTYProviderId;
  command: string;
  args: string[];
  /** The launch's own variables, without reserved `CANVASTTY_*` names and without secret values. */
  env: Record<string, string>;
  /** Names whose values the spawned process gets from the host (forward them by name). */
  secretEnvNames: string[];
  cwd: string;
}
export type CanvasTTYEnvironmentWrapResult =
  | {
    /** An absolute path to an executable, or a bare program name resolved on PATH. Never a shell string. */
    command: string;
    /** At most 256, 8 KB each, no NUL. */
    args: string[];
    /** Launch-contributor rules: no reserved names, no names this launch already sets. */
    env?: Record<string, string>;
    /** Env name -> the plugin's own secret key (needs `secrets`); set and masked by the host. */
    secretEnv?: Record<string, string>;
    /** An existing absolute folder; the launch's folder when omitted. */
    cwd?: string;
  }
  | { refuse: { reason: string } };

/** `canvastty.environment.resume` (10 s): on restore, and before restarting a card from an earlier run. */
export type CanvasTTYEnvironmentResumeResult = { ok: true } | { stopped: { reason: string } };

/** `canvastty.environment.release` (10 s): the card was closed, the app quit with saving off, or a `prepare` answer came after its launch was gone. */
export interface CanvasTTYEnvironmentReleaseParams {
  sessionId: string;
  kind: string;
  ref: CanvasTTYEnvironmentRef;
  /** The person's answer to "Keep environment data?"; always true when quitting. */
  keepData: boolean;
  reason: "closed" | "quit";
}

/** `canvastty.environment.describe` (3 s): the card badge and its tooltip. */
export interface CanvasTTYEnvironmentDescribeResult {
  label: string;
  detail?: string;
}

export interface CanvasTTYServiceLaunch {
  /** Agent providers the options apply to; every agent when omitted. */
  appliesTo?: Array<"codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" | "cursor" | "minimax" | "devin" | "antigravity">;
  /** At most 8, shown in the agent launcher under Advanced (a policy with none is not shown). */
  fields: CanvasTTYLaunchField[];
  /** Also asked before every launch of these agents where the person did not choose the plugin (`chosen: false`);
   * such an answer may only refuse, and no answer refuses too. */
  policy?: boolean;
  /** An orchestrator may choose these options for its subagents (spawn_agent launchOptions); otherwise only the person. */
  delegable?: boolean;
}

export type CanvasTTYLaunchField =
  | { key: string; label: string; kind: "boolean"; default?: boolean }
  | {
    key: string; label: string; kind: "select"; options: Array<{ value: string; label: string }>; default?: string;
    /** The launcher also asks `canvastty.launch.options` (3 s) for up to 64 more choices; the saved value is then any
     * text up to 200 characters, which `canvastty.launch.prepare` must check. */
    optionsFrom?: "service";
  }
  | { key: string; label: string; kind: "text"; maxLength?: number; default?: string };

/** Params of the host request `canvastty.launch.prepare`: launches that chose this plugin, and with `policy` every agent launch. */
export interface CanvasTTYLaunchContext {
  sessionId: string;
  provider: "terminal" | "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" | "cursor" | "minimax" | "devin" | "antigravity";
  /** "auto" only for agents with a native auto mode (Codex, Claude Code, Grok). */
  profile: "normal" | "yolo" | "auto";
  role: "agent" | "orchestrator" | "subagent";
  cwd: string;
  parentSessionId?: string;
  /** The app is bringing back a saved card. */
  restoring: boolean;
  /** The agent continues an earlier conversation. */
  resume: boolean;
  /** This plugin's values for this card, checked against its fields; empty when `chosen` is false. */
  options: Record<string, boolean | string>;
  /** The person chose this plugin for the launch; false for a policy check, whose answer may only refuse. */
  chosen: boolean;
  /** Where the card runs: the chosen or saved environment, or null on this computer. */
  environment: { pluginId: string; kind: string } | null;
  /** A subagent on this computer in (or below) the folder the person chose for its top-level agent: that real path. */
  trustedFolder?: string;
  /** Host-owned capability sent only to selected Accounts when execution policy requires public route proof.
   * Older cores reject unknown contribution fields: omit accountRoute unless this is exactly true. */
  accountRouteEvidence?: true;
}

/**
 * Answer to `canvastty.launch.prepare` (or `null`). Answer within 5 s: a timeout, error or invalid
 * answer refuses the launch. Conflicting names between plugins, reserved names and approval or
 * conversation arguments refuse it as well.
 */
export interface CanvasTTYLaunchContribution {
  /** Only the selected canvastty-accounts service may attribute the configured account. */
  accountId?: string;
  /** Only when accountRouteEvidence is true; copied from the same immutable account snapshot used for args/env.
   * No credentials. model <= 200 chars; endpoint is canonical host:port <= 300 chars (no URL/path).
   * Binds configured model, host:port and kind, not URL protocol/path or native CLI inference attestation. */
  accountRoute?: { model: string; endpoint: string; kind: "ollama" | "ollama-cloud" | "api-key" };
  /** At most 32; values up to 8 KB. `{launchFiles}` becomes this run's folder of `files`. */
  env?: Record<string, string>;
  /** Env name -> the plugin's own secret key (needs `secrets`); the host sets the value and masks it. */
  secretEnv?: Record<string, string>;
  /** At most 32, appended after CanvasTTY's own arguments. */
  args?: string[];
  /** At most 16 files, 256 KB, removed when the process exits. */
  files?: Array<{ relPath: string; content: string }>;
  /** The agent runs on another model than its vendor's: profile "auto" runs as accept-edits. Allowed in a policy. */
  thirdPartyModel?: boolean;
  refuse?: { reason: string };
}

/** Params of the first host notification, `canvastty.initialize`. */
export interface CanvasTTYServiceContext {
  apiVersion: 2;
  pluginId: string;
  serviceId: string;
  /** `<userData>/plugin-data/<pluginId>`: created before start, removed on uninstall. */
  dataDir: string;
  locale: string;
  hostVersion: string;
}

/** Notifications the host sends to a service. */
export type CanvasTTYServiceHostNotification =
  | { jsonrpc: "2.0"; method: "canvastty.initialize"; params: CanvasTTYServiceContext }
  | { jsonrpc: "2.0"; method: "canvastty.shutdown"; params: Record<string, never> }
  | { jsonrpc: "2.0"; method: "canvastty.sessions.event"; params: CanvasTTYSessionEvent };

/** Requests the host sends to a service, which plugin surfaces cannot send. */
export type CanvasTTYServiceHostRequest =
  | { jsonrpc: "2.0"; id: number; method: "canvastty.launch.prepare"; params: CanvasTTYLaunchContext }
  /** Answer `{ "<field key>": [{ value, label }] }` (at most 64 per field) within 3 s. */
  | { jsonrpc: "2.0"; id: number; method: "canvastty.launch.options"; params: { provider: CanvasTTYLaunchContext["provider"]; fields: string[] } }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.prepare"; params: CanvasTTYEnvironmentPrepareParams }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.wrap"; params: CanvasTTYEnvironmentWrapParams }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.resume"; params: { sessionId: string; kind: string; ref: CanvasTTYEnvironmentRef } }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.release"; params: CanvasTTYEnvironmentReleaseParams }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.environment.describe"; params: { sessionId: string; kind: string; ref: CanvasTTYEnvironmentRef } }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.decide"; params: CanvasTTYDecisionRequest }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.tools.call"; params: CanvasTTYToolCall }
  | { jsonrpc: "2.0"; id: number; method: "canvastty.cards.invoke"; params: CanvasTTYCardActionInvocation };

/** Methods a service may call on the host. Every other method is answered with error -32601. */
export interface CanvasTTYServiceHostApi {
  /** Request or notification. */
  log(params: { level?: "info" | "warn" | "error"; message: string }): null;
  /** Needs the `storage` permission. */
  "storage.get"(params: { key: string }): unknown;
  /** Needs the `storage` permission. */
  "storage.set"(params: { key: string; value: unknown }): null;
  /** Notification only: delivered to this plugin's surfaces through `host.service.onEvent`. */
  event(params: { event: string; data?: unknown }): void;
  /** Up to 32 values (8 to 4096 characters) masked in every text one agent reads from another; memory only. */
  "redaction.register"(params: { values: string[] }): null;
  /** Needs the `secrets` permission: the plugin's own secret, or null; the value is masked for agents from then on. */
  "secrets.get"(params: { key: string }): string | null;
  /** Needs `sessions:events`. Events follow as `canvastty.sessions.event`; call again after every start. */
  "sessions.subscribe"(params: { ownedOnly?: boolean }): { sessions: Array<CanvasTTYSessionSummary & { owned: boolean }> };
  "sessions.unsubscribe"(params: Record<string, never>): null;
  /** Needs `sessions:events`. */
  "sessions.list"(params: { ownedOnly?: boolean }): { sessions: Array<CanvasTTYSessionSummary & { owned: boolean }> };
  /** Needs `sessions:launch`. An `agent` card through the normal launch pipeline; at most 16 per plugin. */
  "sessions.create"(params: {
    provider: CanvasTTYProviderId; cwd: string; profile?: "normal" | "yolo" | "auto"; title?: string;
    launchOptions?: Record<string, Record<string, boolean | string>>;
    environment?: { pluginId: string; kind: string; options?: Record<string, boolean | string> };
  }): { sessionId: string };
  /** Needs `sessions:control`; only cards this plugin created. Enter is added unless `submit: false`. */
  /** Waits until a launch its plugins prepare has started; `sent` is false (and the text dropped) when it did not start. */
  "sessions.send"(params: { sessionId: string; text: string; submit?: boolean }): { sessionId: string; sent: boolean };
  /** Needs `sessions:control`; only cards this plugin created. Closes the card, keeps its environment data. */
  "sessions.stop"(params: { sessionId: string }): { sessionId: string; stopped: true };
  /** Needs `cards:decorate`. `null` removes this plugin's badge from the card. */
  "cards.setBadge"(params: { sessionId: string; badge: { text: string; tone?: CanvasTTYCardTone; tooltip?: string } | null }): null;
}
