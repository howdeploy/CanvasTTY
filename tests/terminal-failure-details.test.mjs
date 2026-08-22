import assert from "node:assert/strict";
import test from "node:test";
import { terminalFailureDetails } from "../src/main/services/terminalFailureDetails.ts";

test("keeps a traceback-sized final PTY excerpt and removes terminal control sequences", () => {
  const details = terminalFailureDetails([
    "\u001b[?25lstarting\u001b[?25h",
    "first context",
    "second context",
    "third context",
    "fourth context",
    "fifth context",
    "sixth context",
    "error: Codex executable was not found\r\n"
  ].join("\n"));

  assert.equal(details, [
    "starting",
    "first context",
    "second context",
    "third context",
    "fourth context",
    "fifth context",
    "sixth context",
    "error: Codex executable was not found"
  ].join("\n"));
});

test("returns no details when the failed PTY wrote no visible output", () => {
  assert.equal(terminalFailureDetails("\u001b[2J\u0007"), null);
});

test("bounds the tooltip payload to the final 8,000 characters", () => {
  const details = terminalFailureDetails("x".repeat(9_000));

  assert.equal(details?.length, 8_000);
  assert.ok(details?.startsWith("…"));
});

test("preserves traceback indentation", () => {
  const details = terminalFailureDetails("Traceback (most recent call last):\n  File \"agent.py\", line 8, in <module>\n    run()\nRuntimeError: launch failed");

  assert.equal(details, "Traceback (most recent call last):\n  File \"agent.py\", line 8, in <module>\n    run()\nRuntimeError: launch failed");
});

test("starts at the final traceback instead of showing the echoed launch command", () => {
  const details = terminalFailureDetails([
    "> printf 'Traceback (most recent call last):\\n...'; exit 1",
    "Traceback (most recent call last):",
    "  File \"agent.py\", line 8, in <module>",
    "    run()",
    "RuntimeError: launch failed"
  ].join("\n"));

  assert.equal(details, [
    "Traceback (most recent call last):",
    "  File \"agent.py\", line 8, in <module>",
    "    run()",
    "RuntimeError: launch failed"
  ].join("\n"));
});
