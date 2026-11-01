import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { AgentIsolation, ISOLATION_FOLDER_PREFIX, probeBubblewrap } from "../src/main/services/isolation/AgentIsolation.ts";
import { isolationPaths } from "../src/main/services/isolation/isolationPaths.ts";
import { seatbeltProfile } from "../src/main/services/isolation/seatbelt.ts";
import { bubblewrapArguments } from "../src/main/services/isolation/bubblewrap.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { codexInsideIsolation } from "../src/main/services/terminalLaunch.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const at = { x: 0, y: 0 };
const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const onMac = { skip: mac ? false : "macOS seatbelt (sandbox-exec) only" };

/** A fake HOME with the files an escape would go for, a CanvasTTY userData folder and a project in NFD. */
async function world(t) {
  // Short: Unix socket paths are limited to ~104 bytes (/tmp rather than macOS's long per-user folder). Windows has no
  // /tmp and no Unix socket limit: its temporary folder.
  const base = await realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "ctty-iso-test-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "h");
  const userData = join(base, "u");
  const project = join(base, "Проект".normalize("NFD"));
  const temp = join(base, "t");
  for (const dir of [project, temp, join(home, ".ssh"), join(home, ".aws"), join(home, "victim", "deep"), join(home, ".codex"),
    join(home, ".claude"), join(home, ".config", "opencode"), join(home, ".local", "share", "opencode"), join(home, ".grok"),
    join(userData, "agent-control", "sessions", "own"), join(userData, "account-homes", "a1"), join(userData, "lifecycle", "runtime")]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(home, ".ssh", "id_test"), "FAKE-PRIVATE-KEY");
  await writeFile(join(home, ".aws", "credentials"), "FAKE");
  await writeFile(join(home, "victim", "deep", "file"), "keep me");
  await writeFile(join(home, ".claude", ".credentials.json"), "FAKE-CLAUDE");
  await writeFile(join(home, ".local", "share", "opencode", "auth.json"), "FAKE-OPENCODE");
  await writeFile(join(userData, "agent-control", "token-app"), "APP-TOKEN");
  await writeFile(join(userData, "agent-control", "sessions", "own", "connection.json"), "{}");
  await writeFile(join(userData, "provider-secrets.bin"), "SECRETS");
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
  return { base, home, userData, project, temp, env };
}

function isolation(w, options = {}) {
  return new AgentIsolation({ userDataPath: w.userData, enabled: () => true, tempRoot: w.temp, ...options });
}

/** Runs `sh -c script` under the generated profile; returns stdout lines. */
function run(w, script, { provider = "codex", env = {}, granted } = {}) {
  const wrapped = isolation(w).wrap({ sessionId: "s1", provider, cwd: w.project.normalize("NFC"), command: "/bin/sh", args: ["-c", script],
    env: { ...w.env, ...env }, ...(granted ? { grantedPrivate: granted } : {}) });
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: w.project, env: wrapped.env, encoding: "utf8", timeout: 20_000 });
    return { lines: result.stdout.split("\n").filter(Boolean), stderr: result.stderr, env: wrapped.env };
  } finally {
    wrapped.cleanup();
  }
}

test("the isolation decision: delegated and non-manual launches, the person's setting, missing layers and environments", () => {
  const on = new AgentIsolation({ userDataPath: "/u", enabled: () => true, platform: "darwin", exists: () => true });
  assert.deepEqual(on.decide({ provider: "codex", profile: "normal", delegated: false }), { apply: false, profile: "normal" }, "manual: the person answers");
  assert.deepEqual(on.decide({ provider: "terminal", profile: "normal", delegated: true }), { apply: false, profile: "normal" });
  for (const profile of ["auto", "acceptEdits", "plan", "yolo"]) {
    assert.deepEqual(on.decide({ provider: "claude", profile, delegated: false }), { apply: true, profile, isolation: { state: "on", layer: "seatbelt" } }, profile);
  }
  assert.equal(on.decide({ provider: "codex", profile: "normal", delegated: true }).apply, true, "a subagent always");
  assert.deepEqual(on.decide({ provider: "codex", profile: "auto", delegated: true, environment: { isolated: true, label: "Container" } }),
    { apply: false, profile: "auto", isolation: { state: "environment", reason: "Runs in Container; the isolation layer of this computer does not apply there." } });
  assert.equal(on.decide({ provider: "codex", profile: "auto", delegated: true, environment: { isolated: false, label: "Worktree" } }).apply, true);

  const off = new AgentIsolation({ userDataPath: "/u", enabled: () => false, platform: "darwin", exists: () => true });
  assert.deepEqual(off.decide({ provider: "claude", profile: "auto", delegated: false }),
    { apply: false, profile: "auto", isolation: { state: "off", reason: "agent isolation is off in Settings → Agents." } });
  assert.match(off.decide({ provider: "qwen", profile: "auto", delegated: false }).refuse, /qwen has no auto mode of its own; its auto runs only inside/u);
  // Off is the person's opt-in: a subagent keeps its profile (a contained auto, a bypass, still becomes normal).
  assert.deepEqual(off.decide({ provider: "codex", profile: "auto", delegated: true }).profile, "auto");
  assert.deepEqual(off.decide({ provider: "qwen", profile: "auto", delegated: true }).profile, "normal");

  const windows = new AgentIsolation({ userDataPath: "C:\\u", enabled: () => true, platform: "win32" });
  const sub = windows.decide({ provider: "codex", profile: "auto", delegated: true });
  assert.deepEqual([sub.apply, sub.profile, sub.isolation.state], [false, "normal", "unavailable"]);
  assert.match(sub.isolation.reason, /no agent isolation layer on Windows yet\. It runs in normal \(it asks\) instead of auto\./u);
  assert.deepEqual(windows.decide({ provider: "codex", profile: "auto", delegated: false }).profile, "auto", "the person's own auto keeps its CLI's auto");
  assert.equal(windows.decide({ provider: "codex", profile: "plan", delegated: true }).profile, "plan", "never raised");
  const linux = new AgentIsolation({ userDataPath: "/u", enabled: () => true, platform: "linux", bubblewrapPath: null });
  assert.match(linux.decide({ provider: "claude", profile: "auto", delegated: true }).isolation.reason, /bubblewrap \(bwrap\) is not installed/u);
  assert.throws(() => windows.wrap({ sessionId: "s", provider: "codex", cwd: "C:\\p", command: "codex", args: [], env: {} }),
    /not available: .* not started without it/u, "fails closed");
});

