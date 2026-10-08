import { dirname, join } from "node:path";
import type { IsolationPaths } from "./isolationPaths.ts";

/** The project's own git hooks folder. */
export function projectHooks(cwd: string): string {
  return join(cwd, ".git", "hooks");
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder.replace(/\/+$/u, "")}/`);
}

/**
 * The bubblewrap arguments of one isolated agent on Linux: the whole file system read-only, the project, this
 * launch's temporary folder and the CLI's own folders writable, an empty tmpfs over every folder it must not read (and
 * /dev/null over such files), its own PID namespace (it cannot signal the person's processes) and the person's user
 * runtime folder hidden (the systemd user manager, D-Bus session bus, SSH agent and Podman sockets live there).
 *
 * Linux cannot filter which Unix sockets a process connects to, so a socket outside those hidden folders (a system
 * Docker socket the person's account may use) stays reachable; docs/installing-and-security.md says so. `exists`
 * decides what is bound: bubblewrap refuses to bind a missing path.
 */
export function bubblewrapArguments(
  paths: IsolationPaths,
  launch: { command: string; args: readonly string[]; cwd: string; runtimeDir?: string },
  exists: (path: string) => "file" | "directory" | null
): string[] {
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    ...(paths.restrictReads ? ["--tmpfs","/",...paths.readableAgain.flatMap(path=>exists(path) ? ["--ro-bind",path,path] : [])] : ["--ro-bind", "/", "/"]),
    ...(!paths.restrictReads ? ["--dev-bind", "/dev", "/dev"] : []),
    "--proc", "/proc"
  ];
  const seen = new Set<string>();
  for (const path of paths.writable) {
    if (seen.has(path) || exists(path) !== "directory") continue;
    seen.add(path);
    args.push("--bind", path, path);
  }
  for (const path of paths.writableFiles) {
    if (exists(path) === "file") args.push("--bind", path, path);
  }
  for (const path of paths.unreadable) {
    const kind = exists(path);
    if (kind === "directory") args.push("--tmpfs", path);
    else if (kind === "file") args.push("--ro-bind", "/dev/null", path);
  }
  // What this launch was handed stays read-only (as in the macOS profile), except the CLI's own moved home, which is
  // one of its writable folders.
  for (const path of paths.readableAgain) {
    if (exists(path)) args.push(seen.has(path) ? "--bind" : "--ro-bind", path, path);
  }
  // Last, over every bind above (a rebound home included): the read-only files and the project's git hooks.
  for (const path of [...paths.gitHooks, ...(paths.protectedDirectories ?? []), ...paths.protectedWrites]) {
    const kind = exists(path);
    if (kind) args.push("--ro-bind", path, path);
  }
  // A mount needs its path to exist, and nothing can be mounted once the agent runs: a protected file that is missing
  // but could be created inside a writable folder cannot be protected here. The caller puts a neutral placeholder
  // there first (LinuxHostPaths); if one is still missing, the launch is refused rather than left unprotected.
  // A `.lock` sibling needs no mount: the rename over the read-only file it guards fails anyway.
  for (const path of [...paths.protectedWrites, ...(paths.protectedDirectories ?? [])]) {
    if (path.endsWith(".lock") || exists(path)) continue;
    if (creatableInside(path, [...seen], exists)) {
      throw new Error(`${path} would be writable for the agent (it does not exist yet, so it cannot be mounted read-only).`);
    }
  }
  // A mount cannot be added once the agent runs. The project's repository (or the one `git init` makes) gets a
  // throwaway hooks folder, and an `info` folder that cannot gain `attributes`: what the agent writes there never
  // reaches the files the person's git reads later, outside the layer. A `.git` file (a worktree) keeps these in the
  // main repository. Repositories deeper in the project are checked when the session ends (gitAudit.ts).
  const writableProject = [...seen].some((folder) => within(launch.cwd, folder));
  const gitDir = join(launch.cwd, ".git");
  if (writableProject && exists(gitDir) !== "file") {
    const hooks = projectHooks(launch.cwd);
    if (!exists(hooks)) args.push("--tmpfs", hooks);
    const info = join(gitDir, "info");
    const attributes = join(info, "attributes");
    if (exists(attributes)) args.push("--ro-bind", attributes, attributes);
    else if (exists(info) === "directory") args.push("--ro-bind", info, info);
    else if (!exists(info)) args.push("--tmpfs", info);
  }
  if (launch.runtimeDir && exists(launch.runtimeDir) === "directory") args.push("--tmpfs", launch.runtimeDir);
  // CanvasTTY's gateway sockets may sit in the hidden runtime folder or in /tmp; bind their folders back.
  for (const path of paths.socketFolders) {
    if (exists(path) === "directory" && !seen.has(path)) args.push("--bind", path, path);
  }
  // Last mount: read exceptions and socket grants must never restore host devices inside a reviewer.
  if (paths.restrictReads) args.push("--dev", "/dev");
  args.push("--chdir", launch.cwd, "--", launch.command, ...launch.args);
  return args;
}

/** A missing `path` whose nearest existing ancestor is one of the writable folders (or inside one). */
export function creatableInside(path: string, writable: readonly string[], exists: (path: string) => "file" | "directory" | null): boolean {
  let current = dirname(path);
  for (let i = 0; i < 128 && !exists(current); i++) {
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return exists(current) === "directory" && writable.some((folder) => current === folder || current.startsWith(`${folder.replace(/\/+$/u, "")}/`));
}
