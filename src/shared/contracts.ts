import { CANVAS_LAUNCHER_ITEMS, PROVIDER_LABELS, isProviderId, type CanvasLauncherItemId, type ProviderId } from "./providerCatalog.ts";
export { CANVAS_LAUNCHER_ITEMS, PROVIDER_LABELS, isProviderId };
export type { CanvasLauncherItemId, ProviderId };
export type AgentProviderId = Exclude<ProviderId, "terminal">;
export type AgentCliAvailability = Record<AgentProviderId, boolean>;
export type LimitProviderId = Extract<AgentProviderId, "codex" | "claude" | "qwen" | "kimi" | "opencode" | "grok">;
/** "auto" only for agents with a native auto mode (autoMode.ts); "normal" is the default. */
export type LaunchProfileId = import("./autoMode.ts").LaunchProfile;
export type DefaultLaunchProfile = import("./autoMode.ts").DefaultLaunchProfile;
export type ReasoningEffort = import("./launchModel.ts").ReasoningEffort;
/**
 * What a session is for, independent of its normal/YOLO profile: an ordinary
 * agent, or an orchestrator that drives other sessions through the local
 * agent-control endpoint (it receives the control descriptor in its environment).
 */
export type LaunchRole = "agent" | "orchestrator";
export type SessionRole = LaunchRole | "subagent";
export type SessionStatus = "idle" | "working" | "needs_approval" | "unavailable" | "done" | "failed";
/** Settings → General, "Agent sessions after restart". */
export type SessionRestoreMode = "off" | "reopen" | "continue";
/**
 * Why a restored card is not simply running as before: it started a new
 * conversation because another card of that CLI shares its folder, or it is
 * held stopped because the environment it ran in is unavailable.
 */
export type SessionRestoreNote = "fresh-shared-folder" | "environment-unavailable" | "environment-pending" | "plugin-unavailable";
export type PaletteId = "sage" | "lilac" | "night";
export type HomeAccentPresetId = "classic" | "warm" | "cool" | "mono" | "custom";
export type SessionRowColorMode = "monochrome" | "status";
export type CanvasColorId = "sage" | "lilac" | "night" | "sand" | "mist" | "rose" | "slate";
export type CanvasPatternId = "dots" | "grid" | "waves" | "diagonal" | "rings" | "none";
export type CustomTerminalBorderSkinId = `custom:${string}`;
export type PixelTerminalBorderSkinId = `pixel:${string}`;
export const BUNDLED_CANVAS_BACKGROUND_IDS = ["sakura", "matrix", "forest-cabin", "gold-black", "cat", "gothic-eclipse"] as const;
export type CanvasBackgroundId = "none" | typeof BUNDLED_CANVAS_BACKGROUND_IDS[number] | PixelTerminalBorderSkinId;
export type PixelSkinPreferredDetail = "minimal" | "detailed";
export type PixelSkinSlot = `${"minimal" | "detailed" | "master"}_${"idle" | "working" | "completed"}` | "background";
export interface PixelSkinAperture { left: number; right: number; top: number; bottom: number }
export type PixelSkinApertures = Record<PixelSkinPreferredDetail | "master", PixelSkinAperture>;
export const DEFAULT_PIXEL_SKIN_APERTURES: PixelSkinApertures = {
  minimal: { left: 10, right: 10, top: 16, bottom: 16 },
  detailed: { left: 14, right: 14, top: 18, bottom: 19 },
  master: { left: 15, right: 15, top: 21, bottom: 22 }
};
export interface PixelSkinPackSummary { id: PixelTerminalBorderSkinId; name: string; aperture: PixelSkinAperture; apertures: PixelSkinApertures }
export interface PixelSkinPackInstallRequest { name: string; files: Record<PixelSkinSlot, Uint8Array>; aperture?: PixelSkinAperture; apertures?: PixelSkinApertures }
export interface PixelSkinZipInstallRequest { name: string; archive: Uint8Array; apertures?: PixelSkinApertures }
export type TerminalBorderSkinId = "classic" | "minimal" | "glass" | "cyber" | "nord" | "gradient" | "cybercore" | "titanium" | "retro" | "sakura" | "matrix" | "forest-cabin" | "gold-black" | "cat" | "gothic-eclipse" | CustomTerminalBorderSkinId | PixelTerminalBorderSkinId;
/** v1 manifest uses an unprefixed plain slug; files live at the fixed skin.css path. */
export interface TerminalBorderSkinManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: "terminal-border";
}
/** Metadata only; the CSS is returned by get(). */
export type TerminalBorderSkinListItem =
  | { id: CustomTerminalBorderSkinId; name: string; revision: string; status: "ready" }
  | { id: CustomTerminalBorderSkinId; name?: string; revision?: string; status: "error"; error: string };
export type TerminalBorderSkinReadResult =
  | { id: CustomTerminalBorderSkinId; name: string; revision: string; status: "ready"; css: string }
  | { id: CustomTerminalBorderSkinId; status: "error"; error: string };
export type AppSkinId = "classic" | "atelier" | "signal" | "greenhouse" | "midnight";
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
export type TerminalLinkOpenMode = "canvas" | "external" | "ask";
export type ShortcutAction = keyof ShortcutBindings;
export type KeyboardPreset = "macos" | "windows" | "linux" | "custom";
export type RadialLauncherActionId = "note" | "browser" | "settings";
export type RadialLauncherItemId = ProviderId | RadialLauncherActionId;

/** Every agent provider (the launcher list without the plain terminal). */
export const AGENT_PROVIDERS: readonly AgentProviderId[] = CANVAS_LAUNCHER_ITEMS
  .filter((item): item is AgentProviderId => item !== "terminal");
