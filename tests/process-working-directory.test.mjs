import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fileSystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { cwdFromLsof, processWorkingDirectory } from "../src/main/services/processWorkingDirectory.ts";

const fields = (name, pid = 42, fd = "cwd") => `p${pid}\0\nf${fd}\0n${name}\0\n`;

test("lsof cwd fields preserve spaces and Unicode and decode C and byte escapes", () => {
  assert.equal(cwdFromLsof(fields("/tmp/folder with spaces \u042e\u043d\u0438\u043a\u043e\u0434 "), 42), "/tmp/folder with spaces \u042e\u043d\u0438\u043a\u043e\u0434 ");
  assert.equal(cwdFromLsof(fields(String.raw`/tmp/\xd0\xae\xd0\xbd\xd0\xb8\xd0\xba\xd0\xbe\xd0\xb4`), 42), "/tmp/\u042e\u043d\u0438\u043a\u043e\u0434");
  assert.equal(cwdFromLsof(fields(String.raw`/tmp/new\nline\\literal\tend`), 42), "/tmp/new\nline\\literal\tend");
  assert.equal(cwdFromLsof(fields(String.raw`/tmp/literal\\n\\x2f`), 42), String.raw`/tmp/literal\n\x2f`);
});

test("lsof must identify one absolute cwd for exactly the requested process", () => {
  for (const output of [fields("/tmp", 43), fields("/tmp", 42, "3"), fields("relative"),
    fields("/one") + fields("/two"), fields(String.raw`/tmp/unknown\q`),
    fields(String.raw`/tmp/nul\x00`), fields(String.raw`/tmp/invalid\xff`), fields("/tmp/ambiguous^J")]) {
    assert.equal(cwdFromLsof(output, 42), undefined, JSON.stringify(output));
  }
});

test("invalid PIDs and unsupported platforms do not launch a lookup", async () => {
  for (const pid of [0, -1, NaN, Infinity, 1.5]) assert.equal(await processWorkingDirectory(pid, "darwin"), undefined);
  assert.equal(await processWorkingDirectory(42, "win32"), undefined);
});

test("unavailable macOS lookup is bounded, uses a fixed executable without a shell and fails closed", async (t) => {
  const original = childProcess.execFile;
  const errors = ["ENOENT", "EACCES", "ETIMEDOUT"];
  const calls = [];
  childProcess.execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    queueMicrotask(() => callback(Object.assign(new Error("fixture lookup failure"), { code: errors.shift() })));
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
  const module = await import(`../src/main/services/processWorkingDirectory.ts?failure-fixture`);
  for (let i = 0; i < 3; i++) assert.equal(await module.processWorkingDirectory(42, "darwin"), undefined);
  for (const { file, args, options } of calls) {
    assert.equal(file, "/usr/sbin/lsof");
    assert.deepEqual(args, ["-a", "-p", "42", "-d", "cwd", "-F0n"]);
    assert.equal(options.timeout, 1_500);
    assert.equal(options.maxBuffer, 64 * 1024);
    assert.equal(options.env.LC_ALL, "en_US.UTF-8");
    assert.equal(options.shell, undefined);
  }
  assert.equal(calls.length, 3);
});


test("Linux cwd must identify the same directory as the process reference, including deleted names", async (t) => {
  const originalReadlink = fileSystem.readlink, originalStat = fileSystem.stat;
  let namedInode = 10;
  let denied = false;
  fileSystem.readlink = async (path) => {
    assert.equal(path, "/proc/42/cwd");
    if (denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return "/fixture/project (deleted)";
  };
  fileSystem.stat = async (path) => ({ dev: 1, ino: path === "/proc/42/cwd" ? 10 : namedInode, isDirectory: () => true });
  syncBuiltinESMExports();
  t.after(() => { fileSystem.readlink = originalReadlink; fileSystem.stat = originalStat; syncBuiltinESMExports(); });
  const module = await import("../src/main/services/processWorkingDirectory.ts?linux-identity-fixture");
  assert.equal(await module.processWorkingDirectory(42, "linux"), "/fixture/project (deleted)", "a live directory may literally have this suffix");
  namedInode = 20;
  assert.equal(await module.processWorkingDirectory(42, "linux"), undefined, "never grant an unrelated directory at a decorated deleted pathname");
  denied = true;
  assert.equal(await module.processWorkingDirectory(42, "linux"), undefined);
});
