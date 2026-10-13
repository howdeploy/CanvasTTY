import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditRepositories, dangerousConfigEntries, neutralizeRepositories, removeConfigEntries } from "../src/main/services/isolation/gitAudit.ts";

test("config entries that make the person's git run a program are found, however they are spelled", () => {
  const text = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tHooksPath = /tmp/evil",
    "\tfsmonitor = true",
    "[core] sshCommand = \"ssh -o ProxyCommand=evil\" ; inline",
    "[filter \"lfs\"]",
    "\tclean = git-lfs clean -- %f",
    "\trequired",
    "[diff \"x\"]",
    "\ttextconv = sh -c \\",
    "  'evil'",
    "[alias]",
    "\tst = status",
    "\tpwn = !sh -c evil",
    "[includeIf \"gitdir:~/\"]",
    "\tpath = /tmp/more.config",
    "[user]",
    "\tname = n",
    "# [core] hooksPath = commented"
  ].join("\n");
  assert.deepEqual(dangerousConfigEntries(text).map((entry) => entry.key), [
    "core.hookspath", "core.sshcommand", "filter.lfs.clean", "diff.x.textconv", "alias.pwn", "includeif.gitdir:~/.path"
  ]);
  const cleaned = removeConfigEntries(text, dangerousConfigEntries(text).map((entry) => entry.key));
  assert.deepEqual(dangerousConfigEntries(cleaned), []);
  for (const kept of ["repositoryformatversion = 0", "fsmonitor = true", "st = status", "name = n", "\trequired", "[core]", "[alias]"]) {
    assert.ok(cleaned.includes(kept), kept);
  }
  assert.ok(!cleaned.includes("evil"), "continuation lines go with their entry");
});

async function repo(root, relative, config) {
  const gitDir = join(root, relative, ".git");
  await mkdir(join(gitDir, "hooks"), { recursive: true });
  await writeFile(join(gitDir, "config"), config);
  return gitDir;
}

test("only repositories changed since the session started are reported, with each key and hook; neutralize removes exactly those", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-git-audit-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = await repo(root, "old", "[core]\n\thooksPath = /person/own/hooks\n");
  // Older than the audit's 50 ms allowance for coarse file clocks.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const since = Date.now();
  const top = await repo(root, ".", "[core]\n\tbare = false\n\tfsmonitor = /tmp/run-me\n[user]\n\tname = n\n");
  await writeFile(join(top, "hooks", "post-commit"), "#!/bin/sh\nevil\n", { mode: 0o755 });
  await writeFile(join(top, "hooks", "pre-commit.sample"), "sample");
  const nested = await repo(root, "deep/nested", "[user]\n\tname = n\n");
  await mkdir(join(nested, "info"));
  await writeFile(join(nested, "info", "attributes"), "* filter=x\n");
  await repo(root, "node_modules/pkg", "[core]\n\thooksPath = /x\n");
  await repo(root, "clean", "[user]\n\tname = n\n");

  const found = await auditRepositories(root, since);
  assert.deepEqual(found.map((entry) => entry.gitDir).sort(), [nested, top].sort(), "the old, clean and node_modules repositories are not reported");
  const topItems = found.find((entry) => entry.gitDir === top).items;
  assert.deepEqual(topItems, [{ kind: "config", key: "core.fsmonitor", value: "/tmp/run-me" }, { kind: "hook", name: "post-commit" }]);
  assert.deepEqual(found.find((entry) => entry.gitDir === nested).items, [{ kind: "attributes" }]);

  await neutralizeRepositories(found);
  assert.equal(await readFile(join(top, "config"), "utf8"), "[core]\n\tbare = false\n[user]\n\tname = n\n");
  assert.deepEqual((await readdir(join(top, "hooks"))).sort(), ["post-commit.disabled-by-canvastty", "pre-commit.sample"]);
  assert.deepEqual(await readdir(join(nested, "info")), ["attributes.disabled-by-canvastty"]);
  assert.match(await readFile(join(old, "config"), "utf8"), /hooksPath/u, "the person's own repository is untouched");
  assert.deepEqual(await auditRepositories(root, since), []);
});

test("a change the file clock stamps slightly before the session's start still counts (coarse kernel clocks)", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-git-clock-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitDir = await repo(root, ".", "[core]\n\tfsmonitor = /tmp/run-me\n");
  // Linux stamps files from a clock that may lag Date.now() by a tick: the start recorded just before the write can
  // read a few milliseconds later than the file's own time.
  const found = await auditRepositories(root, Date.now() + 20);
  assert.deepEqual(found.map((entry) => entry.gitDir), [gitDir]);
});

