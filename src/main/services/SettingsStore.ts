import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type {
  AgentProviderId,
  AppSettings,
  BrowserCanvasState,
  CanvasLauncherItemId,
  CanvasRegion,
  CanvasColorId,
  CanvasOverlayPlacement,
  CanvasWheelCaptureMode,
  CanvasPatternId,
  EdgePanSpeed,
  FocusActivation,
  HomeAccentColors,
  HomeAccentPresetId,
  HomeGridSize,
  HomeWidgetPlacement,
  LimitProviderId,
  LocaleId,
  MediaFit,
  MinimapInteractionMode,
  PaletteId,
  PluginCanvasInstance,
  RadialLauncherItemId,
  SessionRowColorMode,
  ShortcutBindings,
  StickyNote,
  ZoomSensitivity
} from "../../shared/contracts";
import {
  CANVAS_LAUNCHER_ITEMS,
  DEFAULT_CANVAS_LAUNCHER_ITEMS,
  DEFAULT_HOME_ACCENT_COLORS,
  DEFAULT_HOME_GRID_SIZE,
  DEFAULT_HOME_LAYOUT,
  DEFAULT_RADIAL_LAUNCHER_ITEMS,
  DEFAULT_UI_SCALE,
  HOME_GRID_MAX_COLUMNS,
  HOME_GRID_MAX_ROWS,
  HOME_GRID_MIN_COLUMNS,
  HOME_GRID_MIN_ROWS,
  RADIAL_LAUNCHER_ITEMS,
  STICKY_NOTE_MAX_SIZE,
  STICKY_NOTE_MIN_SIZE,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP
} from "../../shared/contracts.ts";
import {
  canvasNavigationPlatform,
  defaultCanvasWheelBinding,
  normalizeCanvasOverrideBinding,
  type CanvasNavigationPlatform
} from "../../shared/canvasNavigation.ts";

const LOCALES = new Set<LocaleId>(["ru", "en"]);
const PALETTES = new Set<PaletteId>(["sage", "lilac", "night"]);
const HOME_ACCENT_PRESETS = new Set<HomeAccentPresetId>(["classic", "warm", "cool", "mono", "custom"]);
const SESSION_ROW_COLOR_MODES = new Set<SessionRowColorMode>(["monochrome", "status"]);
const CANVAS_COLORS = new Set<CanvasColorId>(["sage", "lilac", "night", "sand", "mist", "rose", "slate"]);
const PATTERNS = new Set<CanvasPatternId>(["dots", "grid", "waves", "diagonal", "rings", "none"]);
const MEDIA_FITS = new Set<MediaFit>(["cover", "contain"]);
const SETTINGS_VERSION = 14;
const GROK_LAUNCHER_SETTINGS_VERSION = 3;
const EXPANDED_LIMIT_SETTINGS_VERSION = 5;
const QWEN_SETTINGS_VERSION = 6;
const LEGACY_AGENT_PROVIDERS: AgentProviderId[] = ["codex", "claude", "kimi", "opencode", "hermes"];
const PRE_QWEN_AGENT_PROVIDERS: AgentProviderId[] = [...LEGACY_AGENT_PROVIDERS, "grok"];
const AGENT_PROVIDERS = new Set<AgentProviderId>(["codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok"]);
const LEGACY_LIMIT_PROVIDERS: LimitProviderId[] = ["codex", "claude", "kimi"];
const PRE_QWEN_LIMIT_PROVIDERS: LimitProviderId[] = [...LEGACY_LIMIT_PROVIDERS, "opencode", "grok"];
const LIMIT_PROVIDERS: LimitProviderId[] = ["codex", "claude", "qwen", "kimi", "opencode", "grok"];
const LIMIT_PROVIDER_SET = new Set<LimitProviderId>(LIMIT_PROVIDERS);
const CANVAS_LAUNCHER_ITEM_SET = new Set<CanvasLauncherItemId>(CANVAS_LAUNCHER_ITEMS);
const RADIAL_LAUNCHER_ITEM_SET = new Set<RadialLauncherItemId>(RADIAL_LAUNCHER_ITEMS);
const EDGE_PAN_SPEEDS = new Set<EdgePanSpeed>(["slow", "normal", "fast"]);
const ZOOM_SENSITIVITIES = new Set<ZoomSensitivity>(["slow", "normal", "fast"]);
const FOCUS_ACTIVATIONS = new Set<FocusActivation>(["off", "single", "double"]);
const CANVAS_WHEEL_CAPTURE_MODES = new Set<CanvasWheelCaptureMode>(["off", "always", "key"]);
const CANVAS_OVERLAY_PLACEMENTS = new Set<CanvasOverlayPlacement>([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right"
]);
const MINIMAP_INTERACTION_MODES = new Set<MinimapInteractionMode>(["click", "drag"]);
const SHORTCUT_MODIFIERS = new Set(["Ctrl", "Alt", "Shift", "Meta"]);
const DEFAULT_SHORTCUTS: ShortcutBindings = { home: "Home", renameWindow: "F2" };