test("bubblewrap that cannot create a user namespace (Ubuntu's AppArmor restriction) counts as no layer, and is checked again later", () => {
  let now = 0;
  const calls = [];
  let answer = "bwrap: setting up uid map: Permission denied";
  const linux = new AgentIsolation({ userDataPath: "/u", enabled: () => true, platform: "linux", bubblewrapPath: "/usr/bin/bwrap", now: () => now,
    bubblewrapProbe: (bwrap) => { calls.push(bwrap); return answer; } });
  const sub = linux.decide({ provider: "codex", profile: "auto", delegated: true });
  assert.deepEqual([sub.apply, sub.profile, sub.isolation.state, sub.refuse], [false, "normal", "unavailable", undefined], "a subagent runs in Manual instead of being refused");
  assert.match(sub.isolation.reason, /bubblewrap \(bwrap\) is installed but cannot create its sandbox here \(bwrap: setting up uid map: Permission denied\)/u);
  assert.match(sub.isolation.reason, /AppArmor\. docs\/installing-and-security\.md#linux-when-bubblewrap-cannot-start says how to allow it\. It runs in normal \(it asks\) instead of auto\./u);
  const own = linux.decide({ provider: "claude", profile: "acceptEdits", delegated: false });
  assert.deepEqual([own.apply, own.profile, own.isolation.state], [false, "acceptEdits", "unavailable"], "the person's own launch is not refused either");
  assert.equal(linux.containment(), false);
  assert.throws(() => linux.wrap({ sessionId: "s", provider: "codex", cwd: "/p", command: "codex", args: [], env: {} }), /not available: bubblewrap \(bwrap\) is installed but/u);
  assert.deepEqual(calls, ["/usr/bin/bwrap"], "checked once while the answer is fresh");

  now = 59_000;
  linux.decide({ provider: "codex", profile: "auto", delegated: true });
  assert.equal(calls.length, 1);
  answer = null; // the person allowed it (an AppArmor profile for bwrap, or the sysctl)
  now = 61_000;
  assert.deepEqual(linux.decide({ provider: "codex", profile: "auto", delegated: true }), { apply: true, profile: "auto", isolation: { state: "on", layer: "bubblewrap" } });
  assert.equal(calls.length, 2);
  now = 10_000_000;
  answer = "would not be asked again";
  assert.equal(linux.decide({ provider: "codex", profile: "auto", delegated: true }).apply, true, "a working bubblewrap is kept");
  assert.equal(calls.length, 2);

  const throwing = new AgentIsolation({ userDataPath: "/u", enabled: () => true, platform: "linux", bubblewrapPath: "/usr/bin/bwrap", bubblewrapProbe: () => { throw new Error("spawn EACCES"); } });
  assert.match(throwing.decide({ provider: "codex", profile: "auto", delegated: true }).isolation.reason, /cannot create its sandbox here \(spawn EACCES\)/u);
});

test("the bubblewrap check reports what bubblewrap said, and a missing binary", { skip: process.platform === "win32" ? "POSIX shell script" : false }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ctty-bwprobe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "bwrap");
  await writeFile(fake, "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n", { mode: 0o755 });
  assert.equal(probeBubblewrap(fake), "bwrap: setting up uid map: Permission denied");
  const ok = join(dir, "ok");
  await writeFile(ok, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(probeBubblewrap(ok), null);
  assert.match(probeBubblewrap(join(dir, "missing")), /ENOENT/u);
});

