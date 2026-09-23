import type { AccountLoginService } from '../services/AccountLogin.ts';
import type { ServerProvisioning } from '../services/ServerProvisioning.ts';
import type { DecisionCoordinator } from '../services/decision/DecisionCoordinator.ts';
import type { DecisionSecrets } from '../services/decision/DecisionSecrets.ts';
import type { DecisionInput } from '../../shared/decisions.ts';
import type { PreferenceReviewService } from '../services/PreferenceReviewService';
import type { AdvisoryReviewRequest } from '../../shared/capsules';
import type { ConventionValidatorService } from '../services/ConventionValidatorService';
import type { ContextFeedbackAction, ContextFeedbackInput, ContextLearning } from '../../shared/contextFeedback';
import type { ContextProfileStore } from "../services/ContextProfileStore";
import type { ContextProject, ContextTask, ContextRuleInput, ContextSelection } from "../../shared/contextProfiles";
import { contextText } from '../../shared/contextProfiles';
import { isProviderSecretRef } from "../../shared/providerAccountPolicy";
import { mutateProviderCredential } from "../services/ProviderCredentialSettings";
import { inspectAccountHome } from "../services/AccountHomeInspection";
import type { SavedHostDiagnostics } from "../services/SavedHostDiagnostics";
import type { ContainerExecutionService } from "../services/ContainerExecutionService";
import type { CapsuleLaunchService } from '../services/CapsuleLaunchService';
import type { CapsuleTestService } from '../services/CapsuleTestService';
import type { PrepareCapsuleRequest } from '../../shared/capsules';
import type { WorktreeService } from "../services/WorktreeService";
import type { LocalOperationalMetricsService } from "../services/LocalOperationalMetrics";
import type { RemoteHostMetricsService } from "../services/RemoteHostMetrics";
import { extname } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import type {
  AppSettings,
  AgentCliAvailability,
  BrowserCommand,
  CanvasNavigationPointerBindingInput,
  CreateSessionRequest,
  PluginBrowserOpenResponse,
  PluginCanvasRequest,
  ProviderId,
  ProviderSecretId,
  SessionBounds
} from "../../shared/contracts";
import { IPC, PROVIDER_SECRET_IDS } from "../../shared/contracts";
import { isCanvasNavigationMouseButton } from "../../shared/canvasNavigation";
import { observeWindowState, readWindowState } from "../windowState";
import type { SettingsStore } from "../services/SettingsStore";
import { providerCliAvailability, type ProviderCliRegistry } from "../services/providerCliRegistry";
import type { TerminalManager } from "../services/TerminalManager";
import type { LimitsService } from "../services/LimitsService";
import type { PluginManager } from "../services/PluginManager";
import type { PluginMediaService } from "../services/PluginMediaService";
import type { PluginSecretsService } from "../services/PluginSecretsService";
import type { ProviderSecretsService } from "../services/ProviderSecretsService";
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
  decisions: DecisionCoordinator; decisionSecrets: DecisionSecrets;
  contextProfiles: ContextProfileStore;
  conventionValidator: ConventionValidatorService;
  preferenceReview: PreferenceReviewService;
  capsuleTests: CapsuleTestService;
  capsules: CapsuleLaunchService;
  hostDiagnostics: SavedHostDiagnostics;
  serverProvisioning: ServerProvisioning;
  accountLogin: AccountLoginService;
  containers: ContainerExecutionService;
  worktrees: WorktreeService;
  localMetrics: LocalOperationalMetricsService;
  remoteMetrics: RemoteHostMetricsService;
  settings: SettingsStore;
  providerClis: ProviderCliRegistry;
  recheckProviderClis(): Promise<{ availability: AgentCliAvailability; settings: AppSettings }>;
  terminals: TerminalManager;
  limits: LimitsService;
  plugins: PluginManager;
  pluginMedia: PluginMediaService;
  pluginSecrets: PluginSecretsService;
  providerSecrets: ProviderSecretsService;
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
  decisions, decisionSecrets,
  contextProfiles,
  capsuleTests,
  conventionValidator,
  preferenceReview,
  capsules,
  hostDiagnostics,
  serverProvisioning,
  accountLogin,
  containers,
  worktrees,
  localMetrics,
  remoteMetrics,
  settings,
  providerClis,
  recheckProviderClis,
  terminals,
  limits,
  plugins,
  pluginMedia,
  pluginSecrets,
  providerSecrets,
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
  ipcMain.handle(IPC.decisionRecommend, (event, input: DecisionInput) => { assertMainRenderer(event, getMainWindow); return decisions.recommend(input); });
  ipcMain.handle(IPC.decisionLaunch, (event, id: string, position: { x: number; y: number }) => { assertMainRenderer(event, getMainWindow); return decisions.launch(id, undefined, position); });
  ipcMain.handle(IPC.decisionCancel, (event, id: string) => { assertMainRenderer(event, getMainWindow); return decisions.cancel(id); });
  ipcMain.handle(IPC.decisionAssemble, (event, efforts: unknown) => { assertMainRenderer(event, getMainWindow); return decisions.assemble(efforts); });
  ipcMain.handle(IPC.decisionSecretStatus, event => { assertMainRenderer(event, getMainWindow); return decisionSecrets.status(); });
  ipcMain.handle(IPC.decisionSecretSet, (event, value: string) => { assertMainRenderer(event, getMainWindow); return decisionSecrets.set(value); });
  ipcMain.handle(IPC.decisionSecretRemove, event => { assertMainRenderer(event, getMainWindow); return decisionSecrets.remove(); });
  ipcMain.handle(IPC.contextSource, (event, cwd: string) => {
    assertMainRenderer(event, getMainWindow); contextText(cwd, 4096, 'source path');
    return settings.get().contextProfilesEnabled ? contextProfiles.source(cwd) : { enabled: false, tasks: [] };
  });
  ipcMain.handle(IPC.contextLaunchPreview, (event, request: CreateSessionRequest) => { assertMainRenderer(event, getMainWindow); return terminals.previewContextLaunch(request); });
  ipcMain.handle(IPC.contextGet, event => { assertMainRenderer(event, getMainWindow); return contextProfiles.get(); });
  ipcMain.handle(IPC.contextProject, (event, input: Omit<ContextProject, 'id'> & { id?: string }, revision: number) => { assertMainRenderer(event, getMainWindow); return contextProfiles.saveProject(input, revision); });
  ipcMain.handle(IPC.contextTask, (event, input: Omit<ContextTask, 'id'> & { id?: string }, revision: number) => { assertMainRenderer(event, getMainWindow); return contextProfiles.saveTask(input, revision); });
  ipcMain.handle(IPC.contextRule, (event, input: ContextRuleInput, revision: number) => { assertMainRenderer(event, getMainWindow); return contextProfiles.saveRule(input, revision); });
  ipcMain.handle(IPC.contextRemove, (event, kind: 'project' | 'task' | 'rule', id: string, revision: number) => { assertMainRenderer(event, getMainWindow); return contextProfiles.remove(kind, id, revision); });
  ipcMain.handle(IPC.contextFeedbackSessions, (event, projectId: string) => { assertMainRenderer(event, getMainWindow); return contextProfiles.feedbackSessions(projectId, () => terminals.listMetadata(), id => terminals.contextFeedbackEvidence(id)); });
  ipcMain.handle(IPC.contextLearning, (event, projectId: string, input: ContextLearning, revision: number) => { assertMainRenderer(event, getMainWindow); return contextProfiles.saveLearning(projectId, input, revision); });
  ipcMain.handle(IPC.contextFeedback, (event, input: ContextFeedbackInput, revision: number) => { assertMainRenderer(event, getMainWindow); return contextProfiles.captureFeedback(input, revision, () => terminals.contextFeedbackEvidence(input.sessionId!)); });
  ipcMain.handle(IPC.contextFeedbackAction, (event, action: ContextFeedbackAction, revision: number) => { assertMainRenderer(event, getMainWindow); return contextProfiles.feedbackAction(action, revision); });
  ipcMain.handle(IPC.contextPreview, (event, selection: ContextSelection) => { assertMainRenderer(event, getMainWindow); return contextProfiles.preview(selection); });
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
  ipcMain.handle(IPC.operationalMetricsLocal, (event) => {
    assertMainRenderer(event, getMainWindow);
    return localMetrics.collect();
  });
  ipcMain.handle(IPC.hostsInspect, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return hostDiagnostics.inspect(id); });
  ipcMain.handle(IPC.accountLogin, (event, request: unknown) => { assertMainRenderer(event, getMainWindow); return accountLogin.start(request); });
  ipcMain.handle(IPC.hostsPrepare, (event, hostIds: unknown) => { assertMainRenderer(event, getMainWindow); return serverProvisioning.start(hostIds); });
  ipcMain.handle(IPC.hostsPrepareStatus, (event, jobIds: unknown) => { assertMainRenderer(event, getMainWindow); return serverProvisioning.status(jobIds); });
  ipcMain.handle(IPC.operationalMetricsRemote, (event, hostId: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof hostId !== "string" || hostId.length > 64) throw new Error("A configured remote host id is required.");
    const host = settings.get().remoteHosts.find((candidate) => candidate.id === hostId);
    if (!host) throw new Error("Remote host is not configured.");
    return remoteMetrics.collect(host);
  });
  const workspaceId = (value: unknown): string => {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) throw new Error("Invalid workspace identity.");
    return value;
  };
  ipcMain.handle(IPC.containersProbe, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id)) throw new Error("A saved container profile is required.");
    return containers.probe(id);
  });
  ipcMain.handle(IPC.containersList, event => { assertMainRenderer(event, getMainWindow); return containers.list(); });
  ipcMain.handle(IPC.containersInventory, (event, ids: unknown, force: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 64 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id))) || force !== undefined && typeof force !== 'boolean') throw new Error('Invalid container inventory selection.');
    return containers.inventory(ids as string[] | undefined, force as boolean | undefined);
  });
  ipcMain.handle(IPC.containersCleanup, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return containers.cleanup(workspaceId(id)); });
  ipcMain.handle(IPC.containersReview, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return containers.review(workspaceId(id)); });
  ipcMain.handle(IPC.containersExport, async (event, id: unknown, reviewId: unknown) => {
    assertMainRenderer(event, getMainWindow);
    const generation = workspaceId(id), token = workspaceId(reviewId);
    const cached = containers.cachedReview(generation, token);
    const options = { defaultPath: `canvastty-remote-${cached.workspaceId}.patch`, filters: [{ name: "Git patch", extensions: ["patch"] }] };
    const window = getMainWindow();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    const review = await containers.exportReview(generation, token);
    await writeFile(result.filePath, review.patch, { mode: 0o600 });
    return true;
  });
  ipcMain.handle(IPC.workspacesList, (event) => { assertMainRenderer(event, getMainWindow); return worktrees.list(); });
  ipcMain.handle(IPC.capsulesSelectFiles, async (event, source: unknown) => {
    assertMainRenderer(event, getMainWindow);
    const directory = await capsules.sourceDirectory(source), window = getMainWindow();
    const options: OpenDialogOptions = { defaultPath: directory, properties: ['openFile', 'multiSelections', 'dontAddToRecent'] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : capsules.selectedFiles(directory, result.filePaths);
  });
  ipcMain.handle(IPC.capsulesPrepare, async (event, input: PrepareCapsuleRequest) => { assertMainRenderer(event, getMainWindow); const result = await capsules.prepare(input); return capsules.summary(result.id); });
  ipcMain.handle(IPC.capsulesList, event => { assertMainRenderer(event, getMainWindow); return capsules.list(); });
  ipcMain.handle(IPC.capsulesTestStart, (event, id: unknown, review: unknown, profile: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(profile)) throw new Error('A saved test profile is required.');
    return capsuleTests.start(workspaceId(id), workspaceId(review), profile);
  });
  ipcMain.handle(IPC.capsulesTestList, event => { assertMainRenderer(event, getMainWindow); return capsuleTests.list(); });
  ipcMain.handle(IPC.capsulesTestResult, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return capsuleTests.get(workspaceId(id)); });
  ipcMain.handle(IPC.capsulesTestCancel, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return capsuleTests.cancel(workspaceId(id)); });
  ipcMain.handle(IPC.capsulesTestCleanup, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return capsuleTests.cleanup(workspaceId(id)); });
  ipcMain.handle(IPC.capsulesReviewAgentChoices, (event, id: unknown, review: unknown) => { assertMainRenderer(event, getMainWindow); return preferenceReview.choices(workspaceId(id), workspaceId(review)); });
  ipcMain.handle(IPC.capsulesReviewAgentPreview, (event, input: AdvisoryReviewRequest) => { assertMainRenderer(event, getMainWindow); return preferenceReview.preview(input); });
  ipcMain.handle(IPC.capsulesReviewAgentLaunch, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return preferenceReview.launch(workspaceId(id)); });
  ipcMain.handle(IPC.capsulesReviewAgentCancel, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); preferenceReview.cancel(workspaceId(id)); });
  ipcMain.handle(IPC.capsulesConventions, (event, id: unknown, review: unknown, clearance: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof clearance !== 'string' || !/^D[0-3]$/u.test(clearance)) throw new Error('Invalid convention report clearance.');
    return conventionValidator.run(workspaceId(id), workspaceId(review), clearance as 'D0' | 'D1' | 'D2' | 'D3');
  });
  ipcMain.handle(IPC.capsulesConventionsCurrent, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return conventionValidator.current(workspaceId(id)); });
  ipcMain.handle(IPC.capsulesReview, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return capsules.review(workspaceId(id)); });
  ipcMain.handle(IPC.capsulesApply, (event, id: unknown, review: unknown) => { assertMainRenderer(event, getMainWindow); return capsules.apply(workspaceId(id), workspaceId(review)); });
  ipcMain.handle(IPC.capsulesRecover, (event, id: unknown, review: unknown) => { assertMainRenderer(event, getMainWindow); return capsules.recoverApply(workspaceId(id), workspaceId(review)); });
  ipcMain.handle(IPC.capsulesCleanup, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return capsules.cleanup(workspaceId(id)); });
  ipcMain.handle(IPC.capsulesExport, async (event, id: unknown, reviewId: unknown) => {
    assertMainRenderer(event, getMainWindow);
    const capsuleId = workspaceId(id), token = workspaceId(reviewId);
    await capsules.exportReview(capsuleId, token);
    const options = { defaultPath: `canvastty-capsule-${capsuleId}.patch`, filters: [{ name: 'Git patch', extensions: ['patch'] }] }, window = getMainWindow();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    const review = await capsules.exportReview(capsuleId, token);
    await writeFile(result.filePath, review.patch, { mode: 0o600 }); return true;
  });
  ipcMain.handle(IPC.workspacesReview, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return worktrees.review(workspaceId(id)); });
  ipcMain.handle(IPC.workspacesCleanup, (event, id: unknown) => { assertMainRenderer(event, getMainWindow); return worktrees.cleanup(workspaceId(id)); });
  ipcMain.handle(IPC.workspacesExport, async (event, id: unknown, reviewId: unknown) => {
    assertMainRenderer(event, getMainWindow);
    const review = worktrees.exportReview(workspaceId(id), workspaceId(reviewId));
    const options = { defaultPath: `canvastty-${review.workspaceId}.patch`, filters: [{ name: "Git patch", extensions: ["patch"] }] };
    const window = getMainWindow();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, review.patch, { mode: 0o600 });
    return true;
  });
  ipcMain.handle(IPC.accountHomesInspect, (event, directory: unknown) => { assertMainRenderer(event, getMainWindow); return inspectAccountHome(directory); });
  ipcMain.handle(IPC.settingsGet, () => settings.get());
  ipcMain.handle(IPC.agentsAvailability, (event) => {
    assertMainRenderer(event, getMainWindow);
    return providerCliAvailability(providerClis);
  });
  ipcMain.handle(IPC.agentsRecheck, (event) => {
    assertMainRenderer(event, getMainWindow);
    return recheckProviderClis();
  });
  ipcMain.handle(IPC.settingsUpdate, async (event, patch: Partial<AppSettings>) => {
    assertMainRenderer(event, getMainWindow);
    const next = await settings.update(patch);
    decisions?.invalidate();
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
  ipcMain.handle(IPC.providerSecretsStatus, (event) => { assertMainRenderer(event, getMainWindow); return providerSecrets.status(); });
  ipcMain.handle(IPC.providerSecretsSet, (event, secretId: string, value: string) => { assertMainRenderer(event, getMainWindow); const ref = providerSecretValue(secretId); return mutateProviderCredential(settings, ref, () => providerSecrets.set(ref, value)); });
  ipcMain.handle(IPC.providerSecretsClear, (event, secretId: string) => { assertMainRenderer(event, getMainWindow); const ref = providerSecretValue(secretId); return mutateProviderCredential(settings, ref, () => providerSecrets.delete(ref)); });
  ipcMain.handle(IPC.providerSecretsCreate, (event, owner, value) => { assertMainRenderer(event, getMainWindow); return providerSecrets.create(owner, value); });
  ipcMain.handle(IPC.providerSecretsScopedStatus, (event) => { assertMainRenderer(event, getMainWindow); return providerSecrets.scopedStatus(); });
  ipcMain.handle(IPC.providerSecretsUpdate, (event, ref, owner, value) => { assertMainRenderer(event, getMainWindow); const profile = settings.get().apiProfiles.find(profile => profile.id === owner?.profileId && (profile.hostId ?? "local") === owner?.hostId && profile.secretRef === ref);
    if (!profile || owner?.hostId !== "local") throw new Error("Credential does not belong to this local API profile.");
    return mutateProviderCredential(settings, ref, () => providerSecrets.update(ref, owner, value)); });
  ipcMain.handle(IPC.providerSecretsRemove, (event, ref, owner) => { assertMainRenderer(event, getMainWindow); if (!isProviderSecretRef(ref) || !ref.startsWith("secret:")) throw new Error("Only a profile-owned credential can be removed here.");
    const profile = settings.get().apiProfiles.find(profile => profile.secretRef === ref);
    if (profile && (profile.id !== owner?.profileId || (profile.hostId ?? "local") !== owner?.hostId)) throw new Error("Credential does not belong to this profile.");
    return mutateProviderCredential(settings, ref, () => providerSecrets.remove(ref, owner)); });
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
  ipcMain.handle(IPC.terminalCreate, (event, request: CreateSessionRequest) => { assertMainRenderer(event, getMainWindow); return request?.containerPlacement !== undefined ? terminals.createWithPlacement(request) : terminals.create(request); });
  ipcMain.handle(IPC.terminalContainerPlacementPreview, (event, request: CreateSessionRequest) => { assertMainRenderer(event, getMainWindow); return terminals.previewContainerPlacement(request); });
  ipcMain.handle(IPC.terminalAgentPrompt, (event, id: string, text: string) => { assertMainRenderer(event, getMainWindow); return terminals.sendAgentPrompt(id, text, true, 'user'); });
  ipcMain.handle(IPC.terminalCancelTurn, (event, id: string) => { assertMainRenderer(event, getMainWindow); return terminals.cancelAgentTurn(id); });
  ipcMain.handle(IPC.terminalAcpPermission, (event, id: string, requestId: string, optionId: string) => { assertMainRenderer(event, getMainWindow); return terminals.decideAcpPermission(id, requestId, optionId); });
  ipcMain.handle(IPC.terminalAcpModel, (event, id: string, value: string) => { assertMainRenderer(event, getMainWindow); return terminals.selectAcpModel(id, value); });
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
  if (value === "terminal" || value === "codex" || value === "claude" || value === "qwen" || value === "kimi" || value === "opencode" || value === "hermes" || value === "grok" || value === "omp" || value === "pi" || value === "cursor" || value === "minimax" || value === "devin" || value === "antigravity") return value;
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

function providerSecretValue(value: string): ProviderSecretId {
  if ((PROVIDER_SECRET_IDS as readonly string[]).includes(value)) return value as ProviderSecretId;
  throw new Error("Provider secret id is unknown.");
}
