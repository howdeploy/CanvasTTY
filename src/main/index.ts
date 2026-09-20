import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { EvenG2Controller } from "./services/companion/EvenG2Controller";
import { join } from "node:path";
import { app, BrowserWindow, dialog, net, Notification, protocol, safeStorage, session } from "electron";
import electronUpdater from "electron-updater";
import {
  IPC,
  type LocaleId,
  type PluginCanvasRequest,
  type SessionStatus,
  type UpdaterState,
  type UpdaterStateEvent
} from "../shared/contracts";
import { registerIpc } from "./ipc/registerIpc";
import { SettingsStore } from "./services/SettingsStore";
import { TerminalManager } from "./services/TerminalManager";
import { AgentControlGateway } from "./services/agent-control/AgentControlGateway";
import { TerminalSessionStore } from "./services/TerminalSessionStore";
import { LimitsService } from "./services/LimitsService";
import {
  createProviderCliRegistry,
  type ProviderCliRegistry
} from "./services/providerCliRegistry";
import { PluginManager } from "./services/PluginManager";
import { GithubAuthService } from "./services/GithubAuthService";
import { PluginMediaService } from "./services/PluginMediaService";
import { PluginSecretsService } from "./services/PluginSecretsService";
import { HermesHudService } from "./services/HermesHudService";
import { BrowserService } from "./services/BrowserService";
import { BrowserWorkspace } from "./services/browser/BrowserWorkspace";
import { BrowserAuditStore } from "./services/browser/BrowserAuditStore";
import { CanvasNavigationInputController } from "./services/CanvasNavigationOverride";
import { activeCanvasWheelBinding } from "../shared/canvasNavigation";
import { runBrowserElectronSmoke } from "./services/browser/BrowserElectronSmoke";
import { runBrowserGeometrySmoke } from "./services/browser/BrowserGeometrySmoke";
import {
  runProviderElectronSmoke,
  type ProviderSmokeTarget
} from "./services/browser/ProviderElectronSmoke";
import {
  AgentBrowserBridge,
  AgentGateway,
  WINDOWS_PIPE_HOST_FILENAME,
  WINDOWS_AGENT_GATEWAY_UNAVAILABLE,
  supportsAgentGatewayPlatform
} from "./services/agent-browser";
import {
  recoverKimiConfigurationOnStartup,
  resolveKimiHomeDirectory
} from "./services/agent-browser/ProviderLaunch";
import type { StdioHelperLaunch } from "./services/agent-browser/ProviderLaunch";
import {
  AgentRuntimeBridge,
  RuntimeGateway
} from "./services/agent-runtime";
import type { RuntimeHookHelperLaunch } from "./services/agent-runtime/ProviderRuntimeLaunch";
import {
  recoverHermesConfigurationOnStartup,
  resolveHermesHomeDirectory
} from "./services/hermesConfig";
import { startupPageUrl } from "./startupPage";
import { mainWindowChromeOptions } from "./windowChrome";

// electron-updater is CommonJS; a default import is the only ESM-safe form.
const { autoUpdater } = electronUpdater;
if (process.env.CANVASTTY_USER_DATA_DIR) {
  if (!isAbsolute(process.env.CANVASTTY_USER_DATA_DIR)) throw new Error("CANVASTTY_USER_DATA_DIR must be absolute");
  app.setPath("userData", process.env.CANVASTTY_USER_DATA_DIR);
  delete process.env.CANVASTTY_USER_DATA_DIR;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "canvastty-plugin",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
  {
    scheme: "canvastty-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

let mainWindow: BrowserWindow | null = null;
let evenG2: EvenG2Controller | null = null;
const browserRequests = new Map<string, { resolve():void; reject(error:Error):void; timer:ReturnType<typeof setTimeout> }>();
ipcMain.on(IPC.evenG2BrowserResponse, (event, response: {requestId?:unknown;ok?:unknown}) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !response || typeof response.requestId !== "string" || typeof response.ok !== "boolean") return;
  const request = browserRequests.get(response.requestId); if (!request) return;
  clearTimeout(request.timer); browserRequests.delete(response.requestId);
  if (response.ok) request.resolve(); else request.reject(new Error("Browser could not be shown"));
});
async function showCompanionBrowser():Promise<{title:string;url:string}> {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !browserService) throw new Error("Window unavailable");
  if (browserRequests.size) throw new Error("Browser is opening");
  window.show(); window.focus();
  await new Promise<void>((resolve,reject) => {
    const id=randomUUID(), timer=setTimeout(()=>{browserRequests.delete(id);reject(new Error("Browser display timeout"));},12000);
    browserRequests.set(id,{resolve,reject,timer});window.webContents.send(IPC.evenG2BrowserRequest,id);
  });
  const state=browserService.getState(), tab=state.tabs.find(tab=>tab.id===state.activeTabId);
  return {title:tab?.title||"Browser",url:tab?.url||""};
}
let terminalManager: TerminalManager | null = null;
let agentControl: AgentControlGateway | null = null;
let limitsService: LimitsService | null = null;
let pluginManager: PluginManager | null = null;
let githubAuth: GithubAuthService | null = null;
let pluginMediaService: PluginMediaService | null = null;
let pluginSecretsService: PluginSecretsService | null = null;
let hermesHudService: HermesHudService | null = null;
let browserService: BrowserWorkspace | null = null;
let canvasNavigationInput: CanvasNavigationInputController | null = null;
let agentGateway: AgentGateway | null = null;
let agentBrowserBridge: AgentBrowserBridge | null = null;
let agentBrowserHelper: StdioHelperLaunch | null = null;
let runtimeGateway: RuntimeGateway | null = null;
let agentRuntimeBridge: AgentRuntimeBridge | null = null;
let agentRuntimeHelper: RuntimeHookHelperLaunch | null = null;
let providerClis: ProviderCliRegistry | null = null;
const pluginWindows = new Map<BrowserWindow, string>();
let servicesReady = false;
let startupRunning = false;
let shutdownRunning = false;
let shutdownComplete = false;
// Set the instant the shell window's close is requested — before the window is
// destroyed — and cleared when a new one is created. Electron aborts the
// navigations that race that close (ERR_ABORTED / ERR_FAILED / "Object has been
// destroyed"); a startup step that sees this flag must stop quietly, because
// the user asked for a quit and there is no failure left to report.
let mainWindowClosing = false;
// Deduplicates attention notifications: the last status already announced per
// session, so a burst of snapshots notifies once per transition. Cleared when
// the session is removed (its removal event), never used as a status source.
const notifiedAttentionStatus = new Map<string, SessionStatus>();
// Self-update state; advanced by autoUpdater events and pushed to the renderer.
let updaterState: UpdaterState = { status: "idle" };
let updaterInitialized = false;

