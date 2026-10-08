import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../src/agent-runtime/plugin-hook-runner.mjs", import.meta.url));

test("plugin hook runner correlates the CanvasTTY session and strips host capabilities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-plugin-hook-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginRoot = join(root, "plugin");
  const entry = join(pluginRoot, "hook.mjs");
  const output = join(root, "hook-output.json");
  const registry = join(root, "plugin-hooks.json");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(entry, `
    import { readFileSync, writeFileSync } from "node:fs";
    const input = JSON.parse(readFileSync(0, "utf8"));
    writeFileSync(process.env.CANVASTTY_TEST_HOOK_OUTPUT, JSON.stringify({
      input,
      environment: {
        terminalSessionId: process.env.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID ?? null,
        capability: process.env.CANVASTTY_RUNTIME_CAPABILITY ?? null
      }
    }));
  `);
  await writeFile(registry, JSON.stringify({
    version: 1,
    hooks: {
      "com.example.audit:audit": {
        pluginId: "com.example.audit",
        hookId: "audit",
        root: pluginRoot,
        entry: "hook.mjs",
        providers: ["codex"],
        events: ["prompt-submit"]
      }
    }
  }));

  const result = runHook(registry, output, JSON.stringify({ prompt: "local payload" }));
  assert.equal(result.status, 0, result.stderr);
  const received = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(received.input, {
    apiVersion: 1,
    pluginId: "com.example.audit",
    hookId: "audit",
    terminalSessionId: "terminal-session-one",
    provider: "codex",
    event: "prompt-submit",
    providerEvent: "UserPromptSubmit",
    payload: { prompt: "local payload" }
  });
  assert.deepEqual(received.environment, {
    terminalSessionId: "terminal-session-one",
    capability: null
  });

  await writeFile(registry, JSON.stringify({ version: 1, hooks: {} }));
  await rm(output);
  const revoked = runHook(registry, output, "{}");
  assert.equal(revoked.status, 0, revoked.stderr);
  await assert.rejects(readFile(output, "utf8"), /ENOENT/u);
});

function runHook(registry, output, input) {
  return spawnSync(process.execPath, [
    runner,
    registry,
    "com.example.audit:audit",
    "codex",
    "prompt-submit",
    "UserPromptSubmit"
  ], {
    env: {
      ...process.env,
      CANVASTTY_TEST_HOOK_OUTPUT: output,
      CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID: "terminal-session-one",
      CANVASTTY_RUNTIME_CAPABILITY: "must-not-reach-plugin"
    },
    input,
    encoding: "utf8"
  });
}

test("OpenCode runs each plugin hook as one process per event, not a runner process that starts another", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-opencode-hooks-"));
  // The hook processes start in the plugin folder and may still be exiting after
  // writing their files; Windows refuses to remove a folder a live process sits in.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const pluginRoot = join(root, "plugin");
  const registry = join(root, "plugin-hooks.json");
  const runnerCalls = join(root, "runner-calls");
  const fakeRunner = join(root, "runner.mjs");
  await mkdir(pluginRoot, { recursive: true });
  for (const id of ["one", "two"]) {
    await writeFile(join(pluginRoot, `${id}.mjs`), `
      import { readFileSync, writeFileSync } from "node:fs";
      const input = JSON.parse(readFileSync(0, "utf8"));
      writeFileSync(${JSON.stringify(join(root, `${id}.json`))}, JSON.stringify({ input, session: process.env.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID, capability: process.env.CANVASTTY_RUNTIME_CAPABILITY ?? null }));
    `);
  }
  // Only counts: a hook that ran through it would not have written its file.
  await writeFile(fakeRunner, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(runnerCalls)}, "x");`);
  const hook = (id) => ({ pluginId: "com.example.audit", hookId: id, root: pluginRoot, entry: `${id}.mjs`, providers: ["opencode"], events: ["after-tool"] });
  await writeFile(registry, JSON.stringify({ version: 1, hooks: { "com.example.audit:one": hook("one"), "com.example.audit:two": hook("two") } }));
  const names = ["CANVASTTY_LIFECYCLE_HOOKS_ENABLED", "CANVASTTY_PLUGIN_HOOK_REGISTRY", "CANVASTTY_PLUGIN_HOOK_RUNNER_COMMAND", "CANVASTTY_PLUGIN_HOOK_RUNNER",
    "CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID", "CANVASTTY_PLUGIN_HOOK_SESSION", "CANVASTTY_RUNTIME_CAPABILITY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, {
    CANVASTTY_LIFECYCLE_HOOKS_ENABLED: "0",
    CANVASTTY_PLUGIN_HOOK_REGISTRY: registry,
    CANVASTTY_PLUGIN_HOOK_RUNNER_COMMAND: process.execPath,
    CANVASTTY_PLUGIN_HOOK_RUNNER: fakeRunner,
    CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID: "terminal-opencode",
    CANVASTTY_PLUGIN_HOOK_SESSION: JSON.stringify([{ key: "com.example.audit:one", events: ["after-tool"] }, { key: "com.example.audit:two", events: ["after-tool"] }]),
    CANVASTTY_RUNTIME_CAPABILITY: "must-not-reach-plugin"
  });
  const { CanvasTTYLifecycle } = await import("../src/agent-runtime/opencode-plugin.mjs?plugin-hook-processes");
  const plugin = await CanvasTTYLifecycle();
  await plugin.event({ event: { type: "session.created", properties: { info: { id: "opencode-root" } } } });
  await plugin.event({ event: { type: "session.status", properties: { sessionID: "opencode-root", status: {type:"busy"} } } });
  const hookInput={sessionID:"opencode-root",callID:"call",tool:"bash"};
  await plugin["tool.execute.before"](hookInput,{args:{command:"private-command"}});
  await plugin["tool.execute.after"]({...hookInput,args:{command:"private-command"}}, {title:"secret title",output:"secret output",metadata:{exit:0}});
  const read = async (path) => { try { return await readFile(path, "utf8"); } catch { return null; } };
  for (let i = 0; i < 200 && (!(await read(join(root, "one.json"))) || !(await read(join(root, "two.json")))); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const id of ["one", "two"]) {
    const received = JSON.parse(await read(join(root, `${id}.json`)) ?? "null");
    assert.ok(received, `${id} ran`);
    assert.equal(received.input.hookId, id);
    assert.equal(received.input.provider, "opencode");
    assert.equal(received.input.event, "after-tool");
    assert.equal(received.session, "terminal-opencode");
    assert.equal(received.capability, null, "host capabilities stay out");
    assert.equal(received.input.payload.input.args.command,"private-command","explicit native hook permission retains provider payload");
    assert.equal(received.input.payload.output.output,"secret output");
    assert.ok(!JSON.stringify(received).includes("normalizedActionHash"),"no host-generated fingerprint added to provider payload");
  }
  assert.equal(await read(runnerCalls), null, "no runner process in between");
});
