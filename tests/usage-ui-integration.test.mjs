import test from "node:test";
import assert from "node:assert/strict";
import { build, transform } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";


const root = fileURLToPath(new URL("..", import.meta.url));

test("the always-mounted usage trigger does not eagerly load the report or view", async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/renderer/src/features/usage/UsageHistoryPanel.tsx"],
    outdir: "usage-test-output", write: false, metafile: true,
    bundle: true, splitting: true, format: "esm", platform: "browser", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl" }, logLevel: "silent"
  });
  const outputs = result.metafile.outputs;
  const entry = Object.keys(outputs).find((path) => outputs[path].entryPoint?.endsWith("UsageHistoryPanel.tsx"));
  assert.ok(entry);
  const visited = new Set();
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    for (const dependency of outputs[path].imports) {
      if (!dependency.external && dependency.kind !== "dynamic-import") visit(dependency.path);
    }
  }
  visit(entry);
  const eagerInputs = [...visited].flatMap((path) => Object.keys(outputs[path].inputs));
  assert.ok(!eagerInputs.some((path) => /\/(usageReport\.ts|UsageHistoryView\.tsx)$/.test(path)),
    `report/view must be deferred, not startup dependencies: ${eagerInputs.filter((path) => /usage/i.test(path)).join(", ")}`);
  assert.ok(Object.values(outputs).some((output) => Object.keys(output.inputs).some((path) => path.endsWith("usageReport.ts"))),
    "the report remains present in a deferred chunk");
});

// Exercise the real TSX shell with a small hook/portal host, without launching
// Electron or relying on a browser's network timing for the deferred module.
const panelSource = await readFile(new URL("../src/renderer/src/features/usage/UsageHistoryPanel.tsx", import.meta.url), "utf8");
const { code: panelCode } = await transform(panelSource.replace('import("./UsageHistoryReport").then', '__loadReport().then'), {
  loader: "tsx", format: "cjs", target: "es2022", jsx: "automatic"
});

function panelHarness() {
  let resolveModule, rejectModule;
  const pendingModule = new Promise((resolve, reject) => { resolveModule = resolve; rejectModule = reject; });
  let cursor = 0;
  let moduleRequests = 0;
  const slots = [];
  const effects = [];
  const listeners = new Map();
  const changes = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(value) { return react.useState(() => ({ current: value }))[0]; },
    useId() { return react.useState(() => `id-${cursor}`)[0]; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) {
      const index = cursor++;
      const old = slots[index];
      if (!old || deps.some((value, i) => value !== old.deps[i])) {
        effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; });
      }
    }
  };
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  runInNewContext(panelCode, {
    exports: module.exports, module, Intl, Date, Error,
    __loadReport() { moduleRequests++; return pendingModule; },
    HTMLElement: class {},
    document: { activeElement: null, addEventListener() {}, removeEventListener() {} },
    window: {
      canvasTTY: {},
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); }
    },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "react-dom") return { createPortal: (child) => child };

      if (name.endsWith("usageHistoryPoller.ts")) return { startUsageHistoryPoller: () => ({ stop() {}, refresh() {} }) };
      if (name.endsWith("usageHistoryApi.ts")) return {};
      if (name.endsWith("usageText.ts")) return { usageText: () => ({ title: "Usage", trigger: "Usage", close: "Close", loading: "Loading", reportFailed: "Report failed: {message}" }) };
      if (name.endsWith("UiIcon")) return { UiIcon: "icon" };
      if (name.endsWith(".css")) return {};
      throw new Error(`Unexpected import ${name}`);
    }
  });
  return {
    changes, listeners, resolveModule, rejectModule,
    get moduleRequests() { return moduleRequests; },
    render(open) {
      cursor = 0;
      const tree = module.exports.UsageHistoryPanel({ locale: "en", open, container: {}, onOpenChange: (value) => changes.push(value) });
      while (effects.length) effects.shift()();
      return tree;
    }
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("closed trigger stays mounted; pending report has a named closable modal and preserves native keys", async () => {
  const harness = panelHarness();
  const closed = nodes(harness.render(false));
  assert.equal(closed.filter((node) => node.props?.className === "usage-history-trigger").length, 1);
  await settle();
  assert.equal(harness.moduleRequests, 0);
  const pending = nodes(harness.render(true));
  await settle();
  assert.equal(harness.moduleRequests, 1);
  assert.ok(pending.some((node) => node.props?.role === "dialog"));
  assert.ok(pending.some((node) => node.props?.role === "status" && node.props.children === "Loading"));
  pending.find((node) => node.type === "button" && node.props.children === "Close").props.onClick();
  assert.deepEqual(harness.changes, [false]);
  const listener = harness.listeners.get("keydown");
  for (const key of ["a", "c", "v", "x", "z", "ArrowLeft"]) {
    listener({ key, metaKey: true, preventDefault() { assert.fail("native key intercepted"); }, stopPropagation() { assert.fail("native key stopped"); } });
  }
  let prevented = false;
  listener({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.deepEqual(harness.changes, [false, false]);
  harness.render(false);
  assert.equal(harness.listeners.has("keydown"), false);
  harness.resolveModule({ UsageHistoryReport: "loaded-report" });
  await settle();
  assert.ok(!nodes(harness.render(false)).some((node) => node.type === "loaded-report"));
});

test("a failed deferred report stays dismissible and does not reject outside the overlay", async () => {
  const harness = panelHarness();
  harness.render(true);
  await settle();
  harness.rejectModule(new Error("chunk unavailable"));
  await settle();
  const failed = nodes(harness.render(true));
  assert.ok(failed.some((node) => node.props?.role === "alert" && node.props.children === "Report failed: chunk unavailable"));
  failed.find((node) => node.type === "button" && node.props.children === "Close").props.onClick();
  assert.deepEqual(harness.changes, [false]);
});

test("successful deferred report replaces only the modal body, not the trigger", async () => {
  const harness = panelHarness();
  harness.render(true);
  await settle();
  harness.resolveModule({ UsageHistoryReport: "loaded-report" });
  await settle();
  const loaded = nodes(harness.render(true));
  assert.ok(loaded.some((node) => node.type === "loaded-report"));
  assert.equal(loaded.filter((node) => node.props?.className?.startsWith("usage-history-trigger")).length, 1);
  harness.render(false);
  harness.render(true);
  await settle();
  assert.equal(harness.moduleRequests, 1, "reopening retains the loaded report component");
});