test("the paths: the project and the CLI's own folders writable; other CLIs' credentials, keys and CanvasTTY's tokens unreadable", async (t) => {
  const w = await world(t);
  const paths = isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "s"), env: { ...w.env, CANVASTTY_RUNTIME_ADDRESS: join(w.userData, "lifecycle", "runtime", "r.sock") },
    userDataPath: w.userData, sessionId: "s1", grantedPrivate: [join(w.userData, "agent-control", "sessions", "own")] });
  assert.ok(paths.writable.includes(w.project) && paths.writable.includes(w.project.normalize("NFC")), "both spellings");
  assert.ok(paths.writable.includes(join(w.home, ".codex")));
  assert.ok(!paths.writable.includes(join(w.home, ".claude")));
  for (const secret of [join(w.home, ".ssh"), join(w.home, ".aws"), join(w.home, ".claude"), join(w.home, ".local", "share", "opencode"),
    join(w.home, ".grok"), join(w.userData, "agent-control"), join(w.userData, "provider-secrets.bin"), join(w.userData, "account-homes")]) {
    assert.ok(paths.unreadable.includes(secret), secret);
  }
  assert.ok(!paths.unreadable.includes(join(w.home, ".codex")), "its own folder stays readable");
  assert.ok(paths.readableAgain.includes(join(w.userData, "agent-control", "sessions", "own")));
  assert.ok(paths.socketFolders.includes(join(w.userData, "lifecycle", "runtime")));
  assert.ok(paths.protectedWrites.includes(join(w.home, ".codex", "config.toml")), "its own permission settings stay the person's");
  // An account home a launch was handed is its own state.
  const moved = isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "s"), env: { ...w.env, CODEX_HOME: join(w.userData, "account-homes", "a1") },
    userDataPath: w.userData, sessionId: "s1" });
  assert.ok(moved.writable.includes(join(w.userData, "account-homes", "a1")) && moved.readableAgain.includes(join(w.userData, "account-homes", "a1")));
  assert.throws(() => seatbeltProfile({ ...paths, writable: ['/x"'] }), /cannot be written into an isolation profile/u);
  // A seatbelt profile holds macOS paths; this world's paths are Windows paths on the Windows runner (a backslash is
  // refused like the quote above), so there its fixed rules are read from a profile without paths.
  const macPaths = process.platform === "win32" ? Object.fromEntries(Object.keys(paths).map((key) => [key, []])) : paths;
  const profile = seatbeltProfile(macPaths);
  for (const rule of ["(deny file-write*)", "(deny signal)", "(allow signal (target same-sandbox))", "(deny lsopen)", "(deny appleevent-send)",
    "(deny user-preference-write)", "(deny network-outbound (remote unix-socket))"]) assert.ok(profile.includes(rule), rule);
});

test("bubblewrap: read-only root, writable project, tmpfs over what may not be read, the user runtime folder hidden", async (t) => {
  const w = await world(t);
  const paths = isolationPaths({ provider: "claude", cwd: w.project, sessionTemp: join(w.temp, "s"), env: w.env, userDataPath: w.userData, sessionId: "s" });
  const kinds = new Map([[w.project, "directory"], [join(w.home, ".ssh"), "directory"], [join(w.userData, "provider-secrets.bin"), "file"], ["/run/user/1000", "directory"]]);
  const args = bubblewrapArguments(paths, { command: "/usr/bin/claude", args: ["--x"], cwd: w.project, runtimeDir: "/run/user/1000" }, (path) => kinds.get(path) ?? null);
  const text = args.join(" ");
  assert.match(text, /^--die-with-parent --unshare-pid --unshare-ipc --ro-bind \/ \/ --dev-bind \/dev \/dev --proc \/proc/u);
  assert.ok(text.includes(`--bind ${w.project} ${w.project}`));
  assert.ok(text.includes(`--tmpfs ${join(w.home, ".ssh")}`));
  assert.ok(text.includes(`--ro-bind /dev/null ${join(w.userData, "provider-secrets.bin")}`));
  assert.ok(text.includes("--tmpfs /run/user/1000"));
  assert.deepEqual(args.slice(-5), ["--chdir", w.project, "--", "/usr/bin/claude", "--x"]);
});

test("the paths: another CLI's home moved by its own variable is unreadable, never this CLI's own", async (t) => {
  const w = await world(t);
  const custom = (name) => join(w.base, "creds", name);
  const env = {
    ...w.env, GROK_HOME: custom("grok"), CLAUDE_CONFIG_DIR: custom("claude"), HERMES_HOME: custom("hermes"), KIMI_HOME: custom("kimi"),
    OPENCODE_CONFIG_DIR: custom("opencode"), OPENCODE_CONFIG: custom("opencode.json"), QWEN_HOME: custom("qwen"),
    XDG_DATA_HOME: custom("xdg-data"), CODEX_HOME: join(w.userData, "account-homes", "a1")
  };
  const paths = isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "s"), env, userDataPath: w.userData, sessionId: "s1" });
  for (const moved of [custom("grok"), custom("claude"), custom("hermes"), custom("kimi"), custom("opencode"), custom("opencode.json"), custom("qwen"),
    join(custom("xdg-data"), "opencode"), join(w.home, ".grok"), join(w.home, ".claude")]) {
    assert.ok(paths.unreadable.includes(moved), `${moved} unreadable`);
    assert.ok(!paths.writable.includes(moved) && !paths.readableAgain.includes(moved), `${moved} not handed back`);
  }
  assert.ok(paths.writable.includes(join(w.userData, "account-homes", "a1")) && paths.readableAgain.includes(join(w.userData, "account-homes", "a1")),
    "this CLI's own moved home stays its own");
  assert.ok(!paths.unreadable.includes(join(w.userData, "account-homes", "a1")));
  const grok = isolationPaths({ provider: "grok", cwd: w.project, sessionTemp: join(w.temp, "s"), env, userDataPath: w.userData, sessionId: "s1" });
  assert.ok(grok.writable.includes(custom("grok")) && !grok.unreadable.includes(custom("grok")), "Grok's own moved home is Grok's");
  assert.ok(grok.unreadable.includes(join(w.userData, "account-homes", "a1")), "and Codex's account home is not");
  // A variable that points at HOME or above the project would hide them: never listed.
  const wide = isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "s"), env: { ...w.env, GROK_HOME: w.home, KIMI_HOME: w.base },
    userDataPath: w.userData, sessionId: "s1" });
  assert.ok(!wide.unreadable.includes(w.home) && !wide.unreadable.includes(w.base));
});

