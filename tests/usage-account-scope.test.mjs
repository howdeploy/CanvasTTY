import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LimitsService, readClaudeUsage, withoutAccountScope } from "../src/main/services/LimitsService.ts";

const ACCOUNT_A = ["acct", "alpha", "4f1c"].join("-");
const ACCOUNT_B = ["acct", "beta", "9d2e"].join("-");
const CODEX_SECRETS = ["codex-access-secret", "codex-refresh-secret", "codex-id-token"];
const CLAUDE_TOKEN = ["claude", "oauth", "epoch", "one"].join("-");
const CLAUDE_TOKEN_NEXT = ["claude", "oauth", "epoch", "two"].join("-");

function codexAuth(accountId) {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      account_id: accountId,
      access_token: CODEX_SECRETS[0],
      refresh_token: CODEX_SECRETS[1],
      id_token: CODEX_SECRETS[2]
    }
  });
}

function registry(executables) {
  const calls = [];
  return {
    calls,
    get(provider) {
      calls.push(provider);
      const executable = executables[provider];
      return executable
        ? Object.freeze({
          state: "available",
          provider,
          executable,
          launcher: "native",
          environment: Object.freeze({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
          checked: Object.freeze([])
        })
        : Object.freeze({ state: "unavailable", provider, reason: "cli-not-found", checked: Object.freeze([]), diagnostic: "" });
    },
    snapshot() {
      return {};
    }
  };
}

/** A minimal Codex app-server double: JSON-RPC over stdio, controlled by files in `root`. */
async function fakeCodex(root) {
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(root, "percent"), "20");
  const script = join(root, "fake-codex.mjs");
  await writeFile(script, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const root = ${JSON.stringify(root)};
appendFileSync(root + "/spawns", "spawn\\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.id !== "number") return;
  if (message.method === "initialize") return reply(message.id, {});
  if (message.method !== "account/rateLimits/read") return process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1 } }) + "\\n");
  const switchFile = root + "/switch-during-request";
  if (existsSync(switchFile)) {
    writeFileSync(root + "/codex-home/auth.json", readFileSync(switchFile));
    unlinkSync(switchFile);
  }
  const percent = Number(readFileSync(root + "/percent", "utf8"));
  reply(message.id, { rateLimits: {
    limitId: "codex",
    primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 1790000000 },
    secondary: { usedPercent: percent / 2, windowDurationMins: 10080, resetsAt: 1790500000 }
  } });
});
`);
  await chmod(script, 0o755);
  return {
    codexHome,
    script,
    spawns: async () => (await readFile(join(root, "spawns"), "utf8").catch(() => "")).split("\n").filter(Boolean).length
  };
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-usage-scope-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertNoCodexSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of [ACCOUNT_A, ACCOUNT_B, ...CODEX_SECRETS]) {
    assert.equal(text.includes(secret), false, "auth material must never leave the credential reader");
  }
}

test("Codex scope is a one-way fingerprint of tokens.account_id and is stable per account", async () => {
  await withRoot(async (root) => {
    const codex = await fakeCodex(root);
    await writeFile(join(codex.codexHome, "auth.json"), codexAuth(ACCOUNT_A));
    const service = new LimitsService(registry({ codex: codex.script }), "test", {
      environment: { CODEX_HOME: codex.codexHome },
      cacheTtlMs: 0
    });
    try {
      const first = await service.getProviders(["codex"]);
      const second = await service.getProviders(["codex"]);
      const [snapshot] = first.providers;
      assert.equal(snapshot.state, "available");
      assert.match(snapshot.accountScope, /^[0-9a-f]{16,64}$/);
      assert.equal(second.providers[0].accountScope, snapshot.accountScope);
      assertNoCodexSecrets(first);
      assertNoCodexSecrets(second);

      await writeFile(join(codex.codexHome, "auth.json"), codexAuth(ACCOUNT_B));
      const other = new LimitsService(registry({ codex: codex.script }), "test", {
        environment: { CODEX_HOME: codex.codexHome },
        cacheTtlMs: 0
      });
      try {
        const otherScope = (await other.getProviders(["codex"])).providers[0].accountScope;
        assert.match(otherScope, /^[0-9a-f]{16,64}$/);
        assert.notEqual(otherScope, snapshot.accountScope);
      } finally {
        other.dispose();
      }
    } finally {
      service.dispose();
    }
  });
});

test("a Codex account switch during or between requests makes those observations account-unknown", async () => {
  await withRoot(async (root) => {
    const codex = await fakeCodex(root);
    await writeFile(join(codex.codexHome, "auth.json"), codexAuth(ACCOUNT_A));
    const service = new LimitsService(registry({ codex: codex.script }), "test", {
      environment: { CODEX_HOME: codex.codexHome },
      cacheTtlMs: 0
    });
    try {
      const before = (await service.getProviders(["codex"])).providers[0];
      assert.match(before.accountScope, /^[0-9a-f]+$/);

      await writeFile(join(root, "switch-during-request"), codexAuth(ACCOUNT_B));
      const during = (await service.getProviders(["codex"])).providers[0];
      assert.equal(during.state, "available");
      assert.equal(during.accountScope, null, "scope read before and after the request disagree");

      const afterSwitch = (await service.getProviders(["codex"])).providers[0];
      assert.equal(afterSwitch.accountScope, null, "the first observation after an account change stays unknown");
      assert.equal(await codex.spawns(), 2, "the long-lived app-server restarts so it cannot keep the previous login");

      const settled = (await service.getProviders(["codex"])).providers[0];
      assert.match(settled.accountScope, /^[0-9a-f]+$/);
      assert.notEqual(settled.accountScope, before.accountScope);
      assert.equal(await codex.spawns(), 2);
      assertNoCodexSecrets([before, during, afterSwitch, settled]);
    } finally {
      service.dispose();
    }
  });
});

test("missing or API-key-only Codex auth leaves the account unknown without failing limits", async () => {
  await withRoot(async (root) => {
    const codex = await fakeCodex(root);
    const apiKey = ["sk", "test", "only", "key"].join("-");
    const service = new LimitsService(registry({ codex: codex.script }), "test", {
      environment: { CODEX_HOME: codex.codexHome },
      cacheTtlMs: 0
    });
    try {
      const missing = (await service.getProviders(["codex"])).providers[0];
      assert.equal(missing.state, "available");
      assert.equal(missing.accountScope, null);

      await writeFile(join(codex.codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: apiKey }));
      const keyOnly = (await service.getProviders(["codex"])).providers[0];
      assert.equal(keyOnly.state, "available");
      assert.equal(keyOnly.accountScope, null);
      assert.equal(JSON.stringify(keyOnly).includes(apiKey), false);

      await writeFile(join(codex.codexHome, "auth.json"), "{not json");
      const corrupt = (await service.getProviders(["codex"])).providers[0];
      assert.equal(corrupt.state, "available");
      assert.equal(corrupt.accountScope, null);
    } finally {
      service.dispose();
    }
  });
});

test("Claude scope callback receives only a credential-epoch fingerprint, never the token", async () => {
  await withRoot(async (root) => {
    const received = [];
    const read = async (token) => {
      await writeFile(join(root, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
      await readClaudeUsage("1.5.0", {
        configRoot: root,
        platform: "linux",
        onScope: (...args) => received.push(args),
        request: async () => ({ five_hour: { utilization: 7 } })
      });
    };
    await read(CLAUDE_TOKEN);
    await read(CLAUDE_TOKEN);
    await read(CLAUDE_TOKEN_NEXT);

    assert.equal(received.length, 3);
    for (const args of received) {
      assert.equal(args.length, 1);
      assert.match(args[0], /^[0-9a-f]{16,64}$/);
      assert.equal(args[0].includes(CLAUDE_TOKEN), false);
      assert.equal(args[0].includes(CLAUDE_TOKEN_NEXT), false);
    }
    assert.equal(received[0][0], received[1][0], "one credential epoch keeps one scope");
    assert.notEqual(received[0][0], received[2][0], "a new token starts a new, incomparable epoch");
  });
});

test("missing Claude credentials never report a scope", async () => {
  await withRoot(async (root) => {
    let called = false;
    await assert.rejects(
      readClaudeUsage("1.5.0", { configRoot: root, platform: "linux", onScope: () => { called = true; } }),
      (error) => error instanceof Error && error.message === "not-authenticated"
    );
    assert.equal(called, false);
  });
});

test("Claude snapshots carry the epoch scope, and stale repeats keep the scope of the original observation", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_TOKEN } }));
    let failing = false;
    let requests = 0;
    const service = new LimitsService(registry({ claude: "/fake/claude" }), "test", {
      cacheTtlMs: 0,
      claude: {
        configRoot: root,
        platform: "linux",
        request: async (_url, token) => {
          requests += 1;
          assert.equal(token, CLAUDE_TOKEN);
          if (failing) throw new Error(`upstream rejected ${token}`);
          return { five_hour: { utilization: 12, resets_at: "2026-09-21T18:00:00Z" } };
        }
      }
    });
    try {
      const fresh = (await service.getProviders(["claude"])).providers[0];
      assert.equal(fresh.state, "available");
      assert.match(fresh.accountScope, /^[0-9a-f]{16,64}$/);
      failing = true;
      const stale = (await service.getProviders(["claude"])).providers[0];
      assert.equal(stale.state, "stale");
      assert.equal(stale.accountScope, fresh.accountScope);
      assert.equal(stale.fetchedAt, fresh.fetchedAt);
      assert.equal(requests, 2);
      assert.equal(JSON.stringify([fresh, stale]).includes(CLAUDE_TOKEN), false);
    } finally {
      service.dispose();
    }
  });
});

test("history reads touch only Codex and Claude while get() keeps every provider", async () => {
  const providers = registry({});
  const service = new LimitsService(providers, "test");
  try {
    providers.calls.length = 0;
    const partial = await service.getProviders(["codex", "claude"]);
    assert.deepEqual(partial.providers.map((provider) => provider.provider), ["codex", "claude"]);
    assert.deepEqual([...new Set(providers.calls)].sort(), ["claude", "codex"]);

    const full = await service.get();
    assert.deepEqual(
      full.providers.map(({ provider, state, reason }) => ({ provider, state, reason })),
      ["codex", "claude", "qwen", "kimi", "opencode", "grok"].map((provider) => ({
        provider,
        state: "unavailable",
        reason: "cli-not-found"
      }))
    );
  } finally {
    service.dispose();
  }
});

test("history reads and get() share fresh provider results instead of repeating provider requests", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_TOKEN } }));
    let requests = 0;
    const service = new LimitsService(registry({ claude: "/fake/claude" }), "test", {
      claude: {
        configRoot: root,
        platform: "linux",
        request: async () => {
          requests += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { five_hour: { utilization: 12 } };
        }
      }
    });
    try {
      const [history, full] = await Promise.all([service.getProviders(["claude"]), service.get()]);
      const again = await service.getProviders(["claude"]);
      assert.equal(requests, 1);
      const claude = full.providers.find((provider) => provider.provider === "claude");
      assert.equal(claude.fetchedAt, history.providers[0].fetchedAt);
      assert.equal(again.providers[0].fetchedAt, history.providers[0].fetchedAt);
    } finally {
      service.dispose();
    }
  });
});

test("plugin and companion views omit account scope without mutating the source snapshot", () => {
  const snapshot = {
    fetchedAt: 1,
    providers: [
      { provider: "codex", state: "available", source: "codex-app-server", fetchedAt: 1, windows: [], accountScope: "abc123" },
      { provider: "claude", state: "stale", source: "claude-usage-api", fetchedAt: 1, failedAt: 2, reason: "timeout", windows: [], accountScope: null },
      { provider: "qwen", state: "unavailable", source: "qwen-cli", checkedAt: 1, reason: "unsupported-protocol" }
    ]
  };
  const view = withoutAccountScope(snapshot);
  assert.equal(JSON.stringify(view).includes("accountScope"), false);
  assert.equal(view.providers[0].state, "available");
  assert.equal(view.providers[1].reason, "timeout");
  assert.equal(snapshot.providers[0].accountScope, "abc123");
});
