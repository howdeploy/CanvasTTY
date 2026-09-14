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
  onContext(listener: (context: CanvasTTYPluginContext) => void): () => void;
  onStorageChange(listener: (key: string, value: unknown) => void): () => void;
}

export interface CanvasTTYPluginContext {
  apiVersion: 1;
  plugin: {
    id: string;
    name: string;
    version: string;
    permissions: Array<"storage" | "secrets" | "sessions:read" | "limits:read" | "launcher:open" | "external:open" | "browser:open" | "media:library" | "playlists:read" | "playlists:write" | "hermes:hud" | "network">;
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
