import type { LocaleId, PluginCardActionEntry, PluginCardActionFilter } from "./contracts.ts";

/** Every key the filter lists must match; a card outside an environment never matches `environmentKinds`. */
export function cardActionMatches(
  when: PluginCardActionFilter | undefined,
  session: { provider: string; role: string; environment?: { kind: string } }
): boolean {
  if (!when) return true;
  if (when.providers && !when.providers.includes(session.provider as never)) return false;
  if (when.roles && !when.roles.includes(session.role as never)) return false;
  if (when.environmentKinds && (!session.environment || !when.environmentKinds.includes(session.environment.kind))) return false;
  return true;
}

/** A card action's title in the UI language, as a manifest's `description.ru`/`description.en`; `title` otherwise. */
export function cardActionTitle(action: Pick<PluginCardActionEntry, "title" | "title.ru" | "title.en">, locale: LocaleId): string {
  const localized = locale === "ru" ? action["title.ru"] : locale === "en" ? action["title.en"] : undefined;
  return localized || action.title;
}
