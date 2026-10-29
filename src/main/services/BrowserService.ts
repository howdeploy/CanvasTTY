import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  app,
  BrowserWindow,
  nativeImage,
  screen,
  session,
  View,
  WebContentsView
} from "electron";
import type { DownloadItem, NavigationEntry, Session, WebContents, WebPreferences } from "electron";
import type {
  AgentPresenceSnapshot,
  BrowserActivityEvent,
  BrowserActor,
  BrowserCanvasPointerEvent,
  BrowserCommand,
  BrowserDialogSnapshot,
  BrowserDownloadSnapshot,
  BrowserDownloadStatus,
  BrowserResult,
  BrowserSnapshot,
  BrowserTabSnapshot,
  BrowserTabStatus,
  BrowserViewportBounds,
  CanvasWheelCaptureMode
} from "../../shared/contracts.ts";
import { IPC } from "../../shared/contracts.ts";
import { AgentRegistry } from "./browser/AgentRegistry.ts";
import type { CanvasNavigationInputController } from "./CanvasNavigationOverride.ts";
import { BrowserAutomationService, type BrowserPointerResult } from "./browser/BrowserAutomationService.ts";
import {
  BrowserCanvasCursorController,
  browserCanvasNavigationCursor
} from "./browser/BrowserCanvasCursor.ts";
import { BrowserCanvasGestureController } from "./browser/BrowserCanvasGestureController.ts";
import { BrowserCanvasPointerRouter } from "./browser/BrowserCanvasPointerRouter.ts";
import { BrowserCanvasSinkViewportController } from "./browser/BrowserCanvasSinkViewport.ts";
import { BrowserAuditStore } from "./browser/BrowserAuditStore.ts";
import { browserPageWheelReply, type BrowserPageWheelReply } from "./browser/BrowserCanvasWheel.ts";
import { browserCanvasEventToCss, clipBrowserViewportBounds, normalizeBrowserViewportBounds, sameBrowserViewport } from "./browser/BrowserViewport.ts";
import { BrowserCore, type BrowserCoreHost, type BrowserCoreTab, type BrowserOpenedTab } from "./browser/BrowserCore.ts";
import { BrowserEngineTabs, type BrowserEngineProvider } from "./browser/BrowserEngineTabs.ts";
import type { EngineFallbackReason } from "./browser/BrowserErrors.ts";
import { CHROMIUM_ENGINE } from "./browser/TabDriver.ts";
import { BrowserKernelError } from "./browser/BrowserErrors.ts";
import { NativeViewSync } from "./browser/NativeViewSync.ts";
import {
  BrowserTabLifecycle,
  type TabLifecycleOptions,
  type TabLifecycleState
} from "./browser/BrowserTabLifecycle.ts";
import {
  BrowserPolicyService,
  DEFAULT_BROWSER_URL,
  isSafeBrowserUrl,
  MAX_BROWSER_TABS
} from "./browser/BrowserPolicyService.ts";
import {
  BrowserStore,
  activeTabAmong,
  type PersistedBrowserState,
  type PersistedBrowserTab
} from "./browser/BrowserStore.ts";

const BROWSER_PARTITION = "persist:canvastty-browser";
const MAX_DOWNLOAD_HISTORY = 100;
const MAX_FAVICON_BYTES = 256 * 1024;
const HUMAN_ACTOR: BrowserActor = { kind: "human", connectionId: "canvastty-renderer" };
/** A sleeping tab's card picture: small enough to ride along in every browser state update. */
const SLEEP_PREVIEW_MAX_WIDTH = 480;
const SLEEP_PREVIEW_JPEG_QUALITY = 60;
/** Waits bounded so a stuck page cannot hold a tab's lifecycle queue (and the commands behind it). */
const SLEEP_CAPTURE_TIMEOUT_MS = 2_000;
const WAKE_LOAD_TIMEOUT_MS = 10_000;
/** How long a tab that moved from a contributed engine to Chromium may load before the command runs anyway. */
const ENGINE_FALLBACK_LOAD_TIMEOUT_MS = 15_000;
/** A background tab has never been shown and has no size; screenshots and layout need one. */
const BACKGROUND_TAB_SIZE = { width: 1280, height: 800 };

// Mirrors the `.browser-card { border-radius: 17px }` declaration in src/renderer/src/styles/app.css: the
// stylesheet owns this visual property, so the two have to stay in sync by hand.
const CARD_CORNER_RADIUS = 17;
// Bound the native corner radius even when renderer zoom multiplies the canvas scale.
const MAX_PAGE_CORNER_RADIUS = CARD_CORNER_RADIUS * 3;

/** Card corner radius in device-independent pixels at the current canvas scale. */
function pageCornerRadius(canvasScale: number | undefined): number {
  const scale = typeof canvasScale === "number" && Number.isFinite(canvasScale) ? canvasScale : 1;
  return Math.max(0, Math.min(MAX_PAGE_CORNER_RADIUS, Math.round(CARD_CORNER_RADIUS * scale)));
}

interface BrowserTab {
  id: string;
  view: WebContentsView;
  loading: boolean;
  status: BrowserTabStatus;
  documentRevision: number;
  crashState: string | null;
  favicon: string | null;
  lastSafeUrl: string;
  canvasCursor: BrowserCanvasCursorController;
  canvasSinkViewport: BrowserCanvasSinkViewportController;
  /** Mirrors `view.setVisible` so background throttling can be recomputed without an Electron getter. */
  visible: boolean;
  /** Paused by the hidden-tab lifecycle (CDP Page.setWebLifecycleState frozen). */
  frozen: boolean;
  /** Between media-started-playing and media-paused: a playing tab is never paused. */
  mediaPlaying: boolean;
  /** Set while the tab sleeps: its WebContents is closed and this is what brings it back. */
  sleeping: SleepingTab | null;
}

interface SleepingTab {
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Back/forward history with each entry's page state (scroll position, form state), for navigationHistory.restore. */
  entries: NavigationEntry[];
  index: number;
  preview: string | null;
}

interface DownloadWaiter {
  tabId: string | null;
  startedAt: number;
  resolve(value: BrowserDownloadSnapshot): void;
  reject(error: unknown): void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface BrowserServiceOptions {
  userDataPath?: string;
  /** A separate in-memory session for an additional macOS browser window. */
  sessionPartition?: string;
  downloadRoot?: string;
  uploadRoots?: readonly string[];
  restoreTabs?: boolean;
  canvasWheelCaptureMode?: CanvasWheelCaptureMode;
  now?: () => number;
  canvasNavigationInput?: CanvasNavigationInputController;
  /** "Pause hidden browser tabs": freeze hidden tabs after a while and put long-hidden ones to sleep. */
  pauseHiddenTabs?: boolean;
  /** Timing overrides for the hidden-tab lifecycle (measurements and smoke runs). */
  tabLifecycle?: Pick<TabLifecycleOptions, "freezeAfterMs" | "discardAfterMs" | "maxLiveHiddenTabs">;
  /** Plugin-contributed browser engines for agents' background tabs (`browser:engine`). */
  engines?: BrowserEngineHost;
}

/** How BrowserService reaches the plugin services that contribute browser engines. */
export interface BrowserEngineHost {
  providers(): BrowserEngineProvider[];
  openTab(provider: BrowserEngineProvider, tabId: string): Promise<unknown>;
  closeTab(provider: BrowserEngineProvider, tabId: string): void;
}

export class BrowserService {
  readonly core: BrowserCore;
  private readonly sessionPartition: string;
  private readonly downloadListener = (event: Electron.Event, item: DownloadItem, contents: WebContents): void => this.onDownload(event, item, contents);
  private readonly getOwner: () => BrowserWindow | null;
  private readonly now: () => number;
  private readonly canvasNavigationInput: CanvasNavigationInputController | null;
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly store: BrowserStore;
  private readonly policy: BrowserPolicyService;
  private readonly audit: BrowserAuditStore;
  private readonly busyAutomationTabs = new Set<string>();
  private readonly lifecycle: BrowserTabLifecycle;
  /** Sleeping tabs a show has already asked to wake, so a burst of view syncs asks once. */
  private readonly wakingTabs = new Set<string>();
  private readonly automation = new BrowserAutomationService(
    (tabId, busy) => this.setTabAutomationBusy(tabId, busy),
    {
      beforeCommand: async (tabId) => { await this.lifecycle.ensureLive(tabId); },
      captureSurface: async (tabId) => this.lendCaptureSurface(tabId)
    }
  );
  private readonly agents: AgentRegistry;
  /** Agents' background tabs in plugin-contributed engines: no view, never shown, never saved. */
  private readonly engineTabs: BrowserEngineTabs;
  private readonly canvasGestures: BrowserCanvasGestureController;
  private readonly canvasPointers: BrowserCanvasPointerRouter;
  private readonly clipView = new View();
  /** Every bounds, visibility, corner and throttling change of the native views goes through here. */
  private readonly native = new NativeViewSync();
  private readonly readyPromise: Promise<void>;
  private readonly downloadWaiters = new Set<DownloadWaiter>();
  private readonly observedOwners = new WeakSet<BrowserWindow>();
  private browserSession: Session | null = null;
  private browserPagePreloadId: string | null = null;
  private activeTabId: string | null = null;
  private viewport: BrowserViewportBounds = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    surface: "hidden",
    showAgentPresence: false
  };
  private persisted: PersistedBrowserState = { version: 1, tabs: [], activeTabId: null };
  private downloads: BrowserDownloadSnapshot[] = [];
  private readonly pendingDialogs = new Map<string, BrowserDialogSnapshot>();
  private visible = false;
  private disposed = false;
  private restoreTabsEnabled: boolean;
  private clipOwnerId: number | null = null;
  private clipTabId: string | null = null;
  /** Background tabs whose view is in the window only for a screenshot (lendCaptureSurface). */
  private readonly lentTabs = new Set<string>();
  private pointerTabId: string | null = null;
  private presenceWindow: BrowserWindow | null = null;
  private presenceWindowReady: Promise<void> | null = null;