/** Real git, with no configuration of the machine or the person. */
function git(cwd, ...args) {
  const empty = join(cwd, "..", ".empty-gitconfig");
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
}

test("a repository whose .git is a file (--separate-git-dir) is audited where git keeps it (the reviewer's case)", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-git-separate-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(root, ".empty-gitconfig"), "");
  // Both the working tree and its git directory inside the agent's writable project.
  git(project, "init", "-q", "--separate-git-dir", join(project, "repo-data"), join(project, "repo"));
  assert.match(await readFile(join(project, "repo", ".git"), "utf8"), /^gitdir: /u);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const program = join(root, "prog");
  git(join(project, "repo"), "config", "core.fsmonitor", program);
  assert.equal(git(join(project, "repo"), "rev-parse", "--is-inside-work-tree").trim(), "true", "git recognizes the repository");

  const found = await auditRepositories(project, 0);
  const repo = found.find((entry) => entry.worktree === join(project, "repo"));
  assert.ok(repo, "the repository behind the .git file is reported");
  assert.equal(repo.gitDir, join(project, "repo-data"));
  assert.deepEqual(repo.items, [{ kind: "config", key: "core.fsmonitor", value: program }]);
  assert.equal(found.length, 1, "its git directory is not reported a second time as a folder");
  await neutralizeRepositories(found);
  assert.doesNotMatch(await readFile(join(project, "repo-data", "config"), "utf8"), /fsmonitor/u);
  assert.equal(git(join(project, "repo"), "config", "--get", "core.bare").trim(), "false", "the rest of the config stays");
});

test("a linked worktree's hooks and shared config are audited in its main repository, its own config.worktree too", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-git-worktree-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const main = join(project, "main");
  await mkdir(main, { recursive: true });
  await writeFile(join(root, ".empty-gitconfig"), "");
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "first");
  git(main, "worktree", "add", "-q", join(project, "wt"));
  git(main, "config", "extensions.worktreeConfig", "true");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const since = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 30));
  // From inside the linked worktree: a hook (git runs it from the main repository) and a per-worktree setting.
  const hooksDir = git(join(project, "wt"), "rev-parse", "--path-format=absolute", "--git-path", "hooks").trim();
  assert.equal(await realpath(hooksDir), join(main, ".git", "hooks"), "git runs the worktree's hooks from the main repository");
  const hook = join(main, ".git", "hooks", "post-checkout");
  await writeFile(hook, "#!/bin/sh\nevil\n", { mode: 0o755 });
  git(join(project, "wt"), "config", "--worktree", "core.sshCommand", "evil-ssh");

  const found = await auditRepositories(project, since);
  const worktree = found.find((entry) => entry.worktree === join(project, "wt"));
  assert.ok(worktree, "the linked worktree is reported");
  assert.equal(worktree.commonDir, join(main, ".git"));
  const all = found.flatMap((entry) => entry.items);
  assert.deepEqual(all.filter((item) => item.kind === "hook"), [{ kind: "hook", name: "post-checkout" }], "the shared hook once, not per worktree");
  assert.deepEqual(worktree.items.filter((item) => item.kind === "config"), [{ kind: "config", key: "core.sshcommand", value: "evil-ssh" }]);
  await neutralizeRepositories(found);
  assert.deepEqual(await auditRepositories(project, since), []);
  assert.equal(existsSync(hook), false);
  assert.equal(existsSync(`${hook}.disabled-by-canvastty`), true);
});

