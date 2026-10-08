import { contextBridge, ipcRenderer, webUtils } from "electron";
import { BACKLOG_IPC, BACKLOG_TERMINAL_IPC, BACKLOG_EVENTS, type BacklogApi } from "../shared/backlog";
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
  CustomTerminalBorderSkinId,
  CreateSessionRequest,
  MaterialsSnapshot,
  PluginBrowserOpenRequest,
  PluginBrowserOpenResponse,
  PluginCanvasRequest,
  PluginLauncherRequest,
  PluginServiceEvent,
  PluginCardDecorations,
  PluginStorageChangeEvent,
  PluginUpdateStatus,
  Point,
  ProviderId,
  PixelSkinPackInstallRequest,
  PixelSkinZipInstallRequest,
  PixelSkinSlot,
  PixelTerminalBorderSkinId,
  UpdateStatus,
  SessionBounds,
  SessionEvent,
  SessionRemovedEvent,
  GitRiskReport,
  TerminalDataEvent
} from "../shared/contracts.ts";
import { IPC } from "../shared/contracts.ts";
import { terminalFileDropText } from "../shared/terminalFileDrop";
import { TerminalDataRouter } from "../shared/terminalDataRouter";

function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

// One IPC listener for all terminal output; each card subscribes for its own session id.
const terminalData = new TerminalDataRouter();
ipcRenderer.on(IPC.terminalDataBatch, (_event: Electron.IpcRendererEvent, batch: TerminalDataEvent[]) => {
  for (const payload of batch) terminalData.dispatch(payload);
});

const openUpdateListeners = new Set<() => void>();
let pendingOpenUpdates = false;
ipcRenderer.on(IPC.windowOpenUpdates, () => {
  if (openUpdateListeners.size === 0) pendingOpenUpdates = true;
  else for (const listener of openUpdateListeners) listener();
});

