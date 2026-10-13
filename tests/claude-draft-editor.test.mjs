import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeDraftEditor, isClaudeDraftAction } from "../src/main/services/ClaudeDraftEditor.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const helperPath = new URL("../src/agent-runtime/draft-editor.sh", import.meta.url).pathname;

// Stands in for Claude Code: Ctrl+G hands the draft to $VISUAL and reloads what it leaves.
function fakeClaude(environment, draft) {
  const state = { draft, writes: [], editorRuns: 0 };
  const scratch = mkdtempSync(join(tmpdir(), "claude-draft-test-"));
  state.write = (data) => {
    state.writes.push(data);
    if (data !== "\u0007") return true;
    state.editorRuns += 1;
    const file = join(scratch, "prompt.md");
    writeFileSync(file, state.draft);
    execFileSync("/bin/sh", ["-c", `${environment.VISUAL} "$1"`, "claude", file], {
      env: { PATH: process.env.PATH, ...environment, CANVASTTY_DRAFT_EDITOR: "true" }
    });
    state.draft = readFileSync(file, "utf8");
    return true;
  };
  state.cleanup = () => rmSync(scratch, { recursive: true, force: true });
  return state;
}

function editorFixture(timeoutMs) {
  const root = mkdtempSync(join(tmpdir(), "claude-draft-root-"));
  const clipboard = [];
  const editor = new ClaudeDraftEditor({ root, helperPath, writeClipboard: (text) => clipboard.push(text), timeoutMs });
  return { root, clipboard, editor };
}

