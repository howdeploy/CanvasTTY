import type { LocaleId } from "../../../../shared/contracts";
import { t, type TranslationKey } from "../../lib/i18n.ts";

export type SettingsSection = "general" | "keyboardShortcuts" | "appearance" | "agents" | "controls" | "externalIntegrations" | "canvasLink" | "browser" | "plugins" | "mascots" | "updates" | "about";
export interface SettingsDestination { section: SettingsSection; label?: TranslationKey }
export interface SettingsSearchEntry { section: SettingsSection; label: TranslationKey; description?: TranslationKey }

/** Keep destination labels in sync with SettingGroup labels; both locales are searchable. */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  {
    "section": "general",
    "label": "general"
  },
  {
    "section": "general",
    "label": "language"
  },
  {
    "section": "general",
    "label": "attentionNotifications",
    "description": "attentionNotificationsDescription"
  },
  {
    "section": "general",
    "label": "terminalSessionRestore",
    "description": "terminalSessionRestoreDescription"
  },
  {
    "section": "general",
    "label": "persistCanvasRegions"
  },
  {
    "section": "general",
    "label": "persistStickyNotes"
  },
  {
    "section": "general",
    "label": "persistMaterials"
  },
  {
    "section": "keyboardShortcuts",
    "label": "keyboardShortcuts"
  },
  {
    "section": "keyboardShortcuts",
    "label": "keyboardPreset",
    "description": "keyboardPresetDescription"
  },
  {
    "section": "keyboardShortcuts",
    "label": "canvasWheelCapture",
    "description": "canvasWheelCaptureDescription"
  },
  {
    "section": "keyboardShortcuts",
    "label": "canvasNavigationOverride",
    "description": "canvasNavigationOverrideDescription"
  },
  {
    "section": "appearance",
    "label": "appearance"
  },
  {
    "section": "appearance",
    "label": "keyboardHideBackgrounds"
  },
  {
    "section": "appearance",
    "label": "keyboardDisableDesign"
  },
  {
    "section": "appearance",
    "label": "palette",
    "description": "paletteDescription"
  },
  {
    "section": "appearance",
    "label": "homeColors",
    "description": "homeColorsDescription"
  },
  {
    "section": "appearance",
    "label": "homeCustomColors"
  },
  {
    "section": "appearance",
    "label": "sessionRowColors",
    "description": "sessionRowColorsDescription"
  },
  {
    "section": "appearance",
    "label": "canvasPattern"
  },
  {
    "section": "appearance",
    "label": "canvasColor"
  },
  {
    "section": "appearance",
    "label": "terminalBorderSkin"
  },
  {
    "section": "appearance",
    "label": "terminalSkinDetail"
  },
  {
    "section": "appearance",
    "label": "appSkin"
  },
  {
    "section": "appearance",
    "label": "uiScale",
    "description": "uiScaleDescription"
  },
  {
    "section": "appearance",
    "label": "shortcutHints"
  },
  {
    "section": "appearance",
    "label": "minimapPlacement"
  },
  {
    "section": "appearance",
    "label": "shortcutHintsPlacement"
  },
  {
    "section": "appearance",
    "label": "canvasControlsPlacement"
  },
  {
    "section": "appearance",
    "label": "attentionQueue",
    "description": "attentionQueueDescription"
  },
  {
    "section": "appearance",
    "label": "attentionQueuePlacement"
  },
  {
    "section": "appearance",
    "label": "agentChatHistory",
    "description": "agentChatHistoryDescription"
  },
  {
    "section": "appearance",
    "label": "agentChatHistoryExpandMode"
  },
  {
    "section": "appearance",
    "label": "agentChatHistoryPlacement"
  },
  {
    "section": "appearance",
    "label": "agentChatHistorySearchAgents"
  },
  {
    "section": "appearance",
    "label": "agentChatHistorySearchSessions"
  },
  {
    "section": "agents",
    "label": "agents"
  },
  {
    "section": "agents",
    "label": "agentCliDetection",
    "description": "agentCliDetectionDescription"
  },
  {
    "section": "agents",
    "label": "baseProtection",
    "description": "baseProtectionDescription"
  },
  {
    "section": "agents",
    "label": "agentIsolation",
    "description": "agentIsolationDescription"
  },
  {
    "section": "agents",
    "label": "defaultLaunchProfile",
    "description": "defaultLaunchProfileDescription"
  },
  {
    "section": "agents",
    "label": "agentDefaultLaunchProfiles",
    "description": "agentDefaultLaunchProfilesDescription"
  },
  {
    "section": "agents",
    "label": "orchestrationMaxDepth",
    "description": "orchestrationMaxDepthDescription"
  },
  {
    "section": "agents",
    "label": "orchestrationMaxSubagents",
    "description": "orchestrationMaxSubagentsDescription"
  },
  {
    "section": "agents",
    "label": "agentControlEnabled",
    "description": "agentControlEnabledDescription"
  },
  {
    "section": "agents",
    "label": "canvasLauncherItems",
    "description": "canvasLauncherItemsDescription"
  },
  {
    "section": "agents",
    "label": "quickLauncher",
    "description": "quickLauncherDescription"
  },
  {
    "section": "agents",
    "label": "homeLauncherAgents",
    "description": "homeLauncherAgentsDescription"
  },
  {
    "section": "agents",
    "label": "homeLimitProviders",
    "description": "homeLimitProvidersDescription"
  },
  {
    "section": "agents",
    "label": "providerApiKeys",
    "description": "providerApiKeysDescription"
  },
  {
    "section": "agents",
    "label": "apiProfiles",
    "description": "apiProfilesDescription"
  },
  {
    "section": "canvasLink",
    "label": "canvasLink"
  },
  {
    "section": "externalIntegrations",
    "label": "externalIntegrations"
  },
  {
    "section": "controls",
    "label": "controls"
  },
  {
    "section": "controls",
    "label": "focusActivation"
  },
  {
    "section": "controls",
    "label": "hoverFocus",
    "description": "hoverFocusDescription"
  },
  {
    "section": "controls",
    "label": "hoverFocusSpeed"
  },
  {
    "section": "controls",
    "label": "snapToGrid"
  },
  {
    "section": "controls",
    "label": "minimapInteractionMode",
    "description": "minimapInteractionModeDescription"
  },
  {
    "section": "controls",
    "label": "edgePan",
    "description": "edgePanDescription"
  },
  {
    "section": "controls",
    "label": "edgePanSpeed"
  },
  {
    "section": "controls",
    "label": "zoomSensitivity"
  },
  {
    "section": "controls",
    "label": "useScrollWheelToZoom",
    "description": "useScrollWheelToZoomDescription"
  },
  {
    "section": "controls",
    "label": "copyOnSelect",
    "description": "copyOnSelectDescription"
  },
  {
    "section": "controls",
    "label": "terminalLinkOpenMode",
    "description": "terminalLinkOpenModeDescription"
  },
  {
    "section": "controls",
    "label": "terminalWheelDirection"
  },
  {
    "section": "controls",
    "label": "canvasWheelDirection"
  },
  {
    "section": "browser",
    "label": "browser"
  },
  {
    "section": "browser",
    "label": "browserAgentAccess",
    "description": "browserAgentAccessDescription"
  },
  {
    "section": "browser",
    "label": "browserAgentPresence",
    "description": "browserAgentPresenceDescription"
  },
  {
    "section": "browser",
    "label": "browserRestoreTabs",
    "description": "browserRestoreTabsDescription"
  },
  {
    "section": "browser",
    "label": "browserPauseHiddenTabs",
    "description": "browserPauseHiddenTabsDescription"
  },
  {
    "section": "browser",
    "label": "browserDownloads"
  },
  {
    "section": "browser",
    "label": "browserActivity"
  },
  {
    "section": "browser",
    "label": "browserData",
    "description": "browserDataDescription"
  },
  {
    "section": "plugins",
    "label": "plugins"
  },
  {
    "section": "mascots",
    "label": "mascots"
  },
  {
    "section": "updates",
    "label": "updates"
  },
  {
    "section": "about",
    "label": "about"
  }
];

export function searchSettings(query: string, locale: LocaleId): SettingsSearchEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  return SETTINGS_SEARCH_ENTRIES.filter((entry) => {
    const text = [locale, locale === "ru" ? "en" : "ru"].flatMap((language) => [
      t(language as LocaleId, entry.section), t(language as LocaleId, entry.label),
      entry.description ? t(language as LocaleId, entry.description) : ""
    ]).join(" ").toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
