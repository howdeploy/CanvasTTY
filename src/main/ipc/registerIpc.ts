import { takeDuoInvitation } from "../services/DuoInvitation";
import { registerDesktopWindowIpc } from "./desktopWindowIpc";
import { capturePresetLayout, mergePresetLayout } from "../services/workspacePresetLayout";
import { DuoCanvasSurface } from "../services/DuoCanvasSurface";
import { DuoDocumentService, setDuoAssetProxy, setDuoStorageReceiver } from '../services/DuoDocumentService';
import { DuoFileTransferService, sendDuoFiles } from '../services/DuoFileTransferService';
import { duoSettingsOps, pickDuoSettings } from '../../shared/duoDocument';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { MaterialService } from '../services/materials/MaterialService';
import { CanvasDuoService } from "../services/CanvasDuoService";
import type { DuoCommand } from "../../shared/canvasDuo";
import { WorkspacePresetStore } from "../services/WorkspacePresetStore";
import { registerLinuxDesktopWindowIpc } from "./linuxDesktopWindowIpc";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, dialog, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions, WebContents } from "electron";
import type {
  WallpaperId,
  WallpaperInstallRequest,
  AppSettings,
  AgentChatHistoryProviderId,
  AgentCliAvailability,
  BrowserCommand,
  CanvasNavigationPointerBindingInput,
  CustomTerminalBorderSkinId,
  CreateSessionRequest,
  FileRootReference,
  PluginBrowserOpenResponse,
  PluginCanvasRequest,
  PluginLaunchFieldOptions,
  PixelSkinPackInstallRequest,
  PixelSkinZipInstallRequest,
  PixelSkinSlot,
  PixelTerminalBorderSkinId,
  ProviderId,
  ProviderSecretId,
  Point,
  SessionBounds
} from "../../shared/contracts";
import { IPC, PROVIDER_SECRET_IDS, isProviderId } from "../../shared/contracts";
import { isCanvasNavigationMouseButton } from "../../shared/canvasNavigation";
import { createWindowStateObserver, readWindowState } from "../windowState";
import type { SettingsStore } from "../services/SettingsStore";
import { isCustomTerminalBorderSkinId, type SkinRegistry } from "../services/SkinRegistry";
import { isPixelSkinSlot, isPixelTerminalBorderSkinId, type PixelSkinPackRegistry } from "../services/PixelSkinPackRegistry";
import { providerCliAvailability, type ProviderCliRegistry } from "../services/providerCliRegistry";
import type { TerminalManager } from "../services/TerminalManager";
import type { AgentChatHistoryService } from "../services/AgentChatHistoryService";
import { withoutAccountScope, type LimitsService } from "../services/LimitsService";
import type { UsageHistoryService } from "../services/UsageHistoryService";
import type { PluginManager } from "../services/PluginManager";
import type { MascotManager } from "../services/MascotManager";
import type { PluginServiceSupervisor } from "../services/PluginServiceSupervisor";
import type { PluginCards } from "../services/PluginCards";
import type { PluginFileService } from "../services/PluginFileService";
import type { PluginMediaService } from "../services/PluginMediaService";
import type { PluginSecretsService } from "../services/PluginSecretsService";
import type { ProviderSecretsService } from "../services/ProviderSecretsService";
import type { BrowserService } from "../services/BrowserService";
import type { FileAccessService } from "../services/FileAccessService";
import type { IpcRegistrar } from "./IpcReadinessGate";
import { normalizePluginBrowserUrl } from "../services/browser/PluginBrowserOpenPolicy";
import { PluginBrowserOpenBroker } from "./PluginBrowserOpenBroker";
import type { GithubAuthService } from "../services/GithubAuthService";
import type { HermesHudService } from "../services/HermesHudService";
import { normalizeExternalUrl } from "../../shared/externalUrl";
import type { WallpaperRegistry } from "../services/WallpaperRegistry";
import { readHomeMedia } from "../services/homeMedia";
import { canOpenTerminalFile, resolveTerminalFilePath } from "../services/terminalFileEditor";

interface CriticalDependencies {
  settings: SettingsStore;
  terminalBorderSkins: SkinRegistry;
  pixelSkinPacks: PixelSkinPackRegistry;
  wallpapers: WallpaperRegistry;
  providerClis: ProviderCliRegistry;
  plugins: PluginManager;
  getMainWindow(): BrowserWindow | null;
}

interface Dependencies {
  duoDiagnostic?:(event:import("../../shared/duoDiagnostics").DuoDiagnosticEvent)=>void;
  materials:MaterialService;
  mascots: MascotManager;
  settings: SettingsStore;
  recheckProviderClis(): Promise<{ availability: AgentCliAvailability; settings: AppSettings }>;
  terminals: TerminalManager;
  agentChatHistory: AgentChatHistoryService;
  limits: LimitsService;
  usageHistory: UsageHistoryService;
  plugins: PluginManager;
  pluginServices: PluginServiceSupervisor;
  pluginCards: PluginCards;
  pluginMedia: PluginMediaService;
  pluginFiles: PluginFileService;
  pluginSecrets: PluginSecretsService;
  providerSecrets: ProviderSecretsService;
  browser: BrowserService;
  files: FileAccessService;
  githubAuth: GithubAuthService;
  hermesHud: HermesHudService;
  launchFieldOptions(pluginId: string, provider: ProviderId): Promise<PluginLaunchFieldOptions>;
  getMainWindow(): BrowserWindow | null;
  applyBrowserSettings(settings: AppSettings): Promise<void> | void;
  setCanvasNavigationShortcutCapture(active: boolean): void;
  setCanvasNavigationTerminalEditFocus(contents: WebContents, active: boolean): void;
  setCanvasNavigationPointerBinding(input: CanvasNavigationPointerBindingInput): void;
  openPluginWindow(pluginId: string, contributionId: string, reuse?: boolean): Promise<void>;
  closePluginWindows(pluginId: string): void;
  requestPluginLauncher(provider: ProviderId): void;
  requestPluginCanvas(request: PluginCanvasRequest): void;
  broadcastPluginStorageChange(pluginId: string, key: string, value: unknown): void;
}

/**
 * The handlers the renderer's first frame depends on (settings, appearance, CLI availability, installed plugins,
 * window chrome), registered as soon as the few services behind them are loaded — before terminals, gateways, the
 * browser and the other services start. Returns the window-state observer the main entry point keeps current.
 */
