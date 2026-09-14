import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  chmod,
  lstat,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentProviderId,
  GithubPluginSearchResult,
  InstalledPlugin,
  PluginAgentHook,
  PluginAgentHookEvent,
  PluginContribution,
  PluginInstallPreview,
  PluginManifest,
  PluginModule,
  PluginModuleAsset,
  PluginPermission,
  PluginUpdateStatus,
  Size
} from "../../shared/contracts";
import {
  HOME_GRID_MAX_COLUMNS,
  HOME_GRID_MAX_ROWS,
  PLUGIN_API_VERSION
} from "../../shared/contracts.ts";
import { isValidSemver } from "../../shared/hostVersion.ts";

const MANIFEST_FILE = "canvastty.plugin.json";
/** Plugins keep their metadata (manifest, icon, etc.) in the metadata/ folder. */
const METADATA_DIR = "metadata";
/** Platform name this distribution runs on (the core does not know about it). */
const PLATFORM_ID = "canvastty";
/** Manifest candidates: metadata/ first, then the legacy root. */
const MANIFEST_CANDIDATES = [`${METADATA_DIR}/${MANIFEST_FILE}`, MANIFEST_FILE];
/** Icon candidates: metadata/ first, then the legacy root. */
const ICON_CANDIDATES = [
  `${METADATA_DIR}/icon.png`,
  `${METADATA_DIR}/icon.svg`,
  `${METADATA_DIR}/assets/icon.png`,
  `${METADATA_DIR}/assets/icon.svg`,
  "icon.png",
  "icon.svg",
  "assets/icon.png",
  "assets/icon.svg"
];
const REGISTRY_FILE = "plugins.json";
const RUNTIME_HOOK_REGISTRY_FILE = "plugin-hooks.json";
const VERSIONS_FILE = "plugin-versions.json";
const SEARCH_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 15_000;
const PREVIEW_TTL_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1_500;
const MAX_PACKAGE_ENTRIES = 500;
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_STORAGE_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_RUNTIME_HOOK_REGISTRY_BYTES = 1024 * 1024;
const MAX_PLUGIN_ICON_BYTES = 512 * 1024;
const PLUGIN_INPUT_BRIDGE_URL = "canvastty-plugin://host/input-bridge.js";
const AGENT_PROVIDERS = new Set<AgentProviderId>([
  "codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi"
]);
const PLUGIN_HOOK_EVENTS = new Set<PluginAgentHookEvent>([
  "session-start",
  "prompt-submit",
  "permission-request",
  "permission-result",
  "after-tool",
  "stop",
  "session-end"
]);