export class SettingsStore {
  private readonly filePath: string;
  private readonly platform: CanvasNavigationPlatform;
  private value: AppSettings;
  private hasPersistedLegacyWheelCapture = false;
  private writeQueue = Promise.resolve();

  constructor(userDataPath: string, systemLocale: string, platform: string = process.platform) {
    this.filePath = join(userDataPath, "settings.json");
    this.platform = canvasNavigationPlatform(platform);
    this.value = createDefaults(systemLocale, this.platform);
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const candidate: unknown = JSON.parse(raw);
      const source = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
      const persistedLauncherProviders = Array.isArray(source.homeLauncherProviders)
        ? source.homeLauncherProviders
        : null;
      const persistedLimitProviders = Array.isArray(source.homeLimitProviders)
        ? source.homeLimitProviders
        : null;
      const persistedVersion = typeof source.settingsVersion === "number" ? source.settingsVersion : 0;
      const needsGrokLauncherMigration = persistedVersion < GROK_LAUNCHER_SETTINGS_VERSION
        && persistedLauncherProviders !== null
        && !persistedLauncherProviders.includes("grok");
      const needsExpandedLimitMigration = persistedVersion < EXPANDED_LIMIT_SETTINGS_VERSION
        && isLegacyDefaultLimitSelection(persistedLimitProviders);
      const needsQwenLauncherMigration = persistedVersion < QWEN_SETTINGS_VERSION
        && (
          isPreQwenDefaultSelection(persistedLauncherProviders, PRE_QWEN_AGENT_PROVIDERS)
          || isPreQwenDefaultSelection(persistedLauncherProviders, LEGACY_AGENT_PROVIDERS)
        );
      const needsQwenLimitMigration = persistedVersion < QWEN_SETTINGS_VERSION
        && isPreQwenDefaultSelection(persistedLimitProviders, PRE_QWEN_LIMIT_PROVIDERS);
      this.hasPersistedLegacyWheelCapture = Object.hasOwn(source, "zoomOverApplications");
      const needsMigration = !("useScrollWheelToZoom" in source)
        || !("canvasNavigationOverride" in source)
        || !("canvasWheelOverride" in source)
        || !("canvasWheelCaptureMode" in source)
        || !("homeAccentPreset" in source)
        || !("homeAccentColors" in source)
        || !("sessionRowColorMode" in source)
        || !("homeLauncherProviders" in source)
        || !("homeLimitProviders" in source)
        || !("canvasLauncherItems" in source)
        || !("radialLauncherItems" in source)
        || !("agentLifecycleHooksEnabled" in source)
        || !("uiScale" in source)
        || !("canvasColor" in source)
        || !("minimapPlacement" in source)
        || !("minimapInteractionMode" in source)
        || !("shortcutHintsPlacement" in source)
        || !("canvasControlsPlacement" in source)
        || !("restoreTerminalSessions" in source)
        || !("persistCanvasRegions" in source)
        || !("persistStickyNotes" in source)
        || !("canvasRegions" in source)
        || !("stickyNotes" in source)
        || source.canvasColor === "palette"
        || source.settingsVersion !== SETTINGS_VERSION;
      let migratedCandidate: Record<string, unknown> = source;
      if (needsGrokLauncherMigration && persistedLauncherProviders) {
        migratedCandidate = { ...migratedCandidate, homeLauncherProviders: [...persistedLauncherProviders, "grok"] };
      }
      if (needsExpandedLimitMigration) {
        migratedCandidate = { ...migratedCandidate, homeLimitProviders: [...LIMIT_PROVIDERS] };
      }
      if (needsQwenLauncherMigration && persistedLauncherProviders) {
        migratedCandidate = { ...migratedCandidate, homeLauncherProviders: [...AGENT_PROVIDERS] };
      }
      if (needsQwenLimitMigration) {
        migratedCandidate = { ...migratedCandidate, homeLimitProviders: [...LIMIT_PROVIDERS] };
      }
      this.value = normalizeSettings(migratedCandidate, {
        ...this.value,
        useScrollWheelToZoom: true
      }, this.platform);
      if (!this.value.persistCanvasRegions) this.value.canvasRegions = [];
      if (!this.value.persistStickyNotes) this.value.stickyNotes = [];
      if (needsMigration) await this.persist();
    } catch (error) {
      if (isMissingFile(error)) {
        await this.persist();
      } else {
        console.warn("CanvasTTY settings could not be loaded; defaults are used.", error);
      }
    }