export function registerCriticalIpc(ipcMain: IpcRegistrar, {
  settings,
  terminalBorderSkins,
  pixelSkinPacks,
  wallpapers,
  providerClis,
  plugins,
  getMainWindow
}: CriticalDependencies): (window: BrowserWindow | null) => void {
  ipcMain.handle(IPC.clipboardRead, (event) => {
    assertMainRenderer(event, getMainWindow);
    const text = clipboard.readText();
    console.info("CanvasTTY clipboard read completed", { characters: text.length });
    return text;
  });
  ipcMain.handle(IPC.clipboardHasImage, (event) => {
    assertMainRenderer(event, getMainWindow);
    return !clipboard.readImage().isEmpty();
  });
  ipcMain.on(IPC.clipboardWrite, (event, text: string) => {
    if (!isMainRenderer(event, getMainWindow)) return;
    if (typeof text === "string" && text.length > 0) {
      clipboard.writeText(text);
      console.info("CanvasTTY clipboard write requested", { characters: text.length });
    }
  });
  ipcMain.handle(IPC.externalOpenUrl, (event, value: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return shell.openExternal(normalizeExternalUrl(value));
  });

  ipcMain.handle(IPC.appVersion, (event) => {
    assertMainRenderer(event, getMainWindow);
    return app.getVersion();
  });
  ipcMain.handle(IPC.settingsGet, (event) => {
    assertMainRenderer(event, getMainWindow);
    return settings.get();
  });
  ipcMain.handle(IPC.terminalBorderSkinsList, (event) => {
    assertMainRenderer(event, getMainWindow);
    return terminalBorderSkins.list();
  });
  ipcMain.handle(IPC.terminalBorderSkinsGet, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!isCustomTerminalBorderSkinId(id)) throw new Error("Custom terminal skin ID is invalid.");
    return terminalBorderSkins.get(id as CustomTerminalBorderSkinId);
  });
  terminalBorderSkins.onChanged(() => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC.terminalBorderSkinsChanged);
  });
  ipcMain.handle(IPC.pixelSkinsList, (event) => {
    assertMainRenderer(event, getMainWindow);
    return pixelSkinPacks.list();
  });
  ipcMain.handle(IPC.pixelSkinsInstall, (event, request: PixelSkinPackInstallRequest) => {
    assertMainRenderer(event, getMainWindow);
    return pixelSkinPacks.install(request);
  });
  ipcMain.handle(IPC.pixelSkinsInstallZip, (event, request: PixelSkinZipInstallRequest) => {
    assertMainRenderer(event, getMainWindow);
    return pixelSkinPacks.installZip(request.archive, request.name, request.apertures);
  });
  ipcMain.handle(IPC.pixelSkinsReadAsset, (event, id: unknown, slot: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!isPixelTerminalBorderSkinId(id) || !isPixelSkinSlot(slot)) return null;
    return pixelSkinPacks.readAsset(id as PixelTerminalBorderSkinId, slot as PixelSkinSlot);
  });
  pixelSkinPacks.onChanged(() => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC.pixelSkinsChanged);
  });
  ipcMain.handle(IPC.wallpapersList, (event, _argument: unknown) => { assertMainRenderer(event, getMainWindow); return wallpapers.list(); });
  ipcMain.handle(IPC.wallpapersInstall, (event, request: WallpaperInstallRequest) => { assertMainRenderer(event, getMainWindow); return wallpapers.install(request); });
  ipcMain.handle(IPC.wallpapersImport, (event, bytes: Uint8Array) => { assertMainRenderer(event, getMainWindow); return wallpapers.importPackage(bytes); });
  ipcMain.handle(IPC.wallpapersRead, (event, id: WallpaperId) => { assertMainRenderer(event, getMainWindow); return wallpapers.read(id); });
  ipcMain.handle(IPC.wallpapersRemove, (event, id: WallpaperId) => { assertMainRenderer(event, getMainWindow); return wallpapers.remove(id); });
  ipcMain.handle(IPC.wallpapersExport, (event, id: WallpaperId) => { assertMainRenderer(event, getMainWindow); return wallpapers.export(id); });
  wallpapers.onChanged(() => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC.wallpapersChanged);
  });
  ipcMain.handle(IPC.agentsAvailability, (event) => {
    assertMainRenderer(event, getMainWindow);
    return providerCliAvailability(providerClis);
  });

  ipcMain.handle(IPC.pluginsList, (event) => {
    assertMainRenderer(event, getMainWindow);
    return plugins.list();
  });

  const observeMainWindow = createWindowStateObserver<BrowserWindow>((window, state) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.windowState, state);
  });
  observeMainWindow(getMainWindow());

  // Window controls come only from the app's own renderer; a foreign sender is dropped or refused.
  ipcMain.on(IPC.windowMinimize, (event) => {
    if (isMainRenderer(event, getMainWindow)) BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(IPC.windowToggleMaximize, (event) => {
    assertMainRenderer(event, getMainWindow);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return readWindowState(null);
    window.isMaximized() ? window.unmaximize() : window.maximize();
    return readWindowState(window);
  });
  ipcMain.on(IPC.windowClose, (event) => {
    if (isMainRenderer(event, getMainWindow)) BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(IPC.windowGetState, (event) => {
    assertMainRenderer(event, getMainWindow);
    return readWindowState(BrowserWindow.fromWebContents(event.sender));
  });

  return observeMainWindow;
}

export function registerIpc(ipcMain: IpcRegistrar, {
  duoDiagnostic,
  materials,
  mascots,
  settings,
  recheckProviderClis,
  terminals,
  agentChatHistory,
  limits,
  usageHistory,
  plugins,
  pluginServices,
  pluginCards,
  pluginMedia,
  pluginFiles,
  pluginSecrets,
  providerSecrets,
  browser,
  files,
  githubAuth,
  hermesHud,
  launchFieldOptions,
  getMainWindow,
  applyBrowserSettings,
  setCanvasNavigationShortcutCapture,
  setCanvasNavigationTerminalEditFocus,
  setCanvasNavigationPointerBinding,
  openPluginWindow,
  closePluginWindows,
  requestPluginLauncher,
  requestPluginCanvas,
  broadcastPluginStorageChange
}: Dependencies): void {
  ipcMain.handle(IPC.mascotsList, (event) => {
    assertMainRenderer(event, getMainWindow);
    return mascots.list();
  });
  ipcMain.handle(IPC.mascotsStart, (event, image: Uint8Array) => {
    assertMainRenderer(event, getMainWindow);
    return mascots.start(image);
  });
  ipcMain.handle(IPC.mascotsLink, (event, projectId: string, sessionId: string) => {
    assertMainRenderer(event, getMainWindow);
    return mascots.link(projectId, sessionId);
  });
  ipcMain.handle(IPC.mascotsFail, (event, projectId: string, message: string) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof message !== "string") throw new Error("Mascot error is invalid.");
    return mascots.fail(projectId, message);
  });
  const pluginBrowserOpenBroker = new PluginBrowserOpenBroker(getMainWindow);
  ipcMain.handle(IPC.mascotsRetry, (event, projectId: string) => {
    assertMainRenderer(event, getMainWindow);
    return mascots.retry(projectId);
  });
  ipcMain.handle(IPC.mascotsOpenLog, async (event, projectId: string) => {
    assertMainRenderer(event, getMainWindow);
    await openSystemFile(await mascots.errorLog(projectId));
  });
  // A surface reaches only its own plugin's services: the caller's plugin id is bound by the
  // renderer frame host or by the identity-checked plugin window, never taken from plugin code.
  const requestPluginService = (pluginId: string, values: Record<string, unknown>): Promise<unknown> => {
    const serviceId = stringValue(values.serviceId, "serviceId");
    plugins.assertService(pluginId, serviceId);
    return pluginServices.request(pluginId, serviceId, stringValue(values.method, "method"), values.params);
  };
  const requestPluginBrowserOpen = async (pluginId: string, value: unknown): Promise<void> => {
    plugins.assertPermission(pluginId, "browser:open");
    await pluginBrowserOpenBroker.request(pluginId, normalizePluginBrowserUrl(value));
  };

  const transfers=new DuoFileTransferService(join(app.getPath('userData'),'Duo Imports'));
  const document=new DuoDocumentService(settings,async(channel,args)=>{
    const window=getMainWindow();if(!window||window.isDestroyed()||!ipcMain.invokeOwned)throw Error('Canvas is not available.');
    return ipcMain.invokeOwned(channel,{sender:window.webContents,senderFrame:window.webContents.mainFrame} as IpcMainInvokeEvent,args);
  },async request=>{
    const scheme=new URL(request.url).protocol;
    if(scheme==='canvastty-preview:')return files.protocolResponse(request);
    if(scheme==='canvastty-material:')return materials.protocolResponse(request);
    if(scheme==='canvastty-plugin:')return plugins.protocolResponse(request.url);
    if(scheme==='canvastty-files:')return pluginFiles.protocolResponse(request);
    if(scheme==='canvastty-media:')return pluginMedia.protocolResponse(request);
    throw Error('Unsupported Canvas resource.');
  },next=>getMainWindow()?.webContents.send(IPC.settingsChanged,next),async(channel,args,allowed)=>browser.duoDocumentResource(channel,args,allowed),transfers);
  setDuoStorageReceiver((id,key,value)=>document.storageChanged(id,key,value));
  const duo = new CanvasDuoService(terminals,{onDiagnostic:duoDiagnostic,cwd:app.getPath('home'),surface:new DuoCanvasSurface(getMainWindow,browser),document,
    files:{
      canOpen:async(id,reference)=>{const session=terminals.getMetadata(id);return session?canOpenTerminalFile(reference,session.cwd):false;},
      open:async(id,reference,authorized)=>{
        const session=terminals.getMetadata(id);if(!session)throw Error('Terminal session does not exist.');
        const path=await resolveTerminalFilePath(reference,session.cwd), folderPath=dirname(path), current=settings.get();
        const card={id:randomUUID(),root:{rootType:'folder' as const,folderPath},label:basename(folderPath),folderPath,activeFile:basename(path),expandedFolders:[],position:{x:session.position.x+60,y:session.position.y+60},size:{width:780,height:520}};
        await document.edit(duoSettingsOps(pickDuoSettings(current),{fileCards:[...current.fileCards,card]}),authorized);
      }
    },
    onChanged:reply=>{const window=getMainWindow();if(window&&!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send(IPC.duoChanged,reply);},
    ...(process.env.CANVASTTY_DUO_LAB_OUTPUT&&process.env.CANVASTTY_DUO_LAB_PUBLIC_ONLY==='1'?{peerOptions:{localConnection:false,shareLocalAddress:false}}:{})});
  setDuoAssetProxy(async request=>{
    if(duo.state().role!=='guest'||!duo.state().documentSync)return null;
    const call=async(channel:string,args:unknown[])=>{
      const reply=await duo.command({action:'resource',channel,args});return reply.snapshot?.result as any;
    };
    try{
      let part=await call('protocol',[request.url,request.headers.get('range')]);let value:any;
      if(part.chunk){let text=part.data;while(text.length<part.total){part=await call('chunk',[part.chunk,text.length]);text+=part.data;}value=JSON.parse(text);}else value=part.value;
      return new Response(Buffer.from(value.body,'base64'),{status:value.status,headers:value.headers});
    }catch{return new Response('Shared asset unavailable.',{status:503});}
  });
  app.once("before-quit", () => { void duo.stop(); });
  ipcMain.handle(IPC.duoDiagnostics, event => {
    assertMainRenderer(event, getMainWindow);
    return {...duo.diagnosticReport(),context:{appVersion:app.getVersion(),platform:process.platform,arch:process.arch}};
  });
  ipcMain.handle(IPC.duoCommand, (event, command: DuoCommand) => {
    assertMainRenderer(event, getMainWindow);
    if (command?.action === 'invitation') return {state:duo.state(),invitation:takeDuoInvitation()};
    return duo.command(command);
  });
  ipcMain.handle(IPC.duoUploadFiles, async(event,paths:unknown)=>{
    assertMainRenderer(event,getMainWindow);
    const workspace=duo.state().workspaceId;
    const authorized=()=>{const state=duo.state();return state.role==='guest'&&state.status==='connected'&&state.manage===true&&state.documentSync===true&&state.workspaceId===workspace;};
    return sendDuoFiles(paths,async args=>{
      if(!authorized())throw Error('Duo: connection or permission changed.');
      const reply=await duo.command({action:'resource',channel:'file-upload',args});
      return (reply.snapshot?.result as {value?:unknown})?.value;
    },authorized);
  });

  const workspacePresets = new WorkspacePresetStore(app.getPath("userData"));
  let presetRestoreQueue: Promise<unknown> = Promise.resolve();
  ipcMain.handle(IPC.workspacePresetsList, (event) => {
    assertMainRenderer(event, getMainWindow);
    return workspacePresets.list();
  });
  ipcMain.handle(IPC.workspacePresetsSave, (event, name: unknown, id?: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return workspacePresets.save(name, terminals.captureWorkspaceSessions(), id, capturePresetLayout(settings.get(), browser.getState().tabs.map(tab => tab.url)));
  });
  ipcMain.handle(IPC.workspacePresetsRemove, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return workspacePresets.remove(id);
  });
  ipcMain.handle(IPC.workspacePresetsRestore, (event, id: unknown, mode: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (mode !== "reopen" && mode !== "continue") throw new Error("Invalid workspace restore mode.");
    const next = presetRestoreQueue.catch(() => undefined).then(async () => {
      const preset = await workspacePresets.get(id);
      const merged = mergePresetLayout(settings.get(), preset.layout);
      const cards = await terminals.restoreWorkspaceSessions(preset.sessions, mode);
      const nextSettings = await settings.update(merged.patch);
      agentChatHistory.settingsChanged();
      getMainWindow()?.webContents.send(IPC.settingsChanged, nextSettings);
      await applyBrowserSettings(nextSettings);
      const urls = new Set(browser.getState().tabs.map(tab => tab.url));
      let browserTabsOpened = 0;
      const failures: string[] = [];
      for (const url of preset.layout.browserUrls) {
        if (urls.has(url)) continue;
        try { await browser.newTab(url); urls.add(url); browserTabsOpened++; }
        catch (error) { failures.push(`${url}: ${error instanceof Error ? error.message : "Could not open tab"}`); }
      }
      return { name: preset.name, cards, surfaces: { added: merged.added, browserTabsOpened, failures } };
    });
    presetRestoreQueue = next;
    return next;
  });

  ipcMain.handle(IPC.agentsRecheck, (event) => {
    assertMainRenderer(event, getMainWindow);
    return recheckProviderClis();
  });
  ipcMain.handle(IPC.agentChatHistoryProviders, (event) => {
    assertMainRenderer(event, getMainWindow);
    return agentChatHistory.providers();
  });
  ipcMain.handle(IPC.agentChatHistoryList, (event, provider: AgentChatHistoryProviderId, cursor?: string) => {
    assertMainRenderer(event, getMainWindow);
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 64)) throw new Error("Invalid history cursor.");
    return agentChatHistory.list(provider, cursor);
  });
  ipcMain.handle(IPC.agentChatHistoryResume, (event, provider: AgentChatHistoryProviderId, id: string, position: Point) => {
    assertMainRenderer(event, getMainWindow);
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error("Invalid history card position.");
    return agentChatHistory.resume(provider, id, position);
  });
  ipcMain.handle(IPC.settingsUpdate, async (event, patch: Partial<AppSettings>) => {
    assertMainRenderer(event, getMainWindow);
    const next = await settings.update(patch);
    agentChatHistory.settingsChanged();
    await applyBrowserSettings(next);
    return next;
  });
  ipcMain.on(IPC.canvasNavigationShortcutCapture, (event, active: boolean) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof active !== "boolean") return;
    setCanvasNavigationShortcutCapture(active);
  });
  ipcMain.on(IPC.canvasNavigationTerminalEditFocus, (event, active: boolean) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof active !== "boolean") return;
    setCanvasNavigationTerminalEditFocus(event.sender, active);
  });
  ipcMain.on(IPC.canvasNavigationPointerBinding, (event, input: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!isCanvasNavigationPointerBindingInput(input)) return;
    setCanvasNavigationPointerBinding(input);
  });
  ipcMain.on(IPC.canvasNavigationOwnerWheel, (event, input: unknown) => {
    assertMainRenderer(event, getMainWindow);
    browser.beginRendererWheelSequence(input, event.sender.getZoomFactor());
    event.returnValue = true;
  });
  ipcMain.on(IPC.canvasNavigationPointerGesture, (event, active: boolean) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof active !== "boolean") return;
    browser.setRendererCanvasGestureActive(active);
  });

  ipcMain.handle(IPC.dialogPickDirectory, async (event, defaultPath?: string) => {
    assertMainRenderer(event, getMainWindow);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Choose a project folder",
      defaultPath: typeof defaultPath === "string" ? defaultPath : settings.get().lastDirectory,
      properties: ["openDirectory", "createDirectory"]
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.dialogPickMedia, async (event) => {
    assertMainRenderer(event, getMainWindow);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Choose Home media",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "apng", "jpg", "jpeg", "webp", "gif"] }]
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return null;
    // Save the file the person picked, not a link to it, so a later read is
    // not redirected by changing the link.
    const path = await realpath(picked);
    return { path, dataUrl: await readHomeMedia(path) };
  });

  ipcMain.handle(IPC.mediaRead, async (event, path: string) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof path !== "string" || settings.get().mediaPath !== path) return null;
    try {
      return await readHomeMedia(path);
    } catch (error) {
      console.warn("CanvasTTY media could not be read.", error);
      return null;
    }
  });

  ipcMain.handle(IPC.filesListRoots, (event) => {
    assertMainRenderer(event, getMainWindow);
    return files.listRoots();
  });

  ipcMain.handle(IPC.filesLocations, event => {
    assertMainRenderer(event, getMainWindow);
    return files.locations();
  });
  ipcMain.handle(IPC.filesResolvePath, (event, rootId: unknown, relativePath: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return files.resolvePath(stringValue(rootId, "rootId"), fileRelativePath(relativePath));
  });
  ipcMain.handle(IPC.filesRegisterRoot, async (event, reference: unknown) => {
    assertMainRenderer(event, getMainWindow);
    const parsed = fileRootReference(reference);
    if (!parsed) throw new Error("File root reference is invalid.");
    try {
      return await files.registerRoot(parsed);
    } catch (error) {
      console.warn("CanvasTTY file root could not be registered.", error);
      return null;
    }
  });
  ipcMain.handle(IPC.filesOpenFolder, async (event) => {
    assertMainRenderer(event, getMainWindow);
    const owner = getMainWindow();
    const options: OpenDialogOptions = {
      title: "Choose a folder",
      properties: ["openDirectory"]
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return null;
    try {
      return files.registerFolderRoot(selected);
    } catch (error) {
      console.warn("CanvasTTY selected folder could not be opened.", error);
      return null;
    }
  });
  ipcMain.handle(IPC.filesList, async (event, rootId: unknown, relativePath: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return files.list(stringValue(rootId, "rootId"), fileRelativePath(relativePath));
  });
  ipcMain.handle(IPC.filesRead, async (event, rootId: unknown, relativePath: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return files.read(stringValue(rootId, "rootId"), fileRelativePath(relativePath));
  });
  ipcMain.handle(IPC.filesSearch, async (event, rootId: unknown, query: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return files.search(stringValue(rootId, "rootId"), fileSearchQuery(query));
  });
  ipcMain.handle(IPC.filesCloseRoot, (event, rootId: unknown) => {
    assertMainRenderer(event, getMainWindow);
    files.releaseRoot(stringValue(rootId, "rootId"));
    return true;
  });

  ipcMain.handle(IPC.usageHistoryGet, (event) => {
    assertMainRenderer(event, getMainWindow);
    return usageHistory.get();
  });

  ipcMain.handle(IPC.limitsGet, (event) => {
    assertMainRenderer(event, getMainWindow);
    return limits.get();
  });

  ipcMain.handle(IPC.pluginsSearch, (event, query: string) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof query !== "string") throw new Error("Search query is required.");
    return plugins.searchGithubPlugins(query);
  });
  ipcMain.handle(IPC.pluginsShowcase, (event) => {
    assertMainRenderer(event, getMainWindow);
    return plugins.listShowcasePlugins();
  });
  ipcMain.handle(IPC.pluginsIcon, async (event, sourceUrls: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!Array.isArray(sourceUrls) || sourceUrls.some((url) => typeof url !== "string")) {
      throw new Error("GitHub URLs are required.");
    }
    const icons = await plugins.fetchPluginIcons(sourceUrls);
    return Object.fromEntries(icons);
  });
  ipcMain.handle(IPC.pluginsManifests, async (event, sourceUrls: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!Array.isArray(sourceUrls) || sourceUrls.some((url) => typeof url !== "string")) {
      throw new Error("GitHub URLs are required.");
    }
    const manifests = await plugins.previewManifests(sourceUrls);
    return Object.fromEntries(manifests);
  });
  ipcMain.handle(IPC.pluginsCheckUpdates, (event) => {
    assertMainRenderer(event, getMainWindow);
    return plugins.checkForUpdates();
  });
  ipcMain.handle(IPC.pluginsUpdate, async (event, pluginId: string) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof pluginId !== "string") throw new Error("Plugin identifier is required.");
    closePluginWindows(pluginId);
    return plugins.updatePlugin(pluginId);
  });
  ipcMain.handle(IPC.pluginsPreviewInstall, (event, sourceUrl: string) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof sourceUrl !== "string") throw new Error("GitHub URL is required.");
    return plugins.previewInstall(sourceUrl);
  });
  ipcMain.handle(IPC.pluginsInstall, (event, token: string, selectedModules?: string[]) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof token !== "string") throw new Error("Plugin preview token is invalid.");
    if (selectedModules !== undefined && (
      !Array.isArray(selectedModules) || selectedModules.some((item) => typeof item !== "string")
    )) throw new Error("Plugin module selection is invalid.");
    return plugins.install(token, selectedModules);
  });
  ipcMain.handle(IPC.pluginsSetModules, async (event, pluginId: string, selectedModules: string[]) => {
    assertMainRenderer(event, getMainWindow);
    if (!Array.isArray(selectedModules) || selectedModules.some((item) => typeof item !== "string")) {
      throw new Error("Plugin module selection is invalid.");
    }
    closePluginWindows(pluginId);
    return plugins.setModules(pluginId, selectedModules);
  });
  ipcMain.handle(IPC.pluginsSetEnabled, async (event, pluginId: string, enabled: boolean) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof enabled !== "boolean") throw new Error("Plugin enabled state is invalid.");
    try {
      return await plugins.setEnabled(pluginId, enabled);
    } finally {
      if (!enabled) closePluginWindows(pluginId);
    }
  });
  ipcMain.handle(IPC.pluginsSetHookEnabled, async (
    event,
    pluginId: string,
    hookId: string,
    enabled: boolean
  ) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof pluginId !== "string" || typeof hookId !== "string" || typeof enabled !== "boolean") {
      throw new Error("Plugin hook state is invalid.");
    }
    return plugins.setHookEnabled(pluginId, hookId, enabled);
  });
  ipcMain.handle(IPC.pluginsSetNativeCodeTrusted, (event, pluginId: string, trusted: boolean) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof pluginId !== "string" || typeof trusted !== "boolean") throw new Error("Plugin native code state is invalid.");
    return plugins.setNativeCodeTrusted(pluginId, trusted);
  });
  ipcMain.handle(IPC.pluginsSetDecisionsMayAllow, (event, pluginId: string, allowed: boolean) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof pluginId !== "string" || typeof allowed !== "boolean") throw new Error("Plugin decision state is invalid.");
    return plugins.setDecisionsMayAllow(pluginId, allowed);
  });
  ipcMain.handle(IPC.pluginsServiceReport, (event, pluginId: string) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof pluginId !== "string") throw new Error("Plugin identifier is required.");
    return pluginServices.report(pluginId);
  });
  ipcMain.handle(IPC.pluginsServiceRequest, (
    event,
    pluginId: string,
    serviceId: string,
    method: string,
    params: unknown
  ) => {
    assertMainRenderer(event, getMainWindow);
    return requestPluginService(pluginId, { serviceId, method, params });
  });
  ipcMain.handle(IPC.pluginsCardDecorations, (event) => {
    assertMainRenderer(event, getMainWindow);
    return pluginCards.decorations();
  });
  ipcMain.handle(IPC.pluginsInvokeCardAction, (event, pluginId: unknown, actionId: unknown, sessionId: unknown) => {
    // Only the app window's own card menu invokes actions; plugin surfaces cannot reach this channel.
    assertMainRenderer(event, getMainWindow);
    if (typeof pluginId !== "string" || typeof actionId !== "string" || typeof sessionId !== "string") {
      throw new Error("Card action request is invalid.");
    }
    return pluginCards.invoke(pluginId, actionId, sessionId);
  });
  ipcMain.handle(IPC.pluginsLaunchFieldOptions, (event, pluginId: unknown, provider: unknown) => {
    // Only the app's own launcher asks; plugin surfaces cannot reach this channel.
    assertMainRenderer(event, getMainWindow);
    if (typeof pluginId !== "string" || typeof provider !== "string") throw new Error("Launch option request is invalid.");
    return launchFieldOptions(pluginId, provider as ProviderId);
  });
  ipcMain.handle(IPC.pluginsUninstall, async (event, pluginId: string) => {
    assertMainRenderer(event, getMainWindow);
    closePluginWindows(pluginId);
    // Uninstall first: it stops the plugin's services before removing its files, and afterwards
    // no surface or service of the plugin passes authorization, so nothing can write a secret or
    // media grant after they are revoked. A failed uninstall keeps the plugin's secrets.
    // A media folder pick still open refuses to store its grant while this runs (and after, the plugin is gone).
    pluginMedia.beginRemoval(pluginId);
    pluginFiles.beginRemoval(pluginId);
    try {
      await plugins.uninstall(pluginId);
      await pluginSecrets.revokeAll(pluginId);
      await pluginMedia.revokeAll(pluginId);
      await pluginFiles.revokeAll(pluginId);
    } finally {
      pluginMedia.endRemoval(pluginId);
      pluginFiles.endRemoval(pluginId);
    }
    pluginServices.forget(pluginId);
  });
  ipcMain.handle(IPC.pluginsOpenCanvas, (
    event,
    pluginId: string,
    contributionId: string,
    sourceCanvasInstanceId?: string
  ) => {
    assertMainRenderer(event, getMainWindow);
    const target = plugins.contribution(pluginId, contributionId);
    if (target.kind !== "canvas-app") throw new Error("Plugin contribution is not a canvas app.");
    requestPluginCanvas({
      pluginId,
      contributionId,
      ...(typeof sourceCanvasInstanceId === "string" && sourceCanvasInstanceId.length <= 80
        ? { sourceCanvasInstanceId }
        : {})
    });
  });
  ipcMain.handle(IPC.pluginsOpenWindow, (event, pluginId: string, contributionId: string, reuse?: boolean) => {
    assertMainRenderer(event, getMainWindow);
    return openPluginWindow(pluginId, contributionId, reuse === true);
  });
  ipcMain.handle(IPC.pluginsOpenExternal, async (event, pluginId: string, value: string) => {
    assertMainRenderer(event, getMainWindow);
    plugins.assertPermission(pluginId, "external:open");
    const url = normalizeExternalUrl(value);
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC.pluginsOpenBrowser, async (event, pluginId: string, value: unknown) => {
    assertMainRenderer(event, getMainWindow);
    await requestPluginBrowserOpen(pluginId, value);
  });
  ipcMain.handle(IPC.pluginsStorageGet, (event, pluginId: string, key: string) => {
    assertMainRenderer(event, getMainWindow);
    return plugins.storageGet(pluginId, key);
  });
  ipcMain.handle(IPC.pluginsStorageSet, async (event, pluginId: string, key: string, value: unknown) => {
    assertMainRenderer(event, getMainWindow);
    await plugins.storageSet(pluginId, key, value);
    broadcastPluginStorageChange(pluginId, key, value);
  });
  ipcMain.handle(IPC.pluginsSecretsGet, (event, pluginId: string, key: string) => {
    assertMainRenderer(event, getMainWindow);
    return pluginSecrets.get(pluginId, key);
  });
  ipcMain.handle(IPC.pluginsSecretsSet, (event, pluginId: string, key: string, value: string) => {
    assertMainRenderer(event, getMainWindow);
    return pluginSecrets.set(pluginId, key, value);
  });
  ipcMain.handle(IPC.pluginsSecretsDelete, (event, pluginId: string, key: string) => {
    assertMainRenderer(event, getMainWindow);
    return pluginSecrets.delete(pluginId, key);
  });
  ipcMain.handle(IPC.providerSecretsStatus, (event) => {
    assertMainRenderer(event, getMainWindow);
    return providerSecrets.status();
  });
  ipcMain.handle(IPC.providerSecretsSet, (event, secretId: string, value: string) => {
    assertMainRenderer(event, getMainWindow);
    return providerSecrets.set(providerSecretValue(secretId), value);
  });
  ipcMain.handle(IPC.providerSecretsClear, (event, secretId: string) => {
    assertMainRenderer(event, getMainWindow);
    return providerSecrets.delete(providerSecretValue(secretId));
  });
  const requestPluginFiles = async (event: IpcMainInvokeEvent, pluginId: string, method: string, input: unknown): Promise<unknown> => {
    plugins.assertPermission(pluginId, "files:read");
    const params = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (method === "files.roots") return pluginFiles.roots(pluginId);
    if (method === "files.pickFolder") {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = { title: "Choose a folder for the file explorer", properties: ["openDirectory"] };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return null;
      return pluginFiles.addRoot(pluginId, result.filePaths[0]);
    }
    const rootId = stringValue(params.rootId, "rootId");
    const relativePath = (params.relativePath === undefined || params.relativePath === "") ? "" : stringValue(params.relativePath, "relativePath");
    if (method === "files.list") return pluginFiles.list(pluginId, rootId, relativePath, params);
    if (method === "files.stat") return pluginFiles.entry(pluginId, rootId, relativePath);
    if (method === "files.readText") return pluginFiles.readText(pluginId, rootId, relativePath);
    if (method === "files.reveal") {
      shell.showItemInFolder(await pluginFiles.revealPath(pluginId, rootId, relativePath));
      return null;
    }
    if (method === "files.revoke") { await pluginFiles.revoke(pluginId, rootId); return null; }
    throw new Error("Unknown plugin file method.");
  };
  ipcMain.handle(IPC.pluginsFilesRequest, (event, pluginId: string, method: string, params: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return requestPluginFiles(event, pluginId, method, params);
  });
  ipcMain.handle(IPC.pluginsFileDropText, (event, token: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return pluginFiles.dropText(stringValue(token, "token"));
  });
  ipcMain.handle(IPC.pluginsMediaPickLibrary, (event, pluginId: string) => {
    assertMainRenderer(event, getMainWindow);
    return pickPluginMediaLibrary(event, pluginId, plugins, pluginMedia);
  });
  ipcMain.handle(IPC.pluginsMediaListLibraries, (event, pluginId: string) => {
    assertMainRenderer(event, getMainWindow);
    return pluginMedia.listLibraries(pluginId);
  });
  ipcMain.handle(IPC.pluginsMediaScanLibrary, (event, pluginId: string, libraryId: string) => {
    assertMainRenderer(event, getMainWindow);
    return pluginMedia.scanLibrary(pluginId, libraryId);
  });
  ipcMain.handle(IPC.pluginsMediaRevokeLibrary, (event, pluginId: string, libraryId: string) => {
    assertMainRenderer(event, getMainWindow);
    return pluginMedia.revokeLibrary(pluginId, libraryId);
  });
  ipcMain.handle(IPC.pluginsPlaylistsList, (event, pluginId: string, libraryId: string) => {
    assertMainRenderer(event, getMainWindow);
    return pluginMedia.listPlaylists(pluginId, libraryId);
  });
  ipcMain.handle(IPC.pluginsPlaylistsRead, (event, pluginId: string, libraryId: string, playlistId: string) => {
    assertMainRenderer(event, getMainWindow);
    return pluginMedia.readPlaylist(pluginId, libraryId, playlistId);
  });
  ipcMain.handle(IPC.pluginsPlaylistsWrite, (
    event,
    pluginId: string,
    libraryId: string,
    name: string,
    content: string
  ) => {
    assertMainRenderer(event, getMainWindow);
    return pluginMedia.writePlaylist(
      pluginId,
      stringValue(libraryId, "libraryId"),
      stringValue(name, "name"),
      playlistContent(content)
    );
  });
  (process.platform === "linux" ? registerLinuxDesktopWindowIpc : registerDesktopWindowIpc)(
    ipcMain, plugins, settings, getMainWindow, (event) => assertMainRenderer(event, getMainWindow),
  );
  ipcMain.handle(IPC.pluginsHermesHudStatus, (event, pluginId: string) => {
    assertMainRenderer(event, getMainWindow);
    plugins.assertPermission(pluginId, "hermes:hud");
    return hermesHud.status();
  });
  ipcMain.handle(IPC.pluginsHermesHudOpen, (event, pluginId: string) => {
    assertMainRenderer(event, getMainWindow);
    plugins.assertPermission(pluginId, "hermes:hud");
    return hermesHud.open();
  });
  ipcMain.handle(IPC.pluginsHermesHudClose, (event, pluginId: string) => {
    assertMainRenderer(event, getMainWindow);
    plugins.assertPermission(pluginId, "hermes:hud");
    return hermesHud.close();
  });
  ipcMain.handle(IPC.pluginsHostInvoke, async (
    event,
    pluginId: string,
    contributionId: string,
    method: string,
    params: unknown
  ) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) throw new Error("Plugin window sender is unavailable.");
    const contribution = assertPluginWindowSender(senderUrl, plugins, pluginId, contributionId);
    const values = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {};
    if (method === "host.getContext") {
      const plugin = plugins.list().find((candidate) => candidate.manifest.id === pluginId)!;
      return {
        apiVersion: 1,
        plugin: {
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          permissions: plugin.manifest.permissions,
          modules: plugin.selectedModules
        },
        contribution: { id: contribution.id, kind: contribution.kind, title: contribution.title },
        appearance: { locale: settings.get().locale, palette: settings.get().palette }
      };
    }
    if (method === "storage.get") return plugins.storageGet(pluginId, stringValue(values.key, "key"));
    if (method === "storage.set") {
      const key = stringValue(values.key, "key");
      await plugins.storageSet(pluginId, key, values.value);
      broadcastPluginStorageChange(pluginId, key, values.value);
      return null;
    }
    if (method === "secrets.get") return pluginSecrets.get(pluginId, stringValue(values.key, "key"));
    if (method === "secrets.set") {
      await pluginSecrets.set(
        pluginId,
        stringValue(values.key, "key"),
        secretValue(values.value)
      );
      return null;
    }
    if (method === "secrets.delete") {
      await pluginSecrets.delete(pluginId, stringValue(values.key, "key"));
      return null;
    }
    if (method === "sessions.list") {
      plugins.assertPermission(pluginId, "sessions:read");
      return terminals.listMetadata().map((session) => ({
        id: session.id,
        provider: session.provider,
        title: session.title,
        status: session.status,
        startedAt: session.startedAt,
        exitCode: session.exitCode
      }));
    }
    if (method === "limits.get") {
      plugins.assertPermission(pluginId, "limits:read");
      return { state: "ready", snapshot: withoutAccountScope(await limits.get()) };
    }
    if (method === "hermesHud.getState") {
      plugins.assertPermission(pluginId, "hermes:hud");
      return hermesHud.status();
    }
    if (method === "hermesHud.open") {
      plugins.assertPermission(pluginId, "hermes:hud");
      return hermesHud.open();
    }
    if (method === "hermesHud.close") {
      plugins.assertPermission(pluginId, "hermes:hud");
      return hermesHud.close();
    }
    if (method === "launcher.open") {
      plugins.assertPermission(pluginId, "launcher:open");
      const provider = providerValue(values.provider);
      requestPluginLauncher(provider);
      return null;
    }
    if (method === "external.open") {
      plugins.assertPermission(pluginId, "external:open");
      await shell.openExternal(normalizeExternalUrl(values.url));
      return null;
    }
    if (method === "browser.open") {
      await requestPluginBrowserOpen(pluginId, values.url);
      return null;
    }
    if (method.startsWith("files.")) return requestPluginFiles(event, pluginId, method, values);
    if (method === "media.pickLibrary") {
      return pickPluginMediaLibrary(event, pluginId, plugins, pluginMedia);
    }
    if (method === "media.listLibraries") return pluginMedia.listLibraries(pluginId);
    if (method === "media.scanLibrary") {
      return pluginMedia.scanLibrary(pluginId, stringValue(values.libraryId, "libraryId"));
    }
    if (method === "media.revokeLibrary") {
      await pluginMedia.revokeLibrary(pluginId, stringValue(values.libraryId, "libraryId"));
      return null;
    }
    if (method === "playlists.list") {
      return pluginMedia.listPlaylists(pluginId, stringValue(values.libraryId, "libraryId"));
    }
    if (method === "playlists.read") {
      return pluginMedia.readPlaylist(
        pluginId,
        stringValue(values.libraryId, "libraryId"),
        stringValue(values.playlistId, "playlistId")
      );
    }
    if (method === "playlists.write") {
      return pluginMedia.writePlaylist(
        pluginId,
        stringValue(values.libraryId, "libraryId"),
        stringValue(values.name, "name"),
        playlistContent(values.content)
      );
    }
    if (method === "service.request") return requestPluginService(pluginId, values);
    if (method === "window.open") {
      const targetId = stringValue(values.contributionId, "contributionId");
      const target = plugins.contribution(pluginId, targetId);
      if (target.kind !== "window") throw new Error("Plugin requested an unknown window contribution.");
      await openPluginWindow(pluginId, targetId, values.reuse === true);
      return null;
    }
    if (method === "canvas.open") {
      const targetId = stringValue(values.contributionId, "contributionId");
      const target = plugins.contribution(pluginId, targetId);
      if (target.kind !== "canvas-app") throw new Error("Plugin requested an unknown canvas contribution.");
      requestPluginCanvas({ pluginId, contributionId: targetId });
      return null;
    }
    throw new Error(`Unsupported plugin method: ${String(method).slice(0, 80)}.`);
  });

  ipcMain.handle(IPC.pluginsBrowserOpenResponded, (event, response: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return pluginBrowserOpenBroker.complete(pluginBrowserOpenResponse(response));
  });

  ipcMain.handle(IPC.browserGetState, (event) => {
    assertMainRenderer(event, getMainWindow);
    return browser.getState();
  });
  ipcMain.handle(IPC.browserOpen, (event, url?: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.open(url);
  });
  ipcMain.handle(IPC.browserClose, (event) => {
    assertMainRenderer(event, getMainWindow);
    return browser.close();
  });
  ipcMain.handle(IPC.browserCloseAllTabs, (event) => {
    assertMainRenderer(event, getMainWindow);
    return browser.closeAllTabs();
  });
  ipcMain.handle(IPC.browserNewTab, (event, url?: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.newTab(url);
  });
  ipcMain.handle(IPC.browserSelectTab, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.selectTab(id);
  });
  ipcMain.handle(IPC.browserCloseTab, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.closeTab(id);
  });
  ipcMain.handle(IPC.browserNavigate, (event, id: string, value: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.navigate(id, value);
  });
  ipcMain.handle(IPC.browserBack, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.back(id);
  });
  ipcMain.handle(IPC.browserForward, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.forward(id);
  });
  ipcMain.handle(IPC.browserReload, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.reload(id);
  });
  ipcMain.handle(IPC.browserExecute, (event, command: BrowserCommand) => {
    assertMainRenderer(event, getMainWindow);
    return browser.executeHuman(command);
  });
  ipcMain.handle(IPC.browserGetActivity, (event, sinceSequence?: number) => {
    assertMainRenderer(event, getMainWindow);
    return browser.getActivity(sinceSequence);
  });
  ipcMain.handle(IPC.browserClearData, (event) => {
    assertMainRenderer(event, getMainWindow);
    return browser.clearData();
  });
  ipcMain.on(IPC.browserFocus, (event) => {
    assertMainRenderer(event, getMainWindow);
    browser.focus();
  });
  ipcMain.on(IPC.browserSetInputFocused, (event, focused: unknown) => {
    assertMainRenderer(event, getMainWindow);
    browser.setInputFocused(focused === true);
    event.returnValue = true;
  });
  ipcMain.on(IPC.browserSetViewport, (event, bounds) => {
    assertMainRenderer(event, getMainWindow);
    browser.setViewport(bounds, event.sender.getZoomFactor());
  });
  ipcMain.on(IPC.browserPageWheelDecision, (event, input: unknown) => {
    event.returnValue = browser.decidePageWheel(event.sender, input);
  });
  ipcMain.on(IPC.browserPageWheel, (event, input: unknown) => {
    browser.handlePageWheel(event.sender, input);
  });

  ipcMain.handle(IPC.githubAuthStatus, (event) => {
    assertMainRenderer(event, getMainWindow);
    return githubAuth.status();
  });
  ipcMain.handle(IPC.githubAuthStart, async (event) => {
    assertMainRenderer(event, getMainWindow);
    const flow = await githubAuth.startDeviceFlow();
    // The trusted renderer chooses the built-in or system browser after it
    // receives this validated device-flow payload.
    return {
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      interval: flow.interval,
      expiresAt: flow.expiresAt
    };
  });
  ipcMain.handle(IPC.githubAuthSignOut, (event) => {
    assertMainRenderer(event, getMainWindow);
    return githubAuth.signOut();
  });
  ipcMain.handle(IPC.githubAuthCancel, (event) => {
    assertMainRenderer(event, getMainWindow);
    githubAuth.cancelDeviceFlow();
  });
  ipcMain.handle(IPC.githubAuthOpenUrl, (event, value: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof value !== "string") throw new Error("URL is required.");
    return shell.openExternal(safeGithubUrl(value));
  });

  ipcMain.handle(IPC.terminalList, (event) => {
    assertMainRenderer(event, getMainWindow);
    return terminals.list();
  });
  ipcMain.handle(IPC.terminalCanOpenFile, (event, id: unknown, reference: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof id !== "string") return false;
    const session = terminals.getMetadata(id);
    return session ? canOpenTerminalFile(reference, session.cwd) : false;
  });
  ipcMain.handle(IPC.terminalOpenFile, async (event, id: unknown, reference: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof id !== "string") throw new Error("Terminal session ID is required.");
    const session = terminals.getMetadata(id);
    if (!session) throw new Error("Terminal session does not exist.");
    await openSystemFile(await resolveTerminalFilePath(reference, session.cwd));
  });
  ipcMain.handle(IPC.terminalReadBuffer, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof id !== "string") throw new Error("Terminal session ID is required.");
    return terminals.readBuffer(id);
  });
  ipcMain.handle(IPC.terminalCreate, (event, request: CreateSessionRequest) => {
    assertMainRenderer(event, getMainWindow);
    return terminals.create(request);
  });
  ipcMain.handle(IPC.terminalRestart, (event, id: string, options?: { resume?: unknown }) => {
    assertMainRenderer(event, getMainWindow);
    return terminals.restart(id, { resume: options?.resume === true });
  });
  ipcMain.on(IPC.terminalInput, (event, id: string, data: string, protocolReply: unknown) => {
    // Fire-and-forget: a foreign sender is dropped instead of throwing into the IPC layer.
    if (!isMainRenderer(event, getMainWindow)) return;
    terminals.input(id, data, protocolReply === true);
  });
  ipcMain.on(IPC.terminalResize, (event, id: string, cols: number, rows: number) => {
    if (!isMainRenderer(event, getMainWindow) || typeof id !== "string") return;
    terminals.resize(id, cols, rows);
  });
  ipcMain.on(IPC.terminalBounds, (event, id: string, bounds: SessionBounds) => {
    if (!isMainRenderer(event, getMainWindow) || typeof id !== "string") return;
    terminals.setBounds(id, bounds);
  });
  ipcMain.handle(IPC.terminalRename, (event, id: string, title: string) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof id !== "string") throw new Error("Terminal session id is invalid.");
    return terminals.rename(id, title);
  });
  ipcMain.handle(IPC.terminalSetRestore, (event, id: string, restore: boolean) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof id !== "string") throw new Error("Terminal session id is invalid.");
    return terminals.setRestore(id, restore);
  });
  ipcMain.handle(IPC.terminalResolveGitRisk, (event, reportId: unknown, action: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof reportId !== "string" || reportId.length > 64) throw new Error("Git warning id is invalid.");
    if (action !== "neutralize" && action !== "keep") throw new Error("Git warning action is invalid.");
    return terminals.resolveGitRisk(reportId, action);
  });
  ipcMain.handle(IPC.terminalDispose, (event, id: string, options?: { keepEnvironmentData?: unknown }) => {
    assertMainRenderer(event, getMainWindow);
    // Environment data is kept unless the person explicitly chose Remove.
    return terminals.dispose(id, { keepEnvironmentData: options?.keepEnvironmentData !== false });
  });
  // Fire-and-forget, like the other stream-reporting channels: a malformed
  // report is ignored rather than rejecting into the renderer.
  ipcMain.on(IPC.terminalSetVisible, (event, id: unknown, visible: unknown) => {
    if (!isMainRenderer(event, getMainWindow) || typeof id !== "string" || typeof visible !== "boolean") return;
    terminals.setVisible(id, visible);
  });
  ipcMain.on(IPC.terminalOutputParsed, (event, id: unknown, outputOffset: unknown) => {
    if (!isMainRenderer(event, getMainWindow) || typeof id !== "string" || typeof outputOffset !== "number") return;
    terminals.acknowledgeOutput(id, outputOffset);
  });

}

