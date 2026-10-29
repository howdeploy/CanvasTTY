import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { TerminalManager, MAX_UNPARSED_OUTPUT_CHARS } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const dependencyRoot = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));

// Exercise the dependency's actual callbacks without loading an addon, opening
// a PTY, or replacing process.platform in this test process.
async function callbacks(extension) {
  const source = await readFile(join(dependencyRoot, extension === "ts" ? "src" : "lib", `unixTerminal.${extension}`), "utf8");
  const start = source.indexOf(extension === "ts" ? "const onexit =" : "var onexit =");
  const end = source.indexOf("// fork", start);
  const killStart = source.indexOf(extension === "ts" ? "public kill(" : "UnixTerminal.prototype.kill = function (");
  const killEnd = source.indexOf(extension === "ts" ? "/**" : 'Object.defineProperty(UnixTerminal.prototype, "process"', killStart);
  assert.ok(start >= 0 && end > start && killStart > end && killEnd > killStart);
  let kill = source.slice(killStart, killEnd).trim();
  kill = extension === "ts" ? kill.replace("public kill(", "function kill(") : kill.replace("UnixTerminal.prototype.kill = ", "");
  // Only remove the compiled method's statement delimiter, not its body.
  if (extension === "js") kill = kill.replace(/;$/u, "");
  let wrapper = `(function () { const _this = this; ${source.slice(start, end)} return { onexit, kill: ${kill} }; })`;
  if (extension === "ts") wrapper = stripTypeScriptTypes(wrapper);
  return wrapper;
}

function fixture(wrapper, platform, paused = true) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const events = [];
  const terminal = new EventEmitter();
  const socket = new EventEmitter();
  terminal._socket = socket;
  terminal.pid = 12345;
  terminal._emittedClose = false;
  socket.paused = paused;
  socket.destroyedCount = 0;
  socket.isPaused = () => socket.paused;
  socket.pause = () => { socket.paused = true; };
  socket.resume = () => {
    events.push("resume");
    socket.paused = false;
    socket.emit("resume");
  };
  const close = () => {
    if (terminal._emittedClose) return;
    terminal._emittedClose = true;
    terminal.emit("close");
  };
  socket.destroy = () => { socket.destroyedCount++; close(); };
  let killError;
  const build = runInNewContext(wrapper, {
    process: { platform, kill(pid, signal) { events.push([pid, signal]); if (killError) throw killError; } },
    DESTROY_SOCKET_TIMEOUT_MS: 200,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  }, { timeout: 1000 });
  const actual = build.call(terminal);
  const exits = [];
  terminal.on("exit", (code, signal) => exits.push({ code, signal }));
  function tick(ms) {
    const target = now + ms;
    for (let count = 0; count < 1000; count++) {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > target) { now = target; return; }
      now = first[1].at;
      timers.delete(first[0]);
      first[1].fn();
    }
    assert.fail("callback unexpectedly rescheduled forever");
  }
  return { terminal, socket, timers, events, exits, tick, close,
    onexit: actual.onexit, kill: signal => actual.kill.call(terminal, signal),
    setKillError: error => { killError = error; } };
}

