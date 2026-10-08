import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

// Quitting must not finish while a PTY it hung up is still running: node-pty reports the exit through a native
// callback into JavaScript, and one that lands while Electron frees the Node environment aborts the app with an
// uncaught Napi::Error. The manager waits for every exit (bounded, killing what ignores the hang-up).

const availableRegistry = {
  get: (provider) => ({ state: "available", provider, executable: "/bin/zsh", launcher: "native", environment: {}, checked: [] })
};

/** A fake PTY; `onKill(signal, exit)` decides whether (and when) a signal ends it. */
function fakePty(onKill) {
  const exits = [];
  const pty = {
    pid: 0, process: "zsh", signals: [], exited: false,
    write() {}, resize() {}, pause() {}, resume() {},
    onData() { return { dispose() {} }; },
    onExit(listener) { exits.push(listener); return { dispose() {} }; },
    kill(signal) { pty.signals.push(signal ?? "SIGHUP"); onKill(signal ?? "SIGHUP", exit); },
  };
  function exit(exitCode = 0) {
    if (pty.exited) return;
    pty.exited = true;
    for (const listener of exits) listener({ exitCode, signal: 0 });
  }
  pty.exit = exit;
  return pty;
}

function managerWith(ptys, emit = () => {}) {
  let next = 0;
  const manager = new TerminalManager(emit, availableRegistry, undefined, undefined, false, () => ptys[next++]);
  for (let i = 0; i < ptys.length; i++) manager.create({ provider: "terminal", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  return manager;
}

test("quitting waits for every hung-up PTY to exit before it resolves", async () => {
  const ptys = [0, 1, 2].map((i) => fakePty((_signal, exit) => setTimeout(() => exit(0), 20 + i * 15)));
  const manager = managerWith(ptys);
  await manager.shutdown();
  assert.deepEqual(ptys.map((pty) => pty.signals), [["SIGHUP"], ["SIGHUP"], ["SIGHUP"]]);
  assert.equal(ptys.some((pty) => pty.exited), false, "nothing has exited yet when shutdown returns");
  const started = Date.now();
  assert.equal(await manager.waitForProcessExits(5_000, 5_000), 0);
  assert.ok(ptys.every((pty) => pty.exited), "the wait ends only after the last exit");
  assert.ok(Date.now() - started < 1_000, "and does not sit out the deadline");
  assert.deepEqual(ptys.map((pty) => pty.signals), [["SIGHUP"], ["SIGHUP"], ["SIGHUP"]], "no SIGKILL when the hang-up was enough");
});

test("a PTY that ignores the hang-up is killed after the wait, and quitting waits for that exit too", async () => {
  let signals = 0;
  const stubborn = fakePty((signal, exit) => {
    signals += 1;
    if (signal === "SIGKILL" || (process.platform === "win32" && signals === 2)) setTimeout(() => exit(137), 10);
  });
  const polite = fakePty((_signal, exit) => exit(0));
  const manager = managerWith([stubborn, polite]);
  await manager.shutdown();
  assert.equal(await manager.waitForProcessExits(50, 2_000), 0);
  assert.ok(stubborn.exited);
  assert.deepEqual(stubborn.signals.slice(-1), [process.platform === "win32" ? "SIGHUP" : "SIGKILL"]);
  assert.deepEqual(polite.signals, ["SIGHUP"], "a process that already exited is not signalled again");
});

test("the wait is bounded: a PTY that never exits is reported, not waited on forever", async () => {
  const stuck = fakePty(() => {});
  const manager = managerWith([stuck]);
  await manager.shutdown();
  const started = Date.now();
  assert.equal(await manager.waitForProcessExits(30, 30), 1);
  assert.ok(Date.now() - started < 1_000);
});

test("a card closed just before quitting is waited for as well", async () => {
  let exitLater;
  const closed = fakePty((_signal, exit) => { exitLater = exit; });
  const manager = managerWith([closed]);
  const [card] = manager.list();
  manager.dispose(card.id);
  await manager.shutdown();
  let resolved = false;
  const waiting = manager.waitForProcessExits(5_000, 5_000).then((left) => { resolved = true; return left; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolved, false);
  exitLater(0);
  assert.equal(await waiting, 0);
});

test("an exit handler that throws never escapes into node-pty's native exit callback", () => {
  const pty = fakePty(() => {});
  let failEmits = false;
  const manager = managerWith([pty], () => { if (failEmits) throw new Error("Object has been destroyed"); });
  failEmits = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => pty.exit(1));
  } finally {
    console.warn = warn;
  }
  failEmits = false;
  assert.equal(manager.list()[0].exitCode, 1, "the exit is still recorded");
  manager.disposeAll();
});

test("the quit path awaits the PTY exits before the app may finish quitting", () => {
  const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const shutdown = main.slice(main.indexOf("async function shutdownServices"));
  const body = shutdown.slice(0, shutdown.indexOf("\n}\n"));
  assert.match(body, /terminalManager(?:\?\.|\.)shutdown\(\)[\s\S]*waitForProcessExits\(\)[\s\S]*await ptyExits;/u);
  assert.ok(body.indexOf("await diagnostics.flush()") > body.indexOf("await ptyExits;"));
});
