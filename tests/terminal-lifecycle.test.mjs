import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const terminalCardPath = new URL(
  "../src/renderer/src/features/terminal/TerminalCard.tsx",
  import.meta.url
);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);
const terminalManagerPath = new URL("../src/main/services/TerminalManager.ts", import.meta.url);

test("palette changes retheme the live xterm without recreating it", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const mountDependencies = effectDependenciesContaining(source, "new Terminal({");

  assert.equal(mountDependencies, "session.id");
  assert.match(source, /terminal\.options\.theme = terminalTheme\(palette\)/);
});

test("terminal copy shortcuts write the xterm selection without reaching the PTY", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /terminal\.attachCustomKeyEventHandler/);
  assert.match(source, /window\.canvasTTY\.clipboard\.writeText\(terminal\.getSelection\(\)\)/);
  assert.match(source, /return false;/);
});

test("terminal paste reads the trusted clipboard bridge and uses xterm paste semantics", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /window\.canvasTTY\.clipboard\.readText\(\)/);
  assert.match(source, /terminal\.paste\(text\)/);
});

test("terminal mouse coordinates are adapted for a transformed canvas", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /attachTerminalMouseCoordinateAdapter\(\s*screen/);
  assert.match(source, /captureCanvasWheelRef\.current/);
  assert.match(source, /data-canvas-zoom-surface="application"/);
});

test("logical focus moves keyboard input independently of terminal selection", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /if \(focused && !renaming && !summaryMode\) terminal\.focus\(\)/);
  assert.match(source, /else if \(!focused\) \{\s*terminal\.blur\(\)/);
  assert.match(source, /terminal-card--selected/);
});

test("terminal uses one block cursor instead of overlaying a bar on provider cursor cells", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /cursorStyle: "block"/);
  assert.doesNotMatch(source, /cursorStyle: "bar"/);
});

test("programmatic hover focus does not leak focus reports into the agent TUI", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /focusChangeSource === "hover"/);
  assert.match(source, /suppressFocusReport\.current/);
  assert.match(source, /TERMINAL_FOCUS_IN/);
  assert.match(source, /TERMINAL_FOCUS_OUT/);
});

test("PTY output is batched before crossing into the renderer", async () => {
  const source = await readFile(terminalManagerPath, "utf8");

  assert.match(source, /const OUTPUT_BATCH_MS = 16/);
  assert.match(source, /session\.pendingOutput\.push\(data\)/);
  assert.match(source, /session\.pendingOutput\.join\(""\)/);
  assert.match(source, /bufferChunks\.slice\(session\.bufferStart\)\.join\(""\)/);
});

test("terminal viewport keeps the palette background after row-sized fits", async () => {
  const [source, styles] = await Promise.all([
    readFile(terminalCardPath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);

  assert.match(source, /"--terminal-background": terminalBackground/);
  assert.match(styles, /\.terminal-card__surface \.xterm-viewport \{ background-color: var\(--terminal-background, #202430\); \}/);
});

test("renaming is inline and does not join the xterm mount dependencies", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const mountDependencies = effectDependenciesContaining(source, "new Terminal({");

  assert.equal(mountDependencies, "session.id");
  assert.match(source, /window\.canvasTTY\.terminal\.rename|onRename\(session\.id, title\)/);
  assert.match(source, /data-terminal-rename="true"/);
  assert.match(source, /defaultValue=\{session\.title\}/);
  assert.match(source, /autoFocus/);
  assert.match(source, /terminalRef\.current\?\.blur\(\)/);
  assert.doesNotMatch(source, /requestAnimationFrame\(\(\) => \{\s*renameInput/);
  assert.match(source, /session\.titleCustomized \? session\.title : compactPath\(session\.cwd\)/);
});

test("late input and resize events are guarded after PTY exit", async () => {
  const source = await readFile(terminalManagerPath, "utf8");

  assert.match(source, /session\.metadata\.exitCode !== null/);
  assert.match(source, /tryPtyOperation\(\(\) => process\.write\(data\)\)/);
  assert.match(source, /tryPtyOperation\(\(\) => process\.resize\(safeCols, safeRows\)\)/);
});

test("an exited PTY can restart in place without recreating its xterm card", async () => {
  const [card, manager] = await Promise.all([
    readFile(terminalCardPath, "utf8"),
    readFile(terminalManagerPath, "utf8")
  ]);

  assert.match(manager, /restart\(id: string\): SessionSnapshot/);
  assert.match(manager, /session\.metadata\.exitCode === null/);
  assert.match(manager, /session\.metadata\.status = "idle"/);
  assert.match(manager, /session\.metadata\.failureDetails = null/);
  assert.match(manager, /if \(launched\.process\) this\.bindProcess\(id, session, launched\.process\)/);
  assert.match(card, /shouldRestartExitedTerminal\(event, sessionExited\.current\)/);
  assert.match(card, /onRestart\(session\.id\)/);
});

test("failed PTYs preserve their final sanitized output as failure details", async () => {
  const source = await readFile(terminalManagerPath, "utf8");

  assert.match(source, /terminalFailureDetails\(current\.bufferChunks\.slice\(current\.bufferStart\)\.join\(""\)\)/);
  assert.match(source, /current\.metadata\.failureDetails = exitCode === 0/);
});

function effectDependenciesContaining(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Could not find ${marker}`);

  const effectStart = source.lastIndexOf("useEffect(() => {", markerIndex);
  assert.notEqual(effectStart, -1, "Could not find the xterm mount effect");

  const dependencyStart = source.indexOf("}, [", markerIndex);
  const dependencyEnd = source.indexOf("]);", dependencyStart);
  assert.notEqual(dependencyStart, -1, "Could not find the xterm mount dependencies");
  assert.notEqual(dependencyEnd, -1, "Could not parse the xterm mount dependencies");

  return source.slice(dependencyStart + 4, dependencyEnd).trim();
}