/** The providers whose usage limits CanvasTTY reads, in display order. */
export const LIMIT_PROVIDERS: readonly LimitProviderId[] = ["codex", "claude", "qwen", "kimi", "opencode", "grok"];
// Keeps the safe provider subset proposed by @TroopJostle in PR #23 while
// region, note, Browser, and Settings remain fixed top-level menu actions.
export const DEFAULT_CANVAS_LAUNCHER_ITEMS: readonly CanvasLauncherItemId[] = [
  "codex",
  "claude",
  "qwen",
  "opencode",
  "terminal"
];

export const RADIAL_LAUNCHER_ITEMS: readonly RadialLauncherItemId[] = [...CANVAS_LAUNCHER_ITEMS, "note", "browser", "settings"];

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
  toggleFullscreen: string;
  commandPalette: string;
  openSettings: string;
  focusUp: string;
  focusDown: string;
  focusLeft: string;
  focusRight: string;
  toggleDetail: string;
  terminalCopy: string;
  terminalPaste: string;
  terminalSearch: string;
  terminalRestart: string;
  terminalPageUp: string;
  terminalPageDown: string;
  codexSubmit: string;
  codexSubmitAlternate: string;
  codexSubmitSuper: string;
  codexNewline: string;
  codexSelectAll: string;
}

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  home: "Home",
  renameWindow: "F2",
  toggleFullscreen: "Meta+F",
  commandPalette: "Ctrl+K",
  openSettings: "Ctrl+Comma",
  focusUp: "Alt+ArrowUp",
  focusDown: "Alt+ArrowDown",
  focusLeft: "Alt+ArrowLeft",
  focusRight: "Alt+ArrowRight",
  toggleDetail: "F4",
  terminalCopy: "Ctrl+C",
  terminalPaste: "Ctrl+Shift+V",
  terminalSearch: "Ctrl+Shift+F",
  terminalRestart: "Ctrl+D",
  terminalPageUp: "PageUp",
  terminalPageDown: "PageDown",
  codexSubmit: "Enter",
  codexSubmitAlternate: "Ctrl+Enter",
  codexSubmitSuper: "Meta+Enter",
  codexNewline: "Shift+Enter",
  codexSelectAll: "Ctrl+A"
};

export function keyboardPresetShortcuts(preset: Exclude<KeyboardPreset, "custom">): ShortcutBindings {
  return {
    ...DEFAULT_SHORTCUTS,
    toggleFullscreen: preset === "macos" ? "Meta+F" : "F11",
    ...(preset !== "macos" ? { terminalCopy: "Ctrl+Shift+C" } : {}),
    ...(preset === "macos" ? {
      commandPalette: "Meta+K", openSettings: "Meta+Comma",
      terminalCopy: "Meta+C", terminalPaste: "Meta+V", codexSelectAll: "Meta+A"
    } : {})
  };
}

export function shortcutsShareContext(left: ShortcutAction, right: ShortcutAction): boolean {
  const terminal = (action: ShortcutAction) => action.startsWith("terminal") || action.startsWith("codex");
  return left === "toggleDetail" || right === "toggleDetail" || terminal(left) === terminal(right);
}

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

export type MaterialKind = "image" | "text" | "video" | "audio" | "pdf" | "file";
export type MaterialState = "ready" | "missing" | "moved" | "unreadable";
export type MaterialVersionReason = "pinned" | "remark" | "capture" | "edit";

export type MaterialOrigin =
  | { kind: "clipboard" }
  | { kind: "browser"; url: string; title: string; viewport: Size }
  | { kind: "watch"; folderName: string };

export interface MaterialVersion {
  id: string;
  number: number;
  createdAt: number;
  byteSize: number;
  reason: MaterialVersionReason;
  current: boolean;
  natural: Size | null;
}

export interface CanvasMaterial extends SessionBounds {
  id: string;
  kind: MaterialKind;
  name: string;
  mimeType: string;
  location: string | null;
  state: MaterialState;
  movedTo: string | null;
  liveRevision: number;
  byteSize: number | null;
  modifiedAt: number | null;
  origin: MaterialOrigin | null;
  versions: MaterialVersion[];
  createdAt: number;
}

export interface MaterialStorageUsage {
  usedBytes: number;
  limitBytes: number;
}

export interface MaterialsSnapshot {
  revision: number;
  loadError?: "unreadable";
  materials: CanvasMaterial[];
  remarks: MaterialRemark[];
  storage: MaterialStorageUsage;
}

export type MaterialRejectionReason = "not-a-file" | "unreadable" | "limit" | "quota" | "too-large" | "empty-clipboard";

export interface MaterialRejection {
  name: string;
  reason: MaterialRejectionReason;
}

export interface MaterialsAddResult {
  added: string[];
  existing: string[];
  rejected: MaterialRejection[];
}

export type MaterialFailure =
  | "unavailable"
  | "too-large"
  | "quota"
  | "unreadable"
  | "not-a-file"
  | "kind-mismatch"
  | "already-on-canvas"
  | "version-limit"
  | "material-limit"
  | "remark-limit"
  | "cancelled";

export type MaterialResult = { ok: true } | { ok: false; reason: MaterialFailure };

export type MaterialCreateResult = { ok: true; materialId: string } | { ok: false; reason: MaterialFailure };

export type RemarkAnchor =
  | { kind: "whole" }
  | { kind: "region"; x: number; y: number; width: number; height: number }
  | { kind: "point"; x: number; y: number }
  | { kind: "lines"; start: number; end: number }
  | { kind: "time"; start: number; end: number | null }
  | { kind: "page"; page: number }
  | { kind: "step"; index: number };

export interface RemarkTarget {
  materialId: string;
  versionId: string;
  anchor: RemarkAnchor;
}

export type RemarkStatus = "open" | "sent" | "reported" | "accepted" | "reopened";

export interface RemarkReport {
  handoffId: string;
  at: number;
  note: string | null;
}

