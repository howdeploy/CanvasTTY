import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { createElement } from "react";
import { findAll, tick } from "./helpers/fake-react.mjs";
import { compactPath, renameCommit, visibleTerminalTitle } from "../src/renderer/src/features/terminal/terminalTitle.ts";

const CWD_LABEL = "~/projects/canvas";

function visible(overrides = {}) {
  return visibleTerminalTitle({
    title: "Codex · canvas",
    titleCustomized: false,
    oscTitle: null,
    cwdLabel: CWD_LABEL,
    ...overrides
  });
}

// --- visibleTerminalTitle -------------------------------------------------

test("a custom title wins over both the OSC title and the cwd label", () => {
  assert.equal(visible({ title: "My shell", titleCustomized: true, oscTitle: "vim README.md" }), "My shell");
  assert.equal(visible({ title: "My shell", titleCustomized: true, oscTitle: null }), "My shell");
});

test("without a custom title the OSC title is shown when the shell reported one", () => {
  assert.equal(visible({ oscTitle: "vim README.md" }), "vim README.md");
});

test("without a custom title and without an OSC title the cwd label is shown, not the stored title", () => {
  assert.equal(visible({ oscTitle: null }), CWD_LABEL);
  assert.equal(visible({ oscTitle: undefined }), CWD_LABEL);
});

test("an empty or whitespace-only OSC title falls back to the cwd label", () => {
  assert.equal(visible({ oscTitle: "" }), CWD_LABEL);
  assert.equal(visible({ oscTitle: "   " }), CWD_LABEL);
});

test("the stored default title never leaks into the visible name while uncustomized", () => {
  // Stored default differs from both the OSC title and the cwd label: it must not be shown.
  assert.equal(visible({ title: "Claude · canvas", oscTitle: "bash" }), "bash");
  assert.equal(visible({ title: "Claude · canvas", oscTitle: null }), CWD_LABEL);
});

// --- renameCommit ---------------------------------------------------------

test("submitting the visible text unchanged is a no-op and keeps the visible title", () => {
  assert.deepEqual(renameCommit({ previousVisible: "vim README.md", submitted: "vim README.md" }), {
    kind: "unchanged",
    title: "vim README.md"
  });
});

test("surrounding whitespace does not turn an unchanged title into a rename", () => {
  assert.deepEqual(renameCommit({ previousVisible: "vim README.md", submitted: "  vim README.md  " }), {
    kind: "unchanged",
    title: "vim README.md"
  });
});

test("an empty or whitespace-only submission never renames", () => {
  assert.deepEqual(renameCommit({ previousVisible: CWD_LABEL, submitted: "" }), { kind: "unchanged", title: CWD_LABEL });
  assert.deepEqual(renameCommit({ previousVisible: CWD_LABEL, submitted: "   " }), { kind: "unchanged", title: CWD_LABEL });
});

test("different text renames to the trimmed submission", () => {
  assert.deepEqual(renameCommit({ previousVisible: "vim README.md", submitted: "  build box " }), {
    kind: "rename",
    title: "build box"
  });
});

test("a custom title edited to new text renames; edited back to itself does not", () => {
  assert.equal(renameCommit({ previousVisible: "My shell", submitted: "My shell 2" }).kind, "rename");
  assert.equal(renameCommit({ previousVisible: "My shell", submitted: "My shell" }).kind, "unchanged");
});

test("submitting the stored default while the OSC title is visible is a real rename", () => {
  // The user saw "bash", typed the old stored name: they asked for that name explicitly.
  assert.deepEqual(renameCommit({ previousVisible: "bash", submitted: "Codex · canvas" }), {
    kind: "rename",
    title: "Codex · canvas"
  });
});

// --- Scripted card scenarios ---------------------------------------------
// These mirror the exact sequence TerminalCard performs: compute the visible
// title, seed the rename field from it once, later decide from the seeded
// snapshot plus the field's current value. The "session" object stands in for
// the main-process record (rename() sets titleCustomized = true).

function card(session) {
  let oscTitle = null;
  let field = null; // { value, seededFrom } while the rename input is mounted
  const renames = [];
  const view = (cwdLabel = CWD_LABEL) =>
    visibleTerminalTitle({ title: session.title, titleCustomized: session.titleCustomized, oscTitle, cwdLabel });
  return {
    renames,
    reportOsc(title) { oscTitle = title; },
    header: () => view(),
    summary: () => view(),
    startRename() { const initial = view(); field = { value: initial, seededFrom: initial }; return initial; },
    type(value) { field.value = value; },
    fieldValue: () => field.value,
    commit() {
      const decision = renameCommit({ previousVisible: field.seededFrom, submitted: field.value });
      if (decision.kind === "rename") {
        renames.push(decision.title);
        session = { ...session, title: decision.title, titleCustomized: true };
      }
      field = null;
      return decision;
    },
    cancel() { field = null; },
    session: () => session
  };
}

