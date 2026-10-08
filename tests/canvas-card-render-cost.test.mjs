import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { installMiniDom } from "./helpers/mini-dom.mjs";
import { canvasCardPropsEqual } from "../src/renderer/src/features/terminal/terminalCardProps.ts";

// A pan or zoom gesture renders the workspace on every pointer move. TerminalCard is memoized so those
// renders do not reach the cards: equal props skip the card, any real change does not. Snap targets reach the
// card as a getter that stays the same function, so a neighbour's move does not render it either.

const bounds = (x, y, width = 700, height = 430) => ({ position: { x, y }, size: { width, height } });
const session = { id: "s1", position: { x: 0, y: 0 }, size: { width: 700, height: 430 } };
const callbacks = { onActivate() {}, onSelect() {}, onBoundsChange() {}, getSnapTargets() { return []; } };
const props = (overrides = {}) => ({
  session, zoom: 1, focused: false, selected: false, stackIndex: 3,
  ...callbacks, ...overrides
});

test("a card's props compare equal across a pan: same data, same callbacks and snap-target getter", () => {
  assert.equal(canvasCardPropsEqual(props(), props()), true);
});

test("any real change renders the card", () => {
  for (const change of [
    { zoom: 0.49 }, { focused: true }, { selected: true }, { stackIndex: 4 },
    { session: { ...session, title: "renamed" } },
    { onSelect() {} }, { restoreEnabled: true }
  ]) {
    assert.equal(canvasCardPropsEqual(props(), props(change)), false, JSON.stringify(Object.keys(change)));
  }
});

test("dragging one terminal card does not render the other cards", async (t) => {
  const { document, restore } = installMiniDom();
  const restoreBrowser = installBrowserStubs();
  const cleanup = [restore, restoreBrowser];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); });
  const { WorkspaceCanvas, createCameraStore, renders, cardProps } = await bundleWorkspace();
  // Every callback prop the workspace declares, as a no-op; this test only follows a card drag.
  const source = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  const declared = source.slice(source.indexOf("interface WorkspaceCanvasProps"), source.indexOf("export function WorkspaceCanvas("));
  const workspaceCallbackNames = [...declared.matchAll(/^ {2}(on[A-Z]\w*)\(/gmu)].map((match) => match[1]);
  const { createElement: h, act, Profiler } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const userData = await mkdtemp(join(tmpdir(), "canvastty-render-cost-"));
  cleanup.push(() => rm(userData, { recursive: true, force: true }));
  const settings = await new SettingsStore(userData, "en").load();
  const camera = createCameraStore({ x: 0, y: 0, zoom: 1 });
  const card = (id, x) => ({
    id, provider: "terminal", profile: "normal", title: id, status: "running", cwd: "/", startedAt: 1,
    position: { x, y: 0 }, size: { width: 400, height: 300 }, exitCode: null
  });
  let sessions = [card("a", 0), card("b", 500), card("c", 1000)];
  let workspaceRenders = 0;
  const props = () => ({
    ...Object.fromEntries(workspaceCallbackNames.map((name) => [name, () => undefined])),
    settings, surfacesMounted: true, mediaData: null, materials: [], remarks: [], sessions, limits: null, limitsLoadState: "idle", plugins: [],
    browser: { open: false, tabs: [] }, browserViewVisible: false, homeEditing: false, camera, activeSessionId: "a",
    browserSelected: false, renamingSessionId: null, fullscreenSessionId: null,
    onSessionBoundsChange: (id, bounds) => { sessions = sessions.map((session) => session.id === id ? { ...session, ...bounds } : session); }
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    // The shared WebGL context pool plans once the viewport settles (200 ms); let that run while the DOM exists.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  const render = () => act(async () => root.render(h(Profiler, { id: "workspace", onRender: () => { workspaceRenders += 1; } },
    h(WorkspaceCanvas, { ...props() }))));
  await render();
  await act(async () => undefined);
  assert.deepEqual([...renders], [["a", 1], ["b", 1], ["c", 1]], "each card rendered once when it mounted");

  const before = workspaceRenders;
  for (let step = 1; step <= 5; step += 1) {
    await act(async () => cardProps.get("a").onBoundsPreview("a", { position: { x: step * 10, y: 0 }, size: { width: 400, height: 300 } }));
  }
  await act(async () => cardProps.get("a").onBoundsChange("a", { position: { x: 50, y: 0 }, size: { width: 400, height: 300 } }));
  await render();
  assert.ok(workspaceRenders > before, "the drag rendered the workspace");
  assert.equal(renders.get("a") > 1, true, "the dragged card drew its new position");
  assert.equal(renders.get("b"), 1, "an untouched card is not rendered by a neighbour's drag");
  assert.equal(renders.get("c"), 1, "an untouched card is not rendered by a neighbour's drag");
});