  constructor(getOwner: () => BrowserWindow | null, options: BrowserServiceOptions = {}) {
    this.getOwner = getOwner;
    this.sessionPartition = process.platform === "darwin" && options.sessionPartition ? options.sessionPartition : BROWSER_PARTITION;
    this.now = options.now ?? Date.now;
    this.canvasNavigationInput = options.canvasNavigationInput ?? null;
    const userDataPath = options.userDataPath ?? app.getPath("userData");
    const downloadRoot = join(options.downloadRoot ?? join(app.getPath("downloads"), "CanvasTTY"), randomUUID());
    this.restoreTabsEnabled = options.restoreTabs ?? true;
    this.lifecycle = new BrowserTabLifecycle({
      freezeBlocker: (tabId) => this.freezeBlocker(tabId),
      discardBlocker: (tabId) => this.discardBlocker(tabId),
      freeze: (tabId) => this.freezeTab(tabId),
      resume: (tabId) => this.resumeTab(tabId),
      discard: (tabId) => this.sleepTab(tabId),
      restore: (tabId) => this.wakeTab(tabId),
      stateChanged: (tabId, state) => this.lifecycleChanged(tabId, state)
    }, {
      enabled: options.pauseHiddenTabs ?? true,
      resumePendingFreezeOnDisable: process.platform === "darwin",
      ...options.tabLifecycle
    });
    this.store = new BrowserStore(userDataPath);
    this.policy = new BrowserPolicyService({
      downloadRoot,
      uploadRoots: [downloadRoot, ...(options.uploadRoots ?? [])],
      uploadStagingRoot: join(userDataPath, "browser", "upload-staging", randomUUID())
    });
    this.audit = new BrowserAuditStore(userDataPath, { now: this.now });
    // Presence that stopped heartbeating expires on its own; the timer runs only while an agent is present.
    this.agents = new AgentRegistry(this.now, { onExpired: () => this.presenceChanged() });
    const engines = options.engines;
    this.engineTabs = new BrowserEngineTabs({
      automation: this.automation,
      providers: () => engines?.providers() ?? [],
      openEngineTab: (provider, tabId) => engines
        ? engines.openTab(provider, tabId)
        : Promise.reject(new Error("No browser engine is installed.")),
      closeEngineTab: (provider, tabId) => engines?.closeTab(provider, tabId),
      openChromiumTab: (tabId, url, revision, openOptions) => this.openBackgroundChromiumTab(tabId, url, revision, openOptions),
      changed: () => {
        if (!this.disposed) this.emit();
      },
      now: this.now
    });
    this.canvasGestures = new BrowserCanvasGestureController({
      getOwner: () => this.getOwner(),
      getViewport: () => this.viewport,
      getActiveTab: () => this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null,
      getTab: (tabId) => this.tabs.get(tabId),
      isVisible: () => this.visible,
      isDisposed: () => this.disposed,
      getOverrideState: () => ({
        wheelActive: this.canvasNavigationInput?.wheelActive ?? false,
        navigationActive: this.canvasNavigationInput?.active ?? false
      }),
      getCursorScreenPoint: () => screen.getCursorScreenPoint(),
      requestSurfaceSync: () => this.syncViews(),
      beforeSequenceEnd: () => this.canvasPointers.cancelSequenceRelays(),
      shouldDeferIdleEnd: () => this.canvasPointers.hasFreezePointerRelay,
      sendWheel: (payload) => {
        const owner = this.getOwner();
        if (owner && !owner.isDestroyed()) owner.webContents.send(IPC.browserCanvasWheel,
          browserCanvasEventToCss(payload, owner.webContents.getZoomFactor()));
      },
      sendFreezeFrame: (payload) => {
        const owner = this.getOwner();
        if (owner && !owner.isDestroyed()) owner.webContents.send(IPC.browserCanvasFreezeFrame, payload);
      }
    }, {
      captureMode: options.canvasWheelCaptureMode ?? "key",
      now: this.now
    });
    this.canvasPointers = new BrowserCanvasPointerRouter({
      getOwner: () => this.getOwner(),
      getViewport: () => this.viewport,
      getTab: (tabId) => this.tabs.get(tabId),
      getTabs: () => this.tabs.values(),
      getNativeWheelSink: () => this.canvasGestures.activeNativeSink,
      getFrozenTabId: () => this.canvasGestures.frozenTabId,
      isFreezeActive: () => this.canvasGestures.isFreezeActive,
      isNavigationOverrideActive: () => this.canvasNavigationInput?.active ?? false,
      ownsNavigationMouseButton: (button) => (
        this.canvasNavigationInput?.ownsNavigationMouseButton(button) ?? false
      ),
      getCursorScreenPoint: () => screen.getCursorScreenPoint(),
      endWheelSequence: () => this.canvasGestures.endSequence(),
      sendNavigationPointer: (payload) => {
        const owner = this.getOwner();
        if (owner && !owner.isDestroyed()) owner.webContents.send(IPC.browserCanvasNavigationPointer,
          browserCanvasEventToCss(payload, owner.webContents.getZoomFactor()));
      }
    });

    const host: BrowserCoreHost = {
      getSnapshot: () => this.getState(),
      getTab: (tabId) => this.coreTab(tabId),
      ensureRuntime: () => this.ensureRuntime(),
      newTab: (url) => this.hostNewTab(url),
      openTab: (url, openOptions) => this.hostOpenTab(url, openOptions),
      tabEngine: (tabId) => this.engineTabs.engineOf(tabId) ?? (this.tabs.has(tabId) ? CHROMIUM_ENGINE : null),
      moveTabToChromium: (tabId, reason) => this.moveTabToChromium(tabId, reason),
      closeTab: (tabId) => this.hostCloseTab(tabId),
      activateTab: (tabId) => this.hostActivateTab(tabId),
      navigateTab: (tabId, url) => this.hostNavigate(tabId, url),
      back: (tabId) => this.hostBack(tabId),
      forward: (tabId) => this.hostForward(tabId),
      reload: (tabId) => this.hostReload(tabId),
      pendingDialog: (tabId) => this.pendingDialog(tabId),
      waitForDownload: (tabId, timeoutMs, signal) => this.waitForDownload(tabId, timeoutMs, signal),
      touchActor: (actor, tabId, cursor) => this.touchActor(actor, tabId, cursor),
      heartbeatActor: (actor, timestamp) => this.heartbeatActor(actor, timestamp),
      disconnectActor: (actor) => this.disconnectActor(actor),
      prepareTab: (tabId) => this.lifecycle.ensureLive(tabId)
    };
    this.core = new BrowserCore({
      host,
      automation: this.automation,
      policy: this.policy,
      audit: this.audit,
      onActivity: (event) => this.emitActivity(event)
    });
    this.readyPromise = this.initialize();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  getState(): BrowserSnapshot {
    const agentValues = this.agents.snapshot();
    const runtimeTabs = [...this.tabs.values()];
    const tabs = [
      ...runtimeTabs.length > 0
        ? runtimeTabs.map((tab) => this.tabSnapshot(tab, agentValues))
        : this.persisted.tabs.map((tab) => this.persistedTabSnapshot(tab, agentValues)),
      ...this.engineTabs.snapshots(agentValues)
    ];
    return {
      tabs,
      activeTabId: runtimeTabs.length > 0 ? this.activeTabId : this.persisted.activeTabId,
      visible: this.visible,
      agents: agentValues,
      downloads: this.downloads.map((download) => structuredClone(download)),
      pendingDialog: this.visibleDialog()
    };
  }

  async open(url?: string): Promise<BrowserSnapshot> {
    await this.ensureRuntime();
    this.visible = true;
    if (this.tabs.size === 0) return this.newTab(url);
    if (url && this.activeTabId) return this.navigate(this.activeTabId, url);
    this.syncViews();
    this.emit();
    return this.getState();
  }

  async close(): Promise<void> {
    await this.readyPromise;
    if (this.disposed) return;
    await this.persistRuntime();
    this.canvasPointers.cancelNavigationGesture();
    this.invalidateCanvasSequence(false);
    this.canvasGestures.setInputFocused(false);
    this.visible = false;
    this.hideClipView();
    this.destroyPresenceWindow();
    this.emit();
  }

  focus(): void {
    if (!this.visible || this.viewport.surface !== "native" || !this.activeTabId) return;
    const owner = this.getOwner();
    if (!owner || owner.isDestroyed() || !owner.isFocused()) return;
    const active = this.tabs.get(this.activeTabId);
    if (!active || active.view.webContents.isDestroyed()) return;
    active.view.webContents.focus();
  }

  setInputFocused(focused: boolean): void {
    this.canvasGestures.setInputFocused(focused);
  }

  setCanvasWheelCaptureMode(mode: CanvasWheelCaptureMode): void {
    this.canvasGestures.setCaptureMode(mode);
  }

  ownsPage(sender: WebContents): boolean {
    return [...this.tabs.values()].some((tab) => tab.view.webContents === sender);
  }

  decidePageWheel(sender: WebContents, input: unknown): BrowserPageWheelReply {
    return browserPageWheelReply(this.canvasGestures.decidePageWheel(sender, input));
  }

  handlePageWheel(sender: WebContents, input: unknown): void {
    this.canvasGestures.handlePageWheel(sender, input);
  }

  beginRendererWheelSequence(input: unknown, rendererZoomFactor = 1): void {
    this.canvasGestures.beginRendererSequence(input, rendererZoomFactor);
  }

  async setRestoreTabs(enabled: boolean): Promise<void> {
    await this.readyPromise;
    this.restoreTabsEnabled = enabled;
    if (enabled) await this.persistRuntime();
    else {
      await this.clearSavedTabs();
    }
  }

  setPauseHiddenTabs(enabled: boolean): void {
    this.lifecycle.setEnabled(enabled);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.readyPromise.catch(() => undefined);
    this.disposed = true;
    this.lifecycle.dispose();
    const draining = this.core.shutdown();
    await this.persistRuntime().catch(() => undefined);
    this.visible = false;
    this.canvasGestures.setInputFocused(false);
    this.canvasGestures.endSequence(false);
    this.canvasGestures.clear();
    this.agents.dispose();
    this.engineTabs.dispose();
    this.destroyRuntimeTabs();
    if (this.browserSession && this.browserPagePreloadId) {
      this.browserSession.unregisterPreloadScript(this.browserPagePreloadId);
      this.browserPagePreloadId = null;
    }
    if (process.platform === "darwin" && this.browserSession) {
      this.browserSession.removeListener("will-download", this.downloadListener);
      this.browserSession.setPermissionCheckHandler(null);
      this.browserSession.setPermissionRequestHandler(null);
      this.browserSession.setDevicePermissionHandler(null);
    }
    this.hideClipView();
    this.destroyPresenceWindow();
    for (const waiter of this.downloadWaiters) {
      this.cleanupDownloadWaiter(waiter);
      waiter.reject(new BrowserKernelError("BRIDGE_UNAVAILABLE", "Browser service is shutting down."));
    }
    await Promise.allSettled([draining, this.policy.clearStagedUploads()]);
  }

  async closeAllTabs(): Promise<BrowserSnapshot> {
    await this.readyPromise;
    for (const id of [...this.getState().tabs.map((tab) => tab.id)]) await this.closeTab(id);
    return this.getState();
  }

  async newTab(url = DEFAULT_BROWSER_URL): Promise<BrowserSnapshot> {
    const normalized = this.policy.normalizeHumanInput(url);
    return this.snapshotResult(await this.executeHuman({
      type: "browser_new_tab",
      requestId: randomUUID(),
      url: normalized
    }));
  }

  async selectTab(id: string): Promise<BrowserSnapshot> {
    return this.snapshotResult(await this.executeHuman({
      type: "browser_activate_tab",
      requestId: randomUUID(),
      tabId: id
    }));
  }

  async closeTab(id: string): Promise<BrowserSnapshot> {
    return this.snapshotResult(await this.executeHuman({
      type: "browser_close_tab",
      requestId: randomUUID(),
      tabId: id
    }));
  }

  async navigate(id: string, value: string): Promise<BrowserSnapshot> {
    return this.snapshotResult(await this.executeHuman({
      type: "browser_navigate",
      requestId: randomUUID(),
      tabId: id,
      url: this.policy.normalizeHumanInput(value)
    }));
  }

  async back(id: string): Promise<BrowserSnapshot> {
    return this.snapshotResult(await this.executeHuman({
      type: "browser_back",
      requestId: randomUUID(),
      tabId: id
    }));
  }

  async forward(id: string): Promise<BrowserSnapshot> {
    return this.snapshotResult(await this.executeHuman({
      type: "browser_forward",
      requestId: randomUUID(),
      tabId: id
    }));
  }

  async reload(id: string): Promise<BrowserSnapshot> {
    return this.snapshotResult(await this.executeHuman({
      type: "browser_reload",
      requestId: randomUUID(),
      tabId: id
    }));
  }

  executeHuman(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
    return this.core.execute(HUMAN_ACTOR, command, signal);
  }

  getActivity(sinceSequence = 0): BrowserActivityEvent[] {
    return this.core.getActivity(sinceSequence);
  }

  async clearData(): Promise<BrowserSnapshot> {
    await this.readyPromise;
    await this.closeAllTabs();
    const browserSession = this.requireSession();
    await Promise.all([
      browserSession.clearStorageData(),
      browserSession.clearCache(),
      browserSession.clearAuthCache(),
      this.policy.clearStagedUploads()
    ]);
    this.downloads = [];
    this.pendingDialogs.clear();
    await this.clearSavedTabs();
    if (this.visible) return this.newTab();
    this.emit();
    return this.getState();
  }

  setViewport(bounds: BrowserViewportBounds, rendererZoomFactor = 1): void {
    const normalized = normalizeBrowserViewportBounds(bounds, rendererZoomFactor);
    if (!normalized) return;
    const previous = this.viewport;
    // The card reports its rectangle on every camera step, resize and layout pass; one that rounds to the same
    // placement changes nothing (the window's own moves and resizes resync on their own). A hidden report always
    // runs, since it also ends any gesture in progress.
    if (normalized.surface !== "hidden" && sameBrowserViewport(previous, normalized)) return;
    this.viewport = normalized;
    if (normalized.surface === "hidden") {
      this.canvasPointers.cancelNavigationGesture();
    }
    this.canvasGestures.viewportChanged(previous, normalized);
    this.syncViews();
  }

  setCanvasNavigationActive(active: boolean): void {
    this.canvasPointers.setNavigationActive(active);
  }

  setRendererCanvasGestureActive(active: boolean): void {
    this.canvasPointers.setRendererGestureActive(active);
  }

  cancelCanvasNavigationGesture(): void {
    this.canvasPointers.cancelNavigationGesture();
  }

  setAgentPresences(values: readonly AgentPresenceSnapshot[]): void {
    this.agents.replace(values);
    this.presenceChanged();
  }

  private async initialize(): Promise<void> {
    this.persisted = await this.store.load();
    if (!this.restoreTabsEnabled) await this.clearSavedTabs();
    this.activeTabId = this.persisted.activeTabId;
    await mkdir(this.policy.downloadRoot, { recursive: true });
    this.configureSession();
  }

  private async ensureRuntime(): Promise<void> {
    await this.readyPromise;
    if (this.disposed) throw new BrowserKernelError("BRIDGE_UNAVAILABLE", "Browser service is disposed.");
    this.requireOwner();
    this.visible = true;
    for (const [id, tab] of this.tabs) {
      if (tab.sleeping || !tab.view.webContents.isDestroyed()) continue;
      // Keep the crashed tab's identity and latest URL until reload can replace its WebContents.
      // BrowserCore also calls ensureRuntime before dispatching reload, so recovery must survive it.
      if (process.platform === "darwin" && tab.status === "crashed") continue;
      this.automation.unregister(id);
      this.tabs.delete(id);
    }
    // A destroyed active tab must not leave the active slot pointing at nothing while other tabs are open.
    this.activeTabId = activeTabAmong(this.tabs, this.activeTabId);
    if (this.tabs.size === 0 && this.persisted.tabs.length > 0) {
      for (const saved of this.persisted.tabs.slice(0, MAX_BROWSER_TABS)) {
        const tab = this.createRuntimeTab(saved.id, saved.url);
        void this.loadTab(tab, saved.url);
      }
      this.activeTabId = this.persisted.tabs.some((tab) => tab.id === this.persisted.activeTabId)
        ? this.persisted.activeTabId
        : this.tabs.keys().next().value ?? null;
    }
    this.syncViews();
  }

  private coreTab(tabId: string): BrowserCoreTab | null {
    const engineTab = this.engineTabs.coreTab(tabId);
    if (engineTab) return engineTab;
    const tab = this.tabs.get(tabId);
    if (tab) {
      return { id: tab.id, url: this.tabUrl(tab), documentRevision: tab.documentRevision, status: tab.status };
    }
    const saved = this.persisted.tabs.find((candidate) => candidate.id === tabId);
    return saved ? { id: saved.id, url: saved.url, documentRevision: 0, status: "ready" } : null;
  }

  /**
   * An agent's tab goes to a contributed engine when `choose` picks one: it opens in the background and the active tab
   * stays. If the engine cannot open it, or none applies, it is a normal Chromium tab (made active, as always).
   */
  private async hostOpenTab(url: string, options: { engine?: string; actor: BrowserActor }): Promise<BrowserOpenedTab> {
    const choice = this.engineTabs.choose({ engine: options.engine, actor: options.actor, url });
    if (choice.provider) {
      await this.ensureRuntime();
      if (this.tabs.size + this.engineTabs.size >= MAX_BROWSER_TABS) {
        throw new BrowserKernelError("RATE_LIMITED", `Browser tab limit is ${MAX_BROWSER_TABS}.`);
      }
      const normalized = this.policy.assertNavigationUrl(url);
      try {
        const tabId = await this.engineTabs.open(choice.provider, normalized);
        return { snapshot: this.getState(), tabId, engine: choice.provider.engineId };
      } catch (error) {
        console.warn("CanvasTTY browser engine could not open a tab; using Chromium.", error);
        const snapshot = await this.hostNewTab(url);
        return {
          snapshot,
          tabId: snapshot.activeTabId,
          engine: CHROMIUM_ENGINE,
          ...(options.engine && options.engine !== "auto"
            ? { notice: `Browser engine "${choice.provider.engineId}" could not open the tab; it opened in Chromium.` }
            : {})
        };
      }
    }
    const snapshot = await this.hostNewTab(url);
    return { snapshot, tabId: snapshot.activeTabId, engine: CHROMIUM_ENGINE, ...(choice.notice ? { notice: choice.notice } : {}) };
  }

  private async moveTabToChromium(tabId: string, reason: EngineFallbackReason): Promise<void> {
    await this.ensureRuntime();
    await this.engineTabs.moveToChromium(tabId, reason, { waitForLoad: reason !== "revealed" });
  }

  /**
   * The Chromium tab a contributed engine's tab continues in: same id, the given revision, not activated. It gets the
   * size of a normal page (it was never on screen) so layout and screenshots work while it stays hidden.
   */
  private async openBackgroundChromiumTab(
    tabId: string,
    url: string,
    revision: number,
    options: { waitForLoad: boolean }
  ): Promise<void> {
    if (this.disposed) throw new BrowserKernelError("BRIDGE_UNAVAILABLE", "Browser service is disposed.");
    const normalized = this.policy.assertNavigationUrl(url);
    const tab = this.createRuntimeTab(tabId, normalized, revision);
    this.native.setBounds(tab.view, {
      x: 0,
      y: 0,
      width: Math.max(BACKGROUND_TAB_SIZE.width, Math.round(this.viewport.width)),
      height: Math.max(BACKGROUND_TAB_SIZE.height, Math.round(this.viewport.height))
    });
    await this.persistRuntime();
    this.syncViews();
    this.emit();
    const loading = this.loadTab(tab, normalized);
    if (!options.waitForLoad) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      loading,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ENGINE_FALLBACK_LOAD_TIMEOUT_MS);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * A screenshot of a background tab (an agent's tab, or one that moved from a contributed engine) while the person
   * looks elsewhere. Chromium paints a view only while some of it lies inside a shown window; a view that is hidden,
   * in no window, or entirely outside it gives an empty capture. So for the capture the tab's view, at its page size,
   * is put in the window with only its top-left pixel inside the window's bottom-right corner, under a one-pixel
   * cover in the window's background color, and taken out right after: the whole page is painted and captured, and
   * the person sees nothing. The clip view's own tab (the active tab while its card is off-screen) is not lent: its
   * page stays hidden while it is busy, and the answer asks for the card to be brought into view as before.
   */
  private async lendCaptureSurface(tabId: string): Promise<(() => void) | null> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.visible || tab.sleeping || tab.view.webContents.isDestroyed() || this.clipTabId === tab.id) return null;
    const owner = this.getOwner();
    if (!owner || owner.isDestroyed()) return null;
    const [contentWidth, contentHeight] = owner.getContentSize();
    if (!contentWidth || !contentHeight) return null;
    const current = tab.view.getBounds();
    const width = current.width > 0 ? current.width : Math.max(BACKGROUND_TAB_SIZE.width, Math.round(this.viewport.width));
    const height = current.height > 0 ? current.height : Math.max(BACKGROUND_TAB_SIZE.height, Math.round(this.viewport.height));
    this.lentTabs.add(tab.id);
    owner.contentView.addChildView(tab.view);
    this.native.setBounds(tab.view, { x: contentWidth - 1, y: contentHeight - 1, width, height });
    this.native.setVisible(tab.view, true);
    const cover = new View();
    cover.setBackgroundColor(owner.getBackgroundColor() || "#000000");
    owner.contentView.addChildView(cover);
    cover.setBounds({ x: contentWidth - 1, y: contentHeight - 1, width: 1, height: 1 });
    return () => {
      this.lentTabs.delete(tab.id);
      if (owner.isDestroyed()) return;
      owner.contentView.removeChildView(cover);
      if (owner.contentView.children.includes(tab.view)) owner.contentView.removeChildView(tab.view);
      // Closed, put to sleep, or shown (and mounted in the clip view) meanwhile: syncViews owns it then.
      if (this.disposed || this.tabs.get(tab.id) !== tab || tab.visible || tab.sleeping || tab.view.webContents.isDestroyed()) return;
      this.native.setVisible(tab.view, false);
      this.native.setBounds(tab.view, current.width > 0 ? current : { x: 0, y: 0, width, height });
    };
  }

