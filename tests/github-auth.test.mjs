import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { GithubAuthService } from "../src/main/services/GithubAuthService.ts";

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8")
};

test("GitHub device flow persists an encrypted session atomically without requesting extra scopes", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-`);
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url: String(url), body: String(init.body ?? "") });
    if (String(url).endsWith("/login/device/code")) {
      return Response.json({
        device_code: "device-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1
      });
    }
    if (String(url).endsWith("/login/oauth/access_token")) {
      return Response.json({ access_token: "access", token_type: "bearer", scope: "" });
    }
    if (String(url) === "https://api.github.com/user") return Response.json({ login: "howdeploy" });
    return new Response("missing", { status: 404 });
  };
  try {
    const service = new GithubAuthService(userData, "client-id", {
      fetcher,
      safeStorage,
      now: () => 1_000_000,
      delay: async () => undefined
    });
    const flow = await service.startDeviceFlow();
    assert.equal(flow.userCode, "ABCD-1234");
    assert.equal(flow.expiresAt, 1_900_000);
    await waitFor(async () => (await service.status()).authorized);
    await waitFor(async () => {
      try {
        await readFile(`${userData}/github-oauth.json`, "utf8");
        return true;
      } catch {
        return false;
      }
    });

    assert.equal(requests[0].body, "client_id=client-id");
    assert.equal(requests[0].body.includes("scope"), false);
    const stored = JSON.parse(await readFile(`${userData}/github-oauth.json`, "utf8"));
    assert.equal(typeof stored.data, "string");
    assert.equal(stored.data.includes("access"), false);
    assert.equal((await readdir(userData)).some((name) => name.endsWith(".tmp")), false);

    const restored = new GithubAuthService(userData, "client-id", { fetcher, safeStorage });
    await restored.load();
    assert.deepEqual(await restored.status(), {
      configured: true,
      authorized: true,
      login: "howdeploy",
      tokenExpiresAt: null,
      deviceFlowState: "idle"
    });
    assert.equal(await restored.getToken(), "access");
    await service.signOut();
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("expiring GitHub App tokens refresh without a client secret", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-refresh-`);
  let now = 1_000_000;
  let tokenRequests = 0;
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith("/login/device/code")) {
      return Response.json({
        device_code: "device-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1
      });
    }
    if (String(url).endsWith("/login/oauth/access_token")) {
      tokenRequests += 1;
      if (String(init.body).includes("grant_type=refresh_token")) {
        assert.equal(String(init.body).includes("client_secret"), false);
        return Response.json({ access_token: "refreshed", refresh_token: "refresh-2", expires_in: 3600 });
      }
      return Response.json({ access_token: "initial", refresh_token: "refresh-1", expires_in: 120 });
    }
    if (String(url) === "https://api.github.com/user") return Response.json({ login: "howdeploy" });
    return new Response("missing", { status: 404 });
  };
  try {
    const service = new GithubAuthService(userData, "client-id", {
      fetcher,
      safeStorage,
      now: () => now,
      delay: async () => undefined
    });
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).authorized);
    assert.equal(await service.getToken(), "initial");
    now += 61_000;
    assert.equal(await service.getToken(), "refreshed");
    assert.equal(tokenRequests, 2);
    await service.signOut();
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("signOut cancels an in-flight device flow and prevents a late token from being restored", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-cancel-`);
  let releaseLogin;
  let loginRequested = false;
  const fetcher = async (url) => {
    if (String(url).endsWith("/login/device/code")) {
      return Response.json({
        device_code: "device-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1
      });
    }
    if (String(url).endsWith("/login/oauth/access_token")) {
      return Response.json({ access_token: "late-access", refresh_token: "late-refresh", expires_in: 3600 });
    }
    if (String(url) === "https://api.github.com/user") {
      loginRequested = true;
      return new Promise((resolve) => {
        releaseLogin = () => resolve(Response.json({ login: "late-user" }));
      });
    }
    return new Response("missing", { status: 404 });
  };
  try {
    const service = new GithubAuthService(userData, "client-id", {
      fetcher,
      safeStorage,
      delay: async () => undefined
    });
    await service.startDeviceFlow();
    await waitFor(() => loginRequested);
    await service.signOut();
    releaseLogin();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(await service.status(), {
      configured: true,
      authorized: false,
      login: null,
      tokenExpiresAt: null,
      deviceFlowState: "cancelled"
    });
    await assert.rejects(() => readFile(`${userData}/github-oauth.json`, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("starting a new device flow aborts the previous poll", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-single-flow-`);
  const pollSignals = [];
  let code = 0;
  const fetcher = async (url) => {
    if (String(url).endsWith("/login/device/code")) {
      code += 1;
      return Response.json({
        device_code: `device-${code}`,
        user_code: `CODE-${code}`,
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1
      });
    }
    return new Response("missing", { status: 404 });
  };
  const delay = (_duration, signal) => {
    pollSignals.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  };
  try {
    const service = new GithubAuthService(userData, "client-id", { fetcher, safeStorage, delay });
    await service.startDeviceFlow();
    await waitFor(() => pollSignals.length === 1);
    await service.startDeviceFlow();
    await waitFor(() => pollSignals.length === 2);
    assert.equal(pollSignals[0].aborted, true);
    assert.equal(pollSignals[1].aborted, false);
    await service.signOut();
    assert.equal(pollSignals[1].aborted, true);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("reports an unconfigured OAuth client before starting device flow", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-unconfigured-`);
  try {
    const service = new GithubAuthService(userData, "", { safeStorage });
    assert.deepEqual(await service.status(), {
      configured: false,
      authorized: false,
      login: null,
      tokenExpiresAt: null,
      deviceFlowState: "idle"
    });
    await assert.rejects(
      () => service.startDeviceFlow(),
      /GitHub OAuth is not configured \(missing client id\)\./
    );
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("device-flow status distinguishes denial, code expiry, and provider errors", async () => {
  for (const [providerError, expectedState] of [
    ["access_denied", "denied"],
    ["expired_token", "expired"],
    ["server_error", "failed"]
  ]) {
    const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-${expectedState}-`);
    const fetcher = async (url) => {
      if (String(url).endsWith("/login/device/code")) {
        return Response.json({ device_code: "test-device-code", user_code: "TEST-CODE", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 1 });
      }
      if (String(url).endsWith("/login/oauth/access_token")) return Response.json({ error: providerError });
      return new Response("missing", { status: 404 });
    };
    try {
      const service = new GithubAuthService(userData, "client-id", {
        fetcher,
        safeStorage,
        delay: async () => undefined
      });
      await service.startDeviceFlow();
      await waitFor(async () => (await service.status()).deviceFlowState !== "pending");
      const status = await service.status();
      assert.equal(status.authorized, false);
      assert.equal(status.deviceFlowState, expectedState);
      await service.signOut();
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  }
});