export function injectPluginInputBridge(html: string): string {
  if (html.includes(PLUGIN_INPUT_BRIDGE_URL)) return html;
  const script = `<script src="${PLUGIN_INPUT_BRIDGE_URL}"></script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head || head.index === undefined) return `${script}${html}`;
  const offset = head.index + head[0].length;
  return `${html.slice(0, offset)}${script}${html.slice(offset)}`;
}

const PLUGIN_PERMISSIONS = new Set<PluginPermission>([
  "storage",
  "secrets",
  "sessions:read",
  "limits:read",
  "launcher:open",
  "external:open",
  "browser:open",
  "media:library",
  "playlists:read",
  "playlists:write",
  "hermes:hud",
  "network"
]);

interface StoredPluginRecord {
  sourceUrl: string;
  enabled: boolean;
  installedAt: number;
  selectedModules?: string[];
  enabledHooks?: string[];
}

export interface RuntimePluginHookRegistration {
  key: string;
  events: PluginAgentHookEvent[];
}

interface RuntimeHookRecord {
  pluginId: string;
  hookId: string;
  root: string;
  entry: string;
  providers: AgentProviderId[];
  events: PluginAgentHookEvent[];
}

interface RuntimeHookRegistry {
  version: 1;
  hooks: Record<string, RuntimeHookRecord>;
}

interface StoredVersionRecord {
  installedVersion: string;
  latestVersion?: string;
  checkedAt?: number;
}

interface PendingInstall {
  directory: string;
  packageRoot: string;
  preview: PluginInstallPreview;
}

type DownloadRepository = (url: string, destination: string) => Promise<void>;
type DownloadModuleFiles = (
  url: string,
  destination: string,
  files: readonly PluginModuleAsset[]
) => Promise<void>;

export class PluginManager {
  private readonly pluginRoot: string;
  private readonly stagingRoot: string;
  private readonly storageRoot: string;
  private readonly registryPath: string;
  private readonly versionsPath: string;
  private readonly hookRegistryPath: string;
  private readonly plugins = new Map<string, InstalledPlugin>();
  private readonly pending = new Map<string, PendingInstall>();
  private readonly storageWrites = new Map<string, Promise<void>>();
  private readonly downloadRepository: DownloadRepository;
  private readonly downloadFullRepository: DownloadRepository;
  private readonly downloadModuleFiles: DownloadModuleFiles;
  private tokenProvider: () => Promise<string | null>;
  private registryWrite = Promise.resolve();

  constructor(
    userDataPath: string,
    downloadRepository?: DownloadRepository,
    downloadModuleFiles: DownloadModuleFiles = downloadGithubModuleFiles,
    tokenProvider?: () => Promise<string | null>
  ) {
    this.pluginRoot = join(userDataPath, "plugins");
    this.stagingRoot = join(userDataPath, "plugin-staging");
    this.storageRoot = join(userDataPath, "plugin-storage");
    this.registryPath = join(userDataPath, REGISTRY_FILE);
    this.versionsPath = join(userDataPath, VERSIONS_FILE);
    this.hookRegistryPath = join(userDataPath, "lifecycle", RUNTIME_HOOK_REGISTRY_FILE);
    this.downloadRepository = downloadRepository ?? downloadGithubManifest;
    this.downloadFullRepository = downloadRepository ?? downloadGithubRepository;
    this.downloadModuleFiles = downloadModuleFiles;
    this.tokenProvider = tokenProvider ?? (async () => null);
  }

  /** Resolves the GitHub token from env, then the OAuth session (if any). */
  private async githubToken(): Promise<string | null> {
    const envToken = process.env.GITHUB_TOKEN ?? process.env.CANVASTTY_GITHUB_TOKEN;
    if (envToken) return envToken;
    try {
      return await this.tokenProvider();
    } catch {
      return null;
    }
  }

  /** Registers the OAuth-backed token provider used by module-level helpers. */
  registerTokenProvider(provider: () => Promise<string | null>): void {
    this.tokenProvider = provider;
    registerGithubTokenProvider(provider);
  }

  async load(): Promise<InstalledPlugin[]> {
    await mkdir(this.pluginRoot, { recursive: true });
    await mkdir(this.storageRoot, { recursive: true });
    await rm(this.stagingRoot, { recursive: true, force: true });
    await mkdir(this.stagingRoot, { recursive: true });

    let registry: Record<string, StoredPluginRecord> = {};
    try {
      const raw = await readFile(this.registryPath, "utf8");
      const candidate: unknown = JSON.parse(raw);
      if (isRecord(candidate)) registry = candidate as Record<string, StoredPluginRecord>;
    } catch (error) {
      if (!isMissingFile(error)) {
        console.warn("CanvasTTY plugin registry could not be loaded; invalid entries are ignored.", error);
      }
    }
    const persistedRuntimeHooks = await readRuntimeHookRegistry(this.hookRegistryPath);

    this.plugins.clear();
    for (const [pluginId, record] of Object.entries(registry)) {
      if (!isStoredRecord(record) || !isPluginId(pluginId)) continue;
      try {
        const manifest = await readManifest(join(this.pluginRoot, pluginId));
        if (manifest.id !== pluginId) continue;
        const selectedModules = normalizeSelectedModules(manifest, record.selectedModules);
        const active = activeManifest(manifest, selectedModules);
        this.plugins.set(pluginId, {
          manifest,
          sourceUrl: normalizeGithubUrl(record.sourceUrl),
          enabled: record.enabled,
          installedAt: record.installedAt,
          selectedModules,
          enabledHooks: record.enabled
            ? normalizeEnabledHooks(manifest, record.enabledHooks, selectedModules).filter((hookId) => (
              runtimeHookTrustMatches(
                persistedRuntimeHooks,
                join(this.pluginRoot, pluginId),
                pluginId,
                active.hooks?.find((hook) => hook.id === hookId)
              )
            ))
            : []
        });
      } catch (error) {
        console.warn(`CanvasTTY plugin ${pluginId} could not be loaded.`, error);
      }
    }

    await this.persistRegistry();
    return this.list();
  }

  list(): InstalledPlugin[] {
    return [...this.plugins.values()]
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
      .map((plugin) => structuredClone(activePlugin(plugin)));
  }

  async previewInstall(sourceUrl: string): Promise<PluginInstallPreview> {
    this.cleanupExpiredPreviews();
    const canonicalUrl = normalizeGithubUrl(sourceUrl);
    const directory = await mkdtemp(join(this.stagingRoot, "preview-"));
    const packageRoot = join(directory, "repository");

    try {
      await this.downloadRepository(canonicalUrl, packageRoot);
      await inspectPackage(packageRoot);
      let manifest = await readManifest(packageRoot);
      assertPlatformCompatible(manifest);
      if (this.plugins.has(manifest.id)) {
        throw new Error(`Plugin ${manifest.id} is already installed.`);
      }
      if (manifest.modules?.length) {
        assertModularContributionFiles(manifest);
      } else {
        try {
          await assertManifestAssets(packageRoot, manifest);
        } catch {
          await rm(packageRoot, { recursive: true, force: true });
          await this.downloadFullRepository(canonicalUrl, packageRoot);
          await inspectPackage(packageRoot);
          const downloadedManifest = await readManifest(packageRoot);
          if (JSON.stringify(downloadedManifest) !== JSON.stringify(manifest)) {
            throw new Error("Plugin manifest changed while its package was downloaded.");
          }
          manifest = downloadedManifest;
          await assertManifestAssets(packageRoot, manifest);
        }
      }

      const token = randomUUID();
      const preview: PluginInstallPreview = {
        token,
        sourceUrl: canonicalUrl,
        manifest,
        expiresAt: Date.now() + PREVIEW_TTL_MS
      };
      this.pending.set(token, { directory, packageRoot, preview });
      return structuredClone(preview);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async install(token: string, selectedModules?: string[]): Promise<InstalledPlugin> {
    this.cleanupExpiredPreviews();
    const pending = this.pending.get(token);
    if (!pending) throw new Error("Plugin installation preview expired. Inspect the GitHub link again.");
    this.pending.delete(token);

    const { preview, packageRoot, directory } = pending;
    const modules = normalizeSelectedModules(
      preview.manifest,
      selectedModules ?? preview.manifest.modules?.filter((module) => module.defaultSelected).map((module) => module.id)
    );
    // An explicitly requested selection must be covered by the previewed manifest: normalize drops
    // unknown and duplicate ids, which would install a smaller package than the caller asked for.
    // Default and persisted selections keep the lenient normalization.
    if (selectedModules && modules.length !== selectedModules.length) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("Plugin module selection is invalid.");
    }
    const destination = join(this.pluginRoot, preview.manifest.id);
    if (this.plugins.has(preview.manifest.id)) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(`Plugin ${preview.manifest.id} is already installed.`);
    }

    try {
      if (preview.manifest.modules?.length) {
        await materializeModularPackage(
          preview.sourceUrl,
          packageRoot,
          destination,
          preview.manifest,
          modules,
          this.downloadModuleFiles
        );
      } else {
        await rename(packageRoot, destination);
      }
      const installed: InstalledPlugin = {
        manifest: preview.manifest,
        sourceUrl: preview.sourceUrl,
        enabled: true,
        installedAt: Date.now(),
        selectedModules: modules,
        enabledHooks: []
      };
      this.plugins.set(installed.manifest.id, installed);
      await this.persistRegistry();
      return structuredClone(activePlugin(installed));
    } catch (error) {
      this.plugins.delete(preview.manifest.id);
      await rm(destination, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<InstalledPlugin> {
    const plugin = this.requirePlugin(pluginId);
    const wasEnabled = plugin.enabled;
    const previousEnabledHooks = [...plugin.enabledHooks];
    plugin.enabled = Boolean(enabled);
    if (!plugin.enabled || !wasEnabled) plugin.enabledHooks = [];
    try {
      await this.persistRegistry();
    } catch (error) {
      if (plugin.enabled) {
        plugin.enabled = wasEnabled;
        plugin.enabledHooks = previousEnabledHooks;
      }
      await this.persistRegistry().catch(() => undefined);
      throw error;
    }
    return structuredClone(activePlugin(plugin));
  }

  async setHookEnabled(pluginId: string, hookId: string, enabled: boolean): Promise<InstalledPlugin> {
    const plugin = this.requireEnabledPlugin(pluginId);
    if (!isContributionId(hookId)) throw new Error("Plugin hook identifier is invalid.");
    const hook = activeManifest(plugin.manifest, plugin.selectedModules).hooks?.find((candidate) => candidate.id === hookId);
    if (!hook) throw new Error("Plugin hook is not installed or its module is disabled.");
    const previous = [...plugin.enabledHooks];
    const selected = new Set(previous);
    if (enabled) selected.add(hook.id);
    else selected.delete(hook.id);
    plugin.enabledHooks = [...selected].filter((id) => (
      activeManifest(plugin.manifest, plugin.selectedModules).hooks?.some((candidate) => candidate.id === id)
    ));
    try {
      await this.persistRegistry();
    } catch (error) {
      if (enabled) plugin.enabledHooks = previous;
      await this.persistRegistry().catch(() => undefined);
      throw error;
    }
    return structuredClone(activePlugin(plugin));
  }

  get runtimeHookRegistryPath(): string {
    return this.hookRegistryPath;
  }

  runtimeHooksForProvider(provider: AgentProviderId): RuntimePluginHookRegistration[] {
    const registrations: RuntimePluginHookRegistration[] = [];
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled || plugin.enabledHooks.length === 0) continue;
      const manifest = activeManifest(plugin.manifest, plugin.selectedModules);
      for (const hook of manifest.hooks ?? []) {
        if (!plugin.enabledHooks.includes(hook.id) || !hook.providers.includes(provider)) continue;
        registrations.push({
          key: runtimeHookKey(plugin.manifest.id, hook.id),
          events: [...hook.events]
        });
      }
    }
    return registrations;
  }

  async setModules(pluginId: string, selectedModules: string[]): Promise<InstalledPlugin> {
    const plugin = this.requirePlugin(pluginId);
    if (!plugin.manifest.modules?.length) throw new Error("Plugin does not declare optional modules.");
    const selected = normalizeSelectedModules(plugin.manifest, selectedModules);
    if (selected.length !== new Set(selectedModules).size) throw new Error("Plugin module selection is invalid.");
    if (plugin.enabledHooks.length > 0) {
      plugin.enabledHooks = [];
      await this.persistRegistry();
    }
    const directory = await mkdtemp(join(this.stagingRoot, "modules-"));
    const nextRoot = join(directory, "next");
    const currentRoot = join(this.pluginRoot, pluginId);
    const backupRoot = join(directory, "previous");
    const previousSelection = [...plugin.selectedModules];
    const previousEnabledHooks = [...plugin.enabledHooks];
    let swapped = false;
    try {
      await materializeModularPackage(
        plugin.sourceUrl,
        currentRoot,
        nextRoot,
        plugin.manifest,
        selected,
        this.downloadModuleFiles
      );
      await rename(currentRoot, backupRoot);
      try {
        await rename(nextRoot, currentRoot);
        swapped = true;
      } catch (error) {
        await rename(backupRoot, currentRoot);
        throw error;
      }
      plugin.selectedModules = selected;
      // Module replacement downloads executable hook files again, so trust must be renewed.
      plugin.enabledHooks = [];
      await this.persistRegistry();
      return structuredClone(activePlugin(plugin));
    } catch (error) {
      if (swapped) {
        plugin.selectedModules = previousSelection;
        plugin.enabledHooks = previousEnabledHooks;
        await rm(currentRoot, { recursive: true, force: true });
        await rename(backupRoot, currentRoot);
        await this.persistRegistry().catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async uninstall(pluginId: string): Promise<void> {
    const plugin = this.requirePlugin(pluginId);
    if (plugin.enabledHooks.length > 0) {
      plugin.enabledHooks = [];
      try {
        await this.persistRegistry();
      } catch (error) {
        await this.persistRegistry().catch(() => undefined);
        throw error;
      }
    }
    this.plugins.delete(plugin.manifest.id);
    try {
      await this.persistRegistry();
    } catch (error) {
      this.plugins.set(plugin.manifest.id, plugin);
      await this.persistRegistry().catch(() => undefined);
      throw error;
    }
    await rm(join(this.pluginRoot, plugin.manifest.id), { recursive: true, force: true });
    await rm(join(this.storageRoot, `${plugin.manifest.id}.json`), { force: true });
  }

  async searchGithubPlugins(query: string): Promise<GithubPluginSearchResult[]> {
    const term = query.trim();
    if (!term) return [];
    const results = await searchGithubPluginRepositories(term);
    const mapped = this.excludeInstalled(mapSearchResults(results));
    return this.filterByPlatform(mapped);
  }

  async listShowcasePlugins(): Promise<GithubPluginSearchResult[]> {
    // Test mode: CANVASTTY_SHOWCASE_STUBS=N generates N local stub
    // entries instead of a real GitHub request (nothing is loaded from GitHub).
    const stubCount = Number.parseInt(process.env.CANVASTTY_SHOWCASE_STUBS ?? "", 10);
    if (Number.isFinite(stubCount) && stubCount > 0) {
      return this.excludeInstalled(makeShowcaseStubs(stubCount));
    }
    const results = await listShowcasePluginRepositories();
    const mapped = this.excludeInstalled(mapSearchResults(results));
    return this.filterByPlatform(mapped);
  }

  /**
   * Drops results whose manifest declares platforms without PLATFORM_ID
   * (a fork for another platform must not reach the showcase). Legacy plugins
   * without the platforms field are considered compatible. Also fills in
   * minHostVersion from the manifest so the UI can flag plugins written for a
   * newer host version. Uses the previewManifests batch to avoid extra
   * requests (rate limits preserved).
   */
  private async filterByPlatform(results: GithubPluginSearchResult[]): Promise<GithubPluginSearchResult[]> {
    if (results.length === 0) return results;
    const manifests = await this.previewManifests(results.map((result) => result.url));
    const filtered: GithubPluginSearchResult[] = [];
    for (const result of results) {
      const manifest = manifests.get(result.url);
      if (manifest && manifest.platforms && manifest.platforms.length > 0 && !manifest.platforms.includes(PLATFORM_ID)) {
        continue; // fork for another platform — do not show
      }
      filtered.push(manifest?.minHostVersion
        ? { ...result, minHostVersion: manifest.minHostVersion }
        : result);
    }
    return filtered;
  }

  /** Drops repositories that are already installed (unless uninstalled later). */
  private excludeInstalled(results: GithubPluginSearchResult[]): GithubPluginSearchResult[] {
    if (results.length === 0 || this.plugins.size === 0) return results;
    const installed = new Set<string>();
    for (const plugin of this.plugins.values()) {
      if (!plugin.sourceUrl) continue;
      const key = repositoryKeyOfUrl(plugin.sourceUrl);
      if (key) installed.add(key);
    }
    if (installed.size === 0) return results;
    return results.filter((result) => !installed.has(repositoryKeyOfUrl(result.url)));
  }

  async fetchPluginIcons(sourceUrls: string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(sourceUrls)].filter((url) => typeof url === "string" && url.length > 0);
    const icons = new Map<string, string | null>();
    if (unique.length === 0) return icons;

    // Candidates in priority order; each batch probes one candidate across all
    // repositories with a single GraphQL request (metadata only), then fetches
    // the bytes of present files via raw.githubusercontent (not rate-limited).
    const candidates = ICON_CANDIDATES;
    for (const candidate of candidates) {
      const remaining = unique.filter((url) => !icons.has(url));
      if (remaining.length === 0) break;
      const entries: Array<{ key: string; owner: string; repository: string; path: string; maximumBytes: number; asDataUrl: boolean }> = [];
      for (const url of remaining) {
        let owner = "";
        let repository = "";
        try {
          const source = new URL(url);
          const parts = source.pathname.split("/").filter(Boolean);
          owner = parts[0] ?? "";
          repository = (parts[1] ?? "").replace(/\.git$/i, "");
        } catch {
          continue;
        }
        if (!owner || !repository) continue;
        entries.push({ key: url, owner, repository, path: candidate, maximumBytes: MAX_PLUGIN_ICON_BYTES, asDataUrl: true });
      }
      if (entries.length === 0) continue;
      const results = await githubGraphqlBatch(entries);
      for (const [key, result] of results) {
        if (result.ok && result.dataUrl) {
          icons.set(key, result.dataUrl);
        }
      }
    }
    for (const url of unique) {
      if (!icons.has(url)) icons.set(url, null);
    }
    return icons;
  }

  /**
   * Batch-fetches full manifests (including localized descriptions) for the
   * given repositories. The UI calls this once when the showcase opens or a
   * page turns, so expanding a tile afterwards is instant (no network).
   */
  async previewManifests(sourceUrls: string[]): Promise<Map<string, PluginManifest>> {
    const unique = [...new Set(sourceUrls)].filter((url) => typeof url === "string" && url.length > 0);
    const manifests = new Map<string, PluginManifest>();
    if (unique.length === 0) return manifests;

    // Metadata-first: metadata/canvastty.plugin.json, then legacy root file.
    const parsed = new Map<string, { owner: string; repository: string }>();
    for (const sourceUrl of unique) {
      try {
        const source = new URL(sourceUrl);
        const parts = source.pathname.split("/").filter(Boolean);
        const owner = parts[0] ?? "";
        const repository = (parts[1] ?? "").replace(/\.git$/i, "");
        if (owner && repository) parsed.set(sourceUrl, { owner, repository });
      } catch {
        // Unparseable URL — skipped.
      }
    }
    const toEntries = (path: string): Array<{ key: string; owner: string; repository: string; path: string; maximumBytes: number; asDataUrl: boolean }> =>
      [...parsed.entries()].map(([key, repo]) => ({
        key, owner: repo.owner, repository: repo.repository, path, maximumBytes: MAX_MANIFEST_BYTES, asDataUrl: false
      }));

    for (const candidate of MANIFEST_CANDIDATES) {
      const pending = [...parsed.keys()].filter((key) => !manifests.has(key));
      if (pending.length === 0) break;
      const results = await githubGraphqlBatch(toEntries(candidate).filter((entry) => pending.includes(entry.key)));
      for (const [key, result] of results) {
        if (!result.ok || result.text === undefined) continue;
        try {
          manifests.set(key, validatePluginManifest(JSON.parse(result.text) as unknown));
        } catch {
          // Malformed manifest — skipped; tile falls back to a live preview.
        }
      }
    }
    return manifests;
  }

  async checkForUpdates(): Promise<PluginUpdateStatus[]> {
    const installed = [...this.plugins.values()]
      .filter((plugin) => plugin.enabled && plugin.sourceUrl)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
    const versions = await this.readVersions();
    const updates: PluginUpdateStatus[] = [];
    // Batch: one GraphQL metadata round-trip for all manifests, then raw
    // fetches for present files — far fewer requests than one per plugin.
    const remoteVersions = await fetchRemoteManifestVersions(installed.map((plugin) => plugin.sourceUrl));
    for (const plugin of installed) {
      const latest = remoteVersions.get(plugin.sourceUrl);
      if (latest === undefined) {
        console.warn(`CanvasTTY could not check plugin update: ${plugin.manifest.id}.`);
        continue;
      }
      versions[plugin.manifest.id] = {
        installedVersion: plugin.manifest.version,
        latestVersion: latest,
        checkedAt: Date.now()
      };
      if (latest !== plugin.manifest.version) {
        updates.push({
          pluginId: plugin.manifest.id,
          installedVersion: plugin.manifest.version,
          latestVersion: latest
        });
      }
    }
    await this.persistVersions(versions);
    return updates;
  }

  async updatePlugin(pluginId: string): Promise<InstalledPlugin> {
    const plugin = this.requirePlugin(pluginId);
    if (plugin.enabledHooks.length > 0) {
      plugin.enabledHooks = [];
      await this.persistRegistry();
    }
    const sourceUrl = plugin.sourceUrl;
    const previousSelection = [...plugin.selectedModules];
    const directory = await mkdtemp(join(this.stagingRoot, "update-"));
    const packageRoot = join(directory, "repository");
    const nextRoot = join(directory, "next");
    const currentRoot = join(this.pluginRoot, pluginId);
    const backupRoot = join(directory, "previous");
    let currentBackedUp = false;
    let swapped = false;
    try {
      await this.downloadFullRepository(sourceUrl, packageRoot);
      await inspectPackage(packageRoot);
      const manifest = await readManifest(packageRoot);
      if (manifest.id !== pluginId) throw new Error("Updated plugin package does not match the installed plugin.");
      assertPlatformCompatible(manifest);
      const selected = normalizeSelectedModules(manifest, previousSelection);
      if (manifest.modules?.length) {
        await materializeModularPackage(sourceUrl, packageRoot, nextRoot, manifest, selected, this.downloadModuleFiles);
      } else {
        await assertManifestAssets(packageRoot, manifest);
        await rename(packageRoot, nextRoot);
      }

      await rename(currentRoot, backupRoot);
      currentBackedUp = true;
      try {
        await rename(nextRoot, currentRoot);
        swapped = true;
      } catch (error) {
        await rename(backupRoot, currentRoot);
        currentBackedUp = false;
        throw error;
      }

      const updated: InstalledPlugin = {
        manifest,
        sourceUrl,
        enabled: plugin.enabled,
        installedAt: plugin.installedAt,
        selectedModules: selected,
        // Updated native hook code must be reviewed and trusted again.
        enabledHooks: []
      };
      this.plugins.set(pluginId, updated);
      await this.persistRegistry();
      const versions = await this.readVersions();
      versions[pluginId] = {
        installedVersion: manifest.version,
        latestVersion: manifest.version,
        checkedAt: Date.now()
      };
      await this.persistVersions(versions);
      return structuredClone(activePlugin(updated));
    } catch (error) {
      if (currentBackedUp) {
        this.plugins.set(pluginId, plugin);
        try {
          if (swapped) await rm(currentRoot, { recursive: true, force: true });
          await rename(backupRoot, currentRoot);
          currentBackedUp = false;
          await this.persistRegistry();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Plugin ${pluginId} update failed and could not be rolled back.`);
        }
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async readVersions(): Promise<Record<string, StoredVersionRecord>> {
    try {
      const raw = await readFile(this.versionsPath, "utf8");
      const candidate: unknown = JSON.parse(raw);
      if (isRecord(candidate)) {
        const result: Record<string, StoredVersionRecord> = {};
        for (const [pluginId, value] of Object.entries(candidate)) {
          if (!isPluginId(pluginId) || !isRecord(value)) continue;
          const installedVersion = typeof value.installedVersion === "string" ? value.installedVersion : "";
          const latestVersion = typeof value.latestVersion === "string" ? value.latestVersion : undefined;
          const checkedAt = typeof value.checkedAt === "number" ? value.checkedAt : undefined;
          if (installedVersion) {
            result[pluginId] = { installedVersion, ...(latestVersion ? { latestVersion } : {}), ...(checkedAt ? { checkedAt } : {}) };
          }
        }
        return result;
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        console.warn("CanvasTTY plugin version manifest could not be loaded; it will be rebuilt.", error);
      }
    }
    return {};
  }

  private async persistVersions(versions: Record<string, StoredVersionRecord>): Promise<void> {
    const temporaryPath = `${this.versionsPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(versions, null, 2), "utf8");
    await rename(temporaryPath, this.versionsPath);
  }

  contribution(pluginId: string, contributionId: string): PluginContribution {
    const plugin = activePlugin(this.requireEnabledPlugin(pluginId));
    const contribution = plugin.manifest.contributions.find((candidate) => candidate.id === contributionId);
    if (!contribution) throw new Error("Plugin contribution does not exist.");
    return structuredClone(contribution);
  }

  hasPermission(pluginId: string, permission: PluginPermission): boolean {
    const plugin = activePlugin(this.requireEnabledPlugin(pluginId));
    return plugin.manifest.permissions.includes(permission);
  }

  assertPermission(pluginId: string, permission: PluginPermission): void {
    if (!this.hasPermission(pluginId, permission)) {
      throw new Error(`Plugin ${pluginId} does not have the ${permission} permission.`);
    }
  }

  async storageGet(pluginId: string, key: string): Promise<unknown> {
    this.assertPermission(pluginId, "storage");
    assertStorageKey(key);
    const storage = await this.readStorage(pluginId);
    return Object.prototype.hasOwnProperty.call(storage, key) ? structuredClone(storage[key]) : null;
  }

  async storageSet(pluginId: string, key: string, value: unknown): Promise<void> {
    this.assertPermission(pluginId, "storage");
    assertStorageKey(key);
    const previous = this.storageWrites.get(pluginId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const storage = await this.readStorage(pluginId);
      storage[key] = jsonClone(value);
      const snapshot = JSON.stringify(storage, null, 2);
      if (Buffer.byteLength(snapshot) > MAX_STORAGE_BYTES) {
        throw new Error("Plugin storage exceeds the 64 KB quota.");
      }
      const path = join(this.storageRoot, `${pluginId}.json`);
      const temporaryPath = `${path}.tmp`;
      await writeFile(temporaryPath, snapshot, "utf8");
      await rename(temporaryPath, path);
    });
    this.storageWrites.set(pluginId, next);
    try {
      await next;
    } finally {
      if (this.storageWrites.get(pluginId) === next) this.storageWrites.delete(pluginId);
    }
  }

  entryUrl(pluginId: string, contributionId: string): string {
    const contribution = this.contribution(pluginId, contributionId);
    return `canvastty-plugin://${pluginId}/${encodeAssetPath(contribution.entry)}`;
  }

  async protocolResponse(requestUrl: string): Promise<Response> {
    try {
      const url = new URL(requestUrl);
      if (url.protocol !== "canvastty-plugin:") return response("Unsupported protocol.", 400);
      if (url.hostname === "host" && url.pathname === "/sdk.js") {
        return new Response(PLUGIN_SDK_SOURCE, {
          status: 200,
          headers: resourceHeaders("application/javascript; charset=utf-8", false, false)
        });
      }
      if (url.hostname === "host" && url.pathname === "/input-bridge.js") {
        return new Response(PLUGIN_INPUT_BRIDGE_SOURCE, {
          status: 200,
          headers: resourceHeaders("application/javascript; charset=utf-8", false, false)
        });
      }

      const plugin = activePlugin(this.requireEnabledPlugin(url.hostname));
      const relativePath = decodeAssetPath(url.pathname);
      const root = join(this.pluginRoot, plugin.manifest.id);
      const path = await containedFile(root, relativePath);
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_ASSET_BYTES) return response("Plugin asset is unavailable.", 404);
      const content = await readFile(path);
      const body = extname(path).toLowerCase() === ".html"
        ? injectPluginInputBridge(content.toString("utf8"))
        : content;
      return new Response(body, {
        status: 200,
        headers: resourceHeaders(
          mimeType(path),
          plugin.manifest.permissions.includes("network"),
          plugin.manifest.permissions.includes("media:library")
        )
      });
    } catch {
      return response("Plugin asset is unavailable.", 404);
    }
  }

  async dispose(): Promise<void> {
    const directories = [...this.pending.values()].map((pending) => pending.directory);
    this.pending.clear();
    await Promise.allSettled(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }

  private requirePlugin(pluginId: string): InstalledPlugin {
    if (!isPluginId(pluginId)) throw new Error("Plugin identifier is invalid.");
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error("Plugin is not installed.");
    return plugin;
  }

  private requireEnabledPlugin(pluginId: string): InstalledPlugin {
    const plugin = this.requirePlugin(pluginId);
    if (!plugin.enabled) throw new Error("Plugin is disabled.");
    return plugin;
  }

  private async readStorage(pluginId: string): Promise<Record<string, unknown>> {
    const path = join(this.storageRoot, `${pluginId}.json`);
    try {
      const raw = await readFile(path, "utf8");
      if (Buffer.byteLength(raw) > MAX_STORAGE_BYTES) return {};
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? { ...parsed } : {};
    } catch (error) {
      if (!isMissingFile(error)) console.warn(`CanvasTTY plugin storage for ${pluginId} could not be read.`, error);
      return {};
    }
  }

  private cleanupExpiredPreviews(): void {
    const now = Date.now();
    for (const [token, pending] of this.pending) {
      if (pending.preview.expiresAt > now) continue;
      this.pending.delete(token);
      void rm(pending.directory, { recursive: true, force: true });
    }
  }

  private persistRegistry(): Promise<void> {
    const registry = Object.fromEntries([...this.plugins].map(([id, plugin]) => [id, {
      sourceUrl: plugin.sourceUrl,
      enabled: plugin.enabled,
      installedAt: plugin.installedAt,
      selectedModules: plugin.selectedModules,
      enabledHooks: plugin.enabledHooks
    }] satisfies [string, StoredPluginRecord]));
    const snapshot = JSON.stringify(registry, null, 2);
    const desiredHookRegistry = this.runtimeHookRegistry();
    const hookSnapshot = JSON.stringify(desiredHookRegistry, null, 2);
    if (Buffer.byteLength(hookSnapshot, "utf8") > MAX_RUNTIME_HOOK_REGISTRY_BYTES) {
      throw new Error("Enabled plugin hooks exceed the runtime registry limit.");
    }
    const temporaryPath = `${this.registryPath}.tmp`;
    const write = this.registryWrite.catch(() => undefined).then(async () => {
      const currentHookRegistry = await readRuntimeHookRegistry(this.hookRegistryPath);
      const interimHookRegistry = safeRuntimeHookInterim(currentHookRegistry, desiredHookRegistry);
      const interimHookSnapshot = JSON.stringify(interimHookRegistry, null, 2);

      await mkdir(dirname(this.registryPath), { recursive: true });
      // Revocations and executable replacements become authoritative before the
      // user-visible registry changes. New executable grants are withheld until
      // that registry is durable, so a partial write can only fail closed.
      await writeRuntimeHookRegistry(this.hookRegistryPath, interimHookSnapshot);
      await writeFile(temporaryPath, snapshot, "utf8");
      await rename(temporaryPath, this.registryPath);
      if (interimHookSnapshot !== hookSnapshot) {
        await writeRuntimeHookRegistry(this.hookRegistryPath, hookSnapshot);
      }
    });
    this.registryWrite = write;
    return write;
  }

  private runtimeHookRegistry(): RuntimeHookRegistry {
    const hooks: Record<string, RuntimeHookRecord> = {};
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled || plugin.enabledHooks.length === 0) continue;
      const manifest = activeManifest(plugin.manifest, plugin.selectedModules);
      for (const hook of manifest.hooks ?? []) {
        if (!plugin.enabledHooks.includes(hook.id)) continue;
        hooks[runtimeHookKey(plugin.manifest.id, hook.id)] = runtimeHookRecord(
          join(this.pluginRoot, plugin.manifest.id),
          plugin.manifest.id,
          hook
        );
      }
    }
    return { version: 1, hooks };
  }
}

