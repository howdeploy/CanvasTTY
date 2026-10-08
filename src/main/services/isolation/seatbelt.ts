import type { IsolationPaths } from "./isolationPaths.ts";

/**
 * The macOS seatbelt profile (SBPL, read by /usr/bin/sandbox-exec) of one isolated agent. Everything is allowed
 * except what is listed, and a later rule wins over an earlier one:
 *
 * - writes: nowhere, then the project (every spelling), this launch's own temporary folder, the CLI's own state,
 *   config and cache folders and the package caches, then again nowhere in the project's git hooks and git config
 *   (a hook runs outside the layer the next time the person commits) and the CLI's own permission settings;
 * - reads: not of other CLIs' credential folders, SSH/cloud keys and CanvasTTY's own tokens and secret stores, except
 *   what this launch was handed (its control grant, its account home, its plugin launch files);
 * - no other process may be signalled; no application opened through Launch Services (`open`), no Apple events
 *   (`osascript` driving Terminal), no preference writes through cfprefsd (`defaults write`, which would otherwise
 *   write outside the layer on the agent's behalf);
 * - Unix sockets: DNS (mDNSResponder), syslog, this launch's temporary folder and CanvasTTY's own gateways.
 *
 * The CLI keeps its provider network access. Diff-only reviewers receive narrowly scoped read grants.
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
  if (paths.unreadable.length > 0) {
    lines.push(`(deny${paths.restrictReads ? "" : " file-read*"} file-write*${paths.unreadable.map((path) => ` (subpath ${quote(path)})`).join("")})`);
  }
  if (paths.restrictReads) {
    // Deny regular-file reads globally while allowing narrower exact runtime, OS and diff paths to reopen them.
    // An unconditional `(deny file-read*)` wins over every exception in Seatbelt. Native macOS runtimes need directory
    // entries while resolving resources, so allow directory vnodes and immediately re-hide HOME and project roots.
    lines.push("(deny file-read* (vnode-type REGULAR-FILE))", "(allow file-read-metadata (vnode-type DIRECTORY))", "(allow file-read* (vnode-type DIRECTORY))");
    for (const path of paths.unreadable) lines.push(`(deny file-read* (subpath ${quote(path)}))`);
  }
  if (paths.readableAgain.length > 0) {
    if (paths.restrictReads) {
      // Separate rules make each spelling an independent exception. Combining path predicates in one rule intersects
      // them, so a caller opening `/var/...` would miss the grant even when its canonical `/private/var/...` was listed.
      for (const path of paths.readableAgain) lines.push(`(allow file-read* (subpath ${quote(path)}))`);
    } else {
      lines.push(`(allow file-read*${paths.readableAgain.map((path) => ` (subpath ${quote(path)})`).join("")})`);
    }
  }
  // plugin-data is denied as a whole to hide the private parent and every sibling worktree. Reopen this one exact
  // validated linked-worktree project for writes after that parent denial. The Git metadata denies below still win.
  const privateRootProjects = paths.projectRoots.filter((project) => paths.readableAgain.includes(project)
    && paths.unreadable.some((hidden) => hidden.endsWith("/plugin-data") && project.startsWith(`${hidden}/`)));
  if (privateRootProjects.length > 0) {
    lines.push(`(allow file-write*${privateRootProjects.map((path) => ` (subpath ${quote(path)})`).join("")})`);
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
  if (paths.projectRoots.length > 0) {
    lines.push(`(deny file-write*${paths.projectRoots.map((path) => ` (regex ${regex(`^${escapeRegex(path)}/(.*/)?\\.git/info/attributes$`)})`).join("")})`);
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
