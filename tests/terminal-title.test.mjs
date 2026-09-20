import assert from "node:assert/strict";
import test from "node:test";
import { renameCommit, visibleTerminalTitle } from "../src/renderer/src/features/terminal/terminalTitle.ts";

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

test("scenario: OSC title changes while the rename field is open - the field keeps the user's text and unchanged stays unchanged", () => {
  const c = card({ title: "Codex · canvas", titleCustomized: false });
  c.reportOsc("vim README.md");
  assert.equal(c.startRename(), "vim README.md");
  c.reportOsc("bash");
  assert.equal(c.fieldValue(), "vim README.md", "field is not overwritten by the new OSC title");
  assert.equal(c.commit().kind, "unchanged", "compared against the seeded snapshot, not the newer OSC title");
  assert.deepEqual(c.renames, []);
  assert.equal(c.header(), "bash", "after closing, the header follows the shell again");
});

test("scenario: OSC title changes while the user is typing - the typed text is what gets committed", () => {
  const c = card({ title: "Codex · canvas", titleCustomized: false });
  c.reportOsc("vim README.md");
  c.startRename();
  c.type("notes");
  c.reportOsc("bash");
  assert.equal(c.fieldValue(), "notes");
  assert.deepEqual(c.commit(), { kind: "rename", title: "notes" });
  assert.equal(c.header(), "notes");
});

test("scenario: Escape restores the visible title without any rename", () => {
  const c = card({ title: "Codex · canvas", titleCustomized: false });
  c.reportOsc("vim README.md");
  c.startRename();
  c.type("half-typed");
  c.cancel();
  assert.deepEqual(c.renames, []);
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

test("scenario: restore after restart - stored title/titleCustomized plus a new OSC title follow the same rules", () => {
  // Restored uncustomized session: cwd label until the shell reports a title.
  const restored = card({ title: "Codex · canvas", titleCustomized: false });
  assert.equal(restored.header(), CWD_LABEL);
  assert.equal(restored.summary(), CWD_LABEL);
  restored.reportOsc("zsh");
  assert.equal(restored.header(), "zsh");
  assert.equal(restored.startRename(), "zsh");
  assert.equal(restored.commit().kind, "unchanged");
  assert.equal(restored.session().titleCustomized, false);

  // Restored customized session: the stored name wins even once the shell reports.
  const restoredCustom = card({ title: "prod db", titleCustomized: true });
  assert.equal(restoredCustom.header(), "prod db");
  restoredCustom.reportOsc("zsh");
  assert.equal(restoredCustom.header(), "prod db");
  assert.equal(restoredCustom.summary(), "prod db");
  assert.equal(restoredCustom.startRename(), "prod db");
});

test("scenario: summary view shows the same name as the expanded header in every state", () => {
  const c = card({ title: "Codex · canvas", titleCustomized: false });
  assert.equal(c.summary(), c.header());
  c.reportOsc("vim README.md");
  assert.equal(c.summary(), c.header());
  c.startRename();
  c.type("renamed");
  c.commit();
  assert.equal(c.summary(), "renamed");
  assert.equal(c.summary(), c.header());
});
