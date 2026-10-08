#!/usr/bin/env node
// A fresh-home Electron smoke for restored terminals, lazy chunk failure/retry,
// and keystrokes forwarded by the terminal's loading shell through the real PTY.
// Prepare with `electron-vite build --mode terminal-smoke`; restore a normal build afterward.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runElectronSmoke } from "./lib/run-electron-smoke.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const self = fileURLToPath(import.meta.url);
const electron = createRequire(import.meta.url)("electron");
const marker = "CANVASTTY_TERMINAL_LOADING_ELECTRON_OK";
const shellReadyMarker = "CTTY_LAZY_SHELL_READY";
const typedOutputMarker = "CTTY_LAZY_INPUT_OK";
const typedCommand = `echo ${typedOutputMarker}`;
const sessionId = "lazy-terminal-fixture";
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

if (typeof electron === "string") {
  const root = await mkdtemp("/private/tmp/ctty-terminal-load-");
  try {
    const fixture = await createFixture(root);
    const environment = {
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      XDG_CONFIG_HOME: join(fixture.home, ".config"),
      XDG_DATA_HOME: join(fixture.home, ".local", "share"),
      CANVASTTY_USER_DATA_DIR: fixture.userData,
      SHELL: fixture.shell,
      PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      TMPDIR: root,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8"
    };
    await runElectronSmoke(electron, self, environment, marker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
} else {
  const { app } = await import("electron");
  const userData = process.env.CANVASTTY_USER_DATA_DIR;
  assert.ok(userData, "fresh user data directory was not configured");
  app.setPath("userData", userData);

  let ran = false;
  app.on("browser-window-created", (_event, window) => {
    if (ran) return;
    ran = true;
    void runProbe(window, app).catch((error) => {
      console.error("Terminal loading Electron smoke failed:", error);
      app.exit(1);
    });
  });
  void import(pathToFileURL(join(repo, "out/main/index.js")).href);
}

async function createFixture(root) {
  const home = join(root, "home");
  const userData = join(root, "data");
  const project = join(root, "project");
  await Promise.all([mkdir(home), mkdir(userData, { recursive: true }), mkdir(project)]);

  // The fixture accepts one exact command and prints one marker. It never invokes
  // arbitrary command text, so this checks a real PTY without running user tools.
  const shell = join(root, "inert-echo-shell");
  await writeFile(shell, `#!/bin/sh
printf '${shellReadyMarker}\\n'
while IFS= read -r line; do
  case "$line" in
    '${typedCommand}') printf '${typedOutputMarker}\\n' ;;
    *) printf 'FIXTURE_COMMAND_REJECTED\\n' ;;
  esac
done
`, { mode: 0o700 });

  await writeFile(join(userData, "settings.json"), JSON.stringify({
    locale: "en", sessionRestoreMode: "continue", agentIsolation: "off", agentControlEnabled: false,
    agentLifecycleHooksEnabled: false, browserAgentAccess: false, browserRestoreTabs: false
  }));
  await writeFile(join(userData, "terminal-sessions.json"), JSON.stringify({ version: 2, sessions: [{
    id: sessionId, provider: "terminal", profile: "normal", role: "agent", title: "Lazy terminal fixture",
    titleCustomized: true, cwd: project, position: { x: 80, y: 60 }, size: { width: 620, height: 420 },
    lastState: "running", restore: true
  }] }));
  return { home, userData, shell };
}

async function runProbe(window, app) {
  const contents = window.webContents;
  const protocol = contents.debugger;
  const errors = [];
  let finishedLoads = 0;
  let probeFinished = false;
  let loadsAtTerminalFailure = null;
  const failProbe = (error) => {
    if (probeFinished) return;
    probeFinished = true;
    console.error(error?.stack ?? error);
    appExit(1);
  };

  contents.on("did-finish-load", () => { finishedLoads += 1; });
  contents.on("render-process-gone", (_event, details) => failProbe(new Error(`renderer exited: ${JSON.stringify(details)}`)));
  contents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  try {
    protocol.attach("1.3");
    console.log("terminal loading smoke: CDP attached");
    await waitFor(() => contents.getURL().includes("index.html"), "application page to start", contents);
    await waitFor(async () => await evaluate(contents,
      "window.__canvasttyTerminalCardLoadState?.attempts === 1"), "controlled first import failure", contents);
    await waitFor(async () => await evaluate(contents, `Boolean(document.querySelector(".workspace"))`), "workspace render", contents);

    await waitFor(async () => await evaluate(contents, `Boolean(
      document.querySelector('.terminal-card--load-error[data-session-id="${sessionId}"] [role=alert]')
      && document.querySelector(".terminal-card--load-error button")
      && document.querySelector(".workspace")
      && !document.querySelector(".renderer-recovery")
    )`), "terminal-only error panel with retry", contents);
    loadsAtTerminalFailure = finishedLoads;
    assert.equal(await evaluate(contents, `document.querySelector(".terminal-card--load-error [role=alert]")?.textContent.includes("Could not load this terminal")`), true,
      "the terminal load error is localized inside its own card");
    assert.equal(await evaluate(contents, `document.querySelector(".terminal-card--load-error button")?.textContent.trim()`), "Retry",
      "the failed terminal exposes a retry action");
    assert.equal(await evaluate(contents, "window.__canvasttyTerminalCardLoadState.attempts"), 1,
      "the CDP fixture rejected the initial lazy import");
    const startupOutput = await waitForValue(async () => {
      const snapshot = await evaluate(contents, `window.canvasTTY.terminal.readBuffer("${sessionId}")`);
      return snapshot?.buffer?.includes(shellReadyMarker) ? snapshot : null;
    }, "the restored inert shell to start", contents);
    assert.ok(startupOutput.buffer.includes(shellReadyMarker), "the restored terminal has a live PTY before retry");

    await evaluate(contents, `document.querySelector(".terminal-card--load-error button")?.click()`);
    await waitFor(async () => await evaluate(contents, "window.__canvasttyTerminalCardLoadState.attempts === 2"),
      "the retry import to pause in the CDP fixture", contents);
    assert.equal(await evaluate(contents, `Boolean(document.querySelector('.terminal-card--loading[data-session-id="${sessionId}"] textarea'))`), true,
      "the retried terminal stays on its loading shell while the chunk is held");

    window.show();
    window.focus();
    await wait(80);
    const textareaFocused = await evaluate(contents, `(() => {
      const field = document.querySelector('.terminal-card--loading[data-session-id="${sessionId}"] textarea');
      if (!field) return false;
      field.focus();
      return document.activeElement === field;
    })()`);
    assert.equal(textareaFocused, true, "the loading shell provides a focused native input proxy");
    await contents.debugger.sendCommand("Input.insertText", { text: typedCommand });
    await contents.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });
    await contents.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });

    const preRenderBuffer = await waitForValue(async () => {
      const snapshot = await evaluate(contents, `window.canvasTTY.terminal.readBuffer("${sessionId}")`);
      return snapshot?.buffer && new RegExp(`(?:^|\\r?\\n)${typedOutputMarker}(?:\\r?\\n|$)`, "u").test(snapshot.buffer)
        ? snapshot : null;
    }, "real PTY output while the renderer chunk is still paused", contents);
    assert.ok(preRenderBuffer.buffer.includes(typedCommand),
      "the text entered while loading reached the restored terminal PTY");
    assert.match(preRenderBuffer.buffer, new RegExp(`(?:^|\\r?\\n)${typedOutputMarker}(?:\\r?\\n|$)`, "u"),
      "the inert shell accepted the typed command and printed its output");
    assert.equal(await evaluate(contents, `Boolean(document.querySelector('.terminal-card--loading[data-session-id="${sessionId}"] .xterm-screen'))`), false,
      "the terminal has not mounted before the delayed chunk is released");

    await protocol.sendCommand("Runtime.evaluate", {
      expression: "window.__canvasttyTerminalCardLoadState.release()",
      awaitPromise: true,
      returnByValue: true
    });
    await waitFor(async () => await evaluate(contents, `Boolean(
      document.querySelector('.terminal-card[data-session-id="${sessionId}"] .xterm-screen')
      && Array.from(document.querySelectorAll('.terminal-card[data-session-id="${sessionId}"] .xterm-rows > div'))
        .some((row) => (row.textContent || "").includes("CTTY_LAZY_INPUT_OK") && !(row.textContent || "").includes("echo"))
    )`), "restored terminal xterm to render the preserved PTY output", contents);
    assert.equal(await evaluate(contents, "window.__canvasttyTerminalCardLoadState.attempts"), 2,
      "the retry action invoked the terminal chunk loader again");
    assert.equal(finishedLoads, loadsAtTerminalFailure,
      "terminal chunk failure did not reload the whole application window");
    assert.equal(errors.filter((message) => message.includes("CanvasTTY could not load the terminal panel")).length, 1,
      "the only logged renderer error is the controlled terminal chunk failure");
    assert.equal(await evaluate(contents, `Boolean(document.querySelector('.workspace') && !document.querySelector('.renderer-recovery'))`), true,
      "the workspace remains available after the terminal-only import failure");
    console.log(`${marker} ${JSON.stringify({
      attempts: await evaluate(contents, "window.__canvasttyTerminalCardLoadState.attempts"),
      output_before_xterm_render: preRenderBuffer.buffer.includes("CTTY_LAZY_INPUT_OK"),
      restored_terminal_rendered: true,
      main_window_loads: finishedLoads,
      renderer_console_errors: errors.length
    })}`);
    probeFinished = true;
    appExit(0);
  } catch (error) {
    const diagnostic = await evaluate(contents, `(async () => {
      const [settings, sessions] = await Promise.all([
        window.canvasTTY.settings.get().catch(() => null),
        window.canvasTTY.terminal.list().catch(() => null)
      ]);
      return {
        url: location.href,
        body: document.body.innerText.slice(0, 1200),
        settingsMode: settings?.sessionRestoreMode,
        sessions: sessions?.map(({ id, provider, status, cwd, exitCode, failureDetails, startedAt }) => ({
          id, provider, status, cwd, exitCode, failureDetails, startedAt
        })),
        terminalCards: [...document.querySelectorAll(".terminal-card")].map((card) => ({
          id: card.getAttribute("data-session-id"), className: card.className, text: card.textContent?.slice(0, 120)
        })),
        fixture: window.__canvasttyTerminalCardLoadState
          ? { attempts: window.__canvasttyTerminalCardLoadState.attempts } : null
      };
    })()`);
    console.error("Terminal loading smoke startup diagnostics:", JSON.stringify(diagnostic));
    failProbe(error);
  }

  function appExit(code) {
    if (code === 0) app.quit();
    else app.exit(code);
  }
}

async function evaluate(contents, expression) {
  try { return await contents.executeJavaScript(expression, true); }
  catch { return null; }
}

async function waitFor(predicate, description, contents, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    if (contents.isDestroyed()) throw new Error(`renderer closed while waiting for ${description}`);
    await wait(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForValue(probe, description, contents, timeoutMs = 10_000) {
  return waitFor(probe, description, contents, timeoutMs);
}
