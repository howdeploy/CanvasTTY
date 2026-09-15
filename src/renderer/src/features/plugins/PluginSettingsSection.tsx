import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AppSettings,
  GithubAuthStatus,
  GithubDeviceFlowStart,
  GithubPluginSearchResult,
  InstalledPlugin,
  LocaleId,
  PluginContribution,
  PluginInstallPreview,
  PluginManifest,
  PluginModule,
  PluginPermission,
  PluginUpdateStatus
} from "../../../../shared/contracts";
import { t, type TranslationKey } from "../../lib/i18n";
import { INSTALLED_PAGE_SIZE, SHOWCASE_PAGE_SIZE, clampPage, pageCount, paginate } from "./pluginPagination";
import { compareSemver } from "../../../../shared/hostVersion";
import { UiIcon } from "../../components/UiIcon";

/** Plugin description limit when displayed (longer text is truncated). */
const MAX_DESCRIPTION_LENGTH = 400;

interface PluginSettingsSectionProps {
  settings: AppSettings;
  plugins: InstalledPlugin[];
  onPreviewPlugin(sourceUrl: string): Promise<PluginInstallPreview>;
  onInstallPlugin(token: string, selectedModules: string[]): Promise<void>;
  onSearchPlugins(query: string): Promise<GithubPluginSearchResult[]>;
  onShowcasePlugins(): Promise<GithubPluginSearchResult[]>;
  onFetchPluginIcons(sourceUrls: string[]): Promise<Record<string, string | null>>;
  onPreviewManifests(sourceUrls: string[]): Promise<Record<string, PluginManifest>>;
  onOpenBrowser(url?: string): Promise<void>;
  onCheckPluginUpdates(): Promise<PluginUpdateStatus[]>;
  onUpdatePlugin(pluginId: string): Promise<void>;
  onSetPluginModules(pluginId: string, selectedModules: string[]): Promise<void>;
  onSetPluginEnabled(pluginId: string, enabled: boolean): Promise<void>;
  onUninstallPlugin(pluginId: string): Promise<void>;
  onOpenPluginContribution(plugin: InstalledPlugin, contribution: PluginContribution): Promise<void>;
}

