import type { ProviderId, SessionRestoreMode, SessionRestoreNote } from "../../shared/contracts.ts";
import type { NestedCodexSession, PersistedEnvironmentRef, PersistedTerminalSession } from "./TerminalSessionStore.ts";
import { canResumeLatestConversation, canResumeThreadById, resumeWithoutIdOpensPicker } from "./terminalLaunch.ts";

/**
 * How a card starts: a new conversation, the provider's own resume without an id
 * (its "latest in this folder" flag, or Codex's resume picker), an exact one, or not at all.
 */
export type ResumeRequest = null | "latest" | { threadId: string };

export interface RestoreStep {
  shellResume?: NestedCodexSession;
  record: PersistedTerminalSession;
  /** "stopped" comes back as a card with Restart / Continue; nothing is launched. */
  launch: ResumeRequest | "stopped";
  note?: SessionRestoreNote;
  /**
   * The conversation the card stays tied to: the recorded one when nothing starts or
   * it is resumed by id, none when a new conversation starts, so Continue never goes
   * back to one that is no longer the card's.
   */
  threadId?: string;
}

/**
 * Picks how an agent continues its own conversation: by the id its hook reported
 * when there is one. Without an id Codex and Hermes open their resume pickers;
 * a "latest in this folder" flag is used only when this card is the only card
 * of that CLI in the folder; otherwise two cards would continue the same
 * conversation, so it starts fresh and says so.
 */
export function chooseResume(
  provider: ProviderId,
  threadId: string | undefined,
  cardsOfProviderInFolder: number
): { resume: ResumeRequest; note?: SessionRestoreNote } {
  if (threadId && canResumeThreadById(provider)) return { resume: { threadId } };
  if (resumeWithoutIdOpensPicker(provider)) return { resume: "latest" };
  if (!canResumeLatestConversation(provider)) return { resume: null };
  if (cardsOfProviderInFolder <= 1) return { resume: "latest" };
  return { resume: null, note: "fresh-shared-folder" };
}

/**
 * The records that come back at all: the ones marked to restore, minus subagents whose parent does not come back
 * (a dropped parent drops its subtree). Their environments are the only ones resumed.
 */
export function restorableRecords(
  records: readonly PersistedTerminalSession[],
  mode: SessionRestoreMode,
  isLiveSession: (id: string) => boolean
): PersistedTerminalSession[] {
  if (mode === "off") return [];
  const candidates = records.filter((record) => record.restore);
  const byId = new Map(candidates.map((record) => [record.id, record]));
  // Walk each subagent's parents: it comes back only when the chain reaches a card that is not a subagent (or a
  // live card). A chain that loops back on itself has no owner and comes back as nothing.
  const owned = (record: PersistedTerminalSession): boolean => {
    const seen = new Set<string>();
    for (let current: PersistedTerminalSession | undefined = record; current?.role === "subagent";) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      const parentId = current.parentSessionId ?? "";
      if (!byId.has(parentId)) return isLiveSession(parentId);
      current = byId.get(parentId);
    }
    return true;
  };
  return candidates.filter(owned);
}

/** The core's one restore order and rule set, the same for every environment. */
export function planSessionRestore(
  records: readonly PersistedTerminalSession[],
  mode: SessionRestoreMode,
  context: {
    isLiveSession(id: string): boolean;
    /** False when the environment's plugin is unavailable or its resume answered stopped. */
    environmentAvailable(environment: PersistedEnvironmentRef, record: PersistedTerminalSession): boolean;
    /** False when a plugin named in the saved launch options cannot prepare launches now. */
    launchOptionsAvailable?(options: Record<string, unknown>): boolean;
  }
): RestoreStep[] {
  if (mode === "off") return [];
  // A subagent comes back only with its parent; a dropped parent drops its subtree.
  const kept = restorableRecords(records, mode, (id) => context.isLiveSession(id));
  const byId = new Map(kept.map((record) => [record.id, record]));
  const depth = (record: PersistedTerminalSession, seen = new Set<string>()): number => {
    const parent = record.parentSessionId ? byId.get(record.parentSessionId) : undefined;
    if (!parent || seen.has(parent.id)) return 0;
    seen.add(record.id);
    return 1 + depth(parent, seen);
  };
  const ordered = kept
    .map((record, index) => ({ record, index, depth: depth(record) }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .map(({ record }) => record);

  return ordered.map((record): RestoreStep => {
    const recorded = record.threadId ? { threadId: record.threadId } : {};
    // Its environment was chosen but never prepared (the app quit while preparing): hold it, never run it here.
    if (record.environmentChoice && !record.environment && record.lastState === "running") {
      return { record, launch: "stopped", note: "environment-pending", ...recorded };
    }
    if (record.environment && !context.environmentAvailable(record.environment, record)) {
      return { record, launch: "stopped", note: "environment-unavailable", ...recorded };
    }
    // Never launch without the contribution the person chose: hold the card with its reason.
    if (record.options && context.launchOptionsAvailable?.(record.options) === false) {
      return { record, launch: "stopped", note: "plugin-unavailable", ...recorded };
    }
    if (record.lastState !== "running") return { record, launch: "stopped", ...recorded };
    if (record.provider === "terminal" || mode === "reopen") return { record, launch: null,
      ...(record.provider === "terminal" && mode === "continue" && record.nestedCodex ? { shellResume: record.nestedCodex } : {}) };
    const peers = kept.filter((candidate) => candidate.provider === record.provider && candidate.cwd === record.cwd);
    const { resume, note } = chooseResume(record.provider, record.threadId, peers.length);
    return { record, launch: resume, ...(note ? { note } : {}),
      ...(resume && typeof resume === "object" ? { threadId: resume.threadId } : {}) };
  });
}
