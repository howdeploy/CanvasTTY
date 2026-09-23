import { DecisionCoordinator } from './services/decision/DecisionCoordinator';
import { DecisionSecrets } from './services/decision/DecisionSecrets';
import { PreferenceReviewService } from './services/PreferenceReviewService';
import { ConventionValidatorService } from './services/ConventionValidatorService';
import { ContextLaunchService } from './services/ContextLaunchService';
import { ContextProfileStore } from "./services/ContextProfileStore";
import { ContainerExecutionService } from "./services/ContainerExecutionService";
import { ContainerPlacementService } from './services/ContainerPlacement';
import { WorktreeService } from "./services/WorktreeService";
import { SessionLaunchCoordinator } from "./services/SessionLaunchCoordinator";
import { TaskCapsuleService } from "./services/TaskCapsuleService";
import { CapsuleLaunchService } from "./services/CapsuleLaunchService";
import { ScopedCapsuleControl } from './services/ScopedCapsuleControl';
import { CapsuleTestService } from './services/CapsuleTestService';
import { ProviderAccountLaunchService } from "./services/ProviderAccountLaunchService";
import { LocalOperationalMetricsService } from "./services/LocalOperationalMetrics";
import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { EvenG2Controller } from "./services/companion/EvenG2Controller";
import { join } from "node:path";
import { app, BrowserWindow, dialog, net, protocol, safeStorage, session } from "electron";
import { IPC, type PluginCanvasRequest } from "../shared/contracts";
import { registerIpc } from "./ipc/registerIpc";
import { SavedHostDiagnostics } from "./services/SavedHostDiagnostics";
import { SettingsStore } from "./services/SettingsStore";
import { SessionLaunchPolicy } from "./services/SessionLaunchPolicy";
import { TerminalManager } from "./services/TerminalManager";
import { TerminalSessionStore } from "./services/TerminalSessionStore";
import { LimitsService } from "./services/LimitsService";
import {
  createProviderCliRegistry,
  providerCliAvailability,
  type ProviderCliRegistry
} from "./services/providerCliRegistry";
import { PluginManager } from "./services/PluginManager";
import { GithubAuthService } from "./services/GithubAuthService";
import { PluginMediaService } from "./services/PluginMediaService";
import { PluginSecretsService } from "./services/PluginSecretsService";
import { ProviderSecretsService } from "./services/ProviderSecretsService";
import { AgentControlService } from "./services/AgentControlService";
import { HostPlacementService } from "./services/HostPlacement";
import { RemoteProviderDiscovery } from "./services/RemoteProviderDiscovery";
import { RemoteProviderAccess } from "./services/RemoteProviderAccess";
import { RemoteHostMetricsService } from "./services/RemoteHostMetrics";
import { sshRunner } from "./services/RemoteHostsService";
import { ServerProvisioning } from "./services/ServerProvisioning";
import { AccountLoginService } from "./services/AccountLogin";
import { HermesHudService } from "./services/HermesHudService";
import { BrowserService } from "./services/BrowserService";
import { CanvasNavigationInputController } from "./services/CanvasNavigationOverride";
import { activeCanvasWheelBinding } from "../shared/canvasNavigation";
import { runBrowserElectronSmoke } from "./services/browser/BrowserElectronSmoke";
import {
  runProviderElectronSmoke,
  type ProviderSmokeTarget
} from "./services/browser/ProviderElectronSmoke";
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
  RuntimeGateway
} from "./services/agent-runtime";
import type { RuntimeHookHelperLaunch } from "./services/agent-runtime/ProviderRuntimeLaunch";
import {
  recoverHermesConfigurationOnStartup,
  resolveHermesHomeDirectory
} from "./services/hermesConfig";
import { startupPageUrl } from "./startupPage";
import { mainWindowChromeOptions } from "./windowChrome";

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
let limitsService: LimitsService | null = null;
let pluginManager: PluginManager | null = null;
let githubAuth: GithubAuthService | null = null;
let pluginMediaService: PluginMediaService | null = null;
let pluginSecretsService: PluginSecretsService | null = null;
let decisionCoordinator: DecisionCoordinator | null = null;
let providerSecretsService: ProviderSecretsService | null = null;
let hermesHudService: HermesHudService | null = null;
let browserService: BrowserService | null = null;
let canvasNavigationInput: CanvasNavigationInputController | null = null;
let agentGateway: AgentGateway | null = null;
let orchestrationGateway: OrchestrationGateway | null = null;
let capsuleTestsService: CapsuleTestService | null = null;
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
  // A dead renderer must not leave a blank window: reload the application surface in place.
  // Services, sessions and scrollback live in this process and stay untouched. A clean exit is
  // the normal teardown path.
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    console.warn(`CanvasTTY renderer is gone (reason=${details.reason}, exitCode=${details.exitCode}). Reloading the application.`);
    if (shellWindowGone(window) || window.webContents.isDestroyed()) return;
    void reloadApplicationSurface(window)
      .catch((error) => console.warn("CanvasTTY could not reload the application after a renderer crash.", error));
  });
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

  browserService = new BrowserService(() => mainWindow, {
    userDataPath,
    restoreTabs: settings.get().browserRestoreTabs,
    canvasWheelCaptureMode: settings.get().canvasWheelCaptureMode,
    canvasNavigationInput,
    ...(process.env.CANVASTTY_BROWSER_SMOKE_URL
      ? { downloadRoot: join(userDataPath, "browser-smoke-downloads") }
      : {})
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
    const orchestrationHelperPath = app.isPackaged
      ? join(process.resourcesPath, "agent-browser", "orchestration-helper.mjs")
      : join(app.getAppPath(), "src", "agent-browser", "orchestration-helper.mjs");
    agentBrowserBridge = new AgentBrowserBridge(agentGateway, {
      helper: agentBrowserHelper,
      orchestrationHelper: {
        command: process.execPath,
        args: [orchestrationHelperPath],
        env: { ELECTRON_RUN_AS_NODE: "1" }
      },
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
    evenG2?.observe(channel, payload);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }, providerClis, agentBrowserBridge ?? undefined, agentRuntimeBridge ?? undefined, settings.get().agentLifecycleHooksEnabled);
  terminalManager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings.get()));
  settings.configureHostSessions(() => terminalManager!.listMetadata());
  const terminalSessionStore = new TerminalSessionStore(userDataPath);
  terminalManager.configureSessionPersistence(terminalSessionStore, settings.get().restoreTerminalSessions);

  // The local gateway socket/timer is resident; capabilities and MCP config exist only for sessions explicitly launched with
  // the orchestrator role; interactive sessions never receive capabilities.
  const remoteMetrics = new RemoteHostMetricsService(sshRunner);
  const remoteDiscovery = new RemoteProviderDiscovery(sshRunner);
  const remoteAccess = new RemoteProviderAccess(sshRunner);
  const localMetrics = new LocalOperationalMetricsService({
    sessions: () => terminalManager!.listMetadata(),
    processMetrics: () => app.getAppMetrics().map((metric) => ({ cpuPercent: metric.cpu.percentCPUUsage, workingSetKb: metric.memory.workingSetSize }))
  });
  const hostPlacement = new HostPlacementService({
    metrics: (host) => remoteMetrics.collect(host),
    discovery: (host, providers) => remoteDiscovery.discover(host, undefined, providers),
    access: (host, providers) => remoteAccess.probe(host, undefined, providers),
    capacity: (excludeSessionId) => {
      const counts = new Map<string, { sessions: number; agents: number }>();
      for (const session of terminalManager!.listMetadata()) {
        if (session.id === excludeSessionId || session.hostId === undefined || session.exitCode !== null) continue;
        const count = counts.get(session.hostId) ?? { sessions: 0, agents: 0 };
        count.sessions++;
        if (session.provider !== "terminal") count.agents++;
        counts.set(session.hostId, count);
      }
      const limit = settings.get().agentBudgets.maxRemoteAgentsPerHost;
      return {
        activeSessions: (hostId) => counts.get(hostId)?.sessions ?? 0,
        hasAgentCapacity: (hostId) => (counts.get(hostId)?.agents ?? 0) < limit
      };
    }
  });
  const agentControl = new AgentControlService(terminalManager, { place: request => hostPlacement.place(settings.get().remoteHosts, request) });
  const orchestrationHandler = new ScopedOrchestrationHandler(agentControl);
  orchestrationGateway = new OrchestrationGateway({
    runtimeDirectory: join(userDataPath, "orchestration", "runtime"),
    handler: orchestrationHandler
  });
  await orchestrationGateway.start();
  terminalManager.configureAcp({ orchestrationCommand: {
    command: process.execPath,
    args: [app.isPackaged ? join(process.resourcesPath, "agent-browser", "orchestration-helper.mjs") : join(app.getAppPath(), "src", "agent-browser", "orchestration-helper.mjs")],
    environment: { ELECTRON_RUN_AS_NODE: "1" }
  } });
  terminalManager.configureOrchestration(new OrchestrationBridge(orchestrationGateway));

  // Remote shell sessions resolve their host from the live settings registry:
  // a hostId with no matching entry fails the create instead of spawning.
  terminalManager.configureRemoteHosts(
    (hostId) => settings.hostForLaunch(hostId)
  );

  providerSecretsService = new ProviderSecretsService(userDataPath, {
    isAvailable: securePluginStorageAvailable,
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value)
  }, (owner, pendingCreation) => {
    if (owner.hostId !== "local") return false;
    const profile = settings.get().apiProfiles.find((candidate) => candidate.id === owner.profileId);
    return profile ? (profile.hostId ?? "local") === owner.hostId : pendingCreation;
  });
  await providerSecretsService.load();
  const worktrees = new WorktreeService({ rootDirectory: join(userDataPath, "execution-workspaces") });
  await worktrees.recover().catch(() => { console.warn("CanvasTTY retained workspaces could not be verified; they remain on disk."); });
  const capsuleStorage = new TaskCapsuleService({ rootDirectory: join(userDataPath, 'task-capsules') });
  await capsuleStorage.recover().catch(() => { console.warn('CanvasTTY retained capsules could not be verified; they remain on disk.'); });
  const capsules = new CapsuleLaunchService(capsuleStorage, () => settings.get());
  const contextProfiles = new ContextProfileStore(join(userDataPath, "context-profiles"), () => settings.get().pathPolicies);
  const contextLaunch = new ContextLaunchService(contextProfiles);
  const conventionValidator = new ConventionValidatorService(capsules, contextProfiles);
  terminalManager.configureContextLaunch(contextLaunch, () => settings.get().contextProfilesEnabled);
  const launchPolicy = new SessionLaunchPolicy(() => settings.get(), { context: contextLaunch, capsulePolicy: request => capsules.classify(request) });
  terminalManager.configureLaunchPolicy(launchPolicy);
  const containers = new ContainerExecutionService(() => settings.get(), { rootDirectory: join(userDataPath, "container-generations"), onWorkspaceStopped: (id, lease, kind) => kind === 'capsule-test' ? capsuleTests.confirmStopped(id, lease) : (kind === 'capsule' || kind === 'advisory-review') ? capsuleStorage.confirmContainerStopped(id, lease) : worktrees.confirmContainerStopped(id, lease) });
  const capsuleTests = new CapsuleTestService(capsules, containers, () => settings.get(), { rootDirectory: join(userDataPath, 'capsule-test-runs') });
  capsuleTestsService = capsuleTests;
  await capsuleTests.recover().catch(() => { console.warn('CanvasTTY retained tests could not be verified; their files remain on disk.'); });
  const decisionSecrets = new DecisionSecrets(userDataPath, { isAvailable: securePluginStorageAvailable, encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) }, () => decisionCoordinator?.invalidate());
  const decisions = new DecisionCoordinator({ settings: () => settings.get(), terminals: terminalManager, control: agentControl, secrets: decisionSecrets, providerSecretGeneration: () => providerSecretsService!.generation,
    remoteAvailable: (id, provider) => { const host = settings.get().remoteHosts.find(h => h.id === id); return !!host && remoteDiscovery.cachedAvailable(host, provider); },
    localCliAvailable: provider => providerClis!.get(provider).state === 'available',
    limits: () => limitsService ? limitsService.get() : Promise.resolve(null) });
  decisionCoordinator = decisions;
  providerSecretsService.onChanged(() => decisions.invalidate());
  terminalManager.configureDecisionInvalidation(id => decisions.invalidate(id));
  orchestrationHandler.configureDecisions(decisions);
  const preferenceReview = new PreferenceReviewService(capsules, terminalManager, agentControl, containers, () => settings.get());
  orchestrationHandler.configureCapsules(new ScopedCapsuleControl(terminalManager, agentControl, capsules, capsuleTests, conventionValidator, preferenceReview));
  terminalManager.configureProviderLaunch(new SessionLaunchCoordinator(
    new ProviderAccountLaunchService(() => settings.get(), providerSecretsService, { discovery: remoteDiscovery }), worktrees, () => settings.get(), hostPlacement, containers, capsules));
  terminalManager.configureContainerPlacement(new ContainerPlacementService({
    settings: () => settings.get(), sessions: () => terminalManager!.listMetadata(), policy: launchPolicy,
    inventory: ids => containers.inventory(ids),
    metrics: async host => {
      if (host) return remoteMetrics.collect(host);
      const local = localMetrics.collect();
      return { hostId: 'local', reachable: true, collectedAt: local.collectedAt, load1: local.load1, cores: local.cores,
        memoryTotalMb: local.memoryTotalMb, memoryAvailableMb: local.memoryAvailableMb, gpuVramTotalMb: null, gpuVramUsedMb: null };
    }
  }));

  await terminalManager.restorePersistedSessions();
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
    decisions, decisionSecrets,
    contextProfiles,
    capsuleTests,
    conventionValidator,
    preferenceReview,
    capsules,
    hostDiagnostics: new SavedHostDiagnostics(() => settings.get().remoteHosts, remoteDiscovery, remoteAccess, remoteMetrics),
    accountLogin: new AccountLoginService({ settings: () => settings.get(), terminals: terminalManager, run: sshRunner, userDataPath }),
    serverProvisioning: new ServerProvisioning({ hosts: () => settings.get().remoteHosts, run: sshRunner, access: remoteAccess, discovery: remoteDiscovery }),
    containers,
    worktrees,
    localMetrics,
    remoteMetrics,
    settings,
    providerClis,
    recheckProviderClis: async () => {
      providerClis!.refresh();
      agentBrowserBridge?.providerClisRefreshed();
      await limitsService!.providerClisRefreshed();
      const availability = providerCliAvailability(providerClis!);
      const updatedSettings = await settings.setAvailableProviders(availability);
      return { availability, settings: updatedSettings };
    },
    terminals: terminalManager,
    limits: limitsService,
    plugins: pluginManager,
    pluginMedia: pluginMediaService,
    pluginSecrets: pluginSecretsService,
    providerSecrets: providerSecretsService!,
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

/** Loads only the renderer entry; used to recover from a renderer crash. */
async function reloadApplicationSurface(window: BrowserWindow): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(__dirname, "../renderer/index.html"));
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
// Crash diagnostics: a lost GPU or utility child is logged with its reason; the window itself
// recovers through render-process-gone.
app.on("child-process-gone", (_event, details) => {
  const service = details.serviceName ? `, service=${details.serviceName}` : "";
  console.warn(`CanvasTTY child process exited: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}${service}.`);
});

// Keep shared event names in the main bundle so accidental channel drift fails at build time.
void IPC.terminalData;

async function shutdownServices(): Promise<void> {
  decisionCoordinator?.dispose();
  for (const request of browserRequests.values()) { clearTimeout(request.timer); request.reject(new Error("App closing")); }
  browserRequests.clear();
  await evenG2?.close();
  await capsuleTestsService?.shutdown();
  if (terminalManager) await terminalManager.shutdown();
  if (orchestrationGateway) await Promise.allSettled([orchestrationGateway.stop()]);
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
