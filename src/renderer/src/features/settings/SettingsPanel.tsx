import { useEffect, useState } from "react";
import type {
  AppSettings,
  BrowserActivityEvent,
  BrowserCommandType,
  BrowserDownloadSnapshot,
  BrowserSnapshot,
  CanvasLauncherItemId,
  CanvasColorId,
  CanvasOverlayPlacement,
  CanvasPatternId,
  CanvasWheelCaptureMode,
  EdgePanSpeed,
  FocusActivation,
  GithubPluginSearchResult,
  HomeAccentColors,
  HomeAccentPresetId,
  InstalledPlugin,
  LimitProviderId,
  LocaleId,
  MinimapInteractionMode,
  PaletteId,
  PluginContribution,
  PluginGridSize,
  PluginManifest,
  PluginInstallPreview,
  PluginUpdateStatus,
  RadialLauncherItemId,
  SessionRowColorMode,
  ShortcutAction,
  ZoomSensitivity
} from "../../../../shared/contracts";
import {
  BROWSER_PROVIDER_COLORS,
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
import { t } from "../../lib/i18n";
import { PluginSettingsSection } from "../plugins/PluginSettingsSection";
import { HomeAppearanceSettings } from "../home/HomeAppearanceSettings";
import {
  canvasColorPatch,
  homeAccentPresetPatch,
  resolveAppearanceSettings
} from "./appearanceSettings";
import { CanvasNavigationShortcutEditor } from "./CanvasNavigationShortcutEditor";
import { AgentHooksSettings } from "./AgentHooksSettings";
import { AboutSettings } from "./AboutSettings";
import { setCanvasLauncherItemEnabled } from "../launcher/canvasLauncher";
import { itemLabel } from "../launcher/QuickRadialMenu";
import { setRadialLauncherItemEnabled } from "../launcher/radialLauncher";

type SettingsSection = "general" | "appearance" | "agents" | "controls" | "browser" | "plugins" | "about";

const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  icon: UiIconName;
}> = [
  { id: "general", icon: "app-window" },
  { id: "appearance", icon: "palette" },
  { id: "agents", icon: "terminal" },
  { id: "controls", icon: "sliders-horizontal" },
  { id: "browser", icon: "browser" },
  { id: "plugins", icon: "blocks" },
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

interface SettingsPanelProps {
  open: boolean;
  settings: AppSettings;
  plugins: InstalledPlugin[];
  browser: BrowserSnapshot;
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
  onUninstallPlugin(pluginId: string): Promise<void>;
  onOpenPluginContribution(plugin: InstalledPlugin, contribution: PluginContribution): Promise<void>;
  onToggleHomeWidget(widgetId: string, size: PluginGridSize): Promise<void>;
  onEditHome(): void;
  onOpenBrowser(url?: string): Promise<void>;
}

export function SettingsPanel({
  open,
  settings,
  plugins,
  browser,
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
  const [section, setSection] = useState<SettingsSection>("general");
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [activity, setActivity] = useState<BrowserActivityEvent[]>([]);
  const [activityState, setActivityState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearingBrowserData, setClearingBrowserData] = useState(false);
  const [browserDataMessage, setBrowserDataMessage] = useState<string | null>(null);

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
    const conflict = Object.entries(settings.shortcuts).find(
      ([candidateAction, value]) => candidateAction !== action && value.toLowerCase() === shortcut.toLowerCase()
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
    await onChange({ shortcuts: { ...settings.shortcuts, [action]: shortcut } });
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
                onClick={() => setSection(id)}
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
                label={t(locale, "terminalSessionRestore")}
                description={t(locale, "terminalSessionRestoreDescription")}
              >
                <Segmented
                  value={settings.restoreTerminalSessions ? "save" : "discard"}
                  options={[["discard", t(locale, "doNotSave")], ["save", t(locale, "saveAndContinue")]]}
                  onChange={(value) => void onChange({ restoreTerminalSessions: value === "save" })}
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
              <SettingGroup label={t(locale, "canvasColor")}>
                <SwatchChoices
                  value={appearance.canvasColor}
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
                  onChange={(value) => void onChange(canvasColorPatch(value as CanvasColorId))}
                />
              </SettingGroup>
              <SettingGroup label={t(locale, "canvasPattern")}>
                <Segmented
                  value={settings.pattern}
                  options={(["dots", "grid", "waves", "diagonal", "rings", "none"] as CanvasPatternId[]).map((value) => [value, t(locale, value)])}
                  wrap
                  onChange={(value) => void onChange({ pattern: value as CanvasPatternId })}
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
              <AgentHooksSettings
                settings={settings}
                plugins={plugins}
                onChange={onChange}
                onSetPluginHookEnabled={onSetPluginHookEnabled}
              />
              <SettingGroup
                layout="stacked"
                label={t(locale, "canvasLauncherItems")}
                description={t(locale, "canvasLauncherItemsDescription")}
              >
                <div className="canvas-menu canvas-launcher-settings-menu">
                  <CanvasMenuLabel>{t(locale, "canvasLauncherSettingsLabel")}</CanvasMenuLabel>
                  {CANVAS_LAUNCHER_ITEMS.map((item: CanvasLauncherItemId) => {
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
                      >{PROVIDERS[item].label}</CanvasMenuRow>
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
                <div className="canvas-menu canvas-launcher-settings-menu">
                  <CanvasMenuLabel>{t(locale, "quickLauncherCount").replace("{count}", String(settings.radialLauncherItems.length))}</CanvasMenuLabel>
                  {RADIAL_LAUNCHER_ITEMS.map((item: RadialLauncherItemId) => {
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
                      >{itemLabel(locale, item)}</CanvasMenuRow>
                    );
                  })}
                  <CanvasMenuDivider />
                  <CanvasMenuRow
                    icon="home"
                    muted
                    onClick={() => void onChange({ radialLauncherItems: [...DEFAULT_RADIAL_LAUNCHER_ITEMS] })}
                  >{t(locale, "useDefaults")}</CanvasMenuRow>
                </div>
              </SettingGroup>
              <SettingGroup
                layout="stacked"
                label={t(locale, "homeLauncherAgents")}
                description={t(locale, "homeLauncherAgentsDescription")}
              >
                <div className="agent-launcher-settings">
                  {AGENT_PROVIDERS.map((provider) => {
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
            </>
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
              <SettingGroup
                label={t(locale, "canvasWheelCapture")}
                description={t(locale, "canvasWheelCaptureDescription")}
              >
                <Segmented
                  value={settings.canvasWheelCaptureMode}
                  options={[["off", "Off"], ["always", "On"], ["key", "Key"]]}
                  onChange={(value) => changeCanvasWheelCaptureMode(value as CanvasWheelCaptureMode)}
                />
                {settings.canvasWheelCaptureMode === "key" && (
                  <CanvasNavigationShortcutEditor
                    open={open}
                    locale={locale}
                    label={t(locale, "canvasWheelOverride")}
                    binding={settings.canvasWheelOverride}
                    actionShortcuts={Object.values(settings.shortcuts)}
                    allowDisable={false}
                    onCaptureStart={() => {
                      setCapturing(null);
                      setShortcutError(null);
                    }}
                    onChange={(canvasWheelOverride) => onChange({ canvasWheelOverride })}
                  />
                )}
                {canvasOverrideBindingsMatch && (
                  <p className="shortcut-editor__warning">{t(locale, "canvasOverrideBindingsMatch")}</p>
                )}
              </SettingGroup>
              <SettingGroup
                label={t(locale, "canvasNavigationOverride")}
                description={t(locale, "canvasNavigationOverrideDescription")}
              >
                <CanvasNavigationShortcutEditor
                  open={open}
                  locale={locale}
                  label={t(locale, "canvasNavigationOverride")}
                  binding={settings.canvasNavigationOverride}
                  actionShortcuts={Object.values(settings.shortcuts)}
                  allowDisable
                  onCaptureStart={() => {
                    setCapturing(null);
                    setShortcutError(null);
                  }}
                  onChange={(canvasNavigationOverride) => onChange({ canvasNavigationOverride })}
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
              <SettingGroup label={t(locale, "homeShortcut")} description={t(locale, "homeShortcutDescription")}>
                <ShortcutRow
                  label={t(locale, "shortcutBinding")}
                  value={settings.shortcuts.home}
                  capturing={capturing === "home"}
                  onStart={() => {
                    setShortcutError(null);
                    setCapturing("home");
                  }}
                  onKeyDown={(event) => captureShortcut("home", event)}
                  onPointerDown={(event) => capturePointerShortcut("home", event)}
                />
                {shortcutError && capturing === "home" && (
                  <p className="shortcut-editor__error" role="alert">{shortcutError}</p>
                )}
              </SettingGroup>
              <SettingGroup label={t(locale, "renameWindow")} description={t(locale, "renameWindowDescription")}>
                <ShortcutRow
                  label={t(locale, "shortcutBinding")}
                  value={settings.shortcuts.renameWindow}
                  capturing={capturing === "renameWindow"}
                  onStart={() => {
                    setShortcutError(null);
                    setCapturing("renameWindow");
                  }}
                  onKeyDown={(event) => captureShortcut("renameWindow", event)}
                  onPointerDown={(event) => capturePointerShortcut("renameWindow", event)}
                />
                {shortcutError && capturing === "renameWindow" && (
                  <p className="shortcut-editor__error" role="alert">{shortcutError}</p>
                )}
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
  onPointerDown
}: {
  label: string;
  value: string;
  capturing: boolean;
  onStart(): void;
  onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void;
  onPointerDown(event: React.PointerEvent<HTMLButtonElement>): void;
}): React.JSX.Element {
  return (
    <div className="shortcut-editor__row">
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
  onChange
}: {
  value: string;
  options: [string, string][];
  wrap?: boolean;
  onChange(value: string): void;
}): React.JSX.Element {
  return (
    <div className={`segmented ${wrap ? "segmented--wrap" : ""}`}>
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