test("bubblewrap: a granted private folder is read-only, the CLI's own moved home stays writable", async (t) => {
  const w = await world(t);
  const own = join(w.userData, "agent-control", "sessions", "own");
  const accountHome = join(w.userData, "account-homes", "a1");
  const paths = isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "s"), env: { ...w.env, CODEX_HOME: accountHome },
    userDataPath: w.userData, sessionId: "s", grantedPrivate: [own] });
  // Its config.toml exists: the person's, or the placeholder LinuxHostPaths puts there before a launch.
  const accountConfig = join(accountHome, "config.toml");
  const kinds = new Map([[w.project, "directory"], [own, "directory"], [accountHome, "directory"], [join(w.userData, "agent-control"), "directory"],
    [join(w.userData, "account-homes"), "directory"], [accountConfig, "file"]]);
  const args = bubblewrapArguments(paths, { command: "/usr/bin/codex", args: [], cwd: w.project }, (path) => kinds.get(path) ?? null);
  const text = args.join(" ");
  assert.ok(text.includes(`--ro-bind ${own} ${own}`), "the control grant is readable, not writable");
  assert.ok(!text.includes(`--bind ${own} ${own}`));
  const afterHidden = text.slice(text.indexOf(`--tmpfs ${join(w.userData, "account-homes")}`));
  assert.ok(afterHidden.includes(`--bind ${accountHome} ${accountHome}`), "its own account home is bound back writable over the hidden folder");
  const afterRebind = afterHidden.slice(afterHidden.indexOf(`--bind ${accountHome} ${accountHome}`));
  assert.ok(afterRebind.includes(`--ro-bind ${accountConfig} ${accountConfig}`), "and its permission settings read-only again over that");
  // Without the file (nothing prepared the host) the launch is refused, never run with the settings writable.
  kinds.delete(accountConfig);
  assert.throws(() => bubblewrapArguments(paths, { command: "/usr/bin/codex", args: [], cwd: w.project }, (path) => kinds.get(path) ?? null),
    /config\.toml would be writable for the agent/u);
});

test("bubblewrap: git hooks the agent could create later never reach the real project", async (t) => {
  const w = await world(t);
  const hooks = join(w.project, ".git", "hooks");
  const argsFor = (kinds, options = {}) => {
    const paths = isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "s"), env: w.env, userDataPath: w.userData, sessionId: "s", ...options });
    return bubblewrapArguments(paths, { command: "/usr/bin/codex", args: [], cwd: w.project }, (path) => kinds.get(path) ?? null).join(" ");
  };
  // No repository yet: `git init` inside would create the hooks folder in the writable project.
  const fresh = argsFor(new Map([[w.project, "directory"]]));
  assert.ok(fresh.includes(`--tmpfs ${hooks}`), "a throwaway hooks folder the person's git never sees");
  assert.ok(fresh.indexOf(`--tmpfs ${hooks}`) > fresh.indexOf(`--bind ${w.project} ${w.project}`), "mounted over the project");
  // A repository without a hooks folder: the same.
  assert.ok(argsFor(new Map([[w.project, "directory"], [join(w.project, ".git"), "directory"]])).includes(`--tmpfs ${hooks}`));
  // Existing hooks stay read-only.
  const existing = argsFor(new Map([[w.project, "directory"], [join(w.project, ".git"), "directory"], [hooks, "directory"]]));
  assert.ok(existing.includes(`--ro-bind ${hooks} ${hooks}`) && !existing.includes(`--tmpfs ${hooks}`));
  // A worktree's `.git` file (its hooks live in the main repository) and a read-only project need nothing.
  assert.ok(!argsFor(new Map([[w.project, "directory"], [join(w.project, ".git"), "file"]])).includes(hooks));
  assert.ok(!argsFor(new Map([[w.project, "directory"]]), { readOnlyProject: true }).includes(hooks));
});

test("bubblewrap: the empty .git a throwaway hooks mount leaves behind is removed; a repository made inside stays", async (t) => {
  const w = await world(t);
  const layer = isolation(w, { platform: "linux", bubblewrapPath: "/usr/bin/bwrap", bubblewrapProbe: () => null, exists: () => true });
  const launch = { sessionId: "s", provider: "codex", cwd: w.project, command: "/usr/bin/codex", args: [], env: w.env };
  let wrapped = layer.wrap(launch);
  // What bwrap does for the mount point.
  await mkdir(join(w.project, ".git", "hooks"), { recursive: true });
  wrapped.cleanup();
  assert.equal(existsSync(join(w.project, ".git")), false, "nothing left in the project");
  wrapped = layer.wrap(launch);
  await mkdir(join(w.project, ".git", "hooks"), { recursive: true });
  await writeFile(join(w.project, ".git", "HEAD"), "ref: refs/heads/main\n");
  wrapped.cleanup();
  assert.equal(existsSync(join(w.project, ".git", "HEAD")), true, "the agent's repository is kept");
  assert.equal(existsSync(join(w.project, ".git", "hooks")), true, "with its hooks folder");
});

