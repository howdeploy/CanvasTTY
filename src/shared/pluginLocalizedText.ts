import type { LocaleId, PluginContributionBase, PluginLaunchField, PluginManifest } from "./contracts.ts";

// A manifest text may come with a ".ru" and ".en" variant, like `description.ru`/`description.en`: the app shows the
// one for its language, and the plain text otherwise.
function localized(entry: { readonly [key: string]: string | undefined }, key: string, locale: LocaleId): string {
  return entry[`${key}.${locale}`] || entry[key] || "";
}

/** The plugin's name in the UI language (`name.ru`/`name.en`); `name` otherwise. */
export function pluginName(manifest: Pick<PluginManifest, "name" | "name.ru" | "name.en">, locale: LocaleId): string {
  return localized(manifest, "name", locale);
}

/** A contribution's (canvas app, settings page, home widget, window) title in the UI language; `title` otherwise. */
export function contributionTitle(contribution: Pick<PluginContributionBase, "title" | "title.ru" | "title.en">, locale: LocaleId): string {
  return localized(contribution, "title", locale);
}

/** A launch field's label in the UI language (`label.ru`/`label.en`); `label` otherwise. */
export function launchFieldLabel(field: Pick<PluginLaunchField, "label" | "label.ru" | "label.en">, locale: LocaleId): string {
  return localized(field, "label", locale);
}
