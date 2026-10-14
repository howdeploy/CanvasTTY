import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findAll, importWithFakeReact, tick } from "./helpers/fake-react.mjs";
import { arrangeCanvasAutoSort, planCanvasAutoSort } from "../src/renderer/src/features/workspace/canvasAutoSort.ts";
import {
  CANVAS_AUTO_SORT_MODES,
  canvasAutoSortScope,
  canvasAutoSortUndoTargets
} from "../src/renderer/src/features/workspace/canvasAutoSortScope.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const card = (x = 0, y = 0, width = 700, height = 430) => ({ position: { x, y }, size: { width, height } });
const overlaps = (a, b) => a.position.x < b.position.x + b.size.width
  && a.position.x + a.size.width > b.position.x
  && a.position.y < b.position.y + b.size.height
  && a.position.y + a.size.height > b.position.y;
const assertDisjoint = (placements) => {
  const entries = [...placements.entries()];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      assert.equal(overlaps(entries[i][1], entries[j][1]), false, `${entries[i][0]} overlaps ${entries[j][0]}`);
    }
  }
};
const HOME = card(0, 0, 1_600, 1_200);
const GAP = 20;
const grown = (bounds, by) => card(bounds.position.x - by, bounds.position.y - by, bounds.size.width + 2 * by, bounds.size.height + 2 * by);
const blockOf = (placements) => {
  const all = [...placements.values()];
  const left = Math.min(...all.map((b) => b.position.x));
  const top = Math.min(...all.map((b) => b.position.y));
  return card(left, top, Math.max(...all.map((b) => b.position.x + b.size.width)) - left,
    Math.max(...all.map((b) => b.position.y + b.size.height)) - top);
};
const STATUSES = ["working", "needs_approval", "done", "failed", "idle", "unavailable"];

function mixedItems(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `terminal:s${index}`,
    bounds: card(2_000 + (index % 7) * 97, 300 + (index % 5) * 61, 420 + (index % 4) * 90, 260 + (index % 5) * 70),
    ...(index > 0 && index % 3 !== 0 ? { parentId: `terminal:s${Math.floor((index - 1) / 3)}` } : {}),
    status: STATUSES[index % STATUSES.length],
    project: ["/work/one", "/work/two/", "/work/three"][index % 3],
    startedAt: 1_000 + index
  }));
}

test("every criterion keeps mixed-size windows disjoint, sizes unchanged, and clear of HOME", () => {
  for (let count = 1; count <= 40; count += 1) {
    const items = mixedItems(count);
    for (const mode of CANVAS_AUTO_SORT_MODES) {
      const result = arrangeCanvasAutoSort(items, mode, { avoid: [HOME] });
      assert.deepEqual([...result.keys()].sort(), items.map((item) => item.id).sort());
      assertDisjoint(result);
      for (const item of items) {
        assert.deepEqual(result.get(item.id).size, item.bounds.size, `${mode} keeps ${item.id} size`);
        assert.equal(overlaps(result.get(item.id), HOME), false, `${mode} keeps ${item.id} off HOME`);
      }
    }
  }
});

test("auto-sort is deterministic: input order does not matter and sorting twice changes nothing", () => {
  const items = mixedItems(13);
  const reversed = [...items].reverse();
  for (const mode of CANVAS_AUTO_SORT_MODES) {
    const first = arrangeCanvasAutoSort(items, mode, { avoid: [HOME], snapToGrid: true });
    assert.deepEqual(arrangeCanvasAutoSort(reversed, mode, { avoid: [HOME], snapToGrid: true }), first, `${mode} ignores list order`);
    const again = arrangeCanvasAutoSort(
      items.map((item) => ({ ...item, bounds: first.get(item.id) })),
      mode,
      { avoid: [HOME], snapToGrid: true }
    );
    assert.deepEqual(again, first, `${mode} is idempotent`);
  }
});

