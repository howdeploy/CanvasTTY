/**
 * The "auto" profile (native auto mode inside the CLI's sandbox), the launch contributor's `thirdPartyModel` mark that
 * turns it into accept-edits, Codex's per-run trust of CanvasTTY's own hooks and of the person's folder for subagents,
 * and Claude's «✳» title (idle, and the end of a declined prompt). No real CLI runs; HOME is the runner's fake one.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { normalizePersistedTerminalSessions } from "../src/main/services/TerminalSessionStore.ts";
import { coreOwnedLaunchArgument, resolveTerminalLaunch } from "../src/main/services/terminalLaunch.ts";
import { createProviderLifecycleParser } from "../src/main/services/providerLifecycle.ts";
import {
  ProviderRuntimeLaunchAdapters, codexHookTrustedHash, codexLifecycleArgs, codexTrustArguments
} from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";
import { AUTO_MODE, hasAutoMode } from "../src/shared/autoMode.ts";

const at = { x: 0, y: 0 };
const cli = (provider) => ({ state: "available", provider, executable: `/bin/${provider}`, launcher: "native", environment: {}, checked: [] });
// The launch as it is built on Linux unless a test names the platform: Claude's own sandbox exists on macOS and Linux
// only, so what auto adds depends on it (the Windows case is asserted on its own).
const launch = (provider, profile, args = [], options = {}) =>
  resolveTerminalLaunch(provider, profile, args, { providerCli: cli(provider), environment: {}, platform: "linux", ...options }).args;
const settingsOf = (args) => args.flatMap((arg, index) => args[index - 1] === "--settings" ? [JSON.parse(arg)] : []);

const waitFor = async (predicate, timeoutMs = 6_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

function registry() {
  return { get: (provider) => ({ ...cli(provider), environment: { PATH: "/usr/bin" } }), snapshot: () => ({}) };
}

function spawner(calls) {
  return (command, args, options) => {
    const data = [];
    const exits = [];
    const written = [];
    calls.push({
      command, args, options, written,
      print: (text) => data.forEach((listener) => listener(text)),
      exit: (exitCode = 0) => exits.forEach((listener) => listener({ exitCode }))
    });
    return {
      pid: 41_000 + calls.length, process: command, write(text) { written.push(text); }, resize() {}, kill() {}, pause() {}, resume() {},
      onData(listener) { data.push(listener); return { dispose() {} }; },
      onExit(listener) { exits.push(listener); return { dispose() {} }; }
    };
  };
}

function manager(t, pipeline) {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, registry(), undefined, undefined, true, spawner(calls));
  t.after(() => terminals.shutdown());
  if (pipeline) terminals.configureLaunchPipeline(pipeline);
  return { terminals, calls };
}

async function pipelineAnswering(t, answer, extra = {}) {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-auto-runs-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const requests = [];
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: "p.accounts", pluginName: "Accounts", serviceId: "svc", secrets: false,
      launch: { fields: [{ key: "on", label: "On", kind: "boolean", default: true }], delegable: true }, ...extra }],
    call: async (_pluginId, _serviceId, _method, params) => { requests.push(params); return typeof answer === "function" ? answer(params) : answer; },
    secret: async () => null,
    runsRoot,
    timeoutMs: 500
  });
  return { pipeline, requests };
}

test("auto exists only where the CLI has a native auto mode (OpenCode: a per-run permission config); normal and YOLO are unchanged", () => {
  assert.deepEqual(Object.keys(AUTO_MODE).sort(), ["claude", "codex", "grok"]);
  for (const provider of ["qwen", "kimi", "cursor", "terminal"]) assert.equal(hasAutoMode(provider), false, provider);
  assert.equal(hasAutoMode("opencode"), true);
  assert.throws(() => launch("qwen", "auto"), /qwen has no auto mode of its own; its auto runs only inside CanvasTTY's agent isolation/u);
  // A CLI without an auto mode of its own gets its approval bypass as auto, only inside the isolation layer.
  assert.deepEqual(launch("qwen", "auto", [], { isolated: true }), ["--yolo"]);
  assert.deepEqual(launch("cursor", "auto", [], { isolated: true }), ["--force"]);
  // Accept-edits and plan, where the CLI has them.
  assert.deepEqual(launch("codex", "acceptEdits"), ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
  assert.deepEqual(launch("codex", "plan"), ["--sandbox", "read-only", "--ask-for-approval", "on-request"]);
  assert.deepEqual(launch("grok", "plan"), ["--permission-mode", "plan"]);
  assert.deepEqual(launch("claude", "plan"), ["--permission-mode", "plan"]);
  assert.deepEqual(launch("cursor", "plan"), ["--mode", "plan"]);
  assert.deepEqual(launch("opencode", "plan"), ["--agent", "plan"]);
  assert.deepEqual(launch("cursor", "yolo"), ["--force"], "cursor-agent's bypass is --force");
  // Normal adds no permission flag and no sandbox.
  assert.deepEqual(launch("codex", "normal", ["-c", "x=1"]), ["--no-daemon", "-c", "x=1"]);
  assert.deepEqual(launch("claude", "normal"), []);
  assert.deepEqual(launch("codex", "yolo"), ["--dangerously-bypass-approvals-and-sandbox"]);
});

test("auto: Codex --approve-for-me (its workspace-write sandbox), Claude auto with its sandbox merged into the one --settings", () => {
  assert.deepEqual(launch("codex", "auto"), ["--approve-for-me"]);
  assert.deepEqual(launch("grok", "auto"), ["--permission-mode", "auto"]);
  const hooks = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/hook" }] }] } });
  const plugin = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" } });
  const args = launch("claude", "auto", ["--settings", hooks, "--model", "m", "--settings", plugin]);
  assert.deepEqual(args.slice(0, 2), ["--permission-mode", "auto"]);
  assert.equal(args.filter((arg) => arg === "--settings").length, 1, "Claude keeps only the last --settings");
  const [settings] = settingsOf(args);
  assert.deepEqual(settings.sandbox, { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false });
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "/hook", "CanvasTTY's hooks survive");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11434");
  // Without other settings the sandbox is its own inline --settings.
  assert.deepEqual(settingsOf(launch("claude", "auto")), [{ sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } }]);
  assert.deepEqual(settingsOf(launch("claude", "auto", [], { platform: "darwin" })), settingsOf(launch("claude", "auto")), "macOS: the same sandbox");
  // Claude Code has no sandbox on Windows: auto there is its auto mode alone.
  assert.deepEqual(launch("claude", "auto", [], { platform: "win32" }), ["--permission-mode", "auto"]);
  // Inside CanvasTTY's isolation layer Claude's own sandbox cannot start (macOS refuses a sandbox in a sandbox): left out.
  assert.deepEqual(settingsOf(launch("claude", "auto", [], { isolated: true })), []);
  assert.deepEqual(launch("claude", "auto", [], { isolated: true }), ["--permission-mode", "auto"]);
  // Codex inside the layer: its own seatbelt cannot start in ours, so it is off, never bypassed; approvals stay.
  assert.deepEqual(launch("codex", "auto", [], { isolated: true }),
    ["--sandbox", "danger-full-access", "--ask-for-approval", "on-request", "-c", 'approvals_reviewer="auto_review"']);
  assert.deepEqual(launch("codex", "normal", [], { isolated: true }), ["--sandbox", "danger-full-access", "--ask-for-approval", "on-request"]);
  assert.deepEqual(launch("codex", "acceptEdits", [], { isolated: true }), ["--sandbox", "danger-full-access", "--ask-for-approval", "on-request"]);
  assert.deepEqual(launch("codex", "auto", [], { isolated: true, thirdPartyModel: true }), ["--sandbox", "danger-full-access", "--ask-for-approval", "on-request"]);
  assert.ok(!launch("codex", "auto", [], { isolated: true }).includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.deepEqual(launch("codex", "auto"), ["--approve-for-me"], "outside the layer Codex keeps its own sandbox");
});

test("a third-party model turns auto into accept-edits, sandbox kept; other profiles ignore the mark", () => {
  assert.deepEqual(launch("codex", "auto", [], { thirdPartyModel: true }), ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
  const claude = launch("claude", "auto", [], { thirdPartyModel: true });
  assert.deepEqual(claude.slice(0, 2), ["--permission-mode", "acceptEdits"]);
  assert.equal(settingsOf(claude)[0].sandbox.enabled, true);
  assert.deepEqual(launch("grok", "auto", [], { thirdPartyModel: true }), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(launch("codex", "normal", [], { thirdPartyModel: true }), []);
});

test("plugins cannot pass auto's flags, replace Codex's hooks or their trust", () => {
  for (const argument of ["--approve-for-me", "approvals_reviewer=\"auto_review\"", "hooks.PreToolUse=[]", "hooks.state={}", "hooks={}"]) {
    assert.equal(coreOwnedLaunchArgument("codex", argument), true, argument);
  }
  assert.equal(coreOwnedLaunchArgument("codex", "model_provider=\"ollama\""), false);
  assert.equal(coreOwnedLaunchArgument("codex", "projects={\"/p\"={trust_level=\"trusted\"}}"), false);
});

test("launch arguments are judged by their flags and config keys, not by words inside a value", () => {
  // Permission-changing flags and config keys stay refused, in every spelling.
  for (const [provider, argument] of [
    ["codex", "--dangerously-bypass-approvals-and-sandbox"], ["codex", "approval_policy=\"never\""], ["codex", "sandbox_mode=danger-full-access"],
    ["codex", "--config=approval_policy=never"], ["codex", "-capproval_policy=never"], ["codex", "sandbox_workspace_write.network_access=true"],
    ["codex", "--sandbox"], ["codex", "-a"], ["codex", "exec"], ["grok", "--dangerously-skip-permissions"], ["grok", "--permission-mode"],
    ["grok", "--some-bypass-flag"], ["claude", "--allowedTools"], ["qwen", "-y"]
  ]) assert.equal(coreOwnedLaunchArgument(provider, argument), true, `${provider} ${argument}`);
  // A context plugin's rule text that mentions those words is a value, not a setting.
  const rule = "Never run with --dangerously-skip-permissions; approval_policy stays on-request and nothing may bypass the sandbox_mode.";
  for (const provider of ["codex", "grok", "claude", "qwen"]) {
    assert.equal(coreOwnedLaunchArgument(provider, rule), false, provider);
  }
  for (const argument of ["developer_instructions=\"Do not use --dangerously-bypass-approvals-and-sandbox\"", "--config=instructions=never bypass approval_policy",
    "model=\"gpt-6\"", "--rules", "Rule: approval_policy=never is not allowed here."]) {
    assert.equal(coreOwnedLaunchArgument("codex", argument), false, argument);
  }
});

test("the contribution's thirdPartyModel is checked, merged, allowed in a policy, and handed to plugins with trustedFolder", async (t) => {
  const context = { sessionId: "s", provider: "claude", profile: "auto", role: "agent", cwd: "/p", restoring: false, resume: false,
    options: { "p.accounts": { on: true } }, environment: null };
  let { pipeline } = await pipelineAnswering(t, { thirdPartyModel: true, env: { A: "1" } });
  let prepared = await pipeline.prepare(context);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.thirdPartyModel, true);
  ({ pipeline } = await pipelineAnswering(t, { env: { A: "1" } }));
  assert.equal((await pipeline.prepare(context)).thirdPartyModel, false);
  ({ pipeline } = await pipelineAnswering(t, { thirdPartyModel: "yes" }));
  prepared = await pipeline.prepare(context);
  assert.equal(prepared.ok, false);
  assert.match(prepared.reason, /thirdPartyModel must be true or false/u);
  // A policy only restricts, so it may mark the model too.
  let requests;
  ({ pipeline, requests } = await pipelineAnswering(t, { thirdPartyModel: true }, { launch: { policy: true, fields: [] } }));
  prepared = await pipeline.prepare({ ...context, options: {}, trustedFolder: "/p" });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.thirdPartyModel, true);
  assert.equal(requests[0].trustedFolder, "/p");
  assert.equal(requests[0].chosen, false);
});

test("a card launched in auto through a third-party account shows accept-edits; restore keeps auto records", async (t) => {
  const { pipeline } = await pipelineAnswering(t, (context) => context.options.on ? { thirdPartyModel: true } : null);
  const { terminals, calls } = manager(t, pipeline);
  const cwd = process.cwd();
  assert.throws(() => terminals.create({ provider: "qwen", profile: "auto", cwd, position: at }), /qwen has no auto mode/u);
  const own = terminals.create({ provider: "codex", profile: "auto", cwd, position: at });
  assert.deepEqual(calls[0].args, ["--approve-for-me"]);
  assert.equal(own.autoDowngraded, undefined);
  const account = terminals.create({ provider: "codex", profile: "auto", cwd, position: at, launchOptions: { "p.accounts": { on: true } } });
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls[1].args, ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
  assert.equal(terminals.list().find((session) => session.id === account.id).autoDowngraded, true);
  const record = { id: "11111111-1111-4111-8111-111111111111", provider: "codex", profile: "auto", title: "t", titleCustomized: false,
    cwd, position: at, size: { width: 800, height: 600 } };
  assert.equal(normalizePersistedTerminalSessions({ version: 1, sessions: [record] }).sessions[0].profile, "auto");
});

test("Codex's trusted_hash matches what codex 0.156.1 itself stored for these hooks", () => {
  // Recorded from the real CLI (fake HOME, "Trust all and continue"), then written to its config.toml.
  assert.equal(codexHookTrustedHash("session_start", { command: "/usr/bin/true", timeout: 5 }), "sha256:30eb8c150ae7bdda22b474c5d14025680e751076d673aa34989e84496d97a462");
  assert.equal(codexHookTrustedHash("stop", { command: "/usr/bin/true --stop", timeout: 5 }), "sha256:a896f6311564e5116e3ead69fc711ef312b4645c5b11a766db6508d279c8179b");
  assert.equal(codexHookTrustedHash("pre_tool_use", { command: "/usr/bin/true --pre", timeout: 30, matcher: "Bash|apply_patch" }), "sha256:39bc734257fb0a77821163e145faac1b9f6db27159aecbd4df2c7a7b533cddbf");
  assert.equal(codexHookTrustedHash("permission_request", { command: "/usr/bin/true --perm", timeout: 30, matcher: "*" }), "sha256:9230381c5f1d3961e0c099626c933550558a92240ea34db36ec99be0cabbdf6d");
});

/** Parses the inline TOML tables CanvasTTY writes into `-c` values (strings, numbers, booleans, arrays, tables). */
function tomlInline(text) {
  let out = "", index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\"") {
      let end = index + 1;
      while (text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1); index = end + 1;
    } else if (/[A-Za-z_]/u.test(char)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(text.slice(index))[0];
      out += ["true", "false"].includes(word) ? word : JSON.stringify(word); index += word.length;
    } else { out += char === "=" ? ":" : char; index += 1; }
  }
  return JSON.parse(out);
}

