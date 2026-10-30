import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileAccessService } from "../src/main/services/FileAccessService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// Execute the production wiring: the renderer supplies a session id, never a path.
const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
const resolver = main.match(/new FileAccessService\(\{\s*resolveSessionCwd:\s*([\s\S]+?)\s*\}\);/)[1];
const filesFor = (terminalManager) => new FileAccessService({
  resolveSessionCwd: new Function("terminalManager", `return (${resolver});`)(terminalManager)
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-current-cwd-")));
  const child = join(root, "folder with spaces \u042e\u043d\u0438\u043a\u043e\u0434");
  await mkdir(child);
  await writeFile(join(root, "parent.txt"), "parent");
  await writeFile(join(child, "child.txt"), "child");
  const process = spawn(globalThis.process.execPath, ["-e", `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      process.chdir(JSON.parse(line)); process.stdout.write('changed');
    });
    process.stdout.write('ready');
  `], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(process, "exit");
  t.after(async () => { process.kill(); await exited; await rm(root, { recursive: true, force: true }); });
  await once(process.stdout, "data");
  const calls = [];
  const fake = fakeSpawner(calls);
  const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, false,
    (...args) => { const pty = fake(...args); pty.pid = process.pid; return pty; });
  t.after(() => manager.disposeAll());
  const session = manager.create({ provider: "terminal", cwd: root, profile: "normal", position: { x: 0, y: 0 } });
  const cd = async () => {
    const changed = once(process.stdout, "data");
    process.stdin.write(JSON.stringify(child) + "\n");
    await changed;
  };
  return { root, child, manager, session, calls, cd, files: filesFor(manager) };
}

test("a new Files session root uses the live cwd after cd, without changing launch metadata", {
  skip: !["darwin", "linux"].includes(process.platform), timeout: 10_000
}, async (t) => {
  const h = await fixture(t);
  const before = await h.files.registerRoot({ rootType: "session", sessionId: h.session.id });
  assert.equal(before.label, h.root.split("/").at(-1));
  await h.cd();
  const after = await h.files.registerRoot({ rootType: "session", sessionId: h.session.id });
  assert.equal(after.label, h.child.split("/").at(-1));
  assert.notEqual(after.rootId, before.rootId);
  assert.deepEqual((await h.files.list(after.rootId, "")).map(entry => entry.name), ["child.txt"]);
  assert.ok((await h.files.list(before.rootId, "")).some(entry => entry.name === "parent.txt"));
  assert.equal(h.manager.getMetadata(h.session.id).cwd, h.root, "launch/restore metadata remains immutable");
});

for (const event of ["exit", "restart", "close"]) {
  test(`a cwd lookup cannot register stale state across ${event}`, {
    skip: !["darwin", "linux"].includes(process.platform), timeout: 10_000
  }, async (t) => {
    const h = await fixture(t);
    const pending = h.files.registerRoot({ rootType: "session", sessionId: h.session.id });
    if (event === "exit") h.calls[0].process.emitExit(0);
    if (event === "restart") { h.calls[0].process.emitExit(0); h.manager.restart(h.session.id); }
    if (event === "close") h.manager.dispose(h.session.id);
    assert.equal(await pending, null);
  });
}

test("terminal output cannot choose a Files root, and failed live lookups do not fall back to launch cwd", {
  skip: !["darwin", "linux"].includes(process.platform), timeout: 10_000
}, async (t) => {
  const h = await fixture(t);
  await h.cd();
  h.calls[0].process.emitData(`\x1b]0;/untrusted/title\x07\x1b]7;file://localhost/untrusted/cwd\x07`);
  assert.equal(await h.manager.getWorkingDirectory(h.session.id), h.child);
  h.calls[0].process.pid = 2_147_483_647;
  assert.equal(await h.files.registerRoot({ rootType: "session", sessionId: h.session.id }), null);
  assert.equal(await h.manager.getWorkingDirectory("missing"), undefined);
});

test("agent and unsupported-platform sessions retain existing launch-directory behavior", async () => {
  for (const [provider, platform] of [["terminal", "win32"], ["codex", "darwin"]]) {
    const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, false, fakeSpawner([]), platform);
    const session = manager.create({ provider, cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
    assert.equal(await manager.getWorkingDirectory(session.id), process.cwd());
    manager.disposeAll();
  }
});
