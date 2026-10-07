import { realpath } from "node:fs/promises";
import { app, BrowserWindow, clipboard, dialog, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import type {
  AppSettings,
  AgentChatHistoryProviderId,
  AgentCliAvailability,
  BrowserCommand,
  CanvasNavigationPointerBindingInput,
  CustomTerminalBorderSkinId,
  CreateSessionRequest,
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
import type { PluginServiceSupervisor } from "../services/PluginServiceSupervisor";
import type { PluginCards } from "../services/PluginCards";
import type { PluginMediaService } from "../services/PluginMediaService";
import type { PluginSecretsService } from "../services/PluginSecretsService";
import type { ProviderSecretsService } from "../services/ProviderSecretsService";
import type { BrowserService } from "../services/BrowserService";
import type { IpcRegistrar } from "./IpcReadinessGate";
import { normalizePluginBrowserUrl } from "../services/browser/PluginBrowserOpenPolicy";
import { PluginBrowserOpenBroker } from "./PluginBrowserOpenBroker";
import type { GithubAuthService } from "../services/GithubAuthService";
import type { HermesHudService } from "../services/HermesHudService";
import { normalizeExternalUrl } from "../../shared/externalUrl";
import { readHomeMedia } from "../services/homeMedia";
import { openTerminalFile } from "../services/terminalFileEditor";

interface CriticalDependencies {
  settings: SettingsStore;
  terminalBorderSkins: SkinRegistry;
  pixelSkinPacks: PixelSkinPackRegistry;
  providerClis: ProviderCliRegistry;
  plugins: PluginManager;
  getMainWindow(): BrowserWindow | null;
}

interface Dependencies {
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
  pluginSecrets: PluginSecretsService;
  providerSecrets: ProviderSecretsService;
  browser: BrowserService;
  githubAuth: GithubAuthService;
  hermesHud: HermesHudService;
  launchFieldOptions(pluginId: string, provider: ProviderId): Promise<PluginLaunchFieldOptions>;
  getMainWindow(): BrowserWindow | null;
  applyBrowserSettings(settings: AppSettings): Promise<void> | void;
  setCanvasNavigationShortcutCapture(active: boolean): void;
  setCanvasNavigationPointerBinding(input: CanvasNavigationPointerBindingInput): void;
  openPluginWindow(pluginId: string, contributionId: string): Promise<void>;
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
  providerClis,
  plugins,
  getMainWindow
}: CriticalDependencies): (window: BrowserWindow | null) => void {
  ipcMain.handle(IPC.clipboardRead, (event) => {
    assertMainRenderer(event, getMainWindow);
    return clipboard.readText();
  });
  ipcMain.handle(IPC.clipboardHasImage, (event) => {
    assertMainRenderer(event, getMainWindow);
    return !clipboard.readImage().isEmpty();
  });
  ipcMain.on(IPC.clipboardWrite, (event, text: string) => {
    if (!isMainRenderer(event, getMainWindow)) return;
    if (typeof text === "string" && text.length > 0) clipboard.writeText(text);
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
  pluginSecrets,
  providerSecrets,
  browser,
  githubAuth,
  hermesHud,
  launchFieldOptions,
  getMainWindow,
  applyBrowserSettings,
  setCanvasNavigationShortcutCapture,
  setCanvasNavigationPointerBinding,
  openPluginWindow,
  closePluginWindows,
  requestPluginLauncher,
  requestPluginCanvas,
  broadcastPluginStorageChange
}: Dependencies): void {
  const pluginBrowserOpenBroker = new PluginBrowserOpenBroker(getMainWindow);
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
  ipcMain.on(IPC.canvasNavigationPointerBinding, (event, input: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!isCanvasNavigationPointerBindingInput(input)) return;
    setCanvasNavigationPointerBinding(input);
  });
  ipcMain.on(IPC.canvasNavigationOwnerWheel, (event, input: unknown) => {
    assertMainRenderer(event, getMainWindow);
    browser.beginRendererWheelSequence(input);
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
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]
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
    try {
      await plugins.uninstall(pluginId);
      await pluginSecrets.revokeAll(pluginId);
      await pluginMedia.revokeAll(pluginId);
    } finally {
      pluginMedia.endRemoval(pluginId);
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
  ipcMain.handle(IPC.pluginsOpenWindow, (event, pluginId: string, contributionId: string) => {
    assertMainRenderer(event, getMainWindow);
    return openPluginWindow(pluginId, contributionId);
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
      await openPluginWindow(pluginId, targetId);
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
    browser.setViewport(bounds);
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
  ipcMain.handle(IPC.githubAuthOpenUrl, (event, value: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof value !== "string") throw new Error("URL is required.");
    return shell.openExternal(safeGithubUrl(value));
  });

  ipcMain.handle(IPC.terminalList, (event) => {
    assertMainRenderer(event, getMainWindow);
    return terminals.list();
  });
  ipcMain.handle(IPC.terminalOpenFile, (event, id: unknown, reference: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof id !== "string") throw new Error("Terminal session ID is required.");
    const session = terminals.getMetadata(id);
    if (!session) throw new Error("Terminal session does not exist.");
    return openTerminalFile(reference, session.cwd);
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
  ipcMain.on(IPC.terminalInput, (event, id: string, data: string) => {
    // Fire-and-forget: a foreign sender is dropped instead of throwing into the IPC layer.
    if (!isMainRenderer(event, getMainWindow)) return;
    terminals.input(id, data);
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

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error(`Plugin ${label} parameter is invalid.`);
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