export function normalizeGithubUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 300) throw new Error("Enter a GitHub repository URL.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid GitHub repository URL.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Plugins can only be installed from an HTTPS github.com repository URL.");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("GitHub URL must not contain credentials, query, or fragment.");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("Use a repository root URL such as https://github.com/owner/repository.");
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  if (!isGithubName(owner) || !isGithubName(repository)) throw new Error("GitHub owner or repository name is invalid.");
  return `https://github.com/${owner}/${repository}.git`;
}

/** Returns a stable "owner/repository" key for comparison, or "" when invalid. */
function repositoryKeyOfUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    const owner = parts[0];
    const repository = parts[1].replace(/\.git$/i, "");
    if (!isGithubName(owner) || !isGithubName(repository)) return "";
    return `${owner}/${repository}`;
  } catch {
    return "";
  }
}

export function validatePluginManifest(candidate: unknown): PluginManifest {
  if (!isRecord(candidate)) throw new Error("Plugin manifest must be a JSON object.");
  assertOnlyKeys(candidate, [
    "apiVersion", "id", "name", "version", "description", "description.ru", "description.en",
    "icon", "author", "homepage", "settingsContribution", "coreFiles", "modules", "permissions",
    "contributions", "hooks", "platforms", "minHostVersion"
  ], "Plugin manifest");
  if (candidate.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`Plugin apiVersion must be ${PLUGIN_API_VERSION}.`);
  }
  const id = requiredString(candidate.id, "id", 80);
  if (!isPluginId(id) || id === "host") throw new Error("Plugin id must be a lowercase DNS-style identifier.");
  const name = requiredString(candidate.name, "name", 80);
  const version = requiredString(candidate.version, "version", 40);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Plugin version must be semantic version text.");
  const description = requiredString(candidate.description, "description", 2_000);
  const descriptionRu = optionalString(candidate["description.ru"], "description.ru", 2_000);
  const descriptionEn = optionalString(candidate["description.en"], "description.en", 2_000);
  const iconValue = optionalString(candidate.icon, "icon", 180);
  const icon = iconValue ? assetPath(iconValue) : null;
  const author = optionalString(candidate.author, "author", 120);
  const homepage = optionalWebUrl(candidate.homepage, "homepage");

  // Platform declaration: optional array of platform ids (lowercase, [a-z0-9-]).
  // Absent = legacy plugin compatible with every platform.
  let platforms: string[] | undefined;
  if (candidate.platforms !== undefined) {
    if (!Array.isArray(candidate.platforms) || candidate.platforms.length === 0) {
      throw new Error("Plugin platforms must be a non-empty array of platform ids.");
    }
    platforms = [];
    for (const platform of candidate.platforms) {
      if (typeof platform !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(platform)) {
        throw new Error("Plugin platform ids must be lowercase, alphanumeric with hyphens.");
      }
      if (platforms.includes(platform)) throw new Error(`Plugin platform id is duplicated: ${platform}.`);
      platforms.push(platform);
    }
  }

  // Host-version constraint: optional semver (e.g. "1.2.0"). Malformed values
  // are treated as "no constraint" (legacy plugins must keep working).
  let minHostVersion: string | undefined;
  if (candidate.minHostVersion !== undefined) {
    if (!isValidSemver(candidate.minHostVersion)) {
      throw new Error("Plugin minHostVersion must be a semantic version (e.g. 1.2.0).");
    }
    minHostVersion = String(candidate.minHostVersion).trim();
  }

  if (!Array.isArray(candidate.permissions)) throw new Error("Plugin permissions must be an array.");
  const permissions: PluginPermission[] = [];
  for (const permission of candidate.permissions) {
    if (!PLUGIN_PERMISSIONS.has(permission as PluginPermission)) throw new Error(`Unknown plugin permission: ${String(permission)}.`);
    if (!permissions.includes(permission as PluginPermission)) permissions.push(permission as PluginPermission);
  }

  const modules = validateModules(candidate.modules);
  const moduleIds = new Set(modules.map((module) => module.id));
  const hooks = validateAgentHooks(candidate.hooks, moduleIds);
  const coreFiles = candidate.coreFiles === undefined ? [] : validateModuleFiles(candidate.coreFiles, "coreFiles");
  if (modules.length > 0 && coreFiles.length === 0) {
    throw new Error("Modular plugins must declare at least one coreFiles asset.");
  }
  const ownedFiles = new Set(coreFiles.map((file) => file.path));
  for (const module of modules) {
    for (const file of module.files) {
      if (ownedFiles.has(file.path)) throw new Error(`Plugin module asset is declared more than once: ${file.path}.`);
      ownedFiles.add(file.path);
    }
  }

  if (!Array.isArray(candidate.contributions) || candidate.contributions.length > 32) {
    throw new Error("Plugin contributions must be an array of at most 32 items.");
  }
  if (candidate.contributions.length === 0 && hooks.length === 0) {
    throw new Error("Plugin must declare at least one contribution or agent hook.");
  }
  const contributionIds = new Set<string>();
  const contributions = candidate.contributions.map((value) => {
    const contribution = validateContribution(value);
    if (contribution.module && !moduleIds.has(contribution.module)) {
      throw new Error(`Plugin contribution references an unknown module: ${contribution.module}.`);
    }
    if (contributionIds.has(contribution.id)) throw new Error(`Duplicate contribution id: ${contribution.id}.`);
    contributionIds.add(contribution.id);
    return contribution;
  });
  const settingsContribution = optionalString(candidate.settingsContribution, "settingsContribution", 64);
  if (settingsContribution) {
    const target = contributions.find((contribution) => contribution.id === settingsContribution);
    if (!target || target.kind !== "canvas-app") {
      throw new Error("Plugin settingsContribution must reference a canvas-app contribution.");
    }
  }

  return {
    apiVersion: PLUGIN_API_VERSION,
    id,
    name,
    version,
    description,
    ...(descriptionRu ? { "description.ru": descriptionRu } : {}),
    ...(descriptionEn ? { "description.en": descriptionEn } : {}),
    ...(icon ? { icon } : {}),
    ...(author ? { author } : {}),
    ...(homepage ? { homepage } : {}),
    ...(platforms ? { platforms } : {}),
    ...(minHostVersion ? { minHostVersion } : {}),
    permissions,
    contributions,
    ...(hooks.length ? { hooks } : {}),
    ...(settingsContribution ? { settingsContribution } : {}),
    ...(coreFiles.length ? { coreFiles } : {}),
    ...(modules.length ? { modules } : {})
  };
}

