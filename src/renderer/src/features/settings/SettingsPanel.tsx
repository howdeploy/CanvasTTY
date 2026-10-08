import { ExecutionTargetSettings } from "./ExecutionTargetSettings";
import { EvenG2Controls } from "./EvenG2Controls";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AppSettings,
  AppSkinId,
  AgentCliAvailability,
  AgentProviderId,
  DefaultLaunchProfile,
  BrowserActivityEvent,
  BrowserCommandType,
  BrowserDownloadSnapshot,
  BrowserSnapshot,
  CanvasLauncherItemId,
  CanvasColorId,
  CanvasBackgroundId,
  CanvasOverlayPlacement,
  CanvasPatternId,
  CanvasWheelCaptureMode,
  CustomTerminalBorderSkinId,
  EdgePanSpeed,
  FocusActivation,
  GithubPluginSearchResult,
  HomeAccentColors,
  HomeAccentPresetId,
  InstalledPlugin,
  LimitProviderId,
  LocaleId,
  KeyboardPreset,
  MaterialStorageUsage,
  MinimapInteractionMode,
  PaletteId,
  PluginContribution,
  PluginGridSize,
  PluginManifest,
  PluginInstallPreview,
  PluginUpdateStatus,
  PixelSkinPackSummary,
  PixelSkinPreferredDetail,
  PixelSkinSlot,
  PixelTerminalBorderSkinId,
  RadialLauncherItemId,
  SessionRestoreMode,
  SessionRowColorMode,
  SessionStatus,
  ShortcutAction,
  TerminalBorderSkinListItem,
  TerminalLinkOpenMode,
  TerminalBorderSkinId,
  ZoomSensitivity
} from "../../../../shared/contracts";
import {
  BROWSER_PROVIDER_COLORS,
  keyboardPresetShortcuts,
  shortcutsShareContext,
  BUNDLED_CANVAS_BACKGROUND_IDS,
  CANVAS_LAUNCHER_ITEMS,
  DEFAULT_CANVAS_LAUNCHER_ITEMS,
  DEFAULT_RADIAL_LAUNCHER_ITEMS,
  RADIAL_LAUNCHER_ITEMS,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP
} from "../../../../shared/contracts";
import {
  canvasOverrideBindingConflicts,
  defaultCanvasWheelBinding
} from "../../../../shared/canvasNavigation";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon, type UiIconName } from "../../components/UiIcon";
import {
  CanvasMenuDivider,
  CanvasMenuLabel,
  CanvasMenuRow
} from "../../components/CanvasMenuPrimitives";
import {
  AGENT_PROVIDERS,
  LIMIT_PROVIDERS,
  PROVIDERS,
  resolveHomeLimitProviders,
  resolveHomeLauncherProviders,
  setHomeLimitProviderEnabled,
  setHomeLauncherProviderEnabled
} from "../../lib/providers";
import { shortcutFromKeyboardEvent, shortcutFromPointerEvent } from "../../lib/shortcuts";
import { t, type TranslationKey } from "../../lib/i18n";
import { formatBytes } from "../materials/materialCardModel";
import {
  createTerminalBorderSkinPreviewStyleController,
  isCustomTerminalBorderSkinId,
  normalizeTerminalBorderSkinList
} from "../../lib/skinStyles";
import { PluginSettingsSection } from "../plugins/PluginSettingsSection";
import { HomeAppearanceSettings } from "../home/HomeAppearanceSettings";
import {
  canvasColorPatch,
  homeAccentPresetPatch,
  resolveAppearanceSettings
} from "./appearanceSettings";
import { CanvasNavigationShortcutEditor } from "./CanvasNavigationShortcutEditor";
import { AgentHooksSettings } from "./AgentHooksSettings";
import { PluginServicesSettings } from "./PluginServicesSettings";
import { ProviderSecretsSettings } from "./ProviderSecretsSettings";
import { ApiProfilesSettings } from "./ApiProfilesSettings";
import { AboutSettings } from "./AboutSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import { setCanvasLauncherItemEnabled } from "../launcher/canvasLauncher";
import { itemLabel } from "../launcher/QuickRadialMenu";
import { setRadialLauncherItemEnabled } from "../launcher/radialLauncher";
import { Canvas2DSkinView } from "../skins/Canvas2DSkinView";
import { isPixelSkinPackId, PILOT_SKIN_ASSETS } from "../skins/SkinAssets";
import { isPixelSkinThemeId, pixelSkinAssetFilename } from "../skins/skinCatalog";
import type { PixelSkinThemeId } from "../skins/skinCatalog";
import type { SkinDetailLevel } from "../skins/SkinLayout";
import { PixelSkinPackCreator } from "./PixelSkinPackCreator";
import {
  availableProfiles,
  isDefaultLaunchProfile,
  isolationAvailable,
  resolveDefaultLaunchProfile
} from "../../../../shared/autoMode";

type SettingsSection = "general" | "keyboardShortcuts" | "appearance" | "agents" | "controls" | "externalIntegrations" | "browser" | "plugins" | "updates" | "about";

const SHORTCUT_LABELS = {
  home: "homeShortcut", renameWindow: "renameWindow", toggleFullscreen: "toggleFullscreen",
  commandPalette: "keyboardPalette", openSettings: "settings", toggleDetail: "keyboardDetail",
  focusUp: "keyboardFocusUp", focusDown: "keyboardFocusDown", focusLeft: "keyboardFocusLeft", focusRight: "keyboardFocusRight",
  terminalCopy: "shortcutCopySelection", terminalPaste: "shortcutPaste", terminalSearch: "terminalSearch",
  terminalRestart: "shortcutRestartExited", terminalPageUp: "keyboardPageUp", terminalPageDown: "keyboardPageDown",
  codexSubmit: "keyboardSubmit", codexSubmitAlternate: "keyboardSubmitAlternate", codexSubmitSuper: "keyboardSubmitSuper",
  codexNewline: "shortcutLineBreak", codexSelectAll: "keyboardSelectAll"
} as const;

const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  icon: UiIconName;
}> = [
  { id: "general", icon: "app-window" },
  { id: "keyboardShortcuts", icon: "sliders-horizontal" },
  { id: "appearance", icon: "palette" },
  { id: "agents", icon: "terminal" },
  { id: "controls", icon: "sliders-horizontal" },
  { id: "externalIntegrations", icon: "blocks" },
  { id: "browser", icon: "browser" },
  { id: "plugins", icon: "blocks" },
  { id: "updates", icon: "download" },
  { id: "about", icon: "info" }
];

const CLASSIC_HOME_PREVIEW = ["#B8CF99", "#D8E1C5", "#9CC7DC", "#D5A2C9"];

const CANVAS_COLOR_PREVIEWS: Record<CanvasColorId, string> = {
  sage: "#AAA7A2",
  lilac: "#B8ADB9",
  night: "#222632",
  sand: "#B9AD96",
  mist: "#A9B9BD",
  rose: "#B9A6AD",
  slate: "#262B36"
};

const DEFAULT_PROFILE_LABELS: Record<DefaultLaunchProfile, TranslationKey> = {
  auto: "autoProfile",
  acceptEdits: "acceptEditsProfile",
  normal: "manualProfile",
  plan: "planProfile"
};

interface SettingsPanelProps {
  open: boolean;
  openUpdatesRequest: number;
  settings: AppSettings;
  agentAvailability: AgentCliAvailability | null;
  onRecheckAgentClis(): Promise<void>;
  plugins: InstalledPlugin[];
  browser: BrowserSnapshot;
  materialStorage: MaterialStorageUsage | null;
  onClose(): void;
  onChange(patch: Partial<AppSettings>): Promise<void>;
  onPreviewPlugin(sourceUrl: string): Promise<PluginInstallPreview>;
  onInstallPlugin(token: string, selectedModules: string[]): Promise<void>;
  onSearchPlugins(query: string): Promise<GithubPluginSearchResult[]>;
  onShowcasePlugins(): Promise<GithubPluginSearchResult[]>;
  onFetchPluginIcons(sourceUrls: string[]): Promise<Record<string, string | null>>;
  onPreviewManifests(sourceUrls: string[]): Promise<Record<string, PluginManifest>>;
  onCheckPluginUpdates(): Promise<PluginUpdateStatus[]>;
  onUpdatePlugin(pluginId: string): Promise<void>;
  onSetPluginModules(pluginId: string, selectedModules: string[]): Promise<void>;
  onSetPluginEnabled(pluginId: string, enabled: boolean): Promise<void>;
  onSetPluginHookEnabled(pluginId: string, hookId: string, enabled: boolean): Promise<void>;
  onSetPluginNativeCodeTrusted(pluginId: string, trusted: boolean): Promise<void>;
  onSetPluginDecisionsMayAllow(pluginId: string, allowed: boolean): Promise<void>;
  onUninstallPlugin(pluginId: string): Promise<void>;
  onOpenPluginContribution(plugin: InstalledPlugin, contribution: PluginContribution): Promise<void>;
  onToggleHomeWidget(widgetId: string, size: PluginGridSize): Promise<void>;
  onEditHome(): void;
  onOpenBrowser(url?: string): Promise<void>;
}

