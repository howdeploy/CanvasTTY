import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LimitsService, readClaudeUsage } from "../src/main/services/LimitsService.ts";

test("Claude limits use the current user's OAuth token and perform the usage request", async () => {
  const configRoot = await mkdtemp(join(tmpdir(), "canvastty-claude-limits-"));
  try {
    const userToken = ["test", "oauth", "token"].join("-");
    await writeFile(join(configRoot, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: userToken }
    }), "utf8");
    const payload = {
      five_hour: { utilization: 12, resets_at: "2026-08-28T18:00:00Z" },
      seven_day: { utilization: 34, resets_at: "2026-09-01T18:00:00Z" }
    };
    let request = null;

    const result = await readClaudeUsage("1.3.0", {
      configRoot,
      platform: "linux",
      request: async (url, accessToken, headers) => {
        request = { url, accessToken, headers };
        return payload;
      }
    });

    assert.equal(result, payload);
    assert.deepEqual(request, {
      url: "https://api.anthropic.com/api/oauth/usage",
      accessToken: userToken,
      headers: {
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "canvastty/1.3.0"
      }
    });
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});

test("Claude throttling preserves the last quota, waits before retrying, and follows credential changes", async (t) => {
  const configRoot = await mkdtemp(join(tmpdir(), "canvastty-claude-throttle-"));
  t.after(() => rm(configRoot, { recursive: true, force: true }));
  const credential = (token) => writeFile(join(configRoot, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: token }
  }));
  await credential("fixture-account-one");
  let now = Date.parse("2026-10-29T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const requests = [];
  let response = () => new Response("{}", { status: 429, headers: { "retry-after": "0" } });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(options.headers.authorization);
    return response();
  });
  const service = new LimitsService({ get: (provider) => ({
    state: provider === "claude" ? "available" : "unavailable", provider,
    executable: "/fixture/claude", launcher: "native", environment: {}, checked: []
  }) }, "test", { cacheTtlMs: 0, claude: { configRoot, platform: "linux" } });
  t.after(() => service.dispose());
  const read = async () => (await service.getProviders(["claude"])).providers[0];

  assert.equal((await read()).reason, "rate-limited");
  now += 4 * 60_000;
  assert.equal((await read()).reason, "rate-limited");
  await service.providerClisRefreshed();
  assert.equal((await read()).reason, "rate-limited");
  assert.equal(requests.length, 1, "refresh and polling cannot bypass a zero-header backoff");
  now += 60_000;
  assert.equal((await read()).reason, "rate-limited");
  assert.equal(requests.length, 2, "the fallback deadline permits another request after five minutes");

  response = () => Response.json({ five_hour: { utilization: 12 } });
  await credential("fixture-account-two");
  const fresh = await read();
  assert.equal(fresh.state, "available", "a different credential is not blocked by the old one");
  assert.equal(fresh.windows[0].usedPercent, 12);
  assert.deepEqual(requests, ["Bearer fixture-account-one", "Bearer fixture-account-one", "Bearer fixture-account-two"]);

  response = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });
  const stale = await read();
  assert.equal(stale.state, "stale");
  assert.equal(stale.reason, "rate-limited");
  assert.equal(stale.fetchedAt, fresh.fetchedAt);
  assert.deepEqual(stale.windows, fresh.windows);
  now += 119_999;
  assert.equal((await read()).reason, "rate-limited");
  assert.equal(requests.length, 4);
  now += 2;
  response = () => Response.json({ five_hour: { utilization: 19 } });
  const recovered = await read();
  assert.equal(recovered.state, "available");
  assert.equal(recovered.windows[0].usedPercent, 19);
  assert.equal(requests.length, 5, "the server's retry deadline permits a fresh request");

  const retryAt = now + 180_000;
  response = () => new Response("{}", { status: 429, headers: { "retry-after": new Date(retryAt).toUTCString() } });
  await assert.rejects(readClaudeUsage("test", { configRoot, platform: "linux" }),
    (error) => error.message === "rate-limited" && error.retryAt === Math.floor(retryAt / 1_000) * 1_000);
});

test("missing Claude credentials mean sign-in is unavailable, not that a subscription is required", async () => {
  const missingRoot = await mkdtemp(join(tmpdir(), "canvastty-claude-missing-"));
  const emptyRoot = await mkdtemp(join(tmpdir(), "canvastty-claude-empty-"));
  try {
    await writeFile(join(emptyRoot, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "" }
    }), "utf8");

    await assert.rejects(
      readClaudeUsage("1.3.0", { configRoot: missingRoot, platform: "linux" }),
      (error) => error instanceof Error && error.message === "not-authenticated"
    );
    await assert.rejects(
      readClaudeUsage("1.3.0", { configRoot: emptyRoot, platform: "linux" }),
      (error) => error instanceof Error && error.message === "not-authenticated"
    );
  } finally {
    await Promise.all([
      rm(missingRoot, { recursive: true, force: true }),
      rm(emptyRoot, { recursive: true, force: true })
    ]);
  }
});

