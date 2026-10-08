import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { AgentIsolation, SANDBOX_EXEC } from "../src/main/services/isolation/AgentIsolation.ts";

const ACCOUNT_PLUGIN = "canvastty-accounts";
const mac = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const onMac = { skip: mac ? false : "macOS seatbelt (sandbox-exec) only" };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-account-home-isolation-")));
  const userData = join(root, "user-data");
  const pluginData = join(userData, "plugin-data");
  const accountData = join(pluginData, ACCOUNT_PLUGIN);
  const homes = join(accountData, "homes");
  const project = join(root, "project");
  const temp = join(root, "temp");
  const home = join(root, "home");
  await Promise.all([homes, project, temp, home].map(path => mkdir(path, { recursive: true })));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, userData, pluginData, accountData, homes, project, temp, home };
}

async function prepare(f, options = {}) {
  const provider = options.provider ?? "codex";
  const pluginId = options.pluginId ?? ACCOUNT_PLUGIN;
  const dataDir = Object.hasOwn(options, "dataDir") ? options.dataDir : f.accountData;
  const env = options.env ?? { CODEX_HOME: join(f.homes, "codex-alternate") };
  const answerExtra = options.answerExtra ?? {};
  const selectedAccount = Object.hasOwn(options, "selectedAccount") ? options.selectedAccount : "alternate";
  const requests = [];
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId, pluginName: "Accounts", serviceId: "accounts", launch: { fields: [] }, secrets: false,
      ...(dataDir === undefined ? {} : { dataDir }) }],
    call: async (calledId, _serviceId, _method, params) => {
      requests.push({ calledId, params });
      return { env, ...answerExtra };
    },
    secret: async () => null,
    runsRoot: join(f.userData, "launch-runs")
  });
  const result = await pipeline.prepare({ sessionId: "fixture", provider, profile: "normal", role: "agent", cwd: f.project,
    restoring: false, resume: false, options: { [pluginId]: { ...(selectedAccount === undefined ? {} : { account: selectedAccount }) } }, environment: null });
  return { result, requests };
}

function isolation(f, extra = {}) {
  return new AgentIsolation({
    userDataPath: f.userData,
    enabled: () => true,
    tempRoot: f.temp,
    hostEnvironment: { HOME: f.home, PATH: "/usr/bin:/bin" },
    ...extra
  });
}

test("Accounts host-authorized account home grant is exact, provider-matched and absent from plugin RPC", async t => {
  const f = await fixture(t);
  const accountHome = join(f.homes, "codex-alternate");
  await mkdir(accountHome);
  const { result, requests } = await prepare(f, { env: { CODEX_HOME: accountHome } });
  assert.equal(result.ok, true);
  assert.equal(result.accountHome, accountHome);
  assert.deepEqual(result.env, { CODEX_HOME: accountHome });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].calledId, ACCOUNT_PLUGIN);
  for (const forbidden of ["dataDir", "accountHome", "grantedPrivate", "sandboxFolders"]) {
    assert.equal(Object.hasOwn(requests[0].params, forbidden), false, `${forbidden} is host-only`);
  }
  await result.cleanup();
});

test("Accounts home grant refuses missing host authority, other plugins, the homes root and cross-provider homes", async t => {
  const f = await fixture(t);
  const cases = [
    { name: "missing host dataDir", dataDir: undefined, env: { CODEX_HOME: join(f.homes, "codex-a") } },
    { name: "other plugin id", pluginId: "example.other", dataDir: f.accountData, env: { CODEX_HOME: join(f.homes, "codex-a") } },
    { name: "homes root", dataDir: f.accountData, env: { CODEX_HOME: f.homes } },
    { name: "different selected sibling", dataDir: f.accountData, env: { CODEX_HOME: join(f.homes, "codex-sibling") } },
    { name: "none cannot reopen a sibling", dataDir: f.accountData, selectedAccount: "none", env: { CODEX_HOME: join(f.homes, "codex-none") } },
    { name: "absent selection cannot reopen an account", dataDir: f.accountData, selectedAccount: undefined,
      env: { CODEX_HOME: join(f.homes, "codex-alternate") } },
    { name: "Claude child for Codex", dataDir: f.accountData, env: { CODEX_HOME: join(f.homes, "claude-a") } },
    { name: "Codex child for Claude", provider: "claude", dataDir: f.accountData, env: { CLAUDE_CONFIG_DIR: join(f.homes, "codex-a") } },
    { name: "wrong provider variable", dataDir: f.accountData, env: { CLAUDE_CONFIG_DIR: join(f.homes, "claude-a") } }
  ];
  for (const row of cases) {
    const { result } = await prepare(f, row);
    assert.equal(result.ok, true, row.name);
    assert.equal(result.accountHome, undefined, row.name);
    await result.cleanup();
  }
  const claudeHome = join(f.homes, "claude-alternate");
  const claude = await prepare(f, { provider: "claude", env: { CLAUDE_CONFIG_DIR: claudeHome } });
  assert.equal(claude.result.ok, true);
  assert.equal(claude.result.accountHome, claudeHome);
  await claude.result.cleanup();
});

