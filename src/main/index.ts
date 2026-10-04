import "./stdio";
import appIcon from "../../build/icon.png?asset";
import appManifest from "../../package.json";
import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { EvenG2Controller } from "./services/companion/EvenG2Controller";
import { join } from "node:path";
import { app, BrowserWindow, dialog, Menu, net, Notification, protocol, safeStorage, session } from "electron";
import {
  IPC,
  type LocaleId,
  type PluginCanvasRequest,
  type PluginServiceEvent,
  type SessionStatus
} from "../shared/contracts";
import { registerCriticalIpc, registerIpc } from "./ipc/registerIpc";
import { IpcReadinessGate, type IpcRegistrar } from "./ipc/IpcReadinessGate";
import { registerUpdateIpc } from "./ipc/updateIpc";
import { registerDiagnosticIpc } from "./ipc/diagnosticIpc";
import { DiagnosticLog } from "./services/DiagnosticLog";
import { UpdateController, type UpdateAdapter } from "./services/updates/UpdateController";
import { ManualReleaseAdapter } from "./services/updates/ManualReleaseAdapter";
import { SettingsStore } from "./services/SettingsStore";
import { FileAccessService } from "./services/FileAccessService";
import { SkinRegistry } from "./services/SkinRegistry";
import { PixelSkinPackRegistry } from "./services/PixelSkinPackRegistry";
import { TerminalManager, reachesObservers, reachesRenderer } from "./services/TerminalManager";
import { TerminalRendererOutbox } from "./services/TerminalRendererOutbox";
import { AgentControlGateway } from "./services/agent-control/AgentControlGateway";
import { TerminalSessionStore } from "./services/TerminalSessionStore";
import { AgentChatHistoryService } from "./services/AgentChatHistoryService";
import { LimitsService } from "./services/LimitsService";
import {
  createProviderCliRegistry,
  providerCliAvailability,
  type ProviderCliRegistry
} from "./services/providerCliRegistry";
import { PluginManager } from "./services/PluginManager";
import { PluginServiceSupervisor } from "./services/PluginServiceSupervisor";
import { LaunchPipeline } from "./services/LaunchPipeline";
import { EnvironmentRegistry } from "./services/EnvironmentRegistry";
import { DecisionHooks } from "./services/DecisionHooks";
import { SecretRedactionRegistry } from "./services/safety/SecretRedaction";
import { canvasTtyPrivateData } from "./services/safety/baseProtection";
import { PluginAgentTools } from "./services/PluginAgentTools";
import { PluginSessions } from "./services/PluginSessions";
import { PluginCards } from "./services/PluginCards";
import { GithubAuthService } from "./services/GithubAuthService";
import { PluginMediaService } from "./services/PluginMediaService";
import { PluginSecretsService } from "./services/PluginSecretsService";
import { ProviderSecretsService } from "./services/ProviderSecretsService";
import { listProviderDirectory, type ProviderDirectorySources } from "./services/providerDirectory";
import { ProviderModelCatalog } from "./services/providerModels";
import { AgentControlService } from "./services/AgentControlService";
import { AgentIsolation } from "./services/isolation/AgentIsolation";
import type { AgentProviderId, LaunchProfileId } from "../shared/contracts";
import { HermesHudService } from "./services/HermesHudService";
import { BrowserService, type BrowserServiceOptions } from "./services/BrowserService";
import { CanvasNavigationInputController } from "./services/CanvasNavigationOverride";
import { activeCanvasWheelBinding } from "../shared/canvasNavigation";
import type { ProviderSmokeTarget } from "./services/browser/ProviderElectronSmoke";
import {
  AgentBrowserBridge,
  OrchestrationGateway,
  OrchestrationBridge,
  ScopedOrchestrationHandler,
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
  ClaudeHttpHookPolicy,
  RuntimeGateway
} from "./services/agent-runtime";
import type { RuntimeHookHelperLaunch } from "./services/agent-runtime/ProviderRuntimeLaunch";
import { agentHelperLaunches } from "./services/agentHelpers";
import {
  recoverHermesConfigurationOnStartup,
  resolveHermesHomeDirectory
} from "./services/hermesConfig";
import { startupPageUrl } from "./startupPage";
import { mainWindowChromeOptions } from "./windowChrome";
import { markMainBoot, mainBootMarks } from "./bootMarks";
import { macApplicationMenuTemplate } from "./macApplicationMenu";

if (process.env.CANVASTTY_USER_DATA_DIR) {
  if (!isAbsolute(process.env.CANVASTTY_USER_DATA_DIR)) throw new Error("CANVASTTY_USER_DATA_DIR must be absolute");
  app.setPath("userData", process.env.CANVASTTY_USER_DATA_DIR);
  delete process.env.CANVASTTY_USER_DATA_DIR;
}

const diagnostics = new DiagnosticLog(join(app.getPath("userData"), "logs"));
diagnostics.captureConsole();
diagnostics.record("info", "application", "process.started", {
  version: app.getVersion(), platform: process.platform, architecture: process.arch,
  electron: process.versions.electron, packaged: app.isPackaged
});
process.on("uncaughtExceptionMonitor", error => diagnostics.record("error", "main", "uncaught-exception", error));
process.on("warning", warning => diagnostics.record("warn", "main", "process.warning", warning));
let diagnosticContext: () => unknown = () => ({ servicesReady: false });

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

