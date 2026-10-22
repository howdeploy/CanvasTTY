import type { CheckpointListResult, CheckpointPreviewResult, CheckpointRestoreResult } from "../../shared/contracts.ts";
import { checkpointErrorCode, CheckpointRefusal } from "../services/checkpointRefusal.ts";
import type { GitCheckpoints } from "../services/GitCheckpoints.ts";
import type { TerminalManager } from "../services/TerminalManager.ts";

const CHECKPOINT_ID = /^refs\/canvastty\/[\w-]{1,100}\/\d{1,16}-[0-9a-f-]{36}$/u;

/**
 * The Rollback points dialog's three requests (the main window only, registerIpc). Answers carry a stable error code
 * that the renderer localizes, never main-process text.
 */
export function checkpointIpcHandlers({ checkpoints, terminals }: {
  checkpoints: Pick<GitCheckpoints, "available" | "list" | "preview" | "restore">;
  terminals: Pick<TerminalManager, "getMetadata" | "withCheckpointRestore">;
}) {
  const card = (id: unknown): { id: string; cwd: string } => {
    if (typeof id !== "string") throw new CheckpointRefusal("missing-session", "Terminal session id is invalid.");
    const row = terminals.getMetadata(id);
    if (!row) throw new CheckpointRefusal("missing-session", "Terminal session does not exist.");
    return { id, cwd: row.cwd };
  };
  const checkpointId = (value: unknown): string => {
    if (typeof value !== "string" || !CHECKPOINT_ID.test(value)) throw new CheckpointRefusal("unknown-checkpoint", "Rollback point id is invalid.");
    return value;
  };
  const gitRoot = async (cwd: string): Promise<void> => {
    if (!await checkpoints.available(cwd)) throw new CheckpointRefusal("not-git-root", "The card's folder is not a Git project root.");
  };
  const failed = (error: unknown): { ok: false; code: ReturnType<typeof checkpointErrorCode> } => {
    if (!(error instanceof CheckpointRefusal)) console.warn("Rollback point action failed.", error instanceof Error ? error.name : "error");
    return { ok: false, code: checkpointErrorCode(error) };
  };
  return {
    async list(id: unknown): Promise<CheckpointListResult> {
      try {
        const row = card(id);
        await gitRoot(row.cwd);
        return { ok: true, checkpoints: await checkpoints.list(row.id, row.cwd) };
      } catch (error) { return failed(error); }
    },
    async preview(id: unknown, checkpoint: unknown): Promise<CheckpointPreviewResult> {
      try {
        const row = card(id);
        const ref = checkpointId(checkpoint);
        await gitRoot(row.cwd);
        return { ok: true, ...await checkpoints.preview(row.id, row.cwd, ref) };
      } catch (error) { return failed(error); }
    },
    async restore(id: unknown, checkpoint: unknown): Promise<CheckpointRestoreResult> {
      try {
        const row = card(id);
        const ref = checkpointId(checkpoint);
        await gitRoot(row.cwd);
        await terminals.withCheckpointRestore(row.id, (cwd) => checkpoints.restore(row.id, cwd, ref));
        return { ok: true };
      } catch (error) { return failed(error); }
    }
  };
}
