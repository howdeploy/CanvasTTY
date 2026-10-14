import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentIsolation } from "../src/main/services/isolation/AgentIsolation.ts";
import { isolationPaths } from "../src/main/services/isolation/isolationPaths.ts";
import { seatbeltProfile } from "../src/main/services/isolation/seatbelt.ts";
import { bubblewrapArguments } from "../src/main/services/isolation/bubblewrap.ts";
import { LinuxHostPaths } from "../src/main/services/isolation/linuxHostPaths.ts";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const onMac = { skip: mac ? false : "macOS seatbelt (sandbox-exec) only" };
const hasGit = spawnSync("git", ["--version"]).status === 0;
const withGit = { skip: process.platform === "win32" ? "POSIX paths" : hasGit ? false : "git is not installed" };
const GIT_IDENTITY = "-c user.email=a@b -c user.name=n";

async function world(t) {
  const base = await realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "ctty-git-test-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "h");
  const userData = join(base, "u");
  const project = join(base, "p");
  const temp = join(base, "t");
  const template = join(base, "tpl");
  for (const dir of [home, userData, project, temp, template]) await mkdir(dir, { recursive: true });
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", GIT_CONFIG_NOSYSTEM: "1" };
  return { base, home, userData, project, temp, template, env };
}

function git(w, ...args) {
  const result = spawnSync("git", args, { cwd: w.project, env: { ...w.env, GIT_TEMPLATE_DIR: w.template }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function pathsFor(w, options = {}) {
  return isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "s"), env: w.env, userDataPath: w.userData, sessionId: "s", ...options });
}

test("the paths: an existing repository's per-worktree config, commondir and worktree records are protected", withGit, async (t) => {
  const w = await world(t);
  const gitDir = join(w.project, ".git");
  // No repository yet: nothing to protect by path (seatbelt's pattern still covers what `git init` makes).
  const fresh = pathsFor(w);
  assert.ok(!fresh.protectedWrites.some((path) => path.startsWith(`${gitDir}/`)));
  assert.match(seatbeltProfile(fresh), /\\\.git\/\(info\/attributes\|commondir\|config\\\.worktree\(\\\.lock\)\?\|worktrees\(\/\.\*\)\?\)\$/u);
  git(w, "init", "-q");
  const paths = pathsFor(w);
  for (const file of ["config", "config.worktree", "config.worktree.lock"]) assert.ok(paths.protectedWrites.includes(join(gitDir, file)), file);
  assert.ok(!paths.protectedWrites.includes(join(gitDir, "commondir")), "a missing commondir gets no placeholder: git would refuse an empty one");
  assert.ok(paths.protectedDirectories.includes(join(gitDir, "worktrees")));
  await writeFile(join(gitDir, "commondir"), ".\n");
  assert.ok(pathsFor(w).protectedWrites.includes(join(gitDir, "commondir")), "an existing one is protected");
  // Objects, refs, the index, logs and HEAD stay writable.
  for (const name of ["objects", "refs", "index", "logs", "HEAD", "packed-refs", "ORIG_HEAD"]) {
    const path = join(gitDir, name);
    assert.ok(![...paths.protectedWrites, ...paths.protectedDirectories].some((p) => path === p || path.startsWith(`${p}/`)), name);
  }
});

test("bubblewrap: the records are mounted read-only; a missing config.worktree and worktrees folder get neutral placeholders", withGit, async (t) => {
  const w = await world(t);
  git(w, "init", "-q");
  const gitDir = join(w.project, ".git");
  const kind = (path) => {
    try { const stat = statSync(path); return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null; } catch { return null; }
  };
  const paths = pathsFor(w);
  const hostPaths = new LinuxHostPaths();
  const release = hostPaths.prepare(paths);
  try {
    assert.equal(await readFile(join(gitDir, "config.worktree"), "utf8"), "", "an empty config.worktree means no per-worktree config");
    assert.equal(kind(join(gitDir, "worktrees")), "directory");
    assert.equal(existsSync(join(gitDir, "commondir")), false, "no commondir placeholder");
    // The person's git outside the layer keeps working with them in place.
    git(w, "status", "--short");
    assert.equal(git(w, "rev-parse", "--git-common-dir").trim(), ".git");
    const args = bubblewrapArguments(paths, { command: "/usr/bin/codex", args: [], cwd: w.project }, kind).join(" ");
    const project = args.indexOf(`--bind ${w.project} ${w.project}`);
    const repository = args.indexOf(`--bind ${gitDir} ${gitDir}`);
    assert.ok(repository > project, ".git is a mount point of its own: it cannot be renamed away and back");
    for (const path of [join(gitDir, "config"), join(gitDir, "config.worktree"), join(gitDir, "worktrees")]) {
      assert.ok(args.indexOf(`--ro-bind ${path} ${path}`) > repository, path);
    }
  } finally {
    release();
  }
  assert.equal(existsSync(join(gitDir, "config.worktree")), false, "placeholders removed");
  assert.equal(existsSync(join(gitDir, "worktrees")), false);
  // An existing commondir is mounted read-only.
  await writeFile(join(gitDir, "commondir"), ".\n");
  const placeholders = new Map([[join(gitDir, "config.worktree"), "file"], [join(gitDir, "worktrees"), "directory"]]);
  const withCommon = bubblewrapArguments(pathsFor(w), { command: "/usr/bin/codex", args: [], cwd: w.project },
    (path) => kind(path) ?? placeholders.get(path) ?? null).join(" ");
  assert.ok(withCommon.includes(`--ro-bind ${join(gitDir, "commondir")} ${join(gitDir, "commondir")}`));
});

