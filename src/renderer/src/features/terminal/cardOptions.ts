import type { CheckpointListResult, LaunchProfileId } from "../../../../shared/contracts.ts";

/**
 * "Rollback points…" belongs in an agent card's menu when its folder can have them (an auto or YOLO agent at the top
 * of a Git project) or once some exist. A folder that is not a Git root answers `ok: false`.
 */
export function checkpointsItemShown(result: CheckpointListResult, profile: LaunchProfileId): boolean {
  return result.ok && (result.checkpoints.length > 0 || profile !== "normal");
}

/** The card's options button shows only when its menu will hold at least one item, never an empty menu. */
export function cardHasOptions(items: { restoreEnabled: boolean; checkpointsShown: boolean; pluginActions: number }): boolean {
  return items.restoreEnabled || items.checkpointsShown || items.pluginActions > 0;
}