// Geometry smoke isolates settings, Chromium state and the instance lock before
// any service starts. The installed application's path is never changed.
if (process.env.CANVASTTY_GEOMETRY_DISPOSABLE_DESKTOP === "1"
  && process.env.CANVASTTY_BROWSER_GEOMETRY_URL && process.env.CANVASTTY_GEOMETRY_USER_DATA) {
  app.setPath("userData", process.env.CANVASTTY_GEOMETRY_USER_DATA);
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 920,
    minHeight: 620,
    show: true,
    ...mainWindowChromeOptions(),
    backgroundColor: "#aaa7a2",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = window;
  // A fresh window is not closing; the previous one's flag must not leak in.
  mainWindowClosing = false;

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl && url !== currentUrl) event.preventDefault();
  });
  canvasNavigationInput?.attach(window.webContents, { preventMouseBindings: false });
  // Crash recovery: a dead renderer must never leave the user staring at a
  // blank window. The application surface is reloaded in place — the same entry
  // startup loads — so services, sessions and their scrollback stay untouched
  // and the user lands back in the app. The startup page is not a recovery
  // surface: it is static HTML with no script that could re-enter the app, so
  // loading it here would strand the user on a spinner forever.
  // "clean-exit" is the normal teardown path and must not trigger a reload.
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    console.warn(
      `CanvasTTY renderer is gone (reason=${details.reason}, exitCode=${details.exitCode}). Reloading the application.`
    );
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    void loadApplicationSurface(window)
      .catch((error) => console.warn("CanvasTTY could not reload the application after a renderer crash.", error));
  });
  // Seed the renderer's view of the updater on every (re)load, including the
  // crash-recovery reload above.
  window.webContents.on("did-finish-load", broadcastUpdaterState);
  window.on("blur", () => {
    canvasNavigationInput?.reset();
    browserService?.cancelCanvasNavigationGesture();
  });

  // Both handlers are registered before the startup page load: a close landing
  // inside that load has to be visible to the load's own catch below, and the
  // dead window must not stay in `mainWindow` until the load settles.
  window.on("close", () => {
    mainWindowClosing = true;
  });
  window.on("closed", () => {
    mainWindowClosing = true;
    if (mainWindow === window) mainWindow = null;
  });

  try {
    await window.loadURL(startupPageUrl({ locale: app.getLocale(), isMacOS: process.platform === "darwin" }));
  } catch (error) {
    // A close during this load aborts the navigation (ERR_ABORTED / ERR_FAILED).
    // That is a quit, not a failed startup, so it must not reach the caller's
    // failure handling; a real error on a live window still propagates.
    if (!shellWindowGone(window)) throw error;
    console.warn("CanvasTTY startup page load stopped: its window is gone, the application is closing.", error);
  }
  return window;
}

/**
 * True when the shell window is on its way out: its close was requested (the
 * "close" event fires before destruction) or the window/webContents is already
 * destroyed. Startup work that races this must stop quietly instead of
 * reporting the aborted navigation as a startup failure.
 */
