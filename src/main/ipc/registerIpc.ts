import { extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import type {
  AppSettings,
  BrowserCommand,
  CanvasNavigationPointerBindingInput,
  CreateSessionRequest,
  PluginBrowserOpenResponse,
  PluginCanvasRequest,
  ProviderId,
  SessionBounds
} from "../../shared/contracts";
import { IPC } from "../../shared/contracts";
import { isCanvasNavigationMouseButton } from "../../shared/canvasNavigation";
import { observeWindowState, readWindowState } from "../windowState";
import type { SettingsStore } from "../services/SettingsStore";
import type { TerminalManager } from "../services/TerminalManager";
import type { LimitsService } from "../services/LimitsService";
import type { PluginManager } from "../services/PluginManager";
import type { PluginMediaService } from "../services/PluginMediaService";
import type { PluginSecretsService } from "../services/PluginSecretsService";
import type { BrowserService } from "../services/BrowserService";
import { normalizePluginBrowserUrl } from "../services/browser/PluginBrowserOpenPolicy";
import { PluginBrowserOpenBroker } from "./PluginBrowserOpenBroker";
import type { GithubAuthService } from "../services/GithubAuthService";
import type { HermesHudService } from "../services/HermesHudService";
import { normalizeExternalUrl } from "../../shared/externalUrl";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MEDIA_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

interface Dependencies {
  settings: SettingsStore;
  terminals: TerminalManager;
  limits: LimitsService;
  plugins: PluginManager;
  pluginMedia: PluginMediaService;
  pluginSecrets: PluginSecretsService;
  browser: BrowserService;
  githubAuth: GithubAuthService;
  hermesHud: HermesHudService;
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

export function registerIpc({
  settings,
  terminals,
  limits,
  plugins,
  pluginMedia,
  pluginSecrets,
  browser,
  githubAuth,
  hermesHud,
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
  const requestPluginBrowserOpen = async (pluginId: string, value: unknown): Promise<void> => {
    plugins.assertPermission(pluginId, "browser:open");
    await pluginBrowserOpenBroker.request(pluginId, normalizePluginBrowserUrl(value));
  };

  ipcMain.handle(IPC.clipboardRead, () => clipboard.readText());
  ipcMain.on(IPC.clipboardWrite, (_event, text: string) => {
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
  ipcMain.handle(IPC.settingsGet, () => settings.get());
  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: Partial<AppSettings>) => {
    const next = await settings.update(patch);
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
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Choose Home media",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return { path, dataUrl: await readMedia(path) };
  });

  ipcMain.handle(IPC.mediaRead, async (_event, path: string) => {
    if (typeof path !== "string" || settings.get().mediaPath !== path) return null;
    try {
      return await readMedia(path);
    } catch (error) {
      console.warn("CanvasTTY media could not be read.", error);
      return null;
    }
  });

  ipcMain.handle(IPC.limitsGet, () => limits.get());

  ipcMain.handle(IPC.pluginsList, (event) => {
    assertMainRenderer(event, getMainWindow);
    return plugins.list();
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
  ipcMain.handle(IPC.pluginsPreviewInstall, (_event, sourceUrl: string) => {
    if (typeof sourceUrl !== "string") throw new Error("GitHub URL is required.");
    return plugins.previewInstall(sourceUrl);
  });
  ipcMain.handle(IPC.pluginsInstall, (_event, token: string, selectedModules?: string[]) => {
    if (typeof token !== "string") throw new Error("Plugin preview token is invalid.");
    if (selectedModules !== undefined && (
      !Array.isArray(selectedModules) || selectedModules.some((item) => typeof item !== "string")
    )) throw new Error("Plugin module selection is invalid.");
    return plugins.install(token, selectedModules);
  });
  ipcMain.handle(IPC.pluginsSetModules, async (_event, pluginId: string, selectedModules: string[]) => {
    if (!Array.isArray(selectedModules) || selectedModules.some((item) => typeof item !== "string")) {
      throw new Error("Plugin module selection is invalid.");
    }
    closePluginWindows(pluginId);
    return plugins.setModules(pluginId, selectedModules);
  });
  ipcMain.handle(IPC.pluginsSetEnabled, async (_event, pluginId: string, enabled: boolean) => {
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
  ipcMain.handle(IPC.pluginsUninstall, async (_event, pluginId: string) => {
    closePluginWindows(pluginId);
    await pluginSecrets.revokeAll(pluginId);
    await pluginMedia.revokeAll(pluginId);
    await plugins.uninstall(pluginId);
  });
  ipcMain.handle(IPC.pluginsOpenCanvas, (
    _event,
    pluginId: string,
    contributionId: string,
    sourceCanvasInstanceId?: string
  ) => {
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
  ipcMain.handle(IPC.pluginsOpenWindow, (_event, pluginId: string, contributionId: string) => (
    openPluginWindow(pluginId, contributionId)
  ));
  ipcMain.handle(IPC.pluginsOpenExternal, async (_event, pluginId: string, value: string) => {
    plugins.assertPermission(pluginId, "external:open");
    const url = normalizeExternalUrl(value);
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC.pluginsOpenBrowser, async (event, pluginId: string, value: unknown) => {
    assertMainRenderer(event, getMainWindow);
    await requestPluginBrowserOpen(pluginId, value);
  });
  ipcMain.handle(IPC.pluginsStorageGet, (_event, pluginId: string, key: string) => (
    plugins.storageGet(pluginId, key)
  ));
  ipcMain.handle(IPC.pluginsStorageSet, async (_event, pluginId: string, key: string, value: unknown) => {
    await plugins.storageSet(pluginId, key, value);
    broadcastPluginStorageChange(pluginId, key, value);
  });
  ipcMain.handle(IPC.pluginsSecretsGet, (_event, pluginId: string, key: string) => (
    pluginSecrets.get(pluginId, key)
  ));
  ipcMain.handle(IPC.pluginsSecretsSet, (_event, pluginId: string, key: string, value: string) => (
    pluginSecrets.set(pluginId, key, value)
  ));
  ipcMain.handle(IPC.pluginsSecretsDelete, (_event, pluginId: string, key: string) => (
    pluginSecrets.delete(pluginId, key)
  ));
  ipcMain.handle(IPC.pluginsMediaPickLibrary, (event, pluginId: string) => (
    pickPluginMediaLibrary(event, pluginId, plugins, pluginMedia)
  ));
  ipcMain.handle(IPC.pluginsMediaListLibraries, (_event, pluginId: string) => (
    pluginMedia.listLibraries(pluginId)
  ));
  ipcMain.handle(IPC.pluginsMediaScanLibrary, (_event, pluginId: string, libraryId: string) => (
    pluginMedia.scanLibrary(pluginId, libraryId)
  ));
  ipcMain.handle(IPC.pluginsMediaRevokeLibrary, (_event, pluginId: string, libraryId: string) => (
    pluginMedia.revokeLibrary(pluginId, libraryId)
  ));
  ipcMain.handle(IPC.pluginsPlaylistsList, (_event, pluginId: string, libraryId: string) => (
    pluginMedia.listPlaylists(pluginId, libraryId)
  ));
  ipcMain.handle(IPC.pluginsPlaylistsRead, (_event, pluginId: string, libraryId: string, playlistId: string) => (
    pluginMedia.readPlaylist(pluginId, libraryId, playlistId)
  ));
  ipcMain.handle(IPC.pluginsPlaylistsWrite, (
    _event,
    pluginId: string,
    libraryId: string,
    name: string,
    content: string
  ) => pluginMedia.writePlaylist(
    pluginId,
    stringValue(libraryId, "libraryId"),
    stringValue(name, "name"),
    playlistContent(content)
  ));
  ipcMain.handle(IPC.pluginsHermesHudStatus, (_event, pluginId: string) => {
    plugins.assertPermission(pluginId, "hermes:hud");
    return hermesHud.status();
  });
  ipcMain.handle(IPC.pluginsHermesHudOpen, (_event, pluginId: string) => {
    plugins.assertPermission(pluginId, "hermes:hud");
    return hermesHud.open();
  });
  ipcMain.handle(IPC.pluginsHermesHudClose, (_event, pluginId: string) => {
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
      return terminals.list().map((session) => ({
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
      return { state: "ready", snapshot: await limits.get() };
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

  ipcMain.handle(IPC.terminalList, () => terminals.list());
  ipcMain.handle(IPC.terminalReadBuffer, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof id !== "string") throw new Error("Terminal session ID is required.");
    return terminals.readBuffer(id);
  });
  ipcMain.handle(IPC.terminalCreate, (_event, request: CreateSessionRequest) => terminals.create(request));
  ipcMain.handle(IPC.terminalRestart, (_event, id: string) => terminals.restart(id));
  ipcMain.on(IPC.terminalInput, (_event, id: string, data: string) => terminals.input(id, data));
  ipcMain.on(IPC.terminalResize, (_event, id: string, cols: number, rows: number) => {
    terminals.resize(id, cols, rows);
  });
  ipcMain.on(IPC.terminalBounds, (_event, id: string, bounds: SessionBounds) => terminals.setBounds(id, bounds));
  ipcMain.handle(IPC.terminalRename, (_event, id: string, title: string) => terminals.rename(id, title));
  ipcMain.handle(IPC.terminalDispose, (_event, id: string) => terminals.dispose(id));

  const publishWindowState = (window: BrowserWindow): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC.windowState, readWindowState(window));
  };

  const mainWindow = getMainWindow();
  if (mainWindow) observeWindowState(mainWindow, () => publishWindowState(mainWindow));

  ipcMain.on(IPC.windowMinimize, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle(IPC.windowToggleMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return readWindowState(null);
    window.isMaximized() ? window.unmaximize() : window.maximize();
    return readWindowState(window);
  });
  ipcMain.on(IPC.windowClose, (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle(IPC.windowGetState, (event) => readWindowState(BrowserWindow.fromWebContents(event.sender)));
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

function assertMainRenderer(
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
  if (value === "terminal" || value === "codex" || value === "claude" || value === "qwen" || value === "kimi" || value === "opencode" || value === "hermes" || value === "grok") return value;
  throw new Error("Plugin requested an unknown launcher provider.");
}

async function readMedia(path: string): Promise<string> {
  const mime = MEDIA_MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error("Unsupported media type.");

  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_MEDIA_BYTES) {
    throw new Error("Media must be a file smaller than 25 MB.");
  }

  const content = await readFile(path);
  return `data:${mime};base64,${content.toString("base64")}`;
}
