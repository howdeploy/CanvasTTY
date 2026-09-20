/**
 * Terminal card title rules, kept free of React so they can be unit-tested.
 *
 * Precedence for the name shown on a card (and therefore the name a rename
 * starts from):
 *   1. a user-customized title always wins (`titleCustomized`);
 *   2. otherwise the last OSC 0/2 title the shell reported, when non-empty;
 *   3. otherwise the working-directory label.
 */

export interface VisibleTerminalTitleInput {
  /** Stored session title (`session.title`). */
  title: string;
  /** Whether the user explicitly named the session (`session.titleCustomized`). */
  titleCustomized: boolean;
  /** Display-only shell title from OSC 0/2, `null` when none was reported. */
  oscTitle: string | null | undefined;
  /** Fallback label derived from the working directory. */
  cwdLabel: string;
}

export function visibleTerminalTitle({ title, titleCustomized, oscTitle, cwdLabel }: VisibleTerminalTitleInput): string {
  if (titleCustomized) return title;
  const shellTitle = oscTitle ?? "";
  return shellTitle.trim() ? shellTitle : cwdLabel;
}

export interface RenameCommitInput {
  /** The text the rename field was seeded with: the title visible when editing began. */
  previousVisible: string;
  /** The raw field value at commit time. */
  submitted: string;
}

export type RenameCommit =
  | { kind: "unchanged"; title: string }
  | { kind: "rename"; title: string };

/**
 * Decide what submitting the rename field means.
 *
 * - Empty (or whitespace-only) input never renames; the visible title is kept.
 * - Submitting the same text that was visible is a no-op: no rename request,
 *   so an uncustomized OSC/cwd title is not silently promoted to a custom one.
 * - Anything else renames to the trimmed text.
 */
export function renameCommit({ previousVisible, submitted }: RenameCommitInput): RenameCommit {
  const next = submitted.trim();
  if (!next || next === previousVisible.trim()) return { kind: "unchanged", title: previousVisible };
  return { kind: "rename", title: next };
}