test("default macOS Claude profile reads the default Keychain service for the current account", async () => {
  const profileToken = ["default", "profile", "oauth"].join("-");
  let keychainQuery = null;
  let requestedToken = null;

  await readClaudeUsage("1.5.0", {
    platform: "darwin",
    homeDirectory: "/test-home",
    environment: {},
    account: "tester",
    keychainRequest: async (service, account) => {
      keychainQuery = { service, account };
      return JSON.stringify({ claudeAiOauth: { accessToken: profileToken } });
    },
    request: async (_url, accessToken) => {
      requestedToken = accessToken;
      return { five_hour: { utilization: 7 } };
    }
  });

  assert.deepEqual(keychainQuery, { service: "Claude Code-credentials", account: "tester" });
  assert.equal(requestedToken, profileToken);
});

test("custom CLAUDE_CONFIG_DIR selects its normalized hashed macOS Keychain service", async () => {
  const configRoot = "/test-home/Claude-Profiles/Cafe\u0301";
  const profileToken = ["custom", "profile", "oauth"].join("-");
  let keychainQuery = null;

  await readClaudeUsage("1.5.0", {
    platform: "darwin",
    homeDirectory: "/test-home",
    environment: { CLAUDE_CONFIG_DIR: configRoot },
    account: "profile-user",
    keychainRequest: async (service, account) => {
      keychainQuery = { service, account };
      return JSON.stringify({ claudeAiOauth: { accessToken: profileToken } });
    },
    request: async () => ({ five_hour: { utilization: 7 } })
  });

  assert.deepEqual(keychainQuery, {
    service: "Claude Code-credentials-49260767",
    account: "profile-user"
  });
});

test("CLAUDE_SECURESTORAGE_CONFIG_DIR overrides the config-root Keychain service", async () => {
  const secureStorageRoot = "/Volumes/Claude Credentials/profile-a";
  const profileToken = ["secure", "storage", "oauth"].join("-");
  let requestedService = null;

  await readClaudeUsage("1.5.0", {
    platform: "darwin",
    homeDirectory: "/test-home",
    environment: {
      CLAUDE_CONFIG_DIR: "/test-home/.claude-work",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageRoot
    },
    account: "tester",
    keychainRequest: async (service) => {
      requestedService = service;
      return JSON.stringify({ claudeAiOauth: { accessToken: profileToken } });
    },
    request: async () => ({ five_hour: { utilization: 7 } })
  });

  assert.equal(requestedService, "Claude Code-credentials-6aefe1a7");
});

test("empty CLAUDE_SECURESTORAGE_CONFIG_DIR explicitly selects the default Keychain service", async () => {
  const profileToken = ["default", "store", "oauth"].join("-");
  let requestedService = null;

  await readClaudeUsage("1.5.0", {
    platform: "darwin",
    homeDirectory: "/test-home",
    environment: {
      CLAUDE_CONFIG_DIR: "/test-home/.claude-work",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: ""
    },
    account: "tester",
    keychainRequest: async (service) => {
      requestedService = service;
      return JSON.stringify({ claudeAiOauth: { accessToken: profileToken } });
    },
    request: async () => ({ five_hour: { utilization: 7 } })
  });

  assert.equal(requestedService, "Claude Code-credentials");
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} Claude limits keep using config-root credential files`, async () => {
    const configRoot = await mkdtemp(join(tmpdir(), `canvastty-claude-${platform}-`));
    const fileToken = [platform, "file", "oauth"].join("-");
    try {
      await writeFile(join(configRoot, ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: fileToken }
      }), "utf8");
      let requestedToken = null;

      await readClaudeUsage("1.5.0", {
        platform,
        environment: {
          CLAUDE_CONFIG_DIR: configRoot,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "/ignored/on/non-macos"
        },
        keychainRequest: async () => {
          throw new Error("Keychain must not be queried");
        },
        request: async (_url, accessToken) => {
          requestedToken = accessToken;
          return { five_hour: { utilization: 7 } };
        }
      });

      assert.equal(requestedToken, fileToken);
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  });
}

test("macOS Keychain failures preserve missing-item, timeout, and protocol semantics", async () => {
  const cases = [
    { failure: Object.assign(new Error("missing"), { code: 44 }), reason: "not-authenticated" },
    { failure: Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }), reason: "timeout" },
    { failure: Object.assign(new Error("security failed"), { code: 1 }), reason: "protocol-error" }
  ];

  for (const { failure, reason } of cases) {
    await assert.rejects(
      readClaudeUsage("1.5.0", {
        platform: "darwin",
        homeDirectory: "/test-home",
        environment: {},
        account: "tester",
        keychainRequest: async () => { throw failure; }
      }),
      (error) => error instanceof Error && error.message === reason
    );
  }
});

test("malformed macOS Keychain credential JSON is a protocol error", async () => {
  await assert.rejects(
    readClaudeUsage("1.5.0", {
      platform: "darwin",
      homeDirectory: "/test-home",
      environment: {},
      account: "tester",
      keychainRequest: async () => "not-json"
    }),
    (error) => error instanceof Error && error.message === "protocol-error"
  );
});
