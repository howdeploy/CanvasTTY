import type { LocaleId, ReasoningEffort } from "../../../shared/contracts";

const LABELS: Record<ReasoningEffort, [string, string]> = {
  minimal: ["Минимальная", "Minimal"],
  low: ["Низкая — быстрее и дешевле", "Low — faster and cheaper"],
  medium: ["Средняя", "Medium"],
  high: ["Высокая — точнее, дольше", "High — more careful, slower"],
  xhigh: ["Очень высокая", "Extra high"],
  max: ["Максимальная — дороже всего", "Max — most expensive"]
};

export function effortLabel(locale: LocaleId, effort: ReasoningEffort): string {
  return LABELS[effort][locale === "ru" ? 0 : 1];
}
