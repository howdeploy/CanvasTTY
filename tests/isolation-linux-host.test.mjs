import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentIsolation } from "../src/main/services/isolation/AgentIsolation.ts";
import { bubblewrapArguments } from "../src/main/services/isolation/bubblewrap.ts";
import { isolationPaths } from "../src/main/services/isolation/isolationPaths.ts";
import { LinuxHostPaths } from "../src/main/services/isolation/linuxHostPaths.ts";

// bubblewrap is the Linux layer: these tests build real POSIX folders (a fresh HOME) and read the arguments it would
// get. They run on macOS and Linux; Windows has no isolation layer (agent-isolation.test.mjs covers its decision).
const posixHost = { skip: process.platform === "win32" ? "bubblewrap paths are POSIX paths (Linux layer)" : false };
const BWRAP = "/usr/bin/bwrap";

async function freshHome(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ctty-bwrap-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "h");
  const project = join(base, "p");
  const temp = join(base, "t");
  const userData = join(base, "u");
  for (const dir of [home, project, temp, userData]) await mkdir(dir, { recursive: true });
  return { base, home, project, temp, userData, env: { HOME: home, PATH: "/usr/bin:/bin" } };
}

const linux = (w, hostPaths) => new AgentIsolation({ userDataPath: w.userData, enabled: () => true, platform: "linux", bubblewrapPath: BWRAP, bubblewrapProbe: () => null,
  tempRoot: w.temp, ...(hostPaths ? { linuxHostPaths: hostPaths } : {}) });
const wrapIn = (isolation, w, provider, extra = {}) => isolation.wrap({ sessionId: "s1", provider, cwd: w.project, command: "/bin/sh",
  args: ["-c", "true"], env: { ...w.env, ...extra } });

/**
 * What the mounts in bubblewrap arguments leave the agent: for a path, the last mount whose target is the path or
 * one of its folders decides (a later mount on a folder hides what was mounted under it before). `bind` persists on
 * the host, `tmpfs` is thrown away, `ro` (the read-only root, --ro-bind) cannot be written; a missing file can be
 * created only where its folder's mount is writable.
 */
function mountFor(args, path) {
  let found = null;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--") break;
    let target = null;
    let mode = null;
    if (flag === "--bind" || flag === "--dev-bind") { target = args[i + 2]; mode = "bind"; i += 2; }
    else if (flag === "--ro-bind") { target = args[i + 2]; mode = "ro"; i += 2; }
    else if (flag === "--tmpfs") { target = args[i + 1]; mode = "tmpfs"; i += 1; }
    else if (flag === "--dev") { target = args[i + 1]; mode = "private-dev"; i += 1; }
    else if (flag === "--proc" || flag === "--chdir") { i += 1; continue; }
    else continue;
    if (path === target || path.startsWith(`${target.replace(/\/+$/u, "")}/`)) found = { target, mode };
  }
  return found;
}
const persistsWrite = (args, path) => mountFor(args, path)?.mode === "bind";

test("bubblewrap: a missing CLI permission file inside its writable folder is protected against creation", posixHost, async (t) => {
  const w = await freshHome(t);
  // The reviewer's case: ~/.codex exists and is writable, config.toml does not exist yet.
  await mkdir(join(w.home, ".codex"));
  const wrapped = wrapIn(linux(w), w, "codex");
  const config = join(w.home, ".codex", "config.toml");
  assert.equal(await readFile(config, "utf8"), "", "an empty TOML file means the same as no file");
  const at = wrapped.args.indexOf(config);
  assert.deepEqual(wrapped.args.slice(at - 1, at + 2), ["--ro-bind", config, config]);
  assert.equal(persistsWrite(wrapped.args, config), false, "the agent cannot write the protected file");
  assert.equal(persistsWrite(wrapped.args, join(w.home, ".codex", "sessions", "rollout.jsonl")), true, "its folder stays writable");
  assert.equal(persistsWrite(wrapped.args, join(w.home, "notes.txt")), false, "HOME itself is not opened for writes");
  wrapped.cleanup();
  assert.equal(existsSync(config), false, "the placeholder goes when the launch ends");
  assert.equal(existsSync(join(w.home, ".codex")), true, "the person's folder stays");

  // Claude: both settings files, JSON placeholders.
  await mkdir(join(w.home, ".claude"));
  const claude = wrapIn(linux(w), w, "claude");
  for (const name of ["settings.json", "settings.local.json"]) {
    const path = join(w.home, ".claude", name);
    assert.equal(await readFile(path, "utf8"), "{}\n");
    assert.equal(persistsWrite(claude.args, path), false, name);
  }
  assert.equal(persistsWrite(claude.args, join(w.home, ".claude", "projects", "x.jsonl")), true);
  claude.cleanup();
  assert.equal(existsSync(join(w.home, ".claude", "settings.json")), false);
});