test("the launch: wrapped when the layer applies, refused (never unwrapped) when it cannot start", async (t) => {
  const w = await world(t);
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.shutdown());
  let failing = false;
  const cleaned = [];
  terminals.configureIsolation({
    containment: () => true,
    decide: (input) => new AgentIsolation({ userDataPath: w.userData, enabled: () => true, platform: "darwin", exists: () => true }).decide(input),
    wrap: (launch) => {
      if (failing) throw new Error("agent isolation could not be set up: disk full. The agent was not started without it.");
      return { command: "/usr/bin/sandbox-exec", args: ["-f", "/p.sb", launch.command, ...launch.args], env: { ...launch.env, TMPDIR: "/s/" }, cleanup: () => cleaned.push(launch.sessionId) };
    }
  });
  const auto = terminals.create({ provider: "claude", profile: "auto", cwd: w.project, position: at });
  assert.equal(calls.at(-1).command, "/usr/bin/sandbox-exec");
  assert.deepEqual(calls.at(-1).args.slice(0, 3), ["-f", "/p.sb", "/resolved/claude"]);
  assert.ok(!calls.at(-1).args.some((arg) => arg.includes("\"sandbox\"")), "no Claude sandbox inside the layer");
  assert.deepEqual(auto.isolation, { state: "on", layer: "seatbelt" });
  const manual = terminals.create({ provider: "claude", profile: "normal", cwd: w.project, position: at });
  assert.equal(calls.at(-1).command, "/resolved/claude", "a manual launch by the person is not wrapped");
  assert.equal(manual.isolation, undefined);
  // A contained auto (no auto of its own) exists only inside the layer.
  terminals.create({ provider: "qwen", profile: "auto", cwd: w.project, position: at });
  assert.ok(calls.at(-1).args.includes("--yolo"));
  const count = calls.length;
  failing = true;
  const refused = terminals.create({ provider: "codex", profile: "auto", cwd: w.project, position: at });
  assert.equal(calls.length, count, "nothing started");
  assert.equal(refused.status, "failed");
  assert.match(refused.failureDetails, /^Launch refused: agent isolation could not be set up: disk full\. The agent was not started without it\./u);
  terminals.dispose(auto.id);
  assert.deepEqual(cleaned, [auto.id], "its folder goes with the card");
});

test("without a layer a subagent runs in normal (it asks) and the card says why", async (t) => {
  const w = await world(t);
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.shutdown());
  const windows = new AgentIsolation({ userDataPath: w.userData, enabled: () => true, platform: "win32" });
  terminals.configureIsolation(windows);
  const control = new AgentControlService(terminals, { containment: () => terminals.containment() });
  const orchestrator = terminals.create({ provider: "codex", profile: "auto", cwd: w.project, position: at, role: "orchestrator" });
  assert.equal(orchestrator.profile, "auto");
  const child = await control.spawn({ parentSessionId: orchestrator.id, provider: "codex", cwd: w.project });
  assert.equal(child.profile, "normal");
  assert.equal(child.isolation.state, "unavailable");
  assert.ok(!calls.at(-1).args.includes("--approve-for-me"));
  assert.throws(() => terminals.create({ provider: "qwen", profile: "auto", cwd: w.project, position: at }), /qwen has no auto mode of its own/u);
});

test("seatbelt, for real: writes stay in the project, secrets stay unread, nothing leaves through daemons", onMac, async (t) => {
  const w = await world(t);
  const own = join(w.userData, "agent-control", "sessions", "own");
  const { lines, env } = run(w, [
    'echo ok > inside && echo W-project-ok',
    'mkdir -p deep/er && echo ok > deep/er/f && echo W-subfolder-ok',
    'echo x > "$HOME/outside" 2>/dev/null || echo W-home-denied',
    'echo x > /tmp/ctty-escape 2>/dev/null || echo W-tmp-denied',
    'echo x > /usr/local/ctty-escape 2>/dev/null || echo W-usr-local-denied',
    'rm -rf "$HOME/victim" 2>/dev/null; [ -f "$HOME/victim/deep/file" ] && echo RM-home-denied',
    'cat "$HOME/.ssh/id_test" 2>/dev/null || echo R-ssh-denied',
    'cat "$HOME/.aws/credentials" 2>/dev/null || echo R-aws-denied',
    'cat "$HOME/.claude/.credentials.json" 2>/dev/null || echo R-other-cli-denied',
    `cat "${join(w.userData, "agent-control", "token-app")}" 2>/dev/null || echo R-app-token-denied`,
    `cat "${join(w.userData, "provider-secrets.bin")}" 2>/dev/null || echo R-secret-store-denied`,
    `cat "${join(own, "connection.json")}" >/dev/null && echo R-own-grant-ok`,
    'echo t > "$TMPDIR/t" && echo W-session-tmp-ok',
    'echo c > "$HOME/.codex/state" && echo W-own-cli-ok',
    'echo c > "$HOME/.codex/config.toml" 2>/dev/null || echo W-own-cli-config-denied',
    'git init -q . && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m x && echo GIT-ok',
    'echo evil > .git/hooks/pre-commit 2>/dev/null || echo W-git-hook-denied',
    'kill -0 1 2>/dev/null || echo SIGNAL-denied',
    'defaults write ctty.isolation.probe key -string v 2>/dev/null; defaults read ctty.isolation.probe >/dev/null 2>&1 || echo PREFS-denied',
    'osascript -e \'tell application "System Events" to get name of first process\' >/dev/null 2>&1 || echo APPLE-EVENTS-denied',
    'launchctl submit -l ctty.isolation.probe -- /usr/bin/true 2>/dev/null || echo LAUNCHD-denied'
  ].join("; "), { granted: [own] });
  assert.deepEqual(lines, ["W-project-ok", "W-subfolder-ok", "W-home-denied", "W-tmp-denied", "W-usr-local-denied", "RM-home-denied", "R-ssh-denied",
    "R-aws-denied", "R-other-cli-denied", "R-app-token-denied", "R-secret-store-denied", "R-own-grant-ok", "W-session-tmp-ok", "W-own-cli-ok",
    "W-own-cli-config-denied", "GIT-ok", "W-git-hook-denied", "SIGNAL-denied", "PREFS-denied", "APPLE-EVENTS-denied", "LAUNCHD-denied"]);
  assert.equal(await readFile(join(w.home, "victim", "deep", "file"), "utf8"), "keep me");
  assert.equal(existsSync(join(w.home, "outside")), false);
  assert.match(env.TMPDIR, new RegExp(`^${w.temp}/${ISOLATION_FOLDER_PREFIX}`, "u"));
  assert.deepEqual((await readdir(w.temp)).filter((name) => name.startsWith(ISOLATION_FOLDER_PREFIX)), [], "cleaned up");
  // Nothing was written to the person's preferences on the agent's behalf.
  assert.notEqual(spawnSync("defaults", ["read", "ctty.isolation.probe"]).status, 0);
});

