import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const electron = createRequire(import.meta.url)("electron");
const marker = "CANVASTTY_GITHUB_AUTH_SMOKE_OK";
const timeoutMs = 60_000;
const authChannels = new Set([
  "github-auth:start",
  "github-auth:status",
  "github-auth:cancel",
  "github-auth:open-url"
]);

if (typeof electron === "string") {
  await launchElectronFixture(electron);
} else {
  await runElectronFixture(electron);
}

async function launchElectronFixture(electronPath) {
  const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "ctgh-"));
  const userData = join(root, "data");
  const fixtureHome = join(root, "home");
  const fixtureBin = join(root, "bin");
  await Promise.all([mkdir(userData), mkdir(fixtureHome), mkdir(fixtureBin)]);
  await writeFile(join(userData, "settings.json"), JSON.stringify({ locale: "en", sessionRestoreMode: "continue" }));
  await writeFile(join(userData, "terminal-sessions.json"), JSON.stringify({ version: 2, sessions: [] }));
  await writeFile(join(root, "untrusted-renderer.html"), "<!doctype html><html><body>Untrusted auth IPC fixture</body></html>");

  const environment = {
    ...process.env,
    PATH: fixtureBin,
    HOME: fixtureHome,
    CODEX_HOME: join(fixtureHome, ".codex"),
    QWEN_HOME: join(fixtureHome, ".qwen"),
    XDG_CONFIG_HOME: join(fixtureHome, ".config"),
    XDG_DATA_HOME: join(fixtureHome, ".local", "share"),
    XDG_STATE_HOME: join(fixtureHome, ".local", "state"),
    XDG_CACHE_HOME: join(fixtureHome, ".cache"),
    CANVASTTY_USER_DATA_DIR: userData,
    CANVASTTY_GITHUB_AUTH_FIXTURE_DIR: root
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.GITHUB_OAUTH_CLIENT_ID;
  delete environment.CANVASTTY_GITHUB_CLIENT_ID;
  for (const name of Object.keys(environment)) {
    if (/(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|OAUTH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|APPLICATION_CREDENTIALS|GITHUB_TOKEN|TOKEN)$/i.test(name)) {
      delete environment[name];
    }
  }
  if (process.platform === "win32") {
    environment.USERPROFILE = fixtureHome;
    environment.APPDATA = join(fixtureHome, "AppData", "Roaming");
    environment.LOCALAPPDATA = join(fixtureHome, "AppData", "Local");
  }

  const args = [self, "--disable-gpu"];
  if (process.platform === "linux" && process.env.CI === "true") args.push("--no-sandbox");
  const child = spawn(electronPath, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let outputLength = 0;
  const collect = (chunk) => {
    const text = chunk.toString("utf8");
    outputLength += text.length;
    output = `${output}${text}`.slice(-32 * 1024);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let timeout;
  try {
    const result = await new Promise((resolveExit, reject) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`GitHub auth smoke exceeded its deadline.${capturedOutput(output, outputLength)}`));
      }, timeoutMs);
      child.once("error", reject);
      // close includes drained stdout/stderr; exit can precede the final marker.
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    if (result.signal !== null) {
      assert.fail(`GitHub auth smoke timed out or crashed (signal ${result.signal}).${capturedOutput(output, outputLength)}`);
    }
    if (result.code !== 0) {
      assert.fail(`GitHub auth smoke failed (exit ${result.code}).${capturedOutput(output, outputLength)}`);
    }
    const summary = output.split("\n").find((line) => line.startsWith(`${marker} `));
    assert.ok(summary, `GitHub auth smoke did not finish.${capturedOutput(output, outputLength)}`);
    process.stdout.write(`${summary}\n`);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

function capturedOutput(output, totalLength) {
  const maxLength = 12 * 1024;
  let tail = output.slice(-maxLength);
  tail = tail.replace(
    /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|user[_-]?code|device[_-]?code|oauth[_-]?code|client[_-]?secret|authorization)\b["']?\s*[:=]\s*)["']?[^"'\s,}]+["']?/gi,
    "$1[REDACTED]"
  );
  tail = tail.replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
  const truncated = totalLength > tail.length ? "\n[child output truncated to a bounded tail]" : "";
  return `\n--- captured child output ---\n${tail || "(empty)"}${truncated}\n--- end captured child output ---`;
}