/** A contributed browser engine may have to start its process before it can open a tab. */
const BROWSER_ENGINE_OPEN_TIMEOUT_MS = 20_000;
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
let pluginServices: PluginServiceSupervisor | null = null;
let pluginSessions: PluginSessions | null = null;
let pluginCards: PluginCards | null = null;
let githubAuth: GithubAuthService | null = null;
let pluginMediaService: PluginMediaService | null = null;
let pluginSecretsService: PluginSecretsService | null = null;
let providerSecretsService: ProviderSecretsService | null = null;
let hermesHudService: HermesHudService | null = null;
let agentChatHistory: AgentChatHistoryService | null = null;
let browserService: BrowserService | null = null;
let canvasNavigationInput: CanvasNavigationInputController | null = null;
let agentGateway: AgentGateway | null = null;
let orchestrationGateway: OrchestrationGateway | null = null;
let agentBrowserBridge: AgentBrowserBridge | null = null;
let agentBrowserHelper: StdioHelperLaunch | null = null;
let runtimeGateway: RuntimeGateway | null = null;
let agentRuntimeBridge: AgentRuntimeBridge | null = null;
let agentRuntimeHelper: RuntimeHookHelperLaunch | null = null;
let providerClis: ProviderCliRegistry | null = null;
const pluginWindows = new Map<BrowserWindow, string>();
let servicesReady = false;
let appSurfaceReady = false;
let pendingMenuUpdateCheck = false;
let checkUpdatesFromMenu: (() => void) | null = null;
let installMacMenu: (() => void) | null = null;
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let startupRunning = false;
let shutdownRunning = false;
let shutdownComplete = false;
let observeMainWindowState: ((window: BrowserWindow | null) => void) | null = null;
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

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

/**
 * Creates the shell window. Nothing is loaded into it here: startApplication loads
 * the application surface into it at once, next to the services starting. (An
 * intermediate startup page cost a second renderer navigation before the real one
 * could begin, and replacing a page that is still loading races its ERR_ABORTED
 * into the next load's promise; with one navigation there is nothing to race.)
 */
function createWindow(): BrowserWindow {
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(appIcon);
  markMainBoot("windowCreateStart");
  const window = new BrowserWindow({
    icon: appIcon,
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
  markMainBoot("windowCreated");
  observeMainWindowState?.(window);
  appSurfaceReady = false;
  // A fresh window is not closing; the previous one's flag must not leak in.
  mainWindowClosing = false;

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl && url !== currentUrl) event.preventDefault();
  });
  canvasNavigationInput?.attach(window.webContents, {
    preventMouseBindings: false,
    captureMacEditShortcuts: process.platform === "darwin"
  });
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
  window.on("blur", () => {
    canvasNavigationInput?.reset();
    browserService?.cancelCanvasNavigationGesture();
  });

  // Both handlers are registered before the first load: a close landing inside
  // that load has to be visible to the load's own failure handling, and the dead
  // window must not stay in `mainWindow` until the load settles.
  window.on("close", () => {
    mainWindowClosing = true;
  });
  window.on("closed", () => {
    mainWindowClosing = true;
    if (mainWindow === window) {
      mainWindow = null;
      appSurfaceReady = false;
      observeMainWindowState?.(null);
    }
  });
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

/**
 * Starts every main-process service. It runs next to the application surface load: handlers are registered through
 * `ipc` (the readiness gate) group by group as their services come up — the critical group first, the core group
 * once sessions are restored, the Even G2 companion last — so a renderer call never reaches a service that does not
 * exist yet; it waits for it.
 */