const api: CanvasTTYApi = {
  diagnostics: {
    configuration: () => ipcRenderer.invoke(IPC.diagnosticsConfiguration),
    send: (description, attachment) => ipcRenderer.invoke(IPC.diagnosticsSend, description, attachment),
    reportError: (error) => ipcRenderer.send(IPC.diagnosticsRendererError, error)
  },
  update: {
    status: () => ipcRenderer.invoke(IPC.updateStatus),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    onStatus: (listener) => subscribe<UpdateStatus>(IPC.updateChanged, listener)
  },
  evenG2: {
    state: () => ipcRenderer.invoke(IPC.evenG2State),
    command: (command) => ipcRenderer.invoke(IPC.evenG2Command, command),
    onOpenBrowser: (listener) => subscribe<string>(IPC.evenG2BrowserRequest, listener),
    completeOpenBrowser: (requestId, ok) => ipcRenderer.send(IPC.evenG2BrowserResponse, { requestId, ok })
  },
  appVersion: () => ipcRenderer.invoke(IPC.appVersion),
  clipboard: {
    readText: () => ipcRenderer.invoke(IPC.clipboardRead),
    hasImage: () => ipcRenderer.invoke(IPC.clipboardHasImage),
    writeText: (text: string) => ipcRenderer.send(IPC.clipboardWrite, text)
  },
  external: {
    openUrl: (url: string) => ipcRenderer.invoke(IPC.externalOpenUrl, url)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    onChanged: (listener: (settings: AppSettings) => void) => subscribe(IPC.settingsChanged, listener)
  },
  skins: {
    list: () => ipcRenderer.invoke(IPC.terminalBorderSkinsList),
    get: (id: CustomTerminalBorderSkinId) => ipcRenderer.invoke(IPC.terminalBorderSkinsGet, id),
    onChanged: (listener: () => void) => subscribe<void>(IPC.terminalBorderSkinsChanged, listener)
  },
  pixelSkins: {
    list: () => ipcRenderer.invoke(IPC.pixelSkinsList),
    install: (request: PixelSkinPackInstallRequest) => ipcRenderer.invoke(IPC.pixelSkinsInstall, request),
    installZip: (request: PixelSkinZipInstallRequest) => ipcRenderer.invoke(IPC.pixelSkinsInstallZip, request),
    readAsset: (id: PixelTerminalBorderSkinId, slot: PixelSkinSlot) => ipcRenderer.invoke(IPC.pixelSkinsReadAsset, id, slot),
    onChanged: (listener: () => void) => subscribe<void>(IPC.pixelSkinsChanged, listener)
  },
  agents: {
    availability: () => ipcRenderer.invoke(IPC.agentsAvailability),
    recheck: () => ipcRenderer.invoke(IPC.agentsRecheck)
  },
  agentChatHistory: {
    providers: () => ipcRenderer.invoke(IPC.agentChatHistoryProviders),
    list: (provider, cursor) => ipcRenderer.invoke(IPC.agentChatHistoryList, provider, cursor),
    resume: (provider, id, position) => ipcRenderer.invoke(IPC.agentChatHistoryResume, provider, id, position)
  },
  dialog: {
    pickDirectory: (defaultPath?: string) => ipcRenderer.invoke(IPC.dialogPickDirectory, defaultPath),
    pickMedia: () => ipcRenderer.invoke(IPC.dialogPickMedia)
  },
  media: {
    read: (path: string) => ipcRenderer.invoke(IPC.mediaRead, path)
  },
  materials: {
    snapshot: () => ipcRenderer.invoke(IPC.materialsSnapshot),
    addFiles: (files: File[], point: Point) => ipcRenderer.invoke(
      IPC.materialsAddPaths,
      files.map((file) => webUtils.getPathForFile(file)),
      point
    ),
    pick: (point: Point) => ipcRenderer.invoke(IPC.materialsPick, point),
    paste: (point: Point) => ipcRenderer.invoke(IPC.materialsPaste, point),
    setBounds: (id: string, bounds: SessionBounds) => ipcRenderer.send(IPC.materialsSetBounds, id, bounds),
    setBoundsBatch: (entries: { id: string; bounds: SessionBounds }[]) => ipcRenderer.send(IPC.materialsSetBoundsBatch, entries),
    remove: (id: string) => ipcRenderer.invoke(IPC.materialsRemove, id),
    pinVersion: (id: string) => ipcRenderer.invoke(IPC.materialsPinVersion, id),
    reveal: (id: string) => ipcRenderer.invoke(IPC.materialsReveal, id),
    relink: (id: string) => ipcRenderer.invoke(IPC.materialsRelink, id),
    acceptMove: (id: string) => ipcRenderer.invoke(IPC.materialsAcceptMove, id),
    addRemark: (draft: unknown) => ipcRenderer.invoke(IPC.materialsAddRemark, draft),
    updateRemark: (id: string, patch: unknown) => ipcRenderer.invoke(IPC.materialsUpdateRemark, id, patch),
    deleteRemark: (id: string) => ipcRenderer.invoke(IPC.materialsDeleteRemark, id),
    onChanged: (listener: (snapshot: MaterialsSnapshot) => void) => subscribe(IPC.materialsChanged, listener)
  },
  limits: {
    get: () => ipcRenderer.invoke(IPC.limitsGet)
  },
  providerSecrets: {
    status: () => ipcRenderer.invoke(IPC.providerSecretsStatus),
    set: (secretId: string, value: string) => ipcRenderer.invoke(IPC.providerSecretsSet, secretId, value),
    clear: (secretId: string) => ipcRenderer.invoke(IPC.providerSecretsClear, secretId)
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
    setNativeCodeTrusted: (pluginId: string, trusted: boolean) => (
      ipcRenderer.invoke(IPC.pluginsSetNativeCodeTrusted, pluginId, trusted)
    ),
    setDecisionsMayAllow: (pluginId: string, allowed: boolean) => (
      ipcRenderer.invoke(IPC.pluginsSetDecisionsMayAllow, pluginId, allowed)
    ),
    serviceReport: (pluginId: string) => ipcRenderer.invoke(IPC.pluginsServiceReport, pluginId),
    serviceRequest: (pluginId: string, serviceId: string, method: string, params: unknown) => (
      ipcRenderer.invoke(IPC.pluginsServiceRequest, pluginId, serviceId, method, params)
    ),
    onServiceEvent: (listener: (event: PluginServiceEvent) => void) => subscribe(IPC.pluginsServiceEvent, listener),
    cardDecorations: () => ipcRenderer.invoke(IPC.pluginsCardDecorations),
    onCardDecorations: (listener: (decorations: PluginCardDecorations) => void) => (
      subscribe(IPC.pluginsCardDecorationsChanged, listener)
    ),
    invokeCardAction: (pluginId: string, actionId: string, sessionId: string, input?: Record<string, unknown>) => (
      ipcRenderer.invoke(IPC.pluginsInvokeCardAction, pluginId, actionId, sessionId, input)
    ),
    executionAccountRoutes: (provider: ProviderId) => ipcRenderer.invoke(IPC.executionAccountRoutes,provider),
    launchFieldOptions: (pluginId: string, provider: ProviderId) => (
      ipcRenderer.invoke(IPC.pluginsLaunchFieldOptions, pluginId, provider)
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
    cancel: () => ipcRenderer.invoke(IPC.githubAuthCancel),
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
    setTerminalEditFocus: (active: boolean) => ipcRenderer.send(IPC.canvasNavigationTerminalEditFocus, active),
    setPointerBindingState: (input: CanvasNavigationPointerBindingInput) => (
      ipcRenderer.send(IPC.canvasNavigationPointerBinding, input)
    ),
    setPointerGestureActive: (active: boolean) => ipcRenderer.send(IPC.canvasNavigationPointerGesture, active),
    onOverrideState: (listener: (event: CanvasNavigationOverrideStateEvent) => void) => (
      subscribe(IPC.canvasNavigationOverrideState, listener)
    )
  },
  terminal: {
    paste: (id, text) => ipcRenderer.invoke(BACKLOG_TERMINAL_IPC.paste, id, text),
    describeFileDrop: (files, sessionId) => ipcRenderer.invoke(BACKLOG_TERMINAL_IPC.describeFileDrop, files.map((file) => webUtils.getPathForFile(file)), sessionId),
    searchOutput: (query, sessionIds) => ipcRenderer.invoke(BACKLOG_TERMINAL_IPC.searchOutput, query, sessionIds),
    readOutputContext: (id, offset) => ipcRenderer.invoke(BACKLOG_TERMINAL_IPC.readOutputContext,id,offset),
    onFocusRequested: (listener) => subscribe(BACKLOG_TERMINAL_IPC.focusRequested, listener),
    openFile: (id: string, reference: string) => ipcRenderer.invoke(IPC.terminalOpenFile, id, reference),
    fileDropText: (files: File[]) => terminalFileDropText(
      files.map((file) => webUtils.getPathForFile(file)),
      process.platform
    ),
    list: () => ipcRenderer.invoke(IPC.terminalList),
    readBuffer: (id: string) => ipcRenderer.invoke(IPC.terminalReadBuffer, id),
    create: (request: CreateSessionRequest) => ipcRenderer.invoke(IPC.terminalCreate, request),
    restart: (id: string, options?: { resume?: boolean }) => ipcRenderer.invoke(IPC.terminalRestart, id, options),
    input: (id: string, data: string) => ipcRenderer.send(IPC.terminalInput, id, data),
    pasteClipboard: (id, text, startedAt) => ipcRenderer.invoke(IPC.terminalPasteClipboard, id, text, startedAt),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send(IPC.terminalResize, id, cols, rows),
    setBounds: (id: string, bounds: SessionBounds) => ipcRenderer.send(IPC.terminalBounds, id, bounds),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC.terminalRename, id, title),
    setRestore: (id: string, restore: boolean) => ipcRenderer.invoke(IPC.terminalSetRestore, id, restore),
    dispose: (id: string, options?: { keepEnvironmentData?: boolean }) => ipcRenderer.invoke(IPC.terminalDispose, id, options),
    setVisible: (id: string, visible: boolean) => ipcRenderer.send(IPC.terminalSetVisible, id, visible),
    onData: (listener: (event: TerminalDataEvent) => void, id?: string) => terminalData.subscribe(listener, id),
    onSession: (listener: (event: SessionEvent) => void) => subscribe(IPC.terminalSession, listener),
    onRemoved: (listener: (event: SessionRemovedEvent) => void) => subscribe(IPC.terminalRemoved, listener),
    resolveGitRisk: (reportId: string, action: "neutralize" | "keep") => ipcRenderer.invoke(IPC.terminalResolveGitRisk, reportId, action),
    onGitRisk: (listener: (report: GitRiskReport) => void) => subscribe(IPC.terminalGitRisk, listener)
  },
  backlog: {
    ...Object.fromEntries(Object.entries(BACKLOG_IPC).map(([name, channel]) => [name, (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)])),
    onTaskBoardChanged:(listener)=>subscribe(BACKLOG_EVENTS.taskBoardChanged,listener)
  } as BacklogApi,
  window: {
    isMacOS: process.platform === "darwin",
    platform: process.platform,
    onOpenUpdates: (listener) => {
      openUpdateListeners.add(listener);
      if (pendingOpenUpdates) { pendingOpenUpdates = false; listener(); }
      return () => { openUpdateListeners.delete(listener); };
    },
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    getState: () => ipcRenderer.invoke(IPC.windowGetState),
    onState: (listener) => subscribe(IPC.windowState, listener)
  }
};

contextBridge.exposeInMainWorld("canvasTTY", api);
