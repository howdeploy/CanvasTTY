import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runElectronSmoke } from "./lib/run-electron-smoke.mjs";
import { OrchestrationClient } from "../src/agent-browser/orchestration-helper.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const self = fileURLToPath(import.meta.url);
const electron = createRequire(import.meta.url)("electron");
const marker = "CANVASTTY_BACKLOG_ELECTRON_OK";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const foregroundScheduler = process.argv.includes("--foreground-scheduler")
  || process.env.CANVASTTY_BACKLOG_FOREGROUND_SCHEDULER === "1";
const visibleWindow = process.argv.includes("--visible-window")
  || process.env.CANVASTTY_BACKLOG_VISIBLE_WINDOW === "1";

async function untilNode(read, name, timeoutMs = 15_000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(intervalMs);
  }
  throw new Error(`Timed out: ${name}`);
}

async function monitorF02Status(window, providerState) {
  let client;
  try {
    const ready = await untilNode(async () => {
      const value = await window.webContents.executeJavaScript("window.__f02StatusProof?.phase === 'ready' ? window.__f02StatusProof : null", true);
      return value?.parentId && value?.childId ? value : null;
    }, "F02 lifecycle fixture in the renderer");
    const capability = await untilNode(async () => {
      try { return JSON.parse(await readFile(join(providerState, `orchestrator-${ready.parentId}.json`), "utf8")); }
      catch { return null; }
    }, "fixture orchestrator gateway descriptor");
    assert.equal(capability.terminalSessionId, ready.parentId);
    client = new OrchestrationClient(capability, { connectTimeoutMs: 5000, callTimeoutMs: 5000 });
    await client.connect();

    const baseline = await untilNode(async () => {
      const observation = await client.call("observe_agent", { sessionId: ready.childId });
      return observation.status === "working" ? observation : null;
    }, "observe_agent reports the rendered worker as working");
    await window.webContents.executeJavaScript(`(() => {
      window.__f02StatusProof.observeWorking = ${JSON.stringify(baseline.status)};
      window.__f02StatusProof.phase = "trigger";
    })()`, true);

    const changed = await untilNode(async () => {
      const observation = await client.call("observe_agent", { sessionId: ready.childId });
      return observation.status === "idle" ? { observation, observedAt: Date.now() } : null;
    }, "observe_agent receives the fixture worker's idle lifecycle event");
    await window.webContents.executeJavaScript(`(() => {
      window.__f02StatusProof.observeIdle = ${JSON.stringify(changed.observation.status)};
      window.__f02StatusProof.observeIdleAt = ${changed.observedAt};
    })()`, true);
    const completed = await untilNode(async () => {
      const value = await window.webContents.executeJavaScript("window.__f02StatusProof?.phase === 'complete' ? window.__f02StatusProof : null", true);
      return value ?? null;
    }, "task edge renders the lifecycle change");
    assert.equal(completed.observeWorking, "working");
    assert.equal(completed.edgeWorking, "working");
    assert.equal(completed.observeIdle, "idle");
    assert.equal(completed.edgeIdle, "waiting-response");
    assert.ok(completed.agreementMs >= 0 && completed.agreementMs < 1_000,
      `task edge must agree with observe_agent within one second; measured ${completed.agreementMs} ms`);
    return `real Electron fixture: fake Qwen lifecycle moved observe_agent and its task edge from working to idle/waiting-response in ${completed.agreementMs} ms`;
  } finally {
    client?.close();
  }
}

