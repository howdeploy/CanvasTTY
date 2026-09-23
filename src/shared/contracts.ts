import { accountRouteMaxDataClass } from "./providerAccountPolicy.ts";
import { CANVAS_LAUNCHER_ITEMS, PROVIDER_LABELS, type CanvasLauncherItemId, type ProviderId } from "./providerCatalog.ts";
export { CANVAS_LAUNCHER_ITEMS, PROVIDER_LABELS };
export type { CanvasLauncherItemId, ProviderId };
export type AgentProviderId = Exclude<ProviderId, "terminal">;
export type AgentCliAvailability = Record<AgentProviderId, boolean>;
export type LimitProviderId = Extract<AgentProviderId, "codex" | "claude" | "qwen" | "kimi" | "opencode" | "grok">;
export type LaunchProfileId = "normal" | "yolo";
export type SessionRole = "interactive" | "orchestrator" | "subagent";
export type SessionStatus = "idle" | "working" | "needs_approval" | "unavailable" | "done" | "failed";
export type PaletteId = "sage" | "lilac" | "night";
export type HomeAccentPresetId = "classic" | "warm" | "cool" | "mono" | "custom";
export type SessionRowColorMode = "monochrome" | "status";
export type CanvasColorId = "sage" | "lilac" | "night" | "sand" | "mist" | "rose" | "slate";
export type CanvasPatternId = "dots" | "grid" | "waves" | "diagonal" | "rings" | "none";
export type LocaleId = "ru" | "en";
export type MediaFit = "cover" | "contain";
export type EdgePanSpeed = "slow" | "normal" | "fast";
export type ZoomSensitivity = "slow" | "normal" | "fast";
export type CanvasWheelCaptureMode = "off" | "always" | "key";
export type CanvasNavigationMouseButton = "Mouse3" | "Mouse4" | "Mouse5";
export type CanvasOverlayPlacement = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type MinimapInteractionMode = "click" | "drag";
export type BrowserViewportSurface = "native" | "placeholder" | "hidden";
export type FocusActivation = "off" | "single" | "double";
export type ShortcutAction = "home" | "renameWindow";
export type RadialLauncherActionId = "note" | "browser" | "settings";
export type RadialLauncherItemId = ProviderId | RadialLauncherActionId;

// Keeps the safe provider subset proposed by @TroopJostle in PR #23 while
// region, note, Browser, and Settings remain fixed top-level menu actions.
export const DEFAULT_CANVAS_LAUNCHER_ITEMS: readonly CanvasLauncherItemId[] = [
  "codex",
  "claude",
  "qwen",
  "opencode",
  "terminal"
];

export const RADIAL_LAUNCHER_ITEMS: readonly RadialLauncherItemId[] = [
  "codex",
  "claude",
  "qwen",
  "kimi",
  "opencode",
  "hermes",
  "grok",
  "omp",
  "pi",
  "cursor",
  "minimax",
  "devin",
  "antigravity",
  "terminal",
  "note",
  "browser",
  "settings"
];

export const DEFAULT_RADIAL_LAUNCHER_ITEMS: readonly RadialLauncherItemId[] = [
  "codex",
  "claude",
  "qwen",
  "opencode",
  "note",
  "terminal",
  "browser",
  "settings"
];

export const UI_SCALE_MIN = 0.85;
export const UI_SCALE_MAX = 1.25;
export const UI_SCALE_STEP = 0.05;
export const DEFAULT_UI_SCALE = 1;

export interface HomeAccentColors {
  clock: string;
  launcher: string;
  browser: string;
  settings: string;
  media: string;
}

export const DEFAULT_HOME_ACCENT_COLORS: HomeAccentColors = {
  clock: "#D8E1C5",
  launcher: "#B8CF99",
  browser: "#9CC7DC",
  settings: "#D5A2C9",
  media: "#D5A2C9"
};

export const HOME_GRID_MIN_COLUMNS = 12;
export const HOME_GRID_MIN_ROWS = 8;
export const HOME_GRID_MAX_COLUMNS = 48;
export const HOME_GRID_MAX_ROWS = 36;
export const HOME_GRID_CELL_WIDTH = 82;
export const HOME_GRID_CELL_HEIGHT = 72;
export const HOME_GRID_GAP = 18;

export interface HomeGridSize {
  columns: number;
  rows: number;
}

export const DEFAULT_HOME_GRID_SIZE: HomeGridSize = {
  columns: 16,
  rows: 12
};

export type CoreHomeWidgetId =
  | "core.limits"
  | "core.sessions"
  | "core.clock"
  | "core.media"
  | "core.launcher"
  | "core.settings";

export interface HomeWidgetPlacement {
  widgetId: string;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
}

export const DEFAULT_HOME_LAYOUT: HomeWidgetPlacement[] = [
  { widgetId: "core.limits", column: 0, row: 0, columnSpan: 7, rowSpan: 3 },
  { widgetId: "core.sessions", column: 7, row: 0, columnSpan: 5, rowSpan: 3 },
  { widgetId: "core.clock", column: 0, row: 3, columnSpan: 9, rowSpan: 3 },
  { widgetId: "core.media", column: 9, row: 3, columnSpan: 3, rowSpan: 3 },
  { widgetId: "core.launcher", column: 0, row: 6, columnSpan: 10, rowSpan: 2 },
  { widgetId: "core.settings", column: 10, row: 6, columnSpan: 2, rowSpan: 2 }
];

export interface ShortcutBindings {
  home: string;
  renameWindow: string;
}

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  home: "Home",
  renameWindow: "F2"
};

export const INITIAL_TERMINAL_COLS = 80;
export const INITIAL_TERMINAL_ROWS = 24;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface SessionBounds {
  position: Point;
  size: Size;
}

export interface StickyNote extends SessionBounds {
  id: string;
  text: string;
}

export const STICKY_NOTE_MIN_SIZE: Size = { width: 180, height: 140 };
export const STICKY_NOTE_MAX_SIZE: Size = { width: 1_000, height: 800 };
export const STICKY_NOTE_DEFAULT_SIZE: Size = { width: 300, height: 220 };

export interface CameraState extends Point {
  zoom: number;
}

export interface AgentBudgets {
  maxLocalAgents: number;
  maxRemoteAgentsPerHost: number;
  maxChildren: number;
  maxDepth: number;
}

export const DEFAULT_AGENT_BUDGETS: Readonly<AgentBudgets> = Object.freeze({
  maxLocalAgents: 4, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2
});

export interface AppSettings {
  locale: LocaleId;
  restoreTerminalSessions: boolean;
  persistCanvasRegions: boolean;
  persistStickyNotes: boolean;
  palette: PaletteId;
  homeAccentPreset: HomeAccentPresetId;
  homeAccentColors: HomeAccentColors;
  sessionRowColorMode: SessionRowColorMode;
  homeLauncherProviders: AgentProviderId[];
  homeLimitProviders: LimitProviderId[];
  canvasLauncherItems: CanvasLauncherItemId[];
  radialLauncherEnabled: boolean;
  radialLauncherItems: RadialLauncherItemId[];
  agentLifecycleHooksEnabled: boolean;
  uiScale: number;
  canvasColor: CanvasColorId;
  pattern: CanvasPatternId;
  snapToGrid: boolean;
  invertTerminalWheel: boolean;
  invertCanvasWheel: boolean;
  edgePan: boolean;
  edgePanSpeed: EdgePanSpeed;
  zoomSensitivity: ZoomSensitivity;
  useScrollWheelToZoom: boolean;
  canvasWheelCaptureMode: CanvasWheelCaptureMode;
  canvasWheelOverride: string | null;
  canvasNavigationOverride: string | null;
  focusActivation: FocusActivation;
  hoverFocus: boolean;
  hoverFocusSpeed: EdgePanSpeed;
  showShortcutHints: boolean;
  minimapPlacement: CanvasOverlayPlacement;
  minimapInteractionMode: MinimapInteractionMode;
  shortcutHintsPlacement: CanvasOverlayPlacement;
  canvasControlsPlacement: CanvasOverlayPlacement;
  shortcuts: ShortcutBindings;
  mediaPath: string | null;
  mediaFit: MediaFit;
  lastDirectory: string;
  acknowledgedDangerousProfiles: AgentProviderId[];
  /** Confidentiality tier applied to tasks that carry no explicit dataClass.
   *  Defaults to D2 (confidential): an unclassified repo is never implicitly
   *  public. */
  defaultDataClass: DataClass;
  apiProfiles: ApiProfile[];
  remoteHosts: RemoteHost[];
  /** Ordered path-class policies (Roadmap D6), FIRST MATCH WINS — see
   *  PathPolicy and dataClassForPath. Empty by default: no path carries an
   *  explicit class until the operator writes one. */
  pathPolicies: PathPolicy[];
  /** Subscriptions per provider; see ProviderAccount. Drives spawn's account
   *  routing (model coverage + per-account privacy caps). */
  providerAccounts: ProviderAccount[];
  agentBudgets: AgentBudgets;
  /** Configured enabled subscriptions of one provider on one host. */
  maxAccountsPerProviderPerHost: 1 | 2;
  /** Profiles that require a separate worktree or container. Worktrees are not OS sandboxes. */
  requiresSandboxProfiles: LaunchProfileId[];
  containerProfiles: ContainerProfile[];
  homeGridSize: HomeGridSize;
  homeLayout: HomeWidgetPlacement[];
  canvasRegions: CanvasRegion[];
  stickyNotes: StickyNote[];
  pluginCanvas: PluginCanvasInstance[];
  browserCanvas: BrowserCanvasState | null;
  browserAgentAccess: boolean;
  browserShowAgentPresence: boolean;
  browserRestoreTabs: boolean;
}

