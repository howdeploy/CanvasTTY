import type { LocaleId } from "../../../shared/contracts.ts";

export function terminalShutdownMessage(count: number, locale: LocaleId): string {
  if (locale === "en") return `${count} active terminal session${count === 1 ? "" : "s"} will close.`;
  switch (new Intl.PluralRules("ru").select(count)) {
    case "one": return `Будет завершена ${count} активная терминальная сессия.`;
    case "few": return `Будут завершены ${count} активные терминальные сессии.`;
    default: return `Будут завершены ${count} активных терминальных сессий.`;
  }
}