test("bubblewrap: a fresh HOME gets the CLI's own state folders, so its first run can write them", posixHost, async (t) => {
  const w = await freshHome(t);
  const wrapped = wrapIn(linux(w), w, "opencode");
  const state = join(w.home, ".local", "state", "opencode");
  const data = join(w.home, ".local", "share", "opencode");
  for (const folder of [state, data, join(w.home, ".config", "opencode"), join(w.home, ".cache", "opencode")]) {
    assert.equal(existsSync(folder), true, folder);
    assert.equal(persistsWrite(wrapped.args, join(folder, "x")), true, `${folder} writable`);
  }
  assert.equal(persistsWrite(wrapped.args, join(w.home, ".local", "state", "other-app", "x")), false, "only the CLI's own folder under .local/state");
  assert.equal(persistsWrite(wrapped.args, join(w.home, ".config", "opencode", "opencode.json")), false, "its permission config stays protected");
  // What the CLI wrote stays; folders it never used and the placeholders go.
  await writeFile(join(data, "auth.json"), "{}");
  wrapped.cleanup();
  assert.equal(existsSync(join(data, "auth.json")), true);
  assert.equal(existsSync(state), false, "an unused state folder is removed again");
  assert.equal(existsSync(join(w.home, ".config", "opencode", "opencode.json")), false);
  assert.equal(existsSync(join(w.home, ".config", "opencode")), false);
});

test("bubblewrap: placeholders and created folders are shared by concurrent launches and kept when the person edits them", posixHost, async (t) => {
  const w = await freshHome(t);
  await mkdir(join(w.home, ".codex"));
  const shared = new LinuxHostPaths();
  const first = wrapIn(linux(w, shared), w, "codex");
  const second = wrapIn(linux(w, shared), w, "codex");
  const config = join(w.home, ".codex", "config.toml");
  assert.ok(second.args.includes(config), "the second launch protects the same file");
  first.cleanup();
  assert.equal(existsSync(config), true, "still protected for the launch that runs");
  second.cleanup();
  assert.equal(existsSync(config), false);

  const third = wrapIn(linux(w, shared), w, "codex");
  await writeFile(config, 'model = "mine"\n');
  third.cleanup();
  assert.equal(await readFile(config, "utf8"), 'model = "mine"\n', "an edit by the person is never removed");
});

test("bubblewrap refuses a launch whose missing protected file it could not protect (fail closed)", posixHost, async (t) => {
  const w = await freshHome(t);
  await mkdir(join(w.home, ".codex"));
  const paths = isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "s"), env: w.env, userDataPath: w.userData, sessionId: "s" });
  const kinds = new Map([[w.project, "directory"], [w.home, "directory"], [join(w.home, ".codex"), "directory"]]);
  assert.throws(() => bubblewrapArguments(paths, { command: "/bin/sh", args: [], cwd: w.project }, (path) => kinds.get(path) ?? null),
    /config\.toml would be writable for the agent/u);
  kinds.set(join(w.home, ".codex", "config.toml"), "file");
  assert.doesNotThrow(() => bubblewrapArguments(paths, { command: "/bin/sh", args: [], cwd: w.project }, (path) => kinds.get(path) ?? null));
  // A folder the CLI does not have is not writable either, so nothing there needs a placeholder.
  kinds.delete(join(w.home, ".codex"));
  kinds.delete(join(w.home, ".codex", "config.toml"));
  assert.doesNotThrow(() => bubblewrapArguments(paths, { command: "/bin/sh", args: [], cwd: w.project }, (path) => kinds.get(path) ?? null));
});