function isCanvasNavigationPointerBindingInput(
  value: unknown
): value is CanvasNavigationPointerBindingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.button === "string"
    && isCanvasNavigationMouseButton(input.button)
    && typeof input.pressed === "boolean"
    && typeof input.altKey === "boolean"
    && typeof input.ctrlKey === "boolean"
    && typeof input.metaKey === "boolean"
    && typeof input.shiftKey === "boolean";
}

function isMainRenderer(
  event: IpcMainEvent | IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null
): boolean {
  try {
    assertMainRenderer(event, getMainWindow);
    return true;
  } catch {
    return false;
  }
}

export function assertMainRenderer(
  event: IpcMainEvent | IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null
): void {
  const expected = getMainWindow();
  if (
    !expected
    || expected.isDestroyed()
    || event.sender !== expected.webContents
    || event.senderFrame !== expected.webContents.mainFrame
  ) {
    throw new Error("Browser IPC is available only to the trusted CanvasTTY renderer.");
  }
}

function safeGithubUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("GitHub URL is invalid.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) {
    throw new Error("Only HTTPS github.com URLs may be opened here.");
  }
  return url.toString();
}

function pluginBrowserOpenResponse(value: unknown): PluginBrowserOpenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin browser.open response is invalid.");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.requestId !== "string" || !/^plugin-browser-[a-z0-9]+$/.test(response.requestId)) {
    throw new Error("Plugin browser.open response ID is invalid.");
  }
  if (typeof response.ok !== "boolean") throw new Error("Plugin browser.open response is invalid.");
  if (response.error !== undefined && (typeof response.error !== "string" || response.error.length > 240)) {
    throw new Error("Plugin browser.open response error is invalid.");
  }
  return response.error === undefined
    ? { requestId: response.requestId, ok: response.ok }
    : { requestId: response.requestId, ok: response.ok, error: response.error };
}