  private async hostNewTab(url: string): Promise<BrowserSnapshot> {
    await this.ensureRuntime();
    if (this.tabs.size + this.engineTabs.size >= MAX_BROWSER_TABS) {
      throw new BrowserKernelError("RATE_LIMITED", `Browser tab limit is ${MAX_BROWSER_TABS}.`);
    }
    const normalized = this.policy.assertNavigationUrl(url);
    const tab = this.createRuntimeTab(randomUUID(), normalized);
    this.invalidateCanvasSequence(false);
    this.activeTabId = tab.id;
    await this.persistRuntime();
    this.syncViews();
    this.emit();
    void this.loadTab(tab, normalized);
    return this.getState();
  }

  private async hostActivateTab(tabId: string): Promise<BrowserSnapshot> {
    await this.ensureRuntime();
    // A contributed engine's tab is never shown: it becomes a Chromium tab first.
    if (this.engineTabs.has(tabId)) await this.engineTabs.moveToChromium(tabId, "revealed", { waitForLoad: false });
    const tab = this.requireTab(tabId);
    this.canvasPointers.cancelNavigationGesture();
    this.invalidateCanvasSequence(false);
    this.activeTabId = tab.id;
    await this.persistRuntime();
    this.syncViews();
    this.canvasGestures.refreshFrame();
    const owner = this.getOwner();
    if (
      this.viewport.surface === "native"
      && owner
      && !owner.isDestroyed()
      && owner.isFocused()
      && !tab.view.webContents.isDestroyed()
    ) {
      tab.view.webContents.focus();
    }
    this.emit();
    return this.getState();
  }

