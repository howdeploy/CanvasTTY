import type { FileCard, FileRootDescriptor, FileRootReference } from "../../../../shared/contracts";

/**
 * Pure restore helpers for persisted Files cards. These map the settings shape to
 * the root reference main needs to re-register and decide whether a restored
 * root is usable, without touching IPC or the filesystem.
 */

/**
 * Rebuilds the root reference to register on launch. Session cards use their
 * session id; folder cards use the persisted absolute `folderPath` (falling back
 * to a path embedded in the root reference). Returns null when a card has no
 * restorable root — e.g. a folder card whose folder was never chosen.
 */
export function fileCardToRootReference(
  card: Pick<FileCard, "root" | "folderPath">
): FileRootReference | null {
  if (card.root.rootType === "session") {
    return card.root.sessionId ? { rootType: "session", sessionId: card.root.sessionId } : null;
  }
  const folderPath = card.folderPath ?? card.root.folderPath ?? null;
  return folderPath ? { rootType: "folder", folderPath } : null;
}

/**
 * A restored root is usable only when registration returned a descriptor that is
 * explicitly available. A null (missing/unreadable root) or `available: false`
 * descriptor must render the card as unavailable instead of reading anything.
 */
export function isFileRootUsable(
  descriptor: FileRootDescriptor | null
): descriptor is FileRootDescriptor {
  return descriptor !== null && descriptor.available !== false;
}
