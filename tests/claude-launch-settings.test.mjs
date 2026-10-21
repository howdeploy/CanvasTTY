/**
 * Claude settings a launch contributor passes: every form (`--settings <json>`, `--settings=<json>`, a settings file
 * among its launch files, any other file) is checked as an option/value pair, and the launch keeps one effective
 * `--settings` whose hooks, permissions and sandbox are CanvasTTY's, in Normal and in Auto. Flags that switch
 * Claude's hooks or permission prompts off are CanvasTTY's too. No real CLI runs here; HOME is the runner's fake one.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { coreOwnedLaunchArgument, mergeClaudeInlineSettings } from "../src/main/services/terminalLaunch.ts";

const cwd = process.cwd();
const at = { x: 0, y: 0 };
const HOOKS = { showStatusInTerminalTab: true, hooks: { Stop: [{ hooks: [{ type: "command", command: "/core/hook stop" }] }] } };
const ROUTE = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" } };
const settingsOf = (args) => args.flatMap((arg, index) => args[index - 1] === "--settings" ? [JSON.parse(arg)] : []);
const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

async function pipelineWith(t, answer) {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-claude-settings-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  return new LaunchPipeline({
    contributors: () => [{ pluginId: "p.route", pluginName: "Route", serviceId: "svc", secrets: false,
      launch: { fields: [{ key: "on", label: "On", kind: "boolean", default: true }] } }],
    call: async () => answer,
    secret: async () => null,
    runsRoot,
    timeoutMs: 1_000
  });
}

const context = { sessionId: "s1", provider: "claude", profile: "normal", role: "agent", cwd, restoring: false, resume: false,
  options: { "p.route": { on: true } } };

test("protected Claude settings are refused in every form: equals, separate value, launch file, other file", async (t) => {
  const refused = async (answer, pattern) => {
    const prepared = await (await pipelineWith(t, answer)).prepare(context);
    assert.equal(prepared.ok, false, JSON.stringify(answer).slice(0, 100));
    assert.match(prepared.reason, pattern, JSON.stringify(answer).slice(0, 100));
  };
  const file = (content) => ({ args: ["--settings", "{launchFiles}/settings.json"], files: [{ relPath: "settings.json", content }] });
  for (const key of ["disableAllHooks", "hooks", "permissions", "sandbox", "defaultMode", "apiKeyHelper"]) {
    const value = key === "disableAllHooks" ? true : key === "defaultMode" ? "bypassPermissions" : {};
    await refused({ args: [`--settings=${JSON.stringify({ [key]: value })}`] }, new RegExp(`Route .*${key}.*only CanvasTTY`, "u"));
    await refused({ args: ["--settings", JSON.stringify({ ...ROUTE, [key]: value })] }, /only CanvasTTY/u);
    await refused(file(JSON.stringify({ [key]: value })), new RegExp(`Route .*${key}.*only CanvasTTY`, "u"));
  }
  await refused({ args: ["--settings", "/etc/claude/other.json"] }, /settings file CanvasTTY cannot check/u);
  await refused({ args: ["--settings=/etc/claude/other.json"] }, /settings file CanvasTTY cannot check/u);
  await refused({ args: ["--settings", "{launchFiles}/missing.json"], files: [{ relPath: "other.json", content: "{}" }] },
    /settings file CanvasTTY cannot check/u);
  await refused(file("not json"), /settings.*not a JSON object/u);
  await refused({ args: ["--settings", "{broken"] }, /settings.*not a JSON object/u);
  await refused({ args: ["--settings"] }, /--settings without a value/u);
  // Flags that switch CanvasTTY's hooks or permission prompts off, or allow tools without asking.
  for (const args of [["--bare"], ["--safe-mode"], ["--allowedTools", "Bash"], ["--allowed-tools=Bash"], ["--permission-prompt-tool", "mcp__x"],
    ["--permission-prompts", "host"]]) {
    await refused({ args }, /only CanvasTTY may pass/u);
  }
});

test("allowed Claude settings are normalized to one inline JSON: equals form and a launch file both work", async (t) => {
  const equals = await (await pipelineWith(t, { args: [`--settings=${JSON.stringify(ROUTE)}`, "--model", "qwen3.5:9b"] })).prepare(context);
  assert.equal(equals.ok, true, equals.reason);
  assert.deepEqual(equals.args, ["--settings", JSON.stringify(ROUTE), "--model", "qwen3.5:9b"]);
  const fromFile = await (await pipelineWith(t, { args: ["--settings", "{launchFiles}/claude/settings.json"],
    files: [{ relPath: "claude/settings.json", content: JSON.stringify({ ...ROUTE, model: "qwen3.5:9b" }) }] })).prepare(context);
  assert.equal(fromFile.ok, true, fromFile.reason);
  assert.deepEqual(fromFile.args, ["--settings", JSON.stringify({ ...ROUTE, model: "qwen3.5:9b" })]);
  await fromFile.cleanup();
  // The merger understands the equals form too, so the core's own settings are never displaced by a later one.
  const merged = mergeClaudeInlineSettings(["--settings", JSON.stringify(HOOKS), `--settings=${JSON.stringify(ROUTE)}`]);
  assert.deepEqual(merged, ["--settings", JSON.stringify({ ...HOOKS, ...ROUTE })]);
  assert.equal(coreOwnedLaunchArgument("claude", `--settings=${JSON.stringify({ disableAllHooks: true })}`), true);
  assert.equal(coreOwnedLaunchArgument("claude", "--settings=/etc/other.json"), true);
  assert.equal(coreOwnedLaunchArgument("claude", `--settings=${JSON.stringify(ROUTE)}`), false);
  assert.equal(coreOwnedLaunchArgument("codex", "--bare"), false, "other agents' flags are their own");
});

/** A card through the real TerminalManager + LaunchPipeline, with CanvasTTY's hook settings from the runtime bridge. */
async function launchClaude(t, profile, answer) {
  const pipeline = await pipelineWith(t, answer);
  const calls = [];
  const runtime = {
    prepareLaunch: () => ({ args: ["--settings", JSON.stringify(HOOKS)], environment: {}, cleanup() {} }),
    currentStatus: () => null
  };
  const clis = { get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: {}, checked: [] }),
    snapshot: () => ({}) };
  const terminals = new TerminalManager(() => undefined, clis, undefined, runtime, true, (command, args) => {
    calls.push({ command, args });
    return { pid: 1, write() {}, resize() {}, kill() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
  });
  t.after(() => terminals.shutdown());
  terminals.configureLaunchPipeline(pipeline);
  const card = terminals.create({ provider: "claude", profile, cwd, position: at, launchOptions: { "p.route": { on: true } } });
  const current = () => terminals.list().find((session) => session.id === card.id);
  await waitFor(() => calls.length > 0 || current().status === "failed");
  return { args: calls[0]?.args ?? null, card: current() };
}