function validateAgentHooks(value: unknown, moduleIds: ReadonlySet<string>): PluginAgentHook[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error("Plugin hooks must contain between 1 and 16 items.");
  }
  const ids = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Every plugin hook must be an object.");
    assertOnlyKeys(candidate, [
      "id", "title", "description", "entry", "providers", "events", "module"
    ], "Plugin hook");
    const id = requiredString(candidate.id, "hook id", 64);
    if (!isContributionId(id) || ids.has(id)) throw new Error(`Plugin hook id is invalid or duplicated: ${id}.`);
    ids.add(id);
    const title = requiredString(candidate.title, "hook title", 80);
    const description = optionalString(candidate.description, "hook description", 240);
    const entry = assetPath(requiredString(candidate.entry, "hook entry", 180));
    if (![".js", ".mjs", ".cjs"].includes(extname(entry))) {
      throw new Error("Plugin hook entry must be a JavaScript file.");
    }
    if (!Array.isArray(candidate.providers) || candidate.providers.length === 0) {
      throw new Error(`Plugin hook ${id} providers must be a non-empty array.`);
    }
    const providers: AgentProviderId[] = [];
    for (const provider of candidate.providers) {
      if (!AGENT_PROVIDERS.has(provider as AgentProviderId)) {
        throw new Error(`Plugin hook ${id} has an unknown provider: ${String(provider)}.`);
      }
      if (providers.includes(provider as AgentProviderId)) {
        throw new Error(`Plugin hook ${id} has a duplicated provider: ${String(provider)}.`);
      }
      providers.push(provider as AgentProviderId);
    }
    if (!Array.isArray(candidate.events) || candidate.events.length === 0) {
      throw new Error(`Plugin hook ${id} events must be a non-empty array.`);
    }
    const events: PluginAgentHookEvent[] = [];
    for (const event of candidate.events) {
      if (!PLUGIN_HOOK_EVENTS.has(event as PluginAgentHookEvent)) {
        throw new Error(`Plugin hook ${id} has an unknown event: ${String(event)}.`);
      }
      if (events.includes(event as PluginAgentHookEvent)) {
        throw new Error(`Plugin hook ${id} has a duplicated event: ${String(event)}.`);
      }
      events.push(event as PluginAgentHookEvent);
    }
    const module = optionalString(candidate.module, "hook module", 64);
    if (module && (!isContributionId(module) || !moduleIds.has(module))) {
      throw new Error(`Plugin hook references an unknown module: ${module}.`);
    }
    return {
      id,
      title,
      ...(description ? { description } : {}),
      entry,
      providers,
      events,
      ...(module ? { module } : {})
    };
  });
}

function validateContribution(value: unknown): PluginContribution {
  if (!isRecord(value)) throw new Error("Every plugin contribution must be an object.");
  assertOnlyKeys(value, [
    "id", "kind", "title", "description", "entry", "icon", "module", "defaultSize", "minSize"
  ], "Plugin contribution");
  const id = requiredString(value.id, "contribution id", 64);
  if (!isContributionId(id)) throw new Error("Contribution id contains unsupported characters.");
  const title = requiredString(value.title, "contribution title", 80);
  const description = optionalString(value.description, "contribution description", 240);
  const entry = assetPath(requiredString(value.entry, "contribution entry", 180));
  if (extname(entry).toLowerCase() !== ".html") throw new Error("Contribution entry must be an HTML file.");
  const iconValue = optionalString(value.icon, "contribution icon", 180);
  const icon = iconValue ? assetPath(iconValue) : null;
  const module = optionalString(value.module, "contribution module", 64);
  if (module && !isContributionId(module)) throw new Error("Contribution module id contains unsupported characters.");
  const base = {
    id,
    title,
    ...(description ? { description } : {}),
    entry,
    ...(icon ? { icon } : {}),
    ...(module ? { module } : {})
  };

  if (value.kind === "home-widget") {
    return { ...base, kind: "home-widget", defaultSize: validateGridSize(value.defaultSize) };
  }
  if (value.kind === "canvas-app" || value.kind === "window") {
    const defaultSize = validateWindowSize(value.defaultSize, "defaultSize", 320, 220);
    const minSize = value.minSize === undefined
      ? null
      : validateWindowSize(value.minSize, "minSize", 240, 140);
    if (minSize && (minSize.width > defaultSize.width || minSize.height > defaultSize.height)) {
      throw new Error("Plugin contribution minSize must not exceed defaultSize.");
    }
    return { ...base, kind: value.kind, defaultSize, ...(minSize ? { minSize } : {}) };
  }
  throw new Error(`Unknown plugin contribution kind: ${String(value.kind)}.`);
}

