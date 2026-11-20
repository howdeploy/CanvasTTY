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
  CustomTerminalBorderSkinId,
  CreateSessionRequest,
  FileRootReference,
  HandoffDraft,
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
  RemarkDraft,
  RemarkPatch,
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
import { createDuoDocumentRouter } from './duoDocumentRouter';

const syntheticListeners=new Map<string,Set<(payload:any)=>void>>();
const documentRouter=createDuoDocumentRouter((channel,...args)=>ipcRenderer.invoke(channel,...args),(channel,payload)=>{
  for(const listener of syntheticListeners.get(channel)??[])listener(payload);
});
const invoke=(channel:string,...args:any[]):Promise<any>=>documentRouter.invoke(channel,...args);
// Apply shared capabilities before notifying the UI. Main-owned polling survives
// renderer timer throttling and does not depend on an open Duo panel.
let duoEvents:Promise<unknown>=Promise.resolve();
ipcRenderer.on(IPC.duoChanged, (_event,reply:import('../shared/canvasDuo').DuoReply)=>{
  duoEvents=duoEvents.catch(()=>undefined).then(async()=>{
    await documentRouter.accept(reply);
    for(const listener of syntheticListeners.get(IPC.duoChanged)??[])listener(reply);
  });
});
const send=(channel:string,...args:any[]):void=>{
  if(documentRouter.ignoreSend(channel)||documentRouter.send(channel,args))return;
  ipcRenderer.send(channel,...args);
};