  private async hostCloseTab(tabId: string): Promise<BrowserSnapshot> {
    await this.ensureRuntime();
    if (this.engineTabs.has(tabId)) {
      this.engineTabs.close(tabId);
      this.pendingDialogs.delete(tabId);
      return this.getState();
    }
    const tab = this.requireTab(tabId);
    if (this.activeTabId === tabId) {
      this.invalidateCanvasSequence(false);
    }
    this.tabs.delete(tabId);
    this.destroyTab(tab);
    this.pendingDialogs.delete(tabId);
    this.activeTabId = activeTabAmong(this.tabs, this.activeTabId);
    await this.persistRuntime();
    this.syncViews();
    this.emit();
    return this.getState();
  }

  private async hostNavigate(tabId: string, url: string): Promise<BrowserSnapshot> {
    await this.ensureRuntime();
    if (this.engineTabs.has(tabId)) {
      await this.engineTabs.navigate(tabId, this.policy.assertNavigationUrl(url));
      return this.getState();
    }
    const tab = this.requireTab(tabId);
    const normalized = this.policy.assertNavigationUrl(url);
    tab.lastSafeUrl = normalized;
    tab.loading = true;
    tab.status = "loading";
    tab.crashState = null;
    // Invalidate observed refs before dispatching Chromium navigation. The
    // did-start-navigation event advances it again, covering reads that race the
    // short interval between dispatch and the actual document transition.
    this.incrementRevision(tab);
    await this.persistRuntime();
    this.emit();
    void this.loadTab(tab, normalized);
    return this.getState();
  }

  private async hostBack(tabId: string): Promise<BrowserSnapshot> {
    await this.ensureRuntime();
    if (this.engineTabs.has(tabId)) {
      await this.engineTabs.history(tabId, -1);
      return this.getState();
    }
    const tab = this.requireTab(tabId);
    if (tab.view.webContents.navigationHistory.canGoBack()) {
      tab.loading = true;
      tab.status = "loading";
      tab.crashState = null;
      this.incrementRevision(tab);
      tab.view.webContents.navigationHistory.goBack();
      this.emit();
    }
    return this.getState();
  }

  private async hostForward(tabId: string): Promise<BrowserSnapshot> {
    await this.ensureRuntime();
    if (this.engineTabs.has(tabId)) {
      await this.engineTabs.history(tabId, 1);
      return this.getState();
    }
    const tab = this.requireTab(tabId);
    if (tab.view.webContents.navigationHistory.canGoForward()) {
      tab.loading = true;
      tab.status = "loading";
      tab.crashState = null;
      this.incrementRevision(tab);
      tab.view.webContents.navigationHistory.goForward();
      this.emit();
    }
    return this.getState();
  }

