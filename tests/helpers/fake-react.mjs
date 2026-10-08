// Bundles renderer components against a minimal React stand-in, so a test can drive a component's
// handlers and state without a DOM. State updaters are queued and applied only by `__flush()`, which
// is the ordering React uses whenever an earlier update of the component is still pending. Effects
// run at the end of `__render()` when their dependencies changed, cleaning up the previous run first.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const FAKE_REACT = `
let slots = [];
let cursor = 0;
const queue = [];
let pendingEffects = [];
const changed = (previous, next) => !previous || !next || next.length !== previous.length
  || next.some((value, index) => !Object.is(value, previous[index]));
export function useState(initial) {
  const index = cursor++;
  if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
  return [slots[index], (update) => { queue.push([index, update]); }];
}
export function useRef(initial) {
  const index = cursor++;
  if (!(index in slots)) slots[index] = { current: initial };
  return slots[index];
}
export function useEffect(effect, deps) {
  const index = cursor++;
  const previous = slots[index];
  if (!previous || changed(previous.deps, deps)) pendingEffects.push([index, effect, deps]);
}
export const useLayoutEffect = useEffect;
export function useCallback(callback) { return callback; }
export function useSyncExternalStore(_subscribe, getSnapshot) {
  cursor++;
  const snapshot = getSnapshot();
  if (CHECK_SNAPSHOTS && !Object.is(snapshot, getSnapshot())) throw new Error("The result of getSnapshot should be cached.");
  return snapshot;
}
export function memo(component) { return component; }
export function useMemo(factory) { return factory(); }
export function jsx(type, props, key) { return { type, props, key }; }
export const jsxs = jsx;
export const Fragment = "fragment";
export function __render(component, props) {
  cursor = 0;
  pendingEffects = [];
  const tree = component(props);
  for (const [index, effect, deps] of pendingEffects.splice(0)) {
    slots[index]?.cleanup?.();
    const cleanup = effect();
    slots[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  }
  return tree;
}
export function __flush() {
  for (const [index, update] of queue.splice(0)) slots[index] = typeof update === "function" ? update(slots[index]) : update;
}
export function __pending() { return queue.length; }
export function __unmount() {
  for (const slot of slots) if (slot && typeof slot === "object" && "cleanup" in slot) slot.cleanup?.();
  slots = []; cursor = 0; queue.length = 0;
}
export function __reset() { slots = []; cursor = 0; queue.length = 0; pendingEffects = []; }
export default { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useSyncExternalStore, memo };
`;

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Imports `exports` (comma-separated names) from a repository-relative module, plus the fake React controls. */
export async function importWithFakeReact(modulePath, exports, { checkSnapshots = false } = {}) {
  const { outputFiles } = await build({
    stdin: {
      contents: `export { ${exports} } from "./${modulePath}"; export { __render, __flush, __pending, __unmount, __reset } from "react";`,
      resolveDir: root,
      loader: "ts"
    },
    jsx: "automatic",
    define: { CHECK_SNAPSHOTS: JSON.stringify(checkSnapshots) },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    loader: { ".svg": "text", ".png": "dataurl", ".ico": "dataurl", ".css": "empty" },
    plugins: [{
      name: "fake-react",
      setup(builder) {
        builder.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, () => ({ path: "react", namespace: "fake-react" }));
        builder.onLoad({ filter: /.*/, namespace: "fake-react" }, () => ({ contents: FAKE_REACT, loader: "js" }));
      }
    }]
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
}

/** Every element in a rendered tree matching `predicate` (function components are not expanded). */
export function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, found); return found; }
  if (!node || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

/** One React change event: currentTarget is the field while the handler runs, null once dispatch ends. */
export function change(field, value) {
  const element = { value };
  const event = { currentTarget: element, target: element };
  field.props.onChange(event);
  event.currentTarget = null;
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