if (typeof electron === "string") {
  const root = await mkdtemp("/tmp/ctv-");
  const userData = join(root, "data"), project = join(root, "project");
  const providerBin = join(root, "provider-bin"), providerState = join(root, "provider-state"), fixtureHome = join(root, "home");
  await Promise.all([mkdir(userData), mkdir(project), mkdir(providerBin), mkdir(providerState), mkdir(fixtureHome)]);
  const shell = join(root, "fixture-shell");
  await writeFile(shell, '#!/bin/sh\nprintf "BACKLOG_FIXTURE_READY\\n"\nwhile IFS= read -r line; do printf "%s\\n" "$line"; if [ "$line" = "EXIT_PROOF" ]; then exit 0; fi; done\n', { mode: 0o700 });
  const fakeCodex = join(providerBin, "codex");
  await writeFile(fakeCodex, `#!/bin/sh
set -eu
if [ -z "\${CANVASTTY_TERMINAL_SESSION_ID:-}" ]; then exit 0; fi
if [ -n "\${CANVASTTY_ORCHESTRATION_ADDRESS:-}" ]; then
  umask 077
  printf '{"address":"%s","connectionId":"%s","terminalSessionId":"%s","capabilityToken":"%s"}\n' \\
    "$CANVASTTY_ORCHESTRATION_ADDRESS" "$CANVASTTY_ORCHESTRATION_CONNECTION_ID" \\
    "$CANVASTTY_TERMINAL_SESSION_ID" "$CANVASTTY_ORCHESTRATION_CAPABILITY" \\
    > "$CANVASTTY_FIXTURE_PROVIDER_DIR/orchestrator-$CANVASTTY_TERMINAL_SESSION_ID.json"
fi
printf 'FAKE_CODEX_READY\\n'
while IFS= read -r line; do printf '%s\\n' "$line"; [ "$line" = "EXIT_PROOF" ] && exit 0; done
`, { mode: 0o700 });
  const fakeHookSender = join(root, "send-runtime-hook.mjs");
  await writeFile(fakeHookSender, `import { connect } from "node:net";
const env = process.env;
const required = ["CANVASTTY_RUNTIME_ADDRESS", "CANVASTTY_RUNTIME_TERMINAL_SESSION_ID", "CANVASTTY_RUNTIME_PROVIDER", "CANVASTTY_RUNTIME_CAPABILITY"];
if (required.some(key => !env[key])) throw new Error("The fixture CLI did not receive its runtime hook capability.");
const [state, event] = process.argv.slice(2);
const message = { v: 1, type: "lifecycle", terminalSessionId: env.CANVASTTY_RUNTIME_TERMINAL_SESSION_ID,
  provider: env.CANVASTTY_RUNTIME_PROVIDER, capabilityToken: env.CANVASTTY_RUNTIME_CAPABILITY,
  state, event, turnId: "fixture-f02-turn" };
const socket = connect(env.CANVASTTY_RUNTIME_ADDRESS);
let buffer = "";
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 5000);
socket.on("connect", () => socket.write(JSON.stringify(message) + "\\n"));
socket.on("data", chunk => {
  buffer += chunk.toString("utf8");
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const response = JSON.parse(buffer.slice(0, newline));
  clearTimeout(timer);
  socket.end();
  if (response.type !== "ack") process.exitCode = 1;
});
socket.on("error", error => { clearTimeout(timer); process.stderr.write(error.message + "\\n"); process.exitCode = 1; });
`, { mode: 0o700 });
  const fakeQwen = join(providerBin, "qwen");
  await writeFile(fakeQwen, `#!/bin/sh
set -eu
if [ -z "\${CANVASTTY_TERMINAL_SESSION_ID:-}" ]; then exit 0; fi
printf '\\033]2;◐ Qwen - project\\007\\n'
printf 'FAKE_QWEN_READY\\n'
while IFS= read -r line; do
  if [ "$line" = "IDLE_PROOF" ]; then
    printf '\\033]2;Qwen - project\\007\\nQWEN_IDLE\\n'
  elif [ "$line" = "TIMELINE_PROOF" ]; then
    node "$CANVASTTY_FIXTURE_HOOK_SENDER" idle Stop
    printf 'TIMELINE_HOOK_ACKED\\n'
  elif [ "$line" = "EXIT_PROOF" ]; then
    exit 0
  else
    printf '%s\\n' "$line"
  fi
done
`, { mode: 0o700 });
  const timelineDirectory = join(userData, "session-timeline");
  await mkdir(timelineDirectory);
  const timelineStart = Date.now() - 200_000;
  const usageFixtureAccount = '=SUM(1,2), "quoted"\n東京';
  for (let part = 0; part < 10; part++) {
    const rows = Array.from({ length: 10_000 }, (_, index) => {
      const ordinal = part * 10_000 + index;
      return JSON.stringify({ id: `fixture-event-${ordinal}`, sessionId: "backlog-parent", at: timelineStart + ordinal,
        type: "command", summary: `Fixture command ${ordinal}`, source: "fixture-hook" });
    });
    if (part === 0) rows.unshift(JSON.stringify({ id: "closed-child-checkpoint", sessionId: "archived-child",
      taskId: "backlog-parent", sessionTitle: "Archived child", at: timelineStart - 1,
      type: "checkpoint", summary: "Closed fixture checkpoint" }));
    if (part === 9) {
      rows.push(JSON.stringify({ id: "usage-csv-baseline", sessionId: "backlog-parent", at: Date.now() - 8 * 86_400_000,
        type: "usage", summary: "Fixture usage baseline", detail: JSON.stringify({ input: 500_000, output: 0, total: 500_000,
          source: "electron-usage-fixture", cumulative: true, counterId: "csv-fixture", provider: "codex",
          model: "smoke-save-lock-proof", accountId: usageFixtureAccount, taskId: "backlog-parent" }) }));
      rows.push(JSON.stringify({ id: "usage-csv-week", sessionId: "backlog-parent", at: Date.now() - 2 * 86_400_000,
        type: "usage", summary: "Fixture usage two days ago", detail: JSON.stringify({ input: 800_000, output: 0,
          total: 800_000, source: "electron-usage-fixture", cumulative: true, counterId: "csv-fixture", provider: "codex",
          model: "smoke-save-lock-proof", accountId: usageFixtureAccount, taskId: "backlog-parent" }) }));
      rows.push(JSON.stringify({ id: "usage-csv-day", sessionId: "backlog-parent", at: Date.now() - 60_000,
        type: "usage", summary: "Fixture usage in current week", detail: JSON.stringify({ input: 1_000_000, output: 0,
          total: 1_000_000, source: "electron-usage-fixture", cumulative: true, counterId: "csv-fixture", provider: "codex",
          model: "smoke-save-lock-proof", accountId: usageFixtureAccount, taskId: "backlog-parent" }) }));
      rows.push(JSON.stringify({ id: "usage-csv-unknown", sessionId: "backlog-parent", at: Date.now() - 30_000,
        type: "usage", summary: "Fixture usage with unavailable token fields", detail: JSON.stringify({ input: null, output: null,
          total: 42, source: "electron-usage-unknown-fixture", cumulative: true, counterId: "csv-unknown",
          provider: "codex", model: "unknown-fixture", accountId: "unknown-account", taskId: "backlog-parent" }) }));
    }
    await writeFile(join(timelineDirectory, `${String(timelineStart + part).padStart(16, "0")}-fixture.ndjson`), rows.join("\n") + "\n");
  }
  await writeFile(join(project, "tracked.txt"), "fixture\n");
  execFileSync("git", ["init", "-q", project]);
  execFileSync("git", ["-C", project, "add", "tracked.txt"]);
  execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
  const {GitCheckpoints}=await import("../src/main/services/GitCheckpoints.ts");
  await new GitCheckpoints(text=>text,50,join(userData,"checkpoints.json")).capture("backlog-parent",project);
  await writeFile(join(userData, "settings.json"), JSON.stringify({ locale: "en", sessionRestoreMode: "continue" }));
  const base = { provider: "codex", profile: "normal", titleCustomized: true, cwd: project,
    size: { width: 560, height: 380 }, lastState: "exited", exitCode: 0, restore: true };
  await writeFile(join(userData, "terminal-sessions.json"), JSON.stringify({ version: 2, sessions: [
    { ...base, id: "backlog-parent", title: "Backlog proof", role: "orchestrator", position: { x: 80, y: 60 } },
    { ...base, id: "backlog-child", title: "Completed fixture", role: "subagent", parentSessionId: "backlog-parent", position: { x: 700, y: 60 } }
  ] }));
  const environment = {
    ...process.env,
    PATH: `${providerBin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
    HOME: fixtureHome,
    CODEX_HOME: join(fixtureHome, ".codex"),
    QWEN_HOME: join(fixtureHome, ".qwen"),
    QWEN_RUNTIME_DIR: join(fixtureHome, ".qwen-runtime"),
    XDG_CONFIG_HOME: join(fixtureHome, ".config"),
    XDG_DATA_HOME: join(fixtureHome, ".local", "share"),
    CANVASTTY_USER_DATA_DIR: userData,
    CANVASTTY_BACKLOG_FIXTURE: project,
    CANVASTTY_FIXTURE_PROVIDER_DIR: providerState,
    CANVASTTY_FIXTURE_HOOK_SENDER: fakeHookSender,
    SHELL: shell,
    CANVASTTY_BACKLOG_FOREGROUND_SCHEDULER: foregroundScheduler ? "1" : "0",
    CANVASTTY_BACKLOG_VISIBLE_WINDOW: visibleWindow ? "1" : "0"
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    await runElectronSmoke(electron, self, environment, marker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
} else {
  let ran = false;
  const fixtureProject = process.env.CANVASTTY_BACKLOG_FIXTURE;
  await writeFile(join(fixtureProject, "tracked.txt"), "checkpoint cancellation fixture\n");
  const invokeCounts = new Map();
  const usageBreakdownPeriods = [];
  const timelineInvokeTimings = [];
  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  Object.defineProperty(electron.ipcMain, "handle", {
    configurable: true,
    value(channel, handler) {
      return originalHandle(channel, async (ipcEvent, ...args) => {
        invokeCounts.set(channel, (invokeCounts.get(channel) ?? 0) + 1);
        if (channel === "backlog:usage-breakdown") usageBreakdownPeriods.push(args[1]);
        const timelineStartedAtEpochMs = channel === "backlog:timeline" ? Date.now() : null;
        const timelineStartedAt = channel === "backlog:timeline" ? performance.now() : null;
        const delayMs = channel === "backlog:tasks" ? 25
          : channel === "backlog:usage-breakdown" ? 250
          : channel === "terminal:paste-context" && args[1] === "DROP_CONTEXT_PROOF" ? 650
          : channel === "backlog:redact" && args[0] === "DROP_OLD_SLOW" ? 500
            : channel === "backlog:redact" && args[0] === "DROP_OLD_CANCEL" ? 800
              : channel === "backlog:budget" ? 850
                : channel === "backlog:network-policy-set" ? 650
                  : channel === "backlog:usage-prices-set" ? 650
                    : channel === "backlog:usage-prices" ? 650
                      : channel === "backlog:broadcast" ? 550 : 0;
        try {
          if (delayMs > 0) await delay(delayMs);
          const result = await handler(ipcEvent, ...args);
          return channel === "backlog:tasks"
            ? { ...result, fixtureReadCount: invokeCounts.get(channel) }
            : result;
        } finally {
          if (timelineStartedAt !== null && timelineStartedAtEpochMs !== null) {
            timelineInvokeTimings.push({ startEpochMs: timelineStartedAtEpochMs, elapsedMs: performance.now() - timelineStartedAt });
            if (timelineInvokeTimings.length > 100) timelineInvokeTimings.shift();
          }
        }
      });
    }
  });
  let visibleFixtureWindow = null;
  electron.app.on("browser-window-created", (_event, window) => {
    if (foregroundScheduler) {
      window.webContents.setBackgroundThrottling(false);
      window.show();
      window.focus();
    } else if (visibleWindow) {
      visibleFixtureWindow ??= window;
      if (window !== visibleFixtureWindow) return;
      window.show();
      window.focus();
    }
    const reportDiagnostics = async phase => {
      const compact = phase === "heartbeat";
      let renderer = null;
      try {
        renderer = await window.webContents.executeJavaScript(`(() => {
          const probe = window.__backlogSmokeDiagnostic ?? null;
          const inspectorChunkResources = performance.getEntriesByType("resource")
            .filter(entry => /BacklogSessionInspector[^/]*\\.js(?:[?#]|$)/u.test(new URL(entry.name, location.href).pathname))
            .map(entry => ({
              name: new URL(entry.name, location.href).pathname.split("/").at(-1),
              startTimeMs: entry.startTime,
              durationMs: entry.duration,
              responseEndMs: entry.responseEnd,
              transferSize: entry.transferSize,
              decodedBodySize: entry.decodedBodySize
            }));
          return {
            visibilityState: document.visibilityState,
            probe: ${compact ? `probe ? {
              lastFixtureCheck: probe.lastFixtureCheck ?? null,
              currentWait: probe.currentWait ?? null,
              f14Outcome: probe.f14?.outcome ?? null,
              f14ClickStartedAtEpochMs: probe.f14?.clickStartedAtEpochMs ?? null,
              f14ClickEndedAtEpochMs: probe.f14?.clickEndedAtEpochMs ?? null,
              f14DurationMs: probe.f14?.durationMs ?? null
            } : null` : "probe"},
            inspectorChunkResources: ${compact ? "[]" : "inspectorChunkResources"}
          };
        })()`, true);
      } catch (error) {
        renderer = { captureError: error instanceof Error ? error.message : String(error) };
      }
      const snapshot = {
        phase,
        foregroundScheduler,
        visibleWindow: visibleWindow && !foregroundScheduler,
        nativeWindow: (() => {
          try {
            if (window.isDestroyed() || window.webContents.isDestroyed()) return { destroyed: true };
            return {
              destroyed: false,
              visible: window.isVisible(),
              focused: window.isFocused(),
              minimized: window.isMinimized(),
              backgroundThrottling: window.webContents.backgroundThrottling,
              backgroundThrottlingSource: "webContents getter"
            };
          } catch (error) {
            return { captureError: error instanceof Error ? error.message : String(error) };
          }
        })(),
        renderer,
        timelineInvokeTimings: timelineInvokeTimings.slice(compact ? -3 : -100)
      };
      console.log(`CANVASTTY_BACKLOG_DIAGNOSTIC ${JSON.stringify(snapshot)}`);
      return snapshot;
    };
    window.webContents.once("did-finish-load", async () => {
      if (ran) return;
      ran = true;
      let heartbeatInFlight = false;
      const heartbeat = setInterval(() => {
        if (heartbeatInFlight) return;
        heartbeatInFlight = true;
        void reportDiagnostics("heartbeat")
          .catch(error => console.error("Backlog diagnostic capture failed:", error))
          .finally(() => { heartbeatInFlight = false; });
      }, 5_000);
      electron.app.once("before-quit", () => clearInterval(heartbeat));
      try {
        if (visibleWindow || foregroundScheduler) {
          window.show();
          window.focus();
          assert.equal(window.isVisible(), true, "the owned fixture window is visible");
          assert.equal(window.isMinimized(), false, "the owned fixture window is not minimized");
          if (visibleWindow && !foregroundScheduler) {
            assert.equal(window.webContents.backgroundThrottling, true, "visible-window mode preserves default background throttling");
          }
        }
        window.webContents.debugger.attach('1.3');
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
        await window.webContents.executeJavaScript(`(() => {
          const inspectorChunkResources = performance.getEntriesByType("resource")
            .filter(entry => /BacklogSessionInspector[^/]*\\.js(?:[?#]|$)/u.test(new URL(entry.name, location.href).pathname))
            .map(entry => ({
              name: new URL(entry.name, location.href).pathname.split("/").at(-1),
              startTimeMs: entry.startTime,
              durationMs: entry.duration,
              responseEndMs: entry.responseEnd,
              transferSize: entry.transferSize,
              decodedBodySize: entry.decodedBodySize
            }));
          window.__backlogSmokeDiagnostic = {
            foregroundScheduler: ${JSON.stringify(foregroundScheduler)},
            visibleWindow: ${JSON.stringify(visibleWindow && !foregroundScheduler)},
            probeStartedAtEpochMs: Date.now(),
            probeStartedAtPerformanceMs: performance.now(),
            probeStart: { visibilityState: document.visibilityState, inspectorChunkResources },
            f14: null
          };
          return true;
        })()`, true);
        await reportDiagnostics("probe-start");
        const f02StatusProof = monitorF02Status(window, process.env.CANVASTTY_FIXTURE_PROVIDER_DIR);
        const result = await window.webContents.executeJavaScript(`(${probe.toString()})(${JSON.stringify(process.env.CANVASTTY_BACKLOG_FIXTURE)})`, true);
        result.evidence.push(await f02StatusProof);
        result.checks = result.evidence.length;
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        assert.equal(invokeCounts.get("terminal:paste-context"), 2, "one direct paste and one confirmed UI paste");
        assert.equal(invokeCounts.get("backlog:checkpoint-restore") ?? 0, 0, "canceling checkpoint restore never reaches IPC");
        assert.equal(invokeCounts.get("backlog:broadcast"), 2, "one direct broadcast and one UI broadcast");
        assert.equal(invokeCounts.get("backlog:usage-prices"), 1, "global price settings load once instead of on every usage-period change");
        assert.deepEqual(usageBreakdownPeriods, ["all", "day", "day", "week"],
          "a usage-price save refreshes rows for the currently selected period only");
        assert.equal(await readFile(join(fixtureProject, "tracked.txt"), "utf8"), "checkpoint cancellation fixture\n",
          "canceling checkpoint restore leaves the project file unchanged");
        result.evidence.push("pending context confirmation reached paste IPC once despite repeated clicks");
        result.evidence.push("checkpoint restore cancellation made no IPC call and left tracked files unchanged");
        result.evidence.push("pending broadcast draft remained intact through its successful IPC response");
        result.evidence.push("global usage prices load once and period filtering does not refetch or overwrite drafts");
        result.checks = result.evidence.length;
        const reduced = await window.webContents.executeJavaScript(`(() => {
          const workspace=document.querySelector('.workspace');
          workspace.classList.add('workspace--layout-animating');
          const card=document.querySelector('.terminal-card:not(.terminal-card--fullscreen)');
          const style=getComputedStyle(card);
          const result={reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,property:style.transitionProperty,duration:style.transitionDuration};
          workspace.classList.remove('workspace--layout-animating');
          return result;
        })()`);
        assert.equal(reduced.reduced,true);
        assert.equal(reduced.property,'none');
        assert.ok(reduced.duration.split(',').every(value=>parseFloat(value)===0));
        result.evidence.push('actual reduced-motion media disables layout transitions');
        result.checks=result.evidence.length;
        result.diagnostics = await reportDiagnostics("success");
        clearInterval(heartbeat);
        window.webContents.debugger.detach();
        console.log(marker + " " + JSON.stringify(result));
        electron.app.quit();
      } catch (error) {
        clearInterval(heartbeat);
        await reportDiagnostics("failure");
        console.error("Backlog smoke failed:", error);
        electron.app.exit(1);
      }
    });
  });
  // Keep the real main process, preload, IPC trust checks and renderer. Only CLI cards restored above are inert.
  void import(pathToFileURL(join(repo, "out/main/index.js")).href);
}

async function probe(project) {
  const checks = [];
  const diagnostics = window.__backlogSmokeDiagnostic ?? (window.__backlogSmokeDiagnostic = {});
  const visibleTimelineProof = diagnostics.visibleWindow === true || diagnostics.foregroundScheduler === true;
  diagnostics.probeEnteredAtEpochMs = Date.now();
  diagnostics.probeEnteredAtPerformanceMs = performance.now();
  const inspectorChunkResources = () => performance.getEntriesByType("resource")
    .filter(entry => /BacklogSessionInspector[^/]*\.js(?:[?#]|$)/u.test(new URL(entry.name, location.href).pathname))
    .map(entry => ({
      name: new URL(entry.name, location.href).pathname.split("/").at(-1),
      startTimeMs: entry.startTime,
      durationMs: entry.duration,
      responseEndMs: entry.responseEnd,
      transferSize: entry.transferSize,
      decodedBodySize: entry.decodedBodySize
    }));
  const check = (condition, name) => {
    diagnostics.lastFixtureCheck = name;
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, name, interval = 50) => {
    diagnostics.currentWait = name;
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const value = await condition();
      if (value) { diagnostics.currentWait = null; return value; }
      await delay(interval);
    }
    throw new Error(`Timed out: ${name}`);
  };
  const setValue = (control, value) => {
    const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  const flushReact = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const observeAfter = (action, condition, name) => new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const value = condition();
      if (value) { observer.disconnect(); clearTimeout(timeout); resolve(value); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Timed out: ${name}`)); }, 15_000);
    Promise.resolve().then(action).catch(error => { observer.disconnect(); clearTimeout(timeout); reject(error); });
  });
  const api = await until(() => window.canvasTTY, "preload API");
  await until(async () => (await api.terminal.list()).some(row => row.id === "backlog-parent"), "restored task");
  check((await api.backlog.flows(project)).templates.filter(row => row.builtIn).length === 4, "four flow templates through real IPC");
  await api.backlog.saveTaskFlow("backlog-parent", "IPC approval fixture");
  const savedFlow = (await api.backlog.flows(project)).templates.find(row => row.name === "IPC approval fixture");
  check(savedFlow?.trusted === false, "a saved project flow waits for explicit approval");
  const flowPreview = await api.backlog.previewFlow(project, savedFlow.id);
  check(typeof flowPreview.instructions === "string" && /^[a-f0-9]{64}$/u.test(flowPreview.digest), "full flow preview and exact digest through IPC");
  await api.backlog.approveFlow(project, savedFlow.id, flowPreview.digest);
  check((await api.backlog.flows(project)).templates.some(row => row.id === savedFlow.id && row.trusted), "desktop approval enables the exact project flow");
  const task = await api.backlog.addTask("backlog-parent", { title: "IPC task proof" });
  const listing = await api.backlog.tasks("backlog-parent");
  check(listing.tasks.some(row => row.title === "IPC task proof"), "task board write/read");
  await api.backlog.assignTask("backlog-parent", listing.tasks[0].id, "backlog-child");
  check((await api.backlog.tasks("backlog-parent")).tasks[0].ownerSessionId === "backlog-child", "task assignment");
  await api.backlog.setBudget("backlog-parent", { tokens: 10, costUsd: null, durationMs: null });
  check((await api.backlog.budget("backlog-parent")).limits.tokens === 10, "budget write/read");
  await api.backlog.clearBudget("backlog-parent");
  check((await api.backlog.budget("backlog-parent")).limits.tokens === null, "clear budget");
  check((await api.backlog.usage("backlog-parent")).cost === null, "unknown usage stays unknown");
  check((await api.backlog.report("backlog-parent")).includes("CanvasTTY session report"), "Markdown report");
  const availableCheckpoints = await api.backlog.checkpoints("backlog-parent");
  check(availableCheckpoints.length > 0, "fixture Git checkpoint is available for preview");
  const preferences = await api.backlog.notificationPreferences();
  await api.backlog.setNotificationPreferences({ ...preferences, importantOnly: true, channels: { desktop: false, phone: true, glasses: false } });
  check((await api.backlog.notificationPreferences()).importantOnly, "notification policy");
  await api.backlog.setNetworkPolicy("backlog-parent", { mode: "offline", providerApis: false, packageRegistries: false, domains: [] });
  check((await api.backlog.networkPolicy("backlog-parent")).policy.mode === "offline", "network policy write/read");
  await api.backlog.setNetworkPolicy("backlog-parent", { mode: "open", providerApis: true, packageRegistries: true, domains: [] });
  check((await api.backlog.secretRequests("backlog-parent")).length === 0, "secret requests contain no values");
  check((await api.backlog.secretGrants("backlog-parent")).length === 0, "secret grants contain no values");

  window.__f02StatusProof = { phase: "creating" };
  const statusOrchestrator = await api.terminal.create({ provider: "codex", profile: "normal", cwd: project,
    role: "orchestrator", title: "F02 gateway fixture", position: { x: 1500, y: 900 } });
  const statusWorker = await api.terminal.create({ provider: "qwen", profile: "normal", cwd: project,
    role: "subagent", parentSessionId: statusOrchestrator.id, title: "F02 lifecycle worker", position: { x: 2200, y: 900 } });
  await until(async () => (await api.terminal.readBuffer(statusOrchestrator.id)).buffer.includes("FAKE_CODEX_READY"),
    "fixture orchestrator CLI");
  await until(async () => (await api.terminal.readBuffer(statusWorker.id)).buffer.includes("FAKE_QWEN_READY"),
    "fixture lifecycle worker CLI");
  await until(() => document.querySelector(`[data-session-id="${statusWorker.id}"]`), "rendered lifecycle worker card");
  await until(() => [...document.querySelectorAll(".workspace__task-edge")].some(edge => edge.dataset.state === "working"),
    "worker lifecycle reflected in the task edge");
  window.__f02StatusProof = { phase: "ready", parentId: statusOrchestrator.id, childId: statusWorker.id };
  await until(() => window.__f02StatusProof?.phase === "trigger", "gateway baseline observation");
  const initialEdge = [...document.querySelectorAll(".workspace__task-edge")].find(edge => edge.dataset.state === "working");
  const edgeWorking = initialEdge?.dataset.state;
  const observeWorking = window.__f02StatusProof.observeWorking;
  check(observeWorking === "working" && initialEdge?.dataset.state === observeWorking,
    "real observe_agent and the rendered task edge agree on working status");
  api.terminal.input(statusWorker.id, "IDLE_PROOF\r");
  await until(() => window.__f02StatusProof?.observeIdleAt !== undefined, "gateway observes worker idle status");
  const idleEdge = await until(() => [...document.querySelectorAll(".workspace__task-edge")]
    .find(edge => edge.dataset.state === "waiting-response"), "task edge reflects the observed idle status");
  const agreementMs = Date.now() - window.__f02StatusProof.observeIdleAt;
  check(window.__f02StatusProof.observeIdle === "idle" && idleEdge.dataset.state === "waiting-response" && agreementMs < 1000,
    `task graph agrees with observe_agent within one second (${agreementMs} ms)`);
  window.__f02StatusProof = { ...window.__f02StatusProof, phase: "complete", edgeWorking,
    edgeIdle: idleEdge.dataset.state, agreementMs };
  await api.terminal.input(statusWorker.id, "TIMELINE_PROOF\r");
  await until(async () => (await api.terminal.readBuffer(statusWorker.id)).buffer.includes("TIMELINE_HOOK_ACKED"),
    "fixture runtime lifecycle hook acknowledgement");
  let timelineSample = [];
  let hookedLifecycle;
  try { hookedLifecycle = await until(async () => {
    const page = await api.backlog.timeline(statusWorker.id, undefined, 50, { types: ["lifecycle"] });
    timelineSample = page.items.slice(0, 8).map(({ sessionId, type, summary, source }) => ({ sessionId, type, summary, source }));
    const events = page.items.filter(event => event.type === "lifecycle" && event.source === "provider-hook");
    const summaries = new Set(events.map(event => event.summary));
    return summaries.has("Stop") ? events : null;
  }, "runtime gateway lifecycle hooks appear in the session timeline", 25); }
  catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; recent timeline rows: ${JSON.stringify(timelineSample)}`);
  }
  check(hookedLifecycle.some(event => event.summary === "Stop"),
    "the session timeline records actual provider-hook lifecycle events from the runtime gateway");
  await api.terminal.dispose(statusWorker.id);
  const closedLifecycle = await api.backlog.timeline(statusOrchestrator.id, undefined, 50,
    { sessionIds: [statusWorker.id], types: ["lifecycle"] });
  check(closedLifecycle.items.some(event => event.summary === "Stop")
    && closedLifecycle.facets.agents.some(agent => agent.id === statusWorker.id && agent.title === "F02 lifecycle worker"),
    "closing a worker retains its real provider-hook timeline and agent filter");
  await api.terminal.dispose(statusOrchestrator.id);

  const parent = await api.terminal.create({ provider: "terminal", profile: "normal", cwd: project, title: "Echo fixture", position: { x: 80, y: 520 } });
  const child = await api.terminal.create({ provider: "terminal", profile: "normal", cwd: project, role: "subagent", parentSessionId: parent.id, title: "Echo child", position: { x: 700, y: 520 } });
  await until(async () => (await api.terminal.readBuffer(parent.id)).buffer.includes("BACKLOG_FIXTURE_READY"), "real PTY output");
  const matches = await until(async () => {
    const result = await api.terminal.searchOutput("BACKLOG_FIXTURE_READY", [parent.id]);
    return result.matches.length ? result.matches : null;
  }, "terminal output search index", 25);
  check(matches.length > 0 && matches[0].sessionId === parent.id, "terminal output search");
  check((await api.terminal.readOutputContext(parent.id, matches[0].offset)).text.includes("BACKLOG_FIXTURE_READY"), "historical output context");
  await api.terminal.paste(parent.id, "PASTE_PROOF");
  const sent = await api.backlog.broadcast([parent.id, child.id], "BROADCAST_PROOF");
  check(sent.delivered.length === 2, "broadcast to live cards");
  await until(async () => (await api.terminal.readBuffer(child.id)).buffer.includes("BROADCAST_PROOF"), "ordered broadcast input");
  const exported = JSON.parse(await api.backlog.exportWorkspace());
  exported.sessions = exported.sessions.filter(row => row.provider === "terminal");
  exported.tasks = [];
  const snapshot = JSON.stringify(exported);
  check((await api.backlog.previewImport(snapshot)).count === 2, "snapshot preview");
  const opened = await api.backlog.importWorkspace(snapshot, { confirmBypass: false });
  check(opened.sessions.length === 2 && opened.sessions[1].parentSessionId === opened.sessions[0].id, "snapshot restores parent relation");
  await api.backlog.saveWorkspacePreset({ id: "backlog-proof", name: "Proof", snapshot });
  check((await api.backlog.workspacePresets()).some(row => row.id === "backlog-proof"), "preset persistence");
  await api.backlog.deleteWorkspacePreset("backlog-proof");
  check(!(await api.backlog.workspacePresets()).some(row => row.id === "backlog-proof"), "preset deletion");
  const sixPreset = { ...exported, sessions: Array.from({ length: 6 }, (_, index) => ({
    ...exported.sessions[0], id: `preset-card-${index}`, title: `Preset fixture ${index}`,
    parentSessionId: index ? "preset-card-0" : undefined,
    position: { x: index * 600, y: 1000 }
  })) };
  await api.backlog.saveWorkspacePreset({ id: "six-card-proof", name: "Six cards proof", snapshot: JSON.stringify(sixPreset) });
  let presetSessions = [];

  await until(() => document.querySelector('[data-session-id="backlog-parent"]'), "rendered restored card");
  check(Boolean(document.querySelector(".terminal-task-summary")), "task summary renders after restore");
  check(document.querySelectorAll(".workspace__task-edge").length > 0, "parent links render");
  document.querySelector('[data-session-id="backlog-parent"] .terminal-card__action--options').click();
  const activity = await until(() => [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent.includes("Activity and task")), "activity menu");
  check(document.readyState === "complete", `F14 starts after document load (${document.readyState})`);
  if (visibleTimelineProof) check(document.visibilityState === "visible", "visible F14 proof requires a visible document");
  const timelineStartedAtEpochMs = Date.now();
  const timelineStartedAt = performance.now();
  diagnostics.f14 = {
    clickStartedAtEpochMs: timelineStartedAtEpochMs,
    clickStartedAtPerformanceMs: timelineStartedAt,
    clickEndedAtEpochMs: null,
    durationMs: null,
    outcome: "pending",
    readyStateAtStart: document.readyState,
    visibilityStateAtStart: document.visibilityState,
    inspectorChunkResourcesAtStart: inspectorChunkResources()
  };
  try {
    const firstRow = await observeAfter(() => activity.click(), () => document.querySelector(".backlog-timeline li"), "100,000-event timeline first row");
    if (visibleTimelineProof) {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const firstRowBounds = firstRow.getBoundingClientRect();
      diagnostics.f14.visibleLayout = {
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        width: firstRowBounds.width,
        height: firstRowBounds.height,
        frameOpportunity: "two animation frames"
      };
      if (document.visibilityState !== "visible" || firstRowBounds.width <= 0 || firstRowBounds.height <= 0) {
        throw new Error("F14 first timeline row did not reach visible layout after a frame opportunity");
      }
      diagnostics.f14.outcome = "visible-layout-after-frame-opportunity";
    } else {
      diagnostics.f14.outcome = "dom-item-rendered-only-not-f14-proof";
    }
  } catch (error) {
    diagnostics.f14.outcome = "failed";
    throw error;
  } finally {
    diagnostics.f14.clickEndedAtEpochMs = Date.now();
    diagnostics.f14.durationMs = performance.now() - timelineStartedAt;
    diagnostics.f14.visibilityStateAtEnd = document.visibilityState;
    diagnostics.f14.inspectorChunkResourcesAtEnd = inspectorChunkResources();
  }
  const timelineMs = diagnostics.f14.durationMs;
  if (visibleTimelineProof) check(timelineMs < 1000, `100,000-event timeline visible layout after frame opportunity under one second (${timelineMs.toFixed(1)} ms)`);
  const timelineForm = document.querySelector(".backlog-timeline__filters");
  const [typeFilter, agentFilter] = timelineForm.querySelectorAll("select");
  check([...typeFilter.options].some(option => option.value === "checkpoint")
    && [...agentFilter.options].some(option => option.value === "archived-child" && option.textContent === "Archived child"),
    "closed agents and older event types are selectable before loading another page");
  setValue(typeFilter, "checkpoint"); setValue(agentFilter, "archived-child");
  await flushReact(); timelineForm.querySelector('button[type="submit"]').click();
  await until(() => document.querySelector(".backlog-timeline")?.textContent.includes("Closed fixture checkpoint"),
    "filter an older closed-agent event through the real inspector");
  check(document.querySelectorAll(".backlog-timeline li").length === 1, "closed-agent filter selects only its requested event type");
  setValue(typeFilter, ""); setValue(agentFilter, "");
  await flushReact(); timelineForm.querySelector('button[type="submit"]').click();
  for (const label of ["Timeline", "Usage", "Report", "Checkpoints", "Tasks", "Budget", "Notifications", "Safety & secrets"]) {
    const button = [...document.querySelectorAll(".backlog-inspector__tabs button")].find(node => node.textContent === label);
    check(Boolean(button), `inspector tab ${label}`);
    button.click();
    await delay(250);
    await until(() => !document.querySelector(".backlog-inspector > .backlog-inspector__notice"), `${label} loading`);
    check(!document.querySelector(".backlog-inspector__error"), `${label} real IPC loads without an error`);
    if (label === "Checkpoints") {
      const previewButton = await until(() => document.querySelector(".backlog-checkpoints button"), "checkpoint preview action");
      previewButton.click();
      const checkpointPreview = await until(() => document.querySelector(".backlog-checkpoint-preview"), "checkpoint diff preview");
      check(checkpointPreview.querySelector("pre").textContent.includes("tracked.txt"), "checkpoint preview shows the fixture file change");
      const originalConfirm = window.confirm;
      let confirmationCalls = 0;
      window.confirm = () => { confirmationCalls += 1; return false; };
      checkpointPreview.querySelector(".backlog-inspector__danger").click();
      await delay(50);
      window.confirm = originalConfirm;
      check(confirmationCalls === 1, "checkpoint restore asks for confirmation");
      check(Boolean(document.querySelector(".backlog-checkpoint-preview")), "cancel leaves the checkpoint preview open");
      document.querySelector(".backlog-checkpoint-preview .backlog-inspector__secondary").click();
    }
    if (label === "Budget") {
      const tokenInput = await until(() => document.querySelector(".backlog-budget__form input"), "budget draft fields");
      await delay(250); // The next one-second poll is now in flight and held by the main-process IPC wrapper.
      setValue(tokenInput, "2468");
      await delay(900);
      check(tokenInput.value === "2468", "budget polling preserves a draft typed while the response is pending");
    }
    if (label === "Usage") {
      const prices = await until(() => document.querySelector(".backlog-usage-breakdown__prices"), "usage prices editor");
      const pricePanel = prices.closest(".backlog-usage-breakdown");
      const addPrice = prices.querySelector("header button");
      check(addPrice.disabled && prices.querySelector("footer button").disabled,
        "price editing waits for the initial global price list");
      await until(() => !addPrice.disabled, "initial global price list loads");
      await until(() => pricePanel.querySelector(".backlog-usage-breakdown__table-wrap")?.textContent.includes("1,000,000"),
        "all-time usage fixture renders");
      const allUsageText = pricePanel.querySelector(".backlog-usage-breakdown__table-wrap").textContent;
      check(allUsageText.includes("1,000,000"), "all-time report shows the current cumulative counter");
      addPrice.click();
      const row = await until(() => prices.querySelector(".backlog-usage-breakdown__price-row"), "usage price draft row");
      const fields = row.querySelectorAll("input");
      setValue(fields[0], "codex");
      setValue(fields[1], "smoke-save-lock-proof");
      setValue(fields[2], "0.25");
      setValue(fields[3], "0.75");
      await flushReact();
      check(fields[1].value === "smoke-save-lock-proof" && fields[2].value === "0.25" && fields[3].value === "0.75",
        "usage price edits are committed before save");
      const savePrices = prices.querySelector("footer button");
      savePrices.click();
      await until(() => [...prices.querySelectorAll("input")].every(input => input.disabled)
        && prices.querySelector("header button").disabled
        && [...prices.querySelectorAll(".backlog-usage-breakdown__price-row > button")].every(button => button.disabled),
      "usage price draft controls lock during save");
      check(true, "provider, model, pricing, add and remove controls lock during usage price save");
      const csvButton = pricePanel.querySelector(".backlog-usage-breakdown__export");
      check(csvButton.disabled, "usage CSV stays disabled while revised prices are saving");
      const day = [...pricePanel.querySelectorAll("header [role=group] button")].find(button => button.textContent === "Day");
      day.click();
      await until(() => day.getAttribute("aria-pressed") === "true", "period changes while price save is pending");
      await until(() => [...prices.querySelectorAll("[role=status]")].some(node => node.textContent.includes("Prices saved.")),
        "usage price save completes");
      check(fields[1].value === "smoke-save-lock-proof" && fields[2].value === "0.25" && fields[3].value === "0.75",
        "saved usage price values remain in the editor");
      await until(() => !csvButton.disabled && pricePanel.querySelector(".backlog-usage-breakdown__table-wrap")?.textContent.includes("200,000"),
        "day usage reflects today's counter increase only");
      const dayUsageText = pricePanel.querySelector(".backlog-usage-breakdown__table-wrap").textContent;
      check(!dayUsageText.includes("500,000") && !dayUsageText.includes("1,000,000"),
        "day usage excludes the two-day-old contribution and all-time cumulative counter");
      await delay(100);
      setValue(fields[1], "smoke-unsaved-period-proof");
      setValue(fields[2], "0.5");
      await flushReact();
      const week = [...pricePanel.querySelectorAll("header [role=group] button")].find(button => button.textContent === "Week");
      week.click();
      await until(() => week.getAttribute("aria-pressed") === "true", "period selection updates");
      await flushReact();
      check(csvButton.disabled, "usage CSV stays disabled while selected-week rows are loading");
      await delay(150);
      check(fields[1].value === "smoke-unsaved-period-proof" && fields[2].value === "0.5" && fields[3].value === "0.75",
        "period changes preserve unsaved global price edits after the refresh returns");
      await until(() => !csvButton.disabled && pricePanel.querySelector(".backlog-usage-breakdown__table-wrap")?.textContent.includes("500,000"),
        "selected-week usage rows enable CSV export");
      const weekUsageText = pricePanel.querySelector(".backlog-usage-breakdown__table-wrap").textContent;
      check(!weekUsageText.includes("200,000") && !weekUsageText.includes("1,000,000") && allUsageText.includes("1,000,000"),
        "week usage includes the two-day-old contribution and differs from both day and all-time values");
      const originalCreateObjectURL = URL.createObjectURL;
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      const capture = { blob: null, filename: "" };
      let downloadedUsageCsv = "";
      try {
        URL.createObjectURL = blob => { capture.blob = blob; return originalCreateObjectURL.call(URL, blob); };
        HTMLAnchorElement.prototype.click = function () { capture.filename = this.download; };
        csvButton.click();
        check(capture.blob instanceof Blob && capture.filename === "Backlog-proof-usage.csv",
          "CSV export uses the download anchor and a text Blob");
        downloadedUsageCsv = capture.blob ? await capture.blob.text() : "";
        check(capture.blob?.type === "text/csv;charset=utf-8", "CSV download Blob has the CSV content type");
      } finally {
        URL.createObjectURL = originalCreateObjectURL;
        HTMLAnchorElement.prototype.click = originalAnchorClick;
      }
      check(downloadedUsageCsv.startsWith("period,card,provider,model,account,task,input_tokens,output_tokens,total_tokens,cost_usd\n"),
        "CSV headers identify the selected period and displayed usage dimensions");
      check(downloadedUsageCsv.includes(`"week","backlog-parent","codex","smoke-save-lock-proof","'=SUM(1,2), ""quoted""\n東京","backlog-parent",500000,0,500000,0.125`),
        "CSV exports selected-week rows, formula-shields and escapes text, and preserves numeric zero");
      check(downloadedUsageCsv.includes("\"week\",\"backlog-parent\",\"codex\",\"unknown-fixture\",\"unknown-account\",\"backlog-parent\",\"Unknown\",\"Unknown\",42,\"Unknown\""),
        "CSV keeps unavailable values distinct from numeric zero");
      check(true, "selected-week usage breakdown downloads as escaped, period-scoped CSV");
    }
    if (label === "Safety & secrets") {
      const policy = await until(() => document.querySelector(".backlog-network-policy"), "network policy panel");
      const mode = policy.querySelector("select");
      setValue(mode, "allowed-domains");
      const domains = await until(() => policy.querySelector("textarea"), "allowed-domain editor");
      setValue(domains, "api.example.com");
      await flushReact();
      check(domains.value === "api.example.com", "network policy domain edit is committed before save");
      const savePolicy = policy.querySelector("button");
      savePolicy.click();
      await until(() => mode.disabled && domains.disabled && savePolicy.disabled, "network policy controls enter pending state");
      check(true, "network policy fields lock during save");
      await until(() => [...policy.querySelectorAll("[role=status]")].some(node => node.textContent.includes("Saved.")), "network policy save");
      check(mode.value === "allowed-domains" && domains.value === "api.example.com", "saved policy remains in the editor");
    }
    if(label==="Tasks"){
      const taskStart=performance.now();
      await observeAfter(()=>api.backlog.addTask('backlog-parent',{title:'EVENT_DRIVEN_TASK_PROOF'}),
        ()=>[...document.querySelectorAll('.backlog-taskboard__task-main strong')].some(node=>node.textContent==='EVENT_DRIVEN_TASK_PROOF'),
        'concurrent board change rendered');
      const taskMs=performance.now()-taskStart;
      check(taskMs<1000,`board changes render under one second (${taskMs.toFixed(1)} ms)`);
      const form = document.querySelector('.backlog-taskboard__form');
      const submit = form.querySelector('button[type="submit"]');
      const title = "UI_TASK_REFRESH_PROOF";
      const row = () => [...document.querySelectorAll('.backlog-taskboard__list li')]
        .find(item => item.querySelector('strong')?.textContent === title);
      const mutate = async (name, action, rendered) => {
        await until(() => !document.querySelector('.backlog-inspector__notice'), 'previous task refresh settles');
        const before = (await api.backlog.tasks('backlog-parent')).fixtureReadCount;
        await action();
        await until(rendered, `${name} renders`);
        await until(() => !form.querySelector('input').value && !document.querySelector('.backlog-inspector__notice'),
          `${name} task refresh settles`);
        const after = (await api.backlog.tasks('backlog-parent')).fixtureReadCount;
        // The last read is this probe; the mutation itself needs exactly one refresh.
        check(after - before - 1 === 1, `${name} refreshes the board once (${after - before - 1} reads)`);
      };
      await mutate('adding a task', async () => {
        setValue(form.querySelector('input'), title); await flushReact(); submit.click();
      }, () => Boolean(row()));
      await mutate('assigning a task', async () => {
        setValue(row().querySelector('select'), 'backlog-parent'); await flushReact();
      }, () => row()?.querySelector('select').value === 'backlog-parent');
      await mutate('closing a task', () => row().querySelector('button').click(),
        () => row()?.dataset.status === 'closed');
    }
  }
  document.querySelector('.backlog-inspector__header button').click();
  const toolsButton = await until(() => document.querySelector('[aria-label="Workspace tools"]'), "workspace tools toggle");
  toolsButton.click();
  await until(() => document.querySelector(".workspace-tools"), "workspace tools panel");
  const grid = [...document.querySelectorAll(".workspace-tools button")].find(node => node.textContent === "Grid");
  grid.click();
  await until(()=>document.querySelector('.workspace--layout-animating'),'layout animation starts',10);
  const layoutStyle=getComputedStyle(document.querySelector('.terminal-card:not(.terminal-card--fullscreen)'));
  const layoutDurations=layoutStyle.transitionDuration.split(',').map(value=>parseFloat(value)*(value.trim().endsWith('ms')?1:1000));
  check(layoutStyle.transitionProperty.includes('transform')&&layoutDurations.every(value=>value>0&&value<300),
    `actual layout transition stays under 300 ms (${Math.max(...layoutDurations).toFixed(0)} ms)`);
  await delay(400);
  const undo = [...document.querySelectorAll(".workspace-tools button")].find(node => node.textContent === "Undo layout");
  check(Boolean(undo) && !undo.disabled, "layout can be undone");
  undo.click();
  const presetRow = await until(() => [...document.querySelectorAll('.workspace-tools__presets li')].find(node => node.querySelector('span')?.textContent === 'Six cards proof'), 'six-card preset row');
  presetRow.querySelector('button').click();
  presetSessions = await until(async () => {
    const rows = (await api.terminal.list()).filter(row => row.title.startsWith('Preset fixture '));
    return rows.length === 6 ? rows : null;
  }, 'one-click six-card preset');
  check(!document.querySelector('.workspace-tools__confirm'), 'safe six-card preset opens in one action');
  await api.backlog.deleteWorkspacePreset('six-card-proof');
  document.querySelector('.workspace-tools header button').click();
  const transfer = new DataTransfer();
  transfer.setData("text/plain", "DROP_CONTEXT_PROOF");
  document.querySelector(`[data-session-id="${parent.id}"]`).dispatchEvent(new DragEvent("drop", {
    bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 200, clientY: 200
  }));
  const preview = await until(() => document.querySelector(".workspace-context-preview"), "context drop preview");
  check(preview.querySelector("textarea").value === "DROP_CONTEXT_PROOF", "dropped text has editable preview");
  check(!(await api.terminal.readBuffer(parent.id)).buffer.includes("DROP_CONTEXT_PROOF"), "drop requires confirmation before input");
  const confirmPaste = preview.querySelector(".workspace-context-preview__send");
  confirmPaste.click();
  confirmPaste.click();
  await until(() => confirmPaste.disabled, "context confirmation pending state");
  check(true, "context confirmation disables while paste is pending");
  await until(() => !document.querySelector(".workspace-context-preview"), "context confirmation");
  await until(async () => (await api.terminal.readBuffer(parent.id)).buffer.includes("DROP_CONTEXT_PROOF"), "confirmed context paste");
  const echoedContext = (await api.terminal.readBuffer(parent.id)).buffer.match(/DROP_CONTEXT_PROOF/gu) ?? [];
  check(echoedContext.length === 1, "repeated context confirmation pastes exactly once");
  const dispatchTextDrop = (text) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", text);
    document.querySelector(`[data-session-id="${parent.id}"]`).dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 200, clientY: 200
    }));
  };
  dispatchTextDrop("DROP_OLD_SLOW");
  await delay(30);
  dispatchTextDrop("DROP_LATEST");
  const latestPreview = await until(() => {
    const dialog = document.querySelector(".workspace-context-preview");
    return dialog?.querySelector("textarea").value === "DROP_LATEST" ? dialog : null;
  }, "newer context drop preview");
  await delay(550);
  check(latestPreview.querySelector("textarea").value === "DROP_LATEST", "older drop resolution cannot replace the latest preview");
  dispatchTextDrop("DROP_OLD_CANCEL");
  await delay(30);
  dispatchTextDrop("DROP_CANCEL_TARGET");
  await until(() => document.querySelector(".workspace-context-preview textarea")?.value === "DROP_CANCEL_TARGET", "cancel-race preview");
  document.querySelector(".workspace-context-preview header button").click();
  await until(() => !document.querySelector(".workspace-context-preview"), "canceled preview closes");
  await delay(850);
  check(!document.querySelector(".workspace-context-preview"), "an older pending drop cannot reopen a canceled preview");

  const workspace = document.querySelector(".workspace");
  const viewportBounds = workspace.getBoundingClientRect();
  const capture = Object.getOwnPropertyDescriptor(workspace, "setPointerCapture");
  const hasCapture = Object.getOwnPropertyDescriptor(workspace, "hasPointerCapture");
  Object.defineProperty(workspace, "setPointerCapture", { configurable: true, value: () => {} });
  Object.defineProperty(workspace, "hasPointerCapture", { configurable: true, value: () => false });
  const pointer = (type, x, y, shiftKey = type === "pointerdown", button = 0) => workspace.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 91, pointerType: "mouse", button,
    shiftKey, clientX: x, clientY: y
  }));
  pointer("pointerdown", viewportBounds.left + 2, viewportBounds.top + 2);
  pointer("pointermove", viewportBounds.right - 2, viewportBounds.bottom - 2);
  pointer("pointerup", viewportBounds.right - 2, viewportBounds.bottom - 2);
  // A real drag is followed by a click event. The canvas consumes it to clear its
  // one-shot drag-click suppression; without this, the next synthetic toolbar click
  // is mistaken for the missing trailing click and correctly suppressed.
  workspace.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window,
    clientX: viewportBounds.right - 2, clientY: viewportBounds.bottom - 2 }));

  // The camera store writes the scene transform synchronously, outside React state batching.
  // Observe that write directly while a same-task pointer burst is coalesced by RAF.
  const scene = workspace.querySelector(".workspace__scene");
  const readPanCamera = () => {
    const match = scene.style.transform.match(/^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)$/u);
    if (!match) throw new Error(`Unexpected scene transform: ${scene.style.transform}`);
    return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
  };
  const checkPan = (name, dx, dy, endingEvent) => {
    const startX = viewportBounds.left + 2, startY = viewportBounds.top + 2;
    const before = readPanCamera();
    const observer = new MutationObserver(() => {});
    observer.observe(scene, { attributes: true, attributeFilter: ["style"] });
    pointer("pointerdown", startX, startY, false, 1);
    if (endingEvent === "pointerup" && name === "raf burst") {
      for (let step = 1; step <= 20; step++) pointer("pointermove", startX + step, startY + step / 2, false, 1);
      pointer("pointerup", startX + dx, startY + dy, false, 1);
    } else {
      pointer("pointermove", startX + dx, startY + dy, false, 1);
      if (endingEvent === "blur") window.dispatchEvent(new Event("blur"));
      else pointer(endingEvent, 0, 0, false, 1);
    }
    const writeCount = observer.takeRecords().filter(record => record.attributeName === "style").length;
    observer.disconnect();
    const after = readPanCamera();
    check(Math.abs(after.x - (before.x + dx)) < 0.01 && Math.abs(after.y - (before.y + dy)) < 0.01,
      `${name} commits the latest pointer position`);
    if (name === "raf burst") check(writeCount === 1, `20 local pointer moves plus exact pointer-up commit the camera once (${writeCount} scene writes)`);
    else check(writeCount === 1, `${name} flushes the latest real pointer sample once (${writeCount} scene writes)`);
    return after;
  };
  const originalPanCamera = readPanCamera();
  checkPan("raf burst", 25, 17, "pointerup");
  workspace.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window,
    clientX: viewportBounds.left + 27, clientY: viewportBounds.top + 19 }));
  checkPan("pointer cancel", 12, 9, "pointercancel");
  const restoreDx = originalPanCamera.x - readPanCamera().x;
  const restoreDy = originalPanCamera.y - readPanCamera().y;
  pointer("pointerdown", viewportBounds.left + 2, viewportBounds.top + 2, false, 1);
  pointer("pointerup", viewportBounds.left + 2 + restoreDx, viewportBounds.top + 2 + restoreDy, false, 1);
  workspace.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window,
    clientX: viewportBounds.left + 2 + restoreDx, clientY: viewportBounds.top + 2 + restoreDy }));
  const restoredPanCamera = readPanCamera();
  check(Math.abs(restoredPanCamera.x - originalPanCamera.x) < 0.01
    && Math.abs(restoredPanCamera.y - originalPanCamera.y) < 0.01
    && Math.abs(restoredPanCamera.zoom - originalPanCamera.zoom) < 0.001,
  "pan proof restores the original camera");
  if (capture) Object.defineProperty(workspace, "setPointerCapture", capture); else delete workspace.setPointerCapture;
  if (hasCapture) Object.defineProperty(workspace, "hasPointerCapture", hasCapture); else delete workspace.hasPointerCapture;
  const toolsButtonAgain = await until(() => document.querySelector('[aria-label="Workspace tools"]'), "workspace tools toggle after drops");
  toolsButtonAgain.click();
  await until(() => document.querySelector(".workspace-tools"), "workspace tools for broadcast");
  const recipientsLabel = [...document.querySelectorAll(".workspace-tools__section")]
    .find(section => section.querySelector("legend")?.textContent === "Broadcast input")?.querySelector("small");
  check(Number(recipientsLabel?.textContent.match(/\d+/u)?.[0] ?? 0) > 0, "marquee selection finds live broadcast recipients");
  document.querySelector(".workspace-tools__section input[type=checkbox]").click();
  const broadcastEditor = await until(() => document.querySelector(".workspace-tools__broadcast-form textarea"), "broadcast editor");
  setValue(broadcastEditor, "BROADCAST_DRAFT_PROOF");
  await flushReact();
  const broadcastButton = document.querySelector(".workspace-tools__broadcast-form button");
  broadcastButton.click();
  await until(() => broadcastButton.disabled, "broadcast pending state");
  check(true, "broadcast send enters its pending state");
  setValue(broadcastEditor, "FOLLOWUP_UNSENT");
  await flushReact();
  await until(() => !document.querySelector(".workspace-tools__broadcast-form button").disabled, "broadcast response settles");
  check(broadcastEditor.value === "FOLLOWUP_UNSENT", "broadcast success preserves a newer follow-up draft");
  const reportCard = await api.terminal.create({ provider: "terminal", profile: "normal", cwd: project, title: "Report lifecycle proof", position: { x: 80, y: 1500 } });
  await until(async () => (await api.terminal.readBuffer(reportCard.id)).buffer.includes("BACKLOG_FIXTURE_READY"), "report fixture ready");
  const reportStart = performance.now();
  await observeAfter(() => api.terminal.input(reportCard.id, "EXIT_PROOF\r"),
    () => document.querySelector(`[data-session-id="${reportCard.id}"] .terminal-card__activity-summary button`), "automatic completed report card");
  const reportMs = performance.now() - reportStart;
  check(reportMs < 2000, `completion shows a report card under two seconds (${reportMs.toFixed(1)} ms)`);
  check((await api.backlog.report(reportCard.id)).includes("CanvasTTY session report"), "automatic report can be exported");
  const paletteStart = performance.now();
  // Observe actual DOM commits; Electron can throttle a background window's polling timers.
  const palette = await observeAfter(() => window.dispatchEvent(new KeyboardEvent("keydown", {
    key: "k", metaKey: navigator.platform.includes("Mac"), ctrlKey: !navigator.platform.includes("Mac"), bubbles: true
  })), () => document.querySelector(".canvas-command-palette"), "command palette shortcut");
  const paletteMs = performance.now() - paletteStart;
  check(Boolean(palette.querySelector("input")), "command palette opens by shortcut");
  check(paletteMs < 100, `command palette opens under 100 ms (${paletteMs.toFixed(1)} ms)`);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  for (const row of [parent, child, reportCard, ...opened.sessions, ...presetSessions]) await api.terminal.dispose(row.id);
  return { checks: checks.length, evidence: checks, scope: "Real Electron/main/preload/renderer; inert restored agent cards and local echo PTYs; no live model, SSH or device calls." };
}