test("copy, cut and clear act on the whole Claude draft through the real helper", async () => {
  const { root, clipboard, editor } = editorFixture();
  const environment = editor.environment("card-1", { VISUAL: "code --wait" });
  assert.deepEqual(environment, {
    VISUAL: `/bin/sh ${helperPath}`,
    CANVASTTY_DRAFT_DIR: join(root, "card-1"),
    CANVASTTY_DRAFT_EDITOR: "code --wait"
  });
  const draft = "Привет 👋\nвторая строка\n[вставка из 40 строк]";
  const claude = fakeClaude(environment, draft);
  try {
    assert.equal(await editor.run("card-1", "copy", "", claude.write), true);
    assert.equal(claude.draft, draft, "copying leaves the draft alone");
    assert.equal(await editor.run("card-1", "cut", "", claude.write), true);
    assert.equal(claude.draft, "");
    assert.deepEqual(clipboard, [draft, draft]);
    claude.draft = "старое";
    assert.equal(await editor.run("card-1", "clear", "ж", claude.write), true);
    assert.equal(claude.draft, "");
    assert.deepEqual(claude.writes.slice(-2), ["\u0007", "ж"], "the replacing key follows the round trip");
    assert.equal(clipboard.length, 2, "clearing never touches the clipboard");
    assert.equal(existsSync(join(root, "card-1", "request")), false, "no request outlives its action");
  } finally {
    claude.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("input typed during the round trip is held and delivered after the replacing key, in order", async () => {
  const { root, editor } = editorFixture();
  const writes = [];
  let finishEditor;
  const write = (data) => {
    writes.push(data);
    if (data === "\u0007") finishEditor = () => writeFileSync(join(root, "card-2", "done"), "");
    return true;
  };
  const running = editor.run("card-2", "clear", "a", write);
  assert.equal(editor.hold("card-2", "b"), true);
  assert.equal(editor.hold("card-2", "c"), true);
  assert.equal(editor.hold("other-card", "x"), false, "other cards are never held");
  assert.equal(await editor.run("card-2", "copy", "", write), false, "one action at a time");
  finishEditor();
  assert.equal(await running, true);
  assert.deepEqual(writes, ["\u0007", "abc"]);
  assert.equal(editor.hold("card-2", "d"), false);
  rmSync(root, { recursive: true, force: true });
});

test("a Ctrl+G Claude picks up late opens no editor and changes nothing, even after a newer action", async () => {
  const { root, clipboard, editor } = editorFixture(60);
  const environment = editor.environment("card-3", {});
  const claude = fakeClaude(environment, "черновик");
  const late = [];
  const writes = [];
  const delayed = (data) => { writes.push(data); if (data === "\u0007") late.push(() => claude.write(data)); return true; };
  try {
    assert.equal(await editor.run("card-3", "cut", "ж", delayed), false, "the deadline passes");
    assert.deepEqual(writes, ["\u0007", "ж"], "what was typed still arrives");
    assert.equal(readFileSync(join(root, "card-3", "request"), "utf8"), "cancel\n");
    late.shift()();
    assert.equal(claude.draft, "черновик", "the late Ctrl+G is a no-op, not the person's editor");
    assert.equal(existsSync(join(root, "card-3", "request")), false);
    assert.deepEqual(clipboard, []);

    assert.equal(await editor.run("card-3", "copy", "", delayed), false);
    const running = editor.run("card-3", "clear", "", claude.write);
    late.shift()();
    assert.equal(await running, true, "the newer action still completes behind the late one");
    assert.equal(claude.draft, "");
    assert.deepEqual(clipboard, []);
  } finally {
    claude.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lost Ctrl+G costs at most the next one, and a new Claude launch forgets it", async () => {
  const { root, editor } = editorFixture(30);
  editor.environment("card-4", {});
  assert.equal(await editor.run("card-4", "cut", "", () => true), false);
  assert.equal(readFileSync(join(root, "card-4", "request"), "utf8"), "cancel\n");
  editor.environment("card-4", {});
  assert.equal(existsSync(join(root, "card-4")), false);
  assert.equal(await editor.run("card-4", "cut", "", () => false), false, "an unsent Ctrl+G is not queued");
  assert.equal(existsSync(join(root, "card-4", "request")), false);
  rmSync(root, { recursive: true, force: true });
});

test("without a request the helper opens the person's own editor, arguments included", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-draft-own-"));
  const file = join(scratch, "prompt.md");
  writeFileSync(file, "draft");
  const ownEditor = join(scratch, "own-editor.sh");
  writeFileSync(ownEditor, 'printf "%s|" "$@" > "$(dirname "$0")/opened"\n');
  execFileSync("/bin/sh", [helperPath, file], {
    env: { PATH: process.env.PATH, CANVASTTY_DRAFT_DIR: join(scratch, "none"), CANVASTTY_DRAFT_EDITOR: `/bin/sh ${ownEditor} --wait` }
  });
  assert.equal(readFileSync(join(scratch, "opened"), "utf8"), `--wait|${file}|`);
  assert.equal(readFileSync(file, "utf8"), "draft");
  rmSync(scratch, { recursive: true, force: true });
});

test("the helper is only offered when it can be named safely, and actions are validated", () => {
  const editor = new ClaudeDraftEditor({ root: "/tmp/x", helperPath: "/Applications/My App/draft-editor.sh", writeClipboard() {} });
  assert.deepEqual(editor.environment("card", {}), {});
  const safe = new ClaudeDraftEditor({ root: "/tmp/x", helperPath, writeClipboard() {} });
  assert.deepEqual(safe.environment("../escape", {}), {});
  assert.equal(safe.environment("card", { EDITOR: "nano" }).CANVASTTY_DRAFT_EDITOR, "nano");
  assert.equal(isClaudeDraftAction("cut"), true);
  assert.equal(isClaudeDraftAction("rm"), false);
});

test("TerminalManager gives local macOS Claude cards the helper and holds their input during an action", {
  skip: process.platform !== "darwin" && "the draft helper is macOS-only"
}, async () => {
  const { root, clipboard, editor } = editorFixture();
  const calls = [];
  const writes = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true,
    fakeSpawner(calls, { onWrite: (data, options) => {
      writes.push(data);
      if (data === "\u0007") {
        writeFileSync(join(options.env.CANVASTTY_DRAFT_DIR, "draft.txt"), "весь черновик");
        writeFileSync(join(options.env.CANVASTTY_DRAFT_DIR, "done"), "");
      }
    } }));
  terminals.configureDraftEditor(editor);
  try {
    const base = { profile: "yolo", cwd: process.cwd(), position: { x: 0, y: 0 } };
    const claude = terminals.create({ ...base, provider: "claude" });
    const claudeEnv = calls.at(-1).options.env;
    assert.equal(claudeEnv.VISUAL, `/bin/sh ${helperPath}`);
    assert.equal(claudeEnv.CANVASTTY_DRAFT_DIR, join(root, claude.id));
    const codex = terminals.create({ ...base, provider: "codex" });
    assert.equal("CANVASTTY_DRAFT_DIR" in calls.at(-1).options.env, false, "only Claude cards get the helper");
    assert.equal(await terminals.draftAction(codex.id, "copy", ""), false);

    const running = terminals.draftAction(claude.id, "cut", "");
    terminals.input(claude.id, "после");
    assert.equal(await running, true);
    assert.deepEqual(writes, ["\u0007", "после"], "typing during the round trip arrives after it");
    assert.deepEqual(clipboard, ["весь черновик"]);
  } finally {
    for (const session of terminals.list()) terminals.dispose(session.id);
    rmSync(root, { recursive: true, force: true });
  }
});
