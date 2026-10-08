import { chmodSync, mkdtempSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_REVIEW_DIFF_BYTES = 64 * 1024;
const ownedWorkspaces = new WeakSet<object>();

/**
 * POSIX keeps the exact owner-only modes. Windows has no owner/group/other bits: chmod only toggles the read-only
 * attribute, which stat reports as the absence of every write bit, so only that part of the mode is checked there.
 */
function hasReviewMode(mode: number, expected: number, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? (mode & 0o222) === 0 : (mode & 0o777) === expected;
}

/** A private, host-created directory whose only source file is the host-reviewed patch. */
export interface DiffOnlyReviewWorkspace {
  readonly directory: string;
  readonly diffPath: string;
  cleanup(): void;
}

export function createDiffOnlyReviewWorkspace(diff: string): DiffOnlyReviewWorkspace {
  if (typeof diff !== "string" || Buffer.byteLength(diff, "utf8") > MAX_REVIEW_DIFF_BYTES) {
    throw new Error("The reviewed diff exceeds the temporary review workspace limit.");
  }
  const tempRoot = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(tempRoot, "canvastty-review-")));
  chmodSync(directory, 0o700);
  const diffPath = join(directory, "review.diff");
  try {
    writeFileSync(diffPath, diff, { encoding: "utf8", flag: "wx", mode: 0o400 });
    chmodSync(diffPath, 0o400);
    chmodSync(directory, 0o500);
  } catch (error) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const workspace: DiffOnlyReviewWorkspace = Object.freeze({
    directory,
    diffPath,
    cleanup() {
      try { chmodSync(directory, 0o700); } catch { /* already removed */ }
      rmSync(directory, { recursive: true, force: true });
      ownedWorkspaces.delete(workspace);
    }
  });
  ownedWorkspaces.add(workspace);
  return workspace;
}

/** TerminalManager accepts only the exact object created here, not paths forged through session metadata. */
export function isHostOwnedDiffOnlyReviewWorkspace(value: unknown, platform: NodeJS.Platform = process.platform): value is DiffOnlyReviewWorkspace {
  if (!value || typeof value !== "object" || !ownedWorkspaces.has(value)) return false;
  const workspace = value as DiffOnlyReviewWorkspace;
  try {
    if (realpathSync(workspace.directory) !== workspace.directory || realpathSync(workspace.diffPath) !== workspace.diffPath
      || workspace.diffPath !== join(workspace.directory, "review.diff")) return false;
    const directory = statSync(workspace.directory);
    const diff = statSync(workspace.diffPath);
    return directory.isDirectory() && hasReviewMode(directory.mode, 0o500, platform)
      && diff.isFile() && hasReviewMode(diff.mode, 0o400, platform)
      && readdirSync(workspace.directory).length === 1 && readdirSync(workspace.directory)[0] === "review.diff";
  } catch { return false; }
}