function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  if(!syntheticListeners.has(channel))syntheticListeners.set(channel,new Set());
  syntheticListeners.get(channel)!.add(listener);
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(documentRouter.localEvent(channel,payload));
  ipcRenderer.on(channel, wrapped);
  return () => {ipcRenderer.removeListener(channel, wrapped);syntheticListeners.get(channel)?.delete(listener);};
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
  duo: { diagnostics: () => invoke(IPC.duoDiagnostics), onChanged: listener => {if(!syntheticListeners.has(IPC.duoChanged))syntheticListeners.set(IPC.duoChanged,new Set());syntheticListeners.get(IPC.duoChanged)!.add(listener);return ()=>{syntheticListeners.get(IPC.duoChanged)?.delete(listener);};}, onInvitation: listener => subscribe(IPC.duoInvitation, listener), command: command => invoke(IPC.duoCommand, command) },
  workspacePresets: {
    list: () => invoke(IPC.workspacePresetsList),
    save: (name, id) => invoke(IPC.workspacePresetsSave, name, id),
    restore: (id, mode) => invoke(IPC.workspacePresetsRestore, id, mode),
    remove: (id) => invoke(IPC.workspacePresetsRemove, id)
  },
  canvasLink: {
    state: () => invoke("canvaslink-settings:state"),
    command: (action) => invoke("canvaslink-settings:command", action)
  },
  mascots: {
    list: () => invoke(IPC.mascotsList),
    start: (image) => invoke(IPC.mascotsStart, image),
    link: (projectId, sessionId) => invoke(IPC.mascotsLink, projectId, sessionId),
    fail: (projectId, message) => invoke(IPC.mascotsFail, projectId, message),
    retry: (projectId) => invoke(IPC.mascotsRetry, projectId),
    openLog: (projectId) => invoke(IPC.mascotsOpenLog, projectId),
    onChanged: (listener) => subscribe(IPC.mascotsChanged, listener)
  },
  diagnostics: {
    configuration: () => invoke(IPC.diagnosticsConfiguration),
    send: (description, attachment) => invoke(IPC.diagnosticsSend, description, attachment),
    reportError: (error) => send(IPC.diagnosticsRendererError, error)
  },
  update: {
    status: () => invoke(IPC.updateStatus),
    check: () => invoke(IPC.updateCheck),
    download: () => invoke(IPC.updateDownload),
    install: () => invoke(IPC.updateInstall),
    onStatus: (listener) => subscribe<UpdateStatus>(IPC.updateChanged, listener)
  },
  evenG2: {
    state: () => invoke(IPC.evenG2State),
    command: (command) => invoke(IPC.evenG2Command, command),
    onOpenBrowser: (listener) => subscribe<string>(IPC.evenG2BrowserRequest, listener),
    completeOpenBrowser: (requestId, ok) => send(IPC.evenG2BrowserResponse, { requestId, ok })
  },
  appVersion: () => invoke(IPC.appVersion),
  clipboard: {
    readText: () => invoke(IPC.clipboardRead),
    hasImage: () => invoke(IPC.clipboardHasImage),
    writeText: (text: string) => send(IPC.clipboardWrite, text)
  },
  external: {
    openUrl: (url: string) => invoke(IPC.externalOpenUrl, url)
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch: Partial<AppSettings>) => invoke(IPC.settingsUpdate, patch),
    onChanged: (listener: (settings: AppSettings) => void) => subscribe(IPC.settingsChanged, listener)
  },
  authorThemes: {
    list: () => invoke(IPC.authorThemesList),
    apply: (id: string) => invoke(IPC.authorThemesApply, id)
  },
  skins: {
    list: () => invoke(IPC.terminalBorderSkinsList),
    get: (id: CustomTerminalBorderSkinId) => invoke(IPC.terminalBorderSkinsGet, id),
    onChanged: (listener: () => void) => subscribe<void>(IPC.terminalBorderSkinsChanged, listener)
  },
  wallpapers: {
    list: () => invoke(IPC.wallpapersList),
    install: (request) => invoke(IPC.wallpapersInstall, request),
    importPackage: (bytes) => invoke(IPC.wallpapersImport, bytes),
    read: (id) => invoke(IPC.wallpapersRead, id),
    remove: (id) => invoke(IPC.wallpapersRemove, id),
    export: (id) => invoke(IPC.wallpapersExport, id),
    onChanged: (listener) => subscribe<void>(IPC.wallpapersChanged, listener)
  },
  pixelSkins: {
    list: () => invoke(IPC.pixelSkinsList),
    install: (request: PixelSkinPackInstallRequest) => invoke(IPC.pixelSkinsInstall, request),
    installZip: (request: PixelSkinZipInstallRequest) => invoke(IPC.pixelSkinsInstallZip, request),
    readAsset: (id: PixelTerminalBorderSkinId, slot: PixelSkinSlot) => invoke(IPC.pixelSkinsReadAsset, id, slot),
    onChanged: (listener: () => void) => subscribe<void>(IPC.pixelSkinsChanged, listener)
  },
  agents: {
    availability: () => invoke(IPC.agentsAvailability),
    recheck: () => invoke(IPC.agentsRecheck)
  },
  agentChatHistory: {
    providers: () => invoke(IPC.agentChatHistoryProviders),
    list: (provider, cursor) => invoke(IPC.agentChatHistoryList, provider, cursor),
    resume: (provider, id, position) => invoke(IPC.agentChatHistoryResume, provider, id, position)
  },
  dialog: {
    pickDirectory: (defaultPath?: string) => invoke(IPC.dialogPickDirectory, defaultPath),
    pickMedia: () => invoke(IPC.dialogPickMedia)
  },
  media: {
    read: (path: string) => invoke(IPC.mediaRead, path)
  },
  files: {
    locations: () => invoke(IPC.filesLocations),
    resolvePath: (rootId: string, relativePath: string) => invoke(IPC.filesResolvePath, rootId, relativePath),
    listRoots: () => invoke(IPC.filesListRoots),
    registerRoot: (reference: FileRootReference) => invoke(IPC.filesRegisterRoot, reference),
    openFolder: () => invoke(IPC.filesOpenFolder),
    list: (rootId: string, relativePath: string) => invoke(IPC.filesList, rootId, relativePath),
    read: (rootId: string, relativePath: string) => invoke(IPC.filesRead, rootId, relativePath),
    search: (rootId: string, query: string) => invoke(IPC.filesSearch, rootId, query),
    closeRoot: (rootId: string) => invoke(IPC.filesCloseRoot, rootId)
  },
  materials: {
    addPaths: (paths: string[], point: Point) => invoke(IPC.materialsAddPaths, paths, point),
    snapshot: () => invoke(IPC.materialsSnapshot),
    addFiles: (files: File[], point: Point) => invoke(
      IPC.materialsAddPaths,
      files.map((file) => webUtils.getPathForFile(file)),
      point
    ),
    pick: (point: Point) => invoke(IPC.materialsPick, point),
    paste: (point: Point) => invoke(IPC.materialsPaste, point),
    setBounds: (id: string, bounds: SessionBounds) => send(IPC.materialsSetBounds, id, bounds),
    setBoundsBatch: (entries: { id: string; bounds: SessionBounds }[]) => send(IPC.materialsSetBoundsBatch, entries),
    remove: (id: string) => invoke(IPC.materialsRemove, id),
    pinVersion: (id: string) => invoke(IPC.materialsPinVersion, id),
    reveal: (id: string) => invoke(IPC.materialsReveal, id),
    relink: (id: string) => invoke(IPC.materialsRelink, id),
    acceptMove: (id: string) => invoke(IPC.materialsAcceptMove, id),
    addRemark: (draft: RemarkDraft) => invoke(IPC.materialsAddRemark, draft),
    updateRemark: (id: string, patch: RemarkPatch) => invoke(IPC.materialsUpdateRemark, id, patch),
    deleteRemark: (id: string) => invoke(IPC.materialsDeleteRemark, id),
    previewHandoff: (draft: HandoffDraft) => invoke(IPC.materialsPreviewHandoff, draft),
    sendHandoff: (draft: HandoffDraft) => invoke(IPC.materialsSendHandoff, draft),
    pickResultsFolder: (sessionId: string) => invoke(IPC.materialsPickResultsFolder, sessionId),
    onChanged: (listener: (snapshot: MaterialsSnapshot) => void) => subscribe(IPC.materialsChanged, listener)

  },
  limits: {
    get: () => invoke(IPC.limitsGet)
  },
  providerSecrets: {
    status: () => invoke(IPC.providerSecretsStatus),
    set: (secretId: string, value: string) => invoke(IPC.providerSecretsSet, secretId, value),
    clear: (secretId: string) => invoke(IPC.providerSecretsClear, secretId)
  },
  usageHistory: {
    get: () => invoke(IPC.usageHistoryGet)
  },
  plugins: {
    list: () => invoke(IPC.pluginsList),
    search: (query: string) => invoke(IPC.pluginsSearch, query),
    showcase: () => invoke(IPC.pluginsShowcase),
    icon: (sourceUrls: string[]) => invoke(IPC.pluginsIcon, sourceUrls),
    manifests: (sourceUrls: string[]) => invoke(IPC.pluginsManifests, sourceUrls),
    checkUpdates: () => invoke(IPC.pluginsCheckUpdates),
    update: (pluginId: string) => invoke(IPC.pluginsUpdate, pluginId),
    onUpdatesAvailable: (listener: (updates: PluginUpdateStatus[]) => void) => subscribe(IPC.pluginsUpdatesAvailable, listener),
    previewInstall: (sourceUrl: string) => invoke(IPC.pluginsPreviewInstall, sourceUrl),
    install: (token: string, selectedModules?: string[]) => invoke(IPC.pluginsInstall, token, selectedModules),
    setModules: (pluginId: string, selectedModules: string[]) => (
      invoke(IPC.pluginsSetModules, pluginId, selectedModules)
    ),
    setEnabled: (pluginId: string, enabled: boolean) => invoke(IPC.pluginsSetEnabled, pluginId, enabled),
    setHookEnabled: (pluginId: string, hookId: string, enabled: boolean) => (
      invoke(IPC.pluginsSetHookEnabled, pluginId, hookId, enabled)
    ),
    setNativeCodeTrusted: (pluginId: string, trusted: boolean) => (
      invoke(IPC.pluginsSetNativeCodeTrusted, pluginId, trusted)
    ),
    setDecisionsMayAllow: (pluginId: string, allowed: boolean) => (
      invoke(IPC.pluginsSetDecisionsMayAllow, pluginId, allowed)
    ),
    serviceReport: (pluginId: string) => invoke(IPC.pluginsServiceReport, pluginId),
    serviceRequest: (pluginId: string, serviceId: string, method: string, params: unknown) => (
      invoke(IPC.pluginsServiceRequest, pluginId, serviceId, method, params)
    ),
    onServiceEvent: (listener: (event: PluginServiceEvent) => void) => subscribe(IPC.pluginsServiceEvent, listener),
    cardDecorations: () => invoke(IPC.pluginsCardDecorations),
    onCardDecorations: (listener: (decorations: PluginCardDecorations) => void) => (
      subscribe(IPC.pluginsCardDecorationsChanged, listener)
    ),
    invokeCardAction: (pluginId: string, actionId: string, sessionId: string) => (
      invoke(IPC.pluginsInvokeCardAction, pluginId, actionId, sessionId)
    ),
    launchFieldOptions: (pluginId: string, provider: ProviderId) => (
      invoke(IPC.pluginsLaunchFieldOptions, pluginId, provider)
    ),
    uninstall: (pluginId: string) => invoke(IPC.pluginsUninstall, pluginId),
    openCanvas: (pluginId: string, contributionId: string, sourceCanvasInstanceId?: string) => (
      invoke(IPC.pluginsOpenCanvas, pluginId, contributionId, sourceCanvasInstanceId)
    ),
    openWindow: (pluginId: string, contributionId: string, reuse?: boolean) => invoke(IPC.pluginsOpenWindow, pluginId, contributionId, reuse),
    openExternal: (pluginId: string, url: string) => invoke(IPC.pluginsOpenExternal, pluginId, url),
    openBrowser: (pluginId: string, url: string) => invoke(IPC.pluginsOpenBrowser, pluginId, url),
    storageGet: (pluginId: string, key: string) => invoke(IPC.pluginsStorageGet, pluginId, key),
    storageSet: (pluginId: string, key: string, value: unknown) => invoke(IPC.pluginsStorageSet, pluginId, key, value),
    secretsGet: (pluginId: string, key: string) => invoke(IPC.pluginsSecretsGet, pluginId, key),
    secretsSet: (pluginId: string, key: string, value: string) => invoke(IPC.pluginsSecretsSet, pluginId, key, value),
    secretsDelete: (pluginId: string, key: string) => invoke(IPC.pluginsSecretsDelete, pluginId, key),
    filesRequest: (pluginId: string, method: string, params?: Record<string, unknown>) => invoke(IPC.pluginsFilesRequest, pluginId, method, params),
    fileDropText: (token: string) => invoke(IPC.pluginsFileDropText, token),
    mediaPickLibrary: (pluginId: string) => invoke(IPC.pluginsMediaPickLibrary, pluginId),
    mediaListLibraries: (pluginId: string) => invoke(IPC.pluginsMediaListLibraries, pluginId),
    mediaScanLibrary: (pluginId: string, libraryId: string) => invoke(IPC.pluginsMediaScanLibrary, pluginId, libraryId),
    mediaRevokeLibrary: (pluginId: string, libraryId: string) => invoke(IPC.pluginsMediaRevokeLibrary, pluginId, libraryId),
    playlistsList: (pluginId: string, libraryId: string) => invoke(IPC.pluginsPlaylistsList, pluginId, libraryId),
    playlistsRead: (pluginId: string, libraryId: string, playlistId: string) => invoke(IPC.pluginsPlaylistsRead, pluginId, libraryId, playlistId),
    playlistsWrite: (pluginId: string, libraryId: string, name: string, content: string) => invoke(IPC.pluginsPlaylistsWrite, pluginId, libraryId, name, content),
    desktopWindows: (pluginId, instanceId, action, value) => invoke(IPC.pluginsDesktopWindows, pluginId, instanceId, action, value),
    onDesktopWindowFocus: (listener) => subscribe(IPC.pluginsDesktopWindowFocus, listener),
    hermesHudStatus: (pluginId: string) => invoke(IPC.pluginsHermesHudStatus, pluginId),
    hermesHudOpen: (pluginId: string) => invoke(IPC.pluginsHermesHudOpen, pluginId),
    hermesHudClose: (pluginId: string) => invoke(IPC.pluginsHermesHudClose, pluginId),
    onOpenLauncher: (listener: (event: PluginLauncherRequest) => void) => subscribe(IPC.pluginsLauncherRequested, listener),
    onOpenCanvas: (listener: (event: PluginCanvasRequest) => void) => subscribe(IPC.pluginsCanvasRequested, listener),
    onBrowserOpenRequested: (listener: (event: PluginBrowserOpenRequest) => void) => (
      subscribe(IPC.pluginsBrowserOpenRequested, listener)
    ),
    completeBrowserOpen: (response: PluginBrowserOpenResponse) => (
      invoke(IPC.pluginsBrowserOpenResponded, response)
    ),
    onStorageChanged: (listener: (event: PluginStorageChangeEvent) => void) => subscribe(IPC.pluginsStorageChanged, listener)
  },
  githubAuth: {
    status: () => invoke(IPC.githubAuthStatus),
    start: () => invoke(IPC.githubAuthStart),
    signOut: () => invoke(IPC.githubAuthSignOut),
    cancel: () => invoke(IPC.githubAuthCancel),
    openUrl: (url: string) => invoke(IPC.githubAuthOpenUrl, url)
  },
  browser: {
    getState: () => invoke(IPC.browserGetState),
    open: (url?: string) => invoke(IPC.browserOpen, url),
    close: () => invoke(IPC.browserClose),
    closeAllTabs: () => invoke(IPC.browserCloseAllTabs),
    newTab: (url?: string) => invoke(IPC.browserNewTab, url),
    selectTab: (id: string) => invoke(IPC.browserSelectTab, id),
    closeTab: (id: string) => invoke(IPC.browserCloseTab, id),
    navigate: (id: string, value: string) => invoke(IPC.browserNavigate, id, value),
    back: (id: string) => invoke(IPC.browserBack, id),
    forward: (id: string) => invoke(IPC.browserForward, id),
    reload: (id: string) => invoke(IPC.browserReload, id),
    execute: (command: BrowserCommand) => invoke(IPC.browserExecute, command),
    getActivity: (sinceSequence?: number) => invoke(IPC.browserGetActivity, sinceSequence),
    clearData: () => invoke(IPC.browserClearData),
    focus: () => send(IPC.browserFocus),
    setInputFocused: (focused: boolean) => {
      if(!documentRouter.active())ipcRenderer.sendSync(IPC.browserSetInputFocused, focused);
    },
    setViewport: (bounds: BrowserViewportBounds) => send(IPC.browserSetViewport, bounds),
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
    setShortcutCaptureActive: (active: boolean) => send(IPC.canvasNavigationShortcutCapture, active),
    setTerminalEditFocus: (active: boolean) => send(IPC.canvasNavigationTerminalEditFocus, active),
    setPointerBindingState: (input: CanvasNavigationPointerBindingInput) => (
      send(IPC.canvasNavigationPointerBinding, input)
    ),
    setPointerGestureActive: (active: boolean) => send(IPC.canvasNavigationPointerGesture, active),
    onOverrideState: (listener: (event: CanvasNavigationOverrideStateEvent) => void) => (
      subscribe(IPC.canvasNavigationOverrideState, listener)
    )
  },
  terminal: {
    openFile: (id: string, reference: string) => invoke(IPC.terminalOpenFile, id, reference),
    canOpenFile: (id: string, reference: string) => invoke(IPC.terminalCanOpenFile, id, reference),
    fileDropText: (files: File[]) => {
      const paths=files.map((file)=>webUtils.getPathForFile(file));
      return documentRouter.active()?invoke(IPC.duoUploadFiles,paths):terminalFileDropText(paths,process.platform);
    },
    list: () => invoke(IPC.terminalList),
    readBuffer: (id: string) => invoke(IPC.terminalReadBuffer, id),
    create: (request: CreateSessionRequest) => invoke(IPC.terminalCreate, request),
    restart: (id: string, options?: { resume?: boolean }) => invoke(IPC.terminalRestart, id, options),
    input: (id: string, data: string, protocolReply = false) => send(IPC.terminalInput, id, data, protocolReply),
    resize: (id: string, cols: number, rows: number) => send(IPC.terminalResize, id, cols, rows),
    setBounds: (id: string, bounds: SessionBounds) => send(IPC.terminalBounds, id, bounds),
    rename: (id: string, title: string) => invoke(IPC.terminalRename, id, title),
    setRestore: (id: string, restore: boolean) => invoke(IPC.terminalSetRestore, id, restore),
    dispose: (id: string, options?: { keepEnvironmentData?: boolean }) => invoke(IPC.terminalDispose, id, options),
    setVisible: (id: string, visible: boolean) => send(IPC.terminalSetVisible, id, visible),
    acknowledgeOutput: (id: string, outputOffset: number) => send(IPC.terminalOutputParsed, id, outputOffset),
    onData: (listener: (event: TerminalDataEvent) => void, id?: string) => terminalData.subscribe(listener, id),
    onSession: (listener: (event: SessionEvent) => void) => subscribe(IPC.terminalSession, listener),
    onRemoved: (listener: (event: SessionRemovedEvent) => void) => subscribe(IPC.terminalRemoved, listener),
    resolveGitRisk: (reportId: string, action: "neutralize" | "keep") => invoke(IPC.terminalResolveGitRisk, reportId, action),
    onGitRisk: (listener: (report: GitRiskReport) => void) => subscribe(IPC.terminalGitRisk, listener)
  },
  window: {
    isMacOS: process.platform === "darwin",
    platform: process.platform,
    onOpenUpdates: (listener) => {
      openUpdateListeners.add(listener);
      if (pendingOpenUpdates) { pendingOpenUpdates = false; listener(); }
      return () => { openUpdateListeners.delete(listener); };
    },
    minimize: () => send(IPC.windowMinimize),
    toggleMaximize: () => invoke(IPC.windowToggleMaximize),
    close: () => send(IPC.windowClose),
    getState: () => invoke(IPC.windowGetState),
    onState: (listener) => subscribe(IPC.windowState, listener)
  }
};

contextBridge.exposeInMainWorld("canvasTTY", api);