test("seatbelt, for real: the launch writes the account home it was handed, not its permission settings, and no other home", onMac, async (t) => {
  const w = await world(t);
  const own = join(w.userData, "account-homes", "a1");
  const other = join(w.userData, "account-homes", "a2");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "auth.json"), "OTHER-ACCOUNT");
  const grant = join(w.userData, "agent-control", "sessions", "own");
  const { lines } = run(w, [
    'echo refreshed > "$CODEX_HOME/auth.json" && cat "$CODEX_HOME/auth.json" >/dev/null && echo HOME-W-ok',
    'mkdir "$CODEX_HOME/sessions" && mkdir "$CODEX_HOME/sessions/x" && echo s > "$CODEX_HOME/sessions/x/log" && echo HOME-SUB-ok',
    'echo x > "$CODEX_HOME/config.toml" 2>/dev/null || echo HOME-CONFIG-denied',
    `cat "${join(other, "auth.json")}" 2>/dev/null || echo OTHER-R-denied`,
    `echo x > "${join(other, "auth.json")}" 2>/dev/null || echo OTHER-W-denied`,
    `echo x > "${join(grant, "g")}" 2>/dev/null || echo GRANT-W-denied`,
    `cat "${join(grant, "connection.json")}" >/dev/null && echo GRANT-R-ok`
  ].join("; "), { env: { CODEX_HOME: own }, granted: [grant] });
  assert.deepEqual(lines, ["HOME-W-ok", "HOME-SUB-ok", "HOME-CONFIG-denied", "OTHER-R-denied", "OTHER-W-denied", "GRANT-W-denied", "GRANT-R-ok"]);
  assert.equal(await readFile(join(own, "auth.json"), "utf8"), "refreshed\n");
});

test("seatbelt, for real: git init works, but no repository in the project gets a hook or attributes from the agent", onMac, async (t) => {
  const w = await world(t);
  const { lines, env } = run(w, [
    'git init -q . && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m x && echo GIT-ok',
    '[ -e .git/hooks ] && echo TEMPLATE-HOOKS || echo NO-TEMPLATE-HOOKS',
    'mkdir -p .git/hooks && (echo evil > .git/hooks/pre-commit) 2>/dev/null || echo W-git-hook-denied',
    'echo sample > .git/hooks/pre-commit.sample 2>/dev/null && echo W-sample-ok',
    'mkdir -p .git/info && (echo "* filter=x" > .git/info/attributes) 2>/dev/null || echo W-attributes-denied',
    'git init -q deep/nested && mkdir -p deep/nested/.git/hooks && (echo evil > deep/nested/.git/hooks/post-commit) 2>/dev/null || echo W-nested-hook-denied',
    'git config core.hooksPath /tmp/x && echo CONFIG-ok'
  ].join("; "));
  assert.deepEqual(lines, ["GIT-ok", "NO-TEMPLATE-HOOKS", "W-git-hook-denied", "W-sample-ok", "W-attributes-denied", "W-nested-hook-denied", "CONFIG-ok"]);
  assert.ok(env.GIT_TEMPLATE_DIR, "an empty template for git init");
  assert.equal(existsSync(join(w.project, ".git", "hooks", "pre-commit")), false);
});

test("bubblewrap: the handed home is writable but its permission settings are read-only again; .git/info cannot gain attributes", async (t) => {
  const w = await world(t);
  const accountHome = join(w.userData, "account-homes", "a1");
  const config = join(accountHome, "config.toml");
  const paths = isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "s"), env: { ...w.env, CODEX_HOME: accountHome },
    userDataPath: w.userData, sessionId: "s" });
  const base = [[w.project, "directory"], [accountHome, "directory"], [join(w.userData, "account-homes"), "directory"], [config, "file"]];
  const text = (extra) => bubblewrapArguments(paths, { command: "/usr/bin/codex", args: [], cwd: w.project }, (path) => new Map([...base, ...extra]).get(path) ?? null).join(" ");
  const fresh = text([]);
  const rebound = fresh.lastIndexOf(`--bind ${accountHome} ${accountHome}`);
  assert.ok(rebound > fresh.indexOf(`--tmpfs ${join(w.userData, "account-homes")}`));
  assert.ok(fresh.lastIndexOf(`--ro-bind ${config} ${config}`) > rebound, "config.toml read-only over the rebound home");
  const info = join(w.project, ".git", "info");
  assert.ok(fresh.includes(`--tmpfs ${info}`), "no .git/info yet: a throwaway one");
  const attributes = join(info, "attributes");
  assert.ok(text([[join(w.project, ".git"), "directory"], [info, "directory"], [attributes, "file"]]).includes(`--ro-bind ${attributes} ${attributes}`));
  assert.ok(text([[join(w.project, ".git"), "directory"], [info, "directory"]]).includes(`--ro-bind ${info} ${info}`), "no attributes file can be created");
});