test("Normal and Auto: one effective --settings keeps CanvasTTY's hooks with the plugin's allowed keys", async (t) => {
  for (const profile of ["normal", "auto"]) {
    for (const answer of [
      { args: [`--settings=${JSON.stringify(ROUTE)}`] },
      { args: ["--settings", "{launchFiles}/settings.json"], files: [{ relPath: "settings.json", content: JSON.stringify(ROUTE) }] }
    ]) {
      const { args, card } = await launchClaude(t, profile, answer);
      assert.ok(args, `${profile}: launched (${card.failureDetails})`);
      assert.equal(args.filter((arg) => arg === "--settings" || arg.startsWith("--settings=")).length, 1, `${profile}: one --settings`);
      const [settings] = settingsOf(args);
      assert.deepEqual(settings.hooks, HOOKS.hooks, `${profile}: CanvasTTY's hooks stay`);
      assert.deepEqual(settings.env, ROUTE.env);
      // Claude Code's own sandbox follows the person's Claude settings: CanvasTTY adds none.
      assert.equal(settings.sandbox, undefined);
    }
    for (const answer of [
      { args: [`--settings=${JSON.stringify({ disableAllHooks: true })}`] },
      { args: [`--settings=${JSON.stringify({ sandbox: { enabled: false } })}`] },
      { args: ["--settings", "{launchFiles}/s.json"], files: [{ relPath: "s.json", content: JSON.stringify({ hooks: {} }) }] }
    ]) {
      const { args, card } = await launchClaude(t, profile, answer);
      assert.equal(args, null, `${profile}: nothing spawned`);
      assert.match(card.failureDetails, /^Launch refused: Route .*only CanvasTTY/u);
    }
  }
});
