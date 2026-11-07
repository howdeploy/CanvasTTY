import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const terminalCardPath = new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url);
const browserCardPath = new URL("../src/renderer/src/features/browser/BrowserCard.tsx", import.meta.url);
const stylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

test("core semantic summaries reserve width before applying counter-scale", async () => {
  const [terminalSource, browserSource, styles] = await Promise.all([
    readFile(terminalCardPath, "utf8"),
    readFile(browserCardPath, "utf8"),
    readFile(stylesPath, "utf8")
  ]);

  assert.match(terminalSource, /"--summary-content-width": `max\(0px, calc\(\$\{\(pixelSurfaceBounds \? pixelSurfaceBounds\.right - pixelSurfaceBounds\.left : size\.width\) - 72\}px \/ var\(--terminal-summary-scale, 1\)\)\)`/);
  assert.match(browserSource, /\(size\.width - 48\) \/ summaryScale/);
  assert.match(styles, /\.terminal-card__summary-content\s*\{[^}]*width:\s*var\(--summary-content-width\)/);
  assert.match(styles, /\.terminal-card__summary-content\s*\{[^}]*justify-content:\s*center/);
  assert.match(styles, /\.browser-card__summary-content\s*\{[^}]*width:\s*var\(--summary-content-width\)/);
});