export interface ContainerProfile {
  id: string; label: string; hostId: string; runtime: "docker" | "podman";
  executable: string; endpoint: { kind: "native" } | { kind: "unix"; socket: string };
  image: string; python: string; hostPython?: string; commands: Partial<Record<ProviderId, string>>;
  network: "none" | "bridge"; cpus: number; memoryMb: number; pids: number; user: string;
}
export interface ContainerAvailability { available: boolean; runtime: "docker" | "podman"; rootless?: boolean; imageId?: string; reason?: string }
export interface RetainedContainer { id: string; profileId: string; hostId: string; workspaceId: string; containerId?: string; state: "preparing" | "created" | "cleanup-needed" | "workspace-retained"; reason?: string; hostWorkspace?: string }
/** Main validates isolation; the renderer never supplies an execution directory. */
export type IsolationRequest = { mode: "direct" } | { mode: "worktree"; ref?: string } | { mode: "container"; profileId: string };
export interface ExecutionWorkspaceSummary {
  workspaceId?: string;
  mode: "direct" | "worktree" | "container";
  sourceCwd: string;
  executionCwd?: string;
  baseCommit?: string;
  containerProfileId?: string;
  hostWorkspace?: string;
  filesystemRestricted: boolean;
  state: "preparing" | "ready" | "running" | "retained" | "failed";
}
export interface RetainedWorkspace {
  id: string; sourceCwd: string; executionCwd: string; baseCommit: string; createdAt: number;
  state: "retained" | "running" | "uncertain" | "unavailable"; reason: string; sessionId?: string;
}
export interface WorkspaceReview { workspaceId: string; reviewId: string; patch: string; limitations: string[]; baseCommit: string; createdAt: number }
export type AgentLaunchOptions = Pick<CreateSessionRequest, "provider" | "profile" | "cwd" | "isolation" | "accountId" | "hostId" | "model">;

export interface CreateSessionRequest {
  isolation?: IsolationRequest;
  provider: ProviderId;
  cwd: string;
  profile: LaunchProfileId;
  position: Point;
  title?: string;
  role?: SessionRole;
  /** Owning session; required for subagents. Cycles are impossible because a
   * parent must already exist when the child is created. */
  parentSessionId?: string;
  /** Remote host for the session: shells spawn `ssh -tt [user@]host $SHELL`,
   *  agents spawn `ssh -tt … "cd '<mapped workspace>' && exec <cli>"`. Agents
   *  require the cwd to be mapped on the host — an unmapped workspace fails
   *  the create. */
  hostId?: string;
  /** Provider account selected and validated by launch policy; names an
   *  AppSettings.providerAccounts entry with a fixed host binding. */
  accountId?: string;
  model?: string;
  dataClass?: DataClass;
  /** Explicit permission for a child to delegate; false by default. */
  allowSubagents?: boolean;
}

export interface SessionMetadata {
  isolation?: IsolationRequest;
  /** Main-owned identity; persisted separately from caller-supplied launch options. */
  execution?: ExecutionWorkspaceSummary;
  id: string;
  revision: number;
  provider: ProviderId;
  profile: LaunchProfileId;
  title: string;
  titleCustomized: boolean;
  cwd: string;
  position: Point;
  size: Size;
  role: SessionRole;
  parentSessionId?: string;
  /** Present only for remote sessions; names an AppSettings.remoteHosts entry. */
  hostId?: string;
  /** Present only when account routing picked a subscription; names an
   *  AppSettings.providerAccounts entry. */
  accountId?: string;
  model?: string;
  dataClass?: DataClass;
  /** Main-generated nonsecret digest; resume must keep the same account route. */
  launchBinding?: string;
  /** Actual adapter limitations for this session, distinct from provider-wide capabilities. */
  integrationNote?: string;
  /** Re-evaluate the live default for sessions without an explicit class. */
  dataClassInherited?: boolean;
  allowSubagents?: boolean;
  status: SessionStatus;
  startedAt: number;
  exitCode: number | null;
  failureDetails: string | null;
}

export interface SessionSnapshot extends SessionMetadata {
  buffer: string;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
  /** Total UTF-16 code units produced, including this batch and trimmed history. */
  outputOffset: number;
}

export interface TerminalBufferSnapshot {
  buffer: string;
  outputOffset: number;
}

export interface SessionEvent {
  session: SessionMetadata;
}

export interface SessionRemovedEvent {
  id: string;
}

export interface MediaSelection {
  path: string;
  dataUrl: string;
}

export interface WindowState {
  isMacOS: boolean;
  maximized: boolean;
  fullscreen: boolean;
}

export const PLUGIN_API_VERSION = 1;

export type PluginPermission =
  | "storage"
  | "secrets"
  | "sessions:read"
  | "limits:read"
  | "launcher:open"
  | "external:open"
  | "browser:open"
  | "media:library"
  | "playlists:read"
  | "playlists:write"
  | "hermes:hud"
  | "network";

export type HermesHudSnapshot =
  | { state: "unavailable"; reason: "cli-not-found"; message: string }
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "stopping" }
  | { state: "running"; hudOpen: boolean }
  | { state: "error"; message: string };

export interface PluginGridSize extends HomeGridSize {}

export interface PluginContributionBase {
  id: string;
  title: string;
  description?: string;
  entry: string;
  icon?: string;
  module?: string;
}