// The real layer, where the machine has a working bubblewrap (CI's Linux runner may): a fresh HOME, the agent tries
// to create the protected file and to write its own state.
const realBwrap = process.platform === "linux" && existsSync(BWRAP)
  && spawnSync(BWRAP, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"]).status === 0;
test("bubblewrap (real): the agent cannot create the CLI's permission file but can write its own state", { skip: realBwrap ? false : "no working bubblewrap on this machine" }, async (t) => {
  const w = await freshHome(t);
  const script = [
    "echo 'approval_policy = \"never\"' > \"$HOME/.codex/config.toml\" 2>/dev/null && echo config-written || echo config-refused",
    "mkdir -p \"$HOME/.codex/sessions\" && echo state > \"$HOME/.codex/sessions/s.jsonl\" && echo state-written || echo state-refused",
    "echo x > \"$HOME/escape.txt\" 2>/dev/null && echo home-written || echo home-refused"
  ].join("; ");
  const wrapped = linux(w).wrap({ sessionId: "s1", provider: "codex", cwd: w.project, command: "/bin/sh", args: ["-c", script], env: w.env });
  let result;
  try {
    result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8", timeout: 20_000 });
  } finally {
    wrapped.cleanup();
  }
  assert.deepEqual(result.stdout.trim().split("\n"), ["config-refused", "state-written", "home-refused"], result.stderr);
  assert.equal(existsSync(join(w.home, ".codex", "config.toml")), false);
  assert.equal(await readFile(join(w.home, ".codex", "sessions", "s.jsonl"), "utf8"), "state\n");
  assert.equal(existsSync(join(w.home, "escape.txt")), false);
});

test("OpenCode custom permission sources are read-only without creating an empty build agent", posixHost, async (t) => {
  const w = await freshHome(t);
  const custom = join(w.home, "accounts", "opencode");
  await mkdir(custom, { recursive: true });
  const explicit = join(w.project, "custom.jsonc");
  await writeFile(explicit, '{"permission":{"edit":"deny"}}');
  const host = new LinuxHostPaths();
  const layer = linux(w, host);
  const extra = { OPENCODE_CONFIG_DIR: custom, OPENCODE_CONFIG: explicit };
  const first = wrapIn(layer, w, "opencode", extra);
  const second = wrapIn(layer, w, "opencode", extra);
  for (const file of [join(custom, "opencode.json"), join(custom, "opencode.jsonc"), explicit, join(w.project, "opencode.jsonc"),
    join(w.project, ".opencode", "agent", "build.md"),
    join(custom, "agent", "build.md"), join(custom, "agents", "build.md")]) {
    assert.equal(persistsWrite(first.args, file), false, file);
  }
  assert.equal(persistsWrite(first.args, join(custom, "sessions", "state.json")), true, "ordinary state remains writable");
  assert.equal(existsSync(join(custom, "agent", "build.md")), false, "no empty build agent is introduced");
  assert.equal(existsSync(join(custom, "agent")), true, "an empty read-only directory prevents creation");
  first.cleanup();
  assert.equal(existsSync(join(custom, "agent")), true, "concurrent launch still holds it");
  second.cleanup();
  assert.equal(existsSync(join(custom, "agent")), false, "empty temporary directory is released");
  assert.equal(await readFile(explicit, "utf8"), '{"permission":{"edit":"deny"}}', "person config is preserved");
});


test("read-restricted reviewers receive a private minimal /dev while ordinary isolation retains host devices", () => {
  const paths = { writable: [], writableFiles: [], unreadable: [], readableAgain: ["/usr"], gitHooks: [], protectedWrites: [], socketFolders: [] };
  const launch = { command: "/usr/bin/node", args: [], cwd: "/review" };
  const restricted = bubblewrapArguments({ ...paths, restrictReads: true }, launch, () => "directory");
  assert.deepEqual(restricted.slice(restricted.indexOf("--dev"), restricted.indexOf("--dev") + 2), ["--dev", "/dev"]);
  assert.equal(restricted.includes("--dev-bind"), false, "the review sandbox must not expose host disks, terminals or device aliases");
  const ordinary = bubblewrapArguments(paths, launch, () => "directory");
  assert.deepEqual(ordinary.slice(ordinary.indexOf("--dev-bind"), ordinary.indexOf("--dev-bind") + 3), ["--dev-bind", "/dev", "/dev"]);
});


test("generated reviewer read grants cannot remount host /dev over the final minimal device filesystem", posixHost, async t => {
  const w = await freshHome(t);
  const paths = isolationPaths({ provider: "codex", cwd: w.project, sessionTemp: join(w.temp, "review"),
    env: w.env, userDataPath: w.userData, sessionId: "review", readOnlyProject: true, restrictHomeReads: true });
  assert.ok(paths.readableAgain.includes("/dev"), "exercise the real read-exception generator");
  // A nested read/socket/writable grant must also be hidden by the final private device mount.
  const withDeviceGrants = { ...paths, readableAgain: [...paths.readableAgain, "/dev/shm"],
    writable: [...paths.writable, "/dev/shm"], socketFolders: [...paths.socketFolders, "/dev/shm"] };
  const args = bubblewrapArguments(withDeviceGrants, { command: "/usr/bin/node", args: [], cwd: w.project }, () => "directory");
  for (const device of ["/dev", "/dev/video0", "/dev/input/event0", "/dev/shm", "/dev/shm/shared-host-file"]) {
    assert.deepEqual(mountFor(args, device), { target: "/dev", mode: "private-dev" }, device);
  }
  assert.equal(args.lastIndexOf("--dev"), args.indexOf("--chdir") - 2, "no later bind can expose devices again");
});