    return this.get();
  }

  get(): AppSettings {
    return structuredClone(this.value);
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    if (patch.canvasWheelCaptureMode !== undefined) this.hasPersistedLegacyWheelCapture = true;
    const nextPatch = patch.canvasWheelCaptureMode === "key"
      && patch.canvasWheelOverride === undefined
      && this.value.canvasWheelOverride === null
      ? { ...patch, canvasWheelOverride: defaultCanvasWheelBinding(this.platform) }
      : patch;
    this.value = normalizeSettings({ ...this.value, ...nextPatch }, this.value, this.platform);
    await this.persist();
    return this.get();
  }

  private persist(): Promise<void> {
    const persistedValue: Partial<AppSettings> & {
      settingsVersion: number;
      zoomOverApplications?: boolean;
    } = {
      ...this.value,
      canvasRegions: this.value.persistCanvasRegions ? this.value.canvasRegions : [],
      stickyNotes: this.value.persistStickyNotes ? this.value.stickyNotes : [],
      settingsVersion: SETTINGS_VERSION
    };
    if (this.hasPersistedLegacyWheelCapture) {
      persistedValue.zoomOverApplications = this.value.canvasWheelCaptureMode === "always";
    }
    const snapshot = JSON.stringify(persistedValue, null, 2);
    const temporaryPath = `${this.filePath}.tmp`;

    const write = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, snapshot, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = write;

    return write;
  }
}

function isLegacyDefaultLimitSelection(candidate: unknown[] | null): boolean {
  return candidate !== null
    && candidate.length === LEGACY_LIMIT_PROVIDERS.length
    && LEGACY_LIMIT_PROVIDERS.every((provider) => candidate.includes(provider));
}

function isPreQwenDefaultSelection<T extends string>(candidate: unknown[] | null, providers: readonly T[]): boolean {
  return candidate !== null
    && candidate.length === providers.length
    && providers.every((provider) => candidate.includes(provider));
}

function createDefaults(systemLocale: string, platform: CanvasNavigationPlatform): AppSettings {
  return {
    locale: systemLocale.toLowerCase().startsWith("ru") ? "ru" : "en",
    restoreTerminalSessions: false,
    persistCanvasRegions: true,
    persistStickyNotes: true,
    palette: "sage",
    homeAccentPreset: "classic",
    homeAccentColors: { ...DEFAULT_HOME_ACCENT_COLORS },
    sessionRowColorMode: "status",
    homeLauncherProviders: [...AGENT_PROVIDERS],
    homeLimitProviders: [...LIMIT_PROVIDERS],
    canvasLauncherItems: [...DEFAULT_CANVAS_LAUNCHER_ITEMS],
    radialLauncherItems: [...DEFAULT_RADIAL_LAUNCHER_ITEMS],
    agentLifecycleHooksEnabled: true,
    uiScale: DEFAULT_UI_SCALE,
    canvasColor: "sage",
    pattern: "dots",
    snapToGrid: true,
    invertTerminalWheel: true,
    invertCanvasWheel: false,
    edgePan: false,
    edgePanSpeed: "normal",
    zoomSensitivity: "normal",
    useScrollWheelToZoom: false,
    canvasWheelCaptureMode: "key",
    canvasWheelOverride: defaultCanvasWheelBinding(platform),
    canvasNavigationOverride: "Alt",
    focusActivation: "off",
    hoverFocus: false,
    hoverFocusSpeed: "normal",
    showShortcutHints: true,
    minimapPlacement: "top-right",
    minimapInteractionMode: "click",
    shortcutHintsPlacement: "bottom-right",
    canvasControlsPlacement: "bottom-left",
    shortcuts: { ...DEFAULT_SHORTCUTS },
    mediaPath: null,
    mediaFit: "cover",
    lastDirectory: homedir(),
    acknowledgedDangerousProfiles: [],
    homeGridSize: { ...DEFAULT_HOME_GRID_SIZE },
    homeLayout: structuredClone(DEFAULT_HOME_LAYOUT),
    canvasRegions: [],
    stickyNotes: [],
    pluginCanvas: [],
    browserCanvas: null,
    browserAgentAccess: true,
    browserShowAgentPresence: true,
    browserRestoreTabs: true
  };
}