  private async hostReload(tabId: string): Promise<BrowserSnapshot> {
    await this.ensureRuntime();
    if (this.engineTabs.has(tabId)) {
      await this.engineTabs.reload(tabId);
      return this.getState();
    }
    this.requireTab(tabId);
    // A sleeping tab's wake is a load of its page already; a paused one resumes before it reloads.
    if ((await this.lifecycle.ensureLive(tabId)).reloaded) {
      this.emit();
      return this.getState();
    }
    let tab = this.requireTab(tabId);
    if (tab.view.webContents.isDestroyed()) {
      const url = tab.lastSafeUrl;
      const nextRevision = tab.documentRevision + 1;
      this.destroyTab(tab);
      tab = this.createRuntimeTab(tabId, url, nextRevision);
      void this.loadTab(tab, url);
      if (process.platform === "darwin") this.syncViews();
    } else {
      tab.status = "loading";
      tab.loading = true;
      tab.crashState = null;
      this.incrementRevision(tab);
      tab.view.webContents.reload();
    }
    this.emit();
    return this.getState();
  }

  private createRuntimeTab(
    id: string,
    url: string,
    initialRevision = 0,
    existingContents?: WebContents
  ): BrowserTab {
    const view = existingContents
      ? new WebContentsView({ webContents: existingContents })
      : new WebContentsView({ webPreferences: remoteBrowserWebPreferences(this.sessionPartition) });
    // Electron's `view.webContents` getter returns undefined once the WebContents is closed (a sleeping or destroyed
    // tab), and every `tab.view.webContents.isDestroyed()` check would throw. Pin the object: closed, it still answers.
    Object.defineProperty(view, "webContents", { value: view.webContents, configurable: true, enumerable: true });
    const tab: BrowserTab = {
      id,
      view,
      loading: true,
      status: "loading",
      documentRevision: initialRevision,
      crashState: null,
      favicon: null,
      lastSafeUrl: url,
      canvasCursor: new BrowserCanvasCursorController(view.webContents),
      canvasSinkViewport: new BrowserCanvasSinkViewportController(view.webContents),
      visible: false,
      frozen: false,
      mediaPlaying: false,
      sleeping: null
    };
    this.tabs.set(id, tab);
    this.lifecycle.track(id, false);
    // A reused popup WebContents may already be running unthrottled; recompute from our own state.
    this.applyBackgroundThrottling(tab);
    tab.canvasCursor.set(browserCanvasNavigationCursor(this.canvasNavigationInput?.active ?? false, false));
    this.bindTab(tab);
    void this.automation.register(id, view.webContents, tab.documentRevision, (dialog) => {
      if (dialog && this.tabs.has(id)) this.pendingDialogs.set(id, dialog);
      else if (!dialog) this.pendingDialogs.delete(id);
      this.emit();
    }).catch(() => undefined);
    return tab;
  }