function shellWindowGone(window: BrowserWindow): boolean {
  return mainWindowClosing || window.isDestroyed() || window.webContents.isDestroyed();
}

async function initializeServices(): Promise<void> {
  // Deny-by-default browser permissions on the default session: neither the
  // shell window nor plugin windows ever request camera, microphone, location,
  // notifications or device access, so nothing is granted silently. The
  // browser partition keeps its own, deliberately more permissive policy in
  // BrowserService; exceptions belong there, not here.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setDevicePermissionHandler(() => false);
  providerClis = buildProviderCliRegistry();
  // Recovery is independent of gateway availability: interrupted provider config
  // overlays must be restored before any new terminal can launch, including on Windows.
  const hermesHomeDirectory = resolveHermesHomeDirectory();
  hermesHudService = new HermesHudService(providerClis, hermesHomeDirectory);
  recoverHermesConfigurationOnStartup(hermesHomeDirectory);
  const kimiHomeDirectory = resolveKimiHomeDirectory();
  recoverKimiConfigurationOnStartup(kimiHomeDirectory);
  const userDataPath = app.getPath("userData");
  const settings = new SettingsStore(userDataPath, app.getLocale());
  await settings.load();
  pluginManager = new PluginManager(userDataPath);
  await pluginManager.load();

  canvasNavigationInput = new CanvasNavigationInputController(
    {
      wheelBinding: activeCanvasWheelBinding(
        settings.get().canvasWheelCaptureMode,
        settings.get().canvasWheelOverride
      ),
      navigationBinding: settings.get().canvasNavigationOverride
    },
    (state) => {
      browserService?.setCanvasNavigationActive(state.navigationActive);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(IPC.canvasNavigationOverrideState, state);
      }
    }
  );
  if (mainWindow && !mainWindow.isDestroyed()) {
    canvasNavigationInput.attach(mainWindow.webContents, { preventMouseBindings: false });
  }

  browserService = new BrowserWorkspace({
    userDataPath,
    audit: new BrowserAuditStore(userDataPath),
    onState: (snapshot) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.browserState, { snapshot }); },
    onActivity: (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.browserActivity, { event }); },
    createInstance: (id, onState) => new BrowserService(() => mainWindow, {
      browserId: id,
      userDataPath: id === "default" ? userDataPath : join(userDataPath, "browser", "windows", id),
      auditUserDataPath: join(userDataPath, "browser", "windows", id),
      onState,
      onActivity: () => {},
      restoreTabs: settings.get().browserRestoreTabs,
      canvasWheelCaptureMode: settings.get().canvasWheelCaptureMode,
      canvasNavigationInput: canvasNavigationInput ?? undefined,
      ...(process.env.CANVASTTY_BROWSER_SMOKE_URL ? { downloadRoot: join(userDataPath, "browser-smoke-downloads") } : {})
    })
  });
  await browserService.ready();
  browserService.setCanvasNavigationActive(canvasNavigationInput.active);

  if (supportsAgentGatewayPlatform()) {
    const runtimeDirectory = join(userDataPath, "browser", "runtime");
    const windowsHostPath = process.platform === "win32"
      ? app.isPackaged
        ? join(process.resourcesPath, "agent-browser", WINDOWS_PIPE_HOST_FILENAME)
        : join(app.getAppPath(), "build", "windows-agent-pipe-host", WINDOWS_PIPE_HOST_FILENAME)
      : undefined;
    agentGateway = new AgentGateway(browserService.core, { runtimeDirectory, windowsHostPath });
    agentGateway.setEnabled(settings.get().browserAgentAccess);
    await agentGateway.start();
    const helperPath = app.isPackaged
      ? join(process.resourcesPath, "agent-browser", "mcp-helper.mjs")
      : join(app.getAppPath(), "src", "agent-browser", "mcp-helper.mjs");
    agentBrowserHelper = {
      command: process.execPath,
      args: [helperPath],
      env: { ELECTRON_RUN_AS_NODE: "1" }
    };
    agentBrowserBridge = new AgentBrowserBridge(agentGateway, {
      helper: agentBrowserHelper,
      providerClis,
      runtimeDirectory,
      hermesHomeDirectory,
      kimiHomeDirectory
    });

    const lifecycleRuntimeDirectory = join(userDataPath, "lifecycle", "runtime");
    runtimeGateway = new RuntimeGateway({
      runtimeDirectory: lifecycleRuntimeDirectory,
      windowsHostPath,
      onSignal: (terminalSessionId, signal) => {
        terminalManager?.applyProviderSignal(terminalSessionId, {
          kind: "lifecycle",
          state: signal.state,
          ...(signal.turnId ? { requestId: signal.turnId } : {})
        });
        agentControl?.onSignal(terminalSessionId, signal);
        if (signal.lastAssistantMessage !== undefined) evenG2?.answer(terminalSessionId, signal.lastAssistantMessage, signal.turnId);
      }
    });
    await runtimeGateway.start();
    const runtimeHelperPath = app.isPackaged
      ? join(process.resourcesPath, "agent-runtime", "hook-helper.mjs")
      : join(app.getAppPath(), "src", "agent-runtime", "hook-helper.mjs");
    const openCodePluginPath = app.isPackaged
      ? join(process.resourcesPath, "agent-runtime", "opencode-plugin.mjs")
      : join(app.getAppPath(), "src", "agent-runtime", "opencode-plugin.mjs");
    const pluginHookRunnerPath = app.isPackaged
      ? join(process.resourcesPath, "agent-runtime", "plugin-hook-runner.mjs")
      : join(app.getAppPath(), "src", "agent-runtime", "plugin-hook-runner.mjs");
    agentRuntimeHelper = {
      command: process.execPath,
      args: [runtimeHelperPath],
      env: { ELECTRON_RUN_AS_NODE: "1" }
    };
    agentRuntimeBridge = new AgentRuntimeBridge(runtimeGateway, {
      helper: agentRuntimeHelper,
      runtimeDirectory: lifecycleRuntimeDirectory,
      openCodePluginPath,
      hermesHomeDirectory,
      kimiHomeDirectory,
      recoverOnStart: true,
      coreHooksEnabled: settings.get().agentLifecycleHooksEnabled,
      pluginHooks: {
        runner: {
          command: process.execPath,
          args: [pluginHookRunnerPath],
          env: { ELECTRON_RUN_AS_NODE: "1" }
        },
        registryPath: pluginManager.runtimeHookRegistryPath,
        list: (provider) => pluginManager!.runtimeHooksForProvider(provider)
      }
    });
  } else {
    console.warn(WINDOWS_AGENT_GATEWAY_UNAVAILABLE);
  }

  terminalManager = new TerminalManager((channel, payload) => {
    agentControl?.observe(channel, payload);
    evenG2?.observe(channel, payload);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
    // Attention notifications ride the session-status stream, never the output
    // stream: a transition into needs_approval/failed notifies once, and the
    // removal event clears the dedup entry so a later session (or restart) can
    // notify again. Failures are not all the same event, though, and status
    // equality cannot tell them apart: the manager states whether a failure is
    // re-derived state (a restored session, already on screen) or the outcome
    // of a launch the user just asked for, which is news either way.
    if (channel === IPC.terminalSession && "session" in payload) {
      const { id, status, title, provider } = payload.session;
      const previousStatus = notifiedAttentionStatus.get(id);
      notifiedAttentionStatus.set(id, status);
      const failureOrigin = status === "failed" ? terminalManager?.consumeFailureOrigin() ?? null : null;
      if ((status === "needs_approval" || status === "failed")
        && failureOrigin !== "restore"
        && (failureOrigin === "user" || previousStatus !== status)
        && settings.get().attentionNotifications
        && Notification.isSupported()) {
        new Notification({
          title: title || provider,
          body: attentionStatusLabel(status, settings.get().locale)
        }).show();
      }
    } else if (channel === IPC.terminalRemoved && "id" in payload) {
      notifiedAttentionStatus.delete(payload.id);
    }
  }, providerClis, agentBrowserBridge ?? undefined, agentRuntimeBridge ?? undefined, settings.get().agentLifecycleHooksEnabled,
  // Final answers reach the runtime hook only for sessions spawned while Even G2 is on.
  undefined, () => evenG2?.enabled() === true);
  const terminalSessionStore = new TerminalSessionStore(userDataPath);
  terminalManager.configureSessionPersistence(terminalSessionStore, settings.get().restoreTerminalSessions);
  await terminalManager.restorePersistedSessions();
  if (process.argv.includes("--agent-control") || process.env.CANVASTTY_AGENT_CONTROL === "1") {
    const windowsHostPath = process.platform === "win32"
      ? app.isPackaged
        ? join(process.resourcesPath, "agent-browser", WINDOWS_PIPE_HOST_FILENAME)
        : join(app.getAppPath(), "build", "windows-agent-pipe-host", WINDOWS_PIPE_HOST_FILENAME)
      : undefined;
    agentControl = new AgentControlGateway({ userDataPath, terminals: terminalManager,
      lifecycleEnabled: () => Boolean(runtimeGateway) && settings.get().agentLifecycleHooksEnabled,
      windowsHostPath });
    try {
      const connection = await agentControl.start();
      console.log(`CANVASTTY_AGENT_CONTROL_READY ${connection}`);
    } catch {
      await agentControl.close().catch(() => undefined);
      agentControl = null;
      console.warn("CanvasTTY agent control could not start; normal terminal operation is unchanged.");
    }
  }
  limitsService = new LimitsService(providerClis, app.getVersion());
  evenG2 = new EvenG2Controller({
    userDataPath, terminals: terminalManager,
    localDiscovery: process.platform === "darwin",
    defaultWorkspace: join(app.getPath("documents"), "CanvasTTY Projects"),
    bundledSpeech: process.platform === "darwin" ? (app.isPackaged ? join(process.resourcesPath, "companion/speech/canvastty-speech") : join(app.getAppPath(), "artifacts/companion-speech", process.arch, "canvastty-speech")) : undefined,
    webRoot: app.isPackaged ? join(process.resourcesPath,"even-g2-web") : join(app.getAppPath(),"integrations/even-g2/dist"),
    speechWorker: app.isPackaged ? join(process.resourcesPath,"companion/asr_worker.py") : join(app.getAppPath(),"src/main/services/companion/asr_worker.py"),
    limits: () => limitsService!.get(), openBrowser: showCompanionBrowser
  });
  await evenG2.load();
  const assertCompanionSender = (event: Electron.IpcMainInvokeEvent):void => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("Untrusted companion caller");
  };
  ipcMain.handle(IPC.evenG2State, event => { assertCompanionSender(event); return evenG2!.state(); });
  ipcMain.handle(IPC.evenG2Command, async (event, command) => { assertCompanionSender(event); return evenG2!.command(command); });
  githubAuth = new GithubAuthService(app.getPath("userData"), undefined, {
    fetcher: (input, init) => net.fetch(input, init)
  });
  await githubAuth.load();
  pluginManager.registerTokenProvider(() => githubAuth!.getToken());
  pluginMediaService = new PluginMediaService(
    app.getPath("userData"),
    (pluginId, permission) => pluginManager!.assertPermission(pluginId, permission)
  );
  await pluginMediaService.load();
  pluginSecretsService = new PluginSecretsService(
    app.getPath("userData"),
    (pluginId, permission) => pluginManager!.assertPermission(pluginId, permission),
    {
      isAvailable: securePluginStorageAvailable,
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value)
    }
  );
  await pluginSecretsService.load();
  protocol.handle("canvastty-plugin", (request) => pluginManager!.protocolResponse(request.url));
  protocol.handle("canvastty-media", (request) => pluginMediaService!.protocolResponse(request));
  registerIpc({
    settings,
    terminals: terminalManager,
    limits: limitsService,
    plugins: pluginManager,
    pluginMedia: pluginMediaService,
    pluginSecrets: pluginSecretsService,
    browser: browserService,
    githubAuth: githubAuth!,
    hermesHud: hermesHudService,
    getMainWindow: () => mainWindow,
    applyBrowserSettings: async (next) => {
      agentRuntimeBridge?.setCoreHooksEnabled(next.agentLifecycleHooksEnabled);
      terminalManager?.setLifecycleHooksEnabled(next.agentLifecycleHooksEnabled);
      agentBrowserBridge?.setEnabled(next.browserAgentAccess);
      browserService?.setRestoreTabs(next.browserRestoreTabs);
      browserService?.cancelCanvasNavigationGesture();
      browserService?.setCanvasWheelCaptureMode(next.canvasWheelCaptureMode);
      canvasNavigationInput?.setBindings({
        wheelBinding: activeCanvasWheelBinding(next.canvasWheelCaptureMode, next.canvasWheelOverride),
        navigationBinding: next.canvasNavigationOverride
      });
      await terminalManager?.setSessionPersistenceEnabled(next.restoreTerminalSessions);
    },
    setCanvasNavigationShortcutCapture: (active) => {
      if (active) browserService?.cancelCanvasNavigationGesture();
      canvasNavigationInput?.setShortcutCaptureActive(active);
    },
    setCanvasNavigationPointerBinding: (input) => {
      canvasNavigationInput?.updatePointerBinding(input);
    },
    openPluginWindow,
    closePluginWindows,
    requestPluginLauncher,
    requestPluginCanvas,
    broadcastPluginStorageChange,
    updater: {
      check: requestUpdaterCheck,
      install: installUpdaterUpdate
    }
  });
  servicesReady = true;
}