async function readManifest(packageRoot: string): Promise<PluginManifest> {
  const found = await firstExistingFile(packageRoot, MANIFEST_CANDIDATES);
  if (!found) throw new Error(`${MANIFEST_FILE} is missing or too large.`);
  const raw = await readFile(found, "utf8");
  return validatePluginManifest(JSON.parse(raw) as unknown);
}

/** Returns the first existing file among the candidates (in declaration order). */
async function firstExistingFile(root: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const path = join(root, candidate);
    try {
      const metadata = await stat(path);
      if (metadata.isFile() && metadata.size <= MAX_MANIFEST_BYTES) return path;
    } catch {
      // Missing candidate — try the next one.
    }
  }
  return null;
}

async function inspectPackage(root: string): Promise<void> {
  let entryCount = 0;
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_PACKAGE_ENTRIES) {
        throw new Error("Plugin package exceeds the 500 entry / 25 MB limit.");
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("Plugin packages must not contain symbolic links.");
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!metadata.isFile()) throw new Error("Plugin packages may contain only regular files and directories.");
      totalBytes += metadata.size;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw new Error("Plugin package exceeds the 500 entry / 25 MB limit.");
      }
    }
  };
  await visit(root);
}

async function assertManifestAssets(root: string, manifest: PluginManifest): Promise<void> {
  for (const contribution of manifest.contributions) {
    await containedFile(root, contribution.entry);
    if (contribution.icon) await containedFile(root, contribution.icon);
  }
  for (const hook of manifest.hooks ?? []) await containedFile(root, hook.entry);
}

async function containedFile(root: string, relativePath: string): Promise<string> {
  const decoded = assetPath(relativePath);
  const rootRealPath = await realpath(root);
  const candidate = resolve(rootRealPath, decoded);
  const candidateRealPath = await realpath(candidate);
  const relation = relative(rootRealPath, candidateRealPath);
  if (relation.startsWith(`..${sep}`) || relation === ".." || resolve(rootRealPath, relation) !== candidateRealPath) {
    throw new Error("Plugin asset escapes its package root.");
  }
  const metadata = await stat(candidateRealPath);
  if (!metadata.isFile()) throw new Error(`Plugin asset is not a file: ${decoded}.`);
  return candidateRealPath;
}

export async function downloadGithubRepository(sourceUrl: string, destination: string): Promise<void> {
  await retryGithubDownload(() => downloadGithubRepositoryOnce(sourceUrl, destination));
}

async function retryGithubDownload<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown = new Error("GitHub plugin download failed.");
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= DOWNLOAD_ATTEMPTS || !(error instanceof TransientGithubDownloadError)) break;
      await delay(DOWNLOAD_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

class TransientGithubDownloadError extends Error {}
class MissingGithubFileError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`GitHub file download failed with HTTP ${status}.`);
    this.status = status;
  }
}

async function downloadGithubRepositoryOnce(sourceUrl: string, destination: string): Promise<void> {
  const source = new URL(sourceUrl);
  const [owner, repositoryWithGit] = source.pathname.split("/").filter(Boolean);
  const repository = repositoryWithGit.replace(/\.git$/i, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref();

  try {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tarball`, {
        redirect: "follow",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "CanvasTTY plugin installer"
        },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) throw new TransientGithubDownloadError("GitHub plugin download timed out.");
      throw new TransientGithubDownloadError("GitHub plugin download could not establish a connection.", { cause: error });
    }
    const finalUrl = new URL(response.url || `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tarball`);
    if (
      finalUrl.protocol !== "https:"
      || (finalUrl.hostname !== "api.github.com" && finalUrl.hostname !== "codeload.github.com")
    ) {
      throw new Error("GitHub plugin archive redirected outside GitHub's download hosts.");
    }
    if (response.status === 404) throw new Error("GitHub repository was not found or is not public.");
    if (!response.ok || !response.body) {
      const message = `GitHub download failed with HTTP ${response.status}.`;
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new TransientGithubDownloadError(message);
      }
      throw new Error(message);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_PACKAGE_BYTES) {
      throw new Error("Plugin archive exceeds the 25 MB download limit.");
    }
    let tarball: Buffer;
    try {
      tarball = await readGzipTarball(response.body);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new TransientGithubDownloadError("GitHub plugin download was interrupted.", { cause: error });
      }
      throw error;
    }
    await extractGithubTarball(tarball, destination);
  } finally {
    clearTimeout(timer);
  }
}

function delay(durationMs: number): Promise<void> {
  // Deliberately not unref'd: a pending download retry must keep the event
  // loop alive, otherwise bare Node contexts (tests, CLI) drain the loop and
  // abort before the retry fires.
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function readGzipTarball(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw new Error("Plugin archive exceeds the 25 MB download limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return gunzipSync(Buffer.concat(chunks, totalBytes), {
      maxOutputLength: MAX_PACKAGE_BYTES + MAX_PACKAGE_ENTRIES * 1_024
    });
  } catch (error) {
    throw new Error("GitHub plugin archive is not a valid bounded gzip tarball.", { cause: error });
  }
}

export async function extractGithubTarball(tarball: Buffer, destination: string): Promise<void> {
  let offset = 0;
  let archiveRoot: string | null = null;
  let entryCount = 0;
  let totalBytes = 0;
  await mkdir(destination, { recursive: true });

  while (offset + 512 <= tarball.length) {
    const header = tarball.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    assertTarChecksum(header);
    const size = tarOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarball.length) throw new Error("GitHub plugin archive is truncated.");
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === "x" || type === "g") continue;
    if (type !== "0" && type !== "\0" && type !== "5") {
      throw new Error("Plugin archive contains a link or unsupported file type.");
    }

    const parts = safeArchiveParts(archivePath);
    if (parts.length === 0) continue;
    if (archiveRoot === null) archiveRoot = parts[0];
    if (parts[0] !== archiveRoot) throw new Error("GitHub plugin archive contains multiple roots.");
    const relativeParts = parts.slice(1);
    if (relativeParts.length === 0) continue;
    const target = join(destination, ...relativeParts);
    entryCount += 1;
    if (entryCount > MAX_PACKAGE_ENTRIES) {
      throw new Error("Plugin package exceeds the 500 entry / 25 MB limit.");
    }

    if (type === "5") {
      await mkdir(target, { recursive: true });
      continue;
    }

    totalBytes += size;
    if (totalBytes > MAX_PACKAGE_BYTES) {
      throw new Error("Plugin package exceeds the 500 entry / 25 MB limit.");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, tarball.subarray(dataStart, dataEnd));
  }
}

function validateGridSize(value: unknown): { columns: number; rows: number } {
  if (!isRecord(value) || !Number.isInteger(value.columns) || !Number.isInteger(value.rows)) {
    throw new Error("Home widget defaultSize must contain integer columns and rows.");
  }
  assertOnlyKeys(value, ["columns", "rows"], "Home widget defaultSize");
  const columns = value.columns as number;
  const rows = value.rows as number;
  if (columns < 1 || columns > HOME_GRID_MAX_COLUMNS || rows < 1 || rows > HOME_GRID_MAX_ROWS) {
    throw new Error("Home widget defaultSize does not fit the Home grid.");
  }
  return { columns, rows };
}

async function downloadGithubManifest(sourceUrl: string, destination: string): Promise<void> {
  const repository = await githubRepositoryMetadata(sourceUrl);
  await mkdir(destination, { recursive: true });
  // Metadata-first: metadata/canvastty.plugin.json, then legacy root file.
  let fetched = false;
  for (const candidate of MANIFEST_CANDIDATES) {
    try {
      const url = githubRawUrl(repository.owner, repository.name, repository.branch, candidate);
      const content = await fetchBoundedGithubFile(url, MAX_MANIFEST_BYTES);
      await mkdir(join(destination, METADATA_DIR), { recursive: true });
      const target = join(destination, METADATA_DIR, MANIFEST_FILE);
      await writeFile(target, content);
      fetched = true;
      break;
    } catch (error) {
      // Missing candidate — try the next one; anything else is fatal.
      if (!(error instanceof MissingGithubFileError)) throw error;
    }
  }
  if (!fetched) throw new Error(`${MANIFEST_FILE} is missing or too large.`);
}

interface GithubSearchItem {
  full_name?: unknown;
  description?: unknown;
  stargazers_count?: unknown;
  updated_at?: unknown;
}

let githubTokenProvider: (() => Promise<string | null>) | null = null;

/** Registers the OAuth-backed GitHub token provider for module-level helpers. */
export function registerGithubTokenProvider(provider: () => Promise<string | null>): void {
  githubTokenProvider = provider;
}

async function resolveGithubToken(): Promise<string | null> {
  const envToken = process.env.GITHUB_TOKEN ?? process.env.CANVASTTY_GITHUB_TOKEN;
  if (envToken) return envToken;
  if (githubTokenProvider) {
    try {
      return await githubTokenProvider();
    } catch {
      return null;
    }
  }
  return null;
}

async function searchGithubPluginRepositories(query: string): Promise<GithubSearchItem[]> {
  const term = query.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  timer.unref();
  try {
    const token = await resolveGithubToken();
    if (token) {
      // GraphQL search uses the GraphQL point budget (5000/h) instead of the
      // Search API quota (30/min), so repeated searches do not hit the limit.
      const page = await githubGraphqlSearchPage(`canvastty-plugin-${term} in:name`, SEARCH_MAX_RESULTS, null, token, controller.signal);
      return page.items.slice(0, SEARCH_MAX_RESULTS);
    }
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", `canvastty-plugin-${term} in:name`);
    url.searchParams.set("per_page", String(SEARCH_MAX_RESULTS));
    const items = await fetchGithubSearchPage(url, controller.signal);
    return items.slice(0, SEARCH_MAX_RESULTS);
  } finally {
    clearTimeout(timer);
  }
}

async function listShowcasePluginRepositories(): Promise<GithubSearchItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  timer.unref();
  try {
    const token = await resolveGithubToken();
    if (token) {
      // GraphQL cursor pagination: same 100-per-page walk as the REST path,
      // but charged against the GraphQL point budget instead of the Search API
      // quota — the showcase no longer consumes the 30/min search limit.
      const items: GithubSearchItem[] = [];
      let cursor: string | null = null;
      for (let page = 1; page <= 10; page += 1) {
        const batch = await githubGraphqlSearchPage("canvastty-plugin in:name", 100, cursor, token, controller.signal);
        if (batch.items.length === 0) break;
        items.push(...batch.items);
        if (!batch.hasNextPage || !batch.endCursor) break;
        cursor = batch.endCursor;
        if (batch.items.length < 100) break;
      }
      return items;
    }
    const items: GithubSearchItem[] = [];
    const perPage = 100;
    for (let page = 1; page <= 10; page += 1) {
      const url = new URL("https://api.github.com/search/repositories");
      url.searchParams.set("q", "canvastty-plugin in:name");
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("page", String(page));
      const batch = await fetchGithubSearchPage(url, controller.signal);
      if (batch.length === 0) break;
      items.push(...batch);
      if (batch.length < perPage) break;
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

/** One page of repository search results via the GraphQL API. */
async function githubGraphqlSearchPage(
  query: string,
  first: number,
  after: string | null,
  token: string,
  signal: AbortSignal
): Promise<{ items: GithubSearchItem[]; hasNextPage: boolean; endCursor: string | null }> {
  const gql = after
    ? `query($q: String!, $first: Int!, $after: String!) { search(query: $q, type: REPOSITORY, first: $first, after: $after) { repositoryCount pageInfo { hasNextPage endCursor } nodes { ... on Repository { nameWithOwner description stargazerCount updatedAt } } } }`
    : `query($q: String!, $first: Int!) { search(query: $q, type: REPOSITORY, first: $first) { repositoryCount pageInfo { hasNextPage endCursor } nodes { ... on Repository { nameWithOwner description stargazerCount updatedAt } } } }`;
  const variables: Record<string, unknown> = { q: query, first };
  if (after) variables.after = after;
  const response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "CanvasTTY plugin search",
      "content-type": "application/json"
    },
    body: JSON.stringify({ query: gql, variables }),
    signal
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error("GitHub search rate limit reached; try again in a minute.");
  }
  if (!response.ok) {
    throw new Error(`GitHub plugin search failed with HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("GitHub plugin search returned an invalid response.");
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`GitHub plugin search failed: ${JSON.stringify(payload.errors).slice(0, 200)}`);
  }
  const data = isRecord(payload.data) ? payload.data : null;
  const search = isRecord(data) && isRecord(data.search) ? data.search : null;
  if (!search) return { items: [], hasNextPage: false, endCursor: null };
  const items: GithubSearchItem[] = [];
  if (Array.isArray(search.nodes)) {
    for (const node of search.nodes) {
      if (!isRecord(node)) continue;
      const fullName = String(node.nameWithOwner ?? "");
      if (!fullName) continue;
      items.push({
        full_name: fullName,
        description: String(node.description ?? ""),
        stargazers_count: Number(node.stargazerCount ?? 0),
        updated_at: String(node.updatedAt ?? "")
      });
    }
  }
  const pageInfo = isRecord(search.pageInfo) ? search.pageInfo : null;
  return {
    items,
    hasNextPage: Boolean(pageInfo && pageInfo.hasNextPage),
    endCursor: pageInfo && typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null
  };
}

