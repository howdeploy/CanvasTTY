import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformSync } from "esbuild";

const source = await readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const chooseFileFolder =");
const end = source.indexOf("  const openFileDirectory =", start);
assert.ok(start >= 0 && end > start);
const code = transformSync(source.slice(start, end), { loader: "ts" }).code;
const tick = () => new Promise(setImmediate);
const descriptor = (rootId) => ({ rootId, label: rootId, available: true });

function selection(t) {
  const previousWindow = globalThis.window;
  const pending = [];
  const closed = [], loaded = [], updates = [], runtime = [];
  const settingsRef = { current: { fileCards: [{ id: "card" }] } };
  const request = () => { const deferred = Promise.withResolvers(); pending.push(deferred); return deferred.promise; };
  globalThis.window = { canvasTTY: { files: {
    openFolder: request, registerRoot: request,
    closeRoot: async (rootId) => { closed.push(rootId); }
  } } };
  t.after(() => { globalThis.window = previousWindow; });
  // Execute the production App callbacks with deferred IPC and an observable card/root boundary.
  const callbacks = new Function("useCallback", "settingsRef", "releaseFileCardRoot", "fileReadSequence", "fileRootRequests", "updateFileCard", "loadFileRoot", "updateFileCardRuntime", "fileErrorMessage", `${code}; return { chooseFileFolder, registerFileSession };`)(
    (callback) => callback, settingsRef, () => {}, { current: {} }, { current: {} },
    (_id, patch) => updates.push(patch), async (_id, root) => { loaded.push(root.rootId); },
    (_id, update) => runtime.push(update({})), (error) => error.message
  );
  return { ...callbacks, pending, closed, loaded, updates, runtime, settingsRef };
}

for (const [first, second] of [["session", "session"], ["session", "folder"], ["folder", "session"]]) {
  test(`latest root selection owns the card when ${first} then ${second} replies arrive backwards`, async (t) => {
    const view = selection(t);
    const choose = (kind, id) => kind === "session" ? view.registerFileSession("card", id) : view.chooseFileFolder("card");
    choose(first, "A"); choose(second, "B");
    view.pending[1].resolve(descriptor("newer")); await tick();
    view.pending[0].resolve(descriptor("older")); await tick();
    assert.deepEqual(view.loaded, ["newer"]);
    assert.deepEqual(view.closed, ["older"]);
    assert.equal(view.updates.length, 1);
    assert.equal(view.updates[0].label, "newer");
  });
}

for (const result of ["null", "error"]) {
  test(`a superseded session ${result} response cannot mark the chosen root unavailable`, async (t) => {
    const view = selection(t);
    view.registerFileSession("card", "A"); view.registerFileSession("card", "B");
    view.pending[1].resolve(descriptor("newer")); await tick();
    if (result === "null") view.pending[0].resolve(null);
    else view.pending[0].reject(new Error("stale"));
    await tick();
    assert.deepEqual(view.runtime, []);
    assert.deepEqual(view.loaded, ["newer"]);
  });
}

test("a closed card releases a late registered root without loading it", async (t) => {
  const view = selection(t);
  view.registerFileSession("card", "A");
  view.settingsRef.current.fileCards = [];
  view.pending[0].resolve(descriptor("late")); await tick();
  assert.deepEqual(view.closed, ["late"]);
  assert.deepEqual(view.loaded, []);
  assert.deepEqual(view.updates, []);
});

test("a closed card is not recreated by a failed lookup", async (t) => {
  const view = selection(t);
  view.registerFileSession("card", "A");
  view.settingsRef.current.fileCards = [];
  view.pending[0].reject(new Error("late failure")); await tick();
  assert.deepEqual(view.runtime, []);
});

for (const result of ["null", "error"]) {
  test(`the current session ${result} response still reports its unavailable root`, async (t) => {
    const view = selection(t);
    view.registerFileSession("card", "A");
    if (result === "null") view.pending[0].resolve(null);
    else view.pending[0].reject(new Error("current failure"));
    await tick();
    assert.deepEqual(view.runtime, [result === "null"
      ? { rootUnavailable: true, loading: false, error: null }
      : { loading: false, error: "current failure" }]);
  });
}

test("separate Files cards do not supersede each other's root selections", async (t) => {
  const view = selection(t);
  view.settingsRef.current.fileCards.push({ id: "other" });
  view.registerFileSession("card", "A"); view.registerFileSession("other", "B");
  view.pending[1].resolve(descriptor("second-card")); await tick();
  view.pending[0].resolve(descriptor("first-card")); await tick();
  assert.deepEqual(view.loaded, ["second-card", "first-card"]);
  assert.deepEqual(view.closed, []);
});

const loadStart = source.indexOf("  const loadFileRoot =");
const restoreStart = source.indexOf("  const restoreFileCard =");
const restoreEnd = source.indexOf("  const fileCardsRestored =", restoreStart);
assert.ok(loadStart >= 0 && restoreStart >= 0 && restoreEnd > restoreStart);
const rootCode = transformSync(source.slice(loadStart, end) + source.slice(restoreStart, restoreEnd), { loader: "ts" }).code;