/**
 * Loads the application entry into a window: the dev server when one is
 * configured, the packaged renderer bundle otherwise. Startup and renderer
 * crash recovery both go through here, so they can never drift apart.
 */
async function loadApplicationSurface(window: BrowserWindow): Promise<void> {
  // Both callers can race a window the user closed first (startup is long,
  // crash recovery runs asynchronously): loading into a destroyed window only
  // produces ERR_FAILED / "Object has been destroyed", which is not a failure.
  if (shellWindowGone(window)) return;
  try {
    if (process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      await window.loadFile(join(__dirname, "../renderer/index.html"));
    }
  } catch (error) {
    // Closing during the load is a normal exit, not a failed startup.
    if (!shellWindowGone(window)) throw error;
    console.warn("CanvasTTY application surface load stopped: its window is gone, the application is closing.", error);
    return;
  }
}

async function loadApplication(window: BrowserWindow): Promise<void> {
  await loadApplicationSurface(window);

  if (process.env.CANVASTTY_SMOKE_TEST === "1") {
    await window.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    );
    console.log("CANVASTTY_SMOKE_READY");
    app.quit();
  }
  const geometrySmokeUrl = process.env.CANVASTTY_BROWSER_GEOMETRY_URL;
  if (geometrySmokeUrl && browserService) {
    try { await runBrowserGeometrySmoke(window, browserService, geometrySmokeUrl); }
    catch (error) {
      console.error(error);
      // Release child WebContentsViews before forcing the failed fixture out.
      await browserService.dispose().catch((cleanupError) => console.error(cleanupError));
      app.exit(1);
    }
    return;
  }
  const browserSmokeUrl = process.env.CANVASTTY_BROWSER_SMOKE_URL;
  if (browserSmokeUrl && browserService) {
    await runBrowserElectronSmoke(browserService.primaryInstance, browserSmokeUrl, app.getPath("userData"));
    console.log("CANVASTTY_BROWSER_SMOKE_READY");
    app.quit();
  }
  const providerSmoke = process.env.CANVASTTY_PROVIDER_SMOKE;
  if (providerSmoke) {
    if (!agentBrowserBridge || !agentBrowserHelper) {
      throw new Error("Provider smoke requires the local agent browser gateway.");
    }
    const targets = parseProviderSmokeTargets(providerSmoke);
    await runProviderElectronSmoke({
      bridge: agentBrowserBridge,
      helper: agentBrowserHelper,
      cwd: process.env.CANVASTTY_PROVIDER_SMOKE_CWD || app.getPath("temp"),
      targets,
      providerClis: providerClis!
    });
    console.log("CANVASTTY_PROVIDER_SMOKE_READY");
    app.quit();
  }
}