test("the block stays at the windows' top-left corner and moves off HOME by the shorter way only when it would cover it", () => {
  const away = [
    { id: "a", bounds: card(3_013, 517) },
    { id: "b", bounds: card(5_000, 900) }
  ];
  const kept = arrangeCanvasAutoSort(away, "grid", { avoid: [HOME] });
  assert.deepEqual(kept.get("a").position, { x: 3_013, y: 517 });
  const snapped = arrangeCanvasAutoSort(away, "grid", { avoid: [HOME], snapToGrid: true });
  assert.deepEqual(snapped.get("a").position, { x: 3_010, y: 520 });

  // Two 700-wide cards side by side: leaving HOME downwards (1,120) is shorter than to the right (1,520).
  const onHome = [
    { id: "a", bounds: card(100, 100) },
    { id: "b", bounds: card(200, 900) }
  ];
  const moved = arrangeCanvasAutoSort(onHome, "grid", { avoid: [HOME] });
  assert.deepEqual(blockOf(moved).position, { x: 100, y: HOME.size.height + GAP });
  // A tall column next to HOME's right edge leaves to the right.
  const tall = arrangeCanvasAutoSort([
    { id: "a", bounds: card(1_500, 0, 300, 2_000) },
    { id: "b", bounds: card(1_500, 2_100, 300, 2_000) }
  ], "grid", { avoid: [HOME] });
  assert.deepEqual(blockOf(tall).position, { x: HOME.size.width + GAP, y: 0 });
});

test("with snapping the block is snapped first, then checked against HOME, then moved off it onto the grid", () => {
  for (const [x, y] of [[1_585, 40], [1_596, 40], [1_612, 333], [1_619, 0], [40, 1_185], [333, 1_214]]) {
    const items = [{ id: "a", bounds: card(x, y, 455, 333) }, { id: "b", bounds: card(x + 7, y + 900, 455, 333) }];
    for (const mode of CANVAS_AUTO_SORT_MODES) {
      const result = arrangeCanvasAutoSort(items, mode, { avoid: [HOME], snapToGrid: true });
      for (const bounds of result.values()) {
        assert.equal(bounds.position.x % 10, 0, `${mode} from ${x},${y}: x on the grid`);
        assert.equal(bounds.position.y % 10, 0, `${mode} from ${x},${y}: y on the grid`);
        assert.equal(overlaps(grown(bounds, GAP), HOME), false, `${mode} from ${x},${y}: the gap to HOME is kept`);
      }
    }
  }
  // Already clear of HOME by the gap once snapped: the block stays where it is.
  const clear = arrangeCanvasAutoSort([
    { id: "a", bounds: card(1_624, 0) }, { id: "b", bounds: card(1_624, 600) }
  ], "grid", { avoid: [HOME], snapToGrid: true });
  assert.deepEqual(blockOf(clear).position, { x: 1_620, y: 0 });
});

test("with snapping every window lands on the 10px grid with at least the 20px snapping gap", () => {
  for (let count = 2; count <= 40; count += 1) {
    const items = mixedItems(count).map((item, index) => ({
      ...item,
      bounds: card(item.bounds.position.x + 3, item.bounds.position.y + 7, item.bounds.size.width + (index % 9), item.bounds.size.height + (index % 7))
    }));
    for (const mode of CANVAS_AUTO_SORT_MODES) {
      const result = arrangeCanvasAutoSort(items, mode, { avoid: [HOME], snapToGrid: true });
      const entries = [...result.entries()];
      for (const [id, bounds] of entries) {
        assert.equal(bounds.position.x % 10, 0, `${mode} ${id} x`);
        assert.equal(bounds.position.y % 10, 0, `${mode} ${id} y`);
      }
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          assert.equal(overlaps(grown(entries[i][1], GAP), entries[j][1]), false, `${mode}: ${entries[i][0]} and ${entries[j][0]} keep the gap`);
        }
      }
    }
  }
  const neighbours = arrangeCanvasAutoSort([{ id: "a", bounds: card(3_000, 0) }, { id: "b", bounds: card(3_000, 600) }], "grid", {});
  assert.equal(neighbours.get("b").position.x - (neighbours.get("a").position.x + 700), GAP, "neighbours sit exactly one gap apart");
});

