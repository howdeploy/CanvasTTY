import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  failureClipboardText,
  failureSummary,
  isUpdateBannerLine,
  possibleCauseLine
} from "../src/renderer/src/features/home/failureSummary.ts";

const failureDetailsPath = new URL("../src/renderer/src/features/home/SessionFailureDetails.tsx", import.meta.url);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

const CODEX_BANNER = [
  "╭──────────────────────────────────────────────╮",
  "│ Update available! 0.42.0 -> 0.43.0            │",
  "│ Run npm install -g @openai/codex to update.   │",
  "╰──────────────────────────────────────────────╯"
].join("\n");

test("summary is null for every status but failed", () => {
  for (const status of ["idle", "working", "needs_approval", "unavailable", "done"]) {
    assert.equal(failureSummary({ status, exitCode: 1, failureDetails: "error: boom" }, "en"), null);
  }
});

test("a known exit code leads the summary, with the error line as possible cause", () => {
  const summary = failureSummary({
    status: "failed",
    exitCode: 2,
    failureDetails: "compiling…\nerror[E0425]: cannot find value `x` in this scope\n  --> src/main.rs:3:5"
  }, "en");

  assert.equal(summary.headline, "Process exited with code 2");
  assert.equal(summary.detail, "Possible cause");
  assert.equal(summary.possibleCause, "error[E0425]: cannot find value `x` in this scope");
  assert.equal(summary.causeKnown, true);
  assert.match(summary.diagnostics, /src\/main\.rs/);
});

test("exit code 127 is reported as a launch failure (CLI not found or not runnable)", () => {
  const summary = failureSummary({
    status: "failed",
    exitCode: 127,
    failureDetails: "/missing/codex: missing"
  }, "en");

  assert.equal(summary.headline, "The command could not be started");
  assert.equal(summary.detail, "The executable was not found or is not runnable (exit code 127).");
  assert.equal(summary.causeKnown, true);

  const ru = failureSummary({ status: "failed", exitCode: 127, failureDetails: null }, "ru");
  assert.equal(ru.headline, "Не удалось запустить команду");
});

test("nothing known: the summary says so instead of guessing", () => {
  const summary = failureSummary({ status: "failed", exitCode: null, failureDetails: null }, "en");

  assert.equal(summary.headline, "Cause unknown");
  assert.equal(summary.detail, "The terminal did not report what went wrong.");
  assert.equal(summary.possibleCause, null);
  assert.equal(summary.causeKnown, false);
  assert.equal(summary.diagnostics, null);

  const ru = failureSummary({ status: "failed", exitCode: null, failureDetails: "   " }, "ru");
  assert.equal(ru.headline, "Причина неизвестна");
  assert.equal(ru.diagnostics, null);
});

test("an exit code without any error-looking line still acknowledges the unknown cause", () => {
  const summary = failureSummary({
    status: "failed",
    exitCode: 1,
    failureDetails: "Loading workspace\nDone."
  }, "en");

  assert.equal(summary.headline, "Process exited with code 1");
  assert.equal(summary.detail, "Cause unknown");
  assert.equal(summary.possibleCause, null);
});

test("a Codex update banner is never presented as the failure cause", () => {
  assert.equal(isUpdateBannerLine("│ Update available! 0.42.0 -> 0.43.0 │"), true);
  assert.equal(isUpdateBannerLine("Run npm install -g @openai/codex to update."), true);
  assert.equal(isUpdateBannerLine("error: Codex executable was not found"), false);

  // Banner only: nothing qualifies as a cause.
  assert.equal(possibleCauseLine(CODEX_BANNER), null);
  const bannerOnly = failureSummary({ status: "failed", exitCode: 1, failureDetails: CODEX_BANNER }, "en");
  assert.equal(bannerOnly.possibleCause, null);
  assert.equal(bannerOnly.detail, "Cause unknown");

  // Banner followed by a real error: the error wins even though the banner came first.
  const withError = failureSummary({
    status: "failed",
    exitCode: 1,
    failureDetails: `${CODEX_BANNER}\nerror: Codex executable was not found`
  }, "en");
  assert.equal(withError.possibleCause, "error: Codex executable was not found");

  // The banner without exit code must not turn "cause unknown" into a known cause either.
  const noExit = failureSummary({ status: "failed", exitCode: null, failureDetails: CODEX_BANNER }, "en");
  assert.equal(noExit.headline, "Cause unknown");
  assert.equal(noExit.causeKnown, false);
});

