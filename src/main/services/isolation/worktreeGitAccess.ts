import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const POINTER_LIMIT = 4096;

/** Host-validated shared Git metadata for one linked worktree in the host's plugin-data tree. */
export interface WorktreeGitAccess {
  cwd: string;
  commonDir: string;
  adminDir: string;
  otherAdminDirs: string[];
}

/**
 * Validates the registered worktree boundary using only the host's resolved launch cwd, original task root, and
 * userData. The returned paths are used to keep shared Git metadata read-only; no Git path or grant comes from a
 * plugin. Any malformed, detached, shared-branch, or mismatched worktree is refused by returning null.
 */
export function worktreeGitAccess(cwd: string, taskRoot: string, userDataPath: string): WorktreeGitAccess | null {
  try {
    const launchCwd = real(cwd);
    const userData = real(userDataPath);
    const pluginData = resolve(userData, "plugin-data");
    if (!within(launchCwd, pluginData) || launchCwd === pluginData) return null;
    // A provider may start in a project subfolder. Its Git boundary is the enclosing registered worktree,
    // which is still validated below against the host task's shared repository and administration pointers.
    const workingTree = nearestGitLayout(launchCwd)?.worktree;
    if (!workingTree || !within(workingTree, pluginData) || workingTree === pluginData) return null;

    const task = real(taskRoot);
    const taskLayout = nearestGitLayout(task);
    if (!taskLayout || !within(task, taskLayout.worktree)) return null;
    if (within(taskLayout.worktree, pluginData) && !isRegisteredLinkedWorktree(taskLayout)) return null;
    if (workingTree === taskLayout.worktree) return null;

    const gitEntry = join(workingTree, ".git");
    const gitEntryStat = lstatSync(gitEntry);
    if (!gitEntryStat.isFile()) return null;
    const gitDirText = pointer(gitEntry, /^gitdir:\s*(.+?)\s*$/mu);
    if (!gitDirText) return null;
    const adminDir = real(isAbsolute(gitDirText) ? gitDirText : resolve(workingTree, gitDirText));
    const commonDir = real(readCommonDir(adminDir));
    if (commonDir !== taskLayout.commonDir) return null;
    // The deny/reopen ordering deliberately hides plugin-data as a parent and reopens only the worker tree. If shared
    // Git storage overlaps either path tree, that boundary cannot be expressed without broadening the reopen.
    if (overlaps(commonDir, workingTree) || overlaps(commonDir, pluginData)) return null;

    const worktreesPath = join(commonDir, "worktrees");
    const worktreesDir = real(worktreesPath);
    if (worktreesDir !== worktreesPath) return null;
    if (dirname(adminDir) !== worktreesDir) return null;
    if (!directory(adminDir)) return null;

    const adminGitdir = pointer(join(adminDir, "gitdir"), /^(.+?)\s*$/mu);
    if (!adminGitdir) return null;
    const registeredEntry = real(isAbsolute(adminGitdir) ? adminGitdir : resolve(adminDir, adminGitdir));
    if (registeredEntry !== gitEntry) return null;
    const adminCommon = pointer(join(adminDir, "commondir"), /^(.+?)\s*$/mu);
    if (!adminCommon) return null;
    if (real(isAbsolute(adminCommon) ? adminCommon : resolve(adminDir, adminCommon)) !== commonDir) return null;

    const head = readRegular(join(adminDir, "HEAD"));
    const branch = head === null ? null : /^ref:\s*(refs\/heads\/.+)\s*$/mu.exec(head)?.[1] ?? null;
    if (!branch || !validBranchRef(branch)) return null;
    if (!hasBranchRef(commonDir, branch)) return null;
    const otherAdminDirs = otherAdministrations(worktreesDir, adminDir);
    // The primary checkout is not listed under .git/worktrees. A forced linked worktree can share its branch, so
    // include the host-validated task root's own Git directory HEAD in the single-writer check.
    if (!otherAdminDirs || anotherWorktreeOwns([...otherAdminDirs, taskLayout.gitDir, commonDir], branch)) return null;
    return { cwd: workingTree, commonDir, adminDir, otherAdminDirs };
  } catch {
    return null;
  }
}

/** Does the launch cwd sit in the private plugin-data tree where only a verified project may be reopened? */
export function isPluginDataPath(path: string, userDataPath: string): boolean {
  try {
    const lexical = resolve(path);
    const lexicalRoot = resolve(userDataPath, "plugin-data");
    const realRoot = resolve(real(userDataPath), "plugin-data");
    return within(lexical, lexicalRoot) || within(lexical, realRoot) || within(real(path), realRoot);
  } catch {
    return false;
  }
}

interface GitLayout { worktree: string; gitDir: string; commonDir: string }

function nearestGitLayout(path: string): GitLayout | null {
  for (let current = path; ; current = dirname(current)) {
    const layout = gitLayout(current);
    if (layout) return layout;
    const parent = dirname(current);
    if (parent === current) return null;
  }
}

