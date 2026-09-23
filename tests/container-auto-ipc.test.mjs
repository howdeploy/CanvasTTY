import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { IPC } from '../src/shared/contracts.ts';

test('preview and auto-create IPC require the trusted main frame and fixed create stays synchronous', async () => {
  const source = await readFile(new URL('../src/main/ipc/registerIpc.ts', import.meta.url), 'utf8'), handlers = new Map(), calls = [];
  const frame = {}, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
  const env = { IPC, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }, PluginBrowserOpenBroker: class {}, observeWindowState() {}, createWindowStateObserver: () => () => {} };
  const code = stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*$/gmu, '').replace('export function registerIpc', 'function registerIpc');
  const terminals = Object.fromEntries(['create', 'createWithPlacement', 'previewContainerPlacement'].map(name => [name, request => { calls.push({ name, request }); return name; }]));
  runInNewContext(code + '\nregisterIpc', env)({ terminals, getMainWindow: () => window });
  const preview = handlers.get(IPC.terminalContainerPlacementPreview), create = handlers.get(IPC.terminalCreate), event = { sender: contents, senderFrame: frame };
  assert.equal(typeof preview, 'function');
  for (const bad of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }]) {
    assert.throws(() => preview(bad, {}), /trusted/); assert.throws(() => create(bad, {}), /trusted/);
  }
  assert.equal(calls.length, 0);
  const fixed = { provider: 'terminal' }, auto = { ...fixed, containerPlacement: {} };
  assert.equal(create(event, fixed), 'create'); assert.equal(create(event, auto), 'createWithPlacement'); assert.equal(preview(event, auto), 'previewContainerPlacement');
  assert.deepEqual(calls.map(c => c.name), ['create', 'createWithPlacement', 'previewContainerPlacement']);
});
