import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentIsolation } from "../src/main/services/isolation/AgentIsolation.ts";
import { isolationPaths } from "../src/main/services/isolation/isolationPaths.ts";
import { seatbeltProfile } from "../src/main/services/isolation/seatbelt.ts";
import { bubblewrapArguments } from "../src/main/services/isolation/bubblewrap.ts";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const onMac = { skip: mac ? false : "macOS seatbelt (sandbox-exec) only" };

/** A fake HOME that holds CanvasTTY's data folder (its settings, a plugin, an account home, a project the app keeps). */
async function world(t) {
  const base = await realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "ctty-ud-test-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "h");
  const userData = join(home, ".config", "canvastty");
  const temp = join(base, "t");
  const accountHome = join(userData, "account-homes", "a1");
  const appProject = join(userData, "projects", "p");
  for (const dir of [temp, join(home, "src"), join(userData, "plugins", "x"), accountHome, appProject, join(userData, "agent-control")]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(userData, "settings.json"), "{\"agentIsolation\":\"on\"}\n");
  await writeFile(join(userData, "plugins", "x", "index.js"), "// plugin\n");
  await writeFile(join(userData, "agent-control", "token-app"), "APP-TOKEN");
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
  return { base, home, userData, temp, accountHome, appProject, env };
}

function pathsFor(w, cwd, env = {}) {
  return isolationPaths({ provider: "codex", cwd, sessionTemp: join(w.temp, "s"), env: { ...w.env, ...env }, userDataPath: w.userData, sessionId: "s" });
}

test("the paths: a project that contains CanvasTTY's data folder leaves that folder read-only, its account home writable", async (t) => {
  const w = await world(t);
  const paths = pathsFor(w, w.home, { CODEX_HOME: w.accountHome });
  assert.ok(paths.writable.includes(w.home), "the project stays writable");
  assert.ok(paths.readOnlyFolders.includes(w.userData), "CanvasTTY's data folder is read-only");
  const profile = seatbeltProfile(paths);
  const deny = profile.indexOf(`(deny file-write* (subpath "${w.userData}")`);
  assert.ok(deny > profile.indexOf(`(subpath "${w.home}")`), "denied after the project is allowed");
  const again = profile.indexOf(`(allow file-write* (subpath "${w.accountHome}"))`);
  assert.ok(again > deny, "the CLI's own account home is writable again");
  // Its parent inside the project cannot be renamed away (and back) or replaced.
  assert.deepEqual(paths.fixedFolders, [join(w.home, ".config")]);
  assert.ok(profile.includes(`(deny file-write-unlink (literal "${join(w.home, ".config")}"))`));
  // A project the app keeps inside its data folder (Even G2's default), or any other project: nothing changes.
  assert.deepEqual(pathsFor(w, w.appProject).readOnlyFolders, []);
  assert.deepEqual(pathsFor(w, w.appProject).fixedFolders, []);
  assert.ok(pathsFor(w, w.appProject).writable.includes(w.appProject));
  assert.deepEqual(pathsFor(w, join(w.home, "src")).readOnlyFolders, []);
  // A read-only (plan) project at HOME has nothing to take back.
  assert.deepEqual(isolationPaths({ provider: "codex", cwd: w.home, sessionTemp: join(w.temp, "s"), env: w.env, userDataPath: w.userData,
    sessionId: "s", readOnlyProject: true }).readOnlyFolders, []);
});

test("bubblewrap: CanvasTTY's data folder is mounted read-only over a project at HOME, its account home bound writable again", async (t) => {
  const w = await world(t);
  const paths = pathsFor(w, w.home, { CODEX_HOME: w.accountHome });
  const kinds = new Map([[w.home, "directory"], [join(w.home, ".config"), "directory"], [w.userData, "directory"], [w.accountHome, "directory"], [join(w.userData, "agent-control"), "directory"]]);
  const args = bubblewrapArguments(paths, { command: "/usr/bin/codex", args: [], cwd: w.home },
    // The CLI's permission settings exist (LinuxHostPaths puts a placeholder where one is missing).
    (path) => kinds.get(path) ?? (paths.protectedWrites.includes(path) && !path.endsWith(".lock") ? "file" : null)).join(" ");
  const project = args.indexOf(`--bind ${w.home} ${w.home}`);
  const readOnly = args.indexOf(`--ro-bind ${w.userData} ${w.userData}`);
  assert.ok(project >= 0 && readOnly > project, "read-only over the writable project");
  const parent = args.indexOf(`--bind ${join(w.home, ".config")} ${join(w.home, ".config")}`);
  assert.ok(parent > project && parent < readOnly, "its parent is a mount point (cannot be renamed), mounted before it");
  assert.ok(args.indexOf(`--bind ${w.accountHome} ${w.accountHome}`, readOnly) > readOnly, "the account home is writable again");
  assert.ok(args.indexOf(`--tmpfs ${join(w.userData, "agent-control")}`) > readOnly, "private data still hidden");
  // A project inside the data folder is bound writable, nothing over it.
  const inside = bubblewrapArguments(pathsFor(w, w.appProject), { command: "/usr/bin/codex", args: [], cwd: w.appProject },
    (path) => path === w.appProject || path === w.userData ? "directory" : null).join(" ");
  assert.ok(inside.includes(`--bind ${w.appProject} ${w.appProject}`));
  assert.ok(!inside.includes(`--ro-bind ${w.userData} ${w.userData}`));
});