export interface PluginModuleAsset {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PluginModule {
  id: string;
  title: string;
  description?: string;
  defaultSelected: boolean;
  permissions: PluginPermission[];
  files: PluginModuleAsset[];
}

export type PluginAgentHookEvent =
  | "session-start"
  | "prompt-submit"
  | "permission-request"
  | "permission-result"
  | "after-tool"
  | "stop"
  | "session-end";

export interface PluginAgentHook {
  id: string;
  title: string;
  description?: string;
  /** JavaScript entry executed with the current user's OS privileges after explicit opt-in. */
  entry: string;
  providers: AgentProviderId[];
  events: PluginAgentHookEvent[];
  module?: string;
}

export interface PluginHomeWidgetContribution extends PluginContributionBase {
  kind: "home-widget";
  defaultSize: PluginGridSize;
}

export interface PluginCanvasAppContribution extends PluginContributionBase {
  kind: "canvas-app";
  defaultSize: Size;
  minSize?: Size;
}

export interface PluginWindowContribution extends PluginContributionBase {
  kind: "window";
  defaultSize: Size;
  minSize?: Size;
}

export type PluginContribution =
  | PluginHomeWidgetContribution
  | PluginCanvasAppContribution
  | PluginWindowContribution;

export interface PluginManifest {
  apiVersion: typeof PLUGIN_API_VERSION;
  id: string;
  name: string;
  version: string;
  description: string;
  /** Optional icon path inside the package root (defaults to `icon.png`). */
  icon?: string;
  /** Russian description override (shown when locale is ru). */
  "description.ru"?: string;
  /** English description override (shown when locale is en). */
  "description.en"?: string;
  author?: string;
  homepage?: string;
  /** Platforms this plugin declares support for (e.g. `["canvastty"]`).
   *  Absent = compatible with every platform (legacy). */
  platforms?: string[];
  /** Minimal host (CanvasTTY) version this plugin is written for, semver.
   *  Informational only; newer requirements are surfaced but do not block. */
  minHostVersion?: string;
  permissions: PluginPermission[];
  contributions: PluginContribution[];
  hooks?: PluginAgentHook[];
  settingsContribution?: string;
  coreFiles?: PluginModuleAsset[];
  modules?: PluginModule[];
}

export interface GithubPluginSearchResult {
  fullName: string;
  url: string;
  description: string;
  stars: number;
  updatedAt: string;
  /** Minimal host version declared in the plugin manifest (semver). */
  minHostVersion?: string;
}

export interface PluginUpdateStatus {
  pluginId: string;
  installedVersion: string;
  latestVersion: string;
}

export interface GithubAuthStatus {
  configured: boolean;
  authorized: boolean;
  login: string | null;
  tokenExpiresAt: number | null;
}

export interface GithubDeviceFlowStart {
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  sourceUrl: string;
  enabled: boolean;
  installedAt: number;
  selectedModules: string[];
  /** Hook ids explicitly trusted by the user. Never populated during install or update. */
  enabledHooks: string[];
}

export interface PluginInstallPreview {
  token: string;
  sourceUrl: string;
  manifest: PluginManifest;
  expiresAt: number;
}

export interface PluginCanvasInstance {
  id: string;
  pluginId: string;
  contributionId: string;
  title: string;
  position: Point;
  size: Size;
}

export interface CanvasRegion extends SessionBounds {
  id: string;
  title: string;
  color: string;
}

export interface PluginSessionInfo {
  id: string;
  provider: ProviderId;
  title: string;
  status: SessionStatus;
  startedAt: number;
  exitCode: number | null;
}

export interface PluginLauncherRequest {
  provider: ProviderId;
}

export interface PluginCanvasRequest {
  pluginId: string;
  contributionId: string;
  sourceCanvasInstanceId?: string;
}

export interface PluginBrowserOpenRequest {
  requestId: string;
  pluginId: string;
  url: string;
}

export interface PluginBrowserOpenResponse {
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface PluginStorageChangeEvent {
  pluginId: string;
  key: string;
  value: unknown;
}

export interface PluginMediaLibrary {
  id: string;
  name: string;
}

export interface PluginMediaTrack {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
  streamUrl: string;
}

export interface PluginPlaylistFile {
  id: string;
  name: string;
  relativePath: string;
  size: number;
}

export interface BrowserCanvasState extends SessionBounds {}

export interface BrowserViewportClipBounds extends Size {
  x: number;
  y: number;
}

export interface BrowserViewportBounds extends Size {
  x: number;
  y: number;
  surface: BrowserViewportSurface;
  clipBounds?: BrowserViewportClipBounds;
  canvasScale?: number;
  showAgentPresence?: boolean;
}

export type BrowserTabStatus = "loading" | "ready" | "error" | "crashed";
export type BrowserConnectionState = "connected" | "stale";
export type BrowserAgentProvider = AgentProviderId | "unknown";

// API keys CanvasTTY stores for BYOK-capable provider CLIs. The renderer only
// ever learns which of them are configured; values stay in the main process.
export const PROVIDER_SECRET_IDS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GOOGLE_API_KEY",
  "ZAI_API_KEY",
  "MINIMAX_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEVIN_API_KEY",
  "CURSOR_API_KEY"
] as const;
export type ProviderSecretId = (typeof PROVIDER_SECRET_IDS)[number];
export type ProviderSecretRef = ProviderSecretId | `secret:${string}`;
export interface ProviderSecretOwner { profileId: string; hostId: string; }
export interface ProviderSecretStatus { ref: ProviderSecretRef; owner: ProviderSecretOwner; configured: boolean; }
export const PROVIDER_SECRET_LIMITS = Object.freeze({ count: 1024, valueBytes: 16 * 1024, rawBytes: 4 * 1024 * 1024, payloadBytes: 32 * 1024 * 1024, encryptedBytes: 48 * 1024 * 1024 });

// An ApiProfile names a model backend for BYOK-capable provider CLIs. It is
// deliberately not an agent provider: it never appears in launchers or session
// restore, it only supplies endpoint and credential references to runtimes
// that accept custom backends.
export type ApiProfileProtocol = "openai-compatible" | "anthropic-compatible" | "google";

export interface ApiProfile {
  id: string;
  name: string;
  protocol: ApiProfileProtocol;
  baseUrl?: string;
  secretRef: ProviderSecretRef;
  defaultModel?: string;
  /** Local vault entries are never forwarded over SSH. */
  hostId?: string;
  assessment?: DataHandlingAssessment;
  /** Invalid explicit evidence is retained as a denial, never erased. */
  assessmentInvalid?: boolean;
}

export const API_PROFILE_PROTOCOLS: readonly ApiProfileProtocol[] = ["openai-compatible", "anthropic-compatible", "google"];

// Static, per-host policy for which agent providers may ever run there. A
// host behind regional blocking (say, OpenAI/Anthropic unreachable from a
// Russian server) declares the providers it can actually serve; placement
// consults this rule as a hard filter before ranking anything.
//   - allowlist: ONLY the listed providers may run on the host;
//   - blocklist: every provider EXCEPT the listed ones may run.
export interface ProviderAccessRule {
  mode: "allowlist" | "blocklist";
  providers: AgentProviderId[];
}

// A RemoteHost names an SSH-reachable machine the orchestrator can launch
// agent sessions on. Like ApiProfile it is pure settings data: nothing spawns
// from it until a connectivity check or launch explicitly runs ssh.
export interface RemoteHost {
  id: string;
  label: string;
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  /** Lower value is preferred. 0-100. */
  priority?: number;
  /** Concurrent sessions this host accepts. 1-64. */
  maxSessions?: number;
  /** Required available RAM in MiB; unknown metrics fail this constraint. */
  minFreeMemoryMb?: number;
  /** Maximum one-minute load divided by CPU cores. */
  maxLoadPerCore?: number;
  /** Which providers the host may run (see ProviderAccessRule). Absent means
   *  unrestricted: every provider is permitted until a rule says otherwise. */
  providerAccess?: ProviderAccessRule;
  /** Confidentiality ceiling of the HOST itself (Roadmap D5): the code a
   *  session touches is seen not only by the AI provider but by the machine
   *  that executes it, so a VPS the operator labels D1 must never receive D2
   *  material even when the provider tier would allow it. Absent means D3 —
   *  the operator's own machines are unrestricted until labeled otherwise. */
  maxDataClass?: DataClass;
  /** Local project directories pre-mapped to their remote counterparts, at
   *  most 8 per host. Pure lookup data: nothing ever syncs or copies files
   *  between the two paths. */
  workspaces?: RemoteWorkspaceMapping[];
}

// One row of a host's workspace table: a local directory and the directory an
// agent session should use for it on the remote side. The mapping only
// translates paths; later roadmap stages decide what (if anything) runs there.
export interface RemoteWorkspaceMapping {
  localPath: string;
  remotePath: string;
}

const MAX_REMOTE_WORKSPACES_PER_HOST = 8;
const REMOTE_WORKSPACE_PATH_MAX_LENGTH = 4096;

// Absolute local path: a POSIX root or a Windows drive/UNC root. Interior
// spaces are legal — the value is a lookup key, not a shell argument — so only
// the root shape is pinned.
function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("\\\\")
    || /^[A-Za-z]:[\\/]/u.test(value);
}

function remoteWorkspacesInvalidReason(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "workspaces must be an array of at most 8 mappings";
  }
  if (value.length > MAX_REMOTE_WORKSPACES_PER_HOST) {
    return "workspaces must hold at most 8 mappings";
  }
  const localPaths = new Set<string>();
  for (const workspace of value) {
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
      return "each workspace mapping must be an object";
    }
    const mapping = workspace as Record<string, unknown>;
    const keys = Object.keys(mapping);
    if (keys.length !== 2 || mapping.localPath === undefined || mapping.remotePath === undefined) {
      return "each workspace mapping must have exactly the localPath and remotePath keys";
    }
    if (typeof mapping.localPath !== "string"
      || mapping.localPath.length === 0
      || mapping.localPath.length > REMOTE_WORKSPACE_PATH_MAX_LENGTH
      || mapping.localPath.trim().length === 0
      || !isAbsoluteLocalPath(mapping.localPath)) {
      return "localPath must be an absolute POSIX or Windows path of at most 4096 characters";
    }
    if (typeof mapping.remotePath !== "string"
      || mapping.remotePath.length === 0
      || mapping.remotePath.length > REMOTE_WORKSPACE_PATH_MAX_LENGTH
      || mapping.remotePath.trim().length === 0
      || !mapping.remotePath.startsWith("/")) {
      return "remotePath must be an absolute POSIX path of at most 4096 characters";
    }
    if (localPaths.has(mapping.localPath)) {
      return "localPath must be unique within a host (case-sensitive)";
    }
    localPaths.add(mapping.localPath);
  }
  return null;
}

const MAX_PROVIDERS_PER_ACCESS_RULE = 16;

// Every agent provider id, derived from the launcher registry so a provider
// added there is automatically valid here too.
const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = CANVAS_LAUNCHER_ITEMS.filter(
  (id): id is AgentProviderId => id !== "terminal"
);

function providerAccessInvalidReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "providerAccess must be an object";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || record.mode === undefined || record.providers === undefined) {
    return "providerAccess must have exactly the mode and providers keys";
  }
  if (record.mode !== "allowlist" && record.mode !== "blocklist") {
    return "providerAccess.mode must be allowlist or blocklist";
  }
  if (!Array.isArray(record.providers)
    || record.providers.length < 1
    || record.providers.length > MAX_PROVIDERS_PER_ACCESS_RULE) {
    return "providerAccess.providers must hold between 1 and 16 provider ids";
  }
  const seen = new Set<string>();
  for (const provider of record.providers) {
    if (typeof provider !== "string" || !AGENT_PROVIDER_IDS.includes(provider as AgentProviderId)) {
      return "providerAccess.providers contains an unknown provider id";
    }
    if (seen.has(provider)) {
      return "providerAccess.providers must not repeat a provider id";
    }
    seen.add(provider);
  }
  return null;
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

// Single source of truth for RemoteHost validation, shared by the settings
// normalizer and the connectivity service. Returns null when the entry is
// valid, otherwise a short human-readable reason. sshHost and sshUser reject
// any whitespace: those strings are composed into an ssh command line, so a
// space could smuggle extra arguments. They also reject a leading dash: the
// composed destination would sit in ssh's option region, where ssh parses it
// as options ("-oProxyCommand=..." style injection) rather than a hostname.
export function remoteHostInvalidReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "entry must be an object";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 64) {
    return "id must be a non-empty string of at most 64 characters";
  }
  if (record.id === "local" || record.id === "auto") return "id is reserved for a launch selector";
  if (typeof record.label !== "string" || record.label.trim().length === 0 || record.label.length > 80) {
    return "label must be a non-empty string of at most 80 characters";
  }
  if (typeof record.sshHost !== "string"
    || record.sshHost.length === 0
    || record.sshHost.length > 253
    || /\s/u.test(record.sshHost)
    || record.sshHost.startsWith("-")) {
    return "sshHost must be a whitespace-free string of at most 253 characters that does not start with a dash";
  }
  if (record.sshUser !== undefined
    && (typeof record.sshUser !== "string"
      || record.sshUser.length === 0
      || record.sshUser.length > 64
      || /\s/u.test(record.sshUser)
      || record.sshUser.startsWith("-"))) {
    return "sshUser must be a whitespace-free string of at most 64 characters that does not start with a dash";
  }
  if (record.sshPort !== undefined && !isIntegerInRange(record.sshPort, 1, 65535)) {
    return "sshPort must be an integer between 1 and 65535";
  }
  if (record.priority !== undefined && !isIntegerInRange(record.priority, 0, 100)) {
    return "priority must be an integer between 0 and 100";
  }
  if (record.maxSessions !== undefined && !isIntegerInRange(record.maxSessions, 1, 64)) {
    return "maxSessions must be an integer between 1 and 64";
  }
  if (record.minFreeMemoryMb !== undefined && !isIntegerInRange(record.minFreeMemoryMb, 0, 16777216)) {
    return "minFreeMemoryMb must be an integer between 0 and 16777216";
  }
  if (record.maxLoadPerCore !== undefined && (typeof record.maxLoadPerCore !== "number" || !Number.isFinite(record.maxLoadPerCore) || record.maxLoadPerCore < 0 || record.maxLoadPerCore > 1024)) {
    return "maxLoadPerCore must be a finite number between 0 and 1024";
  }
  if (record.maxDataClass !== undefined && !DATA_CLASSES.includes(record.maxDataClass as DataClass)) {
    return "maxDataClass must be a data class (D0-D3) when present";
  }
  if (record.providerAccess !== undefined) {
    const providerAccessReason = providerAccessInvalidReason(record.providerAccess);
    if (providerAccessReason !== null) return providerAccessReason;
  }
  if (record.workspaces !== undefined) {
    const workspacesReason = remoteWorkspacesInvalidReason(record.workspaces);
    if (workspacesReason !== null) return workspacesReason;
  }
  return null;
}