const repository = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

/**
 * The real WorkspaceCanvas with a counting TerminalCard. The counting card is memoized with the real TerminalCard's
 * own comparison, so the workspace decides, as in the app, which cards a change reaches.
 */
async function bundleWorkspace() {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        export { WorkspaceCanvas } from "./src/renderer/src/features/workspace/WorkspaceCanvas.tsx";
        export { createCameraStore } from "./src/renderer/src/features/workspace/cameraStore.ts";
        export { renders, cardProps } from "counting-terminal-card";`,
      resolveDir: repository,
      loader: "ts"
    },
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    write: false,
    logLevel: "silent",
    loader: Object.fromEntries([".svg", ".css", ".png", ".ico", ".jpg", ".webp", ".avif", ".gif", ".woff", ".woff2", ".ttf"]
      .map((extension) => [extension, "empty"])),
    define: { "import.meta.env.MODE": "\"test\"", "import.meta.glob": "globalThis.__canvasttyTestGlob" },
    plugins: [{
      name: "counting-terminal-card",
      setup(builder) {
        builder.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
        builder.onResolve({ filter: /(^|\/)terminal\/TerminalCard$|^counting-terminal-card$/ }, () => ({ path: "card", namespace: "counting" }));
        builder.onLoad({ filter: /.*/, namespace: "counting" }, () => ({
          resolveDir: repository,
          loader: "tsx",
          contents: `
            import { memo } from "react";
            import { TerminalCard as RealTerminalCard } from "./src/renderer/src/features/terminal/TerminalCard.tsx";
            export const renders = new Map();
            export const cardProps = new Map();
            function CountingTerminalCard(props) {
              renders.set(props.session.id, (renders.get(props.session.id) ?? 0) + 1);
              cardProps.set(props.session.id, props);
              return <div data-session-id={props.session.id} />;
            }
            if (!RealTerminalCard.compare) throw new Error("TerminalCard is not memoized");
            export const TerminalCard = memo(CountingTerminalCard, RealTerminalCard.compare);`
        }));
      }
    }]
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
}

/** Browser APIs the workspace touches on mount; the preload API answers every call with an empty result. */
function installBrowserStubs() {
  const names = ["__canvasttyTestGlob", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "IntersectionObserver",
    "matchMedia", "innerWidth", "innerHeight", "devicePixelRatio", "canvasTTY"];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const observer = class { observe() {} unobserve() {} disconnect() {} };
  // A preload call is awaited by some callers and used as an unsubscribe function by others.
  const answer = () => Object.assign(() => undefined, {
    then: (resolve) => resolve(undefined), catch: () => Promise.resolve(), finally: (callback) => { callback?.(); return Promise.resolve(); }
  });
  Object.assign(globalThis, {
    __canvasttyTestGlob: () => ({}),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: observer,
    IntersectionObserver: observer,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    canvasTTY: new Proxy({}, { get: (_target, key) => key === "window" ? { isMacOS: true } : new Proxy({}, { get: () => answer }) })
  });
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}