async function runElectronFixture(electronApi) {
  const fixture = {
    status: authStatus("idle"),
    starts: 0,
    statusReads: 0,
    cancels: 0,
    openUrlCalls: 0,
    completeOnCancel: false,
    untrustedStatusCalls: 0,
    untrustedStatusRejected: 0
  };
  let primaryWindow = null;
  let ran = false;
  const originalHandle = electronApi.ipcMain.handle.bind(electronApi.ipcMain);
  Object.defineProperty(electronApi.ipcMain, "handle", {
    configurable: true,
    value(channel, handler) {
      if (!authChannels.has(channel)) return originalHandle(channel, handler);
      return originalHandle(channel, async (event, ...args) => {
        if (!isPrimaryRenderer(event, primaryWindow)) {
          // The real status handler is safe to invoke and proves that its trusted-renderer check
          // rejects an actual second WebContents. Other unexpected senders fail closed here.
          if (channel === "github-auth:status") {
            fixture.untrustedStatusCalls += 1;
            try {
              return await handler(event, ...args);
            } catch (error) {
              fixture.untrustedStatusRejected += 1;
              throw error;
            }
          }
          throw new Error("Untrusted caller rejected by the auth smoke fixture.");
        }

        if (channel === "github-auth:status") {
          fixture.statusReads += 1;
          return { ...fixture.status };
        }
        if (channel === "github-auth:start") {
          fixture.starts += 1;
          fixture.status = authStatus("pending");
          // Empty by design: the renderer follows its normal sign-in path, while its clipboard
          // IPC receives empty text and the production main handler leaves the user clipboard alone.
          return {
            userCode: "",
            verificationUri: "https://github.com/login/device",
            interval: 0.05,
            expiresAt: Date.now() + 60_000
          };
        }
        if (channel === "github-auth:cancel") {
          fixture.cancels += 1;
          if (fixture.completeOnCancel) {
            fixture.completeOnCancel = false;
            fixture.status = {
              ...authStatus("idle"),
              authorized: true,
              login: "fixture-user"
            };
          } else if (fixture.status.deviceFlowState === "pending") {
            fixture.status = authStatus("cancelled");
          }
          return undefined;
        }
        if (channel === "github-auth:open-url") {
          fixture.openUrlCalls += 1;
          assert.equal(args[0], "https://github.com/login/device", "fixture should use the device-flow URL");
          // Do not call the original handler: it would open a real browser.
          return undefined;
        }
        throw new Error("Unexpected GitHub auth channel.");
      });
    }
  });

  electronApi.app.on("browser-window-created", (_event, window) => {
    if (primaryWindow) return;
    primaryWindow = window;
    window.webContents.once("did-finish-load", () => {
      if (ran) return;
      ran = true;
      void exerciseAuthUi(window, fixture, electronApi)
        .then((summary) => {
          console.log(`${marker} ${JSON.stringify(summary)}`);
          electronApi.app.quit();
        })
        .catch((error) => {
          console.error("GitHub auth Electron smoke failed:", error instanceof Error ? error.message : "unknown failure");
          electronApi.app.exit(1);
        });
    });
  });

  void import(new URL("../out/main/index.js", import.meta.url).href);

  async function exerciseAuthUi(window, authFixture, electron) {
    const evidence = [];
    await untilRenderer(window, "Boolean(window.canvasTTY) && Boolean(document.querySelector('.settings-button'))", "production renderer and preload");
    await evaluate(window, "document.querySelector('.settings-button').click(); true");
    await untilRenderer(window, "Boolean(document.querySelector('#settings-tab-plugins'))", "Settings navigation");
    await evaluate(window, "document.querySelector('#settings-tab-plugins').click(); true");
    await untilRenderer(window, "Boolean(document.querySelector('.plugin-github-group'))", "GitHub auth settings");
    await untilRenderer(window, "Boolean(document.querySelector('.plugin-github-signin-secondary'))", "configured sign-in actions");

    await assertUntrustedStatusRejected(window, authFixture, electron);
    evidence.push("untrusted secondary renderer status IPC rejected by the production handler");

    await startFlow(window, authFixture, 1);
    evidence.push(await expectTerminalNotice(window, authFixture, "denied", "denied", "denial notice, code clearing, and retry"));
    await startFlow(window, authFixture, 2);
    evidence.push(await expectTerminalNotice(window, authFixture, "expired", "expired", "expiry notice, code clearing, and retry"));
    await startFlow(window, authFixture, 3);
    evidence.push(await expectTerminalNotice(window, authFixture, "failed", "could not be completed", "failure notice, code clearing, and retry"));

    await startFlow(window, authFixture, 4);
    await evaluate(window, "document.querySelector('.plugin-github-cancel').click(); true");
    await untilRenderer(window, "(() => { const notice = document.querySelector('.plugin-github-flow-notice'); return !document.querySelector('.plugin-github-code') && notice?.textContent.includes('was cancelled') && document.querySelectorAll('.plugin-github-signin-actions button').length === 2; })()", "explicit cancel clears the code and restores retry actions");
    assert.equal(authFixture.cancels, 1);
    evidence.push("explicit cancellation notice, code clearing, and retry");

    await startFlow(window, authFixture, 5);
    authFixture.completeOnCancel = true;
    await evaluate(window, "document.querySelector('.plugin-github-cancel').click(); true");
    await untilRenderer(window, "(() => { const signedIn = document.querySelector('.plugin-github-status strong'); return signedIn?.textContent === '@fixture-user' && !document.querySelector('.plugin-github-code') && !document.querySelector('.plugin-github-flow-notice'); })()", "authorization success wins a raced cancel");
    assert.equal(authFixture.status.authorized, true);
    assert.equal(authFixture.status.deviceFlowState, "idle");
    assert.equal(authFixture.cancels, 2);
    assert.equal(authFixture.starts, 5);
    assert.equal(authFixture.openUrlCalls, 5);
    evidence.push("canonical authorized status wins a raced cancel without a cancelled notice");

    await assertUntrustedStatusRejected(window, authFixture, electron);
    assert.equal(authFixture.untrustedStatusCalls, 2);
    assert.equal(authFixture.untrustedStatusRejected, 2);
    evidence.push("untrusted status IPC remains rejected after the fixture flow");

    return {
      scope: "production renderer and preload with synthetic GitHub auth IPC responses",
      checks: evidence.length,
      evidence,
      authCalls: {
        starts: authFixture.starts,
        statusReads: authFixture.statusReads,
        cancels: authFixture.cancels,
        openUrl: authFixture.openUrlCalls
      },
      externalBrowserOpened: false,
      liveDeviceFlowStarted: false,
      providerSessionsRestored: 0
    };
  }
}