export function isValidRemoteHost(value: unknown): value is RemoteHost {
  return remoteHostInvalidReason(value) === null;
}

// Pure policy lookup, no I/O: does this host's providerAccess rule permit the
// given provider? An absent rule leaves the host unrestricted (true); an
// allowlist admits only its listed providers, a blocklist everything except
// them. Callers that also probe network reachability (RemoteProviderAccess)
// combine the two answers — permission says the host may run the provider,
// reachability says it can.
export function providerPermittedOnHost(host: RemoteHost, provider: AgentProviderId): boolean {
  const rule = host.providerAccess;
  if (!rule) return true;
  const listed = rule.providers.includes(provider);
  return rule.mode === "allowlist" ? listed : !listed;
}

// The most sensitive data class a HOST may carry (Roadmap D5). A task's
// effective ceiling is min(provider tier, host ceiling): the provider contract
// governs what leaves the machine, the host label governs what may execute on
// it, and a task must satisfy BOTH. An absent label reads as D3 — your own
// machine is unrestricted; a VPS the user labels D2 caps at D2. Pure lookup:
// placement uses it as a hard filter only, never as a ranking key.
export function hostEffectiveMaxDataClass(host: RemoteHost): DataClass {
  return host.maxDataClass ?? "D3";
}

// One HTTPS hostname per provider, used ONLY as a connectivity beacon: the
// placement layer asks whether the remote host can open a network path to
// each hostname, never what lives at the other end. This is a heuristic, not
// truth — an endpoint answering says nothing about quota, authentication, or
// regional availability of the actual model API, and a captive portal could
// even answer for a blocked provider. Placement treats the signal as one hard
// filter among several, and a host with no probe data is never excluded on
// this basis.
export const PROVIDER_API_ENDPOINTS: Readonly<Record<AgentProviderId, string>> = Object.freeze({
  codex: "api.openai.com",
  claude: "api.anthropic.com",
  qwen: "dashscope.aliyuncs.com",
  kimi: "api.moonshot.ai",
  opencode: "opencode.ai",
  hermes: "nousresearch.com",
  grok: "api.x.ai",
  omp: "omp.sh",
  pi: "pi.dev",
  cursor: "api2.cursor.com",
  minimax: "api.minimax.io",
  devin: "api.devin.ai",
  antigravity: "antigravity.google"
});

// The beacon URL for one provider: https plus the endpoint hostname and root
// path, exactly what a reachability probe should request.
export function providerApiUrl(provider: AgentProviderId): string {
  return `https://${PROVIDER_API_ENDPOINTS[provider]}/`;
}

// Lookup surface for the workspace table: translate a local project directory
// into its remote counterpart on the host, or null when no mapping covers it.
// Exact localPath matches win; a trailing-slash difference ("/a" vs "/a/")
// still resolves in either direction. The function only reads the table — no
// file is ever transferred or synchronized.
export function remotePathForHost(host: RemoteHost, localPath: string): string | null {
  if (typeof localPath !== "string" || localPath.length === 0) return null;
  const workspaces = host.workspaces;
  if (!workspaces || workspaces.length === 0) return null;
  for (const workspace of workspaces) {
    if (workspace.localPath === localPath) return workspace.remotePath;
  }
  const wanted = withoutTrailingSeparators(localPath);
  for (const workspace of workspaces) {
    if (withoutTrailingSeparators(workspace.localPath) === wanted) return workspace.remotePath;
  }
  return null;
}

// Collapses trailing path separators so a directory path with and without its
// final slash compares equal. The POSIX root keeps its slash.
function withoutTrailingSeparators(path: string): string {
  if (path === "/" || path === "\\") return path;
  return path.replace(/[\\/]+$/u, "");
}

// What CanvasTTY can actually do with each provider's session today. A
// capability is only declared when the integration exists; "none"/"terminal"
// values are explicit instead of pretending every provider is the same.
export interface AgentCapabilities {
  /** Prompt text can be written into the live PTY. */
  send: boolean;
  /** Scrollback can be read back from the session buffer. */
  observe: boolean;
  lifecycle: "structured" | "hooks" | "process" | "none";
  result: "structured" | "final-message" | "terminal" | "none";
  approvals: "structured" | "terminal" | "none";
  browser: "mcp" | "none";
  acp: boolean;
}

export const PROVIDER_CAPABILITIES: Readonly<Record<AgentProviderId, AgentCapabilities>> = Object.freeze({
  codex: Object.freeze({ send: true, observe: true, lifecycle: "hooks", result: "terminal", approvals: "terminal", browser: "mcp", acp: false }),
  claude: Object.freeze({ send: true, observe: true, lifecycle: "hooks", result: "terminal", approvals: "terminal", browser: "mcp", acp: false }),
  qwen: Object.freeze({ send: true, observe: true, lifecycle: "hooks", result: "terminal", approvals: "terminal", browser: "mcp", acp: false }),
  kimi: Object.freeze({ send: true, observe: true, lifecycle: "hooks", result: "terminal", approvals: "terminal", browser: "mcp", acp: false }),
  // OpenCode reports status through its structured event plugin.
  opencode: Object.freeze({ send: true, observe: true, lifecycle: "structured", result: "terminal", approvals: "terminal", browser: "mcp", acp: false }),
  hermes: Object.freeze({ send: true, observe: true, lifecycle: "hooks", result: "terminal", approvals: "terminal", browser: "mcp", acp: false }),
  grok: Object.freeze({ send: true, observe: true, lifecycle: "hooks", result: "terminal", approvals: "terminal", browser: "none", acp: false }),
  omp: Object.freeze({ send: true, observe: true, lifecycle: "process", result: "terminal", approvals: "terminal", browser: "none", acp: false }),
  pi: Object.freeze({ send: true, observe: true, lifecycle: "process", result: "terminal", approvals: "terminal", browser: "none", acp: false }),
  cursor: Object.freeze({ send: true, observe: true, lifecycle: "process", result: "terminal", approvals: "terminal", browser: "none", acp: false }),
  minimax: Object.freeze({ send: true, observe: true, lifecycle: "process", result: "terminal", approvals: "terminal", browser: "none", acp: false }),
  devin: Object.freeze({ send: true, observe: true, lifecycle: "process", result: "terminal", approvals: "terminal", browser: "none", acp: false }),
  antigravity: Object.freeze({ send: true, observe: true, lifecycle: "process", result: "terminal", approvals: "terminal", browser: "none", acp: false })
});

// Roadmap Stage 4, D1: the confidentiality policy layer. CanvasTTY classifies
// the DATA-HANDLING PATH a task's data will travel — never the company behind
// it: the same vendor can run a consumer tier that trains and a business tier
// that does not, and only the contract actually in force for this path counts.
//   D0 public       — may appear anywhere (docs, marketing, open-source code);
//   D1 internal     — not for public posting, but cloud processing is fine;
//   D2 confidential — secrets, customer data, unreleased work (the DEFAULT);
//   D3 restricted   — contractually protected data, self-hosted paths only.
// An unclassified repo is NEVER implicitly public: with no classification in
// force the effective tier is D2, so nothing sensitive leaks just because
// nobody bothered to classify the workspace.
export type DataClass = "D0" | "D1" | "D2" | "D3";

export const DATA_CLASSES: readonly DataClass[] = ["D0", "D1", "D2", "D3"];

// Strictness ordering used by dataClassSatisfies: a provider cleared for D2
// may also run D0 and D1 tasks, never the reverse.
export const DATA_CLASS_RANK: Record<DataClass, number> = {
  D0: 0,
  D1: 1,
  D2: 2,
  D3: 3
};

// One provider's default data-handling path, as facts where they were checked
// and as explicit "unknown" where they were not. verifiedAt and sources exist
// to keep fact distinguishable from guess: a profile citing sources with a
// recent verifiedAt is a checked fact; "unknown" fields are an admission that
// someone still needs to read the terms.
export interface DataHandlingProfile {
  /** Whether prompts and outputs may train the vendor's models. */
  training: "none" | "opt-in" | "opt-out" | "may-train" | "unknown";
  /** How long the vendor keeps request data after serving it. */
  retention: "zero" | "bounded" | "persistent" | "unknown";
  /** Jurisdictions whose legal process can reach the data; unstated when absent. */
  jurisdiction?: string[];
  /** Whether anything beyond the vendor and its subprocessors sees the data. */
  thirdPartyProcessing: "yes" | "no" | "unknown";
  /** The strongest contractual frame available on this path by default. */
  contractualMode: "consumer" | "api" | "business" | "enterprise" | "self-hosted";
  /** When the fields above were last checked against the cited sources. */
  verifiedAt?: string;
  /** Where the facts came from; an entry without them is a guess. */
  sources?: string[];
}

/** Operator-supplied evidence; this is not a CanvasTTY verification badge. */
export interface DataHandlingAssessment {
  profile: DataHandlingProfile;
  evidence: {
    kind: "user-attested" | "provider-documentation" | "organization-contract";
    reviewedAt: string;
    sources: string[];
    note?: string;
    /** Exact nonsecret route snapshot produced by accountRouteBinding(). */
    binding: string;
    models: "*" | string[];
  };
  trustedSelfHosted?: boolean;
}