function gitLayout(worktree: string): GitLayout | null {
  try {
    const entry = join(worktree, ".git");
    const info = lstatSync(entry);
    let gitDir: string;
    if (info.isDirectory()) gitDir = real(entry);
    else if (info.isFile()) {
      const value = pointer(entry, /^gitdir:\s*(.+?)\s*$/mu);
      if (!value) return null;
      gitDir = real(isAbsolute(value) ? value : resolve(worktree, value));
    } else return null;
    if (!directory(gitDir)) return null;
    return { worktree, gitDir, commonDir: real(readCommonDir(gitDir)) };
  } catch {
    return null;
  }
}

/** A task root can itself be a worker worktree; accept it only when its host-side Git pointers agree exactly. */
function isRegisteredLinkedWorktree(layout: GitLayout): boolean {
  try {
    const entry = join(layout.worktree, ".git");
    const entryInfo = lstatSync(entry);
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) return false;
    const gitDirText = pointer(entry, /^gitdir:\s*(.+?)\s*$/mu);
    if (!gitDirText) return false;
    const adminDir = real(isAbsolute(gitDirText) ? gitDirText : resolve(layout.worktree, gitDirText));
    const worktreesDir = join(layout.commonDir, "worktrees");
    if (real(worktreesDir) !== worktreesDir || dirname(adminDir) !== worktreesDir || adminDir !== layout.gitDir || !directory(adminDir)) return false;
    const adminGitdir = pointer(join(adminDir, "gitdir"), /^(.+?)\s*$/mu);
    if (!adminGitdir || real(isAbsolute(adminGitdir) ? adminGitdir : resolve(adminDir, adminGitdir)) !== entry) return false;
    const adminCommon = pointer(join(adminDir, "commondir"), /^(.+?)\s*$/mu);
    return Boolean(adminCommon && real(isAbsolute(adminCommon) ? adminCommon : resolve(adminDir, adminCommon)) === layout.commonDir);
  } catch {
    return false;
  }
}

function readCommonDir(gitDir: string): string {
  const path = join(gitDir, "commondir");
  if (!existsSync(path)) return gitDir;
  const value = pointer(path, /^(.+?)\s*$/mu);
  if (!value) throw new Error("Invalid Git common directory pointer.");
  return isAbsolute(value) ? value : resolve(gitDir, value);
}

function otherAdministrations(worktreesDir: string, ownAdminDir: string): string[] | null {
  const found: string[] = [];
  for (const entry of readdirEntries(worktreesDir)) {
    const admin = join(worktreesDir, entry);
    const info = lstatSync(admin);
    if (info.isSymbolicLink()) return null;
    if (!info.isDirectory() || real(admin) !== admin) return null;
    if (admin === ownAdminDir) continue;
    found.push(admin);
  }
  return found;
}

function anotherWorktreeOwns(otherAdmins: readonly string[], branch: string): boolean {
  for (const admin of otherAdmins) {
    const head = readRegular(join(admin, "HEAD"));
    if (head !== null && /^ref:\s*(refs\/heads\/.+)\s*$/mu.exec(head)?.[1] === branch) return true;
  }
  return false;
}

/** Checks an optional path below an expected real directory without following symlinked components. */
function hasBranchRef(commonDir: string, branch: string): boolean {
  const looseRef = join(commonDir, ...branch.split("/"));
  const looseStatus = optionalRegularStatus(looseRef, commonDir);
  if (looseStatus === null) return false;
  if (looseStatus === "present") {
    const oid = readRegular(looseRef);
    return oid !== null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\s*$/iu.test(oid);
  }
  // pack-refs removes loose refs and may be used by a valid linked worktree. It is read only here; the complete
  // common Git directory is protected by the OS layer, so this never opens a write grant.
  const packedRefs = join(commonDir, "packed-refs");
  try {
    const info = lstatSync(packedRefs);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) return false;
    const lines = readFileSync(packedRefs, "utf8").split(/\r?\n/u);
    const matches = lines.filter((line) => {
      if (!line || line.startsWith("#") || line.startsWith("^")) return false;
      const space = line.indexOf(" ");
      return space > 0 && line.slice(space + 1) === branch;
    });
    return matches.length === 1 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\s/iu.test(matches[0]);
  } catch {
    return false;
  }
}

/** Checks a loose-ref path without following symlinked components; absent refs are resolved through packed-refs. */
function optionalRegularStatus(path: string, root: string): "present" | "missing" | null {
  const rest = relative(root, path);
  if (rest.startsWith("..") || isAbsolute(rest)) return null;
  let current = root;
  try {
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || real(root) !== root) return null;
  } catch { return null; }
  const parts = rest.split(/[\\/]/u).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || real(current) !== current) return null;
      if (index === parts.length - 1) return info.isFile() ? "present" : null;
      if (!info.isDirectory()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      return null;
    }
  }
  return null;
}

function readdirEntries(path: string): string[] {
  return readdirSync(path);
}

function pointer(path: string, pattern: RegExp): string | null {
  const content = readRegular(path);
  const match = content === null ? null : pattern.exec(content);
  return match?.[1]?.trim() || null;
}

function readRegular(path: string): string | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > POINTER_LIMIT) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function directory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function real(path: string): string {
  return realpathSync.native(path);
}

function validBranchRef(ref: string): boolean {
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(ref) || ref.includes("//") || ref.includes("..") || ref.includes("@{")) return false;
  return ref.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}

function within(path: string, root: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}
