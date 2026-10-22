// The Rollback points dialog's requests answer with stable codes the renderer localizes, never main-process text.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { checkpointIpcHandlers } from "../src/main/ipc/checkpointIpc.ts";
import { GitCheckpoints } from "../src/main/services/GitCheckpoints.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const run = promisify(execFile);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-checkpoint-ipc-")));
  const project = join(root, "project");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  await run("git", ["init", "-q", project], { env });
  const git = (...args) => run("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { env });
  await writeFile(join(project, "file.txt"), "base\n");
  await git("add", "file.txt");
  await git("commit", "-qm", "base");
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  const checkpoints = new GitCheckpoints((text) => text.replaceAll("SECRET", "[MASKED]"), 50, join(root, "app", "checkpoints.json"));
  t.after(async () => { terminals.disposeAll(); await rm(root, { recursive: true, force: true }); });
  return { root, project, terminals, checkpoints, calls, handlers: checkpointIpcHandlers({ checkpoints, terminals }) };
}

test("list, preview and restore answer with data or a code; a live card in the folder refuses the restore", async (t) => {
  const f = await fixture(t);
  const card = f.terminals.create({ provider: "codex", profile: "yolo", cwd: f.project, position: { x: 0, y: 0 } });
  assert.deepEqual(await f.handlers.list(card.id), { ok: true, checkpoints: [] });
  await writeFile(join(f.project, "file.txt"), "before turn SECRET\n");
  await f.checkpoints.capture(card.id, f.project);
  const listed = await f.handlers.list(card.id);
  assert.equal(listed.ok, true);
  assert.equal(listed.checkpoints[0].kind, "before-turn");
  await writeFile(join(f.project, "file.txt"), "agent edit\n");
  const preview = await f.handlers.preview(card.id, listed.checkpoints[0].id);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.changedFiles, ["file.txt"]);
  assert.match(preview.text, /\[MASKED\]/u);
  assert.equal(preview.truncated, false);
  assert.deepEqual(await f.handlers.restore(card.id, listed.checkpoints[0].id), { ok: false, code: "agent-running" });
  assert.equal(await readFile(join(f.project, "file.txt"), "utf8"), "agent edit\n", "nothing was restored");
  f.calls[0].process.emitExit(0);
  assert.deepEqual(await f.handlers.restore(card.id, listed.checkpoints[0].id), { ok: true });
  assert.equal(await readFile(join(f.project, "file.txt"), "utf8"), "before turn SECRET\n");
  assert.deepEqual((await f.handlers.list(card.id)).checkpoints.map((entry) => entry.kind).sort(), ["before-restore", "before-turn"]);
});

test("refusals are codes: unknown card, invalid or foreign rollback point, a folder that is not a Git project root", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.handlers.list("missing"), { ok: false, code: "missing-session" });
  assert.deepEqual(await f.handlers.list(42), { ok: false, code: "missing-session" });
  const card = f.terminals.create({ provider: "codex", profile: "yolo", cwd: f.project, position: { x: 0, y: 0 } });
  assert.deepEqual(await f.handlers.preview(card.id, "../../etc"), { ok: false, code: "unknown-checkpoint" });
  assert.deepEqual(await f.handlers.preview(card.id, "refs/canvastty/other/1-00000000-0000-0000-0000-000000000000"),
    { ok: false, code: "unknown-checkpoint" });
  const plain = f.terminals.create({ provider: "terminal", profile: "normal", cwd: f.root, position: { x: 0, y: 0 } });
  assert.deepEqual(await f.handlers.list(plain.id), { ok: false, code: "not-git-root" });
  const broken = checkpointIpcHandlers({ checkpoints: { available: async () => { throw new Error("internal detail /Users/x"); } }, terminals: f.terminals });
  const warn = console.warn; console.warn = () => undefined;
  try { assert.deepEqual(await broken.list(card.id), { ok: false, code: "failed" }); } finally { console.warn = warn; }
});