test("the block keeps clear of regions, notes and windows it does not move, and never lands inside a region", () => {
  const layerIdOf = (id) => `terminal:${id}`;
  const region = card(3_000, 0, 1_000, 3_000);
  const bounds = new Map([
    ["terminal:a", card(2_400, 100, 500, 300)],
    ["terminal:b", card(2_400, 600, 500, 300)],
    ["note:n", card(2_000, 1_300, 300, 200)],
    ["terminal:kept", card(2_000, 1_700, 500, 300)]
  ]);
  const plan = planCanvasAutoSort(["terminal:a", "terminal:b"], bounds, [], layerIdOf, "grid", { avoid: [HOME, region], snapToGrid: true });
  const block = blockOf(plan.after);
  for (const obstacle of [HOME, region, bounds.get("note:n"), bounds.get("terminal:kept")]) {
    assert.equal(overlaps(grown(block, GAP), obstacle), false, `clear of ${JSON.stringify(obstacle)}`);
  }
  assert.ok(block.position.x >= region.position.x + region.size.width || block.position.y >= region.position.y + region.size.height,
    "the block is past the region, not inside it");

  // A region all around the windows' corner: the block still ends outside it.
  const around = card(1_900, -100, 3_000, 3_000);
  const inside = planCanvasAutoSort(["terminal:a", "terminal:b"], bounds, [], layerIdOf, "grid", { avoid: [around] });
  assert.equal(overlaps(blockOf(inside.after), around), false);
});

test("by task puts each subagent to the right of the session that spawned it and survives parent cycles", () => {
  const items = [
    { id: "terminal:lead", bounds: card(0, 2_000) },
    { id: "terminal:sub-b", parentId: "terminal:lead", bounds: card(900, 2_900) },
    { id: "terminal:sub-a", parentId: "terminal:lead", bounds: card(-500, 2_100) },
    { id: "terminal:solo", bounds: card(300, 1_500) },
    { id: "terminal:orphan", parentId: "terminal:closed", bounds: card(4_000, 4_000) }
  ];
  const result = arrangeCanvasAutoSort(items, "task", {});
  const lead = result.get("terminal:lead");
  for (const sub of ["terminal:sub-a", "terminal:sub-b"]) {
    assert.ok(result.get(sub).position.x >= lead.position.x + lead.size.width, `${sub} is right of its parent`);
  }
  assert.ok(result.get("terminal:sub-a").position.y < result.get("terminal:sub-b").position.y, "siblings keep reading order");
  assert.equal(result.get("terminal:orphan").position.x, result.get("terminal:solo").position.x, "a missing parent makes a root");
  assert.ok(result.get("terminal:solo").position.y < lead.position.y, "roots keep reading order");

  const cycle = arrangeCanvasAutoSort([
    { id: "x", parentId: "y", bounds: card(0, 0) },
    { id: "y", parentId: "x", bounds: card(0, 600) }
  ], "task", {});
  assert.equal(cycle.size, 2);
  assertDisjoint(cycle);
});

test("status columns run attention, working, idle, done, failed, unavailable; project columns merge trailing slashes", () => {
  const order = ["unavailable", "failed", "done", "idle", "working", "needs_approval"];
  const items = order.map((status, index) => ({ id: status, status, bounds: card(index * 800, 3_000) }));
  const result = arrangeCanvasAutoSort(items, "status", {});
  const columns = [...items].sort((a, b) => result.get(a.id).position.x - result.get(b.id).position.x).map((item) => item.id);
  assert.deepEqual(columns, ["needs_approval", "working", "idle", "done", "failed", "unavailable"]);

  const projects = arrangeCanvasAutoSort([
    { id: "browser", bounds: card(0, 0) },
    { id: "b1", project: "/work/b/", bounds: card(0, 500) },
    { id: "a1", project: "/work/a", bounds: card(0, 1_000) },
    { id: "b2", project: "/work/b", bounds: card(0, 1_500) }
  ], "project", {});
  const right = (id) => projects.get(id).position.x + projects.get(id).size.width;
  for (const id of ["b1", "b2"]) {
    assert.ok(projects.get(id).position.x > right("a1"), `${id} is in the /work/b group after /work/a`);
    assert.ok(right(id) < projects.get("browser").position.x, "windows without a folder come last");
  }
  assert.equal(projects.get("b1").position.y, projects.get("b2").position.y, "/work/b and /work/b/ form one group");
});

