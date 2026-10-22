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
      deviceFlowState: "idle"
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

const deviceCodeAnswer = () => Response.json({
  device_code: "test-device-code",
  user_code: "TEST-CODE",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 1
});

function serviceWith(userData, pollAnswer, options = {}) {
  const requests = { polls: 0, profile: 0 };
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith("/login/device/code")) return deviceCodeAnswer();
    if (String(url).endsWith("/login/oauth/access_token")) {
      requests.polls += 1;
      return pollAnswer(requests.polls, init);
    }
    if (String(url) === "https://api.github.com/user") {
      requests.profile += 1;
      return Response.json({ login: "fixture-user" });
    }
    return new Response("missing", { status: 404 });
  };
  const service = new GithubAuthService(userData, "client-id", {
    fetcher,
    safeStorage,
    delay: async () => undefined,
    ...options
  });
  return { service, requests };
}

test("access_denied, expired_token and unknown provider errors stop polling with a reported outcome", async () => {
  for (const [answer, expected] of [
    [() => Response.json({ error: "access_denied" }), "denied"],
    [() => Response.json({ error: "expired_token" }), "expired"],
    [() => Response.json({ error: "access_denied" }, { status: 400 }), "denied"],
    [() => Response.json({ error: "device_flow_disabled" }), "failed"],
    [() => Response.json({ error: "incorrect_client_credentials" }, { status: 400 }), "failed"],
    [() => new Response("forbidden", { status: 403 }), "failed"]
  ]) {
    const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-${expected}-`);
    try {
      const { service, requests } = serviceWith(userData, answer);
      await service.startDeviceFlow();
      await waitFor(async () => (await service.status()).deviceFlowState !== "pending");
      const status = await service.status();
      assert.equal(status.authorized, false);
      assert.equal(status.deviceFlowState, expected);
      // Give a runaway poll loop a chance to show itself.
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests.polls, 1, `${expected}: polling stopped after the terminal answer`);
      assert.equal(requests.profile, 0);
      await assert.rejects(() => readFile(`${userData}/github-oauth.json`, "utf8"), { code: "ENOENT" });
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  }
});

test("cancelDeviceFlow stops polling, reports cancelled and keeps an existing session", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-cancel-flow-`);
  const existing = { accessToken: "existing-fx", refreshToken: null, expiresAt: null, login: "existing-user" };
  const storedFile = JSON.stringify({ data: Buffer.from(JSON.stringify(existing)).toString("base64") });
  await writeFile(`${userData}/github-oauth.json`, storedFile);
  const pollSignals = [];
  const releases = [];
  try {
    const { service, requests } = serviceWith(
      userData,
      // The fetcher ignores its AbortSignal on purpose: a late answer must still be discarded.
      () => new Promise((resolve) => { releases.push(resolve); }),
      {
        delay: (_duration, signal) => {
          pollSignals.push(signal);
          return signal.aborted ? Promise.reject(new DOMException("cancelled", "AbortError")) : Promise.resolve();
        }
      }
    );
    await service.load();
    await service.startDeviceFlow();
    await waitFor(() => releases.length === 1);
    assert.equal((await service.status()).deviceFlowState, "pending");

    service.cancelDeviceFlow();
    assert.equal(pollSignals[0].aborted, true);
    assert.equal((await service.status()).deviceFlowState, "cancelled");

    releases[0](Response.json({ access_token: "late-fx", token_type: "bearer", scope: "" }));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));

    const status = await service.status();
    assert.equal(status.deviceFlowState, "cancelled");
    assert.equal(status.login, "existing-user");
    assert.equal(requests.polls, 1, "no poll after cancel");
    assert.equal(requests.profile, 0, "the late token was not used");
    assert.equal(await service.getToken(), "existing-fx");
    assert.equal(await readFile(`${userData}/github-oauth.json`, "utf8"), storedFile);

    // Cancelling again, or with nothing pending, changes nothing.
    service.cancelDeviceFlow();
    assert.equal((await service.status()).deviceFlowState, "cancelled");
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("cancelDeviceFlow after a completed sign-in keeps it", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-cancel-done-`);
  try {
    const { service } = serviceWith(userData, () => Response.json({ access_token: "done-fx", token_type: "bearer", scope: "" }));
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).authorized);
    const completed = await service.status();
    assert.equal(completed.deviceFlowState, "idle");
    service.cancelDeviceFlow();
    assert.deepEqual(await service.status(), completed);
    assert.equal(await service.getToken(), "done-fx");
    await service.signOut();
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("slow_down adds five seconds to this and every later poll", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-slow-down-`);
  const waits = [];
  const answers = [
    { error: "authorization_pending" },
    { error: "slow_down" },
    { error: "authorization_pending" },
    { error: "slow_down" },
    { error: "authorization_pending" },
    { access_token: "slow-fx", token_type: "bearer", scope: "" }
  ];
  try {
    const { service } = serviceWith(userData, () => Response.json(answers.shift()), {
      delay: async (ms) => { waits.push(ms); }
    });
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).authorized);
    assert.deepEqual(waits, [1_000, 1_000, 6_000, 6_000, 11_000, 11_000]);
    await service.signOut();
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("transient poll errors retry with back-off, reset on a valid answer, and give up after a bounded run", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-bounded-`);
  let clock = 1_000_000;
  const waits = [];
  const transient = [
    () => { throw new TypeError("fetch failed"); },
    () => new Response("unavailable", { status: 503 }),
    () => new Response("too many", { status: 429 }),
    () => new Response("not json", { status: 200 }),
    () => new Response("bad gateway", { status: 502 })
  ];
  // Four failures, one pending answer (resets the count), then five failures in a row.
  const answers = [...transient.slice(0, 4), () => Response.json({ error: "authorization_pending" }), ...transient];
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const { service, requests } = serviceWith(userData, () => answers.shift()(), {
      now: () => clock,
      delay: async (ms) => { waits.push(ms); clock += ms; }
    });
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).deviceFlowState !== "pending");
    assert.equal((await service.status()).deviceFlowState, "failed");
    assert.equal(requests.polls, 10);
    assert.equal(answers.length, 0);
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  } finally {
    console.warn = warn;
    await rm(userData, { recursive: true, force: true });
  }
});

test("the device code expires on the host clock even while GitHub keeps answering pending", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-elapsed-`);
  let clock = 1_000_000;
  try {
    const { service, requests } = serviceWith(userData, () => Response.json({ error: "authorization_pending" }), {
      now: () => clock,
      pollTimeoutMs: 2_500,
      delay: async (ms) => { clock += ms; }
    });
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).deviceFlowState !== "pending");
    assert.equal((await service.status()).deviceFlowState, "expired");
    assert.equal(requests.polls, 2);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("signOut clears a reported sign-in outcome", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-signout-outcome-`);
  try {
    const { service } = serviceWith(userData, () => Response.json({ error: "access_denied" }));
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).deviceFlowState === "denied");
    await service.signOut();
    assert.equal((await service.status()).deviceFlowState, "idle");
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("a profile request that times out after the token arrived reports a failed sign-in, not a stuck pending one", async () => {
  const userData = await mkdtemp(`${tmpdir()}/canvastty-github-auth-profile-timeout-`);
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith("/login/device/code")) return deviceCodeAnswer();
    if (String(url).endsWith("/login/oauth/access_token")) return Response.json({ access_token: "access", token_type: "bearer", scope: "" });
    // The profile request hangs until the service's own request timeout aborts it.
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    });
  };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const service = new GithubAuthService(userData, "client-id", {
      fetcher, safeStorage, requestTimeoutMs: 10, delay: async () => undefined
    });
    await service.startDeviceFlow();
    await waitFor(async () => (await service.status()).deviceFlowState !== "pending");
    const status = await service.status();
    assert.equal(status.deviceFlowState, "failed");
    assert.equal(status.authorized, false);
    await assert.rejects(() => readFile(`${userData}/github-oauth.json`, "utf8"), { code: "ENOENT" });
  } finally {
    console.warn = warn;
    await rm(userData, { recursive: true, force: true });
  }
});
