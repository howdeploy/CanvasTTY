import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformSync } from "esbuild";
import { remarkPickable } from "../src/renderer/src/features/materials/materialCardModel.ts";
import { importWithFakeReact } from "./helpers/fake-react.mjs";

const source = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
const handler = source.match(/onPointerDownCapture=\{([\s\S]*?)\}\s+onClickCapture=/)?.[1];
assert.ok(handler);
const { code: compiled } = transformSync(`const handle = ${handler};`, { loader: "ts" });
const createCapture = new Function("openRadialLauncher", "raiseLayer", "remarkDraft", "renderedMaterials", "remarkPickable", "remarkActions", "contextMenu", "regionEditor", "pointerNavigation", `${compiled}\nreturn handle;`);
const { ImageAnnotator, __render, __unmount } = await importWithFakeReact(
  "src/renderer/src/features/materials/ImageAnnotator.tsx", "ImageAnnotator"
);

function picking(material, surface, draws) {
  const capture = createCapture(() => false, () => {}, { picking: true }, [material], remarkPickable,
    { draw: (id, anchor) => draws.push({ id, anchor }) }, null, null, { handlePointerDownCapture: () => true });
  let stopped = false;
  const event = {
    button: 0,
    buttons: 1,
    pointerId: 1,
    clientX: 40,
    clientY: 40,
    target: {
      closest: (selector) => selector === "[data-material-id]" ? { dataset: { materialId: material.id } }
        : selector === ".material-annotator" && surface === "image" ? {} : null
    },
    currentTarget: {
      setPointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 })
    },
    preventDefault() {},
    stopPropagation() { stopped = true; }
  };
  capture(event);
  return { event, stopped };
}

test("reference images keep point and region gestures", (t) => {
  t.after(__unmount);
  const material = { id: "image", kind: "image", state: "ready" };
  for (const end of [{ clientX: 40, clientY: 40 }, { clientX: 140, clientY: 140 }]) {
    const draws = [];
    const { event, stopped } = picking(material, "image", draws);
    assert.equal(stopped, false);
    assert.deepEqual(draws, []);
    const annotator = __render(ImageAnnotator, {
      locale: "en", natural: null, remarks: [], staleVersionIds: new Set(), mode: "pick",
      draftAnchor: null, referenceAnchor: null, selectedRemarkId: null,
      onDraw: (anchor) => draws.push({ id: material.id, anchor }), onSelectRemark() {}
    });
    annotator.props.onPointerDown(event);
    annotator.props.onPointerUp({ ...event, ...end });
    assert.deepEqual(draws, [{ id: "image", anchor: end.clientX === 40
      ? { kind: "point", x: 0.2, y: 0.2 }
      : { kind: "region", x: 0.2, y: 0.2, width: 0.5, height: 0.5 } }]);
    __unmount();
  }
});

test("reference headers and files pick the whole material", () => {
  for (const kind of ["image", "file"]) {
    const draws = [];
    const { stopped } = picking({ id: kind, kind, state: "ready" }, kind === "image" ? "header" : "body", draws);
    assert.equal(stopped, true);
    assert.deepEqual(draws, [{ id: kind, anchor: { kind: "whole" } }]);
  }
});