test("device flow expires after elapsed time even when GitHub stays pending", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-elapsed-expiry-`);
  let clock = 1_000_000;
  let polls = 0;
  const waits = [];
  const fetcher = async (url) => {
    if (String(url).endsWith("/login/device/code")) {
      return Response.json({ device_code: "test-device-code", user_code: "TEST-CODE", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 1 });
    }
    if (String(url).endsWith("/login/oauth/access_token")) {
      polls += 1;
      return Response.json({ error: "authorization_pending" });
    }
    return new Response("missing", { status: 404 });
  };
  try {
    const service = new GithubAuthService(userData, "client-id", {
      fetcher,
      safeStorage,
      now: () => clock,
      pollTimeoutMs: 2_500,
      delay: async (duration) => {
        await new Promise((resolve) => setImmediate(resolve));
        waits.push(duration);
        clock += duration;
      }
    });
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).deviceFlowState === "expired");
    assert.equal(polls, 2);
    assert.deepEqual(waits, [1_000, 1_000, 1_000]);
    await service.signOut();
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("cancel after authorization keeps the completed sign-in", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-cancel-after-success-`);
  const credential = Buffer.from(["successful", "fixture"].join("-")).toString("base64");
  const fetcher = async (url) => {
    if (String(url).endsWith("/login/device/code")) {
      return Response.json({ device_code: "test-device-code", user_code: "TEST-CODE", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 1 });
    }
    if (String(url).endsWith("/login/oauth/access_token")) {
      return Response.json({ access_token: credential, token_type: "bearer", scope: "" });
    }
    if (String(url) === "https://api.github.com/user") return Response.json({ login: "howdeploy" });
    return new Response("missing", { status: 404 });
  };
  try {
    const service = new GithubAuthService(userData, "client-id", {
      fetcher,
      safeStorage,
      delay: async () => undefined
    });
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).authorized);
    const completedStatus = await service.status();
    assert.equal(completedStatus.deviceFlowState, "idle");

    service.cancelDeviceFlow();

    assert.deepEqual(await service.status(), completedStatus);
    assert.equal(await service.getToken(), credential);
    await service.signOut();
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("cancelling a device flow preserves the session and ignores its late token response", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-cancel-flow-`);
  const existingCredential = Buffer.from(["existing", "fixture"].join("-")).toString("base64");
  const lateCredential = Buffer.from(["late", "fixture"].join("-")).toString("base64");
  const storedTokens = { accessToken: existingCredential, refreshToken: null, expiresAt: null, login: "existing-user" };
  const storedFile = JSON.stringify({ data: Buffer.from(JSON.stringify(storedTokens)).toString("base64") });
  await writeFile(`${userData}/github-oauth.json`, storedFile);
  const delayWaiters = [];
  let deviceRequests = 0;
  let oldPollRequested = false;
  let releaseOldPoll;
  let profileRequests = 0;
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith("/login/device/code")) {
      deviceRequests += 1;
      return Response.json({ device_code: `device-${deviceRequests}`, user_code: `CODE-${deviceRequests}`, verification_uri: "https://github.com/login/device", expires_in: 60, interval: 1 });
    }
    if (String(url).endsWith("/login/oauth/access_token")) {
      if (String(init.body).includes("device_code=device-1")) {
        oldPollRequested = true;
        return new Promise((resolve) => { releaseOldPoll = resolve; });
      }
      return Response.json({ error: "authorization_pending" });
    }
    if (String(url) === "https://api.github.com/user") {
      profileRequests += 1;
      return Response.json({ login: "unexpected-user" });
    }
    return new Response("missing", { status: 404 });
  };
  const service = new GithubAuthService(userData, "client-id", {
    fetcher,
    safeStorage,
    delay: (_duration, signal) => new Promise((resolve, reject) => {
      const waiter = { resolve };
      delayWaiters.push(waiter);
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    })
  });
  try {
    await service.load();
    await service.startDeviceFlow();
    await waitFor(() => delayWaiters.length === 1);
    delayWaiters[0].resolve();
    await waitFor(() => oldPollRequested);

    service.cancelDeviceFlow();
    assert.equal((await service.status()).deviceFlowState, "cancelled");
    assert.equal(await service.getToken(), existingCredential);
    assert.equal(await readFile(`${userData}/github-oauth.json`, "utf8"), storedFile);

    await service.startDeviceFlow();
    await waitFor(() => delayWaiters.length === 2);
    releaseOldPoll(Response.json({ access_token: lateCredential, token_type: "bearer", scope: "" }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const status = await service.status();
    assert.equal(status.authorized, true);
    assert.equal(status.login, "existing-user");
    assert.equal(status.deviceFlowState, "pending");
    assert.equal(profileRequests, 0, "late response must not trigger a profile request");
    assert.equal(await service.getToken(), existingCredential);
    assert.equal(await readFile(`${userData}/github-oauth.json`, "utf8"), storedFile);

    service.cancelDeviceFlow();
    assert.equal((await service.status()).deviceFlowState, "cancelled");
    assert.equal(await service.getToken(), existingCredential);
    assert.equal(await readFile(`${userData}/github-oauth.json`, "utf8"), storedFile);
  } finally {
    await service.signOut();
    await rm(userData, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("device polling survives network errors and timeouts, backs off, and honours slow_down", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-retry-`);
  let clock = 1_000_000;
  const waits = [];
  const answers = [
    () => { throw new TypeError("fetch failed"); },
    () => { throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" }); },
    () => new Response("unavailable", { status: 503 }),
    () => Response.json({ error: "slow_down", interval: 20 }),
    () => Response.json({ error: "authorization_pending" }),
    () => Response.json({ access_token: "access", token_type: "bearer", scope: "" })
  ];
  const fetcher = async (url) => {
    if (String(url).endsWith("/login/device/code")) {
      return Response.json({ device_code: "d", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    }
    if (String(url).endsWith("/login/oauth/access_token")) return answers.shift()();
    if (String(url) === "https://api.github.com/user") return Response.json({ login: "howdeploy" });
    return new Response("missing", { status: 404 });
  };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const service = new GithubAuthService(userData, "client-id", {
      fetcher,
      safeStorage,
      now: () => clock,
      delay: async (ms) => { waits.push(ms); clock += ms; }
    });
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).authorized);
    assert.equal(answers.length, 0, "every answer was consumed; the poll did not stop at the first error");
    // 5 s, then doubled after each failure (10, 20, 40), then slow_down's 20 s from GitHub (+5 over
    // the current interval as a floor), kept for later polls.
    assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000, 45_000, 45_000]);
    await service.signOut();
  } finally {
    console.warn = warn;
    await rm(userData, { recursive: true, force: true });
  }
});