test("the possible-cause line is trimmed and bounded", () => {
  const long = `error: ${"x".repeat(400)}`;
  const line = possibleCauseLine(`   ${long}   `);
  assert.equal(line.length, 160);
  assert.ok(line.endsWith("…"));
  assert.equal(possibleCauseLine(null), null);
  assert.equal(possibleCauseLine(""), null);
});

test("clipboard text carries the summary first and the raw diagnostics after", () => {
  const summary = failureSummary({
    status: "failed",
    exitCode: 3,
    failureDetails: "warning: something\nfatal: repository not found"
  }, "en");
  const text = failureClipboardText(summary);
  assert.equal(text.split("\n")[0], "Process exited with code 3");
  assert.ok(text.indexOf("fatal: repository not found") > text.indexOf("Possible cause"));
  assert.ok(text.endsWith("warning: something\nfatal: repository not found"));
});

test("the popover leads with the summary, keeps raw output collapsed and is keyboard reachable", async () => {
  const [component, styles] = await Promise.all([
    readFile(failureDetailsPath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);

  // Summary first, raw diagnostics as a collapsed <details> below it.
  const headline = component.indexOf('className="usage-row__failure-headline"');
  const diagnostics = component.indexOf('<details className="usage-row__failure-diagnostics">');
  assert.ok(headline > 0 && diagnostics > headline, "headline precedes the collapsed diagnostics");
  assert.match(component, /<pre className="usage-row__failure-details" tabIndex=\{0\}>/);
  assert.match(component, /failure\.possibleCause && <code className="usage-row__failure-cause">/);

  // Real buttons for copy and close; Escape closes and returns focus to the trigger.
  assert.match(component, /<button\s+className="usage-row__failure-copy"\s+type="button"/);
  assert.match(component, /<button\s+className="usage-row__failure-close"\s+type="button"/);
  assert.match(component, /if \(event\.key !== "Escape"\) return;[\s\S]*?closeAndRefocus\(\);/);
  assert.match(component, /triggerRef\.current\?\.focus\(\)/);

  // Position is clamped to the viewport on both axes.
  assert.match(component, /const left = Math\.max\(\s*FAILURE_TOOLTIP_MARGIN,/);
  assert.match(component, /tooltip\.style\.top = `\$\{Math\.max\(FAILURE_TOOLTIP_MARGIN, bounds\.bottom \+ FAILURE_TOOLTIP_GAP\)\}px`/);

  // CSS: bounded width and height, wrapping, scrollable diagnostics, focus rings, semantic tokens.
  assert.match(styles, /\.usage-row__failure-tooltip \{[^}]*max-width: calc\(100vw - 32px\);[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.usage-row__failure-tooltip \{[^}]*background: var\(--surface\);/);
  assert.match(styles, /\.usage-row__failure-details \{[^}]*max-height: var\(--failure-tooltip-details-max-height, 260px\);[^}]*overflow: auto;[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.usage-row__failure-cause \{[^}]*border-left: 3px solid var\(--danger\);/);
  assert.match(styles, /\.usage-row__failure-copy:focus-visible, \.usage-row__failure-close:focus-visible \{[^}]*box-shadow: inset 0 0 0 2px var\(--secondary\);/);
  assert.doesNotMatch(styles, /\.usage-row__failure-tooltip \{[^}]*background: #292936/);
});