test("a plugin cannot return accountHome or sandboxFolders as an isolation grant", async t => {
  const f = await fixture(t);
  const accountHome = join(f.homes, "codex-alternate");
  const { result } = await prepare(f, { env: { CODEX_HOME: accountHome }, answerExtra: {
    accountHome, sandboxFolders: [accountHome], grantedPrivate: [accountHome]
  } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown key/u);
});

test("AgentIsolation.wrap refuses a symlinked Accounts home instead of reopening its target", async t => {
  const f = await fixture(t);
  const outside = join(f.userData, "plugin-data", "canvastty-environments", "worktrees", "secret");
  const alias = join(f.homes, "codex-alias");
  await mkdir(outside, { recursive: true });
  await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  const sandbox = isolation(f, { platform: "darwin", exists: path => path === SANDBOX_EXEC });
  assert.throws(() => sandbox.wrap({ sessionId: "alias", provider: "codex", cwd: f.project, command: "/bin/sh", args: [],
    env: { HOME: f.home, PATH: "/usr/bin:/bin", CODEX_HOME: alias }, profile: "acceptEdits", accountHome: alias }),
  /missing or crosses a symbolic link/u);
});

test("seatbelt, for real: only the selected Accounts home is reopened", onMac, async t => {
  const f = await fixture(t);
  const selected = join(f.homes, "codex-alternate");
  const sibling = join(f.homes, "codex-other");
  const environmentWorktree = join(f.pluginData, "canvastty-environments", "worktrees", "sibling");
  const settings = join(f.accountData, "accounts.json");
  await Promise.all([selected, sibling, environmentWorktree].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(selected, "marker"), "selected fixture home\n");
  await writeFile(join(sibling, "marker"), "sibling fixture home\n");
  await writeFile(join(environmentWorktree, "marker"), "environment fixture sibling\n");
  await writeFile(settings, "private account settings\n");
  const wrapped = isolation(f).wrap({
    sessionId: "selected-account",
    provider: "codex",
    cwd: f.project,
    command: "/bin/sh",
    args: ["-c", [
      'cat "$CODEX_HOME/marker" >/dev/null && echo OWN-READ-ok',
      'echo actor > "$CODEX_HOME/actor.txt" && echo OWN-WRITE-ok',
      'echo actor > "$CODEX_HOME/config.toml" 2>/dev/null || echo CLI-SETTINGS-WRITE-denied',
      `cat ${JSON.stringify(join(sibling, "marker"))} >/dev/null 2>&1 || echo ACCOUNT-SIBLING-READ-denied`,
      `echo actor >> ${JSON.stringify(join(sibling, "marker"))} 2>/dev/null || echo ACCOUNT-SIBLING-WRITE-denied`,
      `cat ${JSON.stringify(join(environmentWorktree, "marker"))} >/dev/null 2>&1 || echo ENV-SIBLING-READ-denied`,
      `cat ${JSON.stringify(settings)} >/dev/null 2>&1 || echo SETTINGS-READ-denied`,
      `echo actor >> ${JSON.stringify(settings)} 2>/dev/null || echo SETTINGS-WRITE-denied`,
      `ls ${JSON.stringify(f.pluginData)} >/dev/null 2>&1 || echo PLUGIN-DATA-PARENT-READ-denied`
    ].join("; ")],
    env: { HOME: f.home, PATH: "/usr/bin:/bin", CODEX_HOME: selected },
    profile: "acceptEdits",
    accountHome: selected
  });
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: f.project, env: wrapped.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split("\n").filter(Boolean), [
      "OWN-READ-ok", "OWN-WRITE-ok", "CLI-SETTINGS-WRITE-denied", "ACCOUNT-SIBLING-READ-denied", "ACCOUNT-SIBLING-WRITE-denied",
      "ENV-SIBLING-READ-denied", "SETTINGS-READ-denied", "SETTINGS-WRITE-denied", "PLUGIN-DATA-PARENT-READ-denied"
    ]);
    assert.equal(await readFile(join(selected, "actor.txt"), "utf8"), "actor\n");
    assert.equal(existsSync(join(selected, "config.toml")), false);
    assert.equal(await readFile(join(sibling, "marker"), "utf8"), "sibling fixture home\n");
    assert.equal(await readFile(settings, "utf8"), "private account settings\n");
  } finally {
    wrapped.cleanup();
  }
});

