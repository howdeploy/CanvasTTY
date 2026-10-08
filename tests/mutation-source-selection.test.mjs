import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("mutation snapshots require fresh source and copy only allowed roots", t => {
  const root = mkdtempSync(join(tmpdir(), "ctty-mutation-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  copyFileSync(new URL("../scripts/mutation-backlog.mjs", import.meta.url), join(root, "scripts/mutation-backlog.mjs"));
  const production = join(root, "src", "production.ts");
  writeFileSync(production, "guard enabled\n");
  writeFileSync(join(root, "note.md"), "baseline note\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init"); git("config", "user.name", "Mutation fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "."); git("commit", "-m", "fixture baseline");
  writeFileSync(production, "guard disabled\n");
  const trace = join(root, "git-trace.log");
  const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/mutation-backlog.mjs"), ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, HOME: root, GIT_TRACE: trace } });
  for (const staged of [false, true]) {
    if (staged) git("add", "src/production.ts");
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Source files differ from HEAD.*--source-ref/u);
  }
  git("reset", "--hard", "HEAD");
  writeFileSync(join(root, "src", "new.ts"), "export const untested = true;\n");
  assert.match(run().stderr, /Source files differ from HEAD.*--source-ref/u);
  rmSync(join(root, "src", "new.ts"));
  writeFileSync(join(root, "note.md"), "documentation-only edit\n");
  const documentationOnly = run();
  assert.doesNotMatch(documentationOnly.stderr, /Source files differ from HEAD/u);
  assert.match(documentationOnly.stderr, /Mutation baseline failed/u, "the synthetic source snapshot reaches its intentionally absent baseline files");
  assert.match(readFileSync(trace, "utf8"), /git archive [a-f0-9]{40} -- scripts\/mutation-backlog\.mjs src\/production\.ts(?:\s|$)/u,
    "the actual snapshot copies only the present allowed source roots");
  const explicit = run("--source-ref", "0000000000000000000000000000000000000000");
  assert.equal(explicit.status, 1);
  assert.doesNotMatch(explicit.stderr, /Source files differ from HEAD/u, "explicit source selection is not replaced by the dirty-checkout default guard");
});