function run(w, cwd, script, env = {}) {
  const wrapped = new AgentIsolation({ userDataPath: w.userData, enabled: () => true, tempRoot: w.temp })
    .wrap({ sessionId: "s1", provider: "codex", cwd, command: "/bin/sh", args: ["-c", script], env: { ...w.env, ...env } });
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd, env: wrapped.env, encoding: "utf8", timeout: 20_000 });
    return result.stdout.split("\n").filter(Boolean);
  } finally {
    wrapped.cleanup();
  }
}

test("seatbelt, for real: a project at HOME cannot change CanvasTTY's settings or plugins; ordinary work still succeeds", onMac, async (t) => {
  const w = await world(t);
  const ud = w.userData;
  const lines = run(w, w.home, [
    'echo ok > notes.txt && echo W-project-ok',
    'mkdir -p src/deep && echo ok > src/deep/f && echo W-subfolder-ok',
    `echo '{}' > "${ud}/settings.json" 2>/dev/null || echo W-settings-denied`,
    `echo x > "${ud}/settings.json.tmp" 2>/dev/null || echo W-settings-tmp-denied`,
    `echo x > "${ud}/plugins/x/index.js" 2>/dev/null || echo W-plugin-denied`,
    `mkdir "${ud}/plugins/y" 2>/dev/null || echo W-new-plugin-denied`,
    `rm -rf "${ud}/plugins" 2>/dev/null; [ -f "${ud}/plugins/x/index.js" ] && echo RM-plugins-denied`,
    `mv "${ud}" "$HOME/moved" 2>/dev/null || echo MV-userdata-denied`,
    'mv "$HOME/.config" "$HOME/moved" 2>/dev/null || echo MV-parent-denied',
    'rm -rf "$HOME/.config" 2>/dev/null; [ -d "$HOME/.config" ] && echo RM-parent-denied',
    'mkdir "$HOME/.config/other-app" && echo x > "$HOME/.config/other-app/f" && echo W-parent-entry-ok',
    `echo x > "${ud}/projects/p/f" 2>/dev/null || echo W-app-project-denied`,
    `cat "${ud}/settings.json" >/dev/null && echo R-settings-ok`,
    `cat "${ud}/agent-control/token-app" 2>/dev/null || echo R-token-denied`,
    'echo s > "$CODEX_HOME/auth.json" && echo W-account-home-ok'
  ].join("; "), { CODEX_HOME: w.accountHome });
  assert.deepEqual(lines, ["W-project-ok", "W-subfolder-ok", "W-settings-denied", "W-settings-tmp-denied", "W-plugin-denied", "W-new-plugin-denied",
    "RM-plugins-denied", "MV-userdata-denied", "MV-parent-denied", "RM-parent-denied", "W-parent-entry-ok", "W-app-project-denied", "R-settings-ok", "R-token-denied", "W-account-home-ok"]);
  assert.equal(await readFile(join(ud, "settings.json"), "utf8"), "{\"agentIsolation\":\"on\"}\n");
  assert.equal(await readFile(join(ud, "plugins", "x", "index.js"), "utf8"), "// plugin\n");
  assert.equal(existsSync(join(ud, "plugins", "y")), false);
  assert.equal(existsSync(join(w.home, "moved")), false);
  assert.equal(await readFile(join(w.home, "notes.txt"), "utf8"), "ok\n");
});

test("seatbelt, for real: a project CanvasTTY keeps inside its data folder stays writable", onMac, async (t) => {
  const w = await world(t);
  const lines = run(w, w.appProject, [
    'echo ok > f && mkdir -p sub && echo ok > sub/g && echo W-project-ok',
    `echo '{}' > "${w.userData}/settings.json" 2>/dev/null || echo W-settings-denied`
  ].join("; "));
  assert.deepEqual(lines, ["W-project-ok", "W-settings-denied"]);
  assert.equal(await readFile(join(w.appProject, "sub", "g"), "utf8"), "ok\n");
});