for (const extension of ["ts", "js"]) {
  const wrapper = await callbacks(extension);

  test(`${extension}: macOS paused exit waits for resume, then retains the bounded fallback`, () => {
    const f = fixture(wrapper, "darwin");
    f.onexit(7, 9);
    f.onexit(7, 9); // A duplicate native notification cannot install another watcher.
    f.tick(10_000);
    assert.equal(f.socket.destroyedCount, 0);
    assert.deepEqual(f.exits, []);
    assert.equal(f.timers.size, 0);
    assert.equal(f.socket.listenerCount("resume"), 1);
    f.socket.resume();
    assert.equal(f.socket.listenerCount("resume"), 0);
    f.tick(199);
    assert.deepEqual(f.exits, []);
    f.tick(1);
    assert.equal(f.socket.destroyedCount, 1);
    assert.deepEqual(f.exits, [{ code: 7, signal: 9 }]);
    assert.equal(f.timers.size, 0);
  });

  test(`${extension}: macOS pauses again during the grace period without losing the unread tail`, () => {
    const f = fixture(wrapper, "darwin", false);
    f.onexit(0, 0);
    f.tick(100);
    f.socket.pause();
    f.tick(10_000);
    assert.equal(f.socket.destroyedCount, 0);
    assert.equal(f.socket.listenerCount("resume"), 1);
    f.socket.resume();
    f.tick(199);
    assert.deepEqual(f.exits, []);
    f.close(); // The resumed stream drained naturally before the fallback.
    assert.deepEqual(f.exits, [{ code: 0, signal: 0 }]);
    assert.equal(f.timers.size, 0);
    assert.equal(f.socket.listenerCount("resume"), 0);
    f.tick(10_000);
    assert.equal(f.socket.destroyedCount, 0);
  });

  test(`${extension}: closing a paused socket removes the deferred resume listener`, () => {
    const f = fixture(wrapper, "darwin");
    f.onexit(0, 0);
    f.close();
    assert.equal(f.socket.listenerCount("resume"), 0);
    f.socket.resume();
    f.tick(10_000);
    assert.equal(f.socket.destroyedCount, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.exits.length, 1);
  });

  for (const platform of ["darwin", "linux", "freebsd"]) {
    test(`${extension}: ${platform} keeps its 200ms fallback when ${platform === "darwin" ? "unpaused" : "paused"}`, () => {
      const f = fixture(wrapper, platform, platform !== "darwin");
      f.onexit(0, 0);
      f.tick(199);
      assert.equal(f.socket.destroyedCount, 0);
      f.tick(1);
      assert.equal(f.socket.destroyedCount, 1);
      assert.equal(f.exits.length, 1);
      assert.equal(f.socket.listenerCount("resume"), 0);
    });

    test(`${extension}: ${platform} kill ${platform === "darwin" ? "resumes before signalling" : "preserves the paused stream"}`, () => {
      const f = fixture(wrapper, platform);
      f.onexit(0, 0); // The OS child already exited; only native cleanup remains.
      f.setKillError(Object.assign(new Error("already dead"), { code: "ESRCH" }));
      f.kill();
      assert.deepEqual(f.events, platform === "darwin" ? ["resume", [12345, "SIGHUP"]] : [[12345, "SIGHUP"]]);
      f.tick(200);
      assert.equal(f.exits.length, 1);
      assert.equal(f.socket.listenerCount("resume"), 0);
    });
  }

  test(`${extension}: a failed macOS stream resume cannot suppress the requested signal`, () => {
    const f = fixture(wrapper, "darwin");
    f.socket.resume = () => { throw Error("closed stream"); };
    f.kill("SIGKILL");
    assert.deepEqual(f.events, [[12345, "SIGKILL"]]);
  });

  test(`${extension}: a socket that closed before native exit reports exit immediately`, () => {
    const f = fixture(wrapper, "darwin");
    f.close();
    f.onexit(0, 0);
    assert.deepEqual(f.exits, [{ code: 0, signal: 0 }]);
    assert.equal(f.timers.size, 0);
    assert.equal(f.socket.listenerCount("resume"), 0);
  });

  for (const action of ["close", "restart", "quit"]) test(`${extension}: manager ${action} releases its paused native exit watcher`, async (t) => {
    const calls = [];
    const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, false, fakeSpawner(calls), "darwin");
    t.after(() => { for (const call of calls) call.process.emitExit(0); manager.disposeAll(); });
    const { id } = manager.create({ provider: "terminal", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
    const f = fixture(wrapper, "darwin", false);
    const pty = calls[0].process;
    pty.pause = f.socket.pause;
    pty.resume = f.socket.resume;
    pty.kill = f.kill;
    f.terminal.on("exit", code => pty.emitExit(code));
    pty.emitData("x".repeat(MAX_UNPARSED_OUTPUT_CHARS));
    assert.equal(f.socket.paused, true);
    f.onexit(0, 0);
    if (action === "close") manager.dispose(id);
    else if (action === "quit") await manager.shutdown();
    else {
      // Restart is offered only after onExit: consuming renderer credit makes
      // the finished card restartable, then its next launch has no old pause.
      assert.throws(() => manager.restart(id), /still running/u);
      manager.acknowledgeOutput(id, manager.outputOffset(id));
    }
    f.tick(200);
    assert.equal(await manager.waitForProcessExits(100, 100), 0);
    assert.equal(f.socket.listenerCount("resume"), 0);
    assert.equal(f.timers.size, 0);
    if (action === "restart") {
      manager.restart(id);
      assert.equal(calls.length, 2);
      assert.equal(manager.sessions.get(id).outputPausedProcess, undefined);
      assert.equal(manager.liveProcesses.size, 1, "only the replacement PTY remains live");
    } else assert.equal(manager.sessions.size, 0);
  });
}
