import type { FileEntry, FileRootDescriptor } from "../../../../shared/contracts";
import type { FileReadBinding } from "./fileViewer";

/**
 * Renderer-only, non-persisted state for one Files card: the opaque root handle
 * and the directory/read/search data loaded for it. Persisted identity, bounds,
 * root reference, active file, and expanded folders live in
 * `AppSettings.fileCards`; this state is (re)derived at runtime.
 */
export interface FileCardRuntimeState {
  root: FileRootDescriptor | null;
  entries: readonly FileEntry[];
  childrenByDirectory: Readonly<Record<string, readonly FileEntry[]>>;
  readResult: FileReadBinding | null;
  loading: boolean;
  error: string | null;
  rootUnavailable: boolean;
  quickOpenQuery: string;
  quickOpenResults: readonly string[];
}

export const EMPTY_FILE_CARD_RUNTIME: FileCardRuntimeState = {
  root: null,
  entries: [],
  childrenByDirectory: {},
  readResult: null,
  loading: false,
  error: null,
  rootUnavailable: false,
  quickOpenQuery: "",
  quickOpenResults: []
};

/** Runtime state for a card, falling back to the empty state before it loads. */
export function fileCardRuntimeFor(
  state: Readonly<Record<string, FileCardRuntimeState>>,
  id: string
): FileCardRuntimeState {
  return state[id] ?? EMPTY_FILE_CARD_RUNTIME;
}