export interface MaterialRemark {
  id: string;
  number: number;
  target: RemarkTarget;
  reference: RemarkTarget | null;
  text: string;
  status: RemarkStatus;
  createdAt: number;
  updatedAt: number;
  handoffIds: string[];
  report: RemarkReport | null;
}

export interface RemarkDraft {
  materialId: string;
  anchor: RemarkAnchor;
  reference: { materialId: string; anchor: RemarkAnchor } | null;
  text: string;
}

export interface RemarkPatch {
  text?: string;
  status?: "open" | "accepted" | "reopened";
}

export type RemarkResult = { ok: true; remark: MaterialRemark } | { ok: false; reason: MaterialFailure };

export type MaterialVersionResult = { ok: true; version: MaterialVersion } | { ok: false; reason: MaterialFailure };

export interface CameraState extends Point {
  zoom: number;
}

export interface AppSettings {
  locale: LocaleId;
  sessionRestoreMode: SessionRestoreMode;
  persistCanvasRegions: boolean;
  persistStickyNotes: boolean;
  persistMaterials: boolean;
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
  /** Base protection: deny-only hard rules for agents' tool calls (writes outside the folder, sudo, …). */
  baseProtectionEnabled: boolean;
  uiScale: number;
  canvasColor: CanvasColorId;
  canvasBackground: CanvasBackgroundId;
  pattern: CanvasPatternId;
  terminalBorderSkin: TerminalBorderSkinId;
  terminalSkinDetail: PixelSkinPreferredDetail;
  terminalSkinAnimationEnabled: boolean;
  appSkin: AppSkinId;
  snapToGrid: boolean;
  copyOnSelect: boolean;
  terminalLinkOpenMode: TerminalLinkOpenMode;
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
  keyboardPreset: KeyboardPreset;
  mediaPath: string | null;
  mediaFit: MediaFit;
  lastDirectory: string;
  acknowledgedDangerousProfiles: AgentProviderId[];
  apiProfiles: ApiProfile[];
  homeGridSize: HomeGridSize;
  homeLayout: HomeWidgetPlacement[];
  canvasRegions: CanvasRegion[];
  stickyNotes: StickyNote[];
  pluginCanvas: PluginCanvasInstance[];
  /** Persisted Files card state (root reference, bounds, open file, tree). */
  fileCards: FileCard[];
  browserCanvas: BrowserCanvasState | null;
  browserAgentAccess: boolean;
  browserShowAgentPresence: boolean;
  browserRestoreTabs: boolean;
  /** Pause hidden browser tabs after a while, and put long-hidden ones to sleep (they reload when used). */
  browserPauseHiddenTabs: boolean;
  /** Show an OS notification when a session needs approval or fails. */
  attentionNotifications: boolean;
  /**
   * Show the on-canvas attention panel (sessions awaiting approval or failed).
   * Independent of `attentionNotifications`: one is the HUD, the other the OS toast.
   */
  attentionQueueVisible: boolean;
  /** Canvas corner that hosts the attention panel. */
  attentionQueuePlacement: CanvasOverlayPlacement;
  /** Show the built-in provider conversation history HUD. */
  agentChatHistoryVisible: boolean;
  /** Canvas corner that hosts the provider conversation history HUD. */
  agentChatHistoryPlacement: CanvasOverlayPlacement;
  /** How to expand the collapsed history panel. */
  agentChatHistoryExpandMode: "hover" | "click";
  agentChatHistorySearchAgents: "current" | "all";
  agentChatHistorySearchSessions: "filtered" | "all";
  /**
   * Serve the local agent-control endpoint (Settings → Agents) that the bundled
   * `canvastty-control.mjs` CLI and Orchestrator sessions talk to. Off by default;
   * `--agent-control` / `CANVASTTY_AGENT_CONTROL=1` force it on for one launch.
   */
  agentControlEnabled: boolean;
  /**
   * Agent isolation (Settings → Agents): the operating-system layer around agents that the person did not launch
   * directly (subagents, agents a plugin starts) and around every agent in auto. "on" by default; "off" runs them
   * without it (the person's choice; on Windows, where there is no layer yet, this is the opt-in for auto subagents).
   */
  agentIsolation: AgentIsolationSetting;
  /** How many levels of subagents one top-level orchestrator may have below it (1–4, 2 by default). */
  orchestrationMaxDepth: number;
  /** How many live subagents one top-level orchestrator may have at once, all levels together (1–32, 8 by default). */
  orchestrationMaxSubagents: number;
  /** The common mode the launcher starts in (auto by default); a CLI without it starts in the next one it has. */
  defaultLaunchProfile: DefaultLaunchProfile;
  /** Optional per-agent overrides for the common launch mode. */
  defaultLaunchProfiles: Partial<Record<AgentProviderId, DefaultLaunchProfile>>;
}

export type AgentIsolationSetting = "on" | "off";

/** What the operating-system isolation layer does for one card (shown on the card). */
export interface SessionIsolation {
  /** "on": the agent runs inside the layer; "off": the person turned it off; "unavailable": no layer here (reason). */
  state: "on" | "off" | "unavailable" | "environment";
  /** The mechanism: macOS seatbelt (sandbox-exec) or Linux bubblewrap. */
  layer?: "seatbelt" | "bubblewrap";
  /** Why it is not on, or what changed because of that (e.g. auto ran as normal). */
  reason?: string;
}

export interface CreateSessionRequest {
  provider: ProviderId;
  cwd: string;
  profile: LaunchProfileId;
  position: Point;
  title?: string;
  /** Defaults to "agent"; "orchestrator" is only meaningful for agent providers. */
  role?: SessionRole;
  /** Owning session; required for subagents. Cycles are impossible because a
   * parent must already exist when the child is created. */
  parentSessionId?: string;
  /** Launch options per plugin id; each named plugin's launch service prepares this launch. */
  launchOptions?: Record<string, PluginLaunchValues>;
  /** Where the session runs: a plugin environment kind; omitted = this computer. */
  environment?: SessionEnvironmentChoice;
  /** Exact provider conversation to resume when this card is created from history. */
  resumeThreadId?: string;
  /** The CLI's --model for this launch (launchModel.ts); omitted keeps the CLI's own default. */
  model?: string;
  /** The CLI's reasoning effort for this launch; only the levels that CLI takes. */
  effort?: ReasoningEffort;
}

