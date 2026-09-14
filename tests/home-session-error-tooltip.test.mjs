import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const homeZonePath = new URL("../src/renderer/src/features/home/HomeZone.tsx", import.meta.url);
const failureDetailsPath = new URL("../src/renderer/src/features/home/SessionFailureDetails.tsx", import.meta.url);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

test("Home exposes failed session details from the error mark with a Copy action", async () => {
  const [home, component] = await Promise.all([
    readFile(homeZonePath, "utf8"),
    readFile(failureDetailsPath, "utf8")
  ]);

  assert.match(home, /const failureDetails = sessionFailureDetails\(session, locale\);/);
  assert.match(home, /<SessionFailureDetails details=\{failureDetails\} locale=\{locale\} \/>/);
  assert.match(component, /session\.failureDetails \?\? `\$\{t\(locale, "failureOutputUnavailable"\)\}\$\{session\.exitCode \?\? "unknown"\}`/);
  assert.match(component, /className="usage-row__failure-tooltip"/);
  assert.match(component, /className="usage-row__failure-trigger"/);
  assert.match(component, /<UiIcon name="error" size=\{24\} \/>/);
  assert.match(component, /window\.canvasTTY\.clipboard\.writeText\(details\)/);
  assert.match(component, /<UiIcon name="copy" size=\{16\} \/>/);
});

test("Home opens failure details from hover or keyboard focus in a top-layer popover", async () => {
  const [component, styles] = await Promise.all([
    readFile(failureDetailsPath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);

  assert.match(component, /popover="manual"/);
  assert.match(component, /onMouseEnter=\{openTooltip\}/);
  assert.match(component, /onFocus=\{openTooltip\}/);
  assert.match(component, /tooltip\.showPopover\(\)/);
  assert.match(styles, /\.usage-row__failure-tooltip \{ position: fixed;/);
  assert.match(styles, /\.usage-row__failure-tooltip:popover-open \{ display: grid; \}/);
});

test("failure popover preserves the three-row scroll viewport and danger rail", async () => {
  const [source, styles] = await Promise.all([
    readFile(homeZonePath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);

  assert.match(styles, /\.usage-list \{[^}]*overflow-y: auto;/);
  assert.match(styles, /\.usage-list \{[^}]*overscroll-behavior: contain;/);
  assert.match(source, /className="tile usage-list"[\s\S]*?data-canvas-wheel-priority="local"/);
  assert.doesNotMatch(styles, /\.usage-list:has\([^}]+overflow: visible;/);
  assert.match(styles, /\.usage-row-wrap:has\(\.ui-icon--error\) \.usage-row::before \{ background: var\(--danger\); \}/);
});