async function startFlow(window, fixture, expectedStartCount) {
  await evaluate(window, "document.querySelector('.plugin-github-signin-secondary').click(); true");
  await untilRenderer(window, "Boolean(document.querySelector('.plugin-github-code strong'))", "synthetic authorization code UI");
  await untilRenderer(window, "document.querySelector('.plugin-github-code strong')?.textContent === ''", "empty synthetic code fixture");
  assert.equal(fixture.starts, expectedStartCount);
  assert.equal(fixture.openUrlCalls, expectedStartCount);
}

async function expectTerminalNotice(window, fixture, state, text, label) {
  fixture.status = authStatus(state);
  await untilRenderer(window, `(() => {
    const notice = document.querySelector('.plugin-github-flow-notice');
    return !document.querySelector('.plugin-github-code') && notice?.textContent.includes(${JSON.stringify(text)})
      && document.querySelectorAll('.plugin-github-signin-actions button').length === 2;
  })()`, label);
  return label;
}

async function assertUntrustedStatusRejected(primaryWindow, fixture, electronApi) {
  const preload = fileURLToPath(new URL("../out/preload/index.cjs", import.meta.url));
  const root = process.env.CANVASTTY_GITHUB_AUTH_FIXTURE_DIR;
  assert.ok(root, "fixture directory should be set");
  const secondary = new electronApi.BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
  });
  try {
    await secondary.loadFile(join(root, "untrusted-renderer.html"));
    const exposed = await secondary.webContents.executeJavaScript("typeof window.canvasTTY", true);
    assert.equal(exposed, "object", "secondary window must use the production preload");
    const rejected = await secondary.webContents.executeJavaScript(
      "window.canvasTTY.githubAuth.status().then(() => false, () => true)",
      true
    );
    assert.equal(rejected, true, "the production GitHub status handler must reject the untrusted sender");
  } finally {
    if (!secondary.isDestroyed()) secondary.close();
  }
}

function isPrimaryRenderer(event, window) {
  return Boolean(window && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame);
}

function authStatus(deviceFlowState) {
  return {
    configured: true,
    authorized: false,
    login: null,
    tokenExpiresAt: null,
    deviceFlowState
  };
}

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(expression, true);
}

async function untilRenderer(window, expression, name, timeout = 12_000, interval = 40) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error("Main renderer was destroyed.");
    const result = await evaluate(window, expression);
    if (result) return result;
    await delay(interval);
  }
  throw new Error(`Timed out waiting for ${name}.`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
