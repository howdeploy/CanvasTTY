import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { IPC } from '../src/shared/contracts.ts';
test('inventory is main-renderer only and validates bounded on-demand request before dispatch', async () => {
  const source = await readFile(new URL('../src/main/ipc/registerIpc.ts', import.meta.url), 'utf8'), handlers = new Map(), calls = [];
  const frame = {}, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
  const env = { IPC, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }, PluginBrowserOpenBroker: class {}, observeWindowState() {}, createWindowStateObserver: () => () => {} };
  const code = stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*$/gmu, '').replace('export function registerIpc', 'function registerIpc');
  runInNewContext(code + '\nregisterIpc', env)({ containers: { inventory: (...args) => { calls.push(args); return []; } }, getMainWindow: () => window });
  const handler = handlers.get(IPC.containersInventory), event = { sender: contents, senderFrame: frame };
  assert.equal(calls.length, 0);
  for (const badEvent of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }]) assert.throws(() => handler(badEvent), /trusted/);
  for (const [ids, force] of [['local'], [['x', 'x']], [Array(65).fill('x')], [['bad/id']], [undefined, 'true']]) assert.throws(() => handler(event, ids, force), /Invalid/);
  assert.equal(calls.length, 0); assert.deepEqual(handler(event, ['local'], true), []); assert.deepEqual(calls, [[['local'], true]]);
});
