import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_FIT_MARGIN,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  boundsUnion,
  cameraFittingBounds,
  cameraFittingContent
} from "../src/renderer/src/features/workspace/canvasCameraGeometry.ts";

const viewport = { width: 1200, height: 800 };
const box = (x, y, width, height) => ({ position: { x, y }, size: { width, height } });

test("the union covers every rectangle regardless of order", () => {
  assert.deepEqual(boundsUnion([box(100, 50, 200, 100), box(-400, 300, 100, 100)]), {
    position: { x: -400, y: 50 },
    size: { width: 700, height: 350 }
  });
});

test("an empty canvas has nothing to fit", () => {
  assert.equal(boundsUnion([]), null);
  assert.equal(cameraFittingContent([], viewport), null);
});

test("small content is capped at the maximum zoom and stays centred", () => {
  const camera = cameraFittingBounds(box(0, 0, 200, 120), viewport);
  assert.equal(camera.zoom, CANVAS_MAX_ZOOM);
  assert.ok(Math.abs(camera.x + (0 + 100) * camera.zoom - viewport.width / 2) < 1e-9);
  assert.ok(Math.abs(camera.y + (0 + 60) * camera.zoom - viewport.height / 2) < 1e-9);
});

test("wide content fits the whole span inside the margin, not just the centre", () => {
  const camera = cameraFittingBounds(box(0, 0, 1_000, 300), viewport);
  const expected = (viewport.width - CANVAS_FIT_MARGIN * 2) / 1_000;
  assert.ok(Math.abs(camera.zoom - expected) < 1e-9);
  const left = camera.x + 0 * camera.zoom;
  const right = camera.x + 1_000 * camera.zoom;
  assert.ok(left >= CANVAS_FIT_MARGIN - 1e-6, `left edge ${left}`);
  assert.ok(right <= viewport.width - CANVAS_FIT_MARGIN + 1e-6, `right edge ${right}`);
});

test("huge content clamps to the wheel-zoom floor instead of vanishing", () => {
  assert.equal(cameraFittingBounds(box(0, 0, 40_000, 20_000), viewport).zoom, CANVAS_MIN_ZOOM);
});

test("fitting content frames windows far away from the origin", () => {
  const camera = cameraFittingContent([box(5_000, -3_000, 400, 300), box(5_600, -2_600, 400, 300)], viewport);
  assert.ok(camera.zoom <= CANVAS_MAX_ZOOM);
  for (const [x, y, width, height] of [[5_000, -3_000, 400, 300], [5_600, -2_600, 400, 300]]) {
    const left = camera.x + x * camera.zoom;
    const top = camera.y + y * camera.zoom;
    assert.ok(left >= CANVAS_FIT_MARGIN - 1e-6 && left + width * camera.zoom <= viewport.width - CANVAS_FIT_MARGIN + 1e-6);
    assert.ok(top >= CANVAS_FIT_MARGIN - 1e-6 && top + height * camera.zoom <= viewport.height - CANVAS_FIT_MARGIN + 1e-6);
  }
});