/** Every non-terminal agent that CanvasTTY can install and resolve. */
export type AgentChatHistoryProviderId = AgentProviderId;

export interface AgentChatHistoryItem {
  id: string;
  provider: AgentChatHistoryProviderId;
  title: string;
  cwd: string | null;
  lastActivityAt: number;
}

export interface AgentChatHistoryPage {
  provider: AgentChatHistoryProviderId;
  items: AgentChatHistoryItem[];
  nextCursor: string | null;
  error?: string;
  warning?: string;
}

export type AgentChatHistoryResumeResult =
  | { session: SessionSnapshot; reused: boolean }
  | { error: { code: "invalid-id" | "cli-unavailable" | "conversation-missing" | "cwd-unknown" | "cwd-unavailable" | "resume-failed"; message: string } };

export interface SessionMetadata {
  id: string;
  revision: number;
  provider: ProviderId;
  /** Bindings actually consumed by this separately launched Codex editor. */
  nativeEditor?: { submit: string; submitAlternate: string; submitSuper: string; newline: string; selectAll: string };
  /** Provider conversation id, when the session is attached to one. */
  threadId?: string;
  profile: LaunchProfileId;
  title: string;
  titleCustomized: boolean;
  cwd: string;
  position: Point;
  size: Size;
  role: SessionRole;
  parentSessionId?: string;
  status: SessionStatus;
  /** True only after an explicit provider turn-stop signal; cleared by the next working turn. */
  turnCompleted?: boolean;
  startedAt: number;
  exitCode: number | null;
  failureDetails: string | null;
  /** Set when the person chose "Don't restore this card". */
  skipRestore?: boolean;
  restoreNote?: SessionRestoreNote;
  /** The plugin environment this card runs in (badge text from the plugin's describe). */
  environment?: SessionEnvironmentBadge;
  /** Profile "auto" runs as accept-edits: a launch contributor put the agent on a third-party model. */
  autoDowngraded?: true;
  /** The model and effort the launch asked the CLI for; restarts and restores keep them. */
  model?: string;
  effort?: ReasoningEffort;
  /** The operating-system isolation layer around this agent, when one applies or was wanted. */
  isolation?: SessionIsolation;
  /**
   * In the normal (manual) profile the CLI follows its own configuration: when that configuration skips approvals
   * (Claude's defaultMode, Codex's approval_policy/sandbox_mode, OpenCode's permission), what it says and where.
   */
  configuredMode?: { mode: string; source: string };
  /** Dangerous git settings the isolated agent's session left under its folder (see GitRiskReport). */
  gitRisk?: GitRiskReport;
}

/** Something in a repository's git folder that runs a program when the person uses git there (gitAudit.ts). */
export type GitRiskItem =
  | { kind: "config"; key: string; value: string }
  | { kind: "hook"; name: string }
  | { kind: "attributes" };

/**
 * What an isolated agent's session left in repositories under its folder that would run outside the layer the next
 * time the person uses git there. Shown on the card (or, for a closed card, by the app) until the person neutralizes
 * or keeps it; never changed without them.
 */
export interface GitRiskReport {
  id: string;
  /** The card's folder. */
  cwd: string;
  /** The card's title, for a report about a card that was closed. */
  title?: string;
  /** Each repository's working folder (the parent of its .git) and what was found there. */
  repositories: Array<{ path: string; items: GitRiskItem[] }>;
}

export interface SessionSnapshot extends SessionMetadata {
  buffer: string;
}

/**
 * Which consumers a terminalData event is meant for. The main process feeds
 * every manager event to its in-process observers (agent control, companion
 * presentation) and to the renderer. Output produced while a card is hidden
 * still has to reach the observers, whose cached screens would otherwise go
 * stale, but must not reach the renderer, which gets one replay when the card
 * is shown again; that replay in turn carries nothing the observers have not
 * already seen. Absent means every consumer.
 */
export type TerminalDataAudience = "observers" | "renderer";