async function fetchGithubSearchPage(url: URL, signal: AbortSignal): Promise<GithubSearchItem[]> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "CanvasTTY plugin search"
      },
      signal
    });
  } catch (error) {
    if (signal.aborted) throw new Error("GitHub plugin search timed out.");
    throw new Error("GitHub plugin search could not establish a connection.", { cause: error });
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error("GitHub search rate limit reached; try again in a minute.");
  }
  if (!response.ok || !response.body) {
    throw new Error(`GitHub plugin search failed with HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  const items: GithubSearchItem[] = [];
  for (const item of payload.items) {
    if (isRecord(item)) items.push(item as GithubSearchItem);
  }
  return items;
}

function mapSearchResults(results: GithubSearchItem[]): GithubPluginSearchResult[] {
  const entries: GithubPluginSearchResult[] = [];
  for (const item of results) {
    const fullName = String(item.full_name ?? "");
    if (!fullName) continue;
    const parts = fullName.split("/");
    if (parts.length !== 2 || !isGithubName(parts[0]) || !isGithubName(parts[1])) continue;
    if (!parts[1].startsWith("canvastty-plugin-")) continue;
    entries.push({
      fullName,
      url: `https://github.com/${parts[0]}/${parts[1]}`,
      description: String(item.description ?? ""),
      stars: Number(item.stargazers_count ?? 0),
      updatedAt: String(item.updated_at ?? "")
    });
  }
  return entries;
}

/** Local showcase stubs for tests (env CANVASTTY_SHOWCASE_STUBS=N). */
function makeShowcaseStubs(count: number): GithubPluginSearchResult[] {
  const stubs: GithubPluginSearchResult[] = [];
  for (let i = 1; i <= count; i += 1) {
    stubs.push({
      fullName: `4444cjtr/canvastty-plugin-showcase-stub-${String(i).padStart(2, "0")}`,
      url: `https://github.com/4444cjtr/canvastty-plugin-showcase-stub-${String(i).padStart(2, "0")}`,
      description: `Showcase stub #${i} for testing pagination.`,
      stars: 10 + (i % 40),
      updatedAt: new Date(Date.now() - i * 86_400_000).toISOString()
    });
  }
  return stubs;
}
async function fetchRemoteManifestVersions(sourceUrls: readonly string[]): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const parsed = new Map<string, { owner: string; repository: string }>();
  for (const sourceUrl of sourceUrls) {
    try {
      const source = new URL(sourceUrl);
      const parts = source.pathname.split("/").filter(Boolean);
      const owner = parts[0] ?? "";
      const repository = (parts[1] ?? "").replace(/\.git$/i, "");
      if (owner && repository) parsed.set(sourceUrl, { owner, repository });
    } catch {
      // Unparseable URL — skipped.
    }
  }
  if (parsed.size === 0) return versions;
  const toEntries = (path: string): Array<{ key: string; owner: string; repository: string; path: string; maximumBytes: number; asDataUrl: boolean }> =>
    [...parsed.entries()].map(([key, repo]) => ({
      key, owner: repo.owner, repository: repo.repository, path, maximumBytes: MAX_MANIFEST_BYTES, asDataUrl: false
    }));
  // Metadata-first: metadata/canvastty.plugin.json, then legacy root file.
  // One batched metadata round-trip per candidate, then one raw fetch per present manifest.
  for (const candidate of MANIFEST_CANDIDATES) {
    const pending = [...parsed.keys()].filter((key) => !versions.has(key));
    if (pending.length === 0) break;
    const results = await githubGraphqlBatch(toEntries(candidate).filter((entry) => pending.includes(entry.key)));
    for (const [key, result] of results) {
      if (!result.ok || result.text === undefined) continue;
      try {
        const manifest = validatePluginManifest(JSON.parse(result.text) as unknown);
        versions.set(key, manifest.version);
      } catch {
        // Malformed manifest — treated as "no remote version".
      }
    }
  }
  return versions;
}

async function fetchRemoteManifestVersion(sourceUrl: string): Promise<string> {
  const versions = await fetchRemoteManifestVersions([sourceUrl]);
  const version = versions.get(sourceUrl);
  if (version === undefined) throw new Error("GitHub manifest could not be fetched.");
  return version;
}

async function downloadGithubModuleFiles(
  sourceUrl: string,
  destination: string,
  files: readonly PluginModuleAsset[]
): Promise<void> {
  const repository = await githubRepositoryMetadata(sourceUrl);
  for (const file of files) {
    const content = await fetchBoundedGithubFile(
      githubRawUrl(repository.owner, repository.name, repository.branch, file.path),
      file.bytes
    );
    if (content.length !== file.bytes || createHash("sha256").update(content).digest("hex") !== file.sha256) {
      throw new Error(`Plugin module asset failed integrity verification: ${file.path}.`);
    }
    const path = join(destination, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

const githubMetadataCache = new Map<string, { owner: string; name: string; branch: string }>();

async function githubRepositoryMetadata(sourceUrl: string): Promise<{ owner: string; name: string; branch: string }> {
  const cached = githubMetadataCache.get(sourceUrl);
  if (cached) return cached;
  const metadata = await retryGithubDownload(() => githubRepositoryMetadataOnce(sourceUrl));
  githubMetadataCache.set(sourceUrl, metadata);
  return metadata;
}

async function githubRepositoryMetadataOnce(sourceUrl: string): Promise<{ owner: string; name: string; branch: string }> {
  const source = new URL(sourceUrl);
  const [owner, repositoryWithGit] = source.pathname.split("/").filter(Boolean);
  const name = repositoryWithGit.replace(/\.git$/i, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref();
  try {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
        redirect: "follow",
        headers: { accept: "application/vnd.github+json", "user-agent": "CanvasTTY plugin installer" },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) throw new TransientGithubDownloadError("GitHub metadata request timed out.");
      throw new TransientGithubDownloadError("GitHub metadata request could not establish a connection.", { cause: error });
    }
    const finalUrl = new URL(response.url || `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "api.github.com") {
      throw new Error("GitHub metadata request redirected outside api.github.com.");
    }
    if (response.status === 404) throw new Error("GitHub repository was not found or is not public.");
    if (!response.ok) {
      const message = `GitHub metadata request failed with HTTP ${response.status}.`;
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new TransientGithubDownloadError(message);
      }
      throw new Error(message);
    }
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.default_branch !== "string" || value.default_branch.length > 200) {
      throw new Error("GitHub repository metadata is invalid.");
    }
    return { owner, name, branch: value.default_branch };
  } finally {
    clearTimeout(timer);
  }
}

function githubRawUrl(owner: string, repository: string, branch: string, path: string): string {
  return [
    "https://raw.githubusercontent.com",
    encodeURIComponent(owner),
    encodeURIComponent(repository),
    encodeURIComponent(branch),
    ...assetPath(path).split("/").map(encodeURIComponent)
  ].join("/");
}

const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const GITHUB_GRAPHQL_BATCH_LIMIT = 8;

interface GithubBlobResult {
  ok: boolean;
  dataUrl?: string;
  text?: string;
  missing?: boolean;
}

/**
 * Batch-fetches files across multiple repositories with a single GraphQL
 * request. Each entry describes one file to read at HEAD of a repository.
 * Returns results keyed by the entry key. Uses the unauthenticated REST
 * fallback path per file only when no token is available (GraphQL requires
 * authentication); with a token this collapses N HTTP requests into one.
 */
async function githubGraphqlBatch(
  entries: Array<{ key: string; owner: string; repository: string; path: string; maximumBytes: number; asDataUrl: boolean }>
): Promise<Map<string, GithubBlobResult>> {
  const results = new Map<string, GithubBlobResult>();
  if (entries.length === 0) return results;

  const token = await resolveGithubToken();
  if (!token) {
    // No token: GraphQL is unavailable. Fall back to one raw fetch per entry
    // (still avoids the repository-metadata round trip via cached metadata).
    for (let offset = 0; offset < entries.length; offset += GITHUB_GRAPHQL_BATCH_LIMIT) {
      const chunk = entries.slice(offset, offset + GITHUB_GRAPHQL_BATCH_LIMIT);
      await Promise.all(chunk.map(async (entry) => {
        try {
          const sourceUrl = `https://github.com/${encodeURIComponent(entry.owner)}/${encodeURIComponent(entry.repository)}`;
          const metadata = await githubRepositoryMetadata(sourceUrl);
          const url = githubRawUrl(entry.owner, entry.repository, metadata.branch, entry.path);
          const content = await fetchBoundedGithubFile(url, entry.maximumBytes);
          results.set(entry.key, entry.asDataUrl
            ? { ok: true, dataUrl: `data:${mimeForPath(entry.path)};base64,${content.toString("base64")}` }
            : { ok: true, text: content.toString("utf8") });
        } catch {
          results.set(entry.key, { ok: false, missing: true });
        }
      }));
    }
    return results;
  }

  for (let offset = 0; offset < entries.length; offset += GITHUB_GRAPHQL_BATCH_LIMIT) {
    const chunk = entries.slice(offset, offset + GITHUB_GRAPHQL_BATCH_LIMIT);
    const chunkResults = await githubGraphqlBatchWithToken(chunk, token);
    for (const [key, result] of chunkResults) results.set(key, result);
  }
  return results;
}