// Static DEFAULTS for the confidentiality tiers. These describe each
// provider's consumer-tier data path as shipped, NOT any particular
// organization's contract: an org with a ZDR or enterprise add-on carries its
// own (usually stricter) copy. Entries marked UNVERIFIED (opencode, hermes,
// omp, pi) have had no primary-source review at all, and entries marked
// PROVISIONAL (cursor, minimax) rest on partially-read terms — both must read
// as conservative guesses, which is exactly what their derived tiers say.
export const PROVIDER_DATA_HANDLING: Readonly<Record<AgentProviderId, DataHandlingProfile>> = Object.freeze({
  codex: Object.freeze({
    training: "opt-out",
    retention: "persistent",
    thirdPartyProcessing: "yes",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://help.openai.com/en/articles/5722486", "https://openai.com/policies/row-usage-policy"]
  }),
  claude: Object.freeze({
    training: "opt-out",
    retention: "persistent",
    thirdPartyProcessing: "yes",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://www.anthropic.com/legal/consumer-terms", "https://support.anthropic.com/en/articles/8866577"]
  }),
  grok: Object.freeze({
    training: "opt-out",
    retention: "bounded",
    thirdPartyProcessing: "yes",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://x.ai/legal/terms-of-service", "https://docs.x.ai/docs/data-usage"]
  }),
  qwen: Object.freeze({
    training: "may-train",
    retention: "persistent",
    thirdPartyProcessing: "yes",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://www.alibabacloud.com/help/en/model-studio/", "https://help.aliyun.com/zh/model-studio/"]
  }),
  // Kimi ships the same default posture as Qwen: a verified opt-out agreement
  // would raise its derived tier from D1 to D2.
  kimi: Object.freeze({
    training: "may-train",
    retention: "persistent",
    thirdPartyProcessing: "yes",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://www.moonshot.ai/terms-of-service", "https://platform.moonshot.ai/docs/pricing/chat"]
  }),
  // UNVERIFIED: no primary-source review yet, so every field is "unknown" and
  // the derived tier is D0 — public data only until someone checks the terms.
  opencode: Object.freeze({
    training: "unknown",
    retention: "unknown",
    thirdPartyProcessing: "unknown",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://opencode.ai/docs/"]
  }),
  hermes: Object.freeze({
    training: "unknown",
    retention: "unknown",
    thirdPartyProcessing: "unknown",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://nousresearch.com"]
  }),
  omp: Object.freeze({
    training: "unknown",
    retention: "unknown",
    thirdPartyProcessing: "unknown",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://omp.sh"]
  }),
  pi: Object.freeze({
    training: "unknown",
    retention: "unknown",
    thirdPartyProcessing: "unknown",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://pi.dev"]
  }),
  // PROVISIONAL: Privacy Mode is documented but not verified per-workspace,
  // so training stays "unknown" and the derived tier stays D0.
  cursor: Object.freeze({
    training: "unknown",
    retention: "persistent",
    thirdPartyProcessing: "yes",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://cursor.com/privacy", "https://docs.cursor.com/account/privacy"]
  }),
  // PROVISIONAL: API-tier terms were read, but the training posture remains
  // unsettled, so it is recorded pessimistically.
  minimax: Object.freeze({
    training: "may-train",
    retention: "unknown",
    thirdPartyProcessing: "yes",
    contractualMode: "api",
    verifiedAt: "2026-09-21",
    sources: ["https://platform.minimax.io/docs", "https://www.minimax.io/terms"]
  }),
  devin: Object.freeze({
    training: "none",
    retention: "bounded",
    thirdPartyProcessing: "yes",
    contractualMode: "business",
    verifiedAt: "2026-09-21",
    sources: ["https://cognition.ai/privacy", "https://docs.devin.ai"]
  }),
  antigravity: Object.freeze({
    training: "none",
    retention: "bounded",
    thirdPartyProcessing: "yes",
    contractualMode: "consumer",
    verifiedAt: "2026-09-21",
    sources: ["https://antigravity.google/privacy", "https://developers.google.com/antigravity"]
  })
});

// The most sensitive data class a provider's DEFAULT data-handling path may
// carry. Pure lookup over PROVIDER_DATA_HANDLING, in precedence order:
//   - contractualMode "self-hosted" → D3: the data never leaves infrastructure
//     the operator controls. No static entry is self-hosted; reaching D3 is an
//     org override that flips this field for a verified ZDR or on-prem
//     deployment (the override raises the tier, it never lowers it).
//   - training "unknown" → D0: the path is unverified, so only public data
//     may flow until someone checks the terms.
//   - training other than "none" → D1: the vendor may retain and train on the
//     data, capping the path at internal material.
//   - training "none" with bounded or zero retention → D2.
//   - Anything else (no training but unbounded or unstated retention) reads
//     as D0: not proven safe for confidential data.
export function providerMaxDataClass(provider: AgentProviderId): DataClass {
  const profile = PROVIDER_DATA_HANDLING[provider];
  if (profile.contractualMode === "self-hosted") return "D3";
  if (profile.training === "unknown") return "D0";
  if (profile.training !== "none") return "D1";
  if (profile.retention === "bounded" || profile.retention === "zero") return "D2";
  return "D0";
}

// Rank comparison: a provider allowed to handle `allowed` satisfies every
// task whose class is `required` or lower. D3 satisfies only D3-capable
// paths, D0 is satisfied by everything.
export function dataClassSatisfies(required: DataClass, allowed: DataClass): boolean {
  return DATA_CLASS_RANK[required] <= DATA_CLASS_RANK[allowed];
}

// Multi-account support: one provider may have SEVERAL subscriptions
// attached (a $20 ChatGPT plan next to a $100 Pro plan; Claude Pro vs Max;
// different Grok tiers), and placement must pick an account whose tier
// actually covers the requested model — Astra-class work pointed at a $20
// account, or Opus-class work at a $20 Claude plan, burns the cheap quota
// for nothing. Like ApiProfile and RemoteHost this is pure settings data:
// nothing about it touches a process until spawn consults it.
export interface ProviderAccount {
  /** A single fixed host; omitted or "local" means this machine. */
  hostId?: string;
  /** Ambiguous legacy host bindings stay disabled until explicitly repaired. */
  bindingRequired?: boolean;
  id: string;
  provider: AgentProviderId;
  label: string;
  /** Absent legacy bindings must be configured before production launch. */
  binding?: { kind: "cli-home"; directory: string } | { kind: "api-profile"; profileId: string };
  assessment?: DataHandlingAssessment;
  assessmentInvalid?: boolean;
  /** Free-form subscription label, e.g. "chatgpt-plus", "chatgpt-pro",
   *  "claude-pro", "claude-max", "grok-standard". Diagnostic only — tiers
   *  are never parsed, the models list below is what placement enforces. */
  tier?: string;
  /** Model ids this account's tier is ALLOWED to run. Absent means unrestricted; an explicit empty list disables
   *  this account. A cheap tier should list only what it can sensibly run —
   *  a plus-tier account lists its light models and leaves the heavyweight
   *  ids (Astra-class, Opus-class) to the pro account above it, because even
   *  on Pro the heavyweight models eat quota. Entries are exact matches or
   *  prefix wildcards ending in "*" (see accountSupportsModel). */
  models?: string[];
  /** A shared/team account: colleagues can see its prompts and outputs, so
   *  privacy tightens — accountEffectiveMaxDataClass caps it at D1 even when
   *  the provider's own ceiling is higher. */
  shared?: boolean;
  /** Optionally tightens the actual route's data-class ceiling
   *  (never raises it): a named account can be held to internal-only data
   *  even on a provider whose default path allows more. */
  maxDataClass?: DataClass;
}

// Resolve the actual assessed account/API route first, then tighten it with
// account/shared caps. Without assessment only a native default uses the
// provider default; an unassessed API backend is D0.
export function accountEffectiveMaxDataClass(account: ProviderAccount, profiles: readonly ApiProfile[] = [], model?: string): DataClass {
  return accountRouteMaxDataClass(account, profiles, model);
}

// Does this account's tier cover the requested model? A request without a
// model (undefined) cannot satisfy an explicit allowlist; an account with
// no models list is unrestricted. Matching is case-insensitive: entries are exact ids
// ("gpt-5-mini") or prefix wildcards ending in "*" ("gpt-5*" covers
// "gpt-5", "gpt-5-codex", "GPT-5-Mini").
export function accountSupportsModel(account: ProviderAccount, model: string | undefined): boolean {
  const models = account.models;
  if (models !== undefined && models.length === 0) return false;
  if (models === undefined) return true;
  if (model === undefined) return false;
  const wanted = model.toLowerCase();
  for (const entry of models) {
    const candidate = entry.toLowerCase();
    if (candidate.endsWith("*")) {
      if (wanted.startsWith(candidate.slice(0, -1))) return true;
    } else if (candidate === wanted) {
      return true;
    }
  }
  return false;
}

// Accounts of the given provider whose tier covers the model, in the order
// they were configured — spawn's deterministic v1 picker takes the first.
export function eligibleAccountsForModel(
  accounts: readonly ProviderAccount[],
  provider: AgentProviderId,
  model: string | undefined
): ProviderAccount[] {
  return accounts.filter(
    (account) => account.provider === provider && accountSupportsModel(account, model)
  );
}

