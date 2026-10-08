import assert from "node:assert/strict";
import test from "node:test";
import { createCameraStore } from "../src/renderer/src/features/workspace/cameraStore.ts";
import { importWithFakeReact } from "./helpers/fake-react.mjs";

const { useRemarkPopoverRect, __render, __unmount } = await importWithFakeReact(
  "src/renderer/src/features/workspace/useRemarkPopoverRect.ts", "useRemarkPopoverRect", { checkSnapshots: true }
);

const material = { position: { x: 100, y: 50 }, size: { width: 300, height: 200 } };
const viewport = { current: { getBoundingClientRect: () => ({ width: 1360, height: 820 }) } };

test("a popover opens and follows the camera", (t) => {
  t.after(__unmount);
  const camera = createCameraStore({ x: 0, y: 0, zoom: 1 });
  const render = () => __render(() => useRemarkPopoverRect(camera, material, viewport, 1));
  assert.deepEqual(render(), { position: { x: 100, y: 262 }, size: { width: 360, height: 300 } });
  camera.set({ x: 20, y: 30, zoom: 1.5 });
  assert.deepEqual(render(), { position: { x: 170, y: 417 }, size: { width: 360, height: 300 } });
});

test("a hidden popover opens at the latest position", (t) => {
  t.after(__unmount);
  const camera = createCameraStore({ x: 0, y: 0, zoom: 1 });
  const render = (visible) => __render(() => useRemarkPopoverRect(camera, visible ? material : null, viewport, 1));
  assert.equal(render(false), null);
  camera.set({ x: 50, y: 60, zoom: 1 });
  assert.deepEqual(render(true), { position: { x: 150, y: 322 }, size: { width: 360, height: 300 } });
  assert.equal(render(false), null);
});

test("a popover stays inside the viewport", (t) => {
  t.after(__unmount);
  const camera = createCameraStore({ x: 0, y: 0, zoom: 1 });
  const edge = { ...material, position: { x: 1200, y: 700 } };
  assert.deepEqual(__render(() => useRemarkPopoverRect(camera, edge, viewport, 1)), {
    position: { x: 988, y: 508 }, size: { width: 360, height: 300 }
  });
});