export interface TerminalDataEvent {
  id: string;
  data: string;
  /** Total UTF-16 code units produced, including this batch and trimmed history. */
  outputOffset: number;
  audience?: TerminalDataAudience;
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

/** Newest manifest apiVersion. Version 1 manifests stay valid; `services` needs version 2. */
export const PLUGIN_API_VERSION = 2;
export type PluginApiVersion = 1 | typeof PLUGIN_API_VERSION;

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
  | "network"
  | "launch:contribute"
  | "environment:provide"
  | "decision:provide"
  | "tools:agents"
  | "sessions:events"
  | "sessions:read-screen"
  | "sessions:launch"
  | "sessions:control"
  | "cards:decorate"
  | "browser:engine";

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

/**
 * A long-lived native service: a bundled single-file JavaScript entry that CanvasTTY runs as a
 * separate supervised process after the user trusts the plugin's native code (apiVersion 2).
 */
export interface PluginService {
  id: string;
  title: string;
  description?: string;
  entry: string;
  module?: string;
  /** Launch contribution (`launch:contribute`): options shown in the launcher's Advanced section. */
  launch?: PluginServiceLaunch;
  /** Session environments (`environment:provide`): kinds offered in the launcher's "Where" choice. */
  environments?: PluginEnvironmentKind[];
  /** Decision hooks (`decision:provide`): answers deny, ask or allow before agents' tool calls run. */
  decide?: PluginServiceDecide;
  /** Agent tools (`tools:agents`): listed in the canvastty_agents MCP as `<pluginId>__<name>`. */
  tools?: PluginAgentTool[];
  /** Card actions (`cards:decorate`): menu items on matching cards; the host calls `canvastty.cards.invoke`. */
  cardActions?: PluginCardAction[];
  /** A browser engine (`browser:engine`) for agents' background tabs; the host calls `canvastty.browserEngine.*`. */
  browserEngine?: PluginBrowserEngine;
}

/** A browser engine a plugin service runs: it hands the core one local CDP WebSocket per agent background tab. */
export interface PluginBrowserEngine {
  /** What agents pass as `engine` to browser_new_tab; `[a-z0-9][a-z0-9._-]*`, never `auto` or `chromium`. */
  id: string;
  title: string;
  description?: string;
  /** The engine lays pages out for real. Without layout (the default) clicks and hovers go through the DOM. */
  layout: boolean;
}

/** A tool a plugin service offers to agents through canvastty_agents. */
export interface PluginAgentTool {
  /** `[a-z][a-z0-9_]{0,39}`; agents see `<pluginId>__<name>`. */
  name: string;
  description: string;
  /** JSON Schema of the arguments; its top level is `type: "object"`. At most 8 KB. */
  inputSchema: Record<string, unknown>;
  /** Session roles that see the tool. */
  roles: SessionRole[];
}

/** Which cards show a plugin's card action; every listed key must match (a missing key matches all). */
export interface PluginCardActionFilter {
  providers?: ProviderId[];
  /** Environment kinds (any plugin's); a card outside an environment never matches. */
  environmentKinds?: string[];
  roles?: SessionRole[];
}

export interface PluginCardAction {
  id: string;
  title: string;
  when?: PluginCardActionFilter;
}

export type PluginCardTone = "neutral" | "info" | "warn" | "error";

/** Short plain text a plugin shows on a card (no HTML). */
export interface PluginCardBadge {
  pluginId: string;
  text: string;
  tone: PluginCardTone;
  tooltip?: string;
}

export interface PluginCardActionEntry {
  pluginId: string;
  pluginName: string;
  actionId: string;
  title: string;
  when?: PluginCardActionFilter;
}

/** Everything plugins add to cards: badges per session id and the declared actions. */
export interface PluginCardDecorations {
  badges: Record<string, PluginCardBadge[]>;
  actions: PluginCardActionEntry[];
}

/** What a card action answered, shown as a toast on the card. */
export interface PluginCardActionResult {
  message?: string;
  tone: PluginCardTone;
}

export type PluginDecisionEvent = "pre-tool";

export interface PluginServiceDecide {
  /** `pre-tool`: every shell or file-writing tool call, before it runs (YOLO included). */
  events: PluginDecisionEvent[];
  /** Agents it decides for; all agents with decision hooks when omitted. */
  appliesTo?: AgentProviderId[];
  /** How long CanvasTTY waits for its answer: 1 to 60 s, 3 s when omitted. The agent's call waits as long. */
  timeoutMs?: number;
}

/** One place a session can run (a worktree, a container, a remote host), provided by a plugin service. */
export interface PluginEnvironmentKind {
  kind: string;
  label: string;
  description?: string;
  /** Providers it applies to, "terminal" included; all when omitted. */
  appliesTo?: ProviderId[];
  /** Launcher fields for this kind; values go to `canvastty.environment.prepare` only. */
  fields?: PluginLaunchField[];
  /**
   * What of CanvasTTY's protection reaches the agent inside this environment, as the plugin declares it. Undeclared
   * means no: the core then refuses a launch that needs it, or marks the card as not protected.
   */
  keeps?: PluginEnvironmentKeeps;
}

export interface PluginEnvironmentKeeps {
  /** The launch's arguments and environment reach the agent unchanged: CanvasTTY's hooks (base protection, decisions,
   * lifecycle) and the profile's per-run settings (auto, accept-edits, plan) work there. */
  launch?: boolean;
  /** The agent does not run on this computer's files (a container, a remote host), so this computer's isolation layer
   * does not apply; the environment's own boundary does. */
  isolated?: boolean;
  /** The environment itself confines the agent to the project (for example a container that mounts only it). */
  confines?: boolean;
}

export interface SessionEnvironmentChoice {
  pluginId: string;
  kind: string;
  options?: PluginLaunchValues;
}

export interface SessionEnvironmentBadge {
  pluginId: string;
  kind: string;
  label: string;
  detail?: string;
}

export type PluginLaunchFieldKind = "boolean" | "select" | "text";

/** One launcher option. Values are saved with the session (at most 4 KB per plugin), never secrets. */
export interface PluginLaunchField {
  key: string;
  label: string;
  kind: PluginLaunchFieldKind;
  /** `select` only: 1 to 16 choices. */
  options?: Array<{ value: string; label: string }>;
  /** `select` only: the launcher also asks the service (`canvastty.launch.options`) for up to 64 more choices, such as
   * the plugin's own accounts. The saved value is any short text then; the service checks it when it prepares. */
  optionsFrom?: "service";
  default?: boolean | string;
  /** `text` only: at most 200 characters (the default). */
  maxLength?: number;
}

export interface PluginServiceLaunch {
  /** Agents the options apply to; all agents when omitted. */
  appliesTo?: AgentProviderId[];
  fields: PluginLaunchField[];
  /** Also asked, with `chosen: false`, before every launch of those agents where the person did not choose the
   * plugin; such an answer may only refuse. */
  policy?: boolean;
  /**
   * The plugin declares these options safe for an orchestrator to choose for its subagents (spawn_agent's
   * launchOptions). Without it only the person chooses them, in the launcher.
   */
  delegable?: boolean;
}

/** Field key -> extra choices a service offered for an `optionsFrom: "service"` select. */
export type PluginLaunchFieldOptions = Record<string, Array<{ value: string; label: string }>>;

/** One plugin's option values for one session, as chosen in the launcher. */
export type PluginLaunchValues = Record<string, boolean | string>;

export type PluginServiceState = "stopped" | "starting" | "running" | "backoff" | "failed";

export interface PluginServiceStatus {
  serviceId: string;
  state: PluginServiceState;
  restarts: number;
  lastError?: string;
}

export interface PluginServiceLogEntry {
  at: number;
  serviceId: string;
  source: "host" | "service" | "stderr" | "stdout";
  level: "info" | "warn" | "error";
  message: string;
}

export interface PluginServiceReport {
  services: PluginServiceStatus[];
  log: PluginServiceLogEntry[];
}

export interface PluginServiceEvent {
  pluginId: string;
  serviceId: string;
  event: string;
  data: unknown;
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
  apiVersion: PluginApiVersion;
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
  services?: PluginService[];
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
  /** The user trusted this plugin's services to run as native code. Never set by install or update. */
  nativeCodeTrusted: boolean;
  /** Its decision service may allow tool calls (a second confirmation); revoked with native code trust. */
  decisionsMayAllow: boolean;
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

/** How a Files card is rooted: a terminal session cwd or a dialog-picked folder. */
export type FileRootKind = "session" | "folder";

/**
 * Identifies a root without carrying a filesystem path across the bridge.
 * Session roots name the terminal session whose cwd main resolves; folder roots
 * are created by the native open-folder dialog in main. A folder reference may
 * carry `folderPath` only on restore, to re-register a persisted folder root
 * after relaunch; list/read/search never carry paths.
 */
export type FileRootReference =
  | { rootType: "session"; sessionId: string }
  | { rootType: "folder"; folderPath?: string };

/**
 * Opaque main-owned handle for a registered root. `rootId` is the only way the
 * renderer addresses the root; list/read/search always pair it with a relative
 * path so no absolute root path ever reaches renderer payloads.
 */
export interface FileRootDescriptor {
  rootId: string;
  label: string;
  available: boolean;
  rootType: FileRootKind;
  /**
   * Canonical absolute folder path for folder roots, retained so a persisted
   * root can be re-registered after relaunch. Session descriptors omit it, so a
   * session cwd never crosses the bridge.
   */
  folderPath?: string | null;
}

export type FileEntryKind = "file" | "directory";

export interface FileEntry {
  name: string;
  relativePath: string;
  kind: FileEntryKind;
  /** Byte size for files; null for directories. */
  size: number | null;
}

export type FileReadUnsupportedReason = "binary" | "not-permitted" | "unavailable";

/** Bounded, typed file content. Unsupported and oversized reads carry no bytes. */
export type FileReadResult =
  | { kind: "text"; content: string; truncated: boolean; size: number }
  | { kind: "image"; mediaType: string; dataUrl: string; size: number }
  | { kind: "unsupported"; reason: FileReadUnsupportedReason }
  | { kind: "too-large"; reason: "too-large"; size: number };

/** Bounded filename-search output: relative file paths only. */
export interface FileSearchResult {
  relativePaths: string[];
  truncated: boolean;
}

/**
 * Persisted Files card state. `root` records how the card was rooted; folder
 * roots retain `folderPath` so main can re-validate and re-open the folder after
 * relaunch, while session roots resolve `sessionId` to its cwd again. Neither
 * value is used in list/read/search payloads, which stay relative.
 */
export interface FileCard extends SessionBounds {
  id: string;
  root: FileRootReference;
  /** Display label for the root; null when unknown. Never an absolute path. */
  label: string | null;
  /** Absolute folder path for folder roots; null for session roots. */
  folderPath: string | null;
  /** Relative path of the file shown in the viewer, or null. */
  activeFile: string | null;
  /** Relative paths of expanded tree folders. */
  expandedFolders: string[];
}

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
  secretRef: ProviderSecretId;
  defaultModel?: string;
}

export const API_PROFILE_PROTOCOLS: readonly ApiProfileProtocol[] = ["openai-compatible", "anthropic-compatible", "google"];

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
  /**
   * A hidden tab CanvasTTY paused to save power: "paused" is frozen (it resumes at once), "sleeping" is unloaded
   * (it reloads when shown or used). Absent while the tab runs.
   */
  lifecycle?: BrowserTabLifecycleState;
  /** The last picture of a sleeping tab, for the card; only on the active tab. Never sent to agents. */
  preview?: string | null;
  /**
   * Set on an agent's background tab that a plugin-contributed browser engine drives (the engine id). Such a tab is
   * never shown: showing it moves it to Chromium first. Absent on Chromium tabs.
   */
  engine?: string;
}