test("a plan reads session relations and the bounds of that moment, and needs two live windows", () => {
  const layerIdOf = (id) => `terminal:${id}`;
  const sessions = [
    { id: "lead", status: "working", cwd: "/work", startedAt: 1 },
    { id: "sub", parentSessionId: "lead", status: "needs_approval", cwd: "/work", startedAt: 2 }
  ];
  const bounds = new Map([["terminal:lead", card(3_000, 0)], ["terminal:sub", card(3_000, 900)], ["browser", card(3_000, 1_800)]]);
  const plan = planCanvasAutoSort(["terminal:lead", "terminal:sub", "browser", "terminal:closed"], bounds, sessions, layerIdOf, "task", { avoid: [HOME] });
  assert.deepEqual([...plan.before.keys()], ["terminal:lead", "terminal:sub", "browser"]);
  assert.deepEqual(plan.before.get("terminal:sub"), card(3_000, 900));
  assert.notEqual(plan.before.get("terminal:sub"), bounds.get("terminal:sub"), "undo keeps its own copy");
  assert.ok(plan.after.get("terminal:sub").position.x > plan.after.get("terminal:lead").position.x, "subagent right of its lead");
  assert.equal(planCanvasAutoSort(["terminal:lead", "terminal:closed"], bounds, sessions, layerIdOf, "grid", {}), null);
});

test("scope: a selection limits the sort; otherwise windows outside regions, never notes, materials or Files cards", () => {
  const region = card(5_000, 0, 2_000, 2_000);
  const candidates = [
    { id: "terminal:a", kind: "terminal", bounds: card(0, 0) },
    { id: "terminal:in-region", kind: "terminal", bounds: card(5_100, 100) },
    { id: "plugin:app", kind: "plugin", bounds: card(0, 800) },
    { id: "plugin:mascot", kind: "plugin", bounds: card(0, 1_600), decorative: true },
    { id: "browser", kind: "browser", bounds: card(900, 0) },
    { id: "note:n", kind: "note", bounds: card(0, 3_000) },
    { id: "material:m", kind: "material", bounds: card(0, 4_000) },
    { id: "files:f", kind: "files", bounds: card(0, 5_000) }
  ];
  assert.deepEqual(canvasAutoSortScope(candidates, new Set(), [region]), ["terminal:a", "plugin:app", "browser"]);
  assert.deepEqual(canvasAutoSortScope(candidates, new Set(["terminal:a"]), [region]), ["terminal:a", "plugin:app", "browser"],
    "a single selected card is not a group");
  assert.deepEqual(
    canvasAutoSortScope(candidates, new Set(["terminal:in-region", "plugin:mascot", "note:n", "files:f"]), [region]),
    ["terminal:in-region", "plugin:mascot"],
    "an explicit selection includes region contents and mascots but still never notes or Files cards"
  );
  const fallback = ["terminal:a", "plugin:app", "browser"];
  assert.deepEqual(canvasAutoSortScope(candidates, new Set(["note:n", "files:f"]), [region]), fallback,
    "a selection without two windows (two notes) falls back to the default scope");
  assert.deepEqual(canvasAutoSortScope(candidates, new Set(["terminal:in-region", "note:n", "material:m"]), [region]), fallback,
    "one selected window plus annotations falls back too");
});

test("undo restores only windows still where the sort put them", () => {
  const before = new Map([["a", card(0, 0)], ["b", card(0, 600)], ["c", card(0, 1_200)], ["d", card(0, 1_800)]]);
  const after = new Map([["a", card(2_000, 0)], ["b", card(2_800, 0)], ["c", card(3_600, 0)], ["d", card(0, 1_800)]]);
  const current = new Map([
    ["a", card(2_000, 0)],
    ["b", card(2_810, 0)],
    ["d", card(0, 1_800)]
  ]);
  const restore = canvasAutoSortUndoTargets({ mode: "grid", before, after }, current);
  assert.deepEqual([...restore.keys()], ["a"], "moved (b), closed (c) and unmoved (d) windows are left alone");
  assert.deepEqual(restore.get("a"), card(0, 0));
});

const menuModule = await importWithFakeReact("src/renderer/src/features/workspace/CanvasContextMenu.tsx", "CanvasContextMenu");
const toolsModule = await importWithFakeReact("src/renderer/src/features/workspace/CanvasAutoSortMenu.tsx", "CanvasAutoSortMenu");
const brokenMenuModule = await importWithFakeReact("src/renderer/src/features/workspace/CanvasContextMenu.tsx", "CanvasContextMenu", {
  plugins: [{
    name: "broken-tools-chunk",
    setup(builder) {
      builder.onResolve({ filter: /CanvasAutoSortMenu$/ }, () => ({ path: "broken", namespace: "broken" }));
      builder.onLoad({ filter: /.*/, namespace: "broken" }, () => ({ contents: 'throw new Error("chunk failed");', loader: "js" }));
    }
  }]
});