function codexOverrides(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c") continue;
    const [key, ...rest] = args[index + 1].split("=");
    values[key] = tomlInline(rest.join("="));
  }
  return values;
}

test("every hook CanvasTTY adds to Codex is trusted for this run, and nothing else", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-codex-hooks-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = { command: "/opt/CanvasTTY", args: ["/opt/CanvasTTY Agent/agent-runtime/hook-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const gate = { command: helper.command, args: ["/opt/CanvasTTY Agent/agent-runtime/permission-gate.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const adapters = new ProviderRuntimeLaunchAdapters({ helper, permissionGate: gate, runtimeDirectory: join(root, "runtime"),
    openCodePluginPath: join(root, "opencode-plugin.mjs"), kimiHomeDirectory: join(root, "kimi"), hermesHomeDirectory: join(root, "hermes"),
    grokHomeDirectory: join(root, "grok"), platform: "darwin", environment: {} });
  for (const [label, args] of [
    ["lifecycle + decisions", adapters.prepare("codex", "s", true, true).args],
    ["decisions only", adapters.prepare("codex", "s", false, true).args],
    ["lifecycle only", codexLifecycleArgs(helper, "linux")]
  ]) {
    const overrides = codexOverrides(args);
    const expected = {};
    for (const [key, groups] of Object.entries(overrides)) {
      if (!key.startsWith("hooks.") || key === "hooks.state") continue;
      const event = key.slice("hooks.".length).replace(/(?<=[a-z])([A-Z])/gu, "_$1").toLowerCase();
      groups.forEach((group, index) => {
        const [hook] = group.hooks;
        assert.ok(hook.command.includes("CanvasTTY Agent/agent-runtime/"), `${label}: only CanvasTTY's own helper and gate`);
        expected[`/<session-flags>/config.toml:${event}:${index}:0`] = { trusted_hash: codexHookTrustedHash(event, { command: hook.command, timeout: hook.timeout, ...(group.matcher ? { matcher: group.matcher } : {}) }) };
      });
    }
    assert.ok(Object.keys(expected).length > 0, label);
    assert.deepEqual(overrides["hooks.state"], expected, `${label}: one entry per CanvasTTY hook, none for any other source`);
    assert.equal(args.filter((arg) => arg.startsWith("hooks.state=")).length, 1);
  }
  assert.deepEqual(adapters.prepare("codex", "s", false).args, [], "without CanvasTTY hooks there is nothing to trust");
});

test("a Codex subagent in (or below) the person's orchestrator folder is trusted there for this run only", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-person-folder-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = join(root, "site"), docs = join(site, "docs"), elsewhere = join(root, "elsewhere");
  await Promise.all([mkdir(docs, { recursive: true }), mkdir(elsewhere)]);
  assert.deepEqual(codexTrustArguments(["relative", site, site]), ["-c", `projects={${JSON.stringify(site)}={trust_level="trusted"}}`]);

  const { pipeline, requests } = await pipelineAnswering(t, null);
  const { terminals, calls } = manager(t, pipeline);
  const control = new AgentControlService(terminals);
  const orchestrator = terminals.create({ provider: "claude", profile: "normal", cwd: site, position: at });
  const trust = (args) => args.filter((arg, index) => args[index - 1] === "-c" && arg.startsWith("projects="));
  control.spawn({ parentSessionId: orchestrator.id, provider: "codex", cwd: site });
  control.spawn({ parentSessionId: orchestrator.id, provider: "codex", cwd: docs });
  // A folder outside the person's folder is refused outright: no subagent works there.
  assert.throws(() => control.spawn({ parentSessionId: orchestrator.id, provider: "codex", cwd: elsewhere }), /only inside this project's folder/u);
  terminals.create({ provider: "codex", profile: "normal", cwd: site, position: at });
  assert.deepEqual(calls.slice(1).map((call) => trust(call.args)), [
    [`projects={${JSON.stringify(site)}={trust_level="trusted"}}`],
    [`projects={${JSON.stringify(docs)}={trust_level="trusted"}}`],
    []
  ]);
  // Plugins learn the folder for a subagent (a Claude account home can mark it), never for a top-level card.
  control.spawn({ parentSessionId: orchestrator.id, provider: "claude", cwd: docs, launchOptions: { "p.accounts": { on: true } } });
  terminals.create({ provider: "claude", profile: "normal", cwd: site, position: at, launchOptions: { "p.accounts": { on: true } } });
  await waitFor(() => requests.length === 2);
  assert.deepEqual(requests.map((request) => request.trustedFolder), [docs, undefined]);
});

test("Claude's «✳» title is idle, and a hooked card's title defers to its hooks except for a turn starting", async (t) => {
  const parser = createProviderLifecycleParser("claude");
  assert.equal(parser.push("\u001b]0;✳ Claude Code\u0007"), "idle");
  assert.equal(parser.push("\u001b]0;◑ Claude Code\u0007"), "working");
  assert.equal(createProviderLifecycleParser("qwen", "/p").push("\u001b]0;✳ Qwen - p\u0007"), "needs_approval", "Qwen unchanged");

  const { terminals, calls } = manager(t);
  const card = terminals.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: at });
  const status = () => terminals.list().find((session) => session.id === card.id).status;
  calls[0].print("\u001b]0;✳ Claude Code\u0007");
  assert.equal(status(), "idle", "without hooks the title's idle stands");
  terminals.applyProviderSignal(card.id, { kind: "lifecycle", state: "working" });
  terminals.applyProviderSignal(card.id, { kind: "lifecycle", state: "needs_approval" });
  calls[0].print("\u001b]0;✳ Claude Code\u0007");
  assert.equal(status(), "needs_approval", "a prompt stays until a hook moves it on");
  terminals.applyProviderSignal(card.id, { kind: "lifecycle", state: "idle" });
  calls[0].print("\u001b]0;◐ Claude Code\u0007");
  assert.equal(status(), "working", "the title still reports a turn starting");
});