function parseProviderSmokeTargets(value: string): ProviderSmokeTarget[] {
  const allowed = new Set<ProviderSmokeTarget>(["direct", "claude", "codex", "qwen", "kimi", "opencode", "hermes"]);
  const targets = value.split(",").map((target) => target.trim()).filter(Boolean);
  if (targets.length === 0 || targets.some((target) => !allowed.has(target as ProviderSmokeTarget))) {
    throw new Error("CANVASTTY_PROVIDER_SMOKE contains an unsupported target.");
  }
  return targets as ProviderSmokeTarget[];
}

async function startApplication(): Promise<void> {
  // A quit already under way owns the process: starting (or restarting) into it
  // would build services for a window the user just closed.
  if (startupRunning || shutdownRunning || shutdownComplete) return;
  startupRunning = true;
  let window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;

  try {
    if (!window) window = await createWindow();
    if (process.env.CANVASTTY_CLI_RESOLUTION_SMOKE === "1") {
      const registry = buildProviderCliRegistry();
      console.log(`CANVASTTY_CLI_RESOLUTION_SMOKE_READY ${JSON.stringify(registry.snapshot())}`);
      app.quit();
      return;
    }
    // Closing the window cancels the rest of startup: the user decided to quit,
    // and every remaining step targets that window. The window is visible from
    // the first moment, so this close can land inside any startup await.
    if (shutdownRunning || shutdownComplete || shellWindowGone(window)) return;
    if (!servicesReady) await initializeServices();
    if (shutdownRunning || shutdownComplete || shellWindowGone(window)) return;
    initializeUpdater();
    await loadApplication(window);
  } catch (error) {
    // A load aborted by that same close surfaces here as ERR_FAILED or
    // "Object has been destroyed" — a normal exit, not a startup failure.
    const startupWindow = window ?? mainWindow;
    if (shutdownRunning || shutdownComplete || (startupWindow !== null && shellWindowGone(startupWindow))) {
      console.warn("CanvasTTY startup stopped: its window is gone, the application is closing.", error);
      return;
    }
    if (startupWindow) await showStartupFailure(startupWindow, error);
    else {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error("CanvasTTY could not create its startup window.", error);
      dialog.showErrorBox("CanvasTTY startup failed", detail);
    }
  } finally {
    startupRunning = false;
  }
}