const terminal = (id, x, y, extra = {}) => [`terminal:${id}`, card(x, y), { id, status: "idle", cwd: "/work", startedAt: 1, ...extra }];

/** A workspace host: the layers of the moment plus spies for what the Tools submenu asks of it. */
function host(windows, other = {}) {
  const calls = { commit: [], state: [], mark: [], error: [] };
  const value = {
    bounds: new Map([...windows.map(([id, bounds]) => [id, bounds]), ...(other.layers ?? [])]),
    selection: other.selection ?? new Set(),
    home: HOME,
    regions: other.regions ?? [],
    sessions: windows.map(([, , session]) => session).filter(Boolean),
    pluginCanvas: other.pluginCanvas ?? [],
    plugins: other.plugins ?? [],
    snapToGrid: other.snapToGrid ?? true,
    state: other.state ?? { mode: null, undo: null },
    setState: (state) => calls.state.push(state),
    commit: (next) => calls.commit.push(next),
    mark: (ids) => calls.mark.push([...ids]),
    onError: (message) => calls.error.push(message)
  };
  return { value, calls };
}

function menuHarness(t, props = {}, module = menuModule) {
  const oldWindow = globalThis.window;
  globalThis.window = { canvasTTY: { window: { isMacOS: false } }, getComputedStyle: () => ({ fontSize: "13px" }) };
  module.__reset();
  const oldError = console.error;
  console.error = () => undefined;
  t.after(() => { module.__unmount(); globalThis.window = oldWindow; console.error = oldError; });
  let closed = 0;
  const noop = () => undefined;
  const all = new Proxy({
    kind: "empty", position: { x: 0, y: 0 }, locale: "en", launcherItems: [], currentRegionColor: null,
    materialHasLocation: false, onSendMaterial: null, onSendRemarks: null,
    autoSort: host([]).value, onClose: () => { closed += 1; },
    ...props
  }, { get: (target, key) => (key in target ? target[key] : noop) });
  let tree;
  const render = () => { module.__flush(); tree = module.__render(module.CanvasContextMenu, all); return tree; };
  const row = (label) => findAll(tree, (node) => node.props?.role === "menuitem" && node.props.children === label)[0];
  const tools = () => findAll(tree, (node) => node.type?.name === "CanvasAutoSortMenu")[0];
  const openTools = async () => {
    row(props.locale === "ru" ? "Инструменты" : "Tools").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 0 }) } });
    for (let i = 0; i < 3; i += 1) { render(); await tick(); }
    render();
  };
  render();
  return { render, row, tools, openTools, closed: () => closed };
}

function toolsMenu(hostValue, locale = "en") {
  let done = 0;
  const tree = toolsModule.CanvasAutoSortMenu({ host: hostValue, locale, className: "canvas-menu", onDone: () => { done += 1; } });
  const rows = findAll(tree, (node) => typeof node.props?.role === "string" && node.props.role.startsWith("menuitem"));
  return {
    tree,
    rows,
    radios: rows.filter((node) => node.props.role === "menuitemradio"),
    row: (label) => rows.find((node) => node.props.children === label),
    text: JSON.stringify(tree),
    done: () => done
  };
}

test("the empty-canvas menu has one Tools row that loads its submenu on demand", async (t) => {
  const sortHost = host([]).value;
  const ui = menuHarness(t, { autoSort: sortHost });
  assert.ok(ui.row("Tools"), "Tools is in the empty-canvas menu");
  assert.equal(ui.row("Tools").props["aria-expanded"], false);
  assert.equal(ui.tools(), undefined, "the submenu is not rendered until Tools opens");
  await ui.openTools();
  assert.equal(ui.row("Tools").props["aria-expanded"], true);
  const tools = ui.tools();
  assert.ok(tools, "the loaded submenu is shown");
  assert.equal(tools.props.host, sortHost);
  assert.match(tools.props.className, /canvas-menu__submenu canvas-menu__submenu--right/);
  tools.props.onDone();
  assert.equal(ui.closed(), 1, "running an action closes the menu");

  for (const kind of ["region", "note", "material"]) {
    assert.equal(menuHarness(t, { kind }).row("Tools"), undefined, `no Tools row in the ${kind} menu`);
  }
});

