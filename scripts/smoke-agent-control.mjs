#!/usr/bin/env node
// Explicit live-provider acceptance. Never launches or controls a desktop window.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCli } from "./canvastty-control.mjs";
import { AgentControlGateway, codexComposerReady } from "../src/main/services/agent-control/AgentControlGateway.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { createProviderCliRegistry } from "../src/main/services/providerCliRegistry.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--live") || !option("--cwd")) {
  console.error("Usage: node scripts/smoke-agent-control.mjs --live --cwd <trusted-test-directory> [--artifacts <directory>]");
  process.exitCode = 2;
} else {
  const cwd = await realpath(resolve(option("--cwd")));
  const root = option("--artifacts") ? resolve(option("--artifacts")) : await mkdtemp(join(tmpdir(), "ctty-control-live-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const runtimeRoot = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "ctty-control-hooks-"));
  let terminals;
  let control;
  const runtime = new RuntimeGateway({ runtimeDirectory: runtimeRoot,
    ...(process.platform === "win32" ? { windowsHostPath: resolve("build/windows-agent-pipe-host/canvastty-windows-agent-pipe-host.exe") } : {}),
    onSignal(id, signal) {
      terminals?.applyProviderSignal(id, { kind: "lifecycle", state: signal.state });
      control?.onSignal(id, signal);
    } });
  let lastScreen = "";
  const transitions = [];
  try {
    await runtime.start();
    const bridge = new AgentRuntimeBridge(runtime, {
      helper: { command: process.execPath, args: [resolve("src/agent-runtime/hook-helper.mjs")] },
      runtimeDirectory: runtimeRoot, openCodePluginPath: resolve("src/agent-runtime/opencode-plugin.mjs")
    });
    const registry = createProviderCliRegistry();
    assert.equal(registry.get("codex").state, "available", "Install Codex before the explicitly requested live check.");
    terminals = new TerminalManager((channel, payload) => {
      control?.observe(channel, payload);
      if (payload.session) transitions.push({ status: payload.session.status, profile: payload.session.profile });
    }, registry, undefined, bridge);
    control = new AgentControlGateway({ userDataPath: root, terminals, lifecycleEnabled: () => true,
      ...(process.platform === "win32" ? { windowsHostPath: resolve("build/windows-agent-pipe-host/canvastty-windows-agent-pipe-host.exe") } : {}) });
    const connection = await control.start();
    const common = ["--connection", connection, "--client-file", join(root, "controller.json")];
    const call = async (...argv) => (await runCli([...common, ...argv])).result;
    const { session } = await call("create", "--provider", "codex", "--cwd", cwd, "--title", "CLI live acceptance", "--yolo");
    assert.equal(session.provider, "codex");
    assert.equal(session.profile, "yolo");
    assert.equal(session.cwd, cwd);
    console.log(JSON.stringify({ stage: "session-created", sessionId: session.id, connection, clientFile: join(root, "controller.json") }));
    const readyDeadline = Date.now() + 120_000;
    while (Date.now() < readyDeadline) {
      lastScreen = (await call("screen", session.id)).text;
      if (codexComposerReady(lastScreen)) break;
      if (/Do you trust the contents/.test(lastScreen)) throw new Error("The supplied test directory needs trust review; use an already trusted test directory.");
      if (["failed", "done"].includes((await call("status", session.id)).session.status)) throw new Error("Codex exited during startup.");
      await delay(250);
    }
    assert.ok(codexComposerReady(lastScreen), "Codex did not reach an empty composer.");
    const proof = join(cwd, `canvastty-control-proof-${randomUUID()}.txt`);
    const prompt = `This is an authorized live acceptance test. Only write the new file ${JSON.stringify(proof)}. First create it with exactly "created\\n", then append "edited\\n" in a separate write. Read it back and verify exactly two lines, created and edited. Keep the file. Do not delete files, change system settings, use browsers or network tools, or start agents. Your launch is YOLO; do not change permissions. Return CONTROL_LIVE_OK and CODEX_THREAD_ID.`;
    const promptFile = join(root, "prompt.txt");
    await writeFile(promptFile, prompt, { flag: "wx" });
    const sent = await call("send", session.id, "--prompt-file", promptFile);
    const deadline = Date.now() + 180_000;
    let answer;
    while (Date.now() < deadline) {
      answer = await call("result", session.id, "--after", String(sent.resultRevisionBefore));
      if (answer.fresh) break;
      if (["failed", "done"].includes(answer.session.status)) throw new Error("Codex exited before a result.");
      await delay(400);
    }
    assert.equal(answer?.fresh, true, "No new lifecycle result was received.");
    assert.equal(answer.turn.state, "completed");
    assert.match(answer.turn.result.text, /CONTROL_LIVE_OK/);
    assert.equal(await readFile(proof, "utf8"), "created\nedited\n");
    assert.ok(transitions.some((s) => s.status === "working"));
    assert.equal(answer.session.status, "idle");
    await writeFile(join(root, "result.json"), JSON.stringify({ session: answer.session, resultRevision: answer.resultRevision,
      result: answer.turn.result, transitions, proof, verifiedWrite: true }, null, 2) + "\n");
    console.log(JSON.stringify({ result: "CONTROL_LIVE_PASSED", provider: "codex", profile: "yolo", proof, artifacts: root }));
  } catch (error) {
    if (control && terminals?.listMetadata().length) {
      try {
        const snapshot = terminals.readBuffer(terminals.listMetadata()[0].id);
        await writeFile(join(root, "terminal-output.txt"), snapshot.buffer, { mode: 0o600 });
      } catch { /* Diagnostics must not prevent shutdown of this test's own PTY. */ }
    }
    await writeFile(join(root, "failure.json"), JSON.stringify({ message: error.message, transitions, lastScreen }, null, 2));
    console.error(JSON.stringify({ result: "CONTROL_LIVE_FAILED", message: error.message, artifacts: root }));
    process.exitCode = 1;
  } finally {
    await control?.close();
    await terminals?.shutdown();
    await runtime.close();
  }
}
