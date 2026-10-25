import type { IsolationPaths } from "./isolationPaths.ts";

/**
 * The macOS seatbelt profile (SBPL, read by /usr/bin/sandbox-exec) of one isolated agent. Everything is allowed
 * except what is listed, and a later rule wins over an earlier one:
 *
 * - writes: nowhere, then the project (every spelling), this launch's own temporary folder, the CLI's own state,
 *   config and cache folders and the package caches, then again nowhere in CanvasTTY's own data folder when the project
 *   contains it (its writable folders inside excepted), the project's git hooks and git config
 *   (a hook runs outside the layer the next time the person commits) and the CLI's own permission settings;
 * - reads: not of other CLIs' credential folders, SSH/cloud keys and CanvasTTY's own tokens and secret stores, except
 *   what this launch was handed (its control grant, its account home, its plugin launch files);
 * - no other process may be signalled; no application opened through Launch Services (`open`), no Apple events
 *   (`osascript` driving Terminal), no preference writes through cfprefsd (`defaults write`, which would otherwise
 *   write outside the layer on the agent's behalf);
 * - Unix sockets: only DNS (mDNSResponder), syslog, this launch's own temporary folder and CanvasTTY's own
 *   token-authenticated gateways; no Docker, tmux, SSH agent or other daemon of the person's.
 *
 * Network and the keychain's services stay as they are: the CLI talks to its provider and reads its own sign-in.
 */
export function seatbeltProfile(paths: IsolationPaths): string {
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write*${paths.writable.map((path) => ` (subpath ${quote(path)})`).join("")})`,
    "(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/ptmx\") (literal \"/dev/dtracehelper\") (regex #\"^/dev/tty[^/]*$\") (regex #\"^/dev/fd/\"))"
  ];
  if (paths.creatableFolders.length > 0) {
    lines.push(`(allow file-write-create (require-all (vnode-type DIRECTORY) (require-any${paths.creatableFolders.map((path) => ` (literal ${quote(path)})`).join("")})))`);
  }
  if (paths.writableFiles.length > 0) {
    lines.push(`(allow file-write*${paths.writableFiles.map((path) => ` (regex ${regex(`^${escapeRegex(path)}(\\.[^/]*)?$`)})`).join("")})`);
  }
  // CanvasTTY's data folder inside a writable project: read-only again, except the writable folders inside it.
  if (paths.readOnlyFolders.length > 0) {
    lines.push(`(deny file-write*${paths.readOnlyFolders.map((path) => ` (subpath ${quote(path)})`).join("")})`);
    const inside = paths.writable.filter((path) => paths.readOnlyFolders.some((folder) => path.startsWith(`${folder}/`)));
    if (inside.length > 0) lines.push(`(allow file-write*${inside.map((path) => ` (subpath ${quote(path)})`).join("")})`);
  }
  // Its parent folders inside the project: entries can be created in them, but they cannot be renamed or replaced.
  if (paths.fixedFolders.length > 0) {
    lines.push(`(deny file-write-unlink${paths.fixedFolders.map((path) => ` (literal ${quote(path)})`).join("")})`);
  }
  if (paths.unreadable.length > 0) {
    lines.push(`(deny file-read* file-write*${paths.unreadable.map((path) => ` (subpath ${quote(path)})`).join("")})`);
  }
  if (paths.readableAgain.length > 0) {
    lines.push(`(allow file-read*${paths.readableAgain.map((path) => ` (subpath ${quote(path)})`).join("")})`);
  }
  // The CLI's own home that sits in a hidden folder (an account home it was handed): writable again, like its other
  // folders (a sign-in refresh writes there). Its permission settings are denied again below.
  const ownHidden = paths.readableAgain.filter((path) => paths.writable.includes(path));
  if (ownHidden.length > 0) {
    lines.push(`(allow file-write*${ownHidden.map((path) => ` (subpath ${quote(path)})`).join("")})`);
  }
  // After every allow: git hooks and attributes of any repository in the project (only `*.sample` hooks, what
  // `git init` writes), and the protected files.
  const hookRules = [
    ...paths.gitHooks.map((path) => `^${escapeRegex(path)}/`),
    ...paths.projectRoots.map((path) => `^${escapeRegex(path)}/(.*/)?\\.git/hooks/`)
  ];
  if (hookRules.length > 0) {
    lines.push(`(deny file-write*${hookRules.map((pattern) => ` (regex ${regex(pattern)})`).join("")})`);
    lines.push(`(allow file-write*${hookRules.map((pattern) => ` (regex ${regex(`${pattern}[^/]+\\.sample$`)})`).join("")})`);
  }
  // Also what git reads its config and paths from, existing or not: `commondir`, `config.worktree` and the linked
  // worktrees' records (`worktrees/`). Objects, refs, the index, logs and HEAD stay writable: add, commit, checkout work.
  if (paths.projectRoots.length > 0) {
    const files = "(info/attributes|commondir|config\\.worktree(\\.lock)?|worktrees(/.*)?)";
    lines.push(`(deny file-write*${paths.projectRoots.map((path) => ` (regex ${regex(`^${escapeRegex(path)}/(.*/)?\\.git/${files}$`)})`).join("")})`);
    // These rules match by path: a `.git`, `hooks` or `info` folder renamed away and back would carry changes past
    // them, and so would the project folder itself moved into a writable folder outside it (the launch's temp) and
    // back. They cannot be renamed or removed; entries inside them can still be created where allowed.
    lines.push(`(deny file-write-unlink${paths.projectRoots.map((path) => ` (regex ${regex(`^${escapeRegex(path)}(/(.*/)?\\.git(/hooks|/info)?)?$`)})`).join("")})`);
  }
  const protectedPaths = [...paths.protectedWrites, ...(paths.protectedDirectories ?? [])];
  if (protectedPaths.length > 0) {
    lines.push(`(deny file-write*${protectedPaths.map((path) => ` (subpath ${quote(path)})`).join("")})`);
  }
  lines.push(
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    "(deny lsopen)",
    "(deny appleevent-send)",
    "(deny user-preference-write)",
    "(deny network-outbound (remote unix-socket))"
  );
  // One filter per rule: `remote unix-socket` does not take a list (measured: only one of several listed matched).
  const sockets = [
    "(path-literal \"/private/var/run/mDNSResponder\")",
    "(path-literal \"/private/var/run/syslog\")",
    ...paths.socketFolders.map((path) => `(subpath ${quote(path)})`),
    ...paths.socketPrefixes.map((prefix) => `(regex ${regex(`^${escapeRegex(prefix)}[^/]*/`)})`)
  ];
  for (const socket of sockets) lines.push(`(allow network-outbound (remote unix-socket ${socket}))`);
  return `${lines.join("\n")}\n`;
}

/** An SBPL string literal. Paths with a quote, a backslash or a control character are refused, never escaped. */
function quote(path: string): string {
  if (/["\\\u0000-\u001f]/u.test(path)) throw new Error(`The path ${JSON.stringify(path)} cannot be written into an isolation profile.`);
  return `"${path}"`;
}

function regex(pattern: string): string {
  if (/["\u0000-\u001f]/u.test(pattern)) throw new Error("A path cannot be written into an isolation profile.");
  return `#"${pattern}"`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