export type BrowserTabLifecycleState = "paused" | "sleeping";

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
  /**
   * browser_new_tab only: `auto` (default), `chromium`, or a plugin-contributed engine's id. `auto` gives an agent's
   * new tab the installed engine when one runs; a person's tabs always use Chromium.
   */
  engine?: string;
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
  /** Set when the tab had been put to sleep while hidden and was reloaded to run this command. */
  notice?: string;
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
  | "session-expired"
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

export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent: number | null }
  | { status: "downloaded"; version: string }
  | { status: "unavailable"; reason: "dev" | "offline" | "error" };

export type UpdateStatus =
  | { type: "idle" }
  | { type: "checking" }
  | { type: "available"; version: string; notes?: string; manualUrl?: string }
  | { type: "downloading"; percent?: number }
  | { type: "ready"; version: string }
  | { type: "installing" }
  | { type: "upToDate" }
  | { type: "error"; message: string };

export interface DiagnosticConfiguration { available: boolean; host: string | null }
export interface DiagnosticReportReceipt { reportId: string }
export const DIAGNOSTIC_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export interface DiagnosticAttachment {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
}
export interface DiagnosticRendererError {
  kind: "render" | "window" | "unhandled-rejection";
  message: string;
  stack?: string;
  componentStack?: string;
}

