import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { IPC } from '../src/shared/contracts.ts';

test('remote output IPC validates renderer and IDs before dialog, then rechecks before writing', async () => {
  const source = await readFile(new URL('../src/main/ipc/registerIpc.ts', import.meta.url), 'utf8');
  const handlers = new Map(), calls = [], frame = {}, contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  const id = '00000000-0000-4000-8000-000000000001', token = '00000000-0000-4000-8000-000000000002';
  const review = { workspaceId: id, patch: 'exact reviewed patch\n' };
  let cancelled = false, stale = false, expired = false;
  const context = {
    IPC, Buffer,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    PluginBrowserOpenBroker: class {}, observeWindowState() {}, createWindowStateObserver: () => () => {},
    dialog: { showSaveDialog: async (...args) => { calls.push('dialog'); assert.equal(args[0], window); return { canceled: cancelled, filePath: '/chosen/patch.diff' }; } },
    writeFile: async (path, patch) => { calls.push('write'); assert.equal(path, '/chosen/patch.diff'); assert.equal(patch, review.patch); }
  };
  // Execute the actual registration and handlers, substituting only imported dependencies.
  const code = stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*$/gmu, '').replace('export function registerIpc', 'function registerIpc');
  const register = runInNewContext(code + '\nregisterIpc', context);
  register({ getMainWindow: () => window, containers: {
    review: async value => { calls.push('review'); assert.equal(value, id); return review; },
    cachedReview: (value, selected) => { calls.push('cached'); assert.equal(value, id); assert.equal(selected, token); if (expired) throw Error('expired'); return review; },
    exportReview: async (value, selected) => { calls.push('recheck'); assert.equal(value, id); assert.equal(selected, token); if (stale) throw Error('changed'); return review; }
  } });
  const trusted = { sender: contents, senderFrame: frame };
  for (const channel of [IPC.containersReview, IPC.containersExport]) {
    for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }]) await assert.rejects(async () => handlers.get(channel)(event, id, token), /trusted/);
    await assert.rejects(async () => handlers.get(channel)(trusted, '../../arbitrary', token), /identity/);
  }
  await assert.rejects(handlers.get(IPC.containersExport)(trusted, id, { path: '/arbitrary' }), /identity/);
  assert.deepEqual(calls, []);
  await handlers.get(IPC.containersReview)(trusted, id); assert.deepEqual(calls.splice(0), ['review']);
  expired = true; await assert.rejects(handlers.get(IPC.containersExport)(trusted, id, token), /expired/); assert.deepEqual(calls.splice(0), ['cached']); expired = false;
  cancelled = true; assert.equal(await handlers.get(IPC.containersExport)(trusted, id, token), false); assert.deepEqual(calls.splice(0), ['cached', 'dialog']); cancelled = false;
  stale = true; await assert.rejects(handlers.get(IPC.containersExport)(trusted, id, token), /changed/); assert.deepEqual(calls.splice(0), ['cached', 'dialog', 'recheck']); stale = false;
  assert.equal(await handlers.get(IPC.containersExport)(trusted, id, token), true); assert.deepEqual(calls.splice(0), ['cached', 'dialog', 'recheck', 'write']);
});
