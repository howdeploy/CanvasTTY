import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppSettings,
  BrowserActivityStateEvent,
  BrowserCanvasFreezeFrameEvent,
  BrowserCanvasNavigationPointerEvent,
  BrowserCanvasPointerEvent,
  BrowserCanvasWheelEvent,
  BrowserCommand,
  BrowserStateEvent,
  BrowserViewportBounds,
  CanvasNavigationOverrideStateEvent,
  CanvasNavigationPointerBindingInput,
  CanvasTTYApi,
  CreateSessionRequest,
  PluginBrowserOpenRequest,
  PluginBrowserOpenResponse,
  PluginCanvasRequest,
  PluginLauncherRequest,
  PluginStorageChangeEvent,
  PluginUpdateStatus,
  SessionBounds,
  SessionEvent,
  SessionRemovedEvent,
  TerminalDataEvent
} from "../shared/contracts";
import { IPC } from "../shared/contracts";
import { terminalFileDropText } from "../shared/terminalFileDrop";

function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: CanvasTTYApi = {
  decisions: {
    recommend: input => ipcRenderer.invoke(IPC.decisionRecommend, input), launch: (id, position) => ipcRenderer.invoke(IPC.decisionLaunch, id, position), cancel: id => ipcRenderer.invoke(IPC.decisionCancel, id), assemble: efforts => ipcRenderer.invoke(IPC.decisionAssemble, efforts),
    secretStatus: () => ipcRenderer.invoke(IPC.decisionSecretStatus), setSecret: value => ipcRenderer.invoke(IPC.decisionSecretSet, value), removeSecret: () => ipcRenderer.invoke(IPC.decisionSecretRemove)
  },
  context: {
    source: cwd => ipcRenderer.invoke(IPC.contextSource, cwd),
    previewLaunch: request => ipcRenderer.invoke(IPC.contextLaunchPreview, request),
    get: () => ipcRenderer.invoke(IPC.contextGet),
    saveProject: (project, revision) => ipcRenderer.invoke(IPC.contextProject, project, revision),
    saveTask: (task, revision) => ipcRenderer.invoke(IPC.contextTask, task, revision),
    saveRule: (rule, revision) => ipcRenderer.invoke(IPC.contextRule, rule, revision),
    remove: (kind, id, revision) => ipcRenderer.invoke(IPC.contextRemove, kind, id, revision),
    feedbackSessions: projectId => ipcRenderer.invoke(IPC.contextFeedbackSessions, projectId),
    saveLearning: (projectId, settings, revision) => ipcRenderer.invoke(IPC.contextLearning, projectId, settings, revision),
    captureFeedback: (input, revision) => ipcRenderer.invoke(IPC.contextFeedback, input, revision),
    feedbackAction: (action, revision) => ipcRenderer.invoke(IPC.contextFeedbackAction, action, revision),
    preview: selection => ipcRenderer.invoke(IPC.contextPreview, selection)
  },
  capsules: {
    reviewAgentChoices: (id, review) => ipcRenderer.invoke(IPC.capsulesReviewAgentChoices, id, review),
    previewReviewAgent: input => ipcRenderer.invoke(IPC.capsulesReviewAgentPreview, input),
    launchReviewAgent: id => ipcRenderer.invoke(IPC.capsulesReviewAgentLaunch, id),
    cancelReviewAgent: id => ipcRenderer.invoke(IPC.capsulesReviewAgentCancel, id),
    validateConventions: (id, reviewId, maxDataClass) => ipcRenderer.invoke(IPC.capsulesConventions, id, reviewId, maxDataClass),
    currentConventions: id => ipcRenderer.invoke(IPC.capsulesConventionsCurrent, id),
    startTest: (id, review, profile) => ipcRenderer.invoke(IPC.capsulesTestStart, id, review, profile),
    testRuns: () => ipcRenderer.invoke(IPC.capsulesTestList),
    testResult: id => ipcRenderer.invoke(IPC.capsulesTestResult, id),
    cancelTest: id => ipcRenderer.invoke(IPC.capsulesTestCancel, id),
    cleanupTest: id => ipcRenderer.invoke(IPC.capsulesTestCleanup, id),
    selectFiles: source => ipcRenderer.invoke(IPC.capsulesSelectFiles, source),
    prepare: request => ipcRenderer.invoke(IPC.capsulesPrepare, request),
    list: () => ipcRenderer.invoke(IPC.capsulesList),
    review: id => ipcRenderer.invoke(IPC.capsulesReview, id),
    exportPatch: (id, reviewId) => ipcRenderer.invoke(IPC.capsulesExport, id, reviewId),
    apply: (id, reviewId) => ipcRenderer.invoke(IPC.capsulesApply, id, reviewId),
    recoverApply: (id, reviewId) => ipcRenderer.invoke(IPC.capsulesRecover, id, reviewId),
    cleanup: id => ipcRenderer.invoke(IPC.capsulesCleanup, id)
  },
  accountHomes: { inspect: directory => ipcRenderer.invoke(IPC.accountHomesInspect, directory) },
  evenG2: {
    state: () => ipcRenderer.invoke(IPC.evenG2State),
    command: (command) => ipcRenderer.invoke(IPC.evenG2Command, command),
    onOpenBrowser: (listener) => subscribe<string>(IPC.evenG2BrowserRequest, listener),
    completeOpenBrowser: (requestId, ok) => ipcRenderer.send(IPC.evenG2BrowserResponse, { requestId, ok })
  },
  appVersion: () => ipcRenderer.invoke(IPC.appVersion),
  containers: {
    probe: profileId => ipcRenderer.invoke(IPC.containersProbe, profileId),
    inventory: (profileIds, force) => ipcRenderer.invoke(IPC.containersInventory, profileIds, force),
    list: () => ipcRenderer.invoke(IPC.containersList),
    cleanup: id => ipcRenderer.invoke(IPC.containersCleanup, id),
    review: id => ipcRenderer.invoke(IPC.containersReview, id),
    exportPatch: (id, reviewId) => ipcRenderer.invoke(IPC.containersExport, id, reviewId)
  },
  workspaces: {
    list: () => ipcRenderer.invoke(IPC.workspacesList),
    review: (id: string) => ipcRenderer.invoke(IPC.workspacesReview, id),
    exportPatch: (id: string, reviewId: string) => ipcRenderer.invoke(IPC.workspacesExport, id, reviewId),
    cleanup: (id: string) => ipcRenderer.invoke(IPC.workspacesCleanup, id)
  },
  operationalMetrics: {
    local: () => ipcRenderer.invoke(IPC.operationalMetricsLocal),
    remote: (hostId: string) => ipcRenderer.invoke(IPC.operationalMetricsRemote, hostId)
  },
  accountLogin: { start: request => ipcRenderer.invoke(IPC.accountLogin, request) },
  hosts: {
    inspect: (hostId: string) => ipcRenderer.invoke(IPC.hostsInspect, hostId),
    prepare: (hostIds: string[]) => ipcRenderer.invoke(IPC.hostsPrepare, hostIds),
    prepareStatus: (jobIds: string[]) => ipcRenderer.invoke(IPC.hostsPrepareStatus, jobIds)
  },
  clipboard: {
    readText: () => ipcRenderer.invoke(IPC.clipboardRead),
    writeText: (text: string) => ipcRenderer.send(IPC.clipboardWrite, text)
  },
  external: {
    openUrl: (url: string) => ipcRenderer.invoke(IPC.externalOpenUrl, url)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch)
  },
  agents: {
    availability: () => ipcRenderer.invoke(IPC.agentsAvailability),
    recheck: () => ipcRenderer.invoke(IPC.agentsRecheck)
  },
  dialog: {
    pickDirectory: (defaultPath?: string) => ipcRenderer.invoke(IPC.dialogPickDirectory, defaultPath),
    pickMedia: () => ipcRenderer.invoke(IPC.dialogPickMedia)
  },
  media: {
    read: (path: string) => ipcRenderer.invoke(IPC.mediaRead, path)
  },
  limits: {
    get: () => ipcRenderer.invoke(IPC.limitsGet)
  },
  providerSecrets: {
    status: () => ipcRenderer.invoke(IPC.providerSecretsStatus),
    set: (secretId: string, value: string) => ipcRenderer.invoke(IPC.providerSecretsSet, secretId, value),
    clear: (secretId: string) => ipcRenderer.invoke(IPC.providerSecretsClear, secretId),
    create: (owner, value) => ipcRenderer.invoke(IPC.providerSecretsCreate, owner, value),
    scopedStatus: () => ipcRenderer.invoke(IPC.providerSecretsScopedStatus),
    update: (ref, owner, value) => ipcRenderer.invoke(IPC.providerSecretsUpdate, ref, owner, value),
    remove: (ref, owner) => ipcRenderer.invoke(IPC.providerSecretsRemove, ref, owner)
  },
  plugins: {
    list: () => ipcRenderer.invoke(IPC.pluginsList),
    search: (query: string) => ipcRenderer.invoke(IPC.pluginsSearch, query),
    showcase: () => ipcRenderer.invoke(IPC.pluginsShowcase),
    icon: (sourceUrls: string[]) => ipcRenderer.invoke(IPC.pluginsIcon, sourceUrls),
    manifests: (sourceUrls: string[]) => ipcRenderer.invoke(IPC.pluginsManifests, sourceUrls),
    checkUpdates: () => ipcRenderer.invoke(IPC.pluginsCheckUpdates),
    update: (pluginId: string) => ipcRenderer.invoke(IPC.pluginsUpdate, pluginId),
    onUpdatesAvailable: (listener: (updates: PluginUpdateStatus[]) => void) => subscribe(IPC.pluginsUpdatesAvailable, listener),
    previewInstall: (sourceUrl: string) => ipcRenderer.invoke(IPC.pluginsPreviewInstall, sourceUrl),
    install: (token: string, selectedModules?: string[]) => ipcRenderer.invoke(IPC.pluginsInstall, token, selectedModules),
    setModules: (pluginId: string, selectedModules: string[]) => (
      ipcRenderer.invoke(IPC.pluginsSetModules, pluginId, selectedModules)
    ),
    setEnabled: (pluginId: string, enabled: boolean) => ipcRenderer.invoke(IPC.pluginsSetEnabled, pluginId, enabled),
    setHookEnabled: (pluginId: string, hookId: string, enabled: boolean) => (
      ipcRenderer.invoke(IPC.pluginsSetHookEnabled, pluginId, hookId, enabled)
    ),
    uninstall: (pluginId: string) => ipcRenderer.invoke(IPC.pluginsUninstall, pluginId),
    openCanvas: (pluginId: string, contributionId: string, sourceCanvasInstanceId?: string) => (
      ipcRenderer.invoke(IPC.pluginsOpenCanvas, pluginId, contributionId, sourceCanvasInstanceId)
    ),
    openWindow: (pluginId: string, contributionId: string) => ipcRenderer.invoke(IPC.pluginsOpenWindow, pluginId, contributionId),
    openExternal: (pluginId: string, url: string) => ipcRenderer.invoke(IPC.pluginsOpenExternal, pluginId, url),
    openBrowser: (pluginId: string, url: string) => ipcRenderer.invoke(IPC.pluginsOpenBrowser, pluginId, url),
    storageGet: (pluginId: string, key: string) => ipcRenderer.invoke(IPC.pluginsStorageGet, pluginId, key),
    storageSet: (pluginId: string, key: string, value: unknown) => ipcRenderer.invoke(IPC.pluginsStorageSet, pluginId, key, value),
    secretsGet: (pluginId: string, key: string) => ipcRenderer.invoke(IPC.pluginsSecretsGet, pluginId, key),
    secretsSet: (pluginId: string, key: string, value: string) => ipcRenderer.invoke(IPC.pluginsSecretsSet, pluginId, key, value),
    secretsDelete: (pluginId: string, key: string) => ipcRenderer.invoke(IPC.pluginsSecretsDelete, pluginId, key),
    mediaPickLibrary: (pluginId: string) => ipcRenderer.invoke(IPC.pluginsMediaPickLibrary, pluginId),
    mediaListLibraries: (pluginId: string) => ipcRenderer.invoke(IPC.pluginsMediaListLibraries, pluginId),
    mediaScanLibrary: (pluginId: string, libraryId: string) => ipcRenderer.invoke(IPC.pluginsMediaScanLibrary, pluginId, libraryId),
    mediaRevokeLibrary: (pluginId: string, libraryId: string) => ipcRenderer.invoke(IPC.pluginsMediaRevokeLibrary, pluginId, libraryId),
    playlistsList: (pluginId: string, libraryId: string) => ipcRenderer.invoke(IPC.pluginsPlaylistsList, pluginId, libraryId),
    playlistsRead: (pluginId: string, libraryId: string, playlistId: string) => ipcRenderer.invoke(IPC.pluginsPlaylistsRead, pluginId, libraryId, playlistId),
    playlistsWrite: (pluginId: string, libraryId: string, name: string, content: string) => ipcRenderer.invoke(IPC.pluginsPlaylistsWrite, pluginId, libraryId, name, content),
    hermesHudStatus: (pluginId: string) => ipcRenderer.invoke(IPC.pluginsHermesHudStatus, pluginId),
    hermesHudOpen: (pluginId: string) => ipcRenderer.invoke(IPC.pluginsHermesHudOpen, pluginId),
    hermesHudClose: (pluginId: string) => ipcRenderer.invoke(IPC.pluginsHermesHudClose, pluginId),
    onOpenLauncher: (listener: (event: PluginLauncherRequest) => void) => subscribe(IPC.pluginsLauncherRequested, listener),
    onOpenCanvas: (listener: (event: PluginCanvasRequest) => void) => subscribe(IPC.pluginsCanvasRequested, listener),
    onBrowserOpenRequested: (listener: (event: PluginBrowserOpenRequest) => void) => (
      subscribe(IPC.pluginsBrowserOpenRequested, listener)
    ),
    completeBrowserOpen: (response: PluginBrowserOpenResponse) => (
      ipcRenderer.invoke(IPC.pluginsBrowserOpenResponded, response)
    ),
    onStorageChanged: (listener: (event: PluginStorageChangeEvent) => void) => subscribe(IPC.pluginsStorageChanged, listener)
  },
  githubAuth: {
    status: () => ipcRenderer.invoke(IPC.githubAuthStatus),
    start: () => ipcRenderer.invoke(IPC.githubAuthStart),
    signOut: () => ipcRenderer.invoke(IPC.githubAuthSignOut),
    openUrl: (url: string) => ipcRenderer.invoke(IPC.githubAuthOpenUrl, url)
  },
  browser: {
    getState: () => ipcRenderer.invoke(IPC.browserGetState),
    open: (url?: string) => ipcRenderer.invoke(IPC.browserOpen, url),
    close: () => ipcRenderer.invoke(IPC.browserClose),
    closeAllTabs: () => ipcRenderer.invoke(IPC.browserCloseAllTabs),
    newTab: (url?: string) => ipcRenderer.invoke(IPC.browserNewTab, url),
    selectTab: (id: string) => ipcRenderer.invoke(IPC.browserSelectTab, id),
    closeTab: (id: string) => ipcRenderer.invoke(IPC.browserCloseTab, id),
    navigate: (id: string, value: string) => ipcRenderer.invoke(IPC.browserNavigate, id, value),
    back: (id: string) => ipcRenderer.invoke(IPC.browserBack, id),
    forward: (id: string) => ipcRenderer.invoke(IPC.browserForward, id),
    reload: (id: string) => ipcRenderer.invoke(IPC.browserReload, id),
    execute: (command: BrowserCommand) => ipcRenderer.invoke(IPC.browserExecute, command),
    getActivity: (sinceSequence?: number) => ipcRenderer.invoke(IPC.browserGetActivity, sinceSequence),
    clearData: () => ipcRenderer.invoke(IPC.browserClearData),
    focus: () => ipcRenderer.send(IPC.browserFocus),
    setInputFocused: (focused: boolean) => {
      ipcRenderer.sendSync(IPC.browserSetInputFocused, focused);
    },
    setViewport: (bounds: BrowserViewportBounds) => ipcRenderer.send(IPC.browserSetViewport, bounds),
    onState: (listener: (event: BrowserStateEvent) => void) => subscribe(IPC.browserState, listener),
    onActivity: (listener: (event: BrowserActivityStateEvent) => void) => subscribe(IPC.browserActivity, listener),
    onCanvasWheel: (listener: (event: BrowserCanvasWheelEvent) => void) => subscribe(IPC.browserCanvasWheel, listener),
    onCanvasFreezeFrame: (listener: (event: BrowserCanvasFreezeFrameEvent) => void) => (
      subscribe(IPC.browserCanvasFreezeFrame, listener)
    ),
    onCanvasPointer: (listener: (event: BrowserCanvasPointerEvent) => void) => subscribe(IPC.browserCanvasPointer, listener),
    onCanvasNavigationPointer: (listener: (event: BrowserCanvasNavigationPointerEvent) => void) => (
      subscribe(IPC.browserCanvasNavigationPointer, listener)
    )
  },
  canvasNavigation: {
    armOwnerWheelSequence: (clientX: number, clientY: number) => {
      ipcRenderer.sendSync(IPC.canvasNavigationOwnerWheel, { clientX, clientY });
    },
    setShortcutCaptureActive: (active: boolean) => ipcRenderer.send(IPC.canvasNavigationShortcutCapture, active),
    setPointerBindingState: (input: CanvasNavigationPointerBindingInput) => (
      ipcRenderer.send(IPC.canvasNavigationPointerBinding, input)
    ),
    setPointerGestureActive: (active: boolean) => ipcRenderer.send(IPC.canvasNavigationPointerGesture, active),
    onOverrideState: (listener: (event: CanvasNavigationOverrideStateEvent) => void) => (
      subscribe(IPC.canvasNavigationOverrideState, listener)
    )
  },
  terminal: {
    fileDropText: (files: File[]) => terminalFileDropText(
      files.map((file) => webUtils.getPathForFile(file)),
      process.platform
    ),
    list: () => ipcRenderer.invoke(IPC.terminalList),
    readBuffer: (id: string) => ipcRenderer.invoke(IPC.terminalReadBuffer, id),
    create: (request: CreateSessionRequest) => ipcRenderer.invoke(IPC.terminalCreate, request),
    previewContainerPlacement: (request) => ipcRenderer.invoke(IPC.terminalContainerPlacementPreview, request),
    agentPrompt: (id: string, text: string) => ipcRenderer.invoke(IPC.terminalAgentPrompt, id, text),
    cancelTurn: (id: string) => ipcRenderer.invoke(IPC.terminalCancelTurn, id),
    acpPermission: (id: string, requestId: string, optionId: string) => ipcRenderer.invoke(IPC.terminalAcpPermission, id, requestId, optionId),
    acpModel: (id: string, value: string) => ipcRenderer.invoke(IPC.terminalAcpModel, id, value),
    restart: (id: string) => ipcRenderer.invoke(IPC.terminalRestart, id),
    input: (id: string, data: string) => ipcRenderer.send(IPC.terminalInput, id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send(IPC.terminalResize, id, cols, rows),
    setBounds: (id: string, bounds: SessionBounds) => ipcRenderer.send(IPC.terminalBounds, id, bounds),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC.terminalRename, id, title),
    dispose: (id: string) => ipcRenderer.invoke(IPC.terminalDispose, id),
    onData: (listener: (event: TerminalDataEvent) => void) => subscribe(IPC.terminalData, listener),
    onSession: (listener: (event: SessionEvent) => void) => subscribe(IPC.terminalSession, listener),
    onRemoved: (listener: (event: SessionRemovedEvent) => void) => subscribe(IPC.terminalRemoved, listener)
  },
  window: {
    isMacOS: process.platform === "darwin",
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    getState: () => ipcRenderer.invoke(IPC.windowGetState),
    onState: (listener) => subscribe(IPC.windowState, listener)
  }
};

contextBridge.exposeInMainWorld("canvasTTY", api);