export interface CanvasTTYApi {
  diagnostics: {
    configuration(): Promise<DiagnosticConfiguration>;
    send(description: string, attachment?: DiagnosticAttachment): Promise<DiagnosticReportReceipt>;
    reportError(error: DiagnosticRendererError): void;
  };
  update: {
    status(): Promise<UpdateStatus>;
    check(): Promise<void>;
    download(): Promise<void>;
    install(): Promise<void>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
  };
  evenG2: import('./evenG2.ts').EvenG2Api;
  appVersion(): Promise<string>;
  clipboard: {
    readText(): Promise<string>;
    hasImage(): Promise<boolean>;
    writeText(text: string): void;
  };
  external: {
    openUrl(url: string): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
    onChanged(listener: (settings: AppSettings) => void): () => void;
  };
  skins: {
    list(): Promise<TerminalBorderSkinListItem[]>;
    get(id: CustomTerminalBorderSkinId): Promise<TerminalBorderSkinReadResult>;
    onChanged(listener: () => void): () => void;
  };
  pixelSkins: {
    list(): Promise<PixelSkinPackSummary[]>;
    install(request: PixelSkinPackInstallRequest): Promise<PixelSkinPackSummary>;
    installZip(request: PixelSkinZipInstallRequest): Promise<PixelSkinPackSummary>;
    readAsset(id: PixelTerminalBorderSkinId, slot: PixelSkinSlot): Promise<Uint8Array | null>;
    onChanged(listener: () => void): () => void;
  };
  agents: {
    availability(): Promise<AgentCliAvailability>;
    recheck(): Promise<{ availability: AgentCliAvailability; settings: AppSettings }>;
  };
  agentChatHistory: {
    providers(): Promise<AgentChatHistoryProviderId[]>;
    list(provider: AgentChatHistoryProviderId, cursor?: string): Promise<AgentChatHistoryPage>;
    resume(provider: AgentChatHistoryProviderId, id: string, position: Point): Promise<AgentChatHistoryResumeResult>;
  };
  dialog: {
    pickDirectory(defaultPath?: string): Promise<string | null>;
    pickMedia(): Promise<MediaSelection | null>;
  };
  media: {
    read(path: string): Promise<string | null>;
  };
  files: {
    listRoots(): Promise<FileRootDescriptor[]>;
    /** Registers a session or folder root reference; resolves null when unavailable. */
    registerRoot(reference: FileRootReference): Promise<FileRootDescriptor | null>;
    /** Opens the native folder picker; resolves null when canceled. */
    openFolder(): Promise<FileRootDescriptor | null>;
    list(rootId: string, relativePath: string): Promise<FileEntry[]>;
    read(rootId: string, relativePath: string): Promise<FileReadResult>;
    search(rootId: string, query: string): Promise<FileSearchResult>;
    closeRoot(rootId: string): Promise<void>;
  };
  materials: {
    snapshot(): Promise<MaterialsSnapshot>;
    addFiles(files: File[], point: Point): Promise<MaterialsAddResult>;
    pick(point: Point): Promise<MaterialsAddResult>;
    paste(point: Point): Promise<MaterialsAddResult>;
    setBounds(id: string, bounds: SessionBounds): void;
    setBoundsBatch(entries: { id: string; bounds: SessionBounds }[]): void;
    remove(id: string): Promise<void>;
    pinVersion(id: string): Promise<MaterialVersionResult>;
    reveal(id: string): Promise<void>;
    relink(id: string): Promise<MaterialResult>;
    acceptMove(id: string): Promise<MaterialResult>;
    addRemark(draft: RemarkDraft): Promise<RemarkResult>;
    updateRemark(id: string, patch: RemarkPatch): Promise<RemarkResult>;
    deleteRemark(id: string): Promise<void>;
    onChanged(listener: (snapshot: MaterialsSnapshot) => void): () => void;

  };
  limits: {
    get(): Promise<LimitsSnapshot>;
  };
  providerSecrets: {
    status(): Promise<Record<ProviderSecretId, boolean>>;
    set(secretId: ProviderSecretId, value: string): Promise<void>;
    clear(secretId: ProviderSecretId): Promise<void>;
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
    setNativeCodeTrusted(pluginId: string, trusted: boolean): Promise<InstalledPlugin>;
    setDecisionsMayAllow(pluginId: string, allowed: boolean): Promise<InstalledPlugin>;
    serviceReport(pluginId: string): Promise<PluginServiceReport>;
    serviceRequest(pluginId: string, serviceId: string, method: string, params: unknown): Promise<unknown>;
    onServiceEvent(listener: (event: PluginServiceEvent) => void): () => void;
    cardDecorations(): Promise<PluginCardDecorations>;
    onCardDecorations(listener: (decorations: PluginCardDecorations) => void): () => void;
    invokeCardAction(pluginId: string, actionId: string, sessionId: string): Promise<PluginCardActionResult>;
    /** The service-provided choices of a plugin's `optionsFrom: "service"` launch fields for this agent; empty on any failure. */
    launchFieldOptions(pluginId: string, provider: ProviderId): Promise<PluginLaunchFieldOptions>;
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
    openFile(id: string, reference: string): Promise<void>;
    fileDropText(files: File[]): string;
    list(): Promise<SessionSnapshot[]>;
    readBuffer(id: string): Promise<TerminalBufferSnapshot>;
    create(request: CreateSessionRequest): Promise<SessionSnapshot>;
    /** `resume` continues the card's own conversation instead of starting a new one. */
    restart(id: string, options?: { resume?: boolean }): Promise<SessionSnapshot>;
    input(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    setBounds(id: string, bounds: SessionBounds): void;
    rename(id: string, title: string): Promise<SessionMetadata>;
    setRestore(id: string, restore: boolean): Promise<SessionMetadata>;
    /** `keepEnvironmentData` answers "Keep environment data?" for a card that runs in a plugin environment. */
    dispose(id: string, options?: { keepEnvironmentData?: boolean }): Promise<void>;
    /** Report whether the card renders live output; hidden cards keep history but skip streaming. */
    setVisible(id: string, visible: boolean): void;
    /** With `id`, only that session's output (one context-bridge call per batch instead of one per card). */
    onData(listener: (event: TerminalDataEvent) => void, id?: string): () => void;
    onSession(listener: (event: SessionEvent) => void): () => void;
    onRemoved(listener: (event: SessionRemovedEvent) => void): () => void;
    /** Neutralize (remove the reported keys, disable the hooks) or keep what a git risk report found. */
    resolveGitRisk(reportId: string, action: "neutralize" | "keep"): Promise<void>;
    /** A git risk report about a card that was closed (a live card carries its own on SessionMetadata.gitRisk). */
    onGitRisk(listener: (report: GitRiskReport) => void): () => void;
  };
  window: {
    isMacOS: boolean;
    /** The operating system (process.platform); the launcher uses it to know whether agent isolation exists here. */
    platform: string;
    onOpenUpdates(listener: () => void): () => void;
    minimize(): void;
    toggleMaximize(): Promise<WindowState>;
    close(): void;
    getState(): Promise<WindowState>;
    onState(listener: (state: WindowState) => void): () => void;
  };
}

export const IPC = {
  diagnosticsConfiguration: "diagnostics:configuration",
  diagnosticsSend: "diagnostics:send",
  diagnosticsRendererError: "diagnostics:renderer-error",
  clipboardRead: "clipboard:read",
  clipboardHasImage: "clipboard:has-image",
  clipboardWrite: "clipboard:write",
  externalOpenUrl: "external:open-url",
  terminalSetVisible: "terminal:set-visible",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsChanged: "settings:changed",
  terminalBorderSkinsList: "terminal-border-skins:list",
  terminalBorderSkinsGet: "terminal-border-skins:get",
  terminalBorderSkinsChanged: "terminal-border-skins:changed",
  pixelSkinsList: "pixel-skins:list",
  pixelSkinsInstall: "pixel-skins:install",
  pixelSkinsInstallZip: "pixel-skins:install-zip",
  pixelSkinsReadAsset: "pixel-skins:read-asset",
  pixelSkinsChanged: "pixel-skins:changed",
  dialogPickDirectory: "dialog:pick-directory",
  dialogPickMedia: "dialog:pick-media",
  mediaRead: "media:read",
  filesListRoots: "files:list-roots",
  filesRegisterRoot: "files:register-root",
  filesOpenFolder: "files:open-folder",
  filesList: "files:list",
  filesRead: "files:read",
  filesSearch: "files:search",
  filesCloseRoot: "files:close-root",
  materialsSnapshot: "materials:snapshot",
  materialsAddPaths: "materials:add-paths",
  materialsPick: "materials:pick",
  materialsPaste: "materials:paste",
  materialsSetBounds: "materials:set-bounds",
  materialsSetBoundsBatch: "materials:set-bounds-batch",
  materialsRemove: "materials:remove",
  materialsPinVersion: "materials:pin-version",
  materialsReveal: "materials:reveal",
  materialsRelink: "materials:relink",
  materialsAcceptMove: "materials:accept-move",
  materialsAddRemark: "materials:add-remark",
  materialsUpdateRemark: "materials:update-remark",
  materialsDeleteRemark: "materials:delete-remark",
  materialsChanged: "materials:changed",

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
  pluginsSetNativeCodeTrusted: "plugins:set-native-code-trusted",
  pluginsSetDecisionsMayAllow: "plugins:set-decisions-may-allow",
  pluginsServiceReport: "plugins:service-report",
  pluginsServiceRequest: "plugins:service-request",
  pluginsServiceEvent: "plugins:service-event",
  pluginsCardDecorations: "plugins:card-decorations",
  pluginsCardDecorationsChanged: "plugins:card-decorations-changed",
  pluginsInvokeCardAction: "plugins:invoke-card-action",
  pluginsLaunchFieldOptions: "plugins:launch-field-options",
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
  updateStatus: "update:status",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  updateChanged: "update:changed",
  windowOpenUpdates: "window:open-updates",
  githubAuthStatus: "github-auth:status",
  githubAuthStart: "github-auth:start",
  githubAuthSignOut: "github-auth:sign-out",
  githubAuthOpenUrl: "github-auth:open-url",
  terminalList: "terminal:list",
  terminalOpenFile: "terminal:open-file",
  terminalReadBuffer: "terminal:read-buffer",
  terminalCreate: "terminal:create",
  agentsAvailability: "agents:availability",
  agentsRecheck: "agents:recheck",
  agentChatHistoryList: "agent-chat-history:list",
  agentChatHistoryProviders: "agent-chat-history:providers",
  agentChatHistoryResume: "agent-chat-history:resume",
  terminalRestart: "terminal:restart",
  terminalInput: "terminal:input",
  terminalResize: "terminal:resize",
  terminalBounds: "terminal:bounds",
  terminalRename: "terminal:rename",
  terminalSetRestore: "terminal:set-restore",
  terminalDispose: "terminal:dispose",
  terminalData: "terminal:data",
  /** Main -> renderer: the TerminalDataEvents of one output flush, in order (see TerminalRendererOutbox). */
  terminalDataBatch: "terminal:data-batch",
  terminalSession: "terminal:session",
  terminalRemoved: "terminal:removed",
  terminalGitRisk: "terminal:git-risk",
  terminalResolveGitRisk: "terminal:resolve-git-risk",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  windowGetState: "window:get-state",
  windowState: "window:state"
} as const;