function assertPluginWindowSender(
  senderUrl: string,
  plugins: PluginManager,
  pluginId: string,
  contributionId: string
) {
  const contribution = plugins.contribution(pluginId, contributionId);
  if (contribution.kind !== "window") throw new Error("Plugin host request is not from a window contribution.");
  const actual = new URL(senderUrl);
  const expected = new URL(plugins.entryUrl(pluginId, contributionId));
  if (
    actual.protocol !== expected.protocol
    || actual.hostname !== expected.hostname
    || actual.pathname !== expected.pathname
  ) throw new Error("Plugin window identity does not match its loaded entry.");
  return contribution;
}

async function openSystemFile(path: string): Promise<void> {
  // Electron's Linux openPath drops its completion callback; openExternal completes the handoff.
  if (process.platform === "linux") {
    await shell.openExternal(pathToFileURL(path).href);
    return;
  }
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error(`Plugin ${label} parameter is invalid.`);
  }
  return value;
}

function fileRootReference(value: unknown): FileRootReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  if (reference.rootType === "session") {
    if (typeof reference.sessionId !== "string" || reference.sessionId.length === 0 || reference.sessionId.length > 2_048) {
      return null;
    }
    return { rootType: "session", sessionId: reference.sessionId };
  }
  if (reference.rootType === "folder") {
    if (reference.folderPath === undefined) return { rootType: "folder" };
    if (
      typeof reference.folderPath !== "string"
      || reference.folderPath.length === 0
      || reference.folderPath.length > 4_096
    ) return null;
    return { rootType: "folder", folderPath: reference.folderPath };
  }
  return null;
}