async function githubGraphqlBatchWithToken(
  entries: Array<{ key: string; owner: string; repository: string; path: string; maximumBytes: number; asDataUrl: boolean }>,
  token: string
): Promise<Map<string, GithubBlobResult>> {
  const results = new Map<string, GithubBlobResult>();

  // Batched GraphQL: one HTTP request, N repository(file) nodes.
  const aliases: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    aliases.push(
      `a${index}: repository(owner: ${JSON.stringify(entry.owner)}, name: ${JSON.stringify(entry.repository)}) { defaultBranchRef { name } object(expression: "HEAD:${entry.path.replace(/["\\]/g, "")}") { ... on Blob { isBinary byteSize } } }`
    );
  }
  const query = `query { ${aliases.join(" ")} }`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS * 2);
  timer.unref();
  try {
    const response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": "CanvasTTY plugin installer",
        "content-type": "application/json"
      },
      body: JSON.stringify({ query }),
      signal: controller.signal
    });
    if (!response.ok) {
      const message = `GitHub GraphQL batch failed with HTTP ${response.status}.`;
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new TransientGithubDownloadError(message);
      }
      throw new Error(message);
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error("GitHub GraphQL batch returned an invalid response.");
    const data = isRecord(body.data) ? body.data : null;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const alias = `a${index}`;
      const node = isRecord(data) ? data[alias] : undefined;
      if (!isRecord(node) || node === null) {
        results.set(entry.key, { ok: false, missing: true });
        continue;
      }
      const blob = isRecord(node.object) ? node.object : null;
      if (!blob || !isRecord(blob) || typeof blob.isBinary !== "boolean") {
        results.set(entry.key, { ok: false, missing: true });
        continue;
      }
      if (typeof blob.byteSize === "number" && blob.byteSize > entry.maximumBytes) {
        results.set(entry.key, { ok: false, missing: true });
        continue;
      }
      // We have the metadata; now fetch the actual bytes from raw (GraphQL
      // cannot return raw file bytes for binary content without base64 cost,
      // and text blobs have a size cap). Use one raw request per present file,
      // which is unavoidable — but metadata was already batched.
      try {
        const branch = isRecord(node.defaultBranchRef) && typeof node.defaultBranchRef.name === "string"
          ? node.defaultBranchRef.name
          : "HEAD";
        const url = githubRawUrl(entry.owner, entry.repository, branch, entry.path);
        const content = await fetchBoundedGithubFile(url, entry.maximumBytes);
        results.set(entry.key, entry.asDataUrl
          ? { ok: true, dataUrl: `data:${mimeForPath(entry.path)};base64,${content.toString("base64")}` }
          : { ok: true, text: content.toString("utf8") });
      } catch {
        results.set(entry.key, { ok: false, missing: true });
      }
    }
    return results;
  } catch (error) {
    if (error instanceof TransientGithubDownloadError) throw error;
    if (controller.signal.aborted) {
      throw new TransientGithubDownloadError("GitHub GraphQL batch timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function mimeForPath(path: string): string {
  return path.endsWith(".svg") ? "image/svg+xml" : "image/png";
}

async function fetchBoundedGithubFile(url: string, maximumBytes: number): Promise<Buffer> {
  return retryGithubDownload(() => fetchBoundedGithubFileOnce(url, maximumBytes));
}

async function fetchBoundedGithubFileOnce(url: string, maximumBytes: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref();
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": "CanvasTTY plugin installer" },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) throw new TransientGithubDownloadError("GitHub plugin file download timed out.");
      throw new TransientGithubDownloadError("GitHub plugin file download could not establish a connection.", { cause: error });
    }
    const finalUrl = new URL(response.url || url);
    if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "raw.githubusercontent.com") {
      throw new Error("GitHub plugin file redirected outside raw.githubusercontent.com.");
    }
    if (!response.ok || !response.body) {
      const message = `GitHub file download failed with HTTP ${response.status}.`;
      if (response.status === 404 || response.status === 403) {
        throw new MissingGithubFileError(response.status);
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new TransientGithubDownloadError(message);
      }
      throw new Error(message);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Plugin file exceeds its declared size.");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maximumBytes) throw new Error("Plugin file exceeds its declared size.");
        chunks.push(chunk);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new TransientGithubDownloadError("GitHub plugin file download timed out.", { cause: error });
      }
      if (error instanceof TypeError) {
        throw new TransientGithubDownloadError("GitHub plugin file download was interrupted.", { cause: error });
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

function assertModularContributionFiles(manifest: PluginManifest): void {
  const coreFiles = new Set((manifest.coreFiles ?? []).map((file) => file.path));
  const moduleFiles = new Map((manifest.modules ?? []).map((module) => [
    module.id,
    new Set(module.files.map((file) => file.path))
  ]));
  for (const contribution of manifest.contributions) {
    const available = contribution.module ? moduleFiles.get(contribution.module) : coreFiles;
    if (!available?.has(contribution.entry) || (contribution.icon && !available.has(contribution.icon))) {
      throw new Error(`Contribution assets must belong to its declared module: ${contribution.id}.`);
    }
  }
  for (const hook of manifest.hooks ?? []) {
    const available = hook.module ? moduleFiles.get(hook.module) : coreFiles;
    if (!available?.has(hook.entry)) {
      throw new Error(`Hook entry must belong to its declared module: ${hook.id}.`);
    }
  }
}

async function materializeModularPackage(
  sourceUrl: string,
  previewRoot: string,
  destination: string,
  manifest: PluginManifest,
  selectedModules: readonly string[],
  downloadFiles: DownloadModuleFiles
): Promise<void> {
  const selected = new Set(selectedModules);
  const files = [
    ...(manifest.coreFiles ?? []),
    ...(manifest.modules ?? []).filter((module) => selected.has(module.id)).flatMap((module) => module.files)
  ];
  if (files.length > MAX_PACKAGE_ENTRIES || files.reduce((total, file) => total + file.bytes, 0) > MAX_PACKAGE_BYTES) {
    throw new Error("Selected plugin modules exceed the package limits.");
  }
  await mkdir(destination, { recursive: true });
  await mkdir(join(destination, METADATA_DIR), { recursive: true });
  const sourceManifest = await firstExistingFile(previewRoot, MANIFEST_CANDIDATES);
  if (!sourceManifest) throw new Error(`${MANIFEST_FILE} is missing or too large.`);
  await copyFile(sourceManifest, join(destination, METADATA_DIR, MANIFEST_FILE));
  await downloadFiles(sourceUrl, destination, files);
  await inspectPackage(destination);
  await assertManifestAssets(destination, activeManifest(manifest, selectedModules));
}

function activeManifest(manifest: PluginManifest, selectedModules: readonly string[]): PluginManifest {
  const selected = new Set(selectedModules);
  const contributions = manifest.contributions.filter((contribution) => !contribution.module || selected.has(contribution.module));
  const { settingsContribution, hooks: declaredHooks = [], ...rest } = manifest;
  const hooks = declaredHooks.filter((hook) => !hook.module || selected.has(hook.module));
  const permissions = [
    ...manifest.permissions,
    ...(manifest.modules ?? []).filter((module) => selected.has(module.id)).flatMap((module) => module.permissions)
  ];
  return {
    ...rest,
    permissions: [...new Set(permissions)],
    contributions,
    ...(hooks.length ? { hooks } : {}),
    ...(settingsContribution && contributions.some((item) => item.id === settingsContribution)
      ? { settingsContribution }
      : {})
  };
}

function validateModules(value: unknown): PluginModule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error("Plugin modules must be an array of at most 16 items.");
  const ids = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Every plugin module must be an object.");
    assertOnlyKeys(candidate, ["id", "title", "description", "defaultSelected", "permissions", "files"], "Plugin module");
    const id = requiredString(candidate.id, "module id", 64);
    if (!isContributionId(id) || ids.has(id)) throw new Error(`Plugin module id is invalid or duplicated: ${id}.`);
    ids.add(id);
    const title = requiredString(candidate.title, "module title", 80);
    const description = optionalString(candidate.description, "module description", 240);
    if (!Array.isArray(candidate.permissions)) throw new Error(`Plugin module ${id} permissions must be an array.`);
    const permissions: PluginPermission[] = [];
    for (const permission of candidate.permissions) {
      if (!PLUGIN_PERMISSIONS.has(permission as PluginPermission)) {
        throw new Error(`Unknown plugin module permission: ${String(permission)}.`);
      }
      if (!permissions.includes(permission as PluginPermission)) permissions.push(permission as PluginPermission);
    }
    return {
      id,
      title,
      ...(description ? { description } : {}),
      defaultSelected: candidate.defaultSelected !== false,
      permissions,
      files: validateModuleFiles(candidate.files, `module ${id} files`)
    };
  });
}

function normalizeSelectedModules(manifest: PluginManifest, value: unknown): string[] {
  const available = new Set((manifest.modules ?? []).map((module) => module.id));
  if (!Array.isArray(value)) return [];
  const selected: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !available.has(id) || selected.includes(id)) continue;
    selected.push(id);
  }
  return selected;
}

function normalizeEnabledHooks(
  manifest: PluginManifest,
  value: unknown,
  selectedModules: readonly string[]
): string[] {
  if (!Array.isArray(value)) return [];
  const available = new Set((activeManifest(manifest, selectedModules).hooks ?? []).map((hook) => hook.id));
  return value.filter((id): id is string => typeof id === "string" && available.has(id))
    .filter((id, index, values) => values.indexOf(id) === index);
}

function activePlugin(plugin: InstalledPlugin): InstalledPlugin {
  return {
    ...plugin,
    manifest: activeManifest(plugin.manifest, plugin.selectedModules)
  };
}