export function normalizeSettings(
  candidate: unknown,
  fallback: AppSettings,
  platform: CanvasNavigationPlatform = canvasNavigationPlatform(process.platform)
): AppSettings {
  if (!candidate || typeof candidate !== "object") {
    return fallback;
  }

  const source = candidate as Partial<AppSettings> & { zoomOverApplications?: unknown };
  const mediaPath = source.mediaPath === null || typeof source.mediaPath === "string"
    ? source.mediaPath
    : fallback.mediaPath;
  const acknowledged = Array.isArray(source.acknowledgedDangerousProfiles)
    ? source.acknowledgedDangerousProfiles.filter(
      (provider): provider is AgentProviderId => AGENT_PROVIDERS.has(provider as AgentProviderId)
    )
    : fallback.acknowledgedDangerousProfiles;
  const shortcuts = normalizeShortcuts(source.shortcuts, fallback.shortcuts);
  const navigationOverrideCandidate = source.canvasNavigationOverride === undefined
    ? fallback.canvasNavigationOverride
    : source.canvasNavigationOverride;
  const canvasNavigationOverride = navigationOverrideCandidate === null
    ? null
    : normalizeCanvasOverrideBinding(
      navigationOverrideCandidate,
      Object.values(shortcuts)
    );
  const wheelCapture = normalizeCanvasWheelCapture(source, fallback, platform, Object.values(shortcuts));
  const homeGridSize = normalizeHomeGridSize(
    source.homeGridSize,
    fallback.homeGridSize ?? DEFAULT_HOME_GRID_SIZE
  );
  const homeLayout = normalizeHomeLayout(
    source.homeLayout,
    fallback.homeLayout ?? DEFAULT_HOME_LAYOUT,
    homeGridSize
  );
  const pluginCanvas = normalizePluginCanvas(source.pluginCanvas, fallback.pluginCanvas ?? []);
  const canvasRegions = normalizeCanvasRegions(source.canvasRegions, fallback.canvasRegions ?? []);
  const stickyNotes = normalizeStickyNotes(source.stickyNotes, fallback.stickyNotes ?? []);
  const browserCanvas = normalizeBrowserCanvas(source.browserCanvas, fallback.browserCanvas ?? null);
  const homeAccentColors = normalizeHomeAccentColors(
    source.homeAccentColors,
    fallback.homeAccentColors ?? DEFAULT_HOME_ACCENT_COLORS
  );
  const homeLauncherProviders = normalizeAgentProviderSelection(
    source.homeLauncherProviders,
    fallback.homeLauncherProviders ?? [...AGENT_PROVIDERS]
  );
  const homeLimitProviders = normalizeLimitProviderSelection(
    source.homeLimitProviders,
    fallback.homeLimitProviders ?? LIMIT_PROVIDERS
  );
  const canvasLauncherItems = normalizeCanvasLauncherItems(
    source.canvasLauncherItems,
    fallback.canvasLauncherItems ?? DEFAULT_CANVAS_LAUNCHER_ITEMS
  );
  const radialLauncherItems = normalizeRadialLauncherItems(
    source.radialLauncherItems,
    fallback.radialLauncherItems ?? DEFAULT_RADIAL_LAUNCHER_ITEMS
  );
  const palette = PALETTES.has(source.palette as PaletteId) ? source.palette as PaletteId : fallback.palette;
  const canvasColorCandidate = (source as Record<string, unknown>).canvasColor;
  const canvasColor = canvasColorCandidate === undefined || canvasColorCandidate === "palette"
    ? palette
    : CANVAS_COLORS.has(canvasColorCandidate as CanvasColorId)
      ? canvasColorCandidate as CanvasColorId
      : fallback.canvasColor;

  return {
    locale: LOCALES.has(source.locale as LocaleId) ? source.locale as LocaleId : fallback.locale,
    restoreTerminalSessions: typeof source.restoreTerminalSessions === "boolean"
      ? source.restoreTerminalSessions
      : fallback.restoreTerminalSessions ?? false,
    persistCanvasRegions: typeof source.persistCanvasRegions === "boolean"
      ? source.persistCanvasRegions
      : fallback.persistCanvasRegions ?? true,
    persistStickyNotes: typeof source.persistStickyNotes === "boolean"
      ? source.persistStickyNotes
      : fallback.persistStickyNotes ?? true,
    palette,
    homeAccentPreset: HOME_ACCENT_PRESETS.has(source.homeAccentPreset as HomeAccentPresetId)
      ? source.homeAccentPreset as HomeAccentPresetId
      : fallback.homeAccentPreset,
    homeAccentColors,
    sessionRowColorMode: SESSION_ROW_COLOR_MODES.has(source.sessionRowColorMode as SessionRowColorMode)
      ? source.sessionRowColorMode as SessionRowColorMode
      : fallback.sessionRowColorMode ?? "status",
    homeLauncherProviders,
    homeLimitProviders,
    canvasLauncherItems,
    radialLauncherItems,
    agentLifecycleHooksEnabled: typeof source.agentLifecycleHooksEnabled === "boolean"
      ? source.agentLifecycleHooksEnabled
      : fallback.agentLifecycleHooksEnabled,
    uiScale: normalizeUiScale(source.uiScale, fallback.uiScale ?? DEFAULT_UI_SCALE),
    canvasColor,
    pattern: PATTERNS.has(source.pattern as CanvasPatternId)
      ? source.pattern as CanvasPatternId
      : fallback.pattern,
    snapToGrid: typeof source.snapToGrid === "boolean" ? source.snapToGrid : fallback.snapToGrid,
    invertTerminalWheel: typeof source.invertTerminalWheel === "boolean"
      ? source.invertTerminalWheel
      : fallback.invertTerminalWheel,
    invertCanvasWheel: typeof source.invertCanvasWheel === "boolean"
      ? source.invertCanvasWheel
      : fallback.invertCanvasWheel,
    edgePan: typeof source.edgePan === "boolean" ? source.edgePan : fallback.edgePan,
    edgePanSpeed: EDGE_PAN_SPEEDS.has(source.edgePanSpeed as EdgePanSpeed)
      ? source.edgePanSpeed as EdgePanSpeed
      : fallback.edgePanSpeed,
    zoomSensitivity: ZOOM_SENSITIVITIES.has(source.zoomSensitivity as ZoomSensitivity)
      ? source.zoomSensitivity as ZoomSensitivity
      : fallback.zoomSensitivity,
    useScrollWheelToZoom: typeof source.useScrollWheelToZoom === "boolean"
      ? source.useScrollWheelToZoom
      : fallback.useScrollWheelToZoom,
    canvasWheelCaptureMode: wheelCapture.mode,
    canvasWheelOverride: wheelCapture.binding,
    canvasNavigationOverride,
    focusActivation: FOCUS_ACTIVATIONS.has(source.focusActivation as FocusActivation)
      ? source.focusActivation as FocusActivation
      : fallback.focusActivation,
    hoverFocus: typeof source.hoverFocus === "boolean" ? source.hoverFocus : fallback.hoverFocus,
    hoverFocusSpeed: EDGE_PAN_SPEEDS.has(source.hoverFocusSpeed as EdgePanSpeed)
      ? source.hoverFocusSpeed as EdgePanSpeed
      : fallback.hoverFocusSpeed,
    showShortcutHints: typeof source.showShortcutHints === "boolean"
      ? source.showShortcutHints
      : fallback.showShortcutHints,
    minimapPlacement: normalizeCanvasOverlayPlacement(source.minimapPlacement, fallback.minimapPlacement),
    minimapInteractionMode: MINIMAP_INTERACTION_MODES.has(
      source.minimapInteractionMode as MinimapInteractionMode
    )
      ? source.minimapInteractionMode as MinimapInteractionMode
      : fallback.minimapInteractionMode,
    shortcutHintsPlacement: normalizeCanvasOverlayPlacement(
      source.shortcutHintsPlacement,
      fallback.shortcutHintsPlacement
    ),
    canvasControlsPlacement: normalizeCanvasOverlayPlacement(
      source.canvasControlsPlacement,
      fallback.canvasControlsPlacement
    ),
    shortcuts,
    mediaPath,
    mediaFit: MEDIA_FITS.has(source.mediaFit as MediaFit) ? source.mediaFit as MediaFit : fallback.mediaFit,
    lastDirectory: typeof source.lastDirectory === "string" && source.lastDirectory.length > 0
      ? source.lastDirectory
      : fallback.lastDirectory,
    acknowledgedDangerousProfiles: [...new Set(acknowledged)],
    homeGridSize,
    homeLayout,
    canvasRegions,
    stickyNotes,
    pluginCanvas,
    browserCanvas,
    browserAgentAccess: typeof source.browserAgentAccess === "boolean"
      ? source.browserAgentAccess
      : fallback.browserAgentAccess,
    browserShowAgentPresence: typeof source.browserShowAgentPresence === "boolean"
      ? source.browserShowAgentPresence
      : fallback.browserShowAgentPresence,
    browserRestoreTabs: typeof source.browserRestoreTabs === "boolean"
      ? source.browserRestoreTabs
      : fallback.browserRestoreTabs
  };
}