test("a restarted Claude card reads its new process's title until that process's own hooks report", async (t) => {
  const { terminals, calls } = manager(t);
  const card = terminals.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: at });
  const status = () => terminals.list().find((session) => session.id === card.id).status;
  terminals.applyProviderSignal(card.id, { kind: "lifecycle", state: "needs_approval" });
  calls[0].exit(0);
  await waitFor(() => terminals.list().find((session) => session.id === card.id).exitCode !== null);
  terminals.restart(card.id);
  assert.equal(calls.length, 2);
  calls[1].print("\u001b]0;✳ Claude Code\u0007");
  assert.equal(status(), "idle", "the previous process's hooks say nothing about this one");
  terminals.applyProviderSignal(card.id, { kind: "lifecycle", state: "needs_approval" });
  calls[1].print("\u001b]0;✳ Claude Code\u0007");
  assert.equal(status(), "needs_approval", "once this process's hooks report, the title defers to them again");
});

test("a restarted card has no answer or turn from its previous conversation", async (t) => {
  const { terminals, calls } = manager(t);
  const card = terminals.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: at });
  await terminals.deliverInput(card.id, "do it\r");
  terminals.applyProviderSignal(card.id, { kind: "lifecycle", state: "working" });
  terminals.recordAnswer(card.id, { text: "the old answer", truncated: false });
  assert.deepEqual(terminals.turnProgress(card.id), { promptSent: true, turnStartedSincePrompt: true });
  calls[0].exit(0);
  await waitFor(() => terminals.list().find((session) => session.id === card.id).exitCode !== null);
  terminals.restart(card.id);
  assert.equal(terminals.answer(card.id), null, "the old conversation's answer is not this one's");
  assert.deepEqual(terminals.turnProgress(card.id), { promptSent: false, turnStartedSincePrompt: false });
});