function buildProviderCliRegistry(): ProviderCliRegistry {
  const providerSmoke = process.env.CANVASTTY_PROVIDER_SMOKE;
  const smokeOverrides = providerSmoke ? {
    ...(process.env.CANVASTTY_PROVIDER_SMOKE_KIMI_COMMAND
      ? { kimi: process.env.CANVASTTY_PROVIDER_SMOKE_KIMI_COMMAND }
      : {}),
    ...(process.env.CANVASTTY_PROVIDER_SMOKE_CLAUDE_COMMAND
      ? { claude: process.env.CANVASTTY_PROVIDER_SMOKE_CLAUDE_COMMAND }
      : {}),
    ...(process.env.CANVASTTY_PROVIDER_SMOKE_CODEX_COMMAND
      ? { codex: process.env.CANVASTTY_PROVIDER_SMOKE_CODEX_COMMAND }
      : {}),
    ...(process.env.CANVASTTY_PROVIDER_SMOKE_QWEN_COMMAND
      ? { qwen: process.env.CANVASTTY_PROVIDER_SMOKE_QWEN_COMMAND }
      : {}),
    ...(process.env.CANVASTTY_PROVIDER_SMOKE_OPENCODE_COMMAND
      ? { opencode: process.env.CANVASTTY_PROVIDER_SMOKE_OPENCODE_COMMAND }
      : {}),
    ...(process.env.CANVASTTY_PROVIDER_SMOKE_HERMES_COMMAND
      ? { hermes: process.env.CANVASTTY_PROVIDER_SMOKE_HERMES_COMMAND }
      : {})
  } : undefined;
  const resolutionSmoke = process.env.CANVASTTY_CLI_RESOLUTION_SMOKE === "1";
  return createProviderCliRegistry({
    ...(smokeOverrides ? { overrides: smokeOverrides } : {}),
    ...(resolutionSmoke && process.env.CANVASTTY_CLI_RESOLUTION_SMOKE_ROOT
      ? { platformRoot: process.env.CANVASTTY_CLI_RESOLUTION_SMOKE_ROOT }
      : {}),
    ...(resolutionSmoke && process.env.CANVASTTY_CLI_RESOLUTION_SMOKE_HOME
      ? { homeDirectory: process.env.CANVASTTY_CLI_RESOLUTION_SMOKE_HOME }
      : {})
  });
}

