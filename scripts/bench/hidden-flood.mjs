// What hidden terminal cards cost while their agents flood output: the real TerminalManager with fake PTYs, and
// for each card the renderer's real attachTerminalOutput feeding an @xterm/headless terminal (the same parser the
// card's xterm runs; no DOM, no WebGL, no Electron IPC). One process, so CPU is main-side work plus parsing.
//
//   node --experimental-strip-types scripts/bench/hidden-flood.mjs [cards=5] [seconds=10] [kbPerSecond=256] [runs=3]
//
// Modes: `visible` (cards streamed as usual), `ring-only` (hidden cards get nothing until shown, then a replay cut to
// the 240 000-character ring: the behaviour before the whole-stream fix, which can leave the card's terminal in the
// wrong state), `whole` (hidden cards get what they missed in ring-sized pieces before the ring would drop it).
import xterm from "@xterm/headless";
import { TerminalManager, reachesRenderer } from "../../src/main/services/TerminalManager.ts";
import { attachTerminalOutput } from "../../src/renderer/src/features/terminal/terminalOutput.ts";
import { IPC } from "../../src/shared/contracts.ts";

const [cards = 5, seconds = 10, kbPerSecond = 256, runs = 3] = process.argv.slice(2).map(Number);
const TICK_MS = 16;
const registry = { get: (provider) => ({ state: "available", provider, executable: "/bin/sh", launcher: "native", environment: {}, checked: [] }) };

async function run(mode) {
  const listeners = new Set();
  let events = 0;
  let bytes = 0;
  const spawners = [];
  const manager = new TerminalManager((channel, event) => {
    if (channel !== IPC.terminalData || !reachesRenderer(event)) return;
    events += 1;
    bytes += event.data.length;
    for (const listener of listeners) listener(event);
  }, registry, undefined, undefined, true, () => {
    const pty = { pid: 1, process: "sh", kill() {}, write() {}, resize() {}, onExit() { return { dispose() {} }; },
      onData(listener) { pty.emit = listener; return { dispose() {} }; } };
    spawners.push(pty);
    return pty;
  });
  if (mode === "ring-only") manager.keepHiddenCardWhole = () => undefined;
  const terminals = [];
  const pending = [];
  for (let index = 0; index < cards; index++) {
    const { id } = manager.create({ provider: "terminal", cwd: process.cwd(), profile: "normal", position: { x: index * 800, y: 0 } });
    const terminal = new xterm.Terminal({ cols: 120, rows: 40, scrollback: 1_000, allowProposedApi: true });
    terminals.push(terminal);
    attachTerminalOutput({
      onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      readBuffer: () => Promise.resolve(manager.readBuffer(id))
    }, id, (chunk) => pending.push(new Promise((resolve) => terminal.write(chunk, resolve))), () => undefined, (missing) => `[${missing} missing]`);
    if (mode !== "visible") manager.setVisible(id, false);
  }
  await new Promise((resolve) => setImmediate(resolve));
  // A TUI-like line: colours, cursor moves, text.
  const line = "\x1b[32m✔\x1b[0m \x1b[1mbuilding\x1b[0m module \x1b[36m%\x1b[0m of 4096 files … \x1b[2K\r\n";
  const perTick = Math.round(kbPerSecond * 1024 * TICK_MS / 1000);
  const chunk = line.repeat(Math.ceil(perTick / line.length)).slice(0, perTick);
  const start = process.cpuUsage();
  const wall = performance.now();
  for (let tick = 0; tick < (seconds * 1000) / TICK_MS; tick++) {
    for (const pty of spawners) pty.emit(chunk);
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  // Show every card again (the replay), and let every write finish.
  for (const [id] of manager.sessions) manager.setVisible(id, true);
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all(pending);
  const used = process.cpuUsage(start);
  const elapsed = performance.now() - wall;
  manager.disposeAll();
  for (const terminal of terminals) terminal.dispose();
  return { cpu: (used.user + used.system) / 1e6, elapsed: elapsed / 1000, events, bytes };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(`${cards} cards, ${kbPerSecond} Ki UTF-16 units/s each for ${seconds} s, ${runs} interleaved runs (median); Node ${process.version} ${process.platform}/${process.arch}`);
console.log(`CPU is the process total for all ${cards} cards, including final replay; this headless benchmark excludes DOM painting, WebGL and Electron IPC.`);
console.log("ring-only is a diagnostic lower bound with intentionally incomplete replay, not a functionally equivalent optimization.");
const results = { visible: [], "ring-only": [], whole: [] };
for (let index = 0; index < runs; index++) {
  for (const mode of Object.keys(results)) results[mode].push(await run(mode));
}
for (const [mode, list] of Object.entries(results)) {
  console.log(`${mode.padEnd(9)} CPU ${median(list.map((item) => item.cpu)).toFixed(2)} s over ${median(list.map((item) => item.elapsed)).toFixed(1)} s wall;`
    + ` renderer events ${median(list.map((item) => item.events))}, characters ${median(list.map((item) => item.bytes))}`);
}
