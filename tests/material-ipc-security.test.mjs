import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { IPC } from "../src/shared/contracts.ts";

const ipcPath = new URL("../src/main/ipc/registerMaterialIpc.ts", import.meta.url);

test("every materials IPC channel validates the trusted main renderer", async () => {
  const source = await readFile(ipcPath, "utf8");
  const channels = Object.keys(IPC).filter((name) => name.startsWith("materials") && !name.endsWith("Changed"));
  assert.ok(channels.length > 10);
  for (const channel of channels) {
    const start = source.indexOf(`IPC.${channel},`);
    assert.notEqual(start, -1, `${channel} handler is registered`);
    const handler = source.slice(start, source.indexOf("ipcMain.", start));
    assert.match(handler, /assertMainRenderer\(event, getMainWindow\)/, `${channel} must validate its sender`);
  }
});