// Execute the production ref/commit/key handlers and JSX, not a second implementation of rename.
// This source harness does not mount React or emulate DOM ref reconciliation.
async function rendererCard(initial) {
  const source = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  const select = (pattern) => { const match = source.match(pattern); assert.ok(match, String(pattern)); return match[0]; };
  const bind = select(/^  const bindRenameInput = useCallback\([\s\S]*?^  \}, \[\]\);/m);
  const commit = select(/^  const commitRename = async \([\s\S]*?^  \};/m);
  const cancel = select(/^  const cancelRename = \([\s\S]*?^  \};/m);
  const titles = select(/^  const titleSource = [\s\S]*?^  visibleTitleRef\.current = visibleTitle;/m);
  const header = select(/^      <header[\s\S]*?^      <\/header>/m);
  const summary = select(/^      <button\s+className="terminal-card__summary"[\s\S]*?^      <\/button>/m);
  let session = { id: "rename-card", cwd: "/home/runner/projects/canvas", provider: "codex", profile: "normal", status: "idle", ...initial };
  let oscTitle = null;
  let editing = false;
  let ended = 0;
  const renames = [];
  const field = { value: "", focus() {}, select() {} };
  const visibleTitleRef = { current: "" };
  const noop = () => {};
  const scope = {
    createElement, visibleTerminalTitle, compactPath, renameCommit, visibleTitleRef,
    useRef: () => visibleTitleRef, useCallback: (callback) => callback,
    renameInput: { current: null }, renameInitial: { current: "" }, renameClosed: { current: false }, renameInFlight: { current: false },
    terminalRef: { current: { blur: noop } }, session,
    onRename: async (id, title) => { assert.equal(id, "rename-card"); renames.push(title); session = { ...session, title, titleCustomized: true }; },
    onRenameEnd: () => { ended++; editing = false; },
    startDrag: noop, drag: noop, endDrag: noop, cancelDrag: noop, activateSummary: noop, activateSummaryDouble: noop,
    ProviderIcon: "provider-icon", pixelControls: null, terminalActions: null, pluginDecorations: { badges: [] },
    t: (_locale, key) => key, locale: "en", focusActivation: "click", sessionStatusLabel: () => "idle"
  };
  const { code } = await transform(`${bind}\n${commit}\n${cancel}\nfunction renderTitle(session, oscTitle, renaming) {
    ${titles}
    return { header: (${header}), summary: (${summary}) };
  }`, { loader: "tsx", target: "esnext", jsxFactory: "createElement" });
  const actual = new Function(...Object.keys(scope), `${code}\nreturn { bindRenameInput, renderTitle };`)(...Object.values(scope));
  const render = () => {
    const tree = actual.renderTitle(session, oscTitle, editing);
    if (editing) {
      const fieldNode = findAll(tree.header, (node) => node.type === "input" && node.props["data-terminal-rename"] === "true")[0];
      assert.equal(fieldNode.props.value, undefined, "rerenders must not control the user's rename draft");
      assert.equal(fieldNode.props.defaultValue, undefined, "the ref, not a rerendered default, seeds the field");
    }
    return tree;
  };
  const input = () => findAll(render().header, (node) => node.type === "input" && node.props["data-terminal-rename"] === "true")[0];
  render();
  return {
    renames, render,
    get ended() { return ended; },
    reportOsc(title) { oscTitle = title; render(); },
    startRename() { editing = true; input().props.ref(field); return field.value; },
    type(value) { field.value = value; },
    fieldValue: () => field.value,
    async commit() {
      const node = input();
      node.props.onKeyDown({ key: "Enter", stopPropagation: noop, preventDefault: noop });
      await tick();
      node.props.onBlur();
      await tick();
    },
    cancel() {
      const node = input();
      node.props.onKeyDown({ key: "Escape", stopPropagation: noop, preventDefault: noop });
      node.props.onBlur();
    },
    header: () => findAll(render().header, (node) => node.type === "strong")[0].props.children,
    summary: () => findAll(render().summary, (node) => node.type === "strong")[0].props.children,
    session: () => session
  };
}

test("scenario: differing stored/OSC titles - rename starts from the OSC title and Enter without edits sends nothing", () => {
  const c = card({ title: "Codex · canvas", titleCustomized: false });
  c.reportOsc("vim README.md");
  assert.equal(c.header(), "vim README.md");
  assert.equal(c.startRename(), "vim README.md");
  assert.equal(c.commit().kind, "unchanged");
  assert.deepEqual(c.renames, []);
  assert.equal(c.session().titleCustomized, false);
  assert.equal(c.header(), "vim README.md");
});

