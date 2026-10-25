import type { LocaleId } from "./contracts.ts";

/**
 * Why a plugin's own UI cannot reach its service although the service exists. The main process refuses with one of
 * these fixed texts (plugins see them as the request's error); the renderer shows the localized text with a button
 * that opens the settings section where the person can change it. A service that is trusted but not running keeps the
 * supervisor's own error ("Plugin service is not running." with the last error, if any).
 */
export const PLUGIN_NATIVE_CODE_OFF_ERROR =
  "This plugin's native code is turned off. Turn it on in Settings → Agents → Extension native code.";
export const PLUGIN_SERVICE_MODULE_OFF_ERROR =
  "The plugin module that runs this service is turned off. Turn it on in Settings → Plugins.";

export type PluginServiceNoticeKind = "native-code-off" | "module-off";

const NOTICE_TEXT: Record<LocaleId, Record<PluginServiceNoticeKind | "open", string>> = {
  ru: {
    "native-code-off": "Нативный код этого плагина выключен — включите его в Настройки → Агенты → Нативный код расширений.",
    "module-off": "Модуль этого плагина с нативным кодом выключен — включите его в Настройки → Плагины.",
    open: "Открыть настройки"
  },
  en: {
    "native-code-off": "This plugin's native code is turned off — turn it on in Settings → Agents → Extension native code.",
    "module-off": "The plugin module that runs this service is turned off — turn it on in Settings → Plugins.",
    open: "Open settings"
  }
};

/** The notice an error text stands for (the main process's fixed text or an already localized one), or null. */
export function pluginServiceNoticeKind(message: string): PluginServiceNoticeKind | null {
  const text = message.trim();
  if (text === PLUGIN_NATIVE_CODE_OFF_ERROR || text === NOTICE_TEXT.ru["native-code-off"] || text === NOTICE_TEXT.en["native-code-off"]) {
    return "native-code-off";
  }
  if (text === PLUGIN_SERVICE_MODULE_OFF_ERROR || text === NOTICE_TEXT.ru["module-off"] || text === NOTICE_TEXT.en["module-off"]) {
    return "module-off";
  }
  return null;
}

export function pluginServiceNoticeText(kind: PluginServiceNoticeKind | "open", locale: LocaleId): string {
  return (NOTICE_TEXT[locale] ?? NOTICE_TEXT.en)[kind];
}

/** The settings section that holds the switch for this notice. */
export function pluginServiceNoticeSection(kind: PluginServiceNoticeKind): "agents" | "plugins" {
  return kind === "module-off" ? "plugins" : "agents";
}