async function showStartupFailure(window: BrowserWindow, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  if (window.isDestroyed()) {
    console.error("CanvasTTY startup failed.", error);
    dialog.showErrorBox("CanvasTTY startup failed", detail);
    return;
  }

  try {
    await window.loadURL(startupPageUrl({ locale: app.getLocale(), isMacOS: process.platform === "darwin", error: detail }));
    // Reported only once the diagnostic is really on screen: a close that aborts
    // this very load would otherwise log a failure the user never saw, which is
    // the same false signal as the dialog it replaced.
    console.error("CanvasTTY startup failed.", error);
    window.show();
  } catch {
    // The window went away while the failure page was loading: there is nobody
    // left to read the dialog, so it must not become the last thing on screen.
    if (shellWindowGone(window)) {
      console.warn("CanvasTTY startup failure page stopped: its window is gone, the application is closing.");
      return;
    }
    console.error("CanvasTTY startup failed.", error);
    dialog.showErrorBox("CanvasTTY startup failed", detail);
  }
}

/** Notification body for the two statuses that deserve the user's attention. */
function attentionStatusLabel(status: "needs_approval" | "failed", locale: LocaleId): string {
  if (status === "needs_approval") return locale === "ru" ? "Требуется подтверждение" : "Needs approval";
  return locale === "ru" ? "Сессия завершилась с ошибкой" : "Session failed";
}

// Self-update. electron-updater is packaged-only: in dev, or when the feed
// cannot be reached, the honest state is `unavailable` — never an exception.

/** Pushes the current updater state; also runs on every renderer load. */
function broadcastUpdaterState(): void {
  const event: UpdaterStateEvent = { state: updaterState };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.updaterState, event);
  }
}

function publishUpdaterState(state: UpdaterState): void {
  updaterState = state;
  broadcastUpdaterState();
}