test("the Tools submenu body loads while the empty-canvas menu is open, so Tools shows it at once", async (t) => {
  // A fresh copy of the menu module: nothing loaded yet.
  const fresh = await importWithFakeReact("src/renderer/src/features/workspace/CanvasContextMenu.tsx", "CanvasContextMenu");
  const ui = menuHarness(t, {}, fresh);
  for (let i = 0; i < 3; i += 1) { ui.render(); await tick(); }
  ui.row("Tools").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 0 }) } });
  ui.render();
  assert.ok(ui.tools(), "the first render after Tools already shows the submenu");
});

test("opening Tools closes the launcher submenu and the other way round", async (t) => {
  const ui = menuHarness(t);
  await ui.openTools();
  ui.row("Launch agent").props.onClick();
  ui.render();
  assert.equal(ui.row("Tools").props["aria-expanded"], false);
  assert.equal(ui.row("Launch agent").props["aria-expanded"], true);
  await ui.openTools();
  assert.equal(ui.row("Launch agent").props["aria-expanded"], false);
});

test("if the Tools submenu cannot be loaded the person gets a localized toast and the row closes", async (t) => {
  const { value, calls } = host([]);
  const ui = menuHarness(t, { autoSort: value, locale: "ru" }, brokenMenuModule);
  await ui.openTools();
  assert.deepEqual(calls.error, ["Автосортировка не удалась"]);
  assert.equal(ui.row("Инструменты").props["aria-expanded"], false);
  assert.equal(ui.tools(), undefined);
});

test("the Tools submenu lists the criteria as radio rows and sorts, outlines and remembers the criterion", () => {
  const { value, calls } = host([terminal("a", 3_000, 0), terminal("b", 3_000, 900), terminal("c", 5_000, 400)]);
  const menu = toolsMenu(value);
  assert.deepEqual(menu.radios.map((node) => node.props.children), ["By task", "By status", "By project", "Grid"]);
  assert.ok(menu.radios.every((node) => node.props["aria-checked"] === false && !node.props.disabled));
  assert.equal(menu.row("Undo auto-sort"), undefined, "no undo before a sort");
  assert.doesNotMatch(menu.text, /needs at least 2 windows/);

  menu.row("Grid").props.onClick();
  assert.equal(menu.done(), 1);
  assert.equal(calls.commit.length, 1);
  const moved = calls.commit[0];
  assert.deepEqual([...moved.keys()].sort(), ["terminal:a", "terminal:b", "terminal:c"]);
  assert.deepEqual(calls.mark.map((ids) => ids.sort()), [["terminal:a", "terminal:b", "terminal:c"]], "the moved windows are outlined");
  assert.equal(calls.state.length, 1);
  assert.equal(calls.state[0].mode, "grid");
  assert.deepEqual(calls.state[0].undo.after, moved);

  // The next menu checks the criterion and offers undo while a window is still where the sort put it.
  const after = host([...moved].map(([id, bounds]) => [id, bounds]), { state: calls.state[0] });
  const next = toolsMenu(after.value);
  assert.deepEqual(next.radios.filter((node) => node.props["aria-checked"] === true).map((node) => node.props.children), ["Grid"]);
  next.row("Undo auto-sort").props.onClick();
  // terminal:a already sat at the block's corner, so only the windows that actually moved go back.
  assert.deepEqual(moved.get("terminal:a"), card(3_000, 0));
  assert.deepEqual(after.calls.commit[0], new Map([["terminal:b", card(3_000, 900)], ["terminal:c", card(5_000, 400)]]));
  assert.deepEqual(after.calls.mark.map((ids) => ids.sort()), [["terminal:b", "terminal:c"]]);
  assert.deepEqual(after.calls.state, [{ mode: "grid", undo: null }]);
});