export function normalizeCanvasLauncherItems(
  candidate: unknown,
  fallback: readonly CanvasLauncherItemId[] = DEFAULT_CANVAS_LAUNCHER_ITEMS
): CanvasLauncherItemId[] {
  if (!Array.isArray(candidate)) return [...fallback];
  const result: CanvasLauncherItemId[] = [];
  for (const item of candidate) {
    if (typeof item !== "string" || !CANVAS_LAUNCHER_ITEM_SET.has(item as CanvasLauncherItemId)) continue;
    if (!result.includes(item as CanvasLauncherItemId)) result.push(item as CanvasLauncherItemId);
  }
  return result.length > 0 ? result : [...fallback];
}

export function normalizeRadialLauncherItems(
  candidate: unknown,
  fallback: readonly RadialLauncherItemId[] = DEFAULT_RADIAL_LAUNCHER_ITEMS
): RadialLauncherItemId[] {
  if (!Array.isArray(candidate)) return [...fallback];
  const result: RadialLauncherItemId[] = [];
  for (const item of candidate) {
    if (typeof item !== "string" || !RADIAL_LAUNCHER_ITEM_SET.has(item as RadialLauncherItemId)) continue;
    if (!result.includes(item as RadialLauncherItemId)) result.push(item as RadialLauncherItemId);
    if (result.length === 8) break;
  }
  return result.length > 0 ? result : [...fallback];
}