test("a declined Claude prompt ends idle; a hook after the answer keeps its state", async (t) => {
  const { terminals, calls } = manager(t);
  const card = terminals.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: at });
  const status = () => terminals.list().find((session) => session.id === card.id).status;
  terminals.applyProviderSignal(card.id, { kind: "lifecycle", state: "needs_approval" });
  calls[0].print("\u001b]0;✳ Claude Code\u0007");
  terminals.input(card.id, "\u001b[B");
  terminals.input(card.id, "\u001b");
  assert.deepEqual(calls[0].written, ["\u001b[B", "\u001b"]);
  await waitFor(() => status() === "idle");

  // Answered, and a hook reported meanwhile (here the next prompt): the card stays where the hook put it.
  terminals.applyProviderSignal(card.id, { kind: "lifecycle", state: "needs_approval" });
  terminals.input(card.id, "1");
  terminals.applyProviderSignal(card.id, { kind: "lifecycle", state: "needs_approval" });
  await new Promise((resolve) => setTimeout(resolve, 3_300));
  assert.equal(status(), "needs_approval");
});

test("every open card is saved, not only the first 64; a broken record does not take a valid one's place", () => {
  const record = (index) => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, provider: "codex", profile: "normal", title: `t${index}`,
    titleCustomized: false, cwd: process.cwd(), position: at, size: { width: 800, height: 600 } });
  const many = Array.from({ length: 100 }, (_, index) => record(index));
  assert.equal(normalizePersistedTerminalSessions({ version: 2, sessions: many }).sessions.length, 100);
  const broken = [{ id: "nope" }, ...Array.from({ length: 64 }, (_, index) => record(index))];
  assert.equal(normalizePersistedTerminalSessions({ version: 2, sessions: broken }).sessions.length, 64);
});

test("only a builtin top-level Codex card may ask the host to persist profile trust", async (t) => {
  const { pipeline } = await pipelineAnswering(t, null);
  const { terminals } = manager(t, pipeline);
  const person = terminals.create({provider:"codex",profile:"normal",cwd:process.cwd(),position:at});
  const child = terminals.create({provider:"codex",profile:"plan",role:"subagent",parentSessionId:person.id,cwd:process.cwd(),position:at});
  const plugin = terminals.create({provider:"codex",profile:"normal",cwd:process.cwd(),position:at,launchOptions:{"p.accounts":{on:true}}});
  assert.equal(terminals.localCodexFolderForTrust(person.id),process.cwd());
  assert.equal(terminals.localCodexFolderForTrust(child.id),null);
  assert.equal(terminals.localCodexFolderForTrust(plugin.id),null,"a plugin may have selected another profile home");
  assert.equal(terminals.localCodexFolderForTrust("missing"),null);
});