test("a selection without two windows does not narrow the sort, and too few windows disable it with a hint", () => {
  const windows = [terminal("a", 3_000, 0), terminal("b", 3_000, 900)];
  const notes = [["note:1", card(9_000, 0)], ["note:2", card(9_000, 900)]];
  const selectedNotes = host(windows, { layers: notes, selection: new Set(["note:1", "note:2"]) });
  const menu = toolsMenu(selectedNotes.value);
  assert.ok(menu.radios.every((node) => !node.props.disabled), "two selected notes fall back to the default scope");
  menu.row("By task").props.onClick();
  assert.deepEqual([...selectedNotes.calls.commit[0].keys()].sort(), ["terminal:a", "terminal:b"]);

  const lonely = host([terminal("a", 3_000, 0)], { layers: notes });
  const ru = toolsMenu(lonely.value, "ru");
  assert.ok(ru.radios.every((node) => node.props.disabled === true));
  assert.match(ru.text, /нужно минимум 2 окна/);
  ru.radios[0].props.onClick();
  assert.deepEqual(lonely.calls.state, [], "the criterion is kept only once a sort happened");
  assert.deepEqual(lonely.calls.commit, []);
});

test("a sort that throws reports a localized toast instead of leaving the menu half done", () => {
  const { value, calls } = host([terminal("a", 3_000, 0), terminal("b", 3_000, 900)]);
  value.commit = () => { throw new Error("boom"); };
  const oldError = console.error;
  console.error = () => undefined;
  try {
    const menu = toolsMenu(value);
    menu.row("Grid").props.onClick();
    assert.deepEqual(calls.error, ["Auto-sort failed"]);
    assert.equal(menu.done(), 1);
    assert.deepEqual(calls.state, [], "no criterion or undo step is kept for a failed sort");
  } finally {
    console.error = oldError;
  }
});