function validateModuleFiles(value: unknown, label: string): PluginModuleAsset[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PACKAGE_ENTRIES) {
    throw new Error(`Plugin ${label} must contain between 1 and ${MAX_PACKAGE_ENTRIES} files.`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`Every plugin ${label} entry must be an object.`);
    assertOnlyKeys(candidate, ["path", "bytes", "sha256"], `Plugin ${label} entry`);
    const path = assetPath(requiredString(candidate.path, `${label} path`, 180));
    if (MANIFEST_CANDIDATES.includes(path) || seen.has(path)) throw new Error(`Plugin module asset is invalid or duplicated: ${path}.`);
    seen.add(path);
    if (!Number.isInteger(candidate.bytes) || (candidate.bytes as number) < 0 || (candidate.bytes as number) > MAX_ASSET_BYTES) {
      throw new Error(`Plugin module asset size is invalid: ${path}.`);
    }
    const bytes = candidate.bytes as number;
    totalBytes += bytes;
    if (totalBytes > MAX_PACKAGE_BYTES) throw new Error("Plugin module assets exceed the 25 MB package limit.");
    const sha256 = requiredString(candidate.sha256, `${label} sha256`, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Plugin module asset hash is invalid: ${path}.`);
    return { path, bytes, sha256 };
  });
}

function validateWindowSize(
  value: unknown,
  label: "defaultSize" | "minSize",
  minimumWidth: number,
  minimumHeight: number
): Size {
  if (!isRecord(value) || !Number.isFinite(value.width) || !Number.isFinite(value.height)) {
    throw new Error(`Plugin window ${label} must contain a finite width and height.`);
  }
  assertOnlyKeys(value, ["width", "height"], `Plugin window ${label}`);
  const width = Math.round(value.width as number);
  const height = Math.round(value.height as number);
  if (width < minimumWidth || width > 1_600 || height < minimumHeight || height > 1_100) {
    throw new Error(`Plugin window ${label} is outside the supported bounds.`);
  }
  return { width, height };
}

function assetPath(value: string): string {
  if (value.includes("\\") || value.startsWith("/") || value.includes("\0")) throw new Error("Plugin asset path is invalid.");
  const parts = value.split("/");
  if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Plugin asset path is invalid.");
  }
  return parts.join("/");
}

function encodeAssetPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function decodeAssetPath(pathname: string): string {
  try {
    return assetPath(pathname.replace(/^\/+/, "").split("/").map(decodeURIComponent).join("/"));
  } catch {
    throw new Error("Plugin asset URL is invalid.");
  }
}

function resourceHeaders(mime: string, network: boolean, mediaLibrary: boolean): Headers {
  const connectSources = [
    ...(mediaLibrary ? ["canvastty-media:"] : []),
    ...(network ? ["https:", "http://127.0.0.1:*", "http://localhost:*"] : [])
  ].join(" ") || "'none'";
  const remoteMedia = network ? " https:" : "";
  const localMedia = mediaLibrary ? " canvastty-media:" : "";
  return new Headers({
    "content-type": mime,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self' canvastty-plugin://host",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob:${remoteMedia}`,
      `media-src 'self' data: blob:${localMedia}${remoteMedia}`,
      "font-src 'self' data:",
      `connect-src ${connectSources}`,
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join("; ")
  });
}

function response(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}

function mimeType(path: string): string {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav"
  } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new Error(`Plugin ${field} is missing or too long.`);
  }
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined) return null;
  return requiredString(value, field, maxLength);
}

function optionalWebUrl(value: unknown, field: string): string | null {
  const text = optionalString(value, field, 300);
  if (!text) return null;
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Plugin ${field} must be an HTTP(S) URL.`);
  return url.toString();
}

function isPluginId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 3
    && value.length <= 80
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
    && !value.includes("..");
}

function isContributionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 64
    && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value);
}

function isGithubName(value: string): boolean {
  return value.length > 0 && value.length <= 100 && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

function isStoredRecord(value: unknown): value is StoredPluginRecord {
  return Boolean(
    isRecord(value)
    && typeof value.sourceUrl === "string"
    && typeof value.enabled === "boolean"
    && typeof value.installedAt === "number"
    && Number.isFinite(value.installedAt)
    && (value.selectedModules === undefined || (
      Array.isArray(value.selectedModules) && value.selectedModules.every((item) => typeof item === "string")
    ))
    && (value.enabledHooks === undefined || (
      Array.isArray(value.enabledHooks) && value.enabledHooks.every((item) => typeof item === "string")
    ))
  );
}

function runtimeHookKey(pluginId: string, hookId: string): string {
  return `${pluginId}:${hookId}`;
}

function runtimeHookRecord(root: string, pluginId: string, hook: PluginAgentHook): RuntimeHookRecord {
  return {
    pluginId,
    hookId: hook.id,
    root,
    entry: hook.entry,
    providers: [...hook.providers],
    events: [...hook.events]
  };
}

function runtimeHookTrustMatches(
  registry: RuntimeHookRegistry,
  root: string,
  pluginId: string,
  hook: PluginAgentHook | undefined
): boolean {
  if (!hook) return false;
  const persisted = registry.hooks[runtimeHookKey(pluginId, hook.id)];
  return Boolean(persisted && sameRuntimeHookRecord(persisted, runtimeHookRecord(root, pluginId, hook)));
}

function safeRuntimeHookInterim(
  current: RuntimeHookRegistry,
  desired: RuntimeHookRegistry
): RuntimeHookRegistry {
  const hooks: Record<string, RuntimeHookRecord> = {};
  for (const [key, desiredHook] of Object.entries(desired.hooks)) {
    const currentHook = current.hooks[key];
    if (currentHook && sameRuntimeHookRecord(currentHook, desiredHook)) hooks[key] = currentHook;
  }
  return { version: 1, hooks };
}

function sameRuntimeHookRecord(left: RuntimeHookRecord, right: RuntimeHookRecord): boolean {
  return left.pluginId === right.pluginId
    && left.hookId === right.hookId
    && left.root === right.root
    && left.entry === right.entry
    && left.providers.length === right.providers.length
    && left.providers.every((provider, index) => provider === right.providers[index])
    && left.events.length === right.events.length
    && left.events.every((event, index) => event === right.events[index]);
}

async function writeRuntimeHookRegistry(path: string, snapshot: string): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

async function readRuntimeHookRegistry(path: string): Promise<RuntimeHookRegistry> {
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_RUNTIME_HOOK_REGISTRY_BYTES) return { version: 1, hooks: {} };
    const candidate: unknown = JSON.parse(raw);
    if (!isRecord(candidate) || candidate.version !== 1 || !isRecord(candidate.hooks)) {
      return { version: 1, hooks: {} };
    }
    const hooks: Record<string, RuntimeHookRecord> = {};
    for (const [key, value] of Object.entries(candidate.hooks)) {
      if (!isRuntimeHookRecord(value) || key !== runtimeHookKey(value.pluginId, value.hookId)) continue;
      hooks[key] = value;
    }
    return { version: 1, hooks };
  } catch {
    return { version: 1, hooks: {} };
  }
}

function isRuntimeHookRecord(value: unknown): value is RuntimeHookRecord {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "pluginId", "hookId", "root", "entry", "providers", "events"
  ].includes(key))) return false;
  return typeof value.pluginId === "string"
    && isPluginId(value.pluginId)
    && typeof value.hookId === "string"
    && isContributionId(value.hookId)
    && typeof value.root === "string"
    && isAbsolute(value.root)
    && typeof value.entry === "string"
    && !isAbsolute(value.entry)
    && Array.isArray(value.providers)
    && value.providers.length > 0
    && value.providers.every((provider) => AGENT_PROVIDERS.has(provider as AgentProviderId))
    && new Set(value.providers).size === value.providers.length
    && Array.isArray(value.events)
    && value.events.length > 0
    && value.events.every((event) => PLUGIN_HOOK_EVENTS.has(event as PluginAgentHookEvent))
    && new Set(value.events).size === value.events.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`${label} contains an unknown field: ${unknown}.`);
}

function assertPlatformCompatible(manifest: PluginManifest): void {
  if (manifest.platforms?.length && !manifest.platforms.includes(PLATFORM_ID)) {
    throw new Error(`Plugin ${manifest.id} does not support the ${PLATFORM_ID} platform.`);
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function assertStorageKey(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
    throw new Error("Plugin storage key is invalid.");
  }
}

function jsonClone(value: unknown): unknown {
  if (value === undefined) throw new Error("Plugin storage value must be JSON serializable.");
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    throw new Error("Plugin storage value must be JSON serializable.");
  }
}

function tarText(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8").trim();
}

function tarOctal(value: Buffer): number {
  const text = tarText(value).replace(/^\s+|\s+$/g, "");
  if (!/^[0-7]+$/.test(text)) throw new Error("Plugin archive contains an invalid tar size.");
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Plugin archive contains an invalid tar size.");
  return parsed;
}

function assertTarChecksum(header: Buffer): void {
  const expected = tarOctal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) throw new Error("Plugin archive tar checksum is invalid.");
}

function safeArchiveParts(value: string): string[] {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error("Plugin archive contains an unsafe path.");
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes(":"))) {
    throw new Error("Plugin archive contains an unsafe path.");
  }
  return parts;
}

const PLUGIN_SDK_SOURCE = `(() => {
  const pending = new Map();
  const listeners = new Set();
  const storageListeners = new Set();
  let nextId = 1;
  const post = (message) => parent.postMessage({ source: "canvastty-plugin", ...message }, "*");
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = String(nextId++);
    pending.set(requestId, { resolve, reject });
    post({ type: "request", requestId, method, params });
  });
  addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || !message || message.source !== "canvastty-host") return;
    if (message.type === "response") {
      const handler = pending.get(message.requestId);
      if (!handler) return;
      pending.delete(message.requestId);
      message.ok ? handler.resolve(message.value) : handler.reject(new Error(message.error || "Plugin request failed."));
      return;
    }
    if (message.type === "context") listeners.forEach((listener) => listener(message.value));
    if (message.type === "storage-change") {
      storageListeners.forEach((listener) => listener(message.key, message.value));
    }
  });
  window.CanvasTTYPlugin = Object.freeze({
    ready: () => post({ type: "ready" }),
    request,
    storage: Object.freeze({
      get: (key) => request("storage.get", { key }),
      set: (key, value) => request("storage.set", { key, value })
    }),
    secrets: Object.freeze({
      get: (key) => request("secrets.get", { key }),
      set: (key, value) => request("secrets.set", { key, value }),
      delete: (key) => request("secrets.delete", { key })
    }),
    canvas: Object.freeze({
      open: (contributionId) => request("canvas.open", { contributionId })
    }),
    media: Object.freeze({
      pickLibrary: () => request("media.pickLibrary"),
      listLibraries: () => request("media.listLibraries"),
      scanLibrary: (libraryId) => request("media.scanLibrary", { libraryId }),
      revokeLibrary: (libraryId) => request("media.revokeLibrary", { libraryId })
    }),
    playlists: Object.freeze({
      list: (libraryId) => request("playlists.list", { libraryId }),
      read: (libraryId, playlistId) => request("playlists.read", { libraryId, playlistId }),
      write: (libraryId, name, content) => request("playlists.write", { libraryId, name, content })
    }),
    hermesHud: Object.freeze({
      getState: () => request("hermesHud.getState"),
      open: () => request("hermesHud.open"),
      close: () => request("hermesHud.close")
    }),
    onContext: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStorageChange: (listener) => {
      storageListeners.add(listener);
      return () => storageListeners.delete(listener);
    }
  });
  addEventListener("DOMContentLoaded", () => post({ type: "ready" }), { once: true });
})();`;

const PLUGIN_INPUT_BRIDGE_SOURCE = `(() => {
  if (parent === window) return;
  let captureWheel = false;
  addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || !message || message.source !== "canvastty-host") return;
    if (message.type === "canvas-input-policy") captureWheel = message.captureWheel === true;
  });
  addEventListener("wheel", (event) => {
    if (!captureWheel) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    parent.postMessage({
      source: "canvastty-plugin",
      type: "canvas-wheel",
      clientX: event.clientX,
      clientY: event.clientY,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey
    }, "*");
  }, { capture: true, passive: false });
  addEventListener("pointerdown", () => {
    parent.postMessage({ source: "canvastty-plugin", type: "canvas-focus" }, "*");
  }, { capture: true });
  addEventListener("pointerover", (event) => {
    if (event.relatedTarget !== null) return;
    parent.postMessage({ source: "canvastty-plugin", type: "canvas-hover", active: true }, "*");
  }, { capture: true });
  addEventListener("pointerout", (event) => {
    if (event.relatedTarget !== null) return;
    parent.postMessage({ source: "canvastty-plugin", type: "canvas-hover", active: false }, "*");
  }, { capture: true });
})();`;