// Roadmap D6: paths carry classes of their own. A repo usually mixes public
// docs with restricted cores, and a policy table lets the operator say "docs/**
// is internal, .env* and deploy/** are restricted" without classifying every
// task by hand — so a cheap agent may fix a UI button yet never even be
// pointed at the payment core. FIRST MATCH WINS: the table is evaluated in
// order and the first pattern covering the path decides its class; no match
// leaves the caller's fallback in force.
export interface PathPolicy {
  /** Gitignore-flavored glob of at most 200 characters, non-blank: `**`
   *  spans any depth, `*` stays within one segment, and a leading `/`
   *  anchors the pattern to the repo root. Only [A-Za-z0-9.*_/-] are legal —
   *  `..`, backslashes, empty segments, and a `**` inside a larger segment
   *  ("src**") are all rejected. */
  pattern: string;
  dataClass: DataClass;
}

export const PATH_POLICY_PATTERN_MAX_LENGTH = 200;

// Pattern grammar validation, shared by the settings normalizer and the
// matcher: a pattern that violates the grammar is dropped at the settings
// boundary and never matches anything.
export function isValidPathPolicyPattern(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > PATH_POLICY_PATTERN_MAX_LENGTH) return false;
  if (value.trim().length === 0) return false;
  if (value.includes("..") || value.includes("\\")) return false;
  if (!/^[A-Za-z0-9.*_/-]+$/u.test(value)) return false;
  const segments = value.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    // The single leading empty segment is the anchor marker; any other empty
    // segment (a trailing slash or a "//") can only be a typo.
    if (segment === "" && index !== 0) return false;
    // A "." segment carries no meaning here — write the pattern without it.
    if (segment === ".") return false;
    // "**" is only meaningful as a whole segment; "src**" would silently read
    // as two single-segment stars, so it is rejected instead.
    if (segment.includes("**") && segment !== "**") return false;
  }
  return true;
}