test("the .git entries the audit does not trust: a pointer to nothing, an oversized pointer, a linked folder it does not walk into", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-git-pointers-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "a"));
  await writeFile(join(root, "a", ".git"), "gitdir: ../missing\n");
  await mkdir(join(root, "b"));
  await writeFile(join(root, "b", ".git"), `gitdir: ${"x".repeat(5000)}\n`);
  const outside = await realpath(await mkdtemp(join(tmpdir(), "canvastty-git-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await repo(outside, "r", "[core]\n\thooksPath = /x\n");
  await symlink(outside, join(root, "link"), "dir").catch(() => undefined);
  assert.deepEqual(await auditRepositories(root, 0), []);
});

// ---- the card: audited when an isolated session ends, is closed, or is restored ----
import { AgentIsolation } from "../src/main/services/isolation/AgentIsolation.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { IPC } from "../src/shared/contracts.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const at = { x: 0, y: 0 };

async function isolatedManager(t, project, events = [], store = null) {
  const calls = [];
  const terminals = new TerminalManager((channel, payload) => events.push({ channel, payload }), availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.shutdown());
  terminals.configureIsolation({
    containment: () => true,
    decide: (input) => new AgentIsolation({ userDataPath: join(project, "..", "u"), enabled: () => true, platform: "darwin", exists: () => true }).decide(input),
    wrap: (launch) => ({ command: "/usr/bin/sandbox-exec", args: ["-f", "/p.sb", launch.command, ...launch.args], env: launch.env, cleanup: () => undefined })
  });
  if (store) {
    terminals.configureSessionPersistence(store, "continue");
    await terminals.restorePersistedSessions();
  }
  return { terminals, calls };
}

async function until(predicate, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
}

/** What an agent inside the layer could leave behind (macOS denies hooks; the config is allowed). */
async function plant(project) {
  await mkdir(join(project, ".git", "hooks"), { recursive: true });
  await writeFile(join(project, ".git", "config"), "[core]\n\thooksPath = /tmp/evil\n[user]\n\tname = n\n");
}

test("an isolated session that ends with a dangerous git setting shows it on its card; neutralize removes exactly that", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "canvastty-git-card-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "p");
  await mkdir(project);
  const { terminals, calls } = await isolatedManager(t, project);
  const card = terminals.create({ provider: "qwen", profile: "auto", cwd: project, position: at });
  assert.equal(card.isolation?.state, "on");
  await plant(project);
  calls.at(-1).process.emitExit(0);
  const risk = await until(() => terminals.getMetadata(card.id)?.gitRisk);
  assert.deepEqual(risk.repositories, [{ path: project, items: [{ kind: "config", key: "core.hookspath", value: "/tmp/evil" }] }]);
  assert.match(await readFile(join(project, ".git", "config"), "utf8"), /hooksPath/u, "nothing changed without the person");
  await terminals.resolveGitRisk(risk.id, "neutralize");
  assert.equal(await readFile(join(project, ".git", "config"), "utf8"), "[core]\n[user]\n\tname = n\n");
  assert.equal(terminals.getMetadata(card.id).gitRisk, undefined);
});

test("a closed isolated card's git settings are reported to the app; keep leaves them; a clean session reports nothing", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "canvastty-git-close-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "p");
  await mkdir(project);
  const events = [];
  const { terminals } = await isolatedManager(t, project, events);
  const clean = terminals.create({ provider: "qwen", profile: "auto", cwd: project, position: at });
  terminals.dispose(clean.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(events.filter((event) => event.channel === IPC.terminalGitRisk), []);
  const card = terminals.create({ provider: "qwen", profile: "auto", cwd: project, position: at, title: "worker" });
  await plant(project);
  terminals.dispose(card.id);
  const reported = await until(() => events.find((event) => event.channel === IPC.terminalGitRisk)?.payload);
  assert.equal(reported.title, "worker");
  assert.equal(reported.repositories[0].items[0].key, "core.hookspath");
  await terminals.resolveGitRisk(reported.id, "keep");
  assert.match(await readFile(join(project, ".git", "config"), "utf8"), /hooksPath/u, "kept as the person chose");
  await assert.rejects(terminals.resolveGitRisk(reported.id, "neutralize"), /no longer/u);
});

test("a card restored after the app quit mid-session is audited on restore", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "canvastty-git-restore-")));
  const project = join(base, "p");
  const storeDirectory = join(base, "store");
  await mkdir(project);
  await mkdir(storeDirectory);
  const first = await isolatedManager(t, project, [], new TerminalSessionStore(storeDirectory));
  const card = first.terminals.create({ provider: "qwen", profile: "auto", cwd: project, position: at });
  await plant(project);
  await first.terminals.shutdown();
  const saved = JSON.parse(await readFile(join(storeDirectory, "terminal-sessions.json"), "utf8")).sessions;
  assert.ok(saved.find((record) => record.id === card.id).gitAuditSince > 0, "the pending audit is saved");
  const second = await isolatedManager(t, project, [], new TerminalSessionStore(storeDirectory));
  const risk = await until(() => second.terminals.getMetadata(card.id)?.gitRisk);
  assert.equal(risk.repositories[0].items[0].key, "core.hookspath");
  // The store is written until the manager is shut down: only then is the folder removed.
  await second.terminals.shutdown();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});
