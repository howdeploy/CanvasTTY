import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { IPC } from '../src/shared/contracts.ts';

test('capsule IPC restricts frame and identity, preserves cancellation and rechecks saved patches', async () => {
  const source = await readFile(new URL('../src/main/ipc/registerIpc.ts', import.meta.url), 'utf8');
  const handlers = new Map(), calls = [], frame = {}, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
  const id = '00000000-0000-4000-8000-000000000001', token = '00000000-0000-4000-8000-000000000002';
  let cancelled = false, exports = 0, failExport = false;
  const context = { IPC, Buffer, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on() {} }, PluginBrowserOpenBroker: class {}, observeWindowState() {}, createWindowStateObserver: () => () => {},
    dialog: { showSaveDialog: async () => { calls.push('save'); return { canceled: cancelled, filePath: '/chosen/output.patch' }; }, showOpenDialog: async () => ({ canceled: cancelled, filePaths: ['/source/code.ts'] }) },
    writeFile: async (path, text) => { calls.push('write'); assert.equal(path, '/chosen/output.patch'); assert.equal(text, 'frozen patch'); } };
  const code = stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*$/gmu, '').replace('export function registerIpc', 'function registerIpc');
  runInNewContext(code + '\nregisterIpc', context)({ getMainWindow: () => window, capsuleTests: { start: async (capsule, review, profile) => { assert.equal(capsule, id); assert.equal(review, token); assert.equal(profile, 'unit'); calls.push('test'); return { id }; }, list: async () => [], get: async () => ({ id }), cancel: async () => {}, cleanup: async () => {} }, capsules: {
    sourceDirectory: async s => s,
    selectedFiles: async (s, files) => { assert.equal(s, '/source'); assert.equal(files[0], '/source/code.ts'); return ['code.ts']; },
    prepare: async input => { assert.equal(input.sourceCwd, '/source'); calls.push('prepare'); return { id }; }, summary: async value => { assert.equal(value, id); return { id, capturedBytes: 20 }; },
    list: async () => [], review: async value => { assert.equal(value, id); return { workspaceId: id, reviewId: token }; },
    exportReview: async (value, selected) => { assert.equal(value, id); assert.equal(selected, token); exports++; calls.push('export'); if (failExport && exports % 2 === 0) throw Error('changed'); return { workspaceId: id, patch: 'frozen patch' }; },
    apply: async (value, selected) => { assert.equal(value, id); assert.equal(selected, token); calls.push('apply'); },
    recoverApply: async (value, selected) => { assert.equal(value, id); assert.equal(selected, token); calls.push('recover'); }, cleanup: async () => {} } });
  const trusted = { sender: contents, senderFrame: frame };
  for (const channel of [IPC.capsulesSelectFiles, IPC.capsulesPrepare, IPC.capsulesList, IPC.capsulesReview, IPC.capsulesExport, IPC.capsulesApply, IPC.capsulesRecover, IPC.capsulesCleanup, IPC.capsulesTestStart, IPC.capsulesTestList, IPC.capsulesTestResult, IPC.capsulesTestCancel, IPC.capsulesTestCleanup]) {
    assert.equal(typeof handlers.get(channel), 'function', String(channel));
    await assert.rejects(async () => handlers.get(channel)({ sender: contents, senderFrame: {} }, id, token), /trusted/);
  }
  for (const channel of [IPC.capsulesReview, IPC.capsulesExport, IPC.capsulesApply, IPC.capsulesRecover, IPC.capsulesCleanup]) await assert.rejects(async () => handlers.get(channel)(trusted, '/unowned/path', token), /identity/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await handlers.get(IPC.capsulesSelectFiles)(trusted, '/source'), ['code.ts']);
  cancelled = true; assert.equal(await handlers.get(IPC.capsulesSelectFiles)(trusted, '/source'), null);
  assert.equal(await handlers.get(IPC.capsulesExport)(trusted, id, token), false); assert.deepEqual(calls.splice(0), ['export', 'save']);
  cancelled = false; exports = 0; failExport = true;
  await assert.rejects(handlers.get(IPC.capsulesExport)(trusted, id, token), /changed/); assert.deepEqual(calls.splice(0), ['export', 'save', 'export']);
  failExport = false; assert.equal(await handlers.get(IPC.capsulesExport)(trusted, id, token), true); assert.deepEqual(calls.splice(0), ['export', 'save', 'export', 'write']);
  await assert.rejects(async () => handlers.get(IPC.capsulesApply)(trusted, id, { patch: 'renderer patch' }), /identity/);
  await handlers.get(IPC.capsulesApply)(trusted, id, token); assert.deepEqual(calls.splice(0), ['apply']);
  await assert.rejects(async () => handlers.get(IPC.capsulesTestStart)(trusted, id, token, { command: '/bin/sh' }), /profile/i);
  await handlers.get(IPC.capsulesTestStart)(trusted, id, token, 'unit'); assert.deepEqual(calls.splice(0), ['test']);
});