export function normalizeUiScale(candidate: unknown, fallback = DEFAULT_UI_SCALE): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return fallback;
  const stepped = Math.round(candidate / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Number(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped)).toFixed(2));
}

function normalizeCanvasOverlayPlacement(
  candidate: unknown,
  fallback: CanvasOverlayPlacement
): CanvasOverlayPlacement {
  return CANVAS_OVERLAY_PLACEMENTS.has(candidate as CanvasOverlayPlacement)
    ? candidate as CanvasOverlayPlacement
    : fallback;
}

function normalizeHomeAccentColors(candidate: unknown, fallback: HomeAccentColors): HomeAccentColors {
  const source = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Partial<HomeAccentColors>
    : {};
  return {
    clock: normalizeHexColor(source.clock, fallback.clock),
    launcher: normalizeHexColor(source.launcher, fallback.launcher),
    browser: normalizeHexColor(source.browser, fallback.browser),
    settings: normalizeHexColor(source.settings, fallback.settings),
    media: normalizeHexColor(source.media, fallback.media)
  };
}

function normalizeAgentProviderSelection(
  candidate: unknown,
  fallback: AgentProviderId[]
): AgentProviderId[] {
  if (!Array.isArray(candidate)) return [...fallback];
  const selected = new Set(candidate.filter((provider): provider is AgentProviderId => (
    typeof provider === "string" && AGENT_PROVIDERS.has(provider as AgentProviderId)
  )));
  return [...AGENT_PROVIDERS].filter((provider) => selected.has(provider));
}

function normalizeLimitProviderSelection(
  candidate: unknown,
  fallback: LimitProviderId[]
): LimitProviderId[] {
  if (!Array.isArray(candidate)) return [...fallback];
  const selected = new Set(candidate.filter((provider): provider is LimitProviderId => (
    typeof provider === "string" && LIMIT_PROVIDER_SET.has(provider as LimitProviderId)
  )));
  return LIMIT_PROVIDERS.filter((provider) => selected.has(provider));
}

function normalizeHexColor(candidate: unknown, fallback: string): string {
  return typeof candidate === "string" && /^#[0-9A-F]{6}$/i.test(candidate)
    ? candidate.toUpperCase()
    : fallback;
}

function normalizeCanvasWheelCapture(
  source: Partial<AppSettings> & { zoomOverApplications?: unknown },
  fallback: AppSettings,
  platform: CanvasNavigationPlatform,
  actionShortcuts: readonly string[]
): { mode: CanvasWheelCaptureMode; binding: string | null } {
  const hasMode = Object.hasOwn(source, "canvasWheelCaptureMode");
  const requestedMode = CANVAS_WHEEL_CAPTURE_MODES.has(source.canvasWheelCaptureMode as CanvasWheelCaptureMode)
    ? source.canvasWheelCaptureMode as CanvasWheelCaptureMode
    : null;
  const hasBinding = Object.hasOwn(source, "canvasWheelOverride");
  const rawBinding = source.canvasWheelOverride;
  const normalizedSourceBinding = rawBinding === null || rawBinding === undefined
    ? null
    : normalizeCanvasOverrideBinding(rawBinding, actionShortcuts);
  const invalidSourceBinding = hasBinding && rawBinding !== null && rawBinding !== undefined
    && normalizedSourceBinding === null;

  if (hasMode && requestedMode !== null) {
    const binding = hasBinding ? normalizedSourceBinding : fallback.canvasWheelOverride;
    if (requestedMode === "key" && binding === null) return { mode: "off", binding: null };
    return { mode: requestedMode, binding };
  }

  if (typeof source.zoomOverApplications === "boolean") {
    if (source.zoomOverApplications) {
      return {
        mode: "always",
        binding: normalizedSourceBinding ?? defaultCanvasWheelBinding(platform)
      };
    }
    return normalizedSourceBinding === null
      ? { mode: "off", binding: null }
      : { mode: "key", binding: normalizedSourceBinding };
  }

  if (invalidSourceBinding) return { mode: "off", binding: null };
  const binding = normalizedSourceBinding ?? fallback.canvasWheelOverride ?? defaultCanvasWheelBinding(platform);
  const mode = requestedMode ?? fallback.canvasWheelCaptureMode;
  return mode === "key" && binding === null
    ? { mode: "off", binding: null }
    : { mode, binding };
}

