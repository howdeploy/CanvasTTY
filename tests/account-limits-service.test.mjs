import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountLimitsService } from "../src/main/services/AccountLimitsService.ts";

function registryFor(availableProvider, cli, environment = {}) {
  // Windows resolves a script CLI to a .cmd shim that runs through cmd.exe, as the real registry does.
  const launch = process.platform === "win32"
    ? { launcher: "batch", commandPrompt: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe" }
    : { launcher: "native" };
  return {
    get(provider) {
      if (provider === availableProvider) {
        return { state: "available", provider, executable: cli, ...launch, environment, checked: [] };
      }
      return { state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" };
    },
    snapshot() { return {}; },
    refresh() { return {}; }
  };
}

function availableSnapshot(provider) {
  const source = provider === "codex" ? "codex-app-server" : "claude-usage-api";
  return {
    fetchedAt: Date.now(),
    providers: [{ provider, state: "available", source, fetchedAt: Date.now(), windows: [] }]
  };
}

async function makeHome(root, provider, accountId) {
  const home = join(await realpath(root), `${provider}-${accountId}`);
  await mkdir(home);
  return home;
}

test("Codex account limits run app-server with the accepted account home", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-account-limits-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accountId = "acct1";
  const home = await makeHome(root, "codex", accountId);
  const observedPath = join(root, "observed.json");
  const script = join(root, "codex-fake");
  await writeFile(script, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ home: process.env.CODEX_HOME, ambient: process.env.CANVASTTY_TEST_AMBIENT }));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "account/rateLimits/read"
    ? { rateLimits: { limitId: "codex", primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1786160179 } } }
    : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`, { mode: 0o700 });
  // Windows cannot run a shebang script directly; a batch shim hands it to this Node, like npm's codex.cmd.
  const cli = process.platform === "win32" ? join(root, "codex-fake.cmd") : script;
  if (cli !== script) await writeFile(cli, `@"${process.execPath}" "${script}" %*\r\n`);

  const service = new AccountLimitsService(registryFor("codex", cli, {
    CODEX_HOME: "/runtime/default-codex-home",
    CANVASTTY_TEST_AMBIENT: "preserved"
  }));
  t.after(() => service.dispose());

  const result = await service.read({ provider: "codex", accountId, home });
  assert.equal(result.state, "available");
  assert.equal(result.provider, "codex");
  assert.equal(result.windows[0].usedPercent, 41);
  assert.deepEqual(JSON.parse(await readFile(observedPath, "utf8")), {
    home,
    ambient: "preserved"
  });
});

test("Claude limits read the selected profile's credentials and issue only the injected request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-account-limits-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accountId = "acct2";
  const home = await makeHome(root, "claude", accountId);
  const token = "fixture-claude-oauth-token";
  await writeFile(join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: token }
  }));
  const requestLog = [];
  const cli = join(root, "claude-fake");
  await writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  const service = new AccountLimitsService(registryFor("claude", cli, {
    CLAUDE_CONFIG_DIR: "/runtime/default-claude-home"
  }), {
    claudeUsageOptions: {
      platform: "linux",
      request: async (url, accessToken, headers) => {
        requestLog.push({ url, accessToken, headers });
        return { five_hour: { utilization: 23 } };
      }
    }
  });
  t.after(() => service.dispose());

  const result = await service.read({ provider: "claude", accountId, home });
  assert.equal(result.state, "available");
  assert.equal(result.provider, "claude");
  assert.equal(result.windows[0].usedPercent, 23);
  assert.deepEqual(requestLog, [{
    url: "https://api.anthropic.com/api/oauth/usage",
    accessToken: token,
    headers: {
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "canvastty/unknown"
    }
  }]);
});

test("missing, mismatched, default, and unsupported account homes are unavailable without borrowing defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-account-limits-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = await makeHome(root, "codex", "other");
  let clientsCreated = 0;
  const service = new AccountLimitsService(registryFor("codex", "/not-used"), {
    createLimitsService: () => {
      clientsCreated++;
      return { get: async () => availableSnapshot("codex"), dispose() {} };
    }
  });
  t.after(() => service.dispose());

  const missing = await service.read({ provider: "codex", accountId: "acct3" });
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.source, "codex-app-server");
  assert.equal(missing.reason, "not-authenticated");
  assert.equal(typeof missing.checkedAt, "number");
  const mismatched = await service.read({ provider: "codex", accountId: "acct3", home });
  assert.equal(mismatched.state, "unavailable");
  assert.equal(mismatched.reason, "not-authenticated");
  const defaultAccount = await service.read({ provider: "codex", accountId: "default", home });
  assert.equal(defaultAccount.state, "unavailable");
  const unsupported = await service.read({ provider: "kimi", accountId: "acct4", home });
  assert.equal(unsupported.state, "unavailable");
  assert.equal(unsupported.reason, "unsupported-protocol");
  assert.equal(clientsCreated, 0);
});

test("per-account clients are isolated and bounded with least-recently-used disposal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-account-limits-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homes = await Promise.all(["a", "b", "c"].map((id) => makeHome(root, "codex", id)));
  const created = [];
  const disposed = [];
  const registry = registryFor("codex", "/not-used", { CODEX_HOME: "/ambient-default" });
  const service = new AccountLimitsService(registry, {
    maxClients: 2,
    createLimitsService: (scoped, _version, options) => {
      const selected = scoped.get("codex");
      const home = selected.state === "available" ? selected.environment.CODEX_HOME : "missing";
      created.push({ home, claudeRoot: options.claudeUsageOptions.configRoot });
      assert.equal(scoped.get("claude").state, "unavailable");
      assert.equal(scoped.get("kimi").state, "unavailable");
      assert.equal(selected.state, "available");
      return {
        get: async () => availableSnapshot("codex"),
        dispose: () => disposed.push(home)
      };
    }
  });
  t.after(() => service.dispose());

  await service.read({ provider: "codex", accountId: "a", home: homes[0] });
  await service.read({ provider: "codex", accountId: "b", home: homes[1] });
  await service.read({ provider: "codex", accountId: "a", home: homes[0] });
  await service.read({ provider: "codex", accountId: "c", home: homes[2] });
  assert.equal(created.length, 3, "the same profile reuses its client");
  assert.deepEqual(disposed, [homes[1]], "the least recently used profile is evicted first");
  assert.deepEqual(created.map((item) => item.home), homes);
  assert.deepEqual(created.map((item) => item.claudeRoot), homes);
  service.dispose();
  assert.deepEqual(disposed, [homes[1], homes[0], homes[2]]);
});

test("provider CLI refresh retires cached account-scoped readers and resolves the new executable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-account-limits-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = await makeHome(root, "codex", "refresh");
  let executable = "/old/codex";
  const created = [];
  const disposed = [];
  const registry = {
    get(provider) {
      if (provider === "codex") return { state: "available", provider, executable, launcher: "native", environment: {}, checked: [] };
      return { state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" };
    },
    snapshot() { return {}; },
    refresh() { return {}; }
  };
  const service = new AccountLimitsService(registry, {
    createLimitsService: (scoped) => {
      const selected = scoped.get("codex");
      assert.equal(selected.state, "available");
      created.push(selected.executable);
      return { get: async () => availableSnapshot("codex"), dispose: () => disposed.push(selected.executable) };
    }
  });
  t.after(() => service.dispose());

  await service.read({ provider: "codex", accountId: "refresh", home });
  executable = "/new/codex";
  await service.providerClisRefreshed();
  await service.read({ provider: "codex", accountId: "refresh", home });
  assert.deepEqual(created, ["/old/codex", "/new/codex"]);
  assert.deepEqual(disposed, ["/old/codex"]);
});