  private bindTab(tab: BrowserTab): void {
    const contents = tab.view.webContents;
    this.canvasNavigationInput?.attach(contents);
    contents.setWindowOpenHandler((details) => {
      const decision = this.policy.popup(details.url, details.disposition, this.tabs.size);
      if (decision.action === "deny" || !decision.url) return { action: "deny" };
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: remoteBrowserWebPreferences(this.sessionPartition)
        },
        createWindow: (options) => {
          // window.open already owns a guest WebContents. Electron requires this
          // callback to return that exact instance, so adopt it into our view.
          const popupContents = (options as typeof options & { webContents?: WebContents }).webContents;
          const child = this.createRuntimeTab(randomUUID(), decision.url!, 0, popupContents);
          if (decision.activate) this.activeTabId = child.id;
          void this.persistRuntime().then(() => {
            this.syncViews();
            this.emit();
          });
          if (!popupContents) void this.loadTab(child, decision.url!);
          return child.view.webContents;
        }
      };
    });
    contents.on("will-navigate", (event, url) => {
      if (!isSafeBrowserUrl(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isSafeBrowserUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("before-mouse-event", (event, mouse) => {
      const nativeSink = this.canvasGestures.activeNativeSink?.tabId === tab.id
        ? this.canvasGestures.activeNativeSink
        : null;
      if ((this.viewport.surface !== "native" && !nativeSink) || this.activeTabId !== tab.id) return;
      const owner = this.getOwner();
      if (!owner || owner.isDestroyed()) return;
      this.canvasGestures.observeBrowserWheel(tab.id, mouse);
      if (this.canvasPointers.handleBrowserMouse(tab, owner, event, mouse)) return;
      if (this.canvasNavigationInput?.ownsAnyMouseButton(mouse.button as string | undefined)) {
        event.preventDefault();
        return;
      }

      const pointerType = mouse.type === "mouseDown" && mouse.button === "left"
        ? "down"
        : mouse.type === "mouseUp" && mouse.button === "left"
          ? "up"
          : mouse.type === "mouseEnter" || (mouse.type === "mouseMove" && this.pointerTabId !== tab.id)
            ? "enter"
            : mouse.type === "mouseLeave"
              ? "leave"
              : null;
      if (pointerType) {
        if (pointerType === "down") {
          contents.focus();
          this.setInputFocused(true);
        }
        this.pointerTabId = pointerType === "leave" ? null : tab.id;
        const payload: BrowserCanvasPointerEvent = {
          tabId: tab.id,
          type: pointerType,
          clientX: this.viewport.x + mouse.x,
          clientY: this.viewport.y + mouse.y,
          clickCount: pointerType === "down" || pointerType === "up" ? Math.max(1, mouse.clickCount ?? 1) : 0
        };
        owner.webContents.send(IPC.browserCanvasPointer, browserCanvasEventToCss(payload, owner.webContents.getZoomFactor()));
      }

    });
    contents.on("login", (event, _details, _authInfo, callback) => {
      event.preventDefault();
      callback();
    });
    contents.on("select-client-certificate", (event, _url, _certificateList, callback) => {
      event.preventDefault();
      (callback as unknown as (certificate?: never) => void)();
    });
    contents.on("did-start-navigation", (_details, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      if (!isInPlace && this.activeTabId === tab.id) {
        this.invalidateCanvasSequence();
      }
      tab.loading = true;
      tab.status = "loading";
      tab.crashState = null;
      if (!isInPlace) this.incrementRevision(tab);
      this.emit();
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      if (tab.status !== "crashed") tab.status = "loading";
      this.emit();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      if (tab.status !== "crashed" && tab.status !== "error") tab.status = "ready";
      if (this.activeTabId === tab.id) this.canvasGestures.refreshFrame();
      this.emit();
    });
    contents.on("did-finish-load", () => tab.canvasCursor.refresh());
    contents.on("media-started-playing", () => { tab.mediaPlaying = true; });
    contents.on("media-paused", () => { tab.mediaPlaying = false; });
    contents.on("did-fail-load", (_event, errorCode, _errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      tab.loading = false;
      tab.status = "error";
      tab.crashState = "load-failed";
      this.emit();
    });
    contents.on("page-title-updated", () => this.emit());
    contents.on("page-favicon-updated", (_event, favicons) => {
      void this.loadFavicon(tab, favicons);
    });
    contents.on("did-navigate", (_event, url) => {
      if (isSafeBrowserUrl(url)) tab.lastSafeUrl = url;
      tab.status = "ready";
      tab.crashState = null;
      this.applyPageScale(tab);
      void this.persistRuntime();
      this.emit();
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (isSafeBrowserUrl(url)) tab.lastSafeUrl = url;
      this.incrementRevision(tab);
      void this.persistRuntime();
      this.emit();
    });
    contents.on("unresponsive", () => {
      tab.status = "error";
      tab.crashState = "unresponsive";
      this.emit();
    });
    contents.on("responsive", () => {
      if (tab.crashState !== "unresponsive") return;
      tab.status = "ready";
      tab.crashState = null;
      this.emit();
    });
    contents.on("render-process-gone", (_event, details) => {
      this.canvasPointers.cancelTab(tab.id);
      if (this.activeTabId === tab.id) {
        this.invalidateCanvasSequence(false);
      }
      tab.loading = false;
      tab.status = "crashed";
      tab.crashState = details.reason;
      this.emit();
    });
    contents.on("destroyed", () => {
      tab.canvasCursor.dispose();
      tab.canvasSinkViewport.dispose();
      this.canvasPointers.cancelTab(tab.id);
      if (this.activeTabId === tab.id) {
        this.invalidateCanvasSequence(false);
      }
      // A closed tab, or one put to sleep (or already woken into a new WebContents), did not crash.
      if (this.tabs.get(tab.id) !== tab || tab.sleeping) return;
      tab.loading = false;
      tab.status = "crashed";
      tab.crashState = "destroyed";
      this.emit();
    });
  }

  private configureSession(): void {
    if (this.browserSession) return;
    const browserSession = session.fromPartition(this.sessionPartition);
    this.browserSession = browserSession;
    this.browserPagePreloadId = browserSession.registerPreloadScript({
      type: "frame",
      filePath: join(__dirname, "../preload/browser.cjs")
    });
    browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => (
      this.policy.permission(permission, requestingOrigin)
    ));
    browserSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(this.policy.permission(permission, contents.getURL()));
    });
    browserSession.setDevicePermissionHandler(() => false);
    browserSession.on("will-download", this.downloadListener);
  }

  private onDownload(
    event: Electron.Event,
    item: DownloadItem,
    contents: WebContents
  ): void {
    const id = randomUUID();
    let savePath: string;
    try {
      savePath = this.policy.resolveDownloadPath(id, item.getFilename());
      item.setSavePath(savePath);
    } catch {
      event.preventDefault();
      return;
    }
    const tabId = [...this.tabs.values()].find((tab) => (
      !tab.view.webContents.isDestroyed() && tab.view.webContents.id === contents.id
    ))?.id ?? null;
    const download: BrowserDownloadSnapshot = {
      id,
      tabId,
      fileName: basename(item.getFilename()).slice(0, 240),
      savePath,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      status: "pending",
      startedAt: this.now(),
      completedAt: null
    };
    this.downloads.push(download);
    if (this.downloads.length > MAX_DOWNLOAD_HISTORY) this.downloads.shift();
    item.on("updated", (_updatedEvent, state) => {
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
      download.status = state === "interrupted" ? "interrupted" : "progressing";
      this.emit();
    });
    item.once("done", (_doneEvent, state) => {
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
      download.status = downloadStatus(state);
      download.completedAt = this.now();
      this.resolveDownloadWaiters(download);
      this.emit();
    });
    this.emit();
  }

  private waitForDownload(
    tabId: string | null,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<BrowserDownloadSnapshot> {
    const startedAt = this.now();
    const recent = [...this.downloads].reverse().find((download) => (
      download.completedAt !== null
      && download.completedAt >= startedAt - 5_000
      && (tabId === null || download.tabId === tabId)
    ));
    if (recent) return Promise.resolve(structuredClone(recent));
    const active = [...this.downloads].reverse().find((download) => (
      download.completedAt === null && (tabId === null || download.tabId === tabId)
    ));
    return new Promise((resolve, reject) => {
      const waiter: DownloadWaiter = {
        tabId,
        startedAt: active?.startedAt ?? startedAt,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.cleanupDownloadWaiter(waiter);
          reject(new BrowserKernelError("TIMEOUT", "Browser download wait timed out.", { retryable: true }));
        }, timeoutMs),
        signal
      };
      waiter.timeout.unref();
      if (signal) {
        waiter.abort = () => {
          this.cleanupDownloadWaiter(waiter);
          reject(new DOMException("Browser download wait was canceled.", "AbortError"));
        };
        if (signal.aborted) return waiter.abort();
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.downloadWaiters.add(waiter);
    });
  }

  private resolveDownloadWaiters(download: BrowserDownloadSnapshot): void {
    for (const waiter of [...this.downloadWaiters]) {
      if (download.startedAt < waiter.startedAt) continue;
      if (waiter.tabId !== null && download.tabId !== waiter.tabId) continue;
      this.cleanupDownloadWaiter(waiter);
      waiter.resolve(structuredClone(download));
    }
  }

  private cleanupDownloadWaiter(waiter: DownloadWaiter): void {
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    this.downloadWaiters.delete(waiter);
  }

  private async loadFavicon(tab: BrowserTab, values: readonly string[]): Promise<void> {
    for (const value of values.slice(0, 4)) {
      try {
        let image;
        if (value.startsWith("data:image/") && value.length <= MAX_FAVICON_BYTES * 2) {
          image = nativeImage.createFromDataURL(value);
        } else if (isSafeBrowserUrl(value) && !tab.view.webContents.isDestroyed()) {
          const response = await tab.view.webContents.session.fetch(value, { credentials: "omit" });
          if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/")) continue;
          const contentLength = Number(response.headers.get("content-length") ?? 0);
          if (contentLength > MAX_FAVICON_BYTES) continue;
          const buffer = await readBoundedResponse(response, MAX_FAVICON_BYTES);
          image = nativeImage.createFromBuffer(buffer);
        } else {
          continue;
        }
        if (!image || image.isEmpty()) continue;
        const size = image.getSize();
        if (size.width > 64 || size.height > 64) image = image.resize({ width: 64, height: 64, quality: "good" });
        const png = image.toPNG();
        if (png.byteLength > MAX_FAVICON_BYTES) continue;
        tab.favicon = `data:image/png;base64,${png.toString("base64")}`;
        this.emit();
        return;
      } catch {
        // Try the next favicon candidate.
      }
    }
  }

  private incrementRevision(tab: BrowserTab): void {
    tab.documentRevision += 1;
    this.automation.updateRevision(tab.id, tab.documentRevision);
  }

  private async loadTab(tab: BrowserTab, url: string): Promise<void> {
    try {
      await tab.view.webContents.loadURL(url);
    } catch {
      if (!this.tabs.has(tab.id)) return;
      tab.loading = false;
      tab.status = "error";
      tab.crashState = "load-failed";
      this.emit();
    }
  }

  private async persistRuntime(): Promise<void> {
    if (!this.restoreTabsEnabled) return;
    const tabs = [...this.tabs.values()]
      .map((tab) => ({ id: tab.id, url: this.tabUrl(tab) }))
      .filter((tab) => isSafeBrowserUrl(tab.url));
    try {
      this.persisted = await this.store.replace(tabs, this.activeTabId);
    } catch (error) {
      // The tabs on screen stay as they are; only the copy restored at the next
      // start is stale. The store already holds the new state in memory.
      this.persisted = this.store.get();
      console.warn("CanvasTTY browser tabs could not be saved.", error);
    }
  }

  private async clearSavedTabs(): Promise<void> {
    try {
      await this.store.clear();
    } catch (error) {
      console.warn("CanvasTTY saved browser tabs could not be cleared.", error);
    }
    this.persisted = this.store.get();
  }

  private destroyRuntimeTabs(): void {
    for (const tab of this.tabs.values()) this.destroyTab(tab);
    this.tabs.clear();
    this.activeTabId = this.persisted.activeTabId;
    this.pendingDialogs.clear();
  }

  private destroyTab(tab: BrowserTab): void {
    this.lifecycle.untrack(tab.id);
    this.lentTabs.delete(tab.id);
    this.wakingTabs.delete(tab.id);
    this.canvasPointers.cancelTab(tab.id);
    if (this.activeTabId === tab.id) {
      this.invalidateCanvasSequence(false);
    }
    tab.canvasCursor.dispose();
    tab.canvasSinkViewport.dispose();
    this.automation.unregister(tab.id);
    this.clipView.removeChildView(tab.view);
    if (this.clipTabId === tab.id) this.clipTabId = null;
    if (this.pointerTabId === tab.id) this.pointerTabId = null;
    this.busyAutomationTabs.delete(tab.id);
    this.setTabVisible(tab, false);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
  }

  private syncViews(): void {
    const owner = this.getOwner();
    if (!owner || owner.isDestroyed()) {
      this.native.setVisible(this.clipView, false);
      return;
    }
    this.observeOwner(owner);
    if (process.platform === "darwin" && (!owner.isVisible() || owner.isMinimized())) {
      this.hideClipView();
      this.syncPresenceOverlay(null);
      return;
    }
    const content = owner.getContentBounds();
    const visibleRectangle = clipBrowserViewportBounds(this.viewport, content);
    const left = visibleRectangle?.x ?? 0;
    const top = visibleRectangle?.y ?? 0;
    const right = left + (visibleRectangle?.width ?? 0);
    const bottom = top + (visibleRectangle?.height ?? 0);
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (active?.sleeping && this.visible && this.viewport.surface === "native" && visibleRectangle !== null) {
      this.wakeForShow(active.id);
    }
    if (!active || active.view.webContents.isDestroyed()) {
      this.hideClipView();
      this.syncPresenceOverlay(null);
      return;
    }

    const canvasSurface = this.canvasGestures.surfaceDecision(active.id, visibleRectangle, content);
    if (canvasSurface.kind !== "normal") {
      if (this.presenceWindow && !this.presenceWindow.isDestroyed()) this.presenceWindow.hide();
      if (canvasSurface.kind === "sink") {
        this.mountClipTab(owner, active);
        this.native.setBounds(this.clipView, canvasSurface.layout.clip);
        this.native.setBounds(active.view, canvasSurface.layout.view);
        // The sink is a 4 DIP wheel receiver; rounding it would be a visual regression and could
        // break the wheel-continuity invariant (docs/adr/ADR-20260808-native-browser-wheel-continuity.md).
        this.native.setBorderRadius(active.view, 0);
        this.setTabVisible(active, true);
        this.native.setVisible(this.clipView, true);
      } else {
        this.native.setVisible(this.clipView, false);
      }
      return;
    }

    const show = this.visible && this.viewport.surface === "native" && visibleRectangle !== null;
    if (!show) {
      this.hideClipView();
      this.syncPresenceOverlay(null);
      return;
    }

    this.mountClipTab(owner, active);
    this.native.setBounds(this.clipView, { x: left, y: top, width: right - left, height: bottom - top });
    this.applyPageScale(active);
    this.native.setBounds(active.view, {
      x: this.viewport.x - left,
      y: this.viewport.y - top,
      width: this.viewport.width,
      height: this.viewport.height
    });
    this.native.setBorderRadius(active.view, pageCornerRadius(this.viewport.canvasScale));
    this.setTabVisible(active, true);
    this.native.setVisible(this.clipView, true);
    this.syncPresenceOverlay({ owner, tabId: active.id, left, top, right, bottom });
  }

  private invalidateCanvasSequence(sync = true): void {
    this.canvasGestures.endSequence(sync);
    this.canvasGestures.invalidateCapture();
  }

  private mountClipTab(owner: BrowserWindow, active: BrowserTab): void {
    for (const tab of this.tabs.values()) {
      if (tab.id !== active.id) this.setTabVisible(tab, false);
    }
    if (this.clipTabId !== active.id) {
      if (this.clipTabId) {
        const previous = this.tabs.get(this.clipTabId);
        if (previous) this.clipView.removeChildView(previous.view);
      }
      this.clipView.addChildView(active.view);
      this.clipTabId = active.id;
    }
    if (this.clipOwnerId !== owner.id) {
      owner.contentView.addChildView(this.clipView);
      this.clipOwnerId = owner.id;
    }
  }

  private applyPageScale(tab: BrowserTab): void {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    const pageScale = this.viewport.canvasScale ?? 1;
    if (Math.abs(contents.getZoomFactor() - pageScale) > 0.001) contents.setZoomFactor(pageScale);
  }

  private hideClipView(): void {
    this.pointerTabId = null;
    for (const tab of this.tabs.values()) {
      this.setTabVisible(tab, false);
      // A hidden view must not carry stale corner geometry into its next show.
      this.native.setBorderRadius(tab.view, 0);
    }
    this.native.setVisible(this.clipView, false);
  }

  /** Mirrors `view.setVisible` into `tab.visible` and recomputes background throttling for it. */
  private setTabVisible(tab: BrowserTab, visible: boolean): void {
    // A sleeping tab has no page to show; syncViews wakes it first.
    if (tab.sleeping) {
      tab.visible = false;
      return;
    }
    // A tab lent a surface for a screenshot stays painted until the capture gives it back.
    if (visible || !this.lentTabs.has(tab.id)) this.native.setVisible(tab.view, visible);
    const changed = tab.visible !== visible;
    tab.visible = visible;
    this.applyBackgroundThrottling(tab);
    if (changed && this.tabs.get(tab.id) === tab) this.lifecycle.setVisible(tab.id, visible);
  }

  private setTabAutomationBusy(tabId: string, busy: boolean): void {
    if (busy) this.busyAutomationTabs.add(tabId);
    else this.busyAutomationTabs.delete(tabId);
    const tab = this.tabs.get(tabId);
    if (tab) this.applyBackgroundThrottling(tab);
    this.lifecycle.setBusy(tabId, busy);
  }

  private wakeForShow(tabId: string): void {
    if (this.wakingTabs.has(tabId)) return;
    this.wakingTabs.add(tabId);
    void this.lifecycle.ensureLive(tabId).catch((error: unknown) => {
      console.warn("CanvasTTY could not wake a sleeping browser tab.", error);
    }).finally(() => {
      this.wakingTabs.delete(tabId);
      if (this.disposed) return;
      this.syncViews();
      this.emit();
    });
  }

  /** Why a hidden tab must keep running now: anything the person or a page could lose by a pause. */
  private freezeBlocker(tabId: string): string | null {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.sleeping || tab.view.webContents.isDestroyed()) return "closed";
    const contents = tab.view.webContents;
    if (tab.status === "crashed") return "crashed";
    if (tab.loading) return "loading";
    if (tab.mediaPlaying || contents.isCurrentlyAudible()) return "media";
    if (this.pendingDialogs.has(tabId)) return "dialog";
    if (this.downloads.some((download) => download.tabId === tabId && download.completedAt === null)) return "download";
    if (contents.isBeingCaptured()) return "capture";
    if (contents.isDevToolsOpened()) return "devtools";
    return null;
  }

  /** Sleeping also loses what the page holds in memory: never with an agent on the tab or a beforeunload handler. */
  private async discardBlocker(tabId: string): Promise<string | null> {
    const blocker = this.freezeBlocker(tabId);
    if (blocker) return blocker;
    if (this.agents.forTab(tabId).length > 0) return "agent";
    if (await this.automation.hasBeforeUnload(tabId)) return "beforeunload";
    return this.freezeBlocker(tabId);
  }

  private async freezeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.sleeping || tab.view.webContents.isDestroyed()) return;
    // Chromium keeps a page frozen only while it may be throttled; a hidden, undriven tab already is.
    this.applyBackgroundThrottling(tab);
    await this.automation.setLifecycleState(tabId, "frozen");
  }

  private async resumeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.sleeping || tab.view.webContents.isDestroyed()) return;
    await this.automation.setLifecycleState(tabId, "active");
  }

  private lifecycleChanged(tabId: string, state: TabLifecycleState): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.frozen = state === "frozen";
    this.emit();
  }

  /**
   * Puts a hidden tab to sleep: its WebContents is closed, and the tab keeps its address, title, favicon, history
   * (with each entry's scroll and form state) and a small picture for the card. False when the tab woke meanwhile.
   */
  private async sleepTab(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.sleeping || tab.view.webContents.isDestroyed()) return false;
    const contents = tab.view.webContents;
    const preview = await boundedWait(capturePreview(contents), SLEEP_CAPTURE_TIMEOUT_MS).catch(() => null);
    if (this.tabs.get(tabId) !== tab || tab.visible || this.busyAutomationTabs.has(tabId) || contents.isDestroyed()) {
      return false;
    }
    const history = contents.navigationHistory;
    tab.lastSafeUrl = this.tabUrl(tab);
    tab.sleeping = {
      title: contents.getTitle(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      entries: history.getAllEntries(),
      index: history.getActiveIndex(),
      preview
    };
    this.canvasPointers.cancelTab(tab.id);
    if (this.activeTabId === tab.id) this.invalidateCanvasSequence(false);
    tab.canvasCursor.dispose();
    tab.canvasSinkViewport.dispose();
    this.automation.unregister(tab.id);
    this.clipView.removeChildView(tab.view);
    if (this.clipTabId === tab.id) this.clipTabId = null;
    if (this.pointerTabId === tab.id) this.pointerTabId = null;
    this.busyAutomationTabs.delete(tab.id);
    this.pendingDialogs.delete(tab.id);
    tab.frozen = false;
    tab.loading = false;
    tab.mediaPlaying = false;
    contents.close({ waitForBeforeUnload: false });
    this.emit();
    return true;
  }

  /** Brings a sleeping tab back in a new WebContents, on the history entry it slept on. */
  private async wakeTab(tabId: string): Promise<void> {
    const asleep = this.tabs.get(tabId);
    const saved = asleep?.sleeping;
    if (!asleep || !saved || this.disposed) return;
    const tab = this.createRuntimeTab(tabId, asleep.lastSafeUrl, asleep.documentRevision + 1);
    tab.favicon = asleep.favicon;
    const current = saved.entries[saved.index];
    let loading: Promise<void>;
    if (current && isSafeBrowserUrl(current.url)) {
      loading = tab.view.webContents.navigationHistory.restore({ entries: saved.entries, index: saved.index })
        .catch(() => this.loadTab(tab, asleep.lastSafeUrl));
    } else {
      loading = this.loadTab(tab, asleep.lastSafeUrl);
    }
    this.syncViews();
    this.emit();
    // A command after the wake finds the page loaded (or as far as it got): a slow page cannot hold the queue.
    await boundedWait(loading, WAKE_LOAD_TIMEOUT_MS).catch(() => undefined);
    if (this.tabs.get(tabId) === tab) void this.persistRuntime();
  }

  /**
   * Chromium background throttling is disabled only for a tab that is on screen or that an agent
   * command/screenshot is currently driving; every other hidden/inactive tab runs throttled to save
   * idle CPU. `sandbox/security` and the wheel-continuity sink surface are untouched by this.
   */
  private applyBackgroundThrottling(tab: BrowserTab): void {
    if (tab.view.webContents.isDestroyed()) return;
    const keepUnthrottled = tab.visible || this.busyAutomationTabs.has(tab.id);
    this.native.setBackgroundThrottling(tab.view.webContents, !keepUnthrottled);
  }

  private observeOwner(owner: BrowserWindow): void {
    if (this.observedOwners.has(owner)) return;
    this.observedOwners.add(owner);
    const sync = () => this.syncViews();
    owner.on("move", sync);
    owner.on("resize", sync);
    owner.on("maximize", sync);
    owner.on("unmaximize", sync);
    owner.on("show", sync);
    if (process.platform === "darwin") {
      owner.on("minimize", () => {
        this.canvasGestures.endSequence(false);
        sync();
      });
      owner.on("restore", sync);
    }
    owner.on("hide", () => {
      this.canvasGestures.endSequence(false);
      sync();
    });
    owner.on("blur", () => this.canvasGestures.endSequence());
    owner.webContents.on("before-mouse-event", (event, mouse) => {
      if (mouse.type === "mouseWheel") {
        this.canvasGestures.beginOwnerSequence({ x: mouse.x, y: mouse.y });
      }
      this.canvasPointers.handleOwnerMouse(event, mouse, owner);
    });
    owner.once("closed", () => {
      this.canvasGestures.endSequence(false);
      this.destroyPresenceWindow();
    });
  }

  private syncPresenceOverlay(
    geometry: { owner: BrowserWindow; tabId: string; left: number; top: number; right: number; bottom: number } | null
  ): void {
    if (!geometry || !this.viewport.showAgentPresence) {
      if (geometry) void this.automation.setAgentPresences(geometry.tabId, []);
      if (this.presenceWindow && !this.presenceWindow.isDestroyed()) this.presenceWindow.hide();
      return;
    }
    const values = this.agents.forTab(geometry.tabId).filter((presence) => presence.cursor.updatedAt > 0);
    const useTrustedWindow = !(process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland");
    void this.automation.setAgentPresences(geometry.tabId, useTrustedWindow ? [] : values);
    if (!useTrustedWindow) return;
    if (values.length === 0) {
      if (this.presenceWindow && !this.presenceWindow.isDestroyed()) this.presenceWindow.hide();
      return;
    }
    const content = geometry.owner.getContentBounds();
    const overlay = this.ensurePresenceWindow(geometry.owner);
    overlay.setBounds({
      x: content.x + geometry.left,
      y: content.y + geometry.top,
      width: geometry.right - geometry.left,
      height: geometry.bottom - geometry.top
    }, false);
    const offsetX = geometry.left - this.viewport.x;
    const offsetY = geometry.top - this.viewport.y;
    const payload = values.map((presence) => ({
      id: presence.connectionId,
      color: presence.brandColor,
      x: presence.cursor.x - offsetX,
      y: presence.cursor.y - offsetY,
      stale: presence.connectionState === "stale"
    }));
    void this.presenceWindowReady?.then(async () => {
      if (overlay.isDestroyed()) return;
      await overlay.webContents.executeJavaScript(`globalThis.renderPresence(${JSON.stringify(payload).replace(/</g, "\\u003c")})`);
      overlay.showInactive();
    }).catch(() => undefined);
  }

  private ensurePresenceWindow(owner: BrowserWindow): BrowserWindow {
    if (this.presenceWindow && !this.presenceWindow.isDestroyed()) return this.presenceWindow;
    const overlay = new BrowserWindow({
      parent: owner,
      show: false,
      frame: false,
      transparent: true,
      focusable: false,
      hasShadow: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      backgroundColor: "#00000000",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false
      }
    });
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.webContents.on("will-navigate", (event) => event.preventDefault());
    this.presenceWindow = overlay;
    this.presenceWindowReady = overlay.loadURL(presenceOverlayUrl());
    overlay.on("closed", () => {
      if (this.presenceWindow === overlay) {
        this.presenceWindow = null;
        this.presenceWindowReady = null;
      }
    });
    return overlay;
  }

  private destroyPresenceWindow(): void {
    const overlay = this.presenceWindow;
    this.presenceWindow = null;
    this.presenceWindowReady = null;
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
  }

  private touchActor(actor: BrowserActor, tabId: string | null, cursor?: BrowserPointerResult): void {
    if (!this.agents.touch(actor, tabId ?? this.activeTabId, cursor)) return;
    this.presenceChanged();
  }

  private heartbeatActor(actor: BrowserActor, timestamp: number): void {
    if (!this.agents.heartbeat(actor, timestamp)) return;
    this.presenceChanged();
  }

  private disconnectActor(actor: BrowserActor): void {
    if (!this.agents.disconnect(actor)) return;
    this.presenceChanged();
  }

  private presenceChanged(): void {
    this.syncViews();
    this.emit();
  }

  private pendingDialog(tabId: string): BrowserDialogSnapshot | null {
    const dialog = this.pendingDialogs.get(tabId);
    return dialog ? structuredClone(dialog) : null;
  }

  private visibleDialog(): BrowserDialogSnapshot | null {
    const dialog = this.activeTabId
      ? this.pendingDialogs.get(this.activeTabId) ?? this.pendingDialogs.values().next().value
      : this.pendingDialogs.values().next().value;
    return dialog ? structuredClone(dialog) : null;
  }

  private tabSnapshot(tab: BrowserTab, agents: readonly AgentPresenceSnapshot[]): BrowserTabSnapshot {
    const contents = tab.view.webContents;
    const url = this.tabUrl(tab);
    const tabAgents = agents
      .filter((presence) => presence.currentTabId === tab.id)
      .map((presence) => structuredClone(presence));
    if (tab.sleeping) {
      return {
        id: tab.id,
        url,
        title: tab.sleeping.title || displayUrl(url),
        loading: false,
        canGoBack: tab.sleeping.canGoBack,
        canGoForward: tab.sleeping.canGoForward,
        documentRevision: tab.documentRevision,
        status: "ready",
        favicon: tab.favicon,
        agents: tabAgents,
        crashState: null,
        lifecycle: "sleeping",
        ...(this.activeTabId === tab.id ? { preview: tab.sleeping.preview } : {})
      };
    }
    const title = contents.isDestroyed() ? "" : contents.getTitle();
    return {
      id: tab.id,
      url,
      title: title || displayUrl(url),
      loading: tab.loading,
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      documentRevision: tab.documentRevision,
      status: tab.status,
      favicon: tab.favicon,
      agents: tabAgents,
      crashState: tab.crashState,
      ...(tab.frozen ? { lifecycle: "paused" as const } : {})
    };
  }

  private persistedTabSnapshot(
    tab: PersistedBrowserTab,
    agents: readonly AgentPresenceSnapshot[]
  ): BrowserTabSnapshot {
    return {
      id: tab.id,
      url: tab.url,
      title: displayUrl(tab.url),
      loading: false,
      canGoBack: false,
      canGoForward: false,
      documentRevision: 0,
      status: "ready",
      favicon: null,
      agents: agents.filter((presence) => presence.currentTabId === tab.id).map((presence) => structuredClone(presence)),
      crashState: null
    };
  }

  private tabUrl(tab: BrowserTab): string {
    if (tab.view.webContents.isDestroyed()) return tab.lastSafeUrl;
    const current = tab.view.webContents.getURL();
    return isSafeBrowserUrl(current) ? current : tab.lastSafeUrl;
  }

  private snapshotResult(result: BrowserResult): BrowserSnapshot {
    if (!result.ok) throw new BrowserKernelError(
      result.error?.code ?? "BRIDGE_UNAVAILABLE",
      result.error?.message ?? "Browser command failed.",
      { retryable: result.error?.retryable, details: result.error?.details }
    );
    return this.getState();
  }

  private requireSession(): Session {
    if (!this.browserSession) throw new BrowserKernelError("BRIDGE_UNAVAILABLE", "Browser session is unavailable.");
    return this.browserSession;
  }

  private requireOwner(): BrowserWindow {
    const owner = this.getOwner();
    if (!owner || owner.isDestroyed()) throw new BrowserKernelError("BRIDGE_UNAVAILABLE", "Browser host window is unavailable.");
    return owner;
  }

  private requireTab(id: string): BrowserTab {
    const tab = this.tabs.get(id);
    if (!tab) throw new BrowserKernelError("TAB_NOT_FOUND", "Browser tab is unavailable.");
    return tab;
  }

  private emit(): void {
    const owner = this.getOwner();
    if (owner && !owner.isDestroyed()) owner.webContents.send(IPC.browserState, { snapshot: this.getState() });
  }

  private emitActivity(event: BrowserActivityEvent): void {
    const owner = this.getOwner();
    if (owner && !owner.isDestroyed()) owner.webContents.send(IPC.browserActivity, { event });
  }
}