test("scenario: missing OSC title - rename starts from the cwd label, editing it customizes the title", () => {
  const c = card({ title: "Codex · canvas", titleCustomized: false });
  assert.equal(c.header(), CWD_LABEL);
  assert.equal(c.startRename(), CWD_LABEL);
  c.type("api server");
  assert.deepEqual(c.commit(), { kind: "rename", title: "api server" });
  assert.deepEqual(c.renames, ["api server"]);
  assert.equal(c.session().titleCustomized, true);
  assert.equal(c.header(), "api server");
  // A later OSC title no longer changes what is visible or edited.
  c.reportOsc("bash");
  assert.equal(c.header(), "api server");
  assert.equal(c.startRename(), "api server");
});

test("scenario: OSC title changes while the rename field is open - the field keeps the user's text and unchanged stays unchanged", async () => {
  const c = await rendererCard({ title: "Codex · canvas", titleCustomized: false });
  c.reportOsc("vim README.md");
  assert.equal(c.startRename(), "vim README.md");
  c.reportOsc("bash");
  assert.equal(c.fieldValue(), "vim README.md", "field is not overwritten by the new OSC title");
  await c.commit();
  assert.deepEqual(c.renames, []);
  assert.equal(c.ended, 1, "trailing blur must not commit a second time");
  assert.equal(c.header(), "bash", "after closing, the header follows the shell again");
});

test("scenario: OSC title changes while the user is typing - the typed text is what gets committed", async () => {
  const c = await rendererCard({ title: "Codex · canvas", titleCustomized: false });
  c.reportOsc("vim README.md");
  c.startRename();
  c.type("notes");
  c.reportOsc("bash");
  assert.equal(c.fieldValue(), "notes");
  await c.commit();
  assert.deepEqual(c.renames, ["notes"]);
  assert.equal(c.ended, 1);
  assert.equal(c.header(), "notes");
});

test("scenario: Escape restores the visible title without any rename", async () => {
  const c = await rendererCard({ title: "Codex · canvas", titleCustomized: false });
  c.reportOsc("vim README.md");
  c.startRename();
  c.type("half-typed");
  c.cancel();
  assert.deepEqual(c.renames, []);
  assert.equal(c.ended, 1);
  assert.equal(c.header(), "vim README.md");
  assert.equal(c.session().titleCustomized, false);
});

test("scenario: custom name - visible, seeded and summary text are all the custom name regardless of OSC", () => {
  const c = card({ title: "My shell", titleCustomized: true });
  c.reportOsc("vim README.md");
  assert.equal(c.header(), "My shell");
  assert.equal(c.summary(), "My shell");
  assert.equal(c.startRename(), "My shell");
  assert.equal(c.commit().kind, "unchanged");
  assert.deepEqual(c.renames, []);
});

test("scenario: restore after restart - stored title/titleCustomized plus a new OSC title follow the same rules", async () => {
  // Restored uncustomized session: cwd label until the shell reports a title.
  const restored = await rendererCard({ title: "Codex · canvas", titleCustomized: false });
  assert.equal(restored.header(), CWD_LABEL);
  assert.equal(restored.summary(), CWD_LABEL);
  restored.reportOsc("zsh");
  assert.equal(restored.header(), "zsh");
  assert.equal(restored.startRename(), "zsh");
  await restored.commit();
  assert.deepEqual(restored.renames, []);
  assert.equal(restored.session().titleCustomized, false);

  // Restored customized session: the stored name wins even once the shell reports.
  const restoredCustom = await rendererCard({ title: "prod db", titleCustomized: true });
  assert.equal(restoredCustom.header(), "prod db");
  restoredCustom.reportOsc("zsh");
  assert.equal(restoredCustom.header(), "prod db");
  assert.equal(restoredCustom.summary(), "prod db");
  assert.equal(restoredCustom.startRename(), "prod db");
});

test("actual header and summary JSX use the visible title and accessible summary name", async () => {
  const c = await rendererCard({ title: "Codex · canvas", titleCustomized: false });
  for (const [osc, expected] of [[null, CWD_LABEL], ["vim README.md", "vim README.md"], ["", CWD_LABEL]]) {
    c.reportOsc(osc);
    assert.equal(c.header(), expected);
    assert.equal(c.summary(), expected);
    assert.equal(c.render().summary.props.title, expected);
    assert.equal(c.render().summary.props["aria-label"], expected);
  }
  c.startRename();
  c.type("My shell");
  await c.commit();
  c.reportOsc("new OSC title");
  assert.equal(c.header(), "My shell");
  assert.equal(c.summary(), "My shell");
});

test("the working-folder label shortens a home folder on Linux, macOS and Windows", () => {
  assert.equal(compactPath("/home/runner/projects/canvas"), "~/projects/canvas");
  assert.equal(compactPath("/Users/runner/projects/canvas"), "~/projects/canvas");
  assert.equal(compactPath("C:\\Users\\runner\\projects\\canvas"), "~\\projects\\canvas");
  assert.equal(compactPath("/Users/runner"), "/Users/runner", "the home folder itself stays whole");
  assert.equal(compactPath("/opt/work"), "/opt/work");
  assert.equal(compactPath("/Users"), "/Users");
});