export function SettingsPanel({
  open,
  openUpdatesRequest,
  settings,
  agentAvailability,
  onRecheckAgentClis,
  plugins,
  browser,
  materialStorage,
  onClose,
  onChange,
  onPreviewPlugin,
  onInstallPlugin,
  onSearchPlugins,
  onShowcasePlugins,
  onFetchPluginIcons,
  onPreviewManifests,
  onCheckPluginUpdates,
  onUpdatePlugin,
  onSetPluginModules,
  onSetPluginEnabled,
  onSetPluginHookEnabled,
  onSetPluginNativeCodeTrusted,
  onSetPluginDecisionsMayAllow,
  onUninstallPlugin,
  onOpenPluginContribution,
  onToggleHomeWidget,
  onEditHome,
  onOpenBrowser,
}: SettingsPanelProps): React.JSX.Element {
  const locale = settings.locale;
  const appearance = resolveAppearanceSettings(settings);
  const homeLauncherProviders = resolveHomeLauncherProviders(settings);
  const homeLimitProviders = resolveHomeLimitProviders(settings);
  const containmentAvailable = isolationAvailable(settings, window.canvasTTY?.window?.platform ?? "");
  const [section, setSection] = useState<SettingsSection>("general");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openUpdatesRequest > 0) setSection("updates");
  }, [openUpdatesRequest]);
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [activity, setActivity] = useState<BrowserActivityEvent[]>([]);
  const [activityState, setActivityState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearingBrowserData, setClearingBrowserData] = useState(false);
  const [browserDataMessage, setBrowserDataMessage] = useState<string | null>(null);
  const [pixelPacks, setPixelPacks] = useState<PixelSkinPackSummary[]>([]);
  const [pixelPacksState, setPixelPacksState] = useState<"loading" | "ready" | "error">("loading");
  const [defaultProfilesBusy, setDefaultProfilesBusy] = useState(false);
  const defaultProfilesBusyRef = useRef(false);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = async (): Promise<void> => {
      const request = ++revision;
      try {
        const packs = await window.canvasTTY.pixelSkins.list();
        if (!active || request !== revision) return;
        setPixelPacks(packs);
        setPixelPacksState("ready");
      } catch {
        if (active && request === revision) setPixelPacksState("error");
      }
    };
    const unsubscribe = window.canvasTTY.pixelSkins.onChanged(() => void refresh());
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, []);

  const [checkingAgentClis, setCheckingAgentClis] = useState(false);
  const [agentCliError, setAgentCliError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (open && contentRef.current) contentRef.current.scrollTop = 0;
  }, [open, section]);

  const openAgentInstall = (provider: AgentProviderId): void => {
    const url = PROVIDERS[provider].installUrl;
    if (!url) return;
    void window.canvasTTY.external.openUrl(url).catch(() => setAgentCliError(t(locale, "agentInstallLinkFailed")));
  };

  const recheckAgentClis = async (): Promise<void> => {
    setCheckingAgentClis(true);
    setAgentCliError(null);
    try {
      await onRecheckAgentClis();
    } catch {
      setAgentCliError(t(locale, "agentCliRecheckFailed"));
    } finally {
      setCheckingAgentClis(false);
    }
  };

  const missingAgentRow = (provider: AgentProviderId, label = PROVIDERS[provider].label): React.JSX.Element => (
    <div className="agent-launcher-settings__row" key={provider}>
      <span className="agent-launcher-settings__identity">
        <ProviderIcon provider={provider} size="small" />
        <strong>{label}</strong>
        <small>{t(locale, "limitCliNotFound")}</small>
      </span>
      <button className="setting-inline-action" type="button" onClick={() => openAgentInstall(provider)}>
        {t(locale, "install")}
      </button>
    </div>
  );

  useEffect(() => {
    if (!open) {
      setCapturing(null);
      setShortcutError(null);
      setClearConfirm(false);
      setBrowserDataMessage(null);
    }
  }, [open]);

  useEffect(() => {
    if (section === "controls") return;
    setShortcutError(null);
    setCapturing(null);
  }, [section]);

  useEffect(() => {
    if (!open || section !== "browser") return;
    let active = true;
    setActivityState("loading");
    void window.canvasTTY.browser.getActivity()
      .then((events) => {
        if (!active) return;
        setActivity(events.slice(-40));
        setActivityState("ready");
      })
      .catch(() => {
        if (active) setActivityState("error");
      });
    const unsubscribe = window.canvasTTY.browser.onActivity(({ event }) => {
      if (!active) return;
      setActivity((current) => [...current.filter((candidate) => candidate.sequence !== event.sequence), event].slice(-40));
      setActivityState("ready");
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [open, section]);

  const clearBrowserData = async (): Promise<void> => {
    if (!clearConfirm) {
      setClearConfirm(true);
      setBrowserDataMessage(null);
      return;
    }
    setClearingBrowserData(true);
    try {
      await window.canvasTTY.browser.clearData();
      setBrowserDataMessage(t(locale, "browserDataCleared"));
      setClearConfirm(false);
    } catch {
      setBrowserDataMessage(t(locale, "browserDataClearFailed"));
    } finally {
      setClearingBrowserData(false);
    }
  };

  const saveShortcut = async (action: ShortcutAction, shortcut: string): Promise<void> => {
    if (!["home", "renameWindow", "toggleFullscreen"].includes(action) && shortcut.includes("Mouse")) {
      setShortcutError(t(locale, "shortcutKeyboardOnly"));
      return;
    }
    const conflict = Object.entries(settings.shortcuts).find(
      ([candidateAction, value]) => candidateAction !== action
        && shortcutsShareContext(action, candidateAction as ShortcutAction)
        && value.toLowerCase() === shortcut.toLowerCase()
    );
    const conflictsWithNavigation = settings.canvasNavigationOverride !== null
      && canvasOverrideBindingConflicts(settings.canvasNavigationOverride, shortcut);
    const conflictsWithWheel = settings.canvasWheelCaptureMode === "key"
      && settings.canvasWheelOverride !== null
      && canvasOverrideBindingConflicts(settings.canvasWheelOverride, shortcut);
    if (conflict || conflictsWithNavigation || conflictsWithWheel) {
      setShortcutError(t(locale, "shortcutConflict"));
      return;
    }

    setShortcutError(null);
    await onChange({ keyboardPreset: "custom", shortcuts: { ...settings.shortcuts, [action]: shortcut } });
    setCapturing(null);
  };

  const captureShortcut = (
    action: ShortcutAction,
    event: React.KeyboardEvent<HTMLButtonElement>
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapturing(null);
      setShortcutError(null);
      return;
    }

    const shortcut = shortcutFromKeyboardEvent(event);
    if (!shortcut) return;
    void saveShortcut(action, shortcut);
  };

  const capturePointerShortcut = (
    action: ShortcutAction,
    event: React.PointerEvent<HTMLButtonElement>
  ): void => {
    const shortcut = shortcutFromPointerEvent(event);
    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();
    void saveShortcut(action, shortcut);
  };

  const changeCanvasWheelCaptureMode = (mode: CanvasWheelCaptureMode): void => {
    if (mode === "key" && settings.canvasWheelOverride === null) {
      void onChange({
        canvasWheelCaptureMode: mode,
        canvasWheelOverride: defaultCanvasWheelBinding(window.canvasTTY.window.isMacOS ? "darwin" : "other")
      });
      return;
    }
    void onChange({ canvasWheelCaptureMode: mode });
  };

  const changeAgentDefaultProfile = (provider: AgentProviderId, profile: DefaultLaunchProfile | null): void => {
    if (defaultProfilesBusyRef.current) return;
    defaultProfilesBusyRef.current = true;
    setDefaultProfilesBusy(true);
    const defaultLaunchProfiles = { ...settings.defaultLaunchProfiles };
    if (profile === null) delete defaultLaunchProfiles[provider];
    else defaultLaunchProfiles[provider] = profile;
    void onChange({ defaultLaunchProfiles }).finally(() => {
      defaultProfilesBusyRef.current = false;
      setDefaultProfilesBusy(false);
    });
  };

  const canvasOverrideBindingsMatch = settings.canvasWheelCaptureMode === "key"
    && settings.canvasWheelOverride !== null
    && settings.canvasNavigationOverride !== null
    && settings.canvasWheelOverride === settings.canvasNavigationOverride;

  return (
    <div className={`settings-backdrop ${open ? "settings-backdrop--open" : ""}`} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside
        className={`settings-panel ${open ? "settings-panel--open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t(locale, "settings")}
        aria-hidden={!open}
      >
        <div className="settings-panel__sidebar">
          <header className="settings-panel__brand">
            <span className="settings-panel__brand-icon"><UiIcon name="settings" size="1.05em" /></span>
            <h2>{t(locale, "settings")}</h2>
          </header>
          <nav className="settings-tabs" role="tablist" aria-label={t(locale, "settingsSections")}>
            {SETTINGS_SECTIONS.map(({ id, icon }) => (
              <button
                id={`settings-tab-${id}`}
                key={id}
                className={section === id ? "settings-tabs__button settings-tabs__button--active" : "settings-tabs__button"}
                type="button"
                role="tab"
                aria-controls={`settings-panel-${id}`}
                aria-selected={section === id}
                title={t(locale, id)}
                onClick={() => {
                  setCapturing(null);
                  setShortcutError(null);
                  setSection(id);
                }}
              >
                <span className="settings-tabs__icon"><UiIcon name={icon} size="1.05em" /></span>
                <span>{t(locale, id)}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="settings-panel__main">
          <header className="settings-panel__header">
            <div>
              <span>{t(locale, "settings")}</span>
              <h2>{t(locale, section)}</h2>
            </div>
            <button
              className="settings-panel__close"
              type="button"
              onClick={onClose}
              aria-label={t(locale, "close")}
            ><UiIcon name="close" size="1.05em" /></button>
          </header>

          <div
            id={`settings-panel-${section}`}
            ref={contentRef}
            className="settings-panel__content"
            role="tabpanel"
            aria-labelledby={`settings-tab-${section}`}
          >
          {section === "general" && (
            <>
              <SettingGroup label={t(locale, "language")}>
                <Segmented
                  value={settings.locale}
                  options={[["ru", "Русский"], ["en", "English"]]}
                  onChange={(value) => void onChange({ locale: value as LocaleId })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "attentionNotifications")}
                description={t(locale, "attentionNotificationsDescription")}
              >
                <Segmented
                  value={settings.attentionNotifications ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ attentionNotifications: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "terminalSessionRestore")}
                description={t(locale, "terminalSessionRestoreDescription")}
              >
                <Segmented
                  value={settings.sessionRestoreMode}
                  options={[
                    ["off", t(locale, "doNotSave")],
                    ["reopen", t(locale, "sessionRestoreReopen")],
                    ["continue", t(locale, "sessionRestoreContinue")]
                  ]}
                  onChange={(value) => void onChange({ sessionRestoreMode: value as SessionRestoreMode })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "persistCanvasRegions")}>
                <Segmented
                  value={settings.persistCanvasRegions ? "save" : "discard"}
                  options={[["discard", t(locale, "doNotSave")], ["save", t(locale, "saveAndContinue")]]}
                  onChange={(value) => void onChange({ persistCanvasRegions: value === "save" })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "persistStickyNotes")}>
                <Segmented
                  value={settings.persistStickyNotes ? "save" : "discard"}
                  options={[["discard", t(locale, "doNotSave")], ["save", t(locale, "saveAndContinue")]]}
                  onChange={(value) => void onChange({ persistStickyNotes: value === "save" })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "persistMaterials")}
                description={materialStorage ? `${t(locale, "materialStorageUsed")} ${formatBytes(materialStorage.usedBytes, locale)} / ${formatBytes(materialStorage.limitBytes, locale)}. ${t(locale, "materialStorageRetention")}` : undefined}
              >
                <Segmented
                  value={settings.persistMaterials ? "save" : "discard"}
                  options={[["discard", t(locale, "doNotSave")], ["save", t(locale, "saveAndContinue")]]}
                  onChange={(value) => void onChange({ persistMaterials: value === "save" })}
                />
              </SettingGroup>
            </>
          )}

          {section === "keyboardShortcuts" && (
            <>
              <SettingGroup label={t(locale, "keyboardPreset")} description={t(locale, "keyboardPresetDescription")}>
                <Segmented
                  value={settings.keyboardPreset}
                  options={[["macos", "macOS"], ["windows", "Windows"], ["linux", "Linux"], ["custom", t(locale, "keyboardCustom")]]}
                  onChange={(value) => {
                    const keyboardPreset = value as KeyboardPreset;
                    setCapturing(null);
                    setShortcutError(null);
                    void onChange({ keyboardPreset, ...(keyboardPreset === "custom" ? {} : {
                      shortcuts: keyboardPresetShortcuts(keyboardPreset),
                      canvasWheelOverride: keyboardPreset === "macos" ? "Meta" : "Ctrl",
                      canvasNavigationOverride: "Alt"
                    }) });
                  }}
                />
              </SettingGroup>
              <div className="keyboard-shortcuts">
                <p>{t(locale, "keyboardCaptureHint")}</p>
                {([
                  ["keyboardCanvas", ["home", "renameWindow", "toggleFullscreen", "commandPalette", "openSettings", "focusUp", "focusDown", "focusLeft", "focusRight", "toggleDetail"]],
                  ["keyboardTerminal", ["terminalCopy", "terminalPaste", "terminalSearch", "terminalRestart", "terminalPageUp", "terminalPageDown"]],
                  ["keyboardCodex", ["codexSubmit", "codexSubmitAlternate", "codexSubmitSuper", "codexNewline", "codexSelectAll"]]
                ] as const).map(([group, actions]) => (
                  <div key={group}>
                    <h3>{t(locale, group)}</h3>
                    {actions.map((action) => (
                      <ShortcutRow
                        key={action}
                        label={t(locale, SHORTCUT_LABELS[action])}
                        value={settings.shortcuts[action].replace("Meta", window.canvasTTY.window.isMacOS ? "Command" : "Super") || t(locale, "disabled")}
                        capturing={capturing === action}
                        onStart={() => { setShortcutError(null); setCapturing(action); }}
                        onKeyDown={(event) => captureShortcut(action, event)}
                        onPointerDown={(event) => capturePointerShortcut(action, event)}
                        disableLabel={t(locale, "disabled")}
                        onDisable={["codexSubmit", "codexNewline", "codexSelectAll"].includes(action) ? undefined : () => {
                          setCapturing(null);
                          setShortcutError(null);
                          void onChange({ keyboardPreset: "custom", shortcuts: { ...settings.shortcuts, [action]: "" } });
                        }}
                      />
                    ))}
                  </div>
                ))}
                <SettingGroup label={t(locale, "canvasWheelCapture")} description={t(locale, "canvasWheelCaptureDescription")}>
                  <Segmented value={settings.canvasWheelCaptureMode}
                    options={[["off", "Off"], ["always", "On"], ["key", "Key"]]}
                    onChange={(value) => changeCanvasWheelCaptureMode(value as CanvasWheelCaptureMode)} />
                  {settings.canvasWheelCaptureMode === "key" && (
                    <CanvasNavigationShortcutEditor open={open} locale={locale}
                      label={t(locale, "canvasWheelOverride")} binding={settings.canvasWheelOverride}
                      actionShortcuts={Object.values(settings.shortcuts)} allowDisable={false}
                      onCaptureStart={() => { setCapturing(null); setShortcutError(null); }}
                      onChange={(canvasWheelOverride) => onChange({ keyboardPreset: "custom", canvasWheelOverride })} />
                  )}
                  {canvasOverrideBindingsMatch && <p className="shortcut-editor__warning">{t(locale, "canvasOverrideBindingsMatch")}</p>}
                </SettingGroup>
                <SettingGroup label={t(locale, "canvasNavigationOverride")} description={t(locale, "canvasNavigationOverrideDescription")}>
                  <CanvasNavigationShortcutEditor open={open} locale={locale}
                    label={t(locale, "canvasNavigationOverride")} binding={settings.canvasNavigationOverride}
                    actionShortcuts={Object.values(settings.shortcuts)} allowDisable
                    onCaptureStart={() => { setCapturing(null); setShortcutError(null); }}
                    onChange={(canvasNavigationOverride) => onChange({ keyboardPreset: "custom", canvasNavigationOverride })} />
                </SettingGroup>
                {shortcutError && <p className="shortcut-editor__error" role="alert">{shortcutError}</p>}
                <p>{t(locale, "keyboardCodexDescription")}</p>
              </div>
            </>
          )}

          {section === "appearance" && (
            <>
              <SettingGroup label={t(locale, "palette")} description={t(locale, "paletteDescription")}>
                <Segmented
                  value={settings.palette}
                  options={( ["sage", "lilac", "night"] as PaletteId[]).map((value) => [value, t(locale, value)])}
                  onChange={(value) => void onChange({ palette: value as PaletteId })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "homeColors")} description={t(locale, "homeColorsDescription")}>
                <SwatchChoices
                  value={appearance.homeAccentPreset}
                  options={[
                    ["classic", t(locale, "homePresetClassic"), CLASSIC_HOME_PREVIEW],
                    ["warm", t(locale, "homePresetWarm"), ["#D99872", "#F1D4A8", "#A9CAD6", "#D99AA6"]],
                    ["cool", t(locale, "homePresetCool"), ["#8AB7C5", "#C4DCE2", "#A9B9E3", "#C3A9D9"]],
                    ["mono", t(locale, "homePresetMono"), ["#89919E", "#D8DCE1", "#AAB2BE", "#C3C7CE"]],
                    ["custom", t(locale, "homePresetCustom"), Object.values(appearance.homeAccentColors)]
                  ]}
                  onChange={(value) => void onChange(homeAccentPresetPatch(value as HomeAccentPresetId))}
                />
              </SettingGroup>
              {appearance.homeAccentPreset === "custom" && (
                <SettingGroup label={t(locale, "homeCustomColors")}>
                  <div className="color-editor">
                    {([
                      ["clock", t(locale, "homeColorClock")],
                      ["launcher", t(locale, "homeColorLauncher")],
                      ["browser", t(locale, "homeColorBrowser")],
                      ["settings", t(locale, "homeColorSettings")],
                      ["media", t(locale, "homeColorMedia")]
                    ] as [keyof HomeAccentColors, string][]).map(([key, label]) => (
                      <ColorField
                        key={key}
                        label={label}
                        value={appearance.homeAccentColors[key]}
                        onChange={(value) => void onChange({
                          homeAccentColors: { ...appearance.homeAccentColors, [key]: value }
                        })}
                      />
                    ))}
                  </div>
                </SettingGroup>
              )}
              <SettingGroup
                label={t(locale, "sessionRowColors")}
                description={t(locale, "sessionRowColorsDescription")}
              >
                <Segmented
                  value={settings.sessionRowColorMode}
                  options={([
                    ["status", t(locale, "sessionRowColorsByStatus")],
                    ["monochrome", t(locale, "sessionRowColorsMonochrome")]
                  ] as [SessionRowColorMode, string][])}
                  onChange={(value) => void onChange({ sessionRowColorMode: value as SessionRowColorMode })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "canvasPattern")}
                description={locale === "ru" ? "Если выбран фон-картинка, рисунок канваса не применяется." : "The canvas pattern is not applied when a background image is selected."}
              >
                <Segmented
                  value={settings.pattern}
                  options={(["dots", "grid", "waves", "diagonal", "rings", "none"] as CanvasPatternId[]).map((value) => [value, t(locale, value)])}
                  wrap
                  onChange={(value) => void onChange({ pattern: value as CanvasPatternId })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "canvasColor")}>
                <SwatchChoices
                  value={settings.canvasBackground === "none" ? appearance.canvasColor : ""}
                  columns={4}
                  options={([
                    ["sage", t(locale, "sage")],
                    ["lilac", t(locale, "lilac")],
                    ["night", t(locale, "night")],
                    ["sand", t(locale, "canvasColorSand")],
                    ["mist", t(locale, "canvasColorMist")],
                    ["rose", t(locale, "canvasColorRose")],
                    ["slate", t(locale, "canvasColorSlate")]
                  ] as [CanvasColorId, string][]).map(([value, label]) => (
                    [value, label, [CANVAS_COLOR_PREVIEWS[value]]]
                  ))}
                  onChange={(value) => void onChange({ ...canvasColorPatch(value as CanvasColorId), canvasBackground: "none" })}
                />
              </SettingGroup>
              <SettingGroup
                label={locale === "ru" ? "Пиксельные фоны" : "Pixel backgrounds"}
                description={locale === "ru" ? "Только фон Canvas. Рамки терминалов выбираются отдельно ниже." : "Canvas background only. Choose terminal borders separately below."}
                layout="stacked"
              >
                <CanvasBackgroundChoices locale={locale} value={settings.canvasBackground} pixelPacks={pixelPacks}
                  onChange={(canvasBackground) => void onChange({ canvasBackground })} />
                {pixelPacksState !== "ready" && <small role="status">{pixelPacksState === "loading"
                  ? (locale === "ru" ? "Загрузка пользовательских фонов…" : "Loading custom backgrounds…")
                  : (locale === "ru" ? "Не удалось загрузить пользовательские фоны." : "Custom backgrounds could not be loaded.")}</small>}
              </SettingGroup>
              <SettingGroup label={t(locale, "terminalBorderSkin")} layout="stacked"
                description={locale === "ru" ? "Только оформление окон. Выбранный фон Canvas сохранится." : "Window appearance only. Your Canvas background stays selected."}>
                <BorderSkinChoices
                  locale={locale}
                  value={settings.terminalBorderSkin}
                  pixelPacks={pixelPacks}
                  onPackCreated={(pack) => setPixelPacks((current) => current.some((item) => item.id === pack.id) ? current : [...current, pack])}
                  onChange={(terminalBorderSkin) => void onChange({ terminalBorderSkin })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "terminalSkinDetail")}>
                <Segmented
                  value={settings.terminalSkinDetail}
                  options={[
                    ["minimal", t(locale, "terminalSkinDetailMinimal")],
                    ["detailed", t(locale, "terminalSkinDetailDetailed")]
                  ]}
                  onChange={(terminalSkinDetail) => void onChange({ terminalSkinDetail: terminalSkinDetail as PixelSkinPreferredDetail })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "appSkin")} layout="stacked">
                <AppSkinChoices
                  locale={locale}
                  value={settings.appSkin}
                  onChange={(appSkin) => void onChange({ appSkin })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "uiScale")} description={t(locale, "uiScaleDescription")}>
                <label className="ui-scale-setting">
                  <input
                    type="range"
                    min={UI_SCALE_MIN}
                    max={UI_SCALE_MAX}
                    step={UI_SCALE_STEP}
                    value={settings.uiScale}
                    onChange={(event) => void onChange({ uiScale: Number(event.currentTarget.value) })}
                  />
                  <output>{settings.uiScale.toFixed(2)}×</output>
                </label>
              </SettingGroup>
              <SettingGroup label={t(locale, "shortcutHints")}>
                <Segmented
                  value={settings.showShortcutHints ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ showShortcutHints: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "minimapPlacement")}>
                <PlacementChoices
                  value={settings.minimapPlacement}
                  locale={locale}
                  onChange={(minimapPlacement) => void onChange({ minimapPlacement })}
                />
              </SettingGroup>
              {settings.showShortcutHints && (
                <SettingGroup label={t(locale, "shortcutHintsPlacement")}>
                  <PlacementChoices
                    value={settings.shortcutHintsPlacement}
                    locale={locale}
                    onChange={(shortcutHintsPlacement) => void onChange({ shortcutHintsPlacement })}
                  />
                </SettingGroup>
              )}
              <SettingGroup label={t(locale, "canvasControlsPlacement")}>
                <PlacementChoices
                  value={settings.canvasControlsPlacement}
                  locale={locale}
                  onChange={(canvasControlsPlacement) => void onChange({ canvasControlsPlacement })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "attentionQueue")}
                description={t(locale, "attentionQueueDescription")}
              >
                <Segmented
                  value={settings.attentionQueueVisible ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ attentionQueueVisible: value === "on" })}
                />
              </SettingGroup>
              {settings.attentionQueueVisible && (
                <SettingGroup layout="stacked" label={t(locale, "attentionQueuePlacement")}>
                  <PlacementChoices
                    value={settings.attentionQueuePlacement}
                    locale={locale}
                    onChange={(attentionQueuePlacement) => void onChange({ attentionQueuePlacement })}
                  />
                </SettingGroup>
              )}
              <SettingGroup label={t(locale, "agentChatHistory")} description={t(locale, "agentChatHistoryDescription")}>
                <Segmented
                  value={settings.agentChatHistoryVisible ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ agentChatHistoryVisible: value === "on" })}
                />
              </SettingGroup>
              {settings.agentChatHistoryVisible && (
                <SettingGroup label={t(locale, "agentChatHistoryExpandMode")}>
                  <Segmented value={settings.agentChatHistoryExpandMode}
                    options={[["hover", t(locale, "agentChatHistoryExpandHover")], ["click", t(locale, "agentChatHistoryExpandClick")]]}
                    onChange={(agentChatHistoryExpandMode: AppSettings["agentChatHistoryExpandMode"]) => void onChange({ agentChatHistoryExpandMode })} />
                </SettingGroup>
              )}
              {settings.agentChatHistoryVisible && (
                <SettingGroup label={t(locale, "agentChatHistoryPlacement")} layout="stacked">
                  <PlacementChoices value={settings.agentChatHistoryPlacement} locale={locale}
                    onChange={(agentChatHistoryPlacement) => void onChange({ agentChatHistoryPlacement })} />
                </SettingGroup>
              )}
              {settings.agentChatHistoryVisible && (
                <>
                  <SettingGroup label={t(locale, "agentChatHistorySearchAgents")} layout="stacked">
                    <Segmented value={settings.agentChatHistorySearchAgents}
                      options={[["current", t(locale, "agentChatHistorySearchCurrentAgent")], ["all", t(locale, "agentChatHistorySearchAllAgents")]]}
                      onChange={(agentChatHistorySearchAgents: AppSettings["agentChatHistorySearchAgents"]) => void onChange({ agentChatHistorySearchAgents })} />
                  </SettingGroup>
                  <SettingGroup label={t(locale, "agentChatHistorySearchSessions")} layout="stacked">
                    <Segmented value={settings.agentChatHistorySearchSessions}
                      options={[["filtered", t(locale, "agentChatHistorySearchFiltered")], ["all", t(locale, "agentChatHistoryActivityAll")]]}
                      onChange={(agentChatHistorySearchSessions: AppSettings["agentChatHistorySearchSessions"]) => void onChange({ agentChatHistorySearchSessions })} />
                  </SettingGroup>
                </>
              )}
              <HomeAppearanceSettings
                settings={settings}
                plugins={plugins}
                onToggleHomeWidget={onToggleHomeWidget}
                onEditHome={onEditHome}
              />
            </>
          )}

          {section === "agents" && (
            <>
              <ExecutionTargetSettings settings={settings} locale={locale} onChange={onChange}/>
              <SettingGroup layout="stacked" label={t(locale, "agentCliDetection")} description={t(locale, "agentCliDetectionDescription")}>
                <div className="agent-cli-recheck">
                  <button className="setting-inline-action" type="button" disabled={checkingAgentClis} onClick={() => void recheckAgentClis()}>
                    {t(locale, checkingAgentClis ? "agentCliRechecking" : "agentCliRecheck")}
                  </button>
                  {agentCliError && <span role="alert">{agentCliError}</span>}
                </div>
              </SettingGroup>
              <SettingGroup
                label={t(locale, "baseProtection")}
                description={t(locale, "baseProtectionDescription")}
              >
                <Segmented
                  value={settings.baseProtectionEnabled ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ baseProtectionEnabled: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "agentIsolation")} description={t(locale, "agentIsolationDescription")}>
                <Segmented
                  value={settings.agentIsolation === "off" ? "off" : "on"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ agentIsolation: value === "off" ? "off" : "on" })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "defaultLaunchProfile")} description={t(locale, "defaultLaunchProfileDescription")}>
                <Segmented
                  value={settings.defaultLaunchProfile ?? "auto"}
                  options={[["auto", t(locale, "autoProfile")], ["acceptEdits", t(locale, "acceptEditsProfile")], ["normal", t(locale, "manualProfile")], ["plan", t(locale, "planProfile")]]}
                  onChange={(value) => void onChange({ defaultLaunchProfile: value as AppSettings["defaultLaunchProfile"] })}
                />
              </SettingGroup>
              <SettingGroup
                layout="stacked"
                label={t(locale, "agentDefaultLaunchProfiles")}
                description={t(locale, "agentDefaultLaunchProfilesDescription")}
              >
                <div className="agent-launcher-settings">
                  {AGENT_PROVIDERS.map((provider) => {
                    const savedProfile = settings.defaultLaunchProfiles?.[provider];
                    const available = availableProfiles(provider, containmentAvailable)
                      .filter(isDefaultLaunchProfile);
                    const actualProfile = resolveDefaultLaunchProfile(provider, settings, containmentAvailable);
                    const desiredProfile = isDefaultLaunchProfile(savedProfile)
                      ? savedProfile
                      : settings.defaultLaunchProfile;
                    const fallback = !available.includes(desiredProfile);
                    const selected = isDefaultLaunchProfile(savedProfile)
                      ? (available.includes(savedProfile) ? savedProfile : actualProfile)
                      : "inherit";
                    return (
                      <div className="agent-launcher-settings__row" key={provider}>
                        <span className="agent-launcher-settings__identity">
                          <ProviderIcon provider={provider} size="small" />
                          <strong>{PROVIDERS[provider].label}</strong>
                          {fallback && <small>{t(locale, "defaultLaunchProfileFallback").replace("{profile}", t(locale, DEFAULT_PROFILE_LABELS[actualProfile]))}</small>}
                        </span>
                        <Segmented
                          value={selected}
                          wrap
                          disabled={defaultProfilesBusy}
                          options={[
                            ["inherit", t(locale, "inheritDefaultLaunchProfile")],
                            ...available.map((profile) => [profile, t(locale, DEFAULT_PROFILE_LABELS[profile])] as [string, string])
                          ]}
                          onChange={(value) => changeAgentDefaultProfile(
                            provider,
                            value === "inherit" ? null : value as DefaultLaunchProfile
                          )}
                        />
                      </div>
                    );
                  })}
                </div>
              </SettingGroup>
              <SettingGroup label={t(locale, "orchestrationMaxDepth")} description={t(locale, "orchestrationMaxDepthDescription")}>
                <Segmented
                  value={String(settings.orchestrationMaxDepth ?? 2)}
                  options={[["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]]}
                  onChange={(value) => void onChange({ orchestrationMaxDepth: Number(value) })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "orchestrationMaxSubagents")} description={t(locale, "orchestrationMaxSubagentsDescription")}>
                <Segmented
                  value={String(settings.orchestrationMaxSubagents ?? 8)}
                  options={[...new Set([2, 4, 8, 16, 32, settings.orchestrationMaxSubagents ?? 8])].sort((a, b) => a - b).map((count) => [String(count), String(count)] as [string, string])}
                  onChange={(value) => void onChange({ orchestrationMaxSubagents: Number(value) })}
                />
              </SettingGroup>
              <AgentHooksSettings
                settings={settings}
                plugins={plugins}
                onChange={onChange}
                onSetPluginHookEnabled={onSetPluginHookEnabled}
              />
              <PluginServicesSettings
                locale={locale}
                plugins={plugins}
                open={open}
                onSetNativeCodeTrusted={onSetPluginNativeCodeTrusted}
                onSetDecisionsMayAllow={onSetPluginDecisionsMayAllow}
              />
              <SettingGroup
                label={t(locale, "experimentalBacklogEnabled")}
                description={t(locale, "experimentalBacklogEnabledDescription")}
              >
                <Segmented
                  value={settings.experimentalBacklogEnabled ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ experimentalBacklogEnabled: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "agentControlEnabled")}
                description={t(locale, "agentControlEnabledDescription")}
              >
                <Segmented
                  value={settings.agentControlEnabled ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ agentControlEnabled: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup
                layout="stacked"
                label={t(locale, "canvasLauncherItems")}
                description={t(locale, "canvasLauncherItemsDescription")}
              >
                <div className="canvas-menu canvas-launcher-settings-menu">
                  <CanvasMenuLabel>{t(locale, "canvasLauncherSettingsLabel")}</CanvasMenuLabel>
                  {CANVAS_LAUNCHER_ITEMS.map((item: CanvasLauncherItemId) => {
                    if (item !== "terminal" && !agentAvailability?.[item]) return missingAgentRow(item);
                    const enabled = settings.canvasLauncherItems.includes(item);
                    return (
                      <CanvasMenuRow
                        icon={enabled ? "minus" : "plus"}
                        muted={!enabled}
                        aria-pressed={enabled}
                        aria-label={`${t(locale, enabled ? "disable" : "enable")}: ${PROVIDERS[item].label}`}
                        title={`${t(locale, enabled ? "disable" : "enable")}: ${PROVIDERS[item].label}`}
                        key={item}
                        onClick={() => void onChange({
                          canvasLauncherItems: setCanvasLauncherItemEnabled(
                            settings.canvasLauncherItems,
                            item,
                            !enabled
                          )
                        })}
                      ><span className="canvas-menu__provider"><ProviderIcon provider={item} size="small" />{PROVIDERS[item].label}</span></CanvasMenuRow>
                    );
                  })}
                  <CanvasMenuDivider />
                  <CanvasMenuRow
                    icon="home"
                    muted
                    onClick={() => void onChange({ canvasLauncherItems: [...DEFAULT_CANVAS_LAUNCHER_ITEMS] })}
                  >{t(locale, "resetCanvasLauncher")}</CanvasMenuRow>
                </div>
              </SettingGroup>
              <SettingGroup
                layout="stacked"
                label={t(locale, "quickLauncher")}
                description={t(locale, "quickLauncherDescription")}
              >
                <div className="quick-launcher-settings">
                <Segmented
                  value={settings.radialLauncherEnabled ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ radialLauncherEnabled: value === "on" })}
                />
                <div className="canvas-menu canvas-launcher-settings-menu">
                  <CanvasMenuLabel>{t(locale, "quickLauncherCount").replace("{count}", String(settings.radialLauncherItems.length))}</CanvasMenuLabel>
                  {RADIAL_LAUNCHER_ITEMS.map((item: RadialLauncherItemId) => {
                    if (item !== "terminal" && item !== "note" && item !== "browser" && item !== "settings" && !agentAvailability?.[item]) {
                      return missingAgentRow(item);
                    }
                    const enabled = settings.radialLauncherItems.includes(item);
                    return (
                      <CanvasMenuRow
                        icon={enabled ? "minus" : "plus"}
                        muted={!enabled}
                        aria-pressed={enabled}
                        aria-label={`${t(locale, enabled ? "disable" : "enable")}: ${itemLabel(locale, item)}`}
                        title={`${t(locale, enabled ? "disable" : "enable")}: ${itemLabel(locale, item)}`}
                        key={item}
                        onClick={() => void onChange({
                          radialLauncherItems: setRadialLauncherItemEnabled(
                            settings.radialLauncherItems,
                            item,
                            !enabled
                          )
                        })}
                      >{item === "note" || item === "browser" || item === "settings"
                        ? itemLabel(locale, item)
                        : <span className="canvas-menu__provider"><ProviderIcon provider={item} size="small" />{itemLabel(locale, item)}</span>}</CanvasMenuRow>
                    );
                  })}
                  <CanvasMenuDivider />
                  <CanvasMenuRow
                    icon="home"
                    muted
                    onClick={() => void onChange({ radialLauncherItems: [...DEFAULT_RADIAL_LAUNCHER_ITEMS] })}
                  >{t(locale, "useDefaults")}</CanvasMenuRow>
                </div>
                </div>
              </SettingGroup>
              <SettingGroup
                layout="stacked"
                label={t(locale, "homeLauncherAgents")}
                description={t(locale, "homeLauncherAgentsDescription")}
              >
                <div className="agent-launcher-settings">
                  {AGENT_PROVIDERS.map((provider) => {
                    if (!agentAvailability?.[provider]) return missingAgentRow(provider);
                    const enabled = homeLauncherProviders.includes(provider);
                    return (
                      <div className="agent-launcher-settings__row" key={provider}>
                        <span className="agent-launcher-settings__identity">
                          <ProviderIcon provider={provider} size="small" />
                          <strong>{PROVIDERS[provider].label}</strong>
                        </span>
                        <Segmented
                          value={enabled ? "on" : "off"}
                          options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                          onChange={(value) => void onChange({
                            homeLauncherProviders: setHomeLauncherProviderEnabled(
                              homeLauncherProviders,
                              provider,
                              value === "on"
                            )
                          })}
                        />
                      </div>
                    );
                  })}
                </div>
              </SettingGroup>
              <SettingGroup
                layout="stacked"
                label={t(locale, "homeLimitProviders")}
                description={t(locale, "homeLimitProvidersDescription")}
              >
                <div className="agent-launcher-settings">
                  {LIMIT_PROVIDERS.map((provider: LimitProviderId) => {
                    if (!agentAvailability?.[provider]) return missingAgentRow(provider, PROVIDERS[provider].limitsLabel ?? PROVIDERS[provider].label);
                    const enabled = homeLimitProviders.includes(provider);
                    return (
                      <div className="agent-launcher-settings__row" key={provider}>
                        <span className="agent-launcher-settings__identity">
                          <ProviderIcon provider={provider} size="small" />
                          <strong>{PROVIDERS[provider].limitsLabel ?? PROVIDERS[provider].label}</strong>
                        </span>
                        <Segmented
                          value={enabled ? "on" : "off"}
                          options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                          onChange={(value) => void onChange({
                            homeLimitProviders: setHomeLimitProviderEnabled(
                              homeLimitProviders,
                              provider,
                              value === "on"
                            )
                          })}
                        />
                      </div>
                    );
                  })}
                </div>
              </SettingGroup>
              <SettingGroup
                layout="stacked"
                label={t(locale, "providerApiKeys")}
                description={t(locale, "providerApiKeysDescription")}
              >
                <ProviderSecretsSettings locale={locale} />
              </SettingGroup>
              <SettingGroup
                layout="stacked"
                label={t(locale, "apiProfiles")}
                description={t(locale, "apiProfilesDescription")}
              >
                <ApiProfilesSettings settings={settings} onChange={onChange} />
              </SettingGroup>
            </>
          )}

          {section === "externalIntegrations" && (
            <EvenG2Controls locale={locale} open={open} />
          )}

          {section === "controls" && (
            <>
              <SettingGroup label={t(locale, "focusActivation")}>
                <Segmented
                  value={settings.focusActivation}
                  options={(["off", "single", "double"] as FocusActivation[]).map((value) => [value, t(locale, value)])}
                  onChange={(value) => void onChange({ focusActivation: value as FocusActivation })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "hoverFocus")} description={t(locale, "hoverFocusDescription")}>
                <Segmented
                  value={settings.hoverFocus ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ hoverFocus: value === "on" })}
                />
              </SettingGroup>
              {settings.hoverFocus && (
                <SettingGroup label={t(locale, "hoverFocusSpeed")}>
                  <Segmented
                    value={settings.hoverFocusSpeed}
                    options={(["slow", "normal", "fast"] as EdgePanSpeed[]).map((value) => [value, t(locale, value)])}
                    onChange={(value) => void onChange({ hoverFocusSpeed: value as EdgePanSpeed })}
                  />
                </SettingGroup>
              )}
              <SettingGroup label={t(locale, "snapToGrid")}>
                <Segmented
                  value={settings.snapToGrid ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ snapToGrid: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "minimapInteractionMode")}
                description={t(locale, "minimapInteractionModeDescription")}
              >
                <Segmented
                  value={settings.minimapInteractionMode}
                  options={([
                    ["click", t(locale, "minimapInteractionClick")],
                    ["drag", t(locale, "minimapInteractionDrag")]
                  ] as [MinimapInteractionMode, string][])}
                  onChange={(value) => void onChange({
                    minimapInteractionMode: value as MinimapInteractionMode
                  })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "edgePan")} description={t(locale, "edgePanDescription")}>
                <Segmented
                  value={settings.edgePan ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ edgePan: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "edgePanSpeed")}>
                <Segmented
                  value={settings.edgePanSpeed}
                  options={(["slow", "normal", "fast"] as EdgePanSpeed[]).map((value) => [value, t(locale, value)])}
                  onChange={(value) => void onChange({ edgePanSpeed: value as EdgePanSpeed })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "zoomSensitivity")}>
                <Segmented
                  value={settings.zoomSensitivity}
                  options={(["slow", "normal", "fast"] as ZoomSensitivity[]).map((value) => [value, t(locale, value)])}
                  onChange={(value) => void onChange({ zoomSensitivity: value as ZoomSensitivity })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "useScrollWheelToZoom")}
                description={t(locale, "useScrollWheelToZoomDescription")}
              >
                <Segmented
                  value={settings.useScrollWheelToZoom ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ useScrollWheelToZoom: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "copyOnSelect")} description={t(locale, "copyOnSelectDescription")}>
                <Segmented
                  value={settings.copyOnSelect ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ copyOnSelect: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "terminalLinkOpenMode")} description={t(locale, "terminalLinkOpenModeDescription")}>
                <Segmented
                  value={settings.terminalLinkOpenMode}
                  options={[
                    ["canvas", "CanvasTTY"],
                    ["external", t(locale, "terminalLinkOpenExternal")],
                    ["ask", t(locale, "terminalLinkOpenAsk")]
                  ]}
                  onChange={(value) => void onChange({ terminalLinkOpenMode: value as TerminalLinkOpenMode })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "terminalWheelDirection")}>
                <Segmented
                  value={settings.invertTerminalWheel ? "inverted" : "normal"}
                  options={[["inverted", t(locale, "wheelInverted")], ["normal", t(locale, "wheelNormal")]]}
                  onChange={(value) => void onChange({ invertTerminalWheel: value === "inverted" })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "canvasWheelDirection")}>
                <Segmented
                  value={settings.invertCanvasWheel ? "inverted" : "normal"}
                  options={[["normal", t(locale, "wheelNormal")], ["inverted", t(locale, "wheelInverted")]]}
                  onChange={(value) => void onChange({ invertCanvasWheel: value === "inverted" })}
                />
              </SettingGroup>
            </>
          )}

          {section === "browser" && (
            <>
              <SettingGroup
                label={t(locale, "browserAgentAccess")}
                description={t(locale, "browserAgentAccessDescription")}
              >
                <Segmented
                  value={settings.browserAgentAccess ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ browserAgentAccess: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "browserAgentPresence")}
                description={t(locale, "browserAgentPresenceDescription")}
              >
                <Segmented
                  value={settings.browserShowAgentPresence ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ browserShowAgentPresence: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "browserRestoreTabs")}
                description={t(locale, "browserRestoreTabsDescription")}
              >
                <Segmented
                  value={settings.browserRestoreTabs ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ browserRestoreTabs: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "browserPauseHiddenTabs")}
                description={t(locale, "browserPauseHiddenTabsDescription")}
              >
                <Segmented
                  value={settings.browserPauseHiddenTabs ? "on" : "off"}
                  options={[["on", t(locale, "on")], ["off", t(locale, "off")]]}
                  onChange={(value) => void onChange({ browserPauseHiddenTabs: value === "on" })}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "browserDownloads")}>
                <BrowserDownloadList downloads={browser.downloads} locale={locale} />
              </SettingGroup>
              <SettingGroup label={t(locale, "browserActivity")}>
                <BrowserActivityList activity={activity} state={activityState} locale={locale} />
              </SettingGroup>
              <SettingGroup
                label={t(locale, "browserData")}
                description={t(locale, "browserDataDescription")}
              >
                <div className="browser-settings__data-actions">
                  <button
                    className={clearConfirm ? "browser-settings__clear browser-settings__clear--confirm" : "browser-settings__clear"}
                    type="button"
                    disabled={clearingBrowserData}
                    onClick={() => void clearBrowserData()}
                  >
                    {clearingBrowserData
                      ? t(locale, "browserDataClearing")
                      : clearConfirm
                        ? t(locale, "browserDataClearConfirm")
                        : t(locale, "browserDataClear")}
                  </button>
                  {clearConfirm && !clearingBrowserData && (
                    <button className="browser-settings__cancel" type="button" onClick={() => setClearConfirm(false)}>
                      {t(locale, "cancel")}
                    </button>
                  )}
                </div>
                {browserDataMessage && <p className="browser-settings__message" role="status">{browserDataMessage}</p>}
              </SettingGroup>
            </>
          )}

          {section === "plugins" && (
            <PluginSettingsSection
              open={open}
              settings={settings}
              plugins={plugins}
              onPreviewPlugin={onPreviewPlugin}
              onInstallPlugin={onInstallPlugin}
              onSearchPlugins={onSearchPlugins}
              onShowcasePlugins={onShowcasePlugins}
              onFetchPluginIcons={onFetchPluginIcons}
              onPreviewManifests={onPreviewManifests}
              onOpenBrowser={onOpenBrowser}
              onCheckPluginUpdates={onCheckPluginUpdates}
              onUpdatePlugin={onUpdatePlugin}
              onSetPluginModules={onSetPluginModules}
              onSetPluginEnabled={onSetPluginEnabled}
              onUninstallPlugin={onUninstallPlugin}
              onOpenPluginContribution={onOpenPluginContribution}
            />
          )}

            {section === "updates" && (
              <UpdatesSettings locale={locale} />
            )}

            {section === "about" && <AboutSettings locale={locale} />}
          </div>
        </div>
      </aside>
    </div>
  );
}

function BrowserDownloadList({
  downloads,
  locale
}: {
  downloads: BrowserDownloadSnapshot[];
  locale: LocaleId;
}): React.JSX.Element {
  const recent = [...downloads]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, 6);
  if (recent.length === 0) return <p className="browser-settings__empty">{t(locale, "browserNoDownloads")}</p>;

  return (
    <div className="browser-settings__list" data-wheel-owner="local">
      {recent.map((download) => {
        const percent = download.totalBytes > 0
          ? Math.min(100, Math.round(download.receivedBytes / download.totalBytes * 100))
          : null;
        return (
          <div className="browser-settings__download" key={download.id}>
            <span className="browser-settings__download-icon"><UiIcon name="download" size={15} /></span>
            <span className="browser-settings__row-copy">
              <strong title={download.fileName}>{download.fileName}</strong>
              <small>{downloadStatusLabel(locale, download.status)}{percent === null ? "" : `, ${percent}%`}</small>
            </span>
            {download.status === "progressing" && percent !== null && (
              <span className="browser-settings__progress" aria-label={`${percent}%`}>
                <span style={{ width: `${percent}%` }} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BrowserActivityList({
  activity,
  state,
  locale
}: {
  activity: BrowserActivityEvent[];
  state: "idle" | "loading" | "ready" | "error";
  locale: LocaleId;
}): React.JSX.Element {
  if (state === "loading" || state === "idle") {
    return <p className="browser-settings__empty">{t(locale, "browserActivityLoading")}</p>;
  }
  if (state === "error") return <p className="browser-settings__empty browser-settings__empty--error">{t(locale, "browserActivityFailed")}</p>;
  const recent = [...activity].sort((left, right) => right.sequence - left.sequence).slice(0, 10);
  if (recent.length === 0) return <p className="browser-settings__empty">{t(locale, "browserNoActivity")}</p>;

  return (
    <div className="browser-settings__list" data-wheel-owner="local">
      {recent.map((event) => {
        const provider = event.provider ?? "unknown";
        return (
          <div className={`browser-settings__activity ${event.ok ? "" : "browser-settings__activity--failed"}`} key={event.sequence}>
            <span
              className="browser-settings__agent-mark"
              style={{ "--agent-color": BROWSER_PROVIDER_COLORS[provider] } as React.CSSProperties}
              aria-hidden="true"
            />
            <span className="browser-settings__row-copy">
              <strong title={event.agentId ?? t(locale, "browserYou")}>{event.agentId ?? t(locale, "browserYou")}</strong>
              <small>{activityOperationLabel(locale, event.operation)}</small>
            </span>
            <time dateTime={new Date(event.timestamp).toISOString()}>
              {new Date(event.timestamp).toLocaleTimeString(locale === "ru" ? "ru-RU" : "en-GB", {
                hour: "2-digit",
                minute: "2-digit"
              })}
            </time>
          </div>
        );
      })}
    </div>
  );
}

function downloadStatusLabel(locale: LocaleId, status: BrowserDownloadSnapshot["status"]): string {
  const keys = {
    pending: "browserDownloadPending",
    progressing: "browserDownloadProgressing",
    completed: "browserDownloadCompleted",
    canceled: "browserDownloadCanceled",
    interrupted: "browserDownloadInterrupted"
  } as const;
  return t(locale, keys[status]);
}

const ACTIVITY_LABELS: Record<LocaleId, Record<BrowserCommandType, string>> = {
  ru: {
    browser_list_tabs: "Просмотрел вкладки",
    browser_new_tab: "Открыл вкладку",
    browser_close_tab: "Закрыл вкладку",
    browser_activate_tab: "Выбрал вкладку",
    browser_navigate: "Перешёл по адресу",
    browser_back: "Вернулся назад",
    browser_forward: "Перешёл вперёд",
    browser_reload: "Обновил страницу",
    browser_observe: "Осмотрел страницу",
    browser_read_page: "Прочитал страницу",
    browser_screenshot: "Сделал снимок",
    browser_click: "Нажал на странице",
    browser_hover: "Навёл курсор",
    browser_type: "Ввёл текст",
    browser_select: "Выбрал значение",
    browser_press: "Нажал клавишу",
    browser_scroll: "Прокрутил страницу",
    browser_drag: "Перетащил элемент",
    browser_wait_for: "Ждал изменения",
    browser_handle_dialog: "Ответил сайту",
    browser_download_wait: "Ждал загрузку",
    browser_upload: "Передал файл",
    browser_get_activity: "Проверил историю"
  },
  en: {
    browser_list_tabs: "Viewed tabs",
    browser_new_tab: "Opened a tab",
    browser_close_tab: "Closed a tab",
    browser_activate_tab: "Selected a tab",
    browser_navigate: "Opened an address",
    browser_back: "Went back",
    browser_forward: "Went forward",
    browser_reload: "Reloaded the page",
    browser_observe: "Inspected the page",
    browser_read_page: "Read the page",
    browser_screenshot: "Took a screenshot",
    browser_click: "Clicked the page",
    browser_hover: "Moved the pointer",
    browser_type: "Entered text",
    browser_select: "Selected a value",
    browser_press: "Pressed a key",
    browser_scroll: "Scrolled the page",
    browser_drag: "Dragged an item",
    browser_wait_for: "Waited for a change",
    browser_handle_dialog: "Answered the site",
    browser_download_wait: "Waited for a download",
    browser_upload: "Uploaded a file",
    browser_get_activity: "Checked activity"
  }
};

function activityOperationLabel(locale: LocaleId, operation: BrowserCommandType): string {
  return ACTIVITY_LABELS[locale][operation];
}

function ShortcutRow({
  label,
  value,
  capturing,
  onStart,
  onKeyDown,
  onPointerDown,
  onDisable,
  disableLabel
}: {
  label: string;
  value: string;
  capturing: boolean;
  onStart(): void;
  onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void;
  onPointerDown(event: React.PointerEvent<HTMLButtonElement>): void;
  onDisable?(): void;
  disableLabel?: string;
}): React.JSX.Element {
  return (
    <div className={onDisable ? "shortcut-editor__row shortcut-editor__row--disable" : "shortcut-editor__row"}>
      <span>{label}</span>
      <button
        className={capturing ? "shortcut-editor__key shortcut-editor__key--capturing" : "shortcut-editor__key"}
        type="button"
        data-shortcut-capture="true"
        onClick={onStart}
        onPointerDown={(event) => {
          if (capturing) onPointerDown(event);
        }}
        onKeyDown={(event) => {
          if (capturing) onKeyDown(event);
        }}
      >{capturing ? "…" : value}</button>
      {onDisable && <button className="shortcut-editor__key shortcut-editor__disable" type="button"
        aria-label={`${disableLabel}: ${label}`} title={disableLabel} onClick={onDisable}>
        <UiIcon name="close" size="1em" />
      </button>}
    </div>
  );
}

function PlacementChoices({
  value,
  locale,
  onChange
}: {
  value: CanvasOverlayPlacement;
  locale: LocaleId;
  onChange(value: CanvasOverlayPlacement): void;
}): React.JSX.Element {
  const options: Array<[CanvasOverlayPlacement, string]> = [
    ["top-left", t(locale, "topLeft")],
    ["top-right", t(locale, "topRight")],
    ["bottom-left", t(locale, "bottomLeft")],
    ["bottom-right", t(locale, "bottomRight")]
  ];
  return (
    <div className="segmented segmented--placement">
      {options.map(([optionValue, label]) => (
        <button
          className={value === optionValue ? "segmented__button segmented__button--active" : "segmented__button"}
          type="button"
          key={optionValue}
          onClick={() => onChange(optionValue)}
        >{label}</button>
      ))}
    </div>
  );
}

function SettingGroup({
  label,
  description,
  layout = "field",
  children
}: {
  label: string;
  description?: string;
  layout?: "field" | "stacked";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={`setting-group setting-group--field${layout === "stacked" ? " setting-group--stacked" : ""}`}>
      <div className="setting-group__copy">
        <h3>{label}</h3>
        {description && <p className="setting-group__description">{description}</p>}
      </div>
      <div className="setting-group__control">{children}</div>
    </section>
  );
}

function Segmented({
  value,
  options,
  wrap = false,
  disabled = false,
  onChange
}: {
  value: string;
  options: [string, string][];
  wrap?: boolean;
  disabled?: boolean;
  onChange(value: string): void;
}): React.JSX.Element {
  return (
    <div className={`segmented ${wrap ? "segmented--wrap" : ""}`}>
      {options.map(([optionValue, label]) => (
        <button
          className={value === optionValue ? "segmented__button segmented__button--active" : "segmented__button"}
          type="button"
          key={optionValue}
          disabled={disabled}
          onClick={() => onChange(optionValue)}
        >{label}</button>
      ))}
    </div>
  );
}

const BACKGROUND_ASSETS = import.meta.glob<string>("../../assets/theme-backgrounds/*.avif", {
  eager: true, query: "?url", import: "default"
});

function CanvasBackgroundChoices({ locale, value, pixelPacks, onChange }: {
  locale: LocaleId;
  value: CanvasBackgroundId;
  pixelPacks: PixelSkinPackSummary[];
  onChange(value: CanvasBackgroundId): void;
}): React.JSX.Element {
  const labelKeys = {
    sakura: "borderSkinSakura", matrix: "borderSkinMatrix", "forest-cabin": "borderSkinForestCabin",
    "gold-black": "borderSkinGoldBlack", cat: "borderSkinCat", "gothic-eclipse": "borderSkinGothicEclipse"
  } as const;
  return <div className="border-skin-choices" role="group" aria-label={locale === "ru" ? "Пиксельные фоны" : "Pixel backgrounds"}>
    <button type="button" className="pixel-pack-create" aria-pressed={value === "none"} onClick={() => onChange("none")}>
      {locale === "ru" ? "Без картинки — выбранный цвет и узор" : "No image — selected color and pattern"}
    </button>
    {BUNDLED_CANVAS_BACKGROUND_IDS.map((id) => <button key={id} type="button" className="border-skin-choice"
      aria-pressed={value === id} onClick={() => onChange(id)}>
      <span className="border-skin-preview border-skin-preview--pixel canvas-background-preview" aria-hidden="true">
        <img src={BACKGROUND_ASSETS[`../../assets/theme-backgrounds/${id}.avif`]} alt="" loading="lazy" />
      </span>
      <span className="border-skin-choice__label">{t(locale, labelKeys[id])}</span>
    </button>)}
    {pixelPacks.map((pack) => <button key={pack.id} type="button" className="border-skin-choice"
      aria-pressed={value === pack.id} onClick={() => onChange(pack.id)}>
      <span className="border-skin-preview border-skin-preview--pixel canvas-background-preview" aria-hidden="true">
        <PixelSkinPackThumbnail id={pack.id} slot="background" />
      </span>
      <span className="border-skin-choice__label">{pack.name}</span>
    </button>)}
    {isPixelSkinPackId(value) && !pixelPacks.some((pack) => pack.id === value) && <small role="status">
      {locale === "ru" ? "Выбранный пользовательский фон недоступен." : "The selected custom background is unavailable."}
    </small>}
  </div>;
}

function BorderSkinChoices({
  locale,
  value,
  pixelPacks,
  onPackCreated,
  onChange
}: {
  locale: LocaleId;
  value: TerminalBorderSkinId;
  pixelPacks: PixelSkinPackSummary[];
  onPackCreated(pack: PixelSkinPackSummary): void;
  onChange(value: TerminalBorderSkinId): void;
}): React.JSX.Element {
  const [customSkins, setCustomSkins] = useState<TerminalBorderSkinListItem[]>([]);
  const [customSkinsLoadState, setCustomSkinsLoadState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let active = true;
    let requestRevision = 0;
    const refresh = async (): Promise<void> => {
      const revision = ++requestRevision;
      try {
        const response: unknown = await window.canvasTTY.skins.list();
        if (!Array.isArray(response) || response.some((item) => item && typeof item === "object"
          && (item as Record<string, unknown>).id === "custom:skin-registry"
          && (item as Record<string, unknown>).status === "error")) throw new Error("Skin registry unavailable.");
        const items = normalizeTerminalBorderSkinList(response);
        if (!active || revision !== requestRevision) return;
        setCustomSkins(items);
        setCustomSkinsLoadState("ready");
      } catch {
        if (!active || revision !== requestRevision) return;
        setCustomSkins([]);
        setCustomSkinsLoadState("error");
      }
    };

    let unsubscribe = (): void => undefined;
    try {
      unsubscribe = window.canvasTTY.skins.onChanged(() => void refresh());
    } catch {
      setCustomSkinsLoadState("error");
    }
    void refresh();
    return () => {
      active = false;
      requestRevision += 1;
      unsubscribe();
    };
  }, []);

  const choices: readonly [TerminalBorderSkinId, Parameters<typeof t>[1]][] = [
    ["classic", "borderSkinClassic"],
    ["minimal", "borderSkinMinimal"],
    ["glass", "borderSkinGlass"],
    ["cyber", "borderSkinCyber"],
    ["nord", "borderSkinNord"],
    ["gradient", "borderSkinGradient"],
    ["cybercore", "borderSkinCybercore"],
    ["titanium", "borderSkinTitanium"],
    ["retro", "borderSkinRetro"],
    ["sakura", "borderSkinSakura"],
    ["matrix", "borderSkinMatrix"],
    ["forest-cabin", "borderSkinForestCabin"],
    ["gold-black", "borderSkinGoldBlack"],
    ["cat", "borderSkinCat"],
    ["gothic-eclipse", "borderSkinGothicEclipse"]
  ];
  const selectedCustomSkinId = isCustomTerminalBorderSkinId(value) ? value : null;
  const selectedCustomSkin = customSkins.find((skin) => skin.id === selectedCustomSkinId);
  const previewStyleController = useRef<ReturnType<typeof createTerminalBorderSkinPreviewStyleController> | null>(null);
  useEffect(() => {
    const controller = createTerminalBorderSkinPreviewStyleController(window.canvasTTY.skins, document);
    previewStyleController.current = controller;
    return () => {
      controller.dispose();
      previewStyleController.current = null;
    };
  }, []);
  useEffect(() => {
    const previewIds = customSkins.map((skin) => skin.id);
    if (selectedCustomSkinId && !previewIds.includes(selectedCustomSkinId)) previewIds.push(selectedCustomSkinId);
    previewStyleController.current?.setActive(previewIds);
  }, [customSkins, selectedCustomSkinId]);
  const customSkinStatus = (skin: TerminalBorderSkinListItem): string => skin.status === "ready"
    ? t(locale, "borderSkinReady")
    : t(locale, "borderSkinError");

  return (
    <div className="border-skin-choices" role="group" aria-label={t(locale, "terminalBorderSkin")}>
      {choices.map(([skin, labelKey]) => {
        const pixelTheme = isPixelSkinThemeId(skin) ? skin : null;
        return (
          <button
            key={skin}
            type="button"
            className="border-skin-choice"
            aria-pressed={value === skin}
            onClick={() => onChange(skin)}
          >
            <span className={`border-skin-preview${pixelTheme ? " border-skin-preview--pixel" : ""}`} data-border-skin={skin} aria-hidden="true">
              {pixelTheme
                ? <PixelBorderSkinThumbnail theme={pixelTheme} />
                : <>
                    <span className="border-skin-preview__header"><i /><i /><i /></span>
                    <span className="border-skin-preview__body"><i /><i /></span>
                  </>}
            </span>
            <span className="border-skin-choice__label">{t(locale, labelKey)}</span>
          </button>
        );
      })}
      {customSkins.map((skin) => {
        const label = skin.status === "ready" ? skin.name : (skin.name || skin.id.slice("custom:".length));
        const status = customSkinStatus(skin);
        return (
          <button
            key={skin.id}
            type="button"
            className="border-skin-choice border-skin-choice--custom"
            aria-label={`${label}, ${status}`}
            aria-pressed={value === skin.id}
            disabled={skin.status === "error"}
            onClick={() => skin.status === "ready" && onChange(skin.id)}
          >
            <CustomTerminalBorderSkinPreview skinId={skin.id} selected={value === skin.id} />
            <span className="border-skin-choice__label">{label}</span>
            <small role="status">{skin.status === "ready" ? status : `${status}: ${skin.error}`}</small>
          </button>
        );
      })}
      {pixelPacks.map((pack) => (
        <button
          key={pack.id}
          type="button"
          className="border-skin-choice"
          aria-pressed={value === pack.id}
          onClick={() => onChange(pack.id)}
        >
          <span className="border-skin-preview border-skin-preview--pixel" aria-hidden="true">
            <PixelSkinPackThumbnail id={pack.id} />
          </span>
          <span className="border-skin-choice__label">{pack.name}</span>
        </button>
      ))}
      <PixelSkinPackCreator locale={locale} onCreated={(pack) => {
        onPackCreated(pack);
        onChange(pack.id);
      }} />
      {selectedCustomSkinId && !selectedCustomSkin && (
        <button
          type="button"
          className="border-skin-choice border-skin-choice--custom"
          aria-label={`${selectedCustomSkinId}, ${t(locale, "borderSkinUnavailable")}`}
          aria-pressed="true"
          disabled
        >
          <CustomTerminalBorderSkinPreview skinId={selectedCustomSkinId} selected />
          <span className="border-skin-choice__label">{selectedCustomSkinId.slice("custom:".length)}</span>
          <small role="status">
            {customSkinsLoadState === "loading"
              ? t(locale, "borderSkinLoading")
              : customSkinsLoadState === "error"
                ? t(locale, "borderSkinListError")
                : t(locale, "borderSkinUnavailable")}
          </small>
        </button>
      )}
      {(isPixelSkinThemeId(value) || isPixelSkinPackId(value)) && (
        <PixelBorderSkinPreview
          key={value}
          locale={locale}
          theme={value}
        />
      )}
    </div>
  );
}

function PixelSkinPackThumbnail({ id, slot = "detailed_idle" }: { id: PixelTerminalBorderSkinId; slot?: PixelSkinSlot }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    void window.canvasTTY.pixelSkins.readAsset(id, slot).then((bytes) => {
      if (!active || !bytes) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      setUrl(objectUrl);
    }).catch(() => { if (active) setUrl(null); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, slot]);
  return url ? <img src={url} alt="" /> : <span className="border-skin-preview__fallback" />;
}

function PixelBorderSkinThumbnail({ theme }: { theme: PixelSkinThemeId }): React.JSX.Element {
  const filename = pixelSkinAssetFilename(theme, "detailed", "idle");
  const url = filename ? PILOT_SKIN_ASSETS[filename] : undefined;
  return url
    ? <img src={url} alt="" loading="lazy" />
    : <span className="border-skin-preview__fallback"><i /><i /></span>;
}

function PixelBorderSkinPreview({
  locale,
  theme,
}: {
  locale: LocaleId;
  theme: PixelSkinThemeId | PixelTerminalBorderSkinId;
}): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [detail, setDetail] = useState<Exclude<SkinDetailLevel, "overview">>("detailed");
  const [status, setStatus] = useState<Extract<SessionStatus, "idle" | "working" | "done">>("idle");
  const isRussian = locale === "ru";
  const details: readonly [Exclude<SkinDetailLevel, "overview">, string, string][] = [
    ["minimal", isRussian ? "Минимал" : "Minimal", isRussian ? "Минимал" : "Minimal"],
    ["detailed", isRussian ? "Детальная" : "Detailed", isRussian ? "Детальная" : "Detailed"],
    ["master", "Master", isRussian ? "Master — оформление оркестратора" : "Master — orchestrator appearance"]
  ];
  const states: readonly [Extract<SessionStatus, "idle" | "working" | "done">, string, string][] = [
    ["idle", isRussian ? "Ожидание" : "Idle", isRussian ? "Ожидание" : "Idle"],
    ["working", isRussian ? "Работа" : "Working", isRussian ? "Работа" : "Working"],
    ["done", isRussian ? "Готово" : "Done", isRussian ? "Готово" : "Done"]
  ];

  useLayoutEffect(() => {
    const element = previewRef.current;
    if (!element) return;
    const measure = (): void => {
      const bounds = element.getBoundingClientRect();
      setSize({ width: Math.round(bounds.width), height: Math.round(bounds.height) });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  return (
    <div className="pixel-skin-preview-tools">
      <div className="pixel-skin-preview-tools__heading">
        <strong>{isRussian ? "Режим предпросмотра" : "Preview mode"}</strong>
        <p>{isRussian ? "Переключатели ниже меняют только пример. Детализация рабочих окон задаётся в настройке «Детализация терминалов»." : "The controls below change only this example. Set live window detail in “Terminal detail”."}</p>
        <p>{isRussian ? "Minimal — простая рамка, Detailed — детальная, Master — вариант для оформления оркестратора." : "Minimal is a simple border, Detailed adds decoration, and Master is the variant for an orchestrator window."}</p>
      </div>
      <div className="pixel-skin-preview-tools__groups">
        <div className="pixel-skin-preview-tools__group" role="group" aria-label={isRussian ? "Детализация рамки" : "Border detail"}>
          {details.map(([value, label, accessibleLabel]) => (
            <button
              key={value}
              type="button"
              aria-label={accessibleLabel}
              aria-pressed={detail === value}
              className={detail === value ? "pixel-skin-preview-tools__button pixel-skin-preview-tools__button--active" : "pixel-skin-preview-tools__button"}
              onClick={() => setDetail(value)}
            >{label}</button>
          ))}
        </div>
        <div className="pixel-skin-preview-tools__group" role="group" aria-label={isRussian ? "Состояние предпросмотра" : "Preview state"}>
          {states.map(([value, label, accessibleLabel]) => (
            <button
              key={value}
              type="button"
              aria-label={accessibleLabel}
              aria-pressed={status === value}
              className={status === value ? "pixel-skin-preview-tools__button pixel-skin-preview-tools__button--active" : "pixel-skin-preview-tools__button"}
              onClick={() => setStatus(value)}
            >{label}</button>
          ))}
        </div>
      </div>
      <div
        ref={previewRef}
        className="pixel-skin-preview-stage"
        data-border-skin={theme}
        data-detail={detail}
        data-preview-state={status}
        aria-label={`${theme}, ${details.find(([value]) => value === detail)?.[2]}, ${states.find(([value]) => value === status)?.[2]}`}
      >
        <div className="pixel-skin-preview-stage__screen" aria-hidden="true">
          <span>user@canvas:~$</span><i />
          {status === "working" && <span className="pixel-skin-preview-stage__activity">&gt; {isRussian ? "Работает…" : "Working…"}</span>}
        </div>
        {size.width > 0 && size.height > 0 && (
          <Canvas2DSkinView
            theme={theme}
            status={status}
            width={size.width}
            height={size.height}
            detail={detail}
          />
        )}
      </div>
    </div>
  );
}

function CustomTerminalBorderSkinPreview({
  skinId,
  selected = false
}: {
  skinId: CustomTerminalBorderSkinId;
  selected?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={`border-skin-preview border-skin-preview--custom${selected ? " border-skin-preview--selected" : ""}`}
      data-border-skin="classic"
      data-custom-border-skin={skinId}
      aria-hidden="true"
    >
      <span className="border-skin-preview__header">
        <span className="border-skin-preview__controls"><i /><i /><i /></span>
        <span className="border-skin-preview__actions" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: ".2em" }}>
          <i className="border-skin-preview__action" />
          <i className="border-skin-preview__action" />
        </span>
      </span>
      <span className="border-skin-preview__body border-skin-preview__surface"><i /><i /><i /></span>
    </span>
  );
}

function AppSkinChoices({
  locale,
  value,
  onChange
}: {
  locale: LocaleId;
  value: AppSkinId;
  onChange(value: AppSkinId): void;
}): React.JSX.Element {
  const choices: readonly [AppSkinId, Parameters<typeof t>[1]][] = [
    ["classic", "appSkinClassic"],
    ["atelier", "appSkinAtelier"],
    ["signal", "appSkinSignal"],
    ["greenhouse", "appSkinGreenhouse"],
    ["midnight", "appSkinMidnight"]
  ];

  return (
    <div className="app-skin-choices">
      {choices.map(([skin, labelKey]) => (
        <button
          key={skin}
          type="button"
          className="app-skin-choice"
          aria-pressed={value === skin}
          onClick={() => onChange(skin)}
        >
          <span className="app-skin-preview" data-preview-skin={skin} aria-hidden="true">
            <span className="app-skin-preview__chrome"><i className="app-skin-preview__dot" /></span>
            <span className="app-skin-preview__body">
              <i className="app-skin-preview__sidebar" />
              <span className="app-skin-preview__content">
                <i className="app-skin-preview__line app-skin-preview__line--accent" />
                <i className="app-skin-preview__line" />
              </span>
            </span>
          </span>
          <span className="app-skin-choice__label">{t(locale, labelKey)}</span>
        </button>
      ))}
    </div>
  );
}

function SwatchChoices({
  value,
  options,
  columns = 5,
  onChange
}: {
  value: string;
  options: [string, string, string[]][];
  columns?: 4 | 5;
  onChange(value: string): void;
}): React.JSX.Element {
  return (
    <div className={`swatch-choices ${columns === 4 ? "swatch-choices--four" : ""}`}>
      {options.map(([optionValue, label, colors]) => (
        <button
          className={value === optionValue ? "swatch-choice swatch-choice--active" : "swatch-choice"}
          type="button"
          key={optionValue}
          aria-pressed={value === optionValue}
          onClick={() => onChange(optionValue)}
        >
          <span className="swatch-choice__preview" aria-hidden="true">
            {colors.map((color, index) => (
              <i key={`${color}-${index}`} style={{ background: color }} />
            ))}
          </span>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const commit = (): void => {
    if (/^#[0-9A-F]{6}$/i.test(draft)) {
      onChange(draft.toUpperCase());
      return;
    }
    setDraft(value);
  };

  return (
    <label className="color-field">
      <span className="color-field__label">{label}</span>
      <span className="color-field__controls">
        <span className="color-field__swatch" style={{ background: value }}>
          <input
            type="color"
            value={value}
            aria-label={label}
            onChange={(event) => onChange(event.currentTarget.value.toUpperCase())}
          />
        </span>
        <input
          className="color-field__hex"
          type="text"
          value={draft}
          maxLength={7}
          spellCheck={false}
          aria-label={`${label} HEX`}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setDraft(value);
              event.currentTarget.blur();
            }
          }}
        />
      </span>
    </label>
  );
}
