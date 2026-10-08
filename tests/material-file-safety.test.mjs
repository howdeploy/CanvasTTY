import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { streamFile } from "../src/main/services/fileResponse.ts";
import { DirectoryWatchSet, MAX_WATCHED_DIRECTORIES } from "../src/main/services/materials/materialWatch.ts";

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-file-safety-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("streaming refuses a path swapped for a FIFO without waiting for a writer", { skip: process.platform === "win32" }, async () => {
  await withRoot(async (root) => {
    const fifo = join(root, "frame.png");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    await assert.rejects(streamFile(new Request("canvastty-material://x/live"), fifo, "image/png"));
    assert.ok(Date.now() - started < 1_000);
  });
});

test("streaming refuses a final path component swapped for a symlink", { skip: process.platform === "win32" }, async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(root, "frame.png"));
    await assert.rejects(streamFile(new Request("canvastty-material://x/live"), join(root, "frame.png"), "image/png"));
  });
});

test("a regular file still streams whole and by range", async () => {
  await withRoot(async (root) => {
    const file = join(root, "clip.bin");
    await writeFile(file, Buffer.from([1, 2, 3, 4, 5]));
    const whole = await streamFile(new Request("canvastty-material://x/live"), file, "application/octet-stream");
    assert.deepEqual([...new Uint8Array(await whole.arrayBuffer())], [1, 2, 3, 4, 5]);
    const part = await streamFile(new Request("canvastty-material://x/live", { headers: { range: "bytes=3-" } }), file, "application/octet-stream");
    assert.equal(part.status, 206);
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [4, 5]);
  });
});

test("a directory watch that fails frees its slot and is opened again on retry", () => {
  const failures = new Map();
  const opened = [];
  const set = new DirectoryWatchSet((directory, _listener, failed) => {
    opened.push(directory);
    failures.set(directory, failed);
    return { close() {} };
  }, () => {});
  set.track("a", "/work/one/a.png");
  assert.equal(set.watched("a"), true);
  failures.get("/work/one")();
  assert.equal(set.watched("a"), false);
  set.retry();
  assert.equal(set.watched("a"), true);
  assert.deepEqual(opened, ["/work/one", "/work/one"]);
});

test("no more than the watch limit is opened; the rest wait for a free slot", () => {
  const closers = new Map();
  const set = new DirectoryWatchSet((directory) => {
    const handle = { close() {} };
    closers.set(directory, handle);
    return handle;
  }, () => {});
  for (let index = 0; index <= MAX_WATCHED_DIRECTORIES; index += 1) set.track(`m${index}`, `/work/${index}/file.png`);
  assert.equal(set.watched(`m${MAX_WATCHED_DIRECTORIES}`), false);
  set.untrack("m0");
  set.retry();
  assert.equal(set.watched(`m${MAX_WATCHED_DIRECTORIES}`), true);
});
