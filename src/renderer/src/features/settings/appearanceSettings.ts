import type {
  AppSettings,
  CanvasColorId,
  HomeAccentColors,
  HomeAccentPresetId
} from "../../../../shared/contracts";
import { DEFAULT_HOME_ACCENT_COLORS } from "../../../../shared/contracts.ts";

export interface ResolvedAppearanceSettings {
  homeAccentPreset: HomeAccentPresetId;
  homeAccentColors: HomeAccentColors;
  canvasColor: CanvasColorId;
}

export function resolveAppearanceSettings(
  settings: Omit<Pick<Partial<AppSettings>, "palette" | "homeAccentPreset" | "homeAccentColors" | "canvasColor">, "canvasColor">
    & { canvasColor?: CanvasColorId | "palette" }
): ResolvedAppearanceSettings {
  return {
    homeAccentPreset: settings.homeAccentPreset ?? "classic",
    homeAccentColors: settings.homeAccentColors ?? DEFAULT_HOME_ACCENT_COLORS,
    canvasColor: settings.canvasColor && settings.canvasColor !== "palette"
      ? settings.canvasColor
      : settings.palette ?? "sage"
  };
}

export function canvasColorPatch(canvasColor: CanvasColorId): Pick<AppSettings, "canvasColor"> {
  return { canvasColor };
}

/** Presentation only: never persist these temporary overrides as user settings. */
export function resolveDisplaySettings(
  settings: AppSettings,
  backgroundsSuspended: boolean,
  designDisabled: boolean
): AppSettings {
  if (!backgroundsSuspended && !designDisabled) return settings;
  return {
    ...settings,
    ...(designDisabled ? {
      appSkin: "classic",
      terminalBorderSkin: "classic",
      terminalSkinAnimationEnabled: false,
      canvasColor: "sage"
    } as const : {}),
    canvasBackground: "none",
    pattern: backgroundsSuspended ? "none" : "dots",
    terminalBackground: "none",
    terminalBackgroundOverrides: {}
  };
}

export function homeAccentPresetPatch(
  homeAccentPreset: HomeAccentPresetId
): Pick<AppSettings, "homeAccentPreset"> {
  return { homeAccentPreset };
}
