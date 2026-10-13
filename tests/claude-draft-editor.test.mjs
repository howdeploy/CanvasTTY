import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// What the helper would do for the oldest waiting request: claim it, save the draft, report done.
function finishRequest(directory, draft = "") {
  const id = readdirSync(directory).filter((name) => name.startsWith("req.")).map((name) => Number(name.slice(4))).sort((a, b) => a - b)[0];
  rmSync(join(directory, `req.${id}`));
  writeFileSync(join(directory, `draft.${id}`), draft);
  writeFileSync(join(directory, `done.${id}`), "");
}

const files = (directory) => (existsSync(directory) ? readdirSync(directory).sort() : []);

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
    assert.deepEqual(files(join(root, "card-1")), [], "no request or draft copy outlives its action");
  } finally {
    claude.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session's actions run one after another, and input typed meanwhile keeps its place", async () => {
  const { root, clipboard, editor } = editorFixture();
  editor.environment("card-2", {});
  const directory = join(root, "card-2");
  const writes = [];
  const write = (data) => { writes.push(data); return true; };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
  const copying = editor.run("card-2", "copy", "", write);
  assert.equal(editor.hold("card-2", "b"), true);
  const clearing = editor.run("card-2", "clear", "ж", write);
  assert.equal(editor.hold("card-2", "c"), true);
  assert.equal(editor.hold("other-card", "x"), false, "other cards are never held");
  await tick();
  assert.deepEqual(writes, ["\u0007"], "the second action waits for the first");
  finishRequest(directory, "весь черновик");
  assert.equal(await copying, true);
  await tick();
  assert.deepEqual(writes, ["\u0007", "b", "\u0007"]);
  finishRequest(directory);
  assert.equal(await clearing, true);
  await tick();
  assert.deepEqual(writes, ["\u0007", "b", "\u0007", "ж", "c"]);
  assert.deepEqual(clipboard, ["весь черновик"]);
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
    assert.deepEqual(files(join(root, "card-3")), ["cancel.1"]);
    late.shift()();
    assert.equal(claude.draft, "черновик", "the late Ctrl+G is a no-op, not the person's editor");
    assert.deepEqual(files(join(root, "card-3")), []);
    assert.deepEqual(clipboard, []);

    assert.equal(await editor.run("card-3", "copy", "", delayed), false);
    const running = editor.run("card-3", "clear", "", claude.write);
    assert.equal(await running, true, "the newer action is done by its own Ctrl+G");
    late.shift()();
    assert.equal(claude.draft, "");
    assert.deepEqual(clipboard, []);
    assert.deepEqual(files(join(root, "card-3")), []);
  } finally {
    claude.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Ctrl+G Claude never handles costs one later Ctrl+G, never the following actions", async () => {
  const { root, clipboard, editor } = editorFixture(40);
  const environment = editor.environment("card-4", {});
  const claude = fakeClaude(environment, "черновик");
  try {
    // A dialog swallowed this Ctrl+G: it will never reach the helper.
    assert.equal(await editor.run("card-4", "cut", "", () => true), false);
    for (let i = 0; i < 3; i += 1) assert.equal(await editor.run("card-4", "copy", "", claude.write), true);
    assert.deepEqual(clipboard, ["черновик", "черновик", "черновик"]);
    assert.deepEqual(files(join(root, "card-4")), ["cancel.1"]);
    claude.write("\u0007");
    assert.deepEqual(files(join(root, "card-4")), [], "the next manual Ctrl+G uses it up");
    assert.equal(claude.draft, "черновик");
    editor.environment("card-4", {});
    assert.equal(existsSync(join(root, "card-4")), false, "a new Claude launch starts clean");
    assert.equal(await editor.run("card-4", "cut", "", () => false), false, "an unsent Ctrl+G is not queued");
    assert.deepEqual(files(join(root, "card-4")), []);
  } finally {
    claude.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a request is either claimed by the helper or cancelled, never both", async () => {
  const { root, clipboard, editor } = editorFixture(40);
  editor.environment("card-5", {});
  const directory = join(root, "card-5");
  let claim;
  const write = () => {
    // The helper claims the request just before the deadline and finishes just after it.
    claim = setTimeout(() => {
      rmSync(join(directory, "req.1"));
      setTimeout(() => {
        writeFileSync(join(directory, "draft.1"), "вырезано");
        writeFileSync(join(directory, "done.1"), "");
      }, 40);
    }, 30);
    return true;
  };
  assert.equal(await editor.run("card-5", "cut", "", write), true, "a claimed request is waited for, not cancelled");
  clearTimeout(claim);
  assert.deepEqual(clipboard, ["вырезано"], "cut text reaches the clipboard");
  assert.deepEqual(files(directory), []);
  rmSync(root, { recursive: true, force: true });
});

