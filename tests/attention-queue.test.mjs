import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { attentionSessions } from "../src/renderer/src/features/home/attentionQueue.ts";

function snapshot(id, status) {
  return {
    id,
    title: id,
    status,
    provider: "terminal",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 320 }
  };
}

test("the attention queue keeps sessions that need a decision or report a failure, in snapshot order", () => {
  const sessions = [
    snapshot("a", "working"),
    snapshot("b", "failed"),
    snapshot("c", "idle"),
    snapshot("d", "needs_approval"),
    snapshot("e", "done"),
    snapshot("f", "unavailable")
  ];

  assert.deepEqual(attentionSessions(sessions).map((session) => session.id), ["b", "d"]);
});

test("the attention queue is empty when no session asks for attention", () => {
  assert.deepEqual(attentionSessions([]), []);
  assert.deepEqual(attentionSessions([snapshot("a", "working"), snapshot("b", "done")]), []);
});

test("only the session status decides attention, never the terminal payload", () => {
  const noisy = {
    ...snapshot("noisy", "working"),
    failureDetails: "error: boom",
    exitCode: 1,
    outputOffset: 4096
  };

  assert.deepEqual(attentionSessions([noisy]), []);
});

test("the queue lives in the screen-anchored overlay layer, not inside the transformed canvas scene", async () => {
  const canvas = await readFile(
    new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url),
    "utf8"
  );
  const overlays = canvas.match(/<div className="canvas-overlays"[^>]*>[\s\S]*?\n      <\/div>/)?.[0];
  const home = await readFile(
    new URL("../src/renderer/src/features/home/HomeZone.tsx", import.meta.url),
    "utf8"
  );

  assert.ok(overlays, "the canvas renders an overlay layer");
  const queue = overlays.match(/<section className="attention-queue"[\s\S]*?<\/section>/)?.[0];

  // The scene carries the camera transform, so a queue rendered inside it scales with the camera and
  // stays underneath the overlay layer. It must be anchored in the overlay layer instead.
  assert.equal(home.includes("attention-queue"), false, "the HOME scene does not render the queue");
  assert.ok(queue, "the overlay layer renders the attention queue");
  assert.match(queue, /className="attention-queue__empty"[\s\S]*?needsAttentionEmpty/);
  assert.match(queue, /className="attention-queue__item"[\s\S]*?focusSessionFromHome\(session\)/);
  assert.match(queue, /<SessionFailureDetails details=\{failureDetails\} locale=\{settings\.locale\} \/>/);
});
