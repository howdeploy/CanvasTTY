import { join } from "node:path";
import { app, BrowserWindow, dialog, net, protocol, safeStorage } from "electron";
import { IPC, type PluginCanvasRequest } from "../shared/contracts";
import { registerIpc } from "./ipc/registerIpc";
import { SettingsStore } from "./services/SettingsStore";
import { TerminalManager } from "./services/TerminalManager";
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
let terminalManager: TerminalManager | null = null;
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
      if (mainWindow && !mainWindow.isDestroyed()) {
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }, providerClis, agentBrowserBridge ?? undefined, agentRuntimeBridge ?? undefined, settings.get().agentLifecycleHooksEnabled);
  const terminalSessionStore = new TerminalSessionStore(userDataPath);
  terminalManager.configureSessionPersistence(terminalSessionStore, settings.get().restoreTerminalSessions);
  await terminalManager.restorePersistedSessions();
  limitsService = new LimitsService(providerClis, app.getVersion());
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
    broadcastPluginStorageChange
  });
  servicesReady = true;
}

async function loadApplication(window: BrowserWindow): Promise<void> {
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

  if (process.env.CANVASTTY_SMOKE_TEST === "1") {
    await window.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    );
    console.log("CANVASTTY_SMOKE_READY");
    app.quit();
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
    if (BrowserWindow.getAllWindows().length === 0) void startApplication();
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

// Keep shared event names in the main bundle so accidental channel drift fails at build time.
void IPC.terminalData;

async function shutdownServices(): Promise<void> {
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
