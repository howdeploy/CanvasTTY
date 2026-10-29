import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
const source = card.slice(card.indexOf("    const fit = (): void => {"), card.indexOf("    fitRef.current = fit;"));

test("a hidden or unmeasurable card cannot report placeholder geometry as a measured grid", () => {
  let dimensions;
  let fits = 0;
  const reported = [];
  const terminal = { cols: 80, rows: 24 };
  const fitAddon = {
    proposeDimensions: () => dimensions,
    fit() { fits++; terminal.cols = dimensions.cols; terminal.rows = dimensions.rows; }
  };
  const fit = runInNewContext(stripTypeScriptTypes(source + "\nfit;"), {
    terminal, fitAddon,
    fitTerminalPreservingViewport(_terminal, callback) { callback(); },
    reportGrid: (cols, rows) => reported.push([cols, rows])
  });
  for (const unmeasurable of [undefined, { cols: NaN, rows: 20 }, { cols: 80, rows: NaN }]) {
    dimensions = unmeasurable;
    fit();
  }
  assert.equal(fits, 0);
  assert.deepEqual(reported, []);
  dimensions = { cols: 93, rows: 31 };
  fit();
  assert.equal(fits, 1);
  assert.deepEqual(reported, [[93, 31]]);
});