export function normalizeHomeLayout(
  candidate: unknown,
  fallback: readonly HomeWidgetPlacement[] = DEFAULT_HOME_LAYOUT,
  gridSize: HomeGridSize = DEFAULT_HOME_GRID_SIZE
): HomeWidgetPlacement[] {
  if (!Array.isArray(candidate)) return fallback.map((placement) => structuredClone(placement));

  const placements: HomeWidgetPlacement[] = [];
  const widgetIds = new Set<string>();
  for (const value of candidate.slice(0, 64)) {
    if (!value || typeof value !== "object") continue;
    const source = value as Partial<HomeWidgetPlacement>;
    if (!isWidgetId(source.widgetId) || widgetIds.has(source.widgetId)) continue;
    if (![source.column, source.row, source.columnSpan, source.rowSpan].every(Number.isInteger)) continue;

    const placement: HomeWidgetPlacement = {
      widgetId: source.widgetId,
      column: source.column!,
      row: source.row!,
      columnSpan: source.columnSpan!,
      rowSpan: source.rowSpan!
    };
    if (!isPlacementInsideGrid(placement, gridSize) || placements.some((current) => placementsOverlap(current, placement))) {
      continue;
    }
    placements.push(placement);
    widgetIds.add(placement.widgetId);
  }

  const settingsPlacement = placements.find((placement) => placement.widgetId === "core.settings");
  if (!settingsPlacement) {
    const defaultSettings = DEFAULT_HOME_LAYOUT.find((placement) => placement.widgetId === "core.settings")!;
    const withoutCollision = placements.filter((placement) => !placementsOverlap(placement, defaultSettings));
    return [...withoutCollision, structuredClone(defaultSettings)];
  }
  return placements;
}

export function normalizeHomeGridSize(
  candidate: unknown,
  fallback: HomeGridSize = DEFAULT_HOME_GRID_SIZE
): HomeGridSize {
  if (!candidate || typeof candidate !== "object") return { ...fallback };
  const source = candidate as Partial<HomeGridSize>;
  if (!Number.isInteger(source.columns) || !Number.isInteger(source.rows)) return { ...fallback };
  return {
    columns: clamp(source.columns!, HOME_GRID_MIN_COLUMNS, HOME_GRID_MAX_COLUMNS),
    rows: clamp(source.rows!, HOME_GRID_MIN_ROWS, HOME_GRID_MAX_ROWS)
  };
}

function normalizePluginCanvas(candidate: unknown, fallback: readonly PluginCanvasInstance[]): PluginCanvasInstance[] {
  if (!Array.isArray(candidate)) return fallback.map((instance) => structuredClone(instance));

  const instances: PluginCanvasInstance[] = [];
  const ids = new Set<string>();
  for (const value of candidate.slice(0, 64)) {
    if (!value || typeof value !== "object") continue;
    const source = value as Partial<PluginCanvasInstance>;
    if (!isInstanceId(source.id) || ids.has(source.id)) continue;
    if (!isPluginId(source.pluginId) || !isContributionId(source.contributionId)) continue;
    if (typeof source.title !== "string" || source.title.trim().length === 0) continue;
    if (!isFinitePoint(source.position) || !isFiniteSize(source.size)) continue;
    instances.push({
      id: source.id,
      pluginId: source.pluginId,
      contributionId: source.contributionId,
      title: source.title.trim().slice(0, 80),
      position: { x: source.position.x, y: source.position.y },
      size: {
        width: clamp(source.size.width, 240, 1_600),
        height: clamp(source.size.height, 140, 1_100)
      }
    });
    ids.add(source.id);
  }
  return instances;
}