test("an isolated launch gets an empty git template, so git init writes no hooks", async (t) => {
  const w = await world(t);
  const layer = isolation(w, { platform: "linux", bubblewrapPath: "/usr/bin/bwrap", bubblewrapProbe: () => null, exists: () => true });
  const wrapped = layer.wrap({ sessionId: "s", provider: "codex", cwd: w.project, command: "/usr/bin/codex", args: [], env: w.env });
  try {
    assert.ok(wrapped.env.GIT_TEMPLATE_DIR);
    assert.deepEqual(await readdir(wrapped.env.GIT_TEMPLATE_DIR), []);
  } finally { wrapped.cleanup(); }
});

test("seatbelt, for real: Claude saves a refreshed sign-in in the login keychain; nothing else there; plan is read-only", onMac, async (t) => {
  const w = await world(t);
  const folder = join(w.home, "Library", "Keychains");
  await mkdir(folder, { recursive: true });
  const keychain = join(folder, "login.keychain-db");
  // A temporary keychain in the fake HOME, never the person's.
  assert.equal(spawnSync("security", ["create-keychain", "-p", "pw", keychain]).status, 0);
  t.after(() => spawnSync("security", ["delete-keychain", keychain]));
  spawnSync("security", ["unlock-keychain", "-p", "pw", keychain]);
  const script = [
    `security add-generic-password -a acct -s ctty-probe -w first "${keychain}" >/dev/null 2>&1 && echo ADD-ok || echo ADD-denied`,
    `security add-generic-password -U -a acct -s ctty-probe -w second "${keychain}" >/dev/null 2>&1 && echo UPDATE-ok || echo UPDATE-denied`,
    `echo x > "${join(folder, "other.keychain-db")}" 2>/dev/null || echo OTHER-denied`
  ].join("; ");
  assert.deepEqual(run(w, script, { provider: "claude" }).lines, ["ADD-ok", "UPDATE-ok", "OTHER-denied"]);
  assert.equal(spawnSync("security", ["find-generic-password", "-a", "acct", "-s", "ctty-probe", "-w", keychain], { encoding: "utf8" }).stdout.trim(), "second");
  // Only Claude Code keeps its sign-in there; another CLI cannot write it.
  assert.deepEqual(run(w, `cat /dev/null >> "${keychain}" 2>/dev/null && echo WRITE-ok || echo WRITE-denied`, { provider: "codex" }).lines, ["WRITE-denied"]);
  // Plan: the project is readable, not writable; the CLI's own folders still are.
  const wrapped = isolation(w).wrap({ sessionId: "p", provider: "codex", profile: "plan", cwd: w.project, command: "/bin/sh",
    args: ["-c", 'ls >/dev/null && echo READ-ok; echo x > plan-file 2>/dev/null || echo WRITE-denied; echo x > "$HOME/.codex/s" && echo OWN-ok'], env: w.env });
  try {
    assert.deepEqual(spawnSync(wrapped.command, wrapped.args, { cwd: w.project, env: wrapped.env, encoding: "utf8" }).stdout.split("\n").filter(Boolean),
      ["READ-ok", "WRITE-denied", "OWN-ok"]);
  } finally { wrapped.cleanup(); }
});

test("seatbelt, for real: Unix sockets only to CanvasTTY's own gateways and the session's folder", onMac, async (t) => {
  const w = await world(t);
  const outsideDir = join(w.base, "o");
  const lifecycle = join(w.userData, "lifecycle", "runtime");
  const orchestration = join(w.userData, "orchestration", "runtime");
  const fallback = await realpath(await mkdtemp("/tmp/ctty-orch-test-"));
  t.after(() => rm(fallback, { recursive: true, force: true }));
  await Promise.all([mkdir(outsideDir), mkdir(orchestration, { recursive: true })]);
  const paths = [join(outsideDir, "d.sock"), join(lifecycle, "r.sock"), join(orchestration, "o.sock"), join(fallback, "f.sock")];
  const servers = paths.map((path) => {
    const server = createServer((socket) => socket.end());
    server.listen(path);
    return server;
  });
  t.after(() => servers.forEach((server) => server.close()));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const probe = (path) => `/usr/bin/python3 -c "import socket,sys
s=socket.socket(socket.AF_UNIX)
try:
  s.connect('${path}'); print('CONNECT-ok')
except Exception: print('CONNECT-denied')"`;
  const { lines } = run(w, paths.map(probe).join("; "), { env: { CANVASTTY_RUNTIME_ADDRESS: join(lifecycle, "r.sock") } });
  assert.deepEqual(lines, ["CONNECT-denied", "CONNECT-ok", "CONNECT-ok", "CONNECT-ok"], "a daemon's socket no; every CanvasTTY gateway yes");
});

/** The installed CLI on PATH (never under a fake HOME: that one is empty), or null. */
function installed(name) {
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(folder, name);
    if (folder && existsSync(path)) return path;
  }
  return null;
}

