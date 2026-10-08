import assert from "node:assert/strict";
import test from "node:test";
import { importWithFakeReact, findAll, tick } from "./helpers/fake-react.mjs";
const panel = await importWithFakeReact("src/renderer/src/features/workspace/SecretGrantsPanel.tsx", "SecretGrantsPanel");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const request = (id, sessionId) => ({ id, sessionId, secretId: "OPENAI_API_KEY", reason: id, createdAt: 1, expiresAt: 600001, turnAvailable: true });
function setup(t) {
 const oldWindow = globalThis.window, oldDocument = globalThis.document, fetches = [], actions = [], errors = [];
 const api = {
  secretRequests(sessionId) { const pending = deferred(); fetches.push({ sessionId, pending }); return pending.promise; },
  secretGrants: async () => [],
  approveSecretRequest(sessionId, requestId, duration) { const pending = deferred(); actions.push({ sessionId, requestId, duration, pending }); return pending.promise; },
  denySecretRequest() { throw new Error("unexpected denial"); }, revokeSecretGrant() { throw new Error("unexpected revoke"); }
 };
 globalThis.window = { setInterval: () => 1, clearInterval() {}, canvasTTY: { backlog: api } };
 globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
 let closed = false; const close = () => { if (closed) return; closed = true; panel.__unmount(); globalThis.window = oldWindow; globalThis.document = oldDocument; };
 panel.__reset(); t.after(close);
 const onError = message => errors.push(message);
 let mountedKey;
 const render = sessionId => {
  const child = panel.SecretGrantsPanel({ sessionId, sessions: [], locale: "en", onError });
  assert.equal(child.key, sessionId, "the production wrapper keys its child by selected task");
  if (mountedKey !== child.key) { panel.__unmount(); mountedKey = child.key; }
  panel.__flush(); return panel.__render(child.type, child.props);
 };
 return { fetches, actions, errors, render, close };
}
const buttons = (tree, label) => findAll(tree, node => node.type === "button" && node.props.children === label);
const content = tree => JSON.stringify(tree);

test("selection changes start fresh loading and ignore stale success, error and finally", async t => {
 for (const outcome of ["success", "error"]) {
  const f = setup(t); f.render("A"); assert.equal(f.fetches.length, 1);
  const switching = f.render("B"); assert.equal(f.fetches.length, 2, "A's pending fetch cannot block B");
  assert.equal(buttons(switching, "10 minutes").length, 0);
  const a = f.fetches[0], b = f.fetches[1];
  if (outcome === "success") a.pending.resolve([request("old-A", "A")]); else a.pending.reject(new Error("stale A failure"));
  await tick(); let tree = f.render("B");
  assert.equal(buttons(tree, "Refresh")[0].props.disabled, true, "A's finally cannot clear B's loading");
  assert.equal(content(tree).includes("old-A"), false); assert.deepEqual(f.errors, []);
  b.pending.resolve([request("new-B", "B")]); await tick(); tree = f.render("B");
  assert.equal(content(tree).includes("new-B"), true); assert.equal(content(tree).includes("old-A"), false);
  assert.equal(buttons(tree, "Refresh")[0].props.disabled, false);
  f.close();
 }
});

test("A to B to A uses a new selection generation and removes old visible actions immediately", async t => {
 const f = setup(t); f.render("A"); f.fetches[0].pending.resolve([request("first-A", "A")]); await tick();
 let tree = f.render("A"); assert.equal(buttons(tree, "10 minutes").length, 1);
 const oldButton = buttons(tree, "10 minutes")[0];
 tree = f.render("B"); assert.equal(content(tree).includes("first-A"), false, "render never mixes A data with B handlers");
 tree = f.render("A"); assert.equal(content(tree).includes("first-A"), false);
 assert.equal(f.fetches.length, 3);
 oldButton.props.onClick(); await tick(); assert.equal(f.actions.length, 0, "detached handlers cannot act in a later generation of A");
 f.fetches[2].pending.resolve([request("latest-A", "A")]); await tick(); tree = f.render("A");
 f.fetches[1].pending.resolve([request("stale-B", "B")]); await tick(); tree = f.render("A");
 assert.equal(content(tree).includes("latest-A"), true); assert.equal(content(tree).includes("stale-B"), false);
});

test("pending A to B to A completions cannot replace the returned selection or its error", async t => {
 const f = setup(t); f.render("A"); f.render("B"); f.render("A");
 assert.deepEqual(f.fetches.map(item => item.sessionId), ["A", "B", "A"]);
 f.fetches[2].pending.reject(new Error("current A failure")); await tick();
 let tree = f.render("A"); assert.deepEqual(f.errors, ["current A failure"]);
 assert.equal(findAll(tree, node => node.props?.role === "alert")[0].props.children, "current A failure");
 f.fetches[0].pending.resolve([request("obsolete-first-A", "A")]);
 f.fetches[1].pending.reject(new Error("obsolete B failure")); await tick(); tree = f.render("A");
 assert.equal(content(tree).includes("obsolete-first-A"), false);
 assert.equal(findAll(tree, node => node.props?.role === "alert")[0].props.children, "current A failure");
 assert.deepEqual(f.errors, ["current A failure"]);
 buttons(tree, "Refresh")[0].props.onClick(); await tick();
 f.fetches[3].pending.resolve([request("recovered-A", "A")]); await tick(); tree = f.render("A");
 assert.equal(content(tree).includes("recovered-A"), true); assert.equal(findAll(tree, node => node.props?.role === "alert").length, 0);
});

test("old grant action completion cannot refresh, report errors or clear a newer scope's busy state", async t => {
 for (const outcome of ["success", "error"]) {
  const f = setup(t); f.render("A"); f.fetches[0].pending.resolve([request("action-A", "A")]); await tick();
  let tree = f.render("A"); buttons(tree, "10 minutes")[0].props.onClick(); await tick();
  assert.deepEqual(f.actions.map(({ sessionId, requestId }) => ({ sessionId, requestId })), [{ sessionId: "A", requestId: "action-A" }]);
  f.render("B"); f.fetches[1].pending.resolve([request("action-B", "B")]); await tick();
  tree = f.render("B"); buttons(tree, "10 minutes")[0].props.onClick(); await tick();
  assert.equal(f.actions[1].sessionId, "B"); assert.equal(f.actions[1].requestId, "action-B");
  if (outcome === "success") f.actions[0].pending.resolve({}); else f.actions[0].pending.reject(new Error("old action failed"));
  await tick(); tree = f.render("B");
  assert.equal(f.fetches.length, 2, "old action must not start another refresh in either scope");
  assert.equal(buttons(tree, "10 minutes")[0].props.disabled, true, "old action finally cannot unlock current action");
  assert.deepEqual(f.errors, []);
  f.actions[1].pending.resolve({}); await tick(); assert.equal(f.fetches.length, 3);
  assert.equal(f.fetches[2].sessionId, "B"); f.fetches[2].pending.resolve([]); await tick();
  assert.equal(buttons(f.render("B"), "10 minutes").length, 0);
  f.close();
 }
});