async function initializeServices(ipc: IpcRegistrar): Promise<void> {
  // Deny-by-default web permissions on the default session: the app window and plugin windows
  // never need camera, microphone, location, notifications or device access. The Browser card uses
  // its own partition with its own policy in BrowserService.
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
  const settings = new SettingsStore(userDataPath, app.getLocale(), process.platform, providerCliAvailability(providerClis));
  const terminalBorderSkins = new SkinRegistry(userDataPath);
  const pixelSkinPacks = new PixelSkinPackRegistry(userDataPath);
  pluginManager = new PluginManager(userDataPath);
  // None of these four reads the others' state; awaiting them one after another only adds their
  // latencies together before the app surface can load. They are independent, so they overlap.
  await Promise.all([
    settings.load(),
    terminalBorderSkins.initialize(),
    pixelSkinPacks.initialize(),
    pluginManager.load()
  ]);
  // The renderer is already loading: what its first frame reads (settings, appearance, CLI availability, installed
  // plugins, window chrome) answers from here on; every other call waits in the gate for its own service group.
  protocol.handle("canvastty-plugin", (request) => pluginManager!.protocolResponse(request.url));
  observeMainWindowState = registerCriticalIpc(ipc, {
    settings,
    terminalBorderSkins,
    pixelSkinPacks,
    providerClis,
    plugins: pluginManager,
    getMainWindow: () => mainWindow
  });
  markMainBoot("criticalServicesReady");
  // Secrets this app knows are masked in every text one agent reads from another (EP-8).
  const redaction = new SecretRedactionRegistry();
  diagnostics.configureRedaction(text => redaction.redact(text));
  diagnosticContext = () => ({
    servicesReady,
    settings: { locale: settings.get().locale, keyboardPreset: settings.get().keyboardPreset,
      uiScale: settings.get().uiScale, sessionRestoreMode: settings.get().sessionRestoreMode },
    sessions: terminalManager?.list().map(({ provider, status, exitCode }) => ({ provider, status, exitCode })) ?? [],
    plugins: pluginManager?.list().map(({ manifest, enabled }) => ({ id: manifest.id, version: manifest.version, enabled })) ?? []
  });
  // Trusted plugin services run as separate processes, started the way plugin hooks are.
  // Services start only once the host APIs they may call on initialize exist (hostReady below).
  pluginServices = new PluginServiceSupervisor({
    waitForHost: true,
    command: process.execPath,
    hostVersion: app.getVersion(),
    locale: () => settings.get().locale,
    host: {
      storageGet: (pluginId, key) => pluginManager!.storageGet(pluginId, key),
      storageSet: async (pluginId, key, value) => {
        await pluginManager!.storageSet(pluginId, key, value);
        broadcastPluginStorageChange(pluginId, key, value);
      },
      emit: (pluginId, serviceId, event, data) => broadcastPluginServiceEvent({ pluginId, serviceId, event, data }),
      registerSecrets: (pluginId, values) => redaction.add(`plugin:${pluginId}`, values),
      secretGet: (pluginId, key) => {
        if (!pluginSecretsService) throw new Error("Plugin secrets are not ready yet.");
        return pluginSecretsService.get(pluginId, key);
      },
      sessions: (pluginId, serviceId, method, params, permissions) => pluginSessions?.handle(pluginId, serviceId, method, params, permissions),
      setBadge: (pluginId, params) => {
        if (!pluginCards) throw new Error("Cards are not ready yet.");
        return pluginCards.setBadge(pluginId, params);
      },
      stopped: (pluginId, serviceId) => pluginSessions?.serviceStopped(pluginId, serviceId)
    }
  });
  // Base protection runs first; then trusted plugin decision services (EP-5).
  const decisionHooks = new DecisionHooks({
    baseProtection: () => settings.get().baseProtectionEnabled,
    services: () => pluginManager!.decisionServices(),
    call: (pluginId, serviceId, method, params, timeoutMs) => pluginServices!.hostCall(pluginId, serviceId, method, params, timeoutMs),
    session: (sessionId) => terminalManager?.decisionContext(sessionId) ?? null,
    privateData: canvasTtyPrivateData(userDataPath)
  });
  pluginManager.setServiceObserver(async (specs) => {
    await pluginServices!.sync(specs);
    // Trust changes add or remove card actions and badges.
    pluginCards?.refresh();
  });
  const pluginServicesStarted = pluginServices.sync(pluginManager.trustedServiceSpecs());
  // Created before sessions are restored: launch services may resolve the plugin's own secrets.
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
    canvasNavigationInput.attach(mainWindow.webContents, {
      preventMouseBindings: false,
      captureMacEditShortcuts: process.platform === "darwin"
    });
  }

  browserService = new BrowserService(() => mainWindow, {
    userDataPath,
    restoreTabs: settings.get().browserRestoreTabs,
    pauseHiddenTabs: settings.get().browserPauseHiddenTabs,
    ...browserLifecycleTimingOverride(process.env.CANVASTTY_BROWSER_LIFECYCLE_MS),
    canvasWheelCaptureMode: settings.get().canvasWheelCaptureMode,
    canvasNavigationInput,
    // Agents' background tabs may run in a plugin-contributed engine (browser:engine); policy stays in the core.
    engines: {
      providers: () => pluginManager!.browserEngineProviders()
        .filter((provider) => pluginServices!.running(provider.pluginId, provider.serviceId)),
      openTab: (provider, tabId) => pluginServices!.hostCall(provider.pluginId, provider.serviceId,
        "canvastty.browserEngine.openTab", { engineId: provider.engineId, tabId }, BROWSER_ENGINE_OPEN_TIMEOUT_MS),
      closeTab: (provider, tabId) => {
        pluginServices?.notify(provider.pluginId, provider.serviceId, "canvastty.browserEngine.closeTab", { engineId: provider.engineId, tabId });
      }
    },
    ...(process.env.CANVASTTY_BROWSER_SMOKE_URL
      ? { downloadRoot: join(userDataPath, "browser-smoke-downloads") }
      : {})
  });
  // The browser store loads next to the gateways below; BrowserService's own methods wait for it, and the core
  // handlers are registered only after it (browserReady below).
  const browserReady = browserService.ready();
  browserService.setCanvasNavigationActive(canvasNavigationInput.active);
  // Stores independent of everything above load meanwhile, not one after another at the end.
  githubAuth = new GithubAuthService(app.getPath("userData"), undefined, {
    fetcher: (input, init) => net.fetch(input, init)
  });
  pluginMediaService = new PluginMediaService(
    app.getPath("userData"),
    (pluginId, permission) => pluginManager!.assertPermission(pluginId, permission)
  );
  providerSecretsService = new ProviderSecretsService(app.getPath("userData"), {
    isAvailable: securePluginStorageAvailable,
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value)
  }, (values) => redaction.add("vault", values));
  const storesLoaded = Promise.all([githubAuth.load(), pluginMediaService.load(), providerSecretsService.load()]);
  // Awaited below; a failure meanwhile must not surface as an unhandled rejection first.
  browserReady.catch(() => undefined);
  storesLoaded.catch(() => undefined);

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
    // The native canvastty-helper where it was built for this platform, the .mjs helpers otherwise.
    const helpers = agentHelperLaunches({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      execPath: process.execPath
    });
    agentBrowserHelper = helpers.browser;
    agentBrowserBridge = new AgentBrowserBridge(agentGateway, {
      helper: agentBrowserHelper,
      orchestrationHelper: helpers.orchestration,
      providerClis,
      runtimeDirectory,
      hermesHomeDirectory,
      kimiHomeDirectory
    });
    // Off the startup path: the first Kimi launch then finds the probe answered instead of blocking on it.
    const bridge = agentBrowserBridge;
    setTimeout(() => void bridge.warmProviderProbes().catch(() => undefined), 5_000).unref();

    const lifecycleRuntimeDirectory = join(userDataPath, "lifecycle", "runtime");
    runtimeGateway = new RuntimeGateway({
      runtimeDirectory: lifecycleRuntimeDirectory,
      windowsHostPath,
      onSignal: (terminalSessionId, signal) => {
        terminalManager?.applyProviderSignal(terminalSessionId, {
          kind: "lifecycle",
          state: signal.state,
          event: signal.event,
          ...(signal.turnId ? { requestId: signal.turnId } : {}),
          ...(signal.threadId ? { threadId: signal.threadId } : {})
        });
        // A subagent's final answer (Codex Stop hook, OpenCode plugin) for get_agent_result and wait_for_agent.
        if (signal.result) terminalManager?.recordAnswer(terminalSessionId, signal.result);
        agentControl?.onSignal(terminalSessionId, signal);
        if (signal.lastAssistantMessage !== undefined && signal.answerCaptureGrantExpiresAt !== undefined) {
          evenG2?.answer(
            terminalSessionId,
            signal.lastAssistantMessage,
            signal.turnId,
            signal.answerCaptureGrantExpiresAt
          );
        }
      },
      onAnswerCaptureRevoked: (terminalSessionId) => evenG2?.clearAnswer(terminalSessionId),
      onPermissionRequest: (terminalSessionId, request, signal) => decisionHooks.decide(terminalSessionId, request, signal),
      // Claude Code's lifecycle hooks go straight to a loopback listener where ClaudeHttpHookPolicy allows it.
      httpHooks: true
    });
    await runtimeGateway.start();
    const openCodePluginPath = app.isPackaged
      ? join(process.resourcesPath, "agent-runtime", "opencode-plugin.mjs")
      : join(app.getAppPath(), "src", "agent-runtime", "opencode-plugin.mjs");
    const pluginHookRunnerPath = app.isPackaged
      ? join(process.resourcesPath, "agent-runtime", "plugin-hook-runner.mjs")
      : join(app.getAppPath(), "src", "agent-runtime", "plugin-hook-runner.mjs");
    agentRuntimeHelper = helpers.hook;
    const claudeHttpHookPolicy = new ClaudeHttpHookPolicy();
    agentRuntimeBridge = new AgentRuntimeBridge(runtimeGateway, {
      helper: agentRuntimeHelper,
      runtimeDirectory: lifecycleRuntimeDirectory,
      openCodePluginPath,
      hermesHomeDirectory,
      kimiHomeDirectory,
      recoverOnStart: true,
      coreHooksEnabled: settings.get().agentLifecycleHooksEnabled,
      permissionGate: helpers.permissionGate,
      wantsDecisions: (provider) => decisionHooks.wanted(provider),
      decisionBudgetMs: (provider) => decisionHooks.budgetMs(provider),
      claudeHttpHooks: (facts) => claudeHttpHookPolicy.verdict(facts),
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

  // Output batches of every session flushed in one task leave as one IPC message.
  const rendererOutbox = new TerminalRendererOutbox((channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload);
  });
  terminalManager = new TerminalManager((channel, payload) => {
    // Output produced while a card is hidden is addressed to the observers
    // only, and the replay when it is shown again to the renderer only; the
    // event says which (TerminalDataEvent.audience).
    if (reachesObservers(payload)) {
      agentControl?.observe(channel, payload);
      evenG2?.observe(channel, payload);
      pluginSessions?.observe(channel, payload);
      if (channel === IPC.terminalRemoved && "id" in payload) pluginCards?.forgetSession(payload.id);
    }
    if (reachesRenderer(payload)) rendererOutbox.push(channel, payload);
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
      if (previousStatus !== status) diagnostics.record(status === "failed" ? "error" : "info", "terminal", "session.state", {
        id, provider, status, exitCode: payload.session.exitCode
      });
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
      diagnostics.record("info", "terminal", "session.closed", { id: payload.id });
      notifiedAttentionStatus.delete(payload.id);
    }
  }, providerClis, agentBrowserBridge ?? undefined, agentRuntimeBridge ?? undefined, settings.get().agentLifecycleHooksEnabled);
  terminalManager.configureRedaction(redaction);
  terminalManager.setKeyboardShortcuts(settings.get().shortcuts);
  // The operating-system isolation layer (Settings → Agents → Agent isolation) and YOLO only where the person
  // acknowledged it: both decided here, in the main process, for every launch whoever asks for it.
  terminalManager.configureIsolation(new AgentIsolation({ userDataPath, enabled: () => settings.get().agentIsolation !== "off" }));
  terminalManager.configureYoloAcknowledgement((provider) => settings.get().acknowledgedDangerousProfiles.includes(provider as AgentProviderId));
  // OpenCode's auto profile runs shell commands without asking only while base protection guards them.
  terminalManager.configureBaseProtection(() => settings.get().baseProtectionEnabled);
  const terminalSessionStore = new TerminalSessionStore(userDataPath);
  terminalManager.configureSessionPersistence(terminalSessionStore, settings.get().sessionRestoreMode);
  agentChatHistory = new AgentChatHistoryService(settings, providerClis, terminalManager, hermesHomeDirectory);

  // Plugin services see card events and control only the cards they start (EP-4).
  const sessionsForPlugins = new PluginSessions({
    terminals: terminalManager,
    notify: (pluginId, serviceId, method, params) => pluginServices!.notify(pluginId, serviceId, method, params)
  });
  pluginSessions = sessionsForPlugins;
  // Plugin tools in canvastty_agents (EP-6), for sessions whose role a tool lists.
  const pluginTools = new PluginAgentTools({
    providers: () => pluginManager!.agentToolProviders()
      .filter((provider) => pluginServices!.running(provider.pluginId, provider.serviceId)),
    call: (pluginId, serviceId, method, params, timeoutMs) => pluginServices!.hostCall(pluginId, serviceId, method, params, timeoutMs),
    caller: (sessionId) => sessionsForPlugins.summary(sessionId),
    redact: (text) => redaction.redact(text)
  });
  // Card badges and actions (EP-7).
  pluginCards = new PluginCards({
    providers: () => pluginManager!.cardActionProviders(),
    trustedPlugins: () => new Set(pluginManager!.trustedServiceSpecs().map((spec) => spec.pluginId)),
    call: (pluginId, serviceId, method, params, timeoutMs) => pluginServices!.hostCall(pluginId, serviceId, method, params, timeoutMs),
    session: (sessionId) => sessionsForPlugins.summary(sessionId),
    redact: (text) => redaction.redact(text),
    changed: (decorations) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(IPC.pluginsCardDecorationsChanged, decorations);
      }
    }
  });

  // list_providers: the CLI registry resolved at startup, the last usage read (never started from here) and the
  // launch options trusted plugins declared.
  const providerModels = new ProviderModelCatalog(providerClis);
  // OpenCode with a model it does not list fails with only "Unexpected server error": refuse it up front.
  terminalManager.configureModelCheck((provider, model) => provider === "terminal" ? null : providerModels.unknownModelCached(provider, model));
  const providerDirectorySources: ProviderDirectorySources = {
    cli: (provider) => providerClis?.get(provider).state ?? null,
    models: (provider) => providerModels.peek(provider),
    checkModel: (provider, model) => providerModels.unknownModel(provider, model, { fresh: true }),
    limits: () => limitsService?.peek() ?? null,
    launchContributors: () => pluginManager?.launchContributors() ?? [],
    containment: () => terminalManager?.containment() === true
  };
  // The orchestration bridge exists only for sessions launched with the
  // orchestrator role, or with a role a trusted plugin tool lists (EP-6);
  // other sessions never receive capabilities.
  // Every delegation (spawn_agent, an orchestrator's own control connection) goes through this one service: the
  // person's limits, profile ceilings, project folder and isolation rules apply the same way to each.
  const managedTerminals = terminalManager;
  const agentControlService = new AgentControlService(managedTerminals, {
    limits: () => ({ maxDepth: settings.get().orchestrationMaxDepth, maxSubagents: settings.get().orchestrationMaxSubagents }),
    containment: () => managedTerminals.containment()
  });
  orchestrationGateway = new OrchestrationGateway({
    runtimeDirectory: join(userDataPath, "orchestration", "runtime"),
    windowsHostPath: process.platform === "win32"
      ? app.isPackaged
        ? join(process.resourcesPath, "agent-browser", WINDOWS_PIPE_HOST_FILENAME)
        : join(app.getAppPath(), "build", "windows-agent-pipe-host", WINDOWS_PIPE_HOST_FILENAME)
      : undefined,
    handler: new ScopedOrchestrationHandler(agentControlService, pluginTools, providerDirectorySources)
  });
  await orchestrationGateway.start();
  terminalManager.configureOrchestration(new OrchestrationBridge(orchestrationGateway));
  terminalManager.configureAgentTools((role, provider) => pluginTools.names(role, provider));

  const launchPipeline = new LaunchPipeline({
    contributors: () => pluginManager!.launchContributors(),
    call: (pluginId, serviceId, method, params, timeoutMs) => pluginServices!.hostCall(pluginId, serviceId, method, params, timeoutMs),
    secret: (pluginId, key) => pluginSecretsService!.get(pluginId, key),
    runsRoot: join(userDataPath, "launch-runs")
  });
  await launchPipeline.clearRuns().catch(() => undefined);
  terminalManager.configureLaunchPipeline(launchPipeline);
  terminalManager.configureEnvironments(new EnvironmentRegistry({
    providers: () => pluginManager!.environmentProviders(),
    call: (pluginId, serviceId, method, params, timeoutMs) => pluginServices!.hostCall(pluginId, serviceId, method, params, timeoutMs),
    secret: (pluginId, key) => pluginSecretsService!.get(pluginId, key)
  }));
  // Every host API a service may call exists now (sessions, cards, tools, secrets, launch, environments): services
  // start, and one that subscribes on initialize does so before the restored cards' events. Restored cards with
  // launch options or an environment ask their plugin's service, so start services first.
  pluginServices.hostReady();
  await pluginServicesStarted.catch(() => undefined);
  await terminalManager.restorePersistedSessions();
  // The agent-control endpoint follows Settings → Agents → "Agent orchestration
  // endpoint"; the start flag / env var force it on for one launch (CI smoke)
  // regardless of the setting. Start and stop are serialised so a quick toggle
  // never races two gateways. Stopping disposes owned sessions' terminals
  // (gateway.close) and withdraws the descriptor from future orchestrators.
  const agentControlForced = process.argv.includes("--agent-control") || process.env.CANVASTTY_AGENT_CONTROL === "1";
  const agentControlCliPath = app.isPackaged
    ? join(process.resourcesPath, "agent-control", "canvastty-control.mjs")
    : join(app.getAppPath(), "scripts", "canvastty-control.mjs");
  const startAgentControl = async (): Promise<void> => {
    if (agentControl || !terminalManager) return;
    const windowsHostPath = process.platform === "win32"
      ? app.isPackaged
        ? join(process.resourcesPath, "agent-browser", WINDOWS_PIPE_HOST_FILENAME)
        : join(app.getAppPath(), "build", "windows-agent-pipe-host", WINDOWS_PIPE_HOST_FILENAME)
      : undefined;
    const gateway = new AgentControlGateway({ userDataPath, terminals: terminalManager, pixelSkinPacks, settings,
      lifecycleEnabled: () => Boolean(runtimeGateway) && settings.get().agentLifecycleHooksEnabled,
      onSettingsChanged: (updated) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.settingsChanged, updated);
      },
      // The CLI's create takes no plugin launch options, so none are listed.
      providers: () => listProviderDirectory({ cli: providerDirectorySources.cli, limits: providerDirectorySources.limits,
        models: providerDirectorySources.models }),
      checkModel: (provider, model) => providerModels.unknownModel(provider, model, { fresh: true }),
      spawnSubagent: (request) => agentControlService.spawn({ parentSessionId: request.parentSessionId, provider: request.provider,
        cwd: request.cwd, ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.profile !== undefined ? { profile: request.profile as LaunchProfileId } : {}),
        ...(request.model !== undefined ? { model: request.model } : {}), ...(request.effort !== undefined ? { effort: request.effort } : {}) }),
      windowsHostPath });
    agentControl = gateway;
    try {
      const connection = await gateway.start();
      // Orchestrator sessions get a connection of their own (grantSession), never the app-wide descriptor.
      terminalManager.setControlConnection({ connectionPath: connection, cliPath: agentControlCliPath,
        grant: (sessionId) => gateway.grantSession(sessionId) });
      console.log(`CANVASTTY_AGENT_CONTROL_READY ${connection}`);
    } catch {
      if (agentControl === gateway) agentControl = null;
      await gateway.close().catch(() => undefined);
      console.warn("CanvasTTY agent control could not start; normal terminal operation is unchanged.");
    }
  };
  const stopAgentControl = async (): Promise<void> => {
    const gateway = agentControl;
    if (!gateway) return;
    agentControl = null;
    terminalManager?.setControlConnection(null);
    await gateway.close().catch(() => undefined);
  };
  let agentControlTransition: Promise<void> = Promise.resolve();
  const applyAgentControlSetting = (enabled: boolean): Promise<void> => {
    agentControlTransition = agentControlTransition
      .then(() => (enabled || agentControlForced ? startAgentControl() : stopAgentControl()))
      .catch(() => undefined);
    return agentControlTransition;
  };
  await applyAgentControlSetting(settings.get().agentControlEnabled);
  limitsService = new LimitsService(providerClis, app.getVersion());
  await Promise.all([browserReady, storesLoaded]);
  pluginManager.registerTokenProvider(() => githubAuth!.getToken());
  protocol.handle("canvastty-media", (request) => pluginMediaService!.protocolResponse(request));
  // Session roots resolve a sessionId to the terminal's current working
  // directory through TerminalManager's metadata snapshots; the renderer never
  // supplies a path. Folder roots come from the native dialog or a persisted
  // folderPath on restore.
  const fileAccessService = new FileAccessService({
    resolveSessionCwd: (sessionId) =>
      terminalManager?.listMetadata().find((session) => session.id === sessionId)?.cwd
  });
  registerIpc(ipc, {
    settings,
    recheckProviderClis: async () => {
      providerClis!.refresh();
      agentBrowserBridge?.providerClisRefreshed();
      void agentBrowserBridge?.warmProviderProbes().catch(() => undefined);
      await limitsService!.providerClisRefreshed();
      const availability = providerCliAvailability(providerClis!);
      const updatedSettings = await settings.setAvailableProviders(availability);
      return { availability, settings: updatedSettings };
    },
    terminals: terminalManager,
    limits: limitsService,
    agentChatHistory,
    plugins: pluginManager,
    pluginServices,
    pluginCards,
    pluginMedia: pluginMediaService,
    pluginSecrets: pluginSecretsService,
    providerSecrets: providerSecretsService!,
    browser: browserService,
    files: fileAccessService,
    githubAuth: githubAuth!,
    hermesHud: hermesHudService,
    launchFieldOptions: (pluginId, provider) => launchPipeline.fieldOptions(pluginId, provider),
    getMainWindow: () => mainWindow,
    applyBrowserSettings: async (next) => {
      terminalManager?.setKeyboardShortcuts(next.shortcuts);
      installMacMenu?.();
      agentRuntimeBridge?.setCoreHooksEnabled(next.agentLifecycleHooksEnabled);
      terminalManager?.setLifecycleHooksEnabled(next.agentLifecycleHooksEnabled);
      // Awaited so the renderer's settings.update resolves with the endpoint live
      // (the launch dialog enables it right before launching an orchestrator).
      await applyAgentControlSetting(next.agentControlEnabled);
      agentBrowserBridge?.setEnabled(next.browserAgentAccess);
      browserService?.setRestoreTabs(next.browserRestoreTabs).catch((error: unknown) => {
        console.warn("CanvasTTY browser tab restore setting could not be applied.", error);
      });
      browserService?.setPauseHiddenTabs(next.browserPauseHiddenTabs);
      browserService?.cancelCanvasNavigationGesture();
      browserService?.setCanvasWheelCaptureMode(next.canvasWheelCaptureMode);
      canvasNavigationInput?.setBindings({
        wheelBinding: activeCanvasWheelBinding(next.canvasWheelCaptureMode, next.canvasWheelOverride),
        navigationBinding: next.canvasNavigationOverride
      });
      await terminalManager?.setSessionRestoreMode(next.sessionRestoreMode);
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
    broadcastPluginStorageChange
  });
  markMainBoot("coreServicesReady");
  // The Even G2 companion is the last group: nothing on the first frame needs it.
  evenG2 = new EvenG2Controller({
    userDataPath, terminals: terminalManager,
    localDiscovery: process.platform === "darwin",
    defaultWorkspace: join(app.getPath("documents"), "CanvasTTY Projects"),
    bundledSpeech: process.platform === "darwin" ? (app.isPackaged ? join(process.resourcesPath, "companion/speech/canvastty-speech") : join(app.getAppPath(), "artifacts/companion-speech", process.arch, "canvastty-speech")) : undefined,
    webRoot: app.isPackaged ? join(process.resourcesPath,"even-g2-web") : join(app.getAppPath(),"integrations/even-g2/dist"),
    mobileRoot: app.isPackaged ? join(process.resourcesPath, "mobile-web") : join(app.getAppPath(), "integrations/mobile/dist"),
    providerAvailability: () => providerCliAvailability(providerClis!),
    speechWorker: app.isPackaged ? join(process.resourcesPath,"companion/asr_worker.py") : join(app.getAppPath(),"src/main/services/companion/asr_worker.py"),
    limits: () => limitsService!.get(), openBrowser: showCompanionBrowser
  });
  await evenG2.load();
  const assertCompanionSender = (event: Electron.IpcMainInvokeEvent):void => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("Untrusted companion caller");
  };
  ipc.handle(IPC.evenG2State, event => { assertCompanionSender(event); return evenG2!.state(); });
  ipc.handle(IPC.evenG2Command, async (event, command) => { assertCompanionSender(event); return evenG2!.command(command); });
  const manuallyInstalled = !app.isPackaged || (process.platform === "win32" && Boolean(process.env.PORTABLE_EXECUTABLE_FILE));
  let updateAdapter: UpdateAdapter;
  if (manuallyInstalled || (process.platform === "darwin" && process.arch !== "arm64")) {
    updateAdapter = new ManualReleaseAdapter();
  } else if (process.platform === "darwin") {
    const { MacSparkleUpdater } = await import("./services/updates/MacSparkleUpdater");
    updateAdapter = new MacSparkleUpdater(userDataPath, dirname(dirname(dirname(app.getPath("exe")))),
      join(process.resourcesPath, "..", "MacOS", "canvastty-update-helper"),
      join(process.resourcesPath, "updates", "mac-update-server.mjs"), app.getVersion());
  } else {
    const { ElectronUpdaterAdapter } = await import("./services/updates/ElectronUpdaterAdapter");
    updateAdapter = new ElectronUpdaterAdapter();
  }
  const update = new UpdateController(updateAdapter, app.getVersion());
  update.onStatus(status => diagnostics.record(status.type === "error" ? "error" : "info", "updates", "state.changed", {
    type: status.type, ...(status.type === "error" ? { message: status.message } : {}),
    ...(status.type === "available" || status.type === "ready" ? { version: status.version } : {}),
    ...(status.type === "downloading" ? { percent: status.percent } : {})
  }));
  registerUpdateIpc(ipc, update, settings, terminalManager, () => mainWindow);
  if (process.platform === "darwin") {
    checkUpdatesFromMenu = () => {
      const window = mainWindow;
      if (!appSurfaceReady || !window || window.isDestroyed() || window.webContents.isDestroyed()) {
        pendingMenuUpdateCheck = true;
        if (!startupRunning && !shutdownRunning && !shutdownComplete) void startApplication();
        return;
      }
      if (window.isMinimized()) window.restore();
      window.show();
      app.focus({ steal: true });
      window.focus();
      window.webContents.send(IPC.windowOpenUpdates);
      void update.check().catch(error => console.warn("Menu update check failed:", error));
    };
    let installedLocale: string | null = null;
    installMacMenu = () => {
      const locale = settings.get().locale;
      if (locale === installedLocale) return;
      Menu.setApplicationMenu(Menu.buildFromTemplate(
        macApplicationMenuTemplate("CanvasTTY", locale, () => checkUpdatesFromMenu?.())
      ));
      installedLocale = locale;
    };
  }
  if (app.isPackaged) {
    updateTimer = setTimeout(() => {
      if (update.status().type !== "idle") return;
      void update.check().catch(error => console.warn("Automatic update check failed:", error));
    }, 30_000);
    updateInterval = setInterval(() => {
      if (["checking", "downloading", "ready", "installing"].includes(update.status().type)) return;
      void update.check().catch(error => console.warn("Automatic update check failed:", error));
    }, 60 * 60 * 1000);
  }
  servicesReady = true;
  markMainBoot("servicesReady");
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
    // Mouse4 is a supported application shortcut, but Chromium also treats it
    // as History Back. Remove the startup screen from this WebContents history
    // once the application surface is ready.
    window.webContents.navigationHistory.clear();
  } catch (error) {
    // Closing during the load is a normal exit, not a failed startup.
    if (!shellWindowGone(window)) throw error;
    console.warn("CanvasTTY application surface load stopped: its window is gone, the application is closing.", error);
    return;
  }
}