test("real CLIs start inside the layer with a fake HOME (version and config only: no sign-in, no network)", onMac, async (t) => {
  const w = await world(t);
  const env = { ...w.env, PATH: `${process.env.PATH}`, XDG_CONFIG_HOME: join(w.home, ".config"), XDG_DATA_HOME: join(w.home, ".local", "share"),
    XDG_STATE_HOME: join(w.home, ".local", "state"), XDG_CACHE_HOME: join(w.home, ".cache"), CODEX_HOME: join(w.home, ".codex"),
    CLAUDE_CONFIG_DIR: join(w.home, ".claude"), GROK_HOME: join(w.home, ".grok"), OPENCODE_DISABLE_AUTOUPDATE: "1", DISABLE_AUTOUPDATER: "1" };
  const cases = [
    ["opencode", "opencode", ["--version"], /\d+\.\d+/u],
    ["opencode", "opencode", ["debug", "config"], /"\$schema"|\{/u],
    ["codex", "codex", ["--version"], /codex-cli \d/u],
    ["claude", "claude", ["--version"], /Claude Code/u],
    ["grok", "grok", ["--version"], /\d+\.\d+/u],
    // Codex accepts the flags it gets inside the layer: its own sandbox off, the auto reviewer on (offline dry run).
    ["codex", "codex", [...codexInsideIsolation("auto", false), "debug", "prompt-input"], /`sandbox_mode` is `danger-full-access`[\s\S]*`approvals_reviewer` is `auto_review`/u]
  ];
  let ran = 0;
  for (const [provider, name, args, expected] of cases) {
    const path = installed(name);
    if (!path) { t.diagnostic(`${name} is not installed; skipped`); continue; }
    const wrapped = isolation(w).wrap({ sessionId: `cli-${ran}`, provider, cwd: w.project, command: path, args, env });
    try {
      const result = await new Promise((resolve) => {
        const child = spawn(wrapped.command, wrapped.args, { cwd: w.project, env: wrapped.env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (data) => { out += data; });
        child.stderr.on("data", (data) => { out += data; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
      });
      assert.equal(result.code, 0, `${name} ${args.join(" ")} inside the layer: ${result.out.slice(-400)}`);
      assert.match(result.out, expected, `${name} ${args.join(" ")}`);
      ran += 1;
    } finally {
      wrapped.cleanup();
    }
  }
  t.diagnostic(`${ran} CLI runs inside the layer`);
});

test("launch homes cannot reopen host credentials or private app data", async (t) => {
  const w = await world(t);
  const input = { provider: "claude", cwd: w.project, sessionTemp: w.temp, userDataPath: w.userData, sessionId: "s1", hostEnvironment: w.env };
  for (const home of [w.home, join(w.home, ".ssh"), join(w.home, ".codex"), join(w.userData, "agent-control"), join(w.userData, "account-homes")]) {
    assert.throws(() => isolationPaths({ ...input, env: { ...w.env, CLAUDE_CONFIG_DIR: home } }), /overlaps.*protected|protected.*overlap/iu, home);
  }
  if (process.platform !== "win32") {
    const alias = join(w.base, "cli-home-alias");
    await symlink(join(w.home, ".ssh"), alias);
    assert.throws(() => isolationPaths({ ...input, env: { ...w.env, CLAUDE_CONFIG_DIR: alias } }), /overlaps.*protected/iu,
      "a symlink cannot disguise a credential directory");
  }
  const changedHome = join(w.base, "different-home");
  const paths = isolationPaths({ ...input, env: { ...w.env, HOME: changedHome } });
  assert.ok(paths.unreadable.includes(join(w.home, ".ssh")), "host HOME keys stay hidden when launch HOME moves");
  assert.ok(paths.unreadable.includes(join(w.home, ".codex")), "host other-provider keys stay hidden");
  const ownAccount = join(w.userData, "account-homes", "a1");
  const own = isolationPaths({ ...input, env: { ...w.env, CLAUDE_CONFIG_DIR: ownAccount } });
  assert.ok(own.readableAgain.includes(ownAccount), "the selected account remains available");
});

test("a launch HOME nested inside another provider's host home cannot expose its credentials", () => {
  const host = join(tmpdir(), "ctty-host-home-boundary");
  assert.throws(() => isolationPaths({
    provider: "claude",
    cwd: join(tmpdir(), "ctty-home-boundary-project"),
    sessionTemp: join(tmpdir(), "ctty-home-boundary-temp"),
    env: { HOME: join(host, ".codex", "nested-home") },
    hostEnvironment: { HOME: host },
    userDataPath: join(tmpdir(), "ctty-home-boundary-data"),
    sessionId: "nested-host-home"
  }), /protected host credentials/u);
});

test("deep nonexistent descendants cannot conceal a credential symlink alias", { skip: process.platform === "win32" }, async (t) => {
  const w = await world(t);
  const credentialHome = join(w.home, ".codex");
  await mkdir(credentialHome, { recursive: true });
  const alias = join(w.base, "deep-credential-alias");
  await symlink(credentialHome, alias);
  assert.throws(() => isolationPaths({
    provider: "claude", cwd: w.project, sessionTemp: w.temp,
    userDataPath: w.userData, sessionId: "deep-alias",
    env: { HOME: join(alias, ...Array.from({ length: 130 }, () => "x")) },
    hostEnvironment: w.env
  }), /protected host credentials/u);
});
