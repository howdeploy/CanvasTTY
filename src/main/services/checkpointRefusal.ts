import type { CheckpointErrorCode } from "../../shared/contracts.ts";

/** A rollback point action that cannot run; `code` is what the renderer localizes. */
export class CheckpointRefusal extends Error {
  readonly code: CheckpointErrorCode;

  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointRefusal";
    this.code = code;
  }
}

/** The stable code of any error from a checkpoint action ("failed" when it is not a refusal). */
export function checkpointErrorCode(error: unknown): CheckpointErrorCode {
  return error instanceof CheckpointRefusal ? error.code : "failed";
}