export function normalizeCanvasRegions(
  candidate: unknown,
  fallback: readonly CanvasRegion[] = []
): CanvasRegion[] {
  if (!Array.isArray(candidate)) return fallback.map((region) => structuredClone(region));

  const regions: CanvasRegion[] = [];
  const ids = new Set<string>();
  for (const value of candidate.slice(0, 32)) {
    if (!value || typeof value !== "object") continue;
    const source = value as Partial<CanvasRegion>;
    if (!isInstanceId(source.id) || ids.has(source.id)) continue;
    if (typeof source.title !== "string" || source.title.trim().length === 0) continue;
    if (!isFinitePoint(source.position) || !isFiniteSize(source.size)) continue;
    if (typeof source.color !== "string" || !/^#[0-9A-F]{6}$/i.test(source.color)) continue;
    regions.push({
      id: source.id,
      title: source.title.trim().slice(0, 80),
      color: source.color.toUpperCase(),
      position: { x: source.position.x, y: source.position.y },
      size: {
        width: clamp(source.size.width, 360, 4_000),
        height: clamp(source.size.height, 240, 3_000)
      }
    });
    ids.add(source.id);
  }
  return regions;
}

// Adapted from @TroopJostle's sticky-note persistence work in PR #23.
export function normalizeStickyNotes(
  candidate: unknown,
  fallback: readonly StickyNote[] = []
): StickyNote[] {
  if (!Array.isArray(candidate)) return fallback.map((note) => structuredClone(note));

  const notes: StickyNote[] = [];
  const ids = new Set<string>();
  for (const value of candidate) {
    if (notes.length >= 128) break;
    if (!value || typeof value !== "object") continue;
    const source = value as Partial<StickyNote>;
    if (!isInstanceId(source.id) || ids.has(source.id)) continue;
    if (typeof source.text !== "string" || !isFinitePoint(source.position) || !isFiniteSize(source.size)) continue;
    notes.push({
      id: source.id,
      text: source.text.slice(0, 20_000),
      position: { x: source.position.x, y: source.position.y },
      size: {
        width: clamp(source.size.width, STICKY_NOTE_MIN_SIZE.width, STICKY_NOTE_MAX_SIZE.width),
        height: clamp(source.size.height, STICKY_NOTE_MIN_SIZE.height, STICKY_NOTE_MAX_SIZE.height)
      }
    });
    ids.add(source.id);
  }
  return notes;
}

function normalizeBrowserCanvas(candidate: unknown, fallback: BrowserCanvasState | null): BrowserCanvasState | null {
  if (candidate === null) return null;
  if (!candidate || typeof candidate !== "object") return fallback ? structuredClone(fallback) : null;
  const source = candidate as Partial<BrowserCanvasState>;
  if (!isFinitePoint(source.position) || !isFiniteSize(source.size)) {
    return fallback ? structuredClone(fallback) : null;
  }
  return {
    position: { x: source.position.x, y: source.position.y },
    size: {
      width: clamp(source.size.width, 560, 1_600),
      height: clamp(source.size.height, 380, 1_100)
    }
  };
}

function normalizeShortcuts(candidate: unknown, fallback: ShortcutBindings): ShortcutBindings {
  const source = candidate && typeof candidate === "object"
    ? candidate as Partial<ShortcutBindings>
    : {};
  const shortcuts = {
    home: isValidShortcut(source.home) ? source.home : fallback.home,
    renameWindow: isValidShortcut(source.renameWindow) ? source.renameWindow : fallback.renameWindow
  };

  if (shortcuts.home.toLowerCase() === shortcuts.renameWindow.toLowerCase()) {
    return { ...fallback };
  }
  return shortcuts;
}

function isValidShortcut(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return false;
  const parts = value.split("+");
  if (parts.some((part) => part.length === 0) || new Set(parts).size !== parts.length) return false;
  const key = parts.at(-1);
  if (!key || parts.slice(0, -1).some((part) => !SHORTCUT_MODIFIERS.has(part))) return false;
  return /^[A-Z0-9]$/i.test(key)
    || /^F(?:[1-9]|1\d|2[0-4])$/.test(key)
    || /^Mouse[345]$/.test(key)
    || new Set([
      "Home", "End", "PageUp", "PageDown", "Space", "Enter", "Escape", "Tab",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Insert", "Backspace"
    ]).has(key);
}

function isWidgetId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 160) return false;
  if (/^core\.(?:limits|sessions|clock|media|launcher|settings)$/.test(value)) return true;
  const match = value.match(/^plugin:([^:]+):([^:]+)$/);
  return Boolean(match && isPluginId(match[1]) && isContributionId(match[2]));
}

function isPluginId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 80
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value);
}

function isContributionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value);
}

function isInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(value);
}

function isFinitePoint(value: unknown): value is { x: number; y: number } {
  return Boolean(
    value
    && typeof value === "object"
    && "x" in value
    && "y" in value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
  );
}

function isFiniteSize(value: unknown): value is { width: number; height: number } {
  return Boolean(
    value
    && typeof value === "object"
    && "width" in value
    && "height" in value
    && Number.isFinite(value.width)
    && Number.isFinite(value.height)
  );
}

function isPlacementInsideGrid(placement: HomeWidgetPlacement, gridSize: HomeGridSize): boolean {
  return placement.column >= 0
    && placement.row >= 0
    && placement.columnSpan > 0
    && placement.rowSpan > 0
    && placement.column + placement.columnSpan <= gridSize.columns
    && placement.row + placement.rowSpan <= gridSize.rows;
}

function placementsOverlap(left: HomeWidgetPlacement, right: HomeWidgetPlacement): boolean {
  return left.column < right.column + right.columnSpan
    && left.column + left.columnSpan > right.column
    && left.row < right.row + right.rowSpan
    && left.row + left.rowSpan > right.row;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