function rootLoading(t) {
  const previousWindow = globalThis.window;
  const registrations = [], listings = [], closed = [], states = {};
  const card = { id: "card", root: { rootType: "session", sessionId: "saved" }, expandedFolders: [], activeFile: null };
  const settingsRef = { current: { fileCards: [card] } };
  const fileRootRequests = { current: {} };
  const files = {
    registerRoot() { const deferred = Promise.withResolvers(); registrations.push(deferred); return deferred.promise; },
    openFolder() { return this.registerRoot(); },
    list(rootId) { const deferred = Promise.withResolvers(); listings.push({ rootId, ...deferred }); return deferred.promise; },
    closeRoot: async (rootId) => { closed.push(rootId); }
  };
  globalThis.window = { canvasTTY: { files } };
  t.after(() => { globalThis.window = previousWindow; });
  const callbacks = new Function("useCallback", "settingsRef", "releaseFileCardRoot", "fileReadSequence", "fileRootRequests", "updateFileCard", "updateFileCardRuntime", "fileErrorMessage", "fileCardToRootReference", "isFileRootUsable", "EMPTY_FILE_CARD_RUNTIME", `${rootCode}; return { chooseFileFolder, registerFileSession, restoreFileCard };`)(
    (callback) => callback, settingsRef, (id) => { if (states[id]?.root) void files.closeRoot(states[id].root.rootId); },
    { current: {} }, fileRootRequests,
    (id, patch) => { settingsRef.current.fileCards = settingsRef.current.fileCards.map((card) => card.id === id ? { ...card, ...patch } : card); },
    (id, update) => { states[id] = { ...states[id], ...update(states[id] ?? {}) }; },
    (error) => error.message, (card) => card.root, (root) => root?.available === true, {}
  );
  return { ...callbacks, registrations, listings, closed, states, card,
    close() { settingsRef.current.fileCards = []; delete fileRootRequests.current.card; delete states.card; } };
}

for (const outcome of ["success", "error"]) {
  test(`a superseded root list ${outcome} cannot overwrite the newer root`, async (t) => {
    const view = rootLoading(t);
    view.registerFileSession("card", "A"); view.registrations[0].resolve(descriptor("old")); await tick();
    view.registerFileSession("card", "B"); view.registrations[1].resolve(descriptor("new")); await tick();
    view.listings[1].resolve(["new entry"]); await tick();
    const expected = structuredClone(view.states.card);
    if (outcome === "success") view.listings[0].resolve(["old entry"]);
    else view.listings[0].reject(new Error("old failure"));
    await tick();
    assert.deepEqual(view.states.card, expected);
    assert.equal(view.closed.includes("old"), true);
  });
}

for (const outcome of ["descriptor", "null", "error"]) {
  test(`late startup restore registration (${outcome}) cannot replace an explicit selection`, async (t) => {
    const view = rootLoading(t);
    const restoring = view.restoreFileCard(view.card);
    view.registerFileSession("card", "picked"); view.registrations[1].resolve(descriptor("picked")); await tick();
    view.listings[0].resolve(["picked entry"]); await tick();
    const expected = structuredClone(view.states.card);
    if (outcome === "error") view.registrations[0].reject(new Error("restore failure"));
    else view.registrations[0].resolve(outcome === "null" ? null : descriptor("restored"));
    await tick();
    // Unfixed restore starts an obsolete list; settle it so the test can inspect its final state.
    for (const pending of view.listings.filter(({ rootId }) => rootId === "restored")) pending.resolve(["restored entry"]);
    await restoring;
    assert.deepEqual(view.states.card, expected);
    if (outcome === "descriptor") assert.equal(view.closed.includes("restored"), true);
  });
}

for (const outcome of ["success", "error"]) {
  test(`startup restore list ${outcome} cannot overwrite an explicit selection`, async (t) => {
    const view = rootLoading(t);
    const restoring = view.restoreFileCard(view.card);
    view.registrations[0].resolve(descriptor("restored")); await tick();
    view.registerFileSession("card", "picked"); view.registrations[1].resolve(descriptor("picked")); await tick();
    view.listings[1].resolve(["picked entry"]); await tick();
    const expected = structuredClone(view.states.card);
    if (outcome === "success") view.listings[0].resolve(["restored entry"]);
    else view.listings[0].reject(new Error("restore list failure"));
    await restoring;
    assert.deepEqual(view.states.card, expected);
  });
}

for (const outcome of ["success", "error"]) {
  test(`closing a card while its root list is pending ignores late ${outcome}`, async (t) => {
    const view = rootLoading(t);
    view.registerFileSession("card", "A"); view.registrations[0].resolve(descriptor("old")); await tick();
    view.close();
    if (outcome === "success") view.listings[0].resolve(["late entry"]);
    else view.listings[0].reject(new Error("late error"));
    await tick();
    assert.equal(view.states.card, undefined);
    assert.equal(view.closed.includes("old"), true);
  });
}

test("the current root list still reports its failure", async (t) => {
  const view = rootLoading(t);
  view.registerFileSession("card", "A"); view.registrations[0].resolve(descriptor("current")); await tick();
  view.listings[0].reject(new Error("current list error")); await tick();
  assert.equal(view.states.card.root.rootId, "current");
  assert.equal(view.states.card.error, "current list error");
  assert.equal(view.states.card.loading, false);
  assert.deepEqual(view.closed, []);
});

test("a current startup restore still loads its saved root", async (t) => {
  const view = rootLoading(t);
  const restoring = view.restoreFileCard(view.card);
  view.registrations[0].resolve(descriptor("saved-root")); await tick();
  view.listings[0].resolve(["saved entry"]);
  await restoring;
  assert.equal(view.states.card.root.rootId, "saved-root");
  assert.deepEqual(view.states.card.entries, ["saved entry"]);
  assert.equal(view.states.card.loading, false);
  assert.deepEqual(view.closed, []);
});
