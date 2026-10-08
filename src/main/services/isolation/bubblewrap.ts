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
 * /dev/null over such files), its own PID namespace (it cannot signal the person's processes), the person's user
 * runtime folder hidden (the systemd user manager, D-Bus session bus, SSH agent and Podman sockets live there), and
 * common system daemon sockets masked in strict network mode.
 *
 * Strict network launches additionally use the native helper's Landlock socket boundary; mounts alone cannot filter
 * arbitrary Unix socket connections. `exists` decides what is bound: bubblewrap refuses to bind a missing path.
 */
export function bubblewrapArguments(
  paths: IsolationPaths,
  launch: { command: string; args: readonly string[]; cwd: string; runtimeDir?: string;
    network?: { mode: "allowed-domains" | "offline"; proxySocketPath?: string } },
  exists: (path: string) => "file" | "directory" | "socket" | null
): string[] {
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    ...(launch.network ? ["--unshare-net"] : []),
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
  // Linux cannot permit atomic ref updates to one branch without making the containing directory writable (which
  // also permits new sibling refs). Linked-worktree Git metadata therefore stays read-only under bubblewrap.
  for (const path of paths.writableFiles) {
    if (exists(path) === "file" && ![...seen].some((folder) => within(path, folder))) args.push("--bind", path, path);
  }
  for (const path of paths.unreadable) {
    const kind = exists(path);
    if (kind === "directory") args.push("--tmpfs", path);
    else if (kind === "file" || kind === "socket") args.push("--ro-bind", "/dev/null", path);
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
  // Connect needs no writable directory. Strict launches cannot replace host gateway socket files.
  for (const path of paths.socketFolders) {
    if (exists(path) === "directory" && !seen.has(path)) args.push(launch.network ? "--ro-bind" : "--bind", path, path);
  }
  if (launch.network?.mode === "allowed-domains") {
    const socket = launch.network.proxySocketPath;
    if (!socket || exists(socket) !== "socket") throw new Error("The restricted-network proxy socket is missing; the agent was not started.");
    args.push("--ro-bind", socket, socket);
  }
  // Last mount: read exceptions and socket grants must never restore host devices inside a reviewer.
  if (paths.restrictReads) args.push("--dev", "/dev");
  args.push("--chdir", launch.cwd, "--", launch.command, ...launch.args);
  return args;
}

/** A missing `path` whose nearest existing ancestor is one of the writable folders (or inside one). */
export function creatableInside(path: string, writable: readonly string[], exists: (path: string) => "file" | "directory" | "socket" | null): boolean {
  let current = dirname(path);
  for (let i = 0; i < 128 && !exists(current); i++) {
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return exists(current) === "directory" && writable.some((folder) => current === folder || current.startsWith(`${folder.replace(/\/+$/u, "")}/`));
}
