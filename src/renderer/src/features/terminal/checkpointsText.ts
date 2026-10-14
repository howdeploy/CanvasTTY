import type { LocaleId } from "../../../../shared/contracts";

// The Rollback points dialog's texts, loaded only with the lazily loaded dialog (like features/usage/usageText.ts), so
// they never weigh on the app's first paint. The card menu's "Rollback points…" label stays in lib/i18n.ts.
const RU = {
  title: "Точки отката",
  loading: "Загрузка…",
  empty: "Точек отката пока нет",
  emptyDetail: "Они сохраняются перед каждым ходом агента в режиме Auto или YOLO, если его папка — корень проекта Git, файлы которого не используют фильтры Git (например, Git LFS).",
  kindBeforeTurn: "Перед ходом агента",
  kindBeforeRestore: "Перед восстановлением",
  changedFiles: "Файлы, изменённые с тех пор",
  diffLegend: "Что сделает восстановление: строки с «+» вернутся, строки с «-» будут удалены.",
  showMore: (count: number) => `Показать ещё (осталось строк: ${count})`,
  moreFiles: (count: number) => `…и ещё файлов: ${count}`,
  noChanges: "С тех пор отслеживаемые файлы не менялись.",
  truncated: "Показ сокращён; восстановление использует полную точку отката.",
  restore: "Восстановить",
  restoring: "Восстановление…",
  confirm: "Вернуть отслеживаемые файлы и индекс этой папки к выбранной точке отката? Коммиты и ветка не меняются. Текущая работа сначала сохранится как ещё одна точка отката.",
  restored: "Файлы восстановлены. Предыдущая работа сохранена как ещё одна точка отката.",
  errorNotGitRoot: "Точки отката доступны, только если папка окна — корень проекта Git.",
  errorUnknown: "Этой точки отката больше нет.",
  errorSubmodules: "В репозитории есть подмодули: восстановите их через Git отдельно.",
  errorFilters: "Файлы проекта используют фильтр Git (например, Git LFS или git-crypt): точки отката для него недоступны.",
  errorWorktreeConflict: "Восстановление перезаписало бы несохранённые файлы (неотслеживаемые или скрытые от Git флагами). Уберите их и повторите.",
  errorNoSafetyPoint: "Текущую работу не удалось сначала сохранить как точку отката (например, в ветке ещё нет коммитов), поэтому ничего не восстановлено.",
  errorRestoreInProgress: "Уже идёт другое восстановление.",
  errorAgentRunning: "Сначала закройте или завершите все агенты и терминалы в этой папке.",
  errorPendingLaunch: "Агент ещё запускается. Повторите через минуту.",
  errorIsolatedEnvironment: "Недоступно: связанная изолированная среда может всё ещё выполнять свою работу.",
  errorMissingSession: "Этого окна больше нет.",
  errorFailed: "Действие не удалось."
};

export type CheckpointsText = typeof RU;

const EN: CheckpointsText = {
  title: "Rollback points",
  loading: "Loading…",
  empty: "No rollback points yet",
  emptyDetail: "They are saved before each turn of an agent in Auto or YOLO whose folder is the top of a Git project whose files use no Git filter (such as Git LFS).",
  kindBeforeTurn: "Before an agent turn",
  kindBeforeRestore: "Before a restore",
  changedFiles: "Files changed since then",
  diffLegend: "What the restore does: lines marked + come back, lines marked - are removed.",
  showMore: (count: number) => `Show more (${count} lines left)`,
  moreFiles: (count: number) => `…and ${count} more files`,
  noChanges: "No tracked file changed since then.",
  truncated: "The preview is shortened; the restore uses the complete rollback point.",
  restore: "Restore",
  restoring: "Restoring…",
  confirm: "Restore the tracked files and index of this folder to this rollback point? Commits and the branch stay as they are. Your current work is saved as another rollback point first.",
  restored: "Files restored. The previous work was saved as another rollback point.",
  errorNotGitRoot: "Rollback points need the card's folder to be the top of a Git project.",
  errorUnknown: "This rollback point no longer exists.",
  errorSubmodules: "This repository has submodules: restore them with Git separately.",
  errorFilters: "Files of this project use a Git filter (such as Git LFS or git-crypt): rollback points are unavailable for it.",
  errorWorktreeConflict: "The restore would overwrite unsaved files (untracked, or hidden from Git by index flags). Move them aside and try again.",
  errorNoSafetyPoint: "Your current work could not be saved as a rollback point first (for example, the branch has no commit yet), so nothing was restored.",
  errorRestoreInProgress: "Another restore is in progress.",
  errorAgentRunning: "Close or exit every agent and terminal in this folder first.",
  errorPendingLaunch: "An agent is still starting. Try again in a moment.",
  errorIsolatedEnvironment: "Unavailable: a related isolated environment may still be running its workload.",
  errorMissingSession: "This card no longer exists.",
  errorFailed: "The action failed."
};

export function checkpointsText(locale: LocaleId): CheckpointsText {
  return locale === "ru" ? RU : EN;
}
