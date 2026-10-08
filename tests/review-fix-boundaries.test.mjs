import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitCheckpoints } from "../src/main/services/GitCheckpoints.ts";
import { SessionTimelineService } from "../src/main/services/SessionTimelineService.ts";

const exec = promisify(execFile);

test("untracked checkpoint reads stay capped if a file grows after its metadata check", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-bounded-checkpoint-"));
  const filePath = join(root, "untracked.txt");
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "-c", "user.name=CanvasTTY audit", "-c", "user.email=audit@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  await writeFile(filePath, "small initial file\n");

  const probe = await open(filePath, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  const originalReadFile = prototype.readFile;
  let growthInjected = false;
  let bytesRead = 0;

  const injectGrowth = async () => {
    if (growthInjected) return;
    growthInjected = true;
    await appendFile(filePath, Buffer.alloc(16 * 1024 * 1024, 120));
  };

  try {
    prototype.read = async function (...args) {
      await injectGrowth();
      const result = await originalRead.apply(this, args);
      bytesRead += result.bytesRead;
      return result;
    };
    prototype.readFile = async function (...args) {
      await injectGrowth();
      const result = await originalReadFile.apply(this, args);
      bytesRead += result.length;
      return result;
    };

    const diff = await new GitCheckpoints(text => text).workingDiff(root);
    assert.equal(growthInjected, true, "the fixture grew the already-opened file after stat checks");
    assert.ok(bytesRead <= 32 * 1024 + 1, `checkpoint reader consumed ${bytesRead} bytes from one untracked file`);
    assert.match(diff, /untracked file\(s\) omitted/u);
  } finally {
    prototype.read = originalRead;
    prototype.readFile = originalReadFile;
    await rm(root, { recursive: true, force: true });
  }
});

test("timeline rejects a positional cursor beyond the referenced segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-timeline-cursor-"));
  try {
    const timeline = new SessionTimelineService(root, text => text);
    await timeline.load();
    for (let index = 0; index < 4; index++) await timeline.append("fixture", "status", `event ${index}`);
    const [segment] = await readdir(timeline.directory);
    assert.ok(segment);

    const first = await timeline.page("fixture", undefined, 2);
    assert.deepEqual(first.items.map(row => row.summary), ["event 3", "event 2"]);
    assert.ok(first.nextCursor);
    await assert.rejects(timeline.page("fixture", `v1:${segment}:999999`, 2), /Invalid timeline cursor/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