function fileRelativePath(value: unknown): string {
  // An empty relative path addresses the root itself, so unlike stringValue it
  // is allowed; FileAccessService re-enforces containment on every operation.
  if (typeof value !== "string" || value.length > 2_048 || value.includes("\0")) {
    throw new Error("File relative path is invalid.");
  }
  return value;
}

function fileSearchQuery(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) {
    throw new Error("File search query is invalid.");
  }
  return value;
}

function playlistContent(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4 * 1024 * 1024) {
    throw new Error("Plugin playlist content is invalid or exceeds 4 MB.");
  }
  return value;
}

function secretValue(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new Error("Plugin secret value is invalid or exceeds 16 KB.");
  }
  return value;
}

async function pickPluginMediaLibrary(
  event: IpcMainInvokeEvent,
  pluginId: string,
  plugins: PluginManager,
  pluginMedia: PluginMediaService
) {
  plugins.assertPermission(pluginId, "media:library");
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: OpenDialogOptions = {
    title: "Choose a music library",
    properties: ["openDirectory"]
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  const selected = result.filePaths[0];
  return result.canceled || !selected ? null : pluginMedia.addLibrary(pluginId, selected);
}

function providerValue(value: unknown): ProviderId {
  if (isProviderId(value)) return value;
  throw new Error("Plugin requested an unknown launcher provider.");
}

function providerSecretValue(value: string): ProviderSecretId {
  if ((PROVIDER_SECRET_IDS as readonly string[]).includes(value)) return value as ProviderSecretId;
  throw new Error("Provider secret id is unknown.");
}
