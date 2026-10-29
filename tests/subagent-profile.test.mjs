import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateOrchestrationArguments, ORCHESTRATION_TOOL_DEFINITIONS } from "../src/agent-browser/orchestration-catalog.mjs";
import { AgentControlService, subagentProfile } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

test("a subagent never gets more than its orchestrator, and never YOLO", () => {
  assert.deepEqual(subagentProfile("normal", "opencode"), { profile: "normal", inherited: true });
  assert.deepEqual(subagentProfile("auto", "opencode"), { profile: "auto", inherited: true });
  assert.deepEqual(subagentProfile("auto", "qwen"), { profile: "auto", inherited: true }, "Qwen has native Auto without CanvasTTY isolation");
  assert.deepEqual(subagentProfile("auto", "hermes"), { profile: "normal", inherited: true }, "no native Auto launch mapping and no isolation layer");
  assert.deepEqual(subagentProfile("auto", "hermes", undefined, true), { profile: "auto", inherited: true }, "inside the layer a contained auto");
  assert.deepEqual(subagentProfile("yolo", "codex"), { profile: "auto", inherited: true });
  assert.deepEqual(subagentProfile("yolo", "kimi"), { profile: "auto", inherited: true });
  assert.deepEqual(subagentProfile("auto", "claude", "acceptEdits"), { profile: "acceptEdits", inherited: false });
  assert.deepEqual(subagentProfile("acceptEdits", "claude"), { profile: "acceptEdits", inherited: true });
  assert.deepEqual(subagentProfile("acceptEdits", "kimi"), { profile: "normal", inherited: true }, "the next lower one its CLI has");
  assert.deepEqual(subagentProfile("plan", "codex"), { profile: "plan", inherited: true });
  assert.deepEqual(subagentProfile("yolo", "claude", "normal"), { profile: "normal", inherited: false });
  // Never more than the orchestrator: a normal orchestrator cannot hand out auto, a plan one cannot hand out normal.
  assert.match(subagentProfile("normal", "opencode", "auto").error, /runs in the normal profile, so its subagents get at most normal/u);
  assert.match(subagentProfile("plan", "codex", "normal").error, /at most plan/u);
  assert.match(subagentProfile("yolo", "codex", "yolo").error, /never given to a subagent/u);
  assert.match(subagentProfile("auto", "hermes", "auto").error, /hermes has no auto mode of its own/u);
  assert.match(subagentProfile("normal", "codex", "fast").error, /profile must be one of/u);
  assert.deepEqual(subagentProfile("readOnly", "cursor"), { profile: "readOnly", inherited: true });
  assert.deepEqual(subagentProfile("readOnly", "codex"), { profile: "plan", inherited: true });
  assert.deepEqual(subagentProfile("askCached", "omp"), { profile: "askCached", inherited: true });
  assert.deepEqual(subagentProfile("dontAsk", "claude"), { profile: "dontAsk", inherited: true });
  assert.deepEqual(subagentProfile("autonomous", "devin"), { profile: "autonomous", inherited: true });
  assert.match(subagentProfile("plan", "hermes").error, /no available profile at or below plan/u);
  assert.match(subagentProfile("readOnly", "omp").error, /no available profile at or below readOnly/u);
  assert.match(subagentProfile("normal", "codex", "dontAsk").error, /would give a subagent more/u);
  const spawn = ORCHESTRATION_TOOL_DEFINITIONS.find((tool) => tool.name === "spawn_agent");
  assert.deepEqual(spawn.inputSchema.properties.profile.enum, ["auto", "normal", "ask", "askCached", "acceptEdits", "dontAsk", "autonomous", "plan", "readOnly"]);
  assert.match(validateOrchestrationArguments("spawn_agent", { provider: "codex", cwd: "/p", profile: "yolo" }).error, /profile is not an accepted value/u);
});

function runtime(decisions) {
  return {
    prepareLaunch: () => ({ args: [], environment: decisions ? { CANVASTTY_RUNTIME_DECISIONS: "1" } : {}, decisions, cleanup() {} }),
    currentStatus: () => null
  };
}

async function setup(t, { decisions, baseProtection, parentProfile = "auto", parentProvider = "codex" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-subagent-profile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, runtime(decisions), true, fakeSpawner(calls));
  terminals.configureBaseProtection(() => baseProtection);
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({ provider: parentProvider, cwd: root, profile: parentProfile, position: { x: 0, y: 0 }, role: "orchestrator" });
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals));
  const spawn = (args) => handler.execute(orchestrator.id, { id: "s", tool: "spawn_agent", arguments: { cwd: root, ...args } });
  return { root, calls, terminals, spawn };
}

const buildBash = (call) => JSON.parse(call.options.env.OPENCODE_CONFIG_CONTENT).agent?.build?.permission?.bash;

test("an auto orchestrator's OpenCode subagent runs in auto: edits without asking, shell guarded by base protection", async (t) => {
  const { calls, terminals, spawn } = await setup(t, { decisions: true, baseProtection: true });
  const child = await spawn({ provider: "opencode" });
  assert.deepEqual([child.profile, child.profileInherited], ["auto", true]);
  assert.equal(terminals.getMetadata(child.sessionId).profile, "auto", "the card shows the profile it runs in");
  assert.equal(buildBash(calls.at(-1)), "allow");
  const normal = await spawn({ provider: "opencode", profile: "normal" });
  assert.equal(normal.profile, "normal");
  assert.equal(normal.profileInherited, undefined);
  const inline = calls.at(-1).options.env.OPENCODE_CONFIG_CONTENT;
  assert.ok(inline === undefined || JSON.parse(inline).agent?.build?.permission === undefined, "normal gets no auto rules");
  const qwen = await spawn({ provider: "qwen" });
  assert.equal(qwen.profile, "auto");
  assert.ok(calls.at(-1).args.includes("--approval-mode"));
  const hermes = await spawn({ provider: "hermes" });
  assert.equal(hermes.profile, "normal", "an auto without a native launch mapping or isolation becomes normal");
  await assert.rejects(spawn({ provider: "hermes", profile: "auto" }), (error) => error.bridgeError?.code === "INVALID_REQUEST" && /no auto mode/u.test(error.message));
  await assert.rejects(spawn({ provider: "codex", profile: "yolo" }), (error) => error.bridgeError?.code === "INVALID_REQUEST" && /never given to a subagent/u.test(error.message));
});

test("a YOLO orchestrator's subagents run in auto or normal, never YOLO", async (t) => {
  const { calls, spawn } = await setup(t, { decisions: true, baseProtection: true, parentProfile: "yolo" });
  const codex = await spawn({ provider: "codex" });
  assert.equal(codex.profile, "auto");
  assert.ok(!calls.at(-1).args.includes("--dangerously-bypass-approvals-and-sandbox"));
  const kimi = await spawn({ provider: "kimi" });
  assert.equal(kimi.profile, "auto");
  assert.ok(calls.at(-1).args.includes("--yolo"), "Ask When Needed is Kimi's supervised Auto");
  assert.ok(!calls.at(-1).args.includes("--auto"), "Never Ask remains unavailable to subagents");
});
