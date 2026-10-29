import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore, normalizeNestedCodex, normalizePersistedTerminalSessions } from "../src/main/services/TerminalSessionStore.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { createShellCodexWrapper, instrumentShellCodex, resumeShellCodex, shellCodexEnvironment } from "../src/main/services/shellCodexLaunch.ts";
import { planSessionRestore } from "../src/main/services/sessionRestorePlan.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const INVOCATION = "33333333-3333-4333-8333-333333333333";
const NEXT = "44444444-4444-4444-8444-444444444444";
const helper = { command: process.execPath, args: [resolve("src/agent-runtime/shell-codex.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
const cli = (executable = "/registered/codex") => ({ state: "available", provider: "codex", executable, launcher: "native", environment: {}, checked: [] });

function manager(directory, calls, enabled = true) {
  const runtime = {
    prepareShellLaunch() { return { args: [], environment: {}, shellCodexWrapper: join(directory, "codex wrapper"), cleanup() {} }; },
    currentStatus() { return null; }
  };
  const instance = new TerminalManager(() => {}, { get: () => cli() }, undefined, runtime, enabled, (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return { pid: calls.length + 100, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; }, onExit(listener) { call.exit = listener; return { dispose() {} }; } };
  });
  instance.configureSessionPersistence(new TerminalSessionStore(directory), "continue");
  return instance;
}

async function resumedCommand(call) {
  const rc = call.args.indexOf("--rcfile");
  if (rc !== -1) return readFile(call.args[rc + 1], "utf8");
  if (call.options.env.ZDOTDIR) return readFile(join(call.options.env.ZDOTDIR, ".zlogin"), "utf8");
  return call.args.join(" ");
}

test("a shell remembers only exact scoped Codex identity, ignores stale ends, and resumes its own cwd in the same card", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-nested-"));
  const cwd = join(directory, "папка ' $(literal) & space");
  await mkdir(cwd);
  try {
    const initial = manager(directory, [], false);
    await initial.restorePersistedSessions();
    const card = initial.create({ provider: "terminal", profile: "normal", cwd: directory, position: { x: 0, y: 0 } });
    initial.applyShellCodexSignal(card.id, { event: "ShellCodexStart", invocationId: INVOCATION, cwd });
    initial.applyShellCodexSignal(card.id, { event: "SessionStart", invocationId: INVOCATION, threadId: OTHER, cwd });
    initial.applyShellCodexSignal(card.id, { event: "ShellCodexStart", invocationId: NEXT, cwd });
    initial.applyShellCodexSignal(card.id, { event: "SessionStart", invocationId: NEXT, threadId: THREAD, cwd });
    initial.applyShellCodexSignal(card.id, { event: "SessionEnd", invocationId: INVOCATION, cwd });
    initial.applyShellCodexSignal(card.id, { event: "Stop", invocationId: INVOCATION, threadId: OTHER, cwd });
    await initial.shutdown();
    const saved = JSON.parse(await readFile(join(directory, "terminal-sessions.json"), "utf8"));
    assert.deepEqual(saved.sessions[0].nestedCodex, { threadId: THREAD, cwd });
    assert.equal(saved.sessions[0].provider, "terminal");
    assert.equal(saved.sessions[0].threadId, undefined);
    const calls = [];
    const restored = manager(directory, calls);
    await restored.restorePersistedSessions();
    assert.equal(restored.list()[0].id, card.id);
    assert.equal(restored.list()[0].provider, "terminal");
    assert.equal(calls[0].options.cwd, cwd);
    assert.match(await resumedCommand(calls[0]), new RegExp(`resume '${THREAD}'`));
    assert.ok(!calls[0].args.includes("-c"), "the original interactive shell stays alive after the saved Codex exits");
    assert.doesNotMatch(await resumedCommand(calls[0]), /--last|--continue/);
    calls[0].exit({ exitCode: 1 });
    restored.restart(card.id, { resume: true });
    assert.match(await resumedCommand(calls[1]), new RegExp(THREAD));
    calls[1].exit({ exitCode: 1 });
    restored.restart(card.id);
    assert.ok(!calls[2].args.includes("-c"));
    await restored.shutdown();
    assert.equal(JSON.parse(await readFile(join(directory, "terminal-sessions.json"), "utf8")).sessions[0].nestedCodex, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ending a nested Codex clears its descriptor; unknown IDs never guess a folder's latest session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-nested-end-"));
  try {
    const initial = manager(directory, []);
    const card = initial.create({ provider: "terminal", profile: "normal", cwd: directory, position: { x: 0, y: 0 } });
    initial.applyShellCodexSignal(card.id, { event: "ShellCodexStart", invocationId: INVOCATION, cwd: directory });
    initial.applyShellCodexSignal(card.id, { event: "SessionStart", invocationId: INVOCATION, threadId: THREAD, cwd: directory });
    initial.applyShellCodexSignal(card.id, { event: "ShellCodexEnd", invocationId: INVOCATION });
    initial.applyShellCodexSignal(card.id, { event: "Stop", invocationId: INVOCATION, threadId: THREAD, cwd: directory });
    await initial.shutdown();
    const calls = [];
    const restored = manager(directory, calls);
    await restored.restorePersistedSessions();
    assert.ok(!calls[0].args.includes("-c"));
    restored.applyShellCodexSignal(card.id, { event: "ShellCodexStart", invocationId: NEXT, cwd: directory });
    restored.applyShellCodexSignal(card.id, { event: "SessionStart", invocationId: NEXT, threadId: "unknown", cwd: directory });
    await restored.shutdown();
    const saved = JSON.parse(await readFile(join(directory, "terminal-sessions.json"), "utf8"));
    assert.equal(saved.sessions[0].nestedCodex, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("nested restore metadata is validated and Reopen never continues it", () => {
  assert.equal(normalizeNestedCodex({ threadId: THREAD, cwd: "relative" }), undefined);
  assert.equal(normalizeNestedCodex({ threadId: THREAD + ";x", cwd: "/tmp" }), undefined);
  assert.equal(normalizeNestedCodex({ threadId: THREAD, cwd: "/tmp\nunsafe" }), undefined);
  assert.deepEqual(normalizeNestedCodex({ threadId: THREAD, cwd: "C:\\папка" }), { threadId: THREAD, cwd: "C:\\папка" });
  const raw = { id: "shell", provider: "terminal", profile: "normal", title: "Terminal", titleCustomized: false,
    cwd: "/tmp", position: { x: 0, y: 0 }, size: { width: 700, height: 430 }, nestedCodex: { threadId: THREAD, cwd: "/tmp" } };
  const records = normalizePersistedTerminalSessions({ version: 2, sessions: [raw] }).sessions;
  const context = { isLiveSession: () => false, environmentAvailable: () => true };
  assert.deepEqual(planSessionRestore(records, "continue", context)[0].shellResume, raw.nestedCodex);
  assert.equal(planSessionRestore(records, "reopen", context)[0].shellResume, undefined);
  assert.equal(normalizePersistedTerminalSessions({ version: 2, sessions: [{ ...raw, provider: "codex" }] }).sessions[0].nestedCodex, undefined);
});

test("Windows shell wrappers keep registered batch resolution and quoted exact resume arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-win-wrapper-"));
  let wrapper;
  try {
    wrapper = createShellCodexWrapper({ directory, helper: { command: "C:\\Canvas App\\CanvasTTY.exe", args: ["C:\\Canvas App\\shell-codex.mjs"] },
      cli: { ...cli("C:\\npm\\codex.cmd"), launcher: "batch", commandPrompt: "C:\\Windows\\System32\\cmd.exe" }, hooks: [], environment: {}, platform: "win32" });
    assert.match(await readFile(wrapper.wrapper, "utf8"), /"C:\\Canvas App\\CanvasTTY\.exe" "C:\\Canvas App\\shell-codex\.mjs"/);
    assert.match(await readFile(wrapper.wrapper, "utf8"), /%\*\r\n$/);
    const env = shellCodexEnvironment({ Path: "C:\\real", PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "C:\\wrapper", "win32");
    assert.equal(env.Path, "C:\\wrapper;C:\\real");
    const resumed = resumeShellCodex({ command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-NoLogo", "-NoProfile"] }, "C:\\папка ' x\\codex.cmd", { threadId: THREAD, cwd: "C:\\папка" }, "win32");
    assert.equal(resumed.args.at(-2), "-Command");
    assert.match(resumed.args.at(-1), /папка '' x/);
    assert.ok(resumed.args.includes("-NoExit"));
    const cmd = resumeShellCodex({ command: "C:\\Windows\\System32\\cmd.exe", args: ["/d"] }, "C:\\wrapper\\codex.cmd", { threadId: THREAD, cwd: "C:\\project" }, "win32");
    assert.equal(cmd.args[2], "/k");
    assert.ok(cmd.args.at(-1).includes(THREAD));
  } finally { wrapper?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

for (const shell of ["bash", "zsh"]) test(`${shell} installs the observer after login rc files replace PATH`, { skip: process.platform === "win32" }, async (t) => {
  try { await access(`/bin/${shell}`); } catch { t.skip(`${shell} is not installed`); return; }
  const directory = await mkdtemp(join(tmpdir(), "canvastty-shell-rc-"));
  let wrapper;
  try {
    const home = join(directory, "home");
    await mkdir(home);
    const reset = `export PATH=/usr/bin:/bin\nexport LOGIN_RC_RAN=yes\n`;
    for (const file of shell === "bash" ? [".bash_profile"] : [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) await writeFile(join(home, file), reset);
    const output = join(directory, "called");
    const executable = join(directory, "registered-codex");
    await writeFile(executable, `#!/bin/sh\nprintf '%s' "$1:$LOGIN_RC_RAN:$ZDOTDIR" > "$TEST_OUTPUT"\n`, { mode: 0o700 });
    wrapper = createShellCodexWrapper({ directory, helper, cli: { ...cli(executable), environment: { TEST_OUTPUT: output } }, hooks: [], environment: {} });
    const environment = { ...process.env, HOME: home };
    delete environment.ZDOTDIR;
    const launch = instrumentShellCodex({ command: `/bin/${shell}`, args: ["-l"] }, wrapper.wrapper, environment);
    const child = spawn(launch.command, [...launch.args, ...(shell === "zsh" ? ["-i"] : []), "-c", "codex resume 11111111-1111-4111-8111-111111111111"],
      { env: { ...environment, ...shellCodexEnvironment(environment, wrapper.directory), ...launch.environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => stderr += data);
    const status = await new Promise((resolveStatus, reject) => { child.once("error", reject); child.once("close", resolveStatus); });
    assert.equal(status, 0, stderr);
    assert.equal(await readFile(output, "utf8"), `--no-daemon:yes:${shell === "zsh" ? home : ""}`);
    for (const file of shell === "bash" ? [".bash_profile"] : [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) assert.equal(await readFile(join(home, file), "utf8"), reset);
  } finally { wrapper?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

for (const shell of ["bash", "zsh"]) test(`${shell} resumes once, reads the profile once and keeps the same interactive shell`, { skip: process.platform === "win32" }, async (t) => {
  try { await access(`/bin/${shell}`); } catch { t.skip(`${shell} is not installed`); return; }
  const directory = await mkdtemp(join(tmpdir(), "canvastty-resume-rc-"));
  try {
    const home = join(directory, "home");
    const privateDirectory = join(directory, "private wrapper ' literal");
    await mkdir(home);
    await mkdir(privateDirectory);
    const count = join(directory, "profile-count");
    const initialCount = join(directory, "profile-count-at-first-prompt");
    const before = join(directory, "shell-before");
    const after = join(directory, "shell-after");
    const argv = join(directory, "codex-argv");
    const wrapper = join(privateDirectory, "codex");
    await writeFile(wrapper, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$QA_ARGV"\nexit 0\n', { mode: 0o700 });
    await writeFile(join(home, shell === "bash" ? ".bash_profile" : ".zprofile"),
      'printf "profile\\n" >> "$QA_COUNT"\nif [ ! -f "$QA_BEFORE" ]; then printf "%s" "$$" > "$QA_BEFORE"; fi\nexport QA_PROFILE_VALUE=retained\n');
    const environment = { PATH: "/usr/bin:/bin", HOME: home, TERM: "xterm-256color", QA_ARGV: argv,
      QA_COUNT: count, QA_INITIAL_COUNT: initialCount, QA_BEFORE: before, QA_AFTER: after };
    const instrumented = instrumentShellCodex({ command: `/bin/${shell}`, args: ["-l", "-i"] }, wrapper, environment);
    const launch = resumeShellCodex(instrumented, wrapper, { threadId: THREAD, cwd: directory });
    const child = spawn(launch.command, launch.args, { cwd: directory,
      env: { ...environment, ...launch.environment }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.stdout.resume();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdin.end('printf "%s:%s" "$QA_PROFILE_VALUE" "$$" > "$QA_AFTER"\ncp "$QA_COUNT" "$QA_INITIAL_COUNT"\n'
      + (shell === "zsh" ? '/bin/zsh -l -i -c exit\n' : '') + 'exit\n');
    let status;
    try { status = await new Promise((yes, no) => { child.once("error", no); child.once("close", yes); }); }
    finally { clearTimeout(timeout); }
    assert.equal(status, 0, stderr);
    assert.equal(await readFile(initialCount, "utf8"), "profile\n", "restore startup side effects run exactly once");
    assert.equal(await readFile(count, "utf8"), shell === "zsh" ? "profile\nprofile\n" : "profile\n");
    assert.equal(await readFile(after, "utf8"), `retained:${await readFile(before, "utf8")}`, "the original shell reaches its prompt with profile state intact");
    assert.equal(await readFile(argv, "utf8"), `resume\n${THREAD}\n`, "the exact conversation is resumed once");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Fish resumes through its init-command and unsupported shells refuse instead of repeating startup", () => {
  const environment = { PATH: "/bin", HOME: "/home/example" };
  const wrapper = "/private/codex";
  const nested = { threadId: THREAD, cwd: "/project" };
  const fish = instrumentShellCodex({ command: "/bin/fish", args: ["-l"] }, wrapper, environment, "linux");
  const resumed = resumeShellCodex(fish, wrapper, nested, "linux");
  assert.deepEqual(resumed.args.slice(-2), ["--init-command", `'${wrapper}' resume '${THREAD}'`]);
  assert.ok(!resumed.args.includes("-c"));
  assert.throws(() => resumeShellCodex({ command: "/bin/sh", args: ["-l"] }, wrapper, nested, "linux"), /no private interactive shell startup/);
});

test("the real scoped wrapper forwards Unicode and shell-looking argv literally and reports lifecycle without a real agent", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-shell-wire-"));
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: join(directory, "gateway"), onSignal: (id, signal) => signals.push({ id, ...signal }) });
  let prepared;
  try {
    await gateway.start();
    const cwd = join(directory, "папка ' пробел");
    await mkdir(cwd);
    const fake = join(directory, "fake-codex");
    const output = join(directory, "argv.json");
    const hook = resolve("src/agent-runtime/hook-helper.mjs");
    await writeFile(fake, `#!/usr/bin/env node\n(async()=>{const fs=await import('node:fs'); const {spawn}=await import('node:child_process'); fs.writeFileSync(process.env.TEST_OUTPUT,JSON.stringify({args:process.argv.slice(2),path:process.env.PATH,cwd:process.cwd(),electronNode:process.env.ELECTRON_RUN_AS_NODE})); const child=spawn(process.execPath,[${JSON.stringify(hook)},'idle','SessionStart'],{stdio:['pipe','inherit','inherit']}); child.stdin.end(JSON.stringify({session_id:${JSON.stringify(THREAD)},cwd:process.cwd()})); await new Promise((yes,no)=>{child.once('error',no);child.once('close',(code)=>code===0?yes():no(new Error('hook failed')));});})().catch(()=>process.exitCode=1);\n`, { mode: 0o700 });
    const bridge = new AgentRuntimeBridge(gateway, { runtimeDirectory: directory, helper: { command: process.execPath, args: [resolve("src/agent-runtime/hook-helper.mjs")] },
      openCodePluginPath: resolve("src/agent-runtime/opencode-plugin.mjs"), shellCodexHelper: helper, coreHooksEnabled: false });
    const registered = { ...cli(fake), environment: { TEST_OUTPUT: output } };
    prepared = bridge.prepareShellLaunch({ terminalSessionId: "shell", cli: registered, environment: process.env });
    assert.equal(prepared.decisions, undefined);
    assert.equal(prepared.environment.CANVASTTY_RUNTIME_CAPABILITY, undefined, "the ordinary shell never gets the capability");
    const userArgs = ["resume", THREAD, "--", "кириллица ' $(touch literal) & \"quote\"", "tail\\"];
    const child = spawn(prepared.shellCodexWrapper, userArgs, { cwd, env: { ...process.env, ...prepared.environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => stderr += data);
    const status = await new Promise((resolveStatus, reject) => { child.once("error", reject); child.once("close", resolveStatus); });
    assert.equal(status, 0, stderr);
    const seen = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(seen.args.slice(-userArgs.length), userArgs);
    assert.equal(seen.electronNode, undefined, "helper-only flags never reach Codex or its tools");
    assert.ok(!seen.path.includes(join(directory, "shell-codex-")), "child tools cannot re-enter the observer");
    assert.equal(signals[0].event, "ShellCodexStart");
    assert.ok(signals.find((signal) => signal.event === "SessionStart" && signal.threadId === THREAD && signal.cwd === cwd));
    assert.equal(signals.at(-1).event, "ShellCodexEnd");
    assert.equal(new Set(signals.map((signal) => signal.invocationId)).size, 1);
    const recipePath = join(prepared.shellCodexWrapper, "..", "launch.json");
    assert.equal((await stat(recipePath)).mode & 0o777, 0o600);
  } finally { prepared?.cleanup(); await gateway.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unused shell observers never consume ordinary agent runtime slots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-shell-slots-"));
  const gateway = new RuntimeGateway({ runtimeDirectory: directory });
  try {
    await gateway.start();
    for (let index = 0; index < 40; index += 1) gateway.registerSession(`shell-${index}`, "codex", false, undefined, false, undefined, true);
    for (let index = 0; index < 32; index += 1) gateway.registerSession(`agent-${index}`, "codex");
    assert.throws(() => gateway.registerSession("agent-overflow", "codex"), /at most 32/);
  } finally { await gateway.close(); await rm(directory, { recursive: true, force: true }); }
});
