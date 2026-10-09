import assert from "node:assert/strict";
import test from "node:test";
import { constrainMascotResize, constrainPluginResize, fitMascotBounds } from "../src/renderer/src/features/plugins/pluginBounds.ts";
import { snapResize } from "../src/renderer/src/features/workspace/snap.ts";

test("uses the platform minimum for older plugin manifests", () => {
  assert.deepEqual(constrainPluginResize({
    position: { x: 10, y: 20 },
    size: { width: 100, height: 80 }
  }, "se"), {
    position: { x: 10, y: 20 },
    size: { width: 320, height: 220 }
  });
});

test("respects a contribution-specific minimum and preserves north-west edges", () => {
  assert.deepEqual(constrainPluginResize({
    position: { x: 500, y: 400 },
    size: { width: 120, height: 90 }
  }, "nw", { width: 280, height: 160 }), {
    position: { x: 340, y: 330 },
    size: { width: 280, height: 160 }
  });
});

test("fits a saved wide mascot card and keeps its proportions while resizing", () => {
  const ratio = 320 / 520;
  const fitted = fitMascotBounds({ position: { x: 100, y: 50 }, size: { width: 420, height: 260 } }, ratio);
  assert.deepEqual(fitted, { position: { x: 230, y: 50 }, size: { width: 160, height: 260 } });
  assert.deepEqual(constrainMascotResize({
    position: fitted.position,
    size: { width: 220, height: 260 }
  }, "se", fitted.size, ratio), {
    position: fitted.position,
    size: { width: 220, height: 358 }
  });
  assert.deepEqual(constrainMascotResize({
    position: fitted.position,
    size: { width: 160, height: 180 }
  }, "se", fitted.size, ratio), {
    position: fitted.position,
    size: { width: 128, height: 208 }
  });
});

test("snapping does not restore the regular card minimum for a mascot", () => {
  const ratio = 0.5;
  const requested = constrainMascotResize({ position: { x: 0, y: 0 }, size: { width: 180, height: 360 } }, "se", { width: 260, height: 520 }, ratio);
  const snapped = snapResize(requested, "se", [], {
    min: { width: 128, height: 140 },
    max: { width: 1_600, height: 1_100 }
  });
  assert.deepEqual(constrainMascotResize(snapped, "se", requested.size, ratio).size, { width: 180, height: 360 });
});