export function PluginSettingsSection({
  settings,
  plugins,
  onPreviewPlugin,
  onInstallPlugin,
  onSearchPlugins,
  onShowcasePlugins,
  onFetchPluginIcons,
  onPreviewManifests,
  onOpenBrowser,
  onCheckPluginUpdates,
  onUpdatePlugin,
  onSetPluginModules,
  onSetPluginEnabled,
  onUninstallPlugin,
  onOpenPluginContribution
}: PluginSettingsSectionProps): React.JSX.Element {
  const locale = settings.locale;
  const [sourceUrl, setSourceUrl] = useState("");
  const [preview, setPreview] = useState<PluginInstallPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const [expandedInstalled, setExpandedInstalled] = useState<Record<string, boolean>>({});
  const [installedIcons, setInstalledIcons] = useState<Record<string, string | null>>({});

  // Load the GitHub OAuth status once on mount.
  useEffect(() => {
    let cancelled = false;
    window.canvasTTY.githubAuth.status()
      .then((status) => {
        if (!cancelled) setGithubStatus(status);
      })
      .catch(() => {
        // Status is decorative; ignore failures.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Preload icons for installed plugins from their GitHub repositories (same
  // source as the showcase), keyed by plugin id.
  useEffect(() => {
    const urls = plugins
      .map((plugin) => plugin.sourceUrl)
      .filter((url): url is string => typeof url === "string" && url.length > 0);
    if (urls.length === 0) return;
    let cancelled = false;
    onFetchPluginIcons(urls)
      .then((icons) => {
        if (cancelled) return;
        const byId: Record<string, string | null> = {};
        for (const plugin of plugins) {
          if (!plugin.sourceUrl) continue;
          const icon = icons[plugin.sourceUrl];
          if (icon !== undefined) byId[plugin.manifest.id] = icon;
        }
        setInstalledIcons((current) => ({ ...current, ...byId }));
      })
      .catch(() => {
        // Icons are decorative — local fallback remains.
      });
    return () => {
      cancelled = true;
    };
  }, [plugins, onFetchPluginIcons]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GithubPluginSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [showcase, setShowcase] = useState<GithubPluginSearchResult[] | null>(null);
  const [loadingShowcase, setLoadingShowcase] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GithubAuthStatus | null>(null);
  const githubConfigured = githubStatus?.configured === true;
  const githubAuthorized = githubStatus?.authorized === true;
  const [hostVersion, setHostVersion] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void window.canvasTTY.appVersion().then((version) => {
      if (!cancelled) setHostVersion(version);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const [installedPage, setInstalledPage] = useState(0);
  const [showcasePage, setShowcasePage] = useState(0);
  const installedPaginationRef = useRef<HTMLDivElement | null>(null);
  const showcasePaginationRef = useRef<HTMLDivElement | null>(null);
  // Pagination position at click time, used to compensate for scroll after
  // the list re-renders (pages have different item counts).
  const paginationAnchor = useRef<{ top: number; scroller: Element | null; target: HTMLElement | null } | null>(null);
  const fixPaginationScroll = (): void => {
    const anchor = paginationAnchor.current;
    paginationAnchor.current = null;
    if (!anchor || !anchor.scroller || !anchor.target) return;
    const delta = anchor.target.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1) anchor.scroller.scrollTop += delta;
  };
  useLayoutEffect(() => {
    fixPaginationScroll();
  }, [installedPage, showcasePage]);
  const startInstalledPageChange = (page: number): void => {
    const target = installedPaginationRef.current;
    const scroller = target?.closest(".settings-panel__content") ?? null;
    paginationAnchor.current = scroller && target
      ? { top: target.getBoundingClientRect().top, scroller, target }
      : null;
    setInstalledPage(page);
  };
  const startShowcasePageChange = (page: number): void => {
    const target = showcasePaginationRef.current;
    const scroller = target?.closest(".settings-panel__content") ?? null;
    paginationAnchor.current = scroller && target
      ? { top: target.getBoundingClientRect().top, scroller, target }
      : null;
    setShowcasePage(page);
  };
  const installedPageCount = pageCount(plugins.length, INSTALLED_PAGE_SIZE);
  const showcaseTotal = (searchResults ?? showcase)?.length ?? 0;
  const showcasePageCount = pageCount(showcaseTotal, SHOWCASE_PAGE_SIZE);
  useEffect(() => {
    setInstalledPage((current) => clampPage(current, plugins.length, INSTALLED_PAGE_SIZE));
  }, [plugins.length]);
  useEffect(() => {
    setShowcasePage(0);
  }, [showcaseTotal]);
  const [githubCode, setGithubCode] = useState<GithubDeviceFlowStart | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [showcasePreviews, setShowcasePreviews] = useState<Record<string, PluginInstallPreview>>({});
  const [showcaseManifests, setShowcaseManifests] = useState<Record<string, PluginManifest>>({});
  const [selectedShowcase, setSelectedShowcase] = useState<string | null>(null);
  const [showcaseModules, setShowcaseModules] = useState<Record<string, string[]>>({});
  const [showcaseIcons, setShowcaseIcons] = useState<Record<string, string | null>>({});

  const [updates, setUpdates] = useState<PluginUpdateStatus[] | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    if (!githubCode) return;
    let cancelled = false;
    let timer: number | null = null;

    const poll = async (): Promise<void> => {
      if (Date.now() >= githubCode.expiresAt) {
        if (!cancelled) {
          setGithubCode(null);
          setError(t(locale, "githubAuthExpired"));
        }
        return;
      }
      try {
        const status = await window.canvasTTY.githubAuth.status();
        if (cancelled) return;
        setGithubStatus(status);
        if (status.authorized) {
          setGithubCode(null);
          return;
        }
      } catch {
        // The main process owns the device flow; a transient status read can retry.
      }
      timer = window.setTimeout(() => void poll(), githubCode.interval * 1000);
    };

    timer = window.setTimeout(() => void poll(), githubCode.interval * 1000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [githubCode, locale]);

  const inspect = async (): Promise<void> => {
    if (busy || sourceUrl.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const next = await onPreviewPlugin(sourceUrl.trim());
      setPreview(next);
      setSelectedModules(next.manifest.modules?.filter((module) => module.defaultSelected).map((module) => module.id) ?? []);
    } catch (reason) {
      setError(errorMessage(reason, t(locale, "pluginInstallFailed")));
    } finally {
      setBusy(false);
    }
  };

  const install = async (): Promise<void> => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onInstallPlugin(preview.token, selectedModules);
      setPreview(null);
      setSourceUrl("");
    } catch (reason) {
      // The install token is single-use: the main process consumes it before doing any work, so a
      // failed install leaves the held preview dead. Dropping it makes the next attempt re-inspect.
      setPreview(null);
      setError(errorMessage(reason, t(locale, "pluginInstallFailed")));
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async (): Promise<void> => {
    if (searching || searchQuery.trim().length === 0 || !githubAuthorized) return;
    setSearching(true);
    setError(null);
    try {
      const results = await onSearchPlugins(searchQuery);
      setSearchResults(results);
      setSelectedShowcase(null);
      const urls = results.map((result) => result.url);
      if (urls.length > 0) {
        const [manifests, icons] = await Promise.all([
          onPreviewManifests(urls).catch(() => ({} as Record<string, PluginManifest>)),
          onFetchPluginIcons(urls).catch(() => ({} as Record<string, string | null>))
        ]);
        const byName: Record<string, PluginManifest> = {};
        for (const result of results) {
          const manifest = manifests[result.url];
          if (manifest) byName[result.fullName] = manifest;
        }
        setShowcaseManifests(byName);
        const iconsByName: Record<string, string | null> = {};
        for (const result of results) {
          const icon = icons[result.url];
          if (icon !== undefined) iconsByName[result.fullName] = icon;
        }
        setShowcaseIcons(iconsByName);
      }
    } catch (reason) {
      setError(errorMessage(reason, t(locale, "pluginSearchFailed")));
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const runShowcase = async (): Promise<void> => {
    if (loadingShowcase || !githubAuthorized) return;
    setLoadingShowcase(true);
    setError(null);
    try {
      const results = await onShowcasePlugins();
      setShowcase(results);
      setSearchResults(null);
      // Fresh icon/manifest state: a previous run may have cached stale data.
      setShowcaseIcons({});
      setShowcaseManifests({});
      setSelectedShowcase(null);
      const urls = results.map((result) => result.url);
      if (urls.length > 0) {
        // Batch-load manifests (descriptions etc.) and icons with two IPC
        // round-trips, so expanding a tile afterwards is instant.
        const [manifests, icons] = await Promise.all([
          onPreviewManifests(urls).catch(() => ({} as Record<string, PluginManifest>)),
          onFetchPluginIcons(urls).catch(() => ({} as Record<string, string | null>))
        ]);
        const byName: Record<string, PluginManifest> = {};
        for (const result of results) {
          const manifest = manifests[result.url];
          if (manifest) byName[result.fullName] = manifest;
        }
        setShowcaseManifests(byName);
        const iconsByName: Record<string, string | null> = {};
        for (const result of results) {
          const icon = icons[result.url];
          if (icon !== undefined) iconsByName[result.fullName] = icon;
        }
        setShowcaseIcons(iconsByName);
      }
    } catch (reason) {
      setError(errorMessage(reason, t(locale, "pluginSearchFailed")));
      setShowcase([]);
    } finally {
      setLoadingShowcase(false);
    }
  };

  const copyGithubCode = (code: string): void => {
    window.canvasTTY.clipboard.writeText(code);
    setCodeCopied(true);
    window.setTimeout(() => setCodeCopied(false), 1600);
  };

  const openGithubAuthorization = async (
    flow: GithubDeviceFlowStart,
    target: "embedded" | "external"
  ): Promise<void> => {
    copyGithubCode(flow.userCode);
    const url = flow.verificationUri;
    if (target === "embedded") await onOpenBrowser(url);
    else await window.canvasTTY.githubAuth.openUrl(url);
  };

  const runGithubSignIn = async (target: "embedded" | "external"): Promise<void> => {
    if (githubBusy) return;
    setGithubBusy(true);
    setError(null);
    try {
      const flow = await window.canvasTTY.githubAuth.start();
      setGithubCode(flow);
      setGithubStatus({ configured: true, authorized: false, login: null, tokenExpiresAt: null });
      await openGithubAuthorization(flow, target);
    } catch (reason) {
      setError(errorMessage(reason, t(locale, "githubAuthNotConfigured")));
    } finally {
      setGithubBusy(false);
    }
  };

  const runGithubSignOut = async (): Promise<void> => {
    if (githubBusy) return;
    setGithubBusy(true);
    setError(null);
    try {
      await window.canvasTTY.githubAuth.signOut();
      setGithubStatus((current) => ({
        configured: current?.configured ?? false,
        authorized: false,
        login: null,
        tokenExpiresAt: null
      }));
      setGithubCode(null);
    } finally {
      setGithubBusy(false);
    }
  };

  const selectShowcaseTile = (fullName: string): void => {
    if (busy) return;
    setSelectedShowcase(fullName);
    const manifest = showcaseManifests[fullName];
    if (manifest && showcaseModules[fullName] === undefined) {
      setShowcaseModules((current) => ({
        ...current,
        [fullName]: manifest.modules?.filter((module) => module.defaultSelected).map((module) => module.id) ?? []
      }));
    }
  };

  const installShowcaseTile = async (fullName: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let preview = showcasePreviews[fullName];
      if (!preview) {
        const result = showcase?.find((item) => item.fullName === fullName);
        if (!result) throw new Error("Plugin showcase entry disappeared.");
        // Full preview (with install token) is only fetched at install time.
        preview = await onPreviewPlugin(result.url);
        setShowcasePreviews((current) => ({ ...current, [fullName]: preview }));
      }
      await onInstallPlugin(preview.token, showcaseModules[fullName] ?? []);
      setShowcaseManifests((current) => {
        const next = { ...current };
        delete next[fullName];
        return next;
      });
      setSelectedShowcase((current) => (current === fullName ? null : current));
      setShowcase((current) => current?.filter((result) => result.fullName !== fullName) ?? null);
    } catch (reason) {
      setError(errorMessage(reason, t(locale, "pluginInstallFailed")));
    } finally {
      // The install token is single-use, consumed by the main process before any work, so the cached
      // preview is dead on failure too; keeping it would replay an expired token on every retry.
      setShowcasePreviews((current) => {
        const next = { ...current };
        delete next[fullName];
        return next;
      });
      setBusy(false);
    }
  };

  const runCheckUpdates = async (): Promise<void> => {
    if (checkingUpdates) return;
    setCheckingUpdates(true);
    setError(null);
    try {
      setUpdates(await onCheckPluginUpdates());
    } catch (reason) {
      setError(errorMessage(reason, t(locale, "pluginUpdateCheckFailed")));
    } finally {
      setCheckingUpdates(false);
    }
  };

  const runUpdate = async (pluginId: string): Promise<void> => {
    if (updatingId) return;
    setUpdatingId(pluginId);
    setError(null);
    try {
      await onUpdatePlugin(pluginId);
      setUpdates((current) => current?.filter((update) => update.pluginId !== pluginId) ?? null);
    } catch (reason) {
      setError(errorMessage(reason, t(locale, "pluginUpdateFailed")));
    } finally {
      setUpdatingId(null);
    }
  };

  const runPluginAction = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason, t(locale, "pluginActionFailed")));
    } finally {
      setBusy(false);
    }
  };

  const renderHostTag = (minHostVersion: string | undefined): React.JSX.Element | null => {
    if (!minHostVersion) return null;
    const hostMatch = compareSemver(minHostVersion, hostVersion);
    const hostClass = hostMatch > 0 ? "plugin-showcase-tile__host--newer"
      : hostMatch < 0 ? "plugin-showcase-tile__host--older"
      : "";
    return (
      <span className={`plugin-showcase-tile__host ${hostClass}`}>
        CanvasTTY:{minHostVersion}
      </span>
    );
  };

  /** Host version in installed plugins — its own line, no leading dot. */
  const renderInstalledHostTag = (minHostVersion: string | undefined): React.JSX.Element | null => {
    if (!minHostVersion) return null;
    const hostMatch = compareSemver(minHostVersion, hostVersion);
    const hostClass = hostMatch > 0 ? "plugin-showcase-tile__host--newer"
      : hostMatch < 0 ? "plugin-showcase-tile__host--older"
      : "";
    return (
      <span className={`installed-plugin__host ${hostClass}`}>
        CanvasTTY:{minHostVersion}
      </span>
    );
  };

  const renderShowcaseTile = (result: GithubPluginSearchResult): React.JSX.Element => {
    const key = result.fullName;
    const manifest = showcaseManifests[key];
    const selected = selectedShowcase === key;
    const hostMatch = result.minHostVersion ? compareSemver(result.minHostVersion, hostVersion) : 0;
    // Older minimums are satisfied by the current host. Only a plugin that
    // requires a newer host is visually marked as incompatible.
    const hostMismatch = Boolean(result.minHostVersion && hostMatch > 0);
    return (
      <article
        className={`plugin-showcase-tile ${selected ? "plugin-showcase-tile--selected" : ""} ${hostMismatch ? "plugin-showcase-tile--host-mismatch" : ""}`}
        key={key}
      >
        <button
          className="plugin-showcase-tile__head"
          type="button"
          disabled={busy}
          onClick={() => selectShowcaseTile(key)}
        >
          <PluginShowcaseIcon
            fullName={result.fullName}
            icon={showcaseIcons[key]}
          />
          <span className="plugin-showcase-tile__title">
            <strong>{manifest ? manifest.name : showcaseName(result.fullName)}</strong>
            <small className="plugin-showcase-tile__author">{showcaseAuthor(result.fullName)}</small>
            {renderHostTag(result.minHostVersion)}
          </span>
        </button>
      </article>
    );
  };

  const renderShowcaseDetail = (): React.JSX.Element => {
    if (!selectedShowcase) {
      return <p className="plugin-settings__empty plugin-showcase-detail__empty">{t(locale, "showcaseEmpty")}</p>;
    }
    const result = showcase?.find((item) => item.fullName === selectedShowcase);
    const manifest = showcaseManifests[selectedShowcase];
    const modules = showcaseModules[selectedShowcase] ?? [];
    if (!result) return <p className="plugin-settings__empty">{t(locale, "noSearchResults")}</p>;
    return (
      <article className="plugin-showcase-detail">
        <header className="plugin-showcase-detail__header">
          <PluginShowcaseIcon
            fullName={result.fullName}
            icon={showcaseIcons[selectedShowcase]}
          />
          <span className="plugin-showcase-tile__title">
            <strong>{manifest ? manifest.name : showcaseName(result.fullName)}</strong>
            <small className="plugin-showcase-tile__author">{showcaseAuthor(result.fullName)}</small>
          </span>
        </header>
        <div className="plugin-showcase-detail__body">
          {manifest ? (
            <>
              <div className="plugin-showcase-tile__manifest">
                <small>{t(locale, "pluginVersion")} v{manifest.version}</small>
                <small className="plugin-showcase-tile__repo">{result.fullName}</small>
              </div>
              {renderInstalledHostTag(manifest.minHostVersion)}
              <p className="plugin-showcase-tile__description">{manifestDescription(manifest, locale)}</p>
              <PermissionList permissions={manifest.permissions} locale={locale} />
              <HookManifestWarning manifest={manifest} locale={locale} />
              <ModuleList
                modules={manifest.modules ?? []}
                selected={modules}
                disabled={busy}
                locale={locale}
                onChange={(next) => setShowcaseModules((current) => ({ ...current, [selectedShowcase]: next }))}
              />
              <div className="plugin-showcase-tile__actions">
                <button
                  className="plugin-primary-action plugin-icon-btn"
                  type="button"
                  title={t(locale, "showcaseOpenCanvas")}
                  aria-label={t(locale, "showcaseOpenCanvas")}
                  onClick={() => void onOpenBrowser(result.url)}
                >
                  <UiIcon name="terminal" size={22} />
                </button>
                <button
                  className="plugin-icon-btn"
                  type="button"
                  title={t(locale, "showcaseOpenBrowser")}
                  aria-label={t(locale, "showcaseOpenBrowser")}
                  onClick={() => void window.canvasTTY.githubAuth.openUrl(result.url)}
                >
                  <UiIcon name="browser" size={22} />
                </button>
                <button
                  className="plugin-primary-action plugin-install-btn"
                  type="button"
                  disabled={busy}
                  onClick={() => void installShowcaseTile(selectedShowcase)}
                >{t(locale, "install")}</button>
              </div>
            </>
          ) : (
            <p className="plugin-settings__empty">{t(locale, "searching")}</p>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="plugin-settings">
      <section className="setting-group">
        <h3>{t(locale, "installPlugin")}</h3>
        <div className="plugin-install-row">
          <input
            value={sourceUrl}
            type="url"
            spellCheck={false}
            placeholder="https://github.com/owner/repository"
            aria-label={t(locale, "githubUrl")}
            onChange={(event) => {
              setSourceUrl(event.target.value);
              setPreview(null);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void inspect();
            }}
          />
          <button type="button" disabled={busy || sourceUrl.trim().length === 0} onClick={() => void inspect()}>
            {t(locale, "inspectPlugin")}
          </button>
        </div>
        {preview && (
          <article className="plugin-preview">
            <header>
              <PluginIcon pluginId={preview.manifest.id} icon={preview.manifest.icon} name={preview.manifest.name} />
              <span><strong>{preview.manifest.name}</strong><small>v{preview.manifest.version}</small></span>
            </header>
            <p>{manifestDescription(preview.manifest, locale)}</p>
            <PermissionList permissions={preview.manifest.permissions} locale={locale} />
            <HookManifestWarning manifest={preview.manifest} locale={locale} showEntries />
            <ModuleList
              modules={preview.manifest.modules ?? []}
              selected={selectedModules}
              disabled={busy}
              locale={locale}
              onChange={setSelectedModules}
            />
            <div className="plugin-preview__actions">
              <button type="button" onClick={() => setPreview(null)}>{t(locale, "cancel")}</button>
              <button className="plugin-primary-action" type="button" disabled={busy} onClick={() => void install()}>{t(locale, "install")}</button>
            </div>
          </article>
        )}
        {error && <p className="plugin-settings__error" role="alert">{error}</p>}
      </section>

      <section className="setting-group plugin-installed-section">
        <h3>
          {t(locale, "installedPlugins")}
          <button
            className="plugin-updates-check"
            type="button"
            disabled={checkingUpdates}
            onClick={() => void runCheckUpdates()}
          >{checkingUpdates ? t(locale, "checkingUpdates") : t(locale, "checkUpdates")}</button>
        </h3>
        {plugins.length === 0 ? <p className="plugin-settings__empty">{t(locale, "noPlugins")}</p> : (
          <>
          <div className="installed-plugin-list">
            {paginate(plugins, installedPage, INSTALLED_PAGE_SIZE).map((plugin) => {
              const update = updates?.find((item) => item.pluginId === plugin.manifest.id) ?? null;
              const expanded = Boolean(expandedInstalled[plugin.manifest.id]);
              const remoteIcon = installedIcons[plugin.manifest.id];
              return (
              <article className={`installed-plugin ${plugin.enabled ? "" : "installed-plugin--disabled"} ${expanded ? "installed-plugin--expanded" : ""}`} key={plugin.manifest.id}>
                <header className="installed-plugin__header" onClick={() => setExpandedInstalled((current) => ({ ...current, [plugin.manifest.id]: !current[plugin.manifest.id] }))}>
                  <span className="installed-plugin__title">
                    <PluginIcon pluginId={plugin.manifest.id} icon={plugin.manifest.icon} name={plugin.manifest.name} remoteIcon={remoteIcon} />
                    <span className="installed-plugin__version">
                      <strong>{plugin.manifest.name}</strong>
                      <small>
                        v{plugin.manifest.version}
                        {update && (
                          <>
                            <span className="installed-plugin__version-arrow" aria-hidden="true">→</span>
                            <span className="installed-plugin__version-new">v{update.latestVersion}</span>
                          </>
                        )}
                      </small>
                      {renderInstalledHostTag(plugin.manifest.minHostVersion)}
                    </span>
                  </span>
                  <div onClick={(event) => event.stopPropagation()}>
                    {update && (
                      <button
                        className="plugin-primary-action installed-plugin__update"
                        type="button"
                        disabled={updatingId !== null}
                        onClick={() => void runUpdate(plugin.manifest.id)}
                      >{updatingId === plugin.manifest.id ? t(locale, "updating") : t(locale, "update")}</button>
                    )}
                    {settingsContribution(plugin) && (
                      <button
                        className="plugin-primary-action"
                        type="button"
                        disabled={busy || !plugin.enabled}
                        onClick={() => void runPluginAction(() => onOpenPluginContribution(
                          plugin,
                          settingsContribution(plugin)!
                        ))}
                      >{t(locale, "settings")}</button>
                    )}
                    <button
                      type="button"
                      className={plugin.enabled ? "" : "installed-plugin__enable"}
                      disabled={busy}
                      onClick={() => void runPluginAction(() => onSetPluginEnabled(plugin.manifest.id, !plugin.enabled))}
                    >{plugin.enabled ? t(locale, "disable") : t(locale, "enable")}</button>
                    <button
                      className="installed-plugin__remove"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (confirmUninstall !== plugin.manifest.id) {
                          setConfirmUninstall(plugin.manifest.id);
                          return;
                        }
                        setConfirmUninstall(null);
                        setInstalledIcons((current) => {
                          const next = { ...current };
                          delete next[plugin.manifest.id];
                          return next;
                        });
                        void runPluginAction(() => onUninstallPlugin(plugin.manifest.id));
                      }}
                    >{confirmUninstall === plugin.manifest.id ? t(locale, "uninstallConfirm") : t(locale, "uninstall")}</button>
                  </div>
                </header>
                <div className="installed-plugin__body">
                  <div className="installed-plugin__details">
                    {plugin.manifest.author && (
                      <div className="installed-plugin__author-row">
                        <span className="installed-plugin__author">
                          {t(locale, "pluginAuthor")}: {plugin.manifest.author}
                        </span>
                        <span className="installed-plugin__repo-actions">
                          <button
                            className="plugin-primary-action plugin-icon-btn"
                            type="button"
                            title={t(locale, "showcaseOpenCanvas")}
                            aria-label={t(locale, "showcaseOpenCanvas")}
                            onClick={() => void onOpenBrowser(plugin.sourceUrl)}
                          >
                            <UiIcon name="terminal" size={18} />
                          </button>
                          <button
                            className="plugin-icon-btn"
                            type="button"
                            title={t(locale, "showcaseOpenBrowser")}
                            aria-label={t(locale, "showcaseOpenBrowser")}
                            onClick={() => void window.canvasTTY.githubAuth.openUrl(plugin.sourceUrl)}
                          >
                            <UiIcon name="browser" size={18} />
                          </button>
                        </span>
                      </div>
                    )}
                    <p>{manifestDescription(plugin.manifest, locale)}</p>
                    <PermissionList permissions={plugin.manifest.permissions} locale={locale} />
                    <HookManifestWarning manifest={plugin.manifest} locale={locale} showEntries />
                    <ModuleList
                      modules={plugin.manifest.modules ?? []}
                      selected={plugin.selectedModules}
                      disabled={busy}
                      locale={locale}
                      onChange={(modules) => void runPluginAction(() => onSetPluginModules(plugin.manifest.id, modules))}
                    />
                    <div className="plugin-contribution-list">
                      {plugin.manifest.contributions.map((contribution) => (
                        <div className="plugin-contribution" key={contribution.id}>
                          <span>
                            <strong>{contribution.title}</strong>
                            <small>{t(locale, contributionKindKey(contribution.kind))}</small>
                          </span>
                          {contribution.kind !== "home-widget" && (
                            <button
                              type="button"
                              disabled={busy || !plugin.enabled}
                              onClick={() => void runPluginAction(() => onOpenPluginContribution(plugin, contribution))}
                            >{t(locale, "open")}</button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
              );
            })}
          </div>
          {installedPageCount > 1 && (
            <div className="plugin-pagination" role="navigation" aria-label={t(locale, "paginationPage")} ref={installedPaginationRef}>
              <button type="button" disabled={installedPage <= 0} onClick={() => startInstalledPageChange(installedPage - 1)} aria-label="‹">‹</button>
              <span>{t(locale, "paginationPage")} {installedPage + 1} / {installedPageCount}</span>
              <button type="button" disabled={installedPage >= installedPageCount - 1} onClick={() => startInstalledPageChange(installedPage + 1)} aria-label="›">›</button>
            </div>
          )}
          </>
        )}
      </section>

      <section className="setting-group plugin-github-group">
        <h3>
          {t(locale, "githubAuthTitle")}
          {githubConfigured && !githubStatus?.authorized && !githubCode && (
            <span className="plugin-github-signin-actions">
              <button type="button" className="plugin-updates-check plugin-github-signin" disabled={githubBusy} onClick={() => void runGithubSignIn("embedded")}>
                {t(locale, "githubAuthSignInCanvas")}
              </button>
              <button type="button" className="plugin-updates-check plugin-github-signin-secondary" disabled={githubBusy} onClick={() => void runGithubSignIn("external")}>
                {t(locale, "githubAuthSignInExternal")}
              </button>
            </span>
          )}
        </h3>
        {githubStatus?.authorized ? (
          <div>
            <div className="plugin-github-row">
              <span className="plugin-github-status">
                <span className="plugin-github-dot" aria-hidden="true" />
                {t(locale, "githubAuthSignedIn")} <strong>@{githubStatus.login}</strong>
              </span>
              <button type="button" className="plugin-github-signout" disabled={githubBusy} onClick={() => void runGithubSignOut()}>
                {t(locale, "githubAuthSignOut")}
              </button>
            </div>
            <p className="plugin-github-revoke">
              {t(locale, "githubAuthRevokeHint")} {" "}
              <a
                href="https://github.com/settings/applications"
                onClick={(event) => {
                  event.preventDefault();
                  void window.canvasTTY.githubAuth.openUrl("https://github.com/settings/applications");
                }}
              >{t(locale, "githubAuthRevokeLink")}</a>
            </p>
          </div>
        ) : githubCode ? (
          <div className="plugin-github-flow">
            <p
              className="plugin-github-code"
              role="button"
              tabIndex={0}
              title={t(locale, "githubAuthCopyHint")}
              onClick={() => copyGithubCode(githubCode.userCode)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  copyGithubCode(githubCode.userCode);
                }
              }}
            >
              {t(locale, "githubAuthCode")}: <strong>{githubCode.userCode}</strong>
              {codeCopied && <span className="plugin-github-copied">{t(locale, "githubAuthCopied")}</span>}
            </p>
            <div className="plugin-github-flow-actions">
              <button type="button" disabled={githubBusy} onClick={() => void openGithubAuthorization(githubCode, "embedded")}>
                {t(locale, "githubAuthOpenCanvas")}
              </button>
              <button type="button" disabled={githubBusy} onClick={() => void openGithubAuthorization(githubCode, "external")}>
                {t(locale, "githubAuthOpenExternal")}
              </button>
            </div>
          </div>
        ) : githubStatus && !githubConfigured ? (
          <p className="plugin-github-unavailable" role="status">{t(locale, "githubAuthNotConfigured")}</p>
        ) : null}
      </section>

      <div className="plugin-showcase-wrap">
        <section className={`setting-group plugin-showcase-group${githubAuthorized ? "" : " plugin-showcase-group--off"}`}>
          <h3>
            {t(locale, "pluginShowcase")}
            <button
              className="plugin-showcase-refresh"
              type="button"
              disabled={loadingShowcase || searching}
              onClick={() => void runShowcase()}
            >{loadingShowcase ? t(locale, "searching") : t(locale, "openShowcase")}</button>
          </h3>
          <div className="plugin-install-row plugin-showcase-search">
          <input
            value={searchQuery}
            type="text"
            spellCheck={false}
            placeholder={t(locale, "searchPluginsPlaceholder")}
            aria-label={t(locale, "searchPlugins")}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchResults(null);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch();
            }}
          />
          <button type="button" disabled={searching || searchQuery.trim().length === 0} onClick={() => void runSearch()}>
            {searching ? t(locale, "searching") : t(locale, "search")}
          </button>
        </div>
        {(showcase !== null || searchResults !== null) && (
          <div className="plugin-showcase-layout">
            {(searchResults ?? showcase)!.length === 0 ? (
              <p className="plugin-settings__empty">{t(locale, "noSearchResults")}</p>
            ) : (
              <>
                <div className="plugin-showcase-list">
                  {paginate(searchResults ?? showcase ?? [], showcasePage, SHOWCASE_PAGE_SIZE).map((result) => renderShowcaseTile(result))}
                </div>
                <div className="plugin-showcase-panel">
                  {renderShowcaseDetail()}
                </div>
              </>
            )}
            {showcasePageCount > 1 && (
              <div className="plugin-pagination plugin-pagination--showcase" role="navigation" aria-label={t(locale, "paginationPage")} ref={showcasePaginationRef}>
                <button type="button" disabled={showcasePage <= 0} onClick={() => startShowcasePageChange(showcasePage - 1)} aria-label="‹">‹</button>
                <span>{t(locale, "paginationPage")} {showcasePage + 1} / {showcasePageCount}</span>
                <button type="button" disabled={showcasePage >= showcasePageCount - 1} onClick={() => startShowcasePageChange(showcasePage + 1)} aria-label="›">›</button>
              </div>
            )}
          </div>
        )}
        </section>
        {!githubAuthorized && (
          <div className="plugin-showcase-lock">
            <span>{t(locale, "showcaseRequiresGithub")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PluginIcon({ pluginId, icon, name, remoteIcon }: { pluginId: string; icon?: string; name: string; remoteIcon?: string | null }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const path = icon || "icon.png";
  const placeholder = <span className="plugin-icon plugin-icon--fallback" aria-label={name}>{name.slice(0, 2).toUpperCase()}</span>;
  // Repository icon (identical to the showcase) has priority; reset the local
  // failure state once it arrives so the icon can swap in after load.
  if (remoteIcon) {
    return (
      <img
        className="plugin-icon"
        src={remoteIcon}
        alt={name}
        onError={() => setFailed(true)}
      />
    );
  }
  if (failed) return placeholder;
  return (
    <img
      className="plugin-icon"
      src={`canvastty-plugin://${pluginId}/${encodeURIComponent(path)}`}
      alt={name}
      onError={() => setFailed(true)}
    />
  );
}

function showcaseName(fullName: string): string {
  const parts = fullName.split("/");
  const repo = parts.length === 2 ? parts[1] : fullName;
  return repo.replace(/^canvastty-plugin-/i, "");
}

function showcaseAuthor(fullName: string): string {
  const parts = fullName.split("/");
  return parts.length === 2 ? parts[0] : "";
}

function PluginShowcaseIcon({
  fullName,
  icon
}: {
  fullName: string;
  icon: string | null | undefined;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const name = showcaseName(fullName);
  const placeholder = <span className="plugin-showcase-tile__avatar plugin-showcase-tile__avatar--fallback">{name.slice(0, 1).toUpperCase()}</span>;
  if (failed || !icon) return placeholder;
  return (
    <img
      className="plugin-showcase-tile__avatar"
      src={icon}
      alt={name}
      onError={() => setFailed(true)}
    />
  );
}

function manifestDescription(manifest: PluginManifest, locale: LocaleId): string {
  const localized = locale === "ru"
    ? manifest["description.ru"]
    : locale === "en"
      ? manifest["description.en"]
      : undefined;
  const description = localized || manifest.description;
  // Descriptions longer than the limit are truncated when displayed.
  return description.length > MAX_DESCRIPTION_LENGTH
    ? `${description.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : description;
}

function PermissionList({ permissions, locale }: { permissions: PluginPermission[]; locale: LocaleId }): React.JSX.Element {
  return (
    <div className="plugin-permissions">
      <strong>{t(locale, "pluginPermissions")}</strong>
      {permissions.length === 0
        ? <span>{t(locale, "pluginNoPermissions")}</span>
        : <ul>{permissions.map((permission) => <li key={permission}>{t(locale, permissionKey(permission))}</li>)}</ul>}
    </div>
  );
}

function HookManifestWarning({
  manifest,
  locale,
  showEntries = false
}: {
  manifest: PluginManifest;
  locale: LocaleId;
  showEntries?: boolean;
}): React.JSX.Element | null {
  if (!manifest.hooks?.length) return null;
  return (
    <div className="plugin-hook-warning" role="note">
      <strong>{t(locale, "pluginHooksIncluded")} · {manifest.hooks.length}</strong>
      <span>{t(locale, "pluginHooksInstallWarning")}</span>
      {showEntries && (
        <ul>
          {manifest.hooks.map((hook) => (
            <li key={hook.id}>
              <strong>{hook.title}</strong>
              <code>{hook.entry}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function permissionKey(permission: PluginPermission): TranslationKey {
  return ({
    storage: "permissionStorage",
    secrets: "permissionSecrets",
    "sessions:read": "permissionSessionsRead",
    "limits:read": "permissionLimitsRead",
    "launcher:open": "permissionLauncherOpen",
    "external:open": "permissionExternalOpen",
    "browser:open": "permissionBrowserOpen",
    "media:library": "permissionMediaLibrary",
    "playlists:read": "permissionPlaylistsRead",
    "playlists:write": "permissionPlaylistsWrite",
    "hermes:hud": "permissionHermesHud",
    network: "permissionNetwork"
  } as const)[permission];
}

function ModuleList({
  modules,
  selected,
  disabled,
  locale,
  onChange
}: {
  modules: PluginModule[];
  selected: string[];
  disabled: boolean;
  locale: LocaleId;
  onChange(value: string[]): void;
}): React.JSX.Element | null {
  if (modules.length === 0) return null;
  return (
    <fieldset className="plugin-modules">
      <legend>{locale === "ru" ? "Необязательные модули" : "Optional modules"}</legend>
      {modules.map((module) => (
        <label key={module.id}>
          <input
            type="checkbox"
            checked={selected.includes(module.id)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked
              ? [...selected, module.id]
              : selected.filter((id) => id !== module.id))}
          />
          <span>
            <strong>{module.title}</strong>
            {module.description && <small>{module.description}</small>}
            {module.permissions.length > 0 && (
              <small>{module.permissions.map((permission) => t(locale, permissionKey(permission))).join(" · ")}</small>
            )}
            <small>{formatBytes(module.files.reduce((total, file) => total + file.bytes, 0))}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1_024 * 1_024
    ? `${Math.max(1, Math.round(bytes / 1_024))} KB`
    : `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function settingsContribution(plugin: InstalledPlugin): PluginContribution | null {
  const id = plugin.manifest.settingsContribution;
  if (!id) return null;
  return plugin.manifest.contributions.find((contribution) => (
    contribution.id === id && contribution.kind === "canvas-app"
  )) ?? null;
}

function contributionKindKey(kind: PluginContribution["kind"]): TranslationKey {
  return kind === "home-widget"
    ? "contributionHomeWidget"
    : kind === "canvas-app"
      ? "contributionCanvasApp"
      : "contributionWindow";
}

function errorMessage(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 320);
}