function initializeUpdater(): void {
  if (updaterInitialized) return;
  updaterInitialized = true;
  if (!app.isPackaged) {
    publishUpdaterState({ status: "unavailable", reason: "dev" });
    return;
  }

  // The user decides when to download (the settings row), while an update that
  // is already on disk installs itself on quit.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  let availableVersion = "";
  autoUpdater.on("checking-for-update", () => publishUpdaterState({ status: "checking" }));
  autoUpdater.on("update-available", (info) => {
    availableVersion = info.version;
    publishUpdaterState({ status: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", () => publishUpdaterState({ status: "idle" }));
  autoUpdater.on("download-progress", (progress) => {
    publishUpdaterState({
      status: "downloading",
      version: availableVersion || app.getVersion(),
      percent: Number.isFinite(progress.percent) ? Math.round(progress.percent) : null
    });
  });
  autoUpdater.on("update-downloaded", (info) => publishUpdaterState({ status: "downloaded", version: info.version }));
  // Without a listener EventEmitter would rethrow an updater error.
  autoUpdater.on("error", (error) => {
    publishUpdaterState({ status: "unavailable", reason: updaterFailureReason(error) });
  });
  void requestUpdaterCheck();
}

/**
 * Renderer "check for updates" intent. A release that was already found is
 * what the row's Download action fetches: autoDownload is off, so only this
 * second request actually pulls the update down.
 */
async function requestUpdaterCheck(): Promise<void> {
  if (!app.isPackaged) {
    publishUpdaterState({ status: "unavailable", reason: "dev" });
    return;
  }
  if (updaterState.status === "downloading" || updaterState.status === "downloaded") return;
  try {
    if (updaterState.status === "available") await autoUpdater.downloadUpdate();
    else {
      publishUpdaterState({ status: "checking" });
      await autoUpdater.checkForUpdates();
    }
  } catch (error) {
    publishUpdaterState({ status: "unavailable", reason: updaterFailureReason(error) });
  }
}

/** Renderer "install" intent; only meaningful once a download finished. */
function installUpdaterUpdate(): void {
  if (updaterState.status !== "downloaded") return;
  autoUpdater.quitAndInstall();
}

function updaterFailureReason(error: unknown): "offline" | "error" {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|ERR_INTERNET_DISCONNECTED|getaddrinfo/i
    .test(`${code} ${message}`)
    ? "offline"
    : "error";
}

if (hasSingleInstanceLock) {
  void app.whenReady()
    .then(startApplication)
    .catch((error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error("CanvasTTY could not create its startup window.", error);
      dialog.showErrorBox("CanvasTTY startup failed", detail);
      app.quit();
    });

  app.on("activate", () => {
    if (app.isReady() && !shutdownRunning && BrowserWindow.getAllWindows().length === 0) void startApplication();
  });

  // The rejected second launch exits silently (the lock is never released), so
  // raising the running window has to happen here — otherwise the user clicks
  // the app again and nothing at all appears to happen.
  app.on("second-instance", () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (!window) {
      // No shell window to raise: still starting (it shows its window anyway) or
      // closed on macOS, where the app outlives it — rebuild through the same
      // path as "activate".
      if (app.isReady()) void startApplication();
      return;
    }
    if (window.isMinimized()) window.restore();
    // macOS leaves a background app behind the active one on focus() alone.
    if (process.platform === "darwin") app.focus({ steal: true });
    window.show();
    window.focus();
  });
}

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownRunning) return;
  shutdownRunning = true;
  void shutdownServices().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
// Crash diagnostics: a lost GPU or utility child is logged with its reason; the
// window itself recovers through render-process-gone in createWindow.
app.on("child-process-gone", (_event, details) => {
  const service = details.serviceName ? `, service=${details.serviceName}` : "";
  console.warn(
    `CanvasTTY child process exited: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}${service}.`
  );
});

// Keep shared event names in the main bundle so accidental channel drift fails at build time.
void IPC.terminalData;

async function shutdownServices(): Promise<void> {
  if (agentControl) await Promise.allSettled([agentControl.close()]);
  for (const request of browserRequests.values()) { clearTimeout(request.timer); request.reject(new Error("App closing")); }
  browserRequests.clear();
  await evenG2?.close();
  if (terminalManager) await terminalManager.shutdown();
  limitsService?.dispose();
  if (agentGateway) await Promise.allSettled([agentGateway.close()]);
  if (runtimeGateway) await Promise.allSettled([runtimeGateway.close()]);
  if (browserService) await Promise.allSettled([browserService.dispose()]);
  if (pluginManager) await Promise.allSettled([pluginManager.dispose()]);
}

async function openPluginWindow(pluginId: string, contributionId: string): Promise<void> {
  if (!pluginManager) throw new Error("Plugin manager is not ready.");
  const contribution = pluginManager.contribution(pluginId, contributionId);
  if (contribution.kind !== "window") throw new Error("Plugin contribution is not a separate window.");

  const window = new BrowserWindow({
    width: contribution.defaultSize.width,
    height: contribution.defaultSize.height,
    minWidth: contribution.minSize?.width ?? 320,
    minHeight: contribution.minSize?.height ?? 220,
    title: contribution.title,
    backgroundColor: "#353442",
    webPreferences: {
      preload: join(__dirname, "../preload/plugin.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--canvastty-plugin-id=${encodeURIComponent(pluginId)}`,
        `--canvastty-contribution-id=${encodeURIComponent(contributionId)}`
      ]
    }
  });
  pluginWindows.set(window, pluginId);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`canvastty-plugin://${pluginId}/`)) event.preventDefault();
  });
  window.on("closed", () => pluginWindows.delete(window));
  await window.loadURL(pluginManager.entryUrl(pluginId, contributionId));
}

function closePluginWindows(pluginId: string): void {
  for (const [window, ownerPluginId] of pluginWindows) {
    if (ownerPluginId !== pluginId) continue;
    pluginWindows.delete(window);
    if (!window.isDestroyed()) window.close();
  }
}

function requestPluginLauncher(provider: import("../shared/contracts").ProviderId): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(IPC.pluginsLauncherRequested, { provider });
}

function requestPluginCanvas(request: PluginCanvasRequest): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(IPC.pluginsCanvasRequested, request);
}

function broadcastPluginStorageChange(pluginId: string, key: string, value: unknown): void {
  const change = { pluginId, key, value };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.pluginsStorageChanged, change);
  }
  for (const [window, ownerPluginId] of pluginWindows) {
    if (ownerPluginId !== pluginId || window.isDestroyed()) continue;
    window.webContents.send(IPC.pluginsStorageChanged, change);
  }
}

function securePluginStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}
