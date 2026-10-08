import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileAccessService } from "../src/main/services/FileAccessService.ts";

const ipcPath = new URL("../src/main/ipc/registerIpc.ts", import.meta.url);

const FILE_CHANNELS = [
  "filesListRoots",
  "filesRegisterRoot",
  "filesOpenFolder",
  "filesList",
  "filesRead",
  "filesSearch",
  "filesCloseRoot"
];

test("every files IPC handler validates the trusted main renderer", async () => {
  const source = await readFile(ipcPath, "utf8");

  assert.match(source, /function assertMainRenderer/);
  assert.match(source, /event\.sender !== expected\.webContents/);
  assert.match(source, /event\.senderFrame !== expected\.webContents\.mainFrame/);

  for (const channel of FILE_CHANNELS) {
    const match = new RegExp(`IPC\\.${channel}\\b`).exec(source);
    assert.ok(match, `${channel} handler is missing`);
    const handler = source.slice(match.index, match.index + 600);
    assert.match(handler, /assertMainRenderer\(event, getMainWindow\)/, `${channel} must validate its sender`);
  }
});

test("list, read, and search payloads expose no absolute root path", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-files-payload-"));
  try {
    const service = new FileAccessService({
      resolveSessionCwd: (sessionId) => (sessionId === "session-1" ? root : undefined)
    });
    const descriptor = service.registerSessionRoot("session-1");
    await writeFile(join(root, "notes.txt"), "hello");

    const payloads = {
      list: await service.list(descriptor.rootId, ""),
      read: await service.read(descriptor.rootId, "notes.txt"),
      search: await service.search(descriptor.rootId, "notes")
    };

    for (const [name, payload] of Object.entries(payloads)) {
      const serialized = JSON.stringify(payload);
      assert.equal(serialized.includes(root), false, `${name} must not embed the absolute root path`);
    }

    assert.match(JSON.stringify(payloads.list), /"relativePath"/);
    assert.match(JSON.stringify(payloads.search), /"relativePaths"/);
    // Session descriptors never leak the resolved cwd.
    assert.equal("folderPath" in descriptor, false);
    assert.equal(JSON.stringify(descriptor).includes(root), false);
    assert.doesNotMatch(JSON.stringify(service.listRoots()), /"folderPath"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("folder descriptors carry the canonical folder path while list/read/search stay relative", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-files-folder-payload-"));
  try {
    const service = new FileAccessService({ resolveSessionCwd: () => undefined });
    const descriptor = service.registerFolderRoot(root);
    await writeFile(join(root, "notes.txt"), "hello");

    // The absolute folder path is intentionally allowed on folder descriptors so
    // that restore can re-register the root after relaunch.
    assert.equal(descriptor.folderPath, realpathSync(root));
    assert.equal(service.listRoots()[0]?.folderPath, realpathSync(root));

    const payloads = [
      await service.list(descriptor.rootId, ""),
      await service.read(descriptor.rootId, "notes.txt"),
      await service.search(descriptor.rootId, "notes")
    ];
    for (const payload of payloads) {
      assert.equal(JSON.stringify(payload).includes(root), false, "operation payload must not embed the absolute root path");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