test("the helper leaves the draft alone when it cannot save a copy, and ignores unknown requests", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-draft-helper-"));
  const directory = join(scratch, "card");
  mkdirSync(directory);
  const file = join(scratch, "prompt.md");
  writeFileSync(file, "draft");
  const run = () => {
    try {
      execFileSync("/bin/sh", [helperPath, file], { env: { PATH: process.env.PATH, CANVASTTY_DRAFT_DIR: directory, CANVASTTY_DRAFT_EDITOR: "false" } });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  writeFileSync(join(directory, "req.1"), "rm\n");
  assert.equal(run(), 0);
  assert.equal(readFileSync(file, "utf8"), "draft");
  writeFileSync(join(directory, "req.2"), "cut\n");
  chmodSync(file, 0o200);
  assert.notEqual(run(), 0);
  chmodSync(file, 0o600);
  assert.equal(readFileSync(file, "utf8"), "draft", "no copy, no cut");
  assert.equal(existsSync(join(directory, "done.2")), false);
  rmSync(scratch, { recursive: true, force: true });
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

test("the helper is only offered when it can be named safely, and actions are validated", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-draft-names-"));
  for (const unsafe of ["/Applications/My App/draft-editor.sh", "/opt/a$b/draft-editor.sh", "/x/'q'/draft-editor.sh"]) {
    const editor = new ClaudeDraftEditor({ root, helperPath: unsafe, writeClipboard() {} });
    assert.deepEqual(editor.environment("card", {}), {}, unsafe);
    assert.equal(editor.isGranted("card"), false);
    assert.equal(await editor.run("card", "clear", "", () => assert.fail("no Ctrl+G without the helper")), false);
  }
  const cyrillic = new ClaudeDraftEditor({ root, helperPath: "/opt/Программы/draft-editor.sh", writeClipboard() {} });
  assert.equal(cyrillic.environment("card", {}).VISUAL, "/bin/sh /opt/Программы/draft-editor.sh");
  const safe = new ClaudeDraftEditor({ root, helperPath, writeClipboard() {} });
  assert.deepEqual(safe.environment("../escape", {}), {});
  assert.equal(safe.environment("card", { EDITOR: "nano" }).CANVASTTY_DRAFT_EDITOR, "nano");
  assert.equal(safe.isGranted("card"), true);
  safe.forget("card");
  assert.equal(safe.isGranted("card"), false);
  assert.equal(isClaudeDraftAction("cut"), true);
  assert.equal(isClaudeDraftAction("rm"), false);
  rmSync(root, { recursive: true, force: true });
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
      if (data === "\u0007") finishRequest(options.env.CANVASTTY_DRAFT_DIR, "весь черновик");
    } }));
  terminals.configureDraftEditor(editor);
  try {
    const base = { profile: "yolo", cwd: process.cwd(), position: { x: 0, y: 0 } };
    const claude = terminals.create({ ...base, provider: "claude" });
    const claudeEnv = calls.at(-1).options.env;
    assert.equal(claudeEnv.VISUAL, `/bin/sh ${helperPath}`);
    assert.equal(claudeEnv.CANVASTTY_DRAFT_DIR, join(root, claude.id));
    assert.equal(terminals.listMetadata().find((s) => s.id === claude.id).claudeDraft, true);
    const codex = terminals.create({ ...base, provider: "codex" });
    assert.equal("CANVASTTY_DRAFT_DIR" in calls.at(-1).options.env, false, "only Claude cards get the helper");
    assert.equal(terminals.listMetadata().find((s) => s.id === codex.id).claudeDraft, undefined);
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