function downloadStatus(state: string): BrowserDownloadStatus {
  if (state === "completed") return "completed";
  if (state === "cancelled") return "canceled";
  return "interrupted";
}

function remoteBrowserWebPreferences(partition = BROWSER_PARTITION): WebPreferences {
  return {
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    plugins: false,
    devTools: false,
    navigateOnDragDrop: false,
    // Initial state only; BrowserService.applyBackgroundThrottling toggles this per tab at runtime
    // based on visibility and in-flight automation, via WebContents.setBackgroundThrottling.
    backgroundThrottling: false,
    spellcheck: true
  };
}

function displayUrl(value: string): string {
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}

function presenceOverlayUrl(): string {
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body,#root{position:fixed;inset:0;margin:0;overflow:hidden;background:transparent;pointer-events:none}.marker{position:absolute;transform:translate(-3px,-3px);pointer-events:none}.dot{display:block;width:10px;height:10px;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 5px #0008}</style><div id="root"></div><script>globalThis.renderPresence=(values)=>{const root=document.getElementById('root');root.replaceChildren(...values.map(v=>{const marker=document.createElement('div');marker.className='marker';marker.style.left=v.x+'px';marker.style.top=v.y+'px';marker.style.opacity=v.stale?'.45':'1';const dot=document.createElement('span');dot.className='dot';dot.style.background=v.color;marker.append(dot);return marker;}));};</script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error("Favicon response is too large.");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Favicon response is too large.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, size);
}

/** A small JPEG of the page for a sleeping tab's card, or null when the page draws nothing. */
async function capturePreview(contents: WebContents): Promise<string | null> {
  let image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return null;
  if (size.width > SLEEP_PREVIEW_MAX_WIDTH) {
    image = image.resize({ width: SLEEP_PREVIEW_MAX_WIDTH, quality: "good" });
  }
  return `data:image/jpeg;base64,${image.toJPEG(SLEEP_PREVIEW_JPEG_QUALITY).toString("base64")}`;
}

function boundedWait<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out.")), ms);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}