// Wiring that only the whole workspace shows; kept to the few facts a behaviour test cannot reach.
test("the workspace keeps auto-sort out of the startup bundle, outlines sorted windows without selecting them, and adds no undo shortcut", async () => {
  const [canvas, menu] = await Promise.all([
    source("src/renderer/src/features/workspace/WorkspaceCanvas.tsx"),
    source("src/renderer/src/features/workspace/CanvasContextMenu.tsx")
  ]);
  for (const code of [canvas, menu]) {
    assert.doesNotMatch(code, /^import (?!type)[^;]*from "\.\/(canvasAutoSort|CanvasAutoSortMenu|canvasAutoSortScope)";/m);
  }
  assert.doesNotMatch(canvas, /setMarqueeSelection\(new Set\((plan|restore)/, "a sort never turns its windows into a drag group");
  assert.match(canvas, /groupSelected=\{marqueeSelection\.has\(terminalLayerId\(session\.id\)\) \|\| autoSortMarked\.has/);
  assert.match(canvas, /element\?\.addEventListener\("pointerdown", clear, true\)/, "the next press clears the outline");
  assert.doesNotMatch(canvas, /key === "z"|KeyZ|"Mod\+Z"|ctrl\+z/i, "no global undo shortcut");
});

test("auto-sort strings exist in every locale and new code uses tokens, vendored icons and no literal glyphs", async () => {
  const [i18n, menu, tools, sorter, scope, styles, icons, readme, wrench, undo] = await Promise.all([
    source("src/renderer/src/lib/i18n.ts"),
    source("src/renderer/src/features/workspace/CanvasContextMenu.tsx"),
    source("src/renderer/src/features/workspace/CanvasAutoSortMenu.tsx"),
    source("src/renderer/src/features/workspace/canvasAutoSort.ts"),
    source("src/renderer/src/features/workspace/canvasAutoSortScope.ts"),
    source("src/renderer/src/styles/app.css"),
    source("src/renderer/src/components/UiIcon.tsx"),
    source("src/renderer/src/assets/icons/lucide/README.md"),
    source("src/renderer/src/assets/icons/lucide/wrench.svg"),
    source("src/renderer/src/assets/icons/lucide/undo-2.svg")
  ]);
  const enStart = i18n.indexOf("const en: Record<keyof typeof ru, string> = {");
  const ru = i18n.slice(0, enStart);
  const en = i18n.slice(enStart);
  const keys = ["canvasMenuTools", "canvasAutoSort", "canvasAutoSortTask", "canvasAutoSortStatus", "canvasAutoSortProject",
    "canvasAutoSortGrid", "canvasAutoSortUnavailable", "canvasAutoSortUndo", "canvasAutoSortFailed"];
  for (const key of keys) {
    const ruValue = ru.match(new RegExp(`\\n  ${key}: "([^"]+)"`))?.[1];
    const enValue = en.match(new RegExp(`\\n  ${key}: "([^"]+)"`))?.[1];
    assert.ok(ruValue && enValue, `${key} is translated in ru and en`);
    assert.match(ruValue, /[а-яё]/i, `${key} has a Russian value`);
    assert.doesNotMatch(enValue, /[а-яё]/i, `${key} has an English value`);
  }

  const toolsBlock = menu.slice(menu.indexOf('icon="wrench"'), menu.indexOf('{kind === "region" && ('));
  for (const code of [toolsBlock, tools, sorter, scope]) {
    assert.doesNotMatch(code, /#[\da-f]{3,8}\b|rgba?\(/i);
    assert.doesNotMatch(code, /[›▸▶→↶↺×✓✔]/u, "icons come from UiIcon, not literal glyphs");
  }
  const sortStyles = styles.split("\n").filter((line) => line.includes("auto-sorting") || line.includes("canvas-menu__check")
    || line.includes("canvas-menu__row:disabled"));
  assert.ok(sortStyles.length >= 4);
  for (const line of sortStyles) assert.doesNotMatch(line, /#[\da-f]{3,8}\b|rgba?\(|\d+px/i, line);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{ \.workspace--auto-sorting [^}]*transition: none; \}/);
  assert.doesNotMatch(styles, /\.workspace--auto-sorting :is\(\.terminal-card, \.plugin-canvas-card\) \{[^}]*\.browser-card/, "the native Browser view never glides");
  // Zoomed out, the outline of the moved windows keeps its on-screen thickness: it grows with the summary scale.
  assert.match(styles, /\.workspace--auto-sorting :is\(\.terminal-card--summary\.terminal-card--selected, \.plugin-canvas-card--summary\.plugin-canvas-card--selected, \.browser-card--summary\.browser-card--selected\) \{ box-shadow: 0 0 0 calc\([^)]*var\(--summary-scale, 1\)\) var\(--primary\)/);
  // "Needs at least 2 windows" is a plain muted hint, not the uppercase group label.
  assert.match(tools, /\{!available && <p className="canvas-menu__hint">\{t\(locale, "canvasAutoSortUnavailable"\)\}<\/p>\}/);
  const hint = styles.match(/\.canvas-menu__hint \{[^}]*\}/)[0];
  const disabledRow = styles.match(/\.canvas-menu__row:disabled \{[^}]*\}/)[0];
  assert.match(hint, /padding: [^;]*calc\(1\.55em \/ \.92\)/, "the hint's text lines up with the indented rows despite its smaller font");
  assert.match(hint, /color: var\(--text\); opacity: \.5;/, "as quiet as the disabled rows it explains");
  assert.match(disabledRow, /opacity: \.5/);
  assert.doesNotMatch(styles.match(/\.canvas-menu__hint \{[^}]*\}/)[0], /uppercase|font-mono/);

  assert.match(icons, /import undoIcon from "\.\.\/assets\/icons\/lucide\/undo-2\.svg";/);
  assert.match(icons, /import wrenchIcon from "\.\.\/assets\/icons\/lucide\/wrench\.svg";/);
  assert.match(readme, /`wrench`, `undo-2`/);
  for (const svg of [wrench, undo]) {
    assert.match(svg, /^<svg\n  xmlns="http:\/\/www\.w3\.org\/2000\/svg"\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"/);
    assert.match(svg, /stroke="currentColor"/);
  }
});

test("the UI contract documents Tools and Auto-sort in every language", async () => {
  const [en, ru, zh] = await Promise.all([
    source("docs/UI_CONTRACT.md"),
    source("docs/UI_CONTRACT.ru.md"),
    source("docs/UI_CONTRACT.zh-CN.md")
  ]);
  assert.match(en, /a \*\*Tools\*\* submenu[\s\S]*\*\*Auto-sort\*\*[\s\S]*\*\*Undo auto-sort\*\*/);
  assert.match(ru, /\*\*Инструменты\*\*[\s\S]*\*\*Автосортировка\*\*[\s\S]*\*\*Отменить автосортировку\*\*/);
  assert.match(zh, /\*\*Tools\*\*[\s\S]*\*\*Auto-sort\*\*[\s\S]*\*\*Undo auto-sort\*\*/);
});