/** Test-only startup hooks (smoke runs behind env flags), once the surface and the services are up. */
async function runStartupSmokes(window: BrowserWindow): Promise<void> {
  if (process.env.CANVASTTY_SMOKE_TEST === "1") {
    await window.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    );
    console.log("CANVASTTY_SMOKE_READY");
    app.quit();
  }
  const browserSmokeUrl = process.env.CANVASTTY_BROWSER_SMOKE_URL;
  if (browserSmokeUrl && browserService) {
    // The smoke runners are test code: they load only when a smoke run asks for them.
    const { runBrowserElectronSmoke } = await import("./services/browser/BrowserElectronSmoke");
    await runBrowserElectronSmoke(browserService, browserSmokeUrl, app.getPath("userData"));
    console.log("CANVASTTY_BROWSER_SMOKE_READY");
    app.quit();
  }
  const providerSmoke = process.env.CANVASTTY_PROVIDER_SMOKE;
  if (providerSmoke) {
    if (!agentBrowserBridge || !agentBrowserHelper) {
      throw new Error("Provider smoke requires the local agent browser gateway.");
    }
    const targets = parseProviderSmokeTargets(providerSmoke);
    const { runProviderElectronSmoke } = await import("./services/browser/ProviderElectronSmoke");
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

/**
 * The gate every IPC handler is registered through while the services start
 * (IpcReadinessGate): created once, before the first renderer load, with a
 * placeholder on every channel. Browser page wheel channels are left out: only
 * browser tabs send them, and tabs exist only once the browser service does.
 */
let ipcGate: IpcReadinessGate | null = null;
function ipcReadinessGate(): IpcReadinessGate {
  if (ipcGate) return ipcGate;
  const ungated = new Set<string>([IPC.evenG2BrowserResponse, IPC.browserPageWheelDecision, IPC.browserPageWheel]);
  ipcGate = new IpcReadinessGate(ipcMain, {
    onInvokeError: (channel, error) => diagnostics.record("error", "ipc", "invoke.failed", { channel, error }),
    channels: Object.values(IPC).filter((channel) => !ungated.has(channel)),
    // The renderer's synchronous sends block it until they are answered: before the
    // browser service is up there is no browser to route a wheel or focus change to.
    syncReplies: { [IPC.canvasNavigationOwnerWheel]: true, [IPC.browserSetInputFocused]: true }
  });
  registerDiagnosticIpc(ipcGate, diagnostics, () => mainWindow,
    !app.isPackaged && process.env.CANVASTTY_DIAGNOSTICS_URL
      ? process.env.CANVASTTY_DIAGNOSTICS_URL : appManifest.diagnostics.reportUrl,
    () => diagnosticContext());
  return ipcGate;
}

async function startApplication(): Promise<void> {
  // A quit already under way owns the process: starting (or restarting) into it
  // would build services for a window the user just closed.
  if (startupRunning || shutdownRunning || shutdownComplete) return;
  startupRunning = true;
  let window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;

  try {
    if (!window) window = createWindow();
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
    // The application surface loads while the services start: its calls wait in
    // the readiness gate until the service group behind each channel is up.
    const services = servicesReady ? null : initializeServices(ipcReadinessGate());
    markMainBoot("applicationLoadStart");
    const surfaceLoad = loadApplicationSurface(window).then(() => markMainBoot("applicationLoaded"));
    const [surface, started] = await Promise.allSettled([surfaceLoad, services]);
    if (shutdownRunning || shutdownComplete || shellWindowGone(window)) return;
    // Both settled before anything is reported: the failure page must not replace
    // a surface that is still loading (its ERR_ABORTED would land in this load).
    if (started.status === "rejected") {
      ipcGate?.fail(started.reason instanceof Error ? started.reason : new Error(String(started.reason)));
      throw started.reason;
    }
    ipcGate?.settle();
    if (surface.status === "rejected") throw surface.reason;
    appSurfaceReady = true;
    diagnostics.record("info", "startup", "ready", { marks: mainBootMarks() });
    installMacMenu?.();
    if (pendingMenuUpdateCheck) {
      pendingMenuUpdateCheck = false;
      checkUpdatesFromMenu?.();
    }
    await runStartupSmokes(window);
  } catch (error) {
    // A load aborted by that same close surfaces here as ERR_FAILED or
    // "Object has been destroyed" — a normal exit, not a startup failure.
    const startupWindow = window ?? mainWindow;
    if (shutdownRunning || shutdownComplete || (startupWindow !== null && shellWindowGone(startupWindow))) {
      console.warn("CanvasTTY startup stopped: its window is gone, the application is closing.", error);
      return;
    }
    diagnostics.record("error", "startup", "failed", { error, marks: mainBootMarks() });
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

if (hasSingleInstanceLock) {
  void app.whenReady()
    .then(() => {
      markMainBoot("appReady");
      return startApplication();
    })
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
  diagnostics.record("info", "application", "shutdown.started");
  agentChatHistory?.dispose();
  if (agentControl) await Promise.allSettled([agentControl.close()]);
  if (updateTimer) clearTimeout(updateTimer);
  if (updateInterval) clearInterval(updateInterval);
  for (const request of browserRequests.values()) { clearTimeout(request.timer); request.reject(new Error("App closing")); }
  browserRequests.clear();
  await evenG2?.close();
  if (terminalManager) await terminalManager.shutdown();
  // The hung-up PTYs exit while the other services close; quitting waits for them (see waitForProcessExits).
  const ptyExits = terminalManager?.waitForProcessExits().then((left) => {
    if (left > 0) console.warn(`CanvasTTY quit with ${left} terminal process(es) that did not exit after SIGKILL.`);
  });
  limitsService?.dispose();
  if (agentGateway) await Promise.allSettled([agentGateway.close()]);
  if (runtimeGateway) await Promise.allSettled([runtimeGateway.close()]);
  if (browserService) await Promise.allSettled([browserService.dispose()]);
  if (pluginServices) await Promise.allSettled([pluginServices.dispose()]);
  if (pluginManager) await Promise.allSettled([pluginManager.dispose()]);
  await ptyExits;
  diagnostics.record("info", "application", "shutdown.completed");
  await diagnostics.flush();
}

async function openPluginWindow(pluginId: string, contributionId: string): Promise<void> {
  if (!pluginManager) throw new Error("Plugin manager is not ready.");
  const contribution = pluginManager.contribution(pluginId, contributionId);
  if (contribution.kind !== "window") throw new Error("Plugin contribution is not a separate window.");

  const window = new BrowserWindow({
    width: contribution.defaultSize.width,
    icon: appIcon,
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

function broadcastPluginServiceEvent(event: PluginServiceEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.pluginsServiceEvent, event);
  }
  for (const [window, ownerPluginId] of pluginWindows) {
    if (ownerPluginId !== event.pluginId || window.isDestroyed()) continue;
    window.webContents.send(IPC.pluginsServiceEvent, event);
  }
}

function securePluginStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

/**
 * Shorter pause/sleep delays for measurements and smoke runs: "freezeMs,discardMs" (for example "3000,8000").
 * Anything else is ignored and the defaults (30 s, 10 min) apply.
 */
function browserLifecycleTimingOverride(value: string | undefined): Pick<BrowserServiceOptions, "tabLifecycle"> {
  const match = /^(\d{3,9}),(\d{3,9})$/u.exec(value ?? "");
  if (!match) return {};
  return { tabLifecycle: { freezeAfterMs: Number(match[1]), discardAfterMs: Number(match[2]) } };
}