function run(w, script) {
  const wrapped = new AgentIsolation({ userDataPath: w.userData, enabled: () => true, tempRoot: w.temp })
    .wrap({ sessionId: "s1", provider: "codex", cwd: w.project, command: "/bin/sh", args: ["-c", script], env: w.env });
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: w.project, env: wrapped.env, encoding: "utf8", timeout: 30_000 });
    return result.stdout.split("\n").filter(Boolean);
  } finally {
    wrapped.cleanup();
  }
}

const WORKFLOW = [
  `git init -q . && echo a > a.txt && git add a.txt && git ${GIT_IDENTITY} commit -q -m one && echo GIT-COMMIT-ok`,
  `git checkout -q -b x && echo b > b.txt && git add b.txt && git ${GIT_IDENTITY} commit -q -m two && git checkout -q - && git branch -q y && echo GIT-BRANCH-ok`,
  `echo c >> a.txt && git ${GIT_IDENTITY} stash -q && git ${GIT_IDENTITY} stash pop -q && git ${GIT_IDENTITY} commit -q -am three && echo GIT-STASH-ok`
];
const PROTECTED = [
  'echo .. > .git/commondir 2>/dev/null || echo W-commondir-denied',
  '(printf "[core]\\n\\thooksPath = /tmp\\n" > .git/config.worktree) 2>/dev/null || echo W-config-worktree-denied',
  'mkdir .git/worktrees 2>/dev/null || echo W-worktrees-denied',
  'git worktree add -q wt 2>/dev/null || echo GIT-WORKTREE-ADD-denied',
  `git init -q deep/n && (echo .. > deep/n/.git/commondir) 2>/dev/null || echo W-nested-commondir-denied`,
  'mv .git moved 2>/dev/null || echo MV-git-denied',
  'mkdir -p .git/hooks .git/info && mv .git/hooks .git/h2 2>/dev/null || echo MV-hooks-denied',
  'mv .git/info .git/i2 2>/dev/null || echo MV-info-denied',
  'mv deep/n/.git deep/n/moved 2>/dev/null || echo MV-nested-git-denied'
];

test("seatbelt, for real: init, add, commit, checkout, branch and stash work; git's pointers and worktree records cannot be created", onMac, async (t) => {
  const w = await world(t);
  const lines = run(w, [...WORKFLOW, ...PROTECTED, 'git log --oneline | wc -l | tr -d " "'].join("; "));
  assert.deepEqual(lines, ["GIT-COMMIT-ok", "GIT-BRANCH-ok", "GIT-STASH-ok", "W-commondir-denied", "W-config-worktree-denied", "W-worktrees-denied",
    "GIT-WORKTREE-ADD-denied", "W-nested-commondir-denied", "MV-git-denied", "MV-hooks-denied", "MV-info-denied", "MV-nested-git-denied", "2"]);
  for (const path of [".git/commondir", ".git/config.worktree", ".git/worktrees", "deep/n/.git/commondir", "moved", ".git/h2", ".git/i2"]) {
    assert.equal(existsSync(join(w.project, path)), false, path);
  }
});

test("seatbelt, for real: an existing repository's records stay as they are; ordinary work continues", onMac, async (t) => {
  const w = await world(t);
  git(w, "init", "-q");
  await writeFile(join(w.project, "a.txt"), "a\n");
  git(w, "add", "a.txt");
  git(w, "-c", "user.email=a@b", "-c", "user.name=n", "commit", "-q", "-m", "one");
  git(w, "worktree", "add", "-q", join(w.base, "linked"));
  await writeFile(join(w.project, ".git", "config.worktree"), "[user]\n\tname = kept\n");
  const record = join(w.project, ".git", "worktrees", "linked");
  const before = await readFile(join(record, "gitdir"), "utf8");
  const lines = run(w, [
    `echo b > b.txt && git add b.txt && git ${GIT_IDENTITY} commit -q -m two && git checkout -q -b x && echo GIT-ok`,
    'echo /tmp/x > .git/worktrees/linked/gitdir 2>/dev/null || echo W-record-denied',
    'echo .. > .git/worktrees/linked/commondir 2>/dev/null || echo W-record-commondir-denied',
    'rm -rf .git/worktrees 2>/dev/null; [ -d .git/worktrees/linked ] && echo RM-worktrees-denied',
    'echo x >> .git/config.worktree 2>/dev/null || echo W-config-worktree-denied'
  ].join("; "));
  assert.deepEqual(lines, ["GIT-ok", "W-record-denied", "W-record-commondir-denied", "RM-worktrees-denied", "W-config-worktree-denied"]);
  assert.equal(await readFile(join(record, "gitdir"), "utf8"), before);
  assert.equal(await readFile(join(w.project, ".git", "config.worktree"), "utf8"), "[user]\n\tname = kept\n");
  assert.equal(git(w, "rev-parse", "--abbrev-ref", "HEAD").trim(), "x");
});
