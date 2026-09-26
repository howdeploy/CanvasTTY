import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LimitsService } from "../src/main/services/LimitsService.ts";

async function readGrokLimits(credentials) {
  const grokHome = await mkdtemp(join(tmpdir(), "canvastty-grok-limits-"));
  const originalFetch = globalThis.fetch;
  const previousGrokHome = process.env.GROK_HOME;
  const requests = [];
  const service = new LimitsService({
    get(provider) {
      if (provider === "grok") {
        return { state: "available", provider, executable: "/resolved/grok", launcher: "native", environment: {}, checked: [] };
      }
      return { state: "unavailable", provider, reason: "cli-not-found", checked: [], diagnostic: "" };
    }
  }, "test");
  try {
    await writeFile(join(grokHome, "auth.json"), JSON.stringify(credentials), "utf8");
    process.env.GROK_HOME = grokHome;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), authorization: init.headers.authorization });
      if (init.headers.authorization !== "Bearer live-token") return new Response("{}", { status: 401 });
      return Response.json({
        config: {
          creditUsagePercent: 43,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-21T06:16:11Z", end: "2026-09-28T06:16:11Z" }
        }
      });
    };
    const grok = (await service.get()).providers.find(({ provider }) => provider === "grok");
    return { grok, requests };
  } finally {
    service.dispose();
    globalThis.fetch = originalFetch;
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    await rm(grokHome, { recursive: true, force: true });
  }
}

test("expired Grok sessions ask to launch the CLI without a billing request", async () => {
  const { grok, requests } = await readGrokLimits({
    "https://auth.x.ai::client": {
      key: "expired-token",
      auth_mode: "oidc",
      refresh_token: "refresh-token",
      expires_at: "2026-09-21T08:58:02.037226Z"
    }
  });

  assert.equal(grok.state, "unavailable");
  assert.equal(grok.reason, "session-expired");
  assert.deepEqual(requests, []);
});

test("expired Grok tokens without a refresh token still require sign-in", async () => {
  const { grok, requests } = await readGrokLimits({
    "https://accounts.x.ai/sign-in": { key: "expired-token", refresh_token: " ", expires_at: "2026-09-21T08:58:02Z" }
  });

  assert.equal(grok.state, "unavailable");
  assert.equal(grok.reason, "not-authenticated");
  assert.equal(requests.length, 1);
});

test("a stale Grok credential does not hide the selected live one", async () => {
  const { grok, requests } = await readGrokLimits({
    "https://accounts.x.ai/sign-in": { key: "expired-token", refresh_token: "refresh-token", expires_at: "2026-09-21T08:58:02Z" },
    "https://auth.x.ai::client": {
      key: "live-token",
      auth_mode: "oidc",
      refresh_token: "refresh-token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString()
    }
  });

  assert.equal(grok.state, "available");
  assert.equal(requests.length, 1);
});

test("Grok credentials without an expiry still read billing", async () => {
  const { grok, requests } = await readGrokLimits({
    "https://auth.x.ai::client": { key: "live-token", auth_mode: "oidc", refresh_token: "refresh-token" }
  });

  assert.equal(grok.state, "available");
  assert.equal(requests.length, 1);
});

test("live Grok sessions still read billing", async () => {
  const { grok, requests } = await readGrokLimits({
    "https://auth.x.ai::client": {
      key: "live-token",
      auth_mode: "oidc",
      refresh_token: "refresh-token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString()
    }
  });

  assert.equal(grok.state, "available");
  assert.equal(grok.windows[0].usedPercent, 43);
  assert.deepEqual(requests, [{
    url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    authorization: "Bearer live-token"
  }]);
});
