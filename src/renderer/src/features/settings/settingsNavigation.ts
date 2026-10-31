import type { TranslationKey } from "../../lib/i18n";

export type SettingsSection = "general" | "keyboardShortcuts" | "appearance" | "agents" | "controls" | "externalIntegrations" | "canvasLink" | "browser" | "plugins" | "mascots" | "updates" | "about";
/** Optional destination used by HOME links to reveal a specific settings group. */
export interface SettingsDestination { section: SettingsSection; label?: TranslationKey }
