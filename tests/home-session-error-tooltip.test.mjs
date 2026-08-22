import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const homeZonePath = new URL("../src/renderer/src/features/home/HomeZone.tsx", import.meta.url);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

test("Home exposes failed session details from the error mark with a Copy action", async () => {
  const source = await readFile(homeZonePath, "utf8");

  assert.match(source, /session\.failureDetails \?\? `\$\{t\(locale, "failureOutputUnavailable"\)\}\$\{session\.exitCode \?\? "unknown"\}`/);
  assert.match(source, /className="usage-row__failure-tooltip"/);
  assert.match(source, /className="usage-row__failure-trigger"/);
  assert.match(source, /<UiIcon name="error" size=\{24\} \/>/);
  assert.match(source, /window\.canvasTTY\.clipboard\.writeText\(failureDetails\)/);
  assert.match(source, /<UiIcon name="copy" size=\{16\} \/>/);
});

test("Home keeps error details visible while the trigger is hovered or keyboard-focused", async () => {
  const styles = await readFile(appStylesPath, "utf8");

  assert.match(styles, /\.usage-row__failure-trigger:hover \+ \.usage-row__failure-tooltip/);
  assert.match(styles, /\.usage-row__failure-trigger:focus-visible \+ \.usage-row__failure-tooltip/);
  assert.match(styles, /\.usage-row__failure-tooltip:hover/);
});