// Pure classification of the task's cwd, not a filesystem access boundary.
// Anchored patterns need repository-relative paths or an explicit repository
// root for absolute paths. Relative patterns retain suffix matching.
export function dataClassForPath(
  policies: readonly PathPolicy[],
  path: string,
  fallback: DataClass,
  repositoryRoot?: string
): DataClass {
  if (typeof path !== "string" || path.length === 0) return fallback;
  let target = path.replace(/\\/gu, "/");
  if (repositoryRoot !== undefined) {
    const root = repositoryRoot.replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (!root || (target !== root && !target.startsWith(`${root}/`))) return fallback;
    target = target.slice(root.length).replace(/^\//u, "");
  }
  for (const policy of policies) {
    if (!policy || typeof policy !== "object" || !DATA_CLASSES.includes(policy.dataClass)) continue;
    if (pathPolicyMatches(policy.pattern, target)) return policy.dataClass;
  }
  return fallback;
}

function pathPolicyMatches(pattern: string, path: string): boolean {
  if (!isValidPathPolicyPattern(pattern)) return false;
  const patternSegments = splitPolicySegments(pattern);
  const anchored = patternSegments[0] === "";
  const patternBody = anchored ? patternSegments.slice(1) : patternSegments;
  const rootless = splitPolicySegments(path);
  // Never guess where a repository begins inside an absolute filesystem path.
  if (anchored && (rootless[0] === "" || /^[A-Za-z]:$/u.test(rootless[0] ?? ""))) return false;
  const segments = rootless[0] === "" ? rootless.slice(1) : rootless;
  const lastStart = anchored ? 0 : segments.length;
  for (let start = 0; start <= lastStart; start += 1) {
    if (matchPolicySegments(patternBody, segments.slice(start), 0, 0)) return true;
  }
  return false;
}

// "\" reads as "/", a leading "./" falls away; the leading "/" of an absolute
// value survives as an empty first segment (the root marker).
function splitPolicySegments(value: string): string[] {
  let normalized = value.replace(/\\/gu, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized.split("/");
}

function matchPolicySegments(
  pattern: readonly string[],
  path: readonly string[],
  patternIndex: number,
  pathIndex: number
): boolean {
  if (patternIndex === pattern.length) return pathIndex === path.length;
  const segment = pattern[patternIndex]!;
  if (segment === "**") {
    // Zero or more whole segments.
    if (matchPolicySegments(pattern, path, patternIndex + 1, pathIndex)) return true;
    return pathIndex < path.length && matchPolicySegments(pattern, path, patternIndex, pathIndex + 1);
  }
  if (pathIndex >= path.length) return false;
  return segmentMatches(segment, path[pathIndex]!)
    && matchPolicySegments(pattern, path, patternIndex + 1, pathIndex + 1);
}

function segmentMatches(patternSegment: string, pathSegment: string): boolean {
  if (!patternSegment.includes("*")) return patternSegment === pathSegment;
  const expression = new RegExp(`^${patternSegment.split("*").map(escapeForRegExp).join(".*")}$`, "u");
  return expression.test(pathSegment);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export const API_PROFILE_PRESETS: readonly ApiProfile[] = Object.freeze([
  Object.freeze({
    id: "openai", name: "OpenAI", protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1", secretRef: "OPENAI_API_KEY"
  }),
  Object.freeze({
    id: "anthropic", name: "Anthropic", protocol: "anthropic-compatible",
    baseUrl: "https://api.anthropic.com", secretRef: "ANTHROPIC_API_KEY"
  }),
  Object.freeze({
    id: "google", name: "Google AI", protocol: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta", secretRef: "GOOGLE_API_KEY"
  }),
  Object.freeze({
    id: "xai", name: "xAI", protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1", secretRef: "XAI_API_KEY"
  }),
  Object.freeze({
    id: "zai", name: "Z.AI", protocol: "openai-compatible",
    baseUrl: "https://api.z.ai/api/paas/v4", secretRef: "ZAI_API_KEY"
  }),
  Object.freeze({
    id: "minimax", name: "MiniMax Open Platform", protocol: "openai-compatible",
    baseUrl: "https://api.minimax.io/v1", secretRef: "MINIMAX_API_KEY"
  }),
  Object.freeze({
    id: "openrouter", name: "OpenRouter", protocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1", secretRef: "OPENROUTER_API_KEY"
  }),
  Object.freeze({
    id: "deepseek", name: "DeepSeek", protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com", secretRef: "DEEPSEEK_API_KEY"
  }),
  Object.freeze({
    id: "custom-openai", name: "Custom OpenAI-compatible", protocol: "openai-compatible",
    secretRef: "OPENAI_API_KEY"
  }),
  Object.freeze({
    id: "custom-anthropic", name: "Custom Anthropic-compatible", protocol: "anthropic-compatible",
    secretRef: "ANTHROPIC_API_KEY"
  })
].map((preset) => Object.freeze({ ...preset })));

export const BROWSER_PROVIDER_COLORS: Record<BrowserAgentProvider, string> = {
  claude: "#D97757",
  codex: "#10A37F",
  qwen: "#6D44E8",
  kimi: "#7C5CFC",
  opencode: "#5A5858",
  hermes: "#D6A700",
  grok: "#111111",
  // OMP, Pi, Cursor, and MiniMax never reach the browser bridge, so these values
  // are never rendered; they exist only to keep the record total over the provider union.
  omp: "#6E6A8A",
  pi: "#4F7C8A",
  cursor: "#1F1F1F",
  minimax: "#3C2A6B",
  devin: "#4E5BA6",
  antigravity: "#1A73E8",
  unknown: "#7A8291"
};

export interface AgentCursorSnapshot {
  x: number;
  y: number;
  updatedAt: number;
}

export interface AgentPresenceSnapshot {
  agentId: string;
  connectionId: string;
  provider: BrowserAgentProvider;
  label: string;
  brandColor: string;
  terminalSessionId: string;
  currentTabId: string | null;
  cursor: AgentCursorSnapshot;
  connectionState: BrowserConnectionState;
  connectedAt: number;
  lastHeartbeatAt: number;
}

export interface BrowserDialogSnapshot {
  tabId: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt: string;
  openedAt: number;
}

export type BrowserDownloadStatus = "pending" | "progressing" | "completed" | "canceled" | "interrupted";

export interface BrowserDownloadSnapshot {
  id: string;
  tabId: string | null;
  fileName: string;
  savePath: string;
  receivedBytes: number;
  totalBytes: number;
  status: BrowserDownloadStatus;
  startedAt: number;
  completedAt: number | null;
}

export interface BrowserTabSnapshot {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  documentRevision: number;
  status: BrowserTabStatus;
  favicon: string | null;
  agents: AgentPresenceSnapshot[];
  crashState: string | null;
}

export interface BrowserSnapshot {
  tabs: BrowserTabSnapshot[];
  activeTabId: string | null;
  visible: boolean;
  agents: AgentPresenceSnapshot[];
  downloads: BrowserDownloadSnapshot[];
  pendingDialog: BrowserDialogSnapshot | null;
}

export interface BrowserStateEvent {
  snapshot: BrowserSnapshot;
}

export interface BrowserCanvasWheelEvent {
  tabId: string;
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface BrowserCanvasFreezeFrameEvent {
  tabId: string;
  generation: number;
  active: boolean;
  dataUrl: string | null;
}

export interface BrowserCanvasNavigationPointerEvent {
  tabId: string;
  type: "down" | "move" | "up" | "cancel";
  clientX: number;
  clientY: number;
}

export interface CanvasNavigationOverrideStateEvent {
  wheelActive: boolean;
  navigationActive: boolean;
}

export interface CanvasNavigationPointerBindingInput {
  button: CanvasNavigationMouseButton;
  pressed: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface BrowserCanvasPointerEvent {
  tabId: string;
  type: "down" | "up" | "enter" | "leave";
  clientX: number;
  clientY: number;
  clickCount: number;
}

export type BrowserErrorCode =
  | "AUTH_INVALID"
  | "BRIDGE_UNAVAILABLE"
  | "TAB_NOT_FOUND"
  | "TAB_CLOSED"
  | "VIEWPORT_UNAVAILABLE"
  | "STALE_REF"
  | "INVALID_URL"
  | "NAVIGATION_BLOCKED"
  | "PERMISSION_DENIED"
  | "DIALOG_OPEN"
  | "PATH_DENIED"
  | "TIMEOUT"
  | "CANCELED"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "BROWSER_CRASHED"
  | "AUDIT_UNAVAILABLE";

export interface BrowserError {
  code: BrowserErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export type BrowserActor =
  | {
    kind: "human";
    connectionId: string;
  }
  | {
    kind: "agent";
    agentId: string;
    provider: BrowserAgentProvider;
    terminalSessionId: string;
    connectionId: string;
    cwd: string;
  };

export interface BrowserElementRef {
  ref: string;
  tabId: string;
  frameId: string;
  documentRevision: number;
  backendNodeId: number;
}

export interface BrowserElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserObservedElement {
  ref: BrowserElementRef;
  role: string;
  name: string;
  description: string | null;
  value: string | null;
  bounds: BrowserElementBounds | null;
  disabled: boolean;
  focused: boolean;
  editable: boolean;
}

export interface BrowserObservation {
  untrustedWebContent: true;
  tabId: string;
  url: string;
  title: string;
  documentRevision: number;
  elements: BrowserObservedElement[];
  nextCursor: string | null;
}

export type BrowserCommandType =
  | "browser_list_tabs"
  | "browser_new_tab"
  | "browser_close_tab"
  | "browser_activate_tab"
  | "browser_navigate"
  | "browser_back"
  | "browser_forward"
  | "browser_reload"
  | "browser_observe"
  | "browser_read_page"
  | "browser_screenshot"
  | "browser_click"
  | "browser_hover"
  | "browser_type"
  | "browser_select"
  | "browser_press"
  | "browser_scroll"
  | "browser_drag"
  | "browser_wait_for"
  | "browser_handle_dialog"
  | "browser_download_wait"
  | "browser_upload"
  | "browser_get_activity";

export interface BrowserCommand {
  type: BrowserCommandType;
  requestId: string;
  tabId?: string;
  url?: string;
  ref?: BrowserElementRef | string;
  targetRef?: BrowserElementRef | string;
  text?: string;
  values?: string[];
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  deltaX?: number;
  deltaY?: number;
  timeoutMs?: number;
  condition?: "load" | "network-idle" | "text" | "element" | "url" | "download";
  value?: string;
  accept?: boolean;
  promptText?: string;
  paths?: string[];
  cursor?: string;
  limit?: number;
  expectedRevision?: number;
}

export interface BrowserResult<T = unknown> {
  ok: boolean;
  requestId: string;
  tabId: string | null;
  commandSequence: number;
  revisionBefore: number | null;
  revisionAfter: number | null;
  data?: T;
  error?: BrowserError;
}

export interface BrowserActivityEvent {
  sequence: number;
  timestamp: number;
  requestId: string;
  actorKind: BrowserActor["kind"];
  agentId: string | null;
  provider: BrowserAgentProvider | null;
  terminalSessionId: string | null;
  tabId: string | null;
  origin: string | null;
  operation: BrowserCommandType;
  targetHash: string | null;
  revisionBefore: number | null;
  revisionAfter: number | null;
  durationMs: number;
  ok: boolean;
  errorCode: BrowserErrorCode | null;
}

export interface BrowserActivityStateEvent {
  event: BrowserActivityEvent;
}

export type LimitSource =
  | "codex-app-server"
  | "claude-usage-api"
  | "qwen-cli"
  | "kimi-usage-api"
  | "opencode-go-usage-api"
  | "grok-billing-api";
export type LimitUnavailableReason =
  | "cli-not-found"
  | "not-authenticated"
  | "subscription-required"
  | "unsupported-protocol"
  | "timeout"
  | "protocol-error";

export interface LimitWindow {
  id: string;
  bucketId: string;
  slot: "primary" | "secondary";
  isDefaultBucket: boolean;
  label: string | null;
  usedPercent: number | null;
  used: number | null;
  limit: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export type ProviderLimitsSnapshot =
  | {
    provider: AgentProviderId;
    state: "available";
    source: LimitSource;
    fetchedAt: number;
    windows: LimitWindow[];
  }
  | {
    provider: AgentProviderId;
    state: "stale";
    source: LimitSource;
    fetchedAt: number;
    failedAt: number;
    reason: LimitUnavailableReason;
    windows: LimitWindow[];
  }
  | {
    provider: AgentProviderId;
    state: "unavailable";
    source: LimitSource;
    checkedAt: number;
    reason: LimitUnavailableReason;
  };

export interface LimitsSnapshot {
  fetchedAt: number;
  providers: ProviderLimitsSnapshot[];
}

/** On-demand operational values only; never prompts, paths or credentials. */
export interface LocalOperationalMetrics {
  collectedAt: number;
  activeSessions: number;
  activeLocalSessions: number;
  activeRemoteSessions: number;
  /** Sum across CanvasTTY Electron processes; can exceed 100 on multiple cores. */
  cpuPercent: number | null;
  memoryWorkingSetMb: number | null;
  load1: number | null;
  cores: number | null;
  memoryTotalMb: number | null;
  memoryAvailableMb: number | null;
}

export interface RemoteHostUtilization {
  hostId: string;
  collectedAt: number;
  reachable: boolean;
  load1: number | null;
  cores: number | null;
  memoryTotalMb: number | null;
  memoryAvailableMb: number | null;
  gpuVramTotalMb: number | null;
  gpuVramUsedMb: number | null;
  detail?: string;
}

export interface CanvasTTYApi {
  evenG2: import('./evenG2.ts').EvenG2Api;
  appVersion(): Promise<string>;
  containers: {
    probe(profileId: string): Promise<ContainerAvailability>;
    list(): Promise<RetainedContainer[]>;
    cleanup(id: string): Promise<void>;
  };
  workspaces: {
    list(): Promise<RetainedWorkspace[]>;
    review(id: string): Promise<WorkspaceReview>;
    exportPatch(id: string, reviewId: string): Promise<boolean>;
    cleanup(id: string): Promise<void>;
  };
  operationalMetrics: {
    local(): Promise<LocalOperationalMetrics>;
    remote(hostId: string): Promise<RemoteHostUtilization>;
  };
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): void;
  };
  external: {
    openUrl(url: string): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  agents: {
    availability(): Promise<AgentCliAvailability>;
    recheck(): Promise<{ availability: AgentCliAvailability; settings: AppSettings }>;
  };
  dialog: {
    pickDirectory(defaultPath?: string): Promise<string | null>;
    pickMedia(): Promise<MediaSelection | null>;
  };
  media: {
    read(path: string): Promise<string | null>;
  };
  limits: {
    get(): Promise<LimitsSnapshot>;
  };
  providerSecrets: {
    status(): Promise<Record<ProviderSecretId, boolean>>;
    set(secretId: ProviderSecretId, value: string): Promise<void>;
    clear(secretId: ProviderSecretId): Promise<void>;
    create(owner: ProviderSecretOwner, value: string): Promise<ProviderSecretStatus>;
    scopedStatus(): Promise<ProviderSecretStatus[]>;
    update(ref: ProviderSecretRef, owner: ProviderSecretOwner, value: string): Promise<void>;
    remove(ref: ProviderSecretRef, owner: ProviderSecretOwner): Promise<void>;
  };
  plugins: {
    list(): Promise<InstalledPlugin[]>;
    search(query: string): Promise<GithubPluginSearchResult[]>;
    showcase(): Promise<GithubPluginSearchResult[]>;
    icon(sourceUrls: string[]): Promise<Record<string, string | null>>;
    manifests(sourceUrls: string[]): Promise<Record<string, PluginManifest>>;
    checkUpdates(): Promise<PluginUpdateStatus[]>;
    update(pluginId: string): Promise<InstalledPlugin>;
    onUpdatesAvailable(listener: (updates: PluginUpdateStatus[]) => void): () => void;
    previewInstall(sourceUrl: string): Promise<PluginInstallPreview>;
    install(token: string, selectedModules?: string[]): Promise<InstalledPlugin>;
    setModules(pluginId: string, selectedModules: string[]): Promise<InstalledPlugin>;
    setEnabled(pluginId: string, enabled: boolean): Promise<InstalledPlugin>;
    setHookEnabled(pluginId: string, hookId: string, enabled: boolean): Promise<InstalledPlugin>;
    uninstall(pluginId: string): Promise<void>;
    openCanvas(pluginId: string, contributionId: string, sourceCanvasInstanceId?: string): Promise<void>;
    openWindow(pluginId: string, contributionId: string): Promise<void>;
    openExternal(pluginId: string, url: string): Promise<void>;
    openBrowser(pluginId: string, url: string): Promise<void>;
    storageGet(pluginId: string, key: string): Promise<unknown>;
    storageSet(pluginId: string, key: string, value: unknown): Promise<void>;
    secretsGet(pluginId: string, key: string): Promise<string | null>;
    secretsSet(pluginId: string, key: string, value: string): Promise<void>;
    secretsDelete(pluginId: string, key: string): Promise<void>;
    mediaPickLibrary(pluginId: string): Promise<PluginMediaLibrary | null>;
    mediaListLibraries(pluginId: string): Promise<PluginMediaLibrary[]>;
    mediaScanLibrary(pluginId: string, libraryId: string): Promise<PluginMediaTrack[]>;
    mediaRevokeLibrary(pluginId: string, libraryId: string): Promise<void>;
    playlistsList(pluginId: string, libraryId: string): Promise<PluginPlaylistFile[]>;
    playlistsRead(pluginId: string, libraryId: string, playlistId: string): Promise<string>;
    playlistsWrite(pluginId: string, libraryId: string, name: string, content: string): Promise<PluginPlaylistFile>;
    hermesHudStatus(pluginId: string): Promise<HermesHudSnapshot>;
    hermesHudOpen(pluginId: string): Promise<HermesHudSnapshot>;
    hermesHudClose(pluginId: string): Promise<HermesHudSnapshot>;
    onOpenLauncher(listener: (event: PluginLauncherRequest) => void): () => void;
    onOpenCanvas(listener: (event: PluginCanvasRequest) => void): () => void;
    onBrowserOpenRequested(listener: (event: PluginBrowserOpenRequest) => void): () => void;
    completeBrowserOpen(response: PluginBrowserOpenResponse): Promise<boolean>;
    onStorageChanged(listener: (event: PluginStorageChangeEvent) => void): () => void;
  };
  browser: {
    getState(): Promise<BrowserSnapshot>;
    open(url?: string): Promise<BrowserSnapshot>;
    close(): Promise<void>;
    closeAllTabs(): Promise<BrowserSnapshot>;
    newTab(url?: string): Promise<BrowserSnapshot>;
    selectTab(id: string): Promise<BrowserSnapshot>;
    closeTab(id: string): Promise<BrowserSnapshot>;
    navigate(id: string, value: string): Promise<BrowserSnapshot>;
    back(id: string): Promise<BrowserSnapshot>;
    forward(id: string): Promise<BrowserSnapshot>;
    reload(id: string): Promise<BrowserSnapshot>;
    execute(command: BrowserCommand): Promise<BrowserResult>;
    getActivity(sinceSequence?: number): Promise<BrowserActivityEvent[]>;
    clearData(): Promise<BrowserSnapshot>;
    focus(): void;
    setInputFocused(focused: boolean): void;
    setViewport(bounds: BrowserViewportBounds): void;
    onState(listener: (event: BrowserStateEvent) => void): () => void;
    onActivity(listener: (event: BrowserActivityStateEvent) => void): () => void;
    onCanvasWheel(listener: (event: BrowserCanvasWheelEvent) => void): () => void;
    onCanvasFreezeFrame(listener: (event: BrowserCanvasFreezeFrameEvent) => void): () => void;
    onCanvasPointer(listener: (event: BrowserCanvasPointerEvent) => void): () => void;
    onCanvasNavigationPointer(listener: (event: BrowserCanvasNavigationPointerEvent) => void): () => void;
  };
  canvasNavigation: {
    armOwnerWheelSequence(clientX: number, clientY: number): void;
    setShortcutCaptureActive(active: boolean): void;
    setPointerBindingState(input: CanvasNavigationPointerBindingInput): void;
    setPointerGestureActive(active: boolean): void;
    onOverrideState(listener: (event: CanvasNavigationOverrideStateEvent) => void): () => void;
  };
  githubAuth: {
    status(): Promise<GithubAuthStatus>;
    start(): Promise<GithubDeviceFlowStart>;
    signOut(): Promise<void>;
    openUrl(url: string): Promise<void>;
  };
  terminal: {
    fileDropText(files: File[]): string;
    list(): Promise<SessionSnapshot[]>;
    readBuffer(id: string): Promise<TerminalBufferSnapshot>;
    create(request: CreateSessionRequest): Promise<SessionSnapshot>;
    restart(id: string): Promise<SessionSnapshot>;
    input(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    setBounds(id: string, bounds: SessionBounds): void;
    rename(id: string, title: string): Promise<SessionMetadata>;
    dispose(id: string): Promise<void>;
    onData(listener: (event: TerminalDataEvent) => void): () => void;
    onSession(listener: (event: SessionEvent) => void): () => void;
    onRemoved(listener: (event: SessionRemovedEvent) => void): () => void;
  };
  window: {
    isMacOS: boolean;
    minimize(): void;
    toggleMaximize(): Promise<WindowState>;
    close(): void;
    getState(): Promise<WindowState>;
    onState(listener: (state: WindowState) => void): () => void;
  };
}

export const IPC = {
  clipboardRead: "clipboard:read",
  clipboardWrite: "clipboard:write",
  externalOpenUrl: "external:open-url",
  containersProbe: "containers:probe",
  containersList: "containers:list",
  containersCleanup: "containers:cleanup",
  workspacesList: "workspaces:list",
  workspacesReview: "workspaces:review",
  workspacesExport: "workspaces:export",
  workspacesCleanup: "workspaces:cleanup",
  operationalMetricsLocal: "operational-metrics:local",
  operationalMetricsRemote: "operational-metrics:remote",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  dialogPickDirectory: "dialog:pick-directory",
  dialogPickMedia: "dialog:pick-media",
  mediaRead: "media:read",
  limitsGet: "limits:get",
  pluginsList: "plugins:list",
  pluginsSearch: "plugins:search",
  pluginsShowcase: "plugins:showcase",
  pluginsIcon: "plugins:icon",
  pluginsManifests: "plugins:manifests",
  pluginsCheckUpdates: "plugins:check-updates",
  pluginsUpdate: "plugins:update",
  pluginsUpdatesAvailable: "plugins:updates-available",
  pluginsPreviewInstall: "plugins:preview-install",
  pluginsInstall: "plugins:install",
  pluginsSetModules: "plugins:set-modules",
  pluginsSetEnabled: "plugins:set-enabled",
  pluginsSetHookEnabled: "plugins:set-hook-enabled",
  pluginsUninstall: "plugins:uninstall",
  pluginsOpenCanvas: "plugins:open-canvas",
  pluginsOpenWindow: "plugins:open-window",
  pluginsOpenExternal: "plugins:open-external",
  pluginsOpenBrowser: "plugins:open-browser",
  pluginsStorageGet: "plugins:storage-get",
  pluginsStorageSet: "plugins:storage-set",
  pluginsSecretsGet: "plugins:secrets-get",
  providerSecretsStatus: "provider-secrets:status",
  providerSecretsSet: "provider-secrets:set",
  providerSecretsClear: "provider-secrets:clear",
  providerSecretsCreate: "provider-secrets:create",
  providerSecretsScopedStatus: "provider-secrets:scoped-status",
  providerSecretsUpdate: "provider-secrets:update",
  providerSecretsRemove: "provider-secrets:remove",
  pluginsSecretsSet: "plugins:secrets-set",
  pluginsSecretsDelete: "plugins:secrets-delete",
  pluginsMediaPickLibrary: "plugins:media-pick-library",
  pluginsMediaListLibraries: "plugins:media-list-libraries",
  pluginsMediaScanLibrary: "plugins:media-scan-library",
  pluginsMediaRevokeLibrary: "plugins:media-revoke-library",
  pluginsPlaylistsList: "plugins:playlists-list",
  pluginsPlaylistsRead: "plugins:playlists-read",
  pluginsPlaylistsWrite: "plugins:playlists-write",
  pluginsHermesHudStatus: "plugins:hermes-hud-status",
  pluginsHermesHudOpen: "plugins:hermes-hud-open",
  pluginsHermesHudClose: "plugins:hermes-hud-close",
  pluginsHostInvoke: "plugins:host-invoke",
  pluginsLauncherRequested: "plugins:launcher-requested",
  pluginsCanvasRequested: "plugins:canvas-requested",
  pluginsBrowserOpenRequested: "plugins:browser-open-requested",
  pluginsBrowserOpenResponded: "plugins:browser-open-responded",
  pluginsStorageChanged: "plugins:storage-changed",
  evenG2State: "even-g2:state",
  evenG2Command: "even-g2:command",
  evenG2BrowserRequest: "even-g2:browser-request",
  evenG2BrowserResponse: "even-g2:browser-response",
  browserGetState: "browser:get-state",
  browserOpen: "browser:open",
  browserClose: "browser:close",
  browserCloseAllTabs: "browser:close-all-tabs",
  browserNewTab: "browser:new-tab",
  browserSelectTab: "browser:select-tab",
  browserCloseTab: "browser:close-tab",
  browserNavigate: "browser:navigate",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  browserReload: "browser:reload",
  browserExecute: "browser:execute",
  browserGetActivity: "browser:get-activity",
  browserClearData: "browser:clear-data",
  browserFocus: "browser:focus",
  browserSetInputFocused: "browser:set-input-focused",
  browserSetViewport: "browser:set-viewport",
  browserState: "browser:state",
  browserActivity: "browser:activity",
  browserPageWheelDecision: "browser:page-wheel-decision",
  browserPageWheel: "browser:page-wheel",
  browserCanvasWheel: "browser:canvas-wheel",
  browserCanvasFreezeFrame: "browser:canvas-freeze-frame",
  browserCanvasPointer: "browser:canvas-pointer",
  browserCanvasNavigationPointer: "browser:canvas-navigation-pointer",
  canvasNavigationShortcutCapture: "canvas-navigation:shortcut-capture",
  canvasNavigationPointerBinding: "canvas-navigation:pointer-binding",
  canvasNavigationOwnerWheel: "canvas-navigation:owner-wheel",
  canvasNavigationPointerGesture: "canvas-navigation:pointer-gesture",
  canvasNavigationOverrideState: "canvas-navigation:override-state",
  appVersion: "app:version",
  githubAuthStatus: "github-auth:status",
  githubAuthStart: "github-auth:start",
  githubAuthSignOut: "github-auth:sign-out",
  githubAuthOpenUrl: "github-auth:open-url",
  terminalList: "terminal:list",
  terminalReadBuffer: "terminal:read-buffer",
  terminalCreate: "terminal:create",
  agentsAvailability: "agents:availability",
  agentsRecheck: "agents:recheck",
  terminalRestart: "terminal:restart",
  terminalInput: "terminal:input",
  terminalResize: "terminal:resize",
  terminalBounds: "terminal:bounds",
  terminalRename: "terminal:rename",
  terminalDispose: "terminal:dispose",
  terminalData: "terminal:data",
  terminalSession: "terminal:session",
  terminalRemoved: "terminal:removed",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  windowGetState: "window:get-state",
  windowState: "window:state"
} as const;
