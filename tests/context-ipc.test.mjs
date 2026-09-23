import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { IPC } from '../src/shared/contracts.ts';
import { contextText } from '../src/shared/contextProfiles.ts';
test('context IPC is explicit main-renderer access and forwards only to the private store', async () => {
  const source = await readFile(new URL('../src/main/ipc/registerIpc.ts', import.meta.url), 'utf8'), handlers = new Map(), calls = [];
  const frame = {}, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
  const contextProfiles = Object.fromEntries(['get', 'saveProject', 'saveTask', 'saveRule', 'remove', 'preview', 'source', 'saveLearning', 'captureFeedback', 'feedbackAction', 'feedbackSessions'].map(name => [name, (...args) => { calls.push([name, ...args]); return {}; }]));
  const env = { IPC, contextText, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }, PluginBrowserOpenBroker: class {}, observeWindowState() {}, createWindowStateObserver: () => () => {} };
  const code = stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*$/gmu, '').replace('export function registerIpc', 'function registerIpc');
  const settings = { contextProfilesEnabled: false };
  runInNewContext(code + '\nregisterIpc', env)({ contextProfiles, settings: { get: () => settings }, terminals: { previewContextLaunch: input => calls.push(['launch',input]) }, getMainWindow: () => window });
  assert.deepEqual(calls, []);
  const channels = [IPC.contextGet, IPC.contextProject, IPC.contextTask, IPC.contextRule, IPC.contextRemove, IPC.contextPreview, IPC.contextSource, IPC.contextLaunchPreview, IPC.contextLearning, IPC.contextFeedback, IPC.contextFeedbackAction, IPC.contextFeedbackSessions];
  for (const channel of channels) {
    assert.equal(typeof handlers.get(channel), 'function');
    for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }]) await assert.rejects(async () => handlers.get(channel)(event, {}), /trusted/);
  }
  assert.deepEqual(calls, []);
  await handlers.get(IPC.contextGet)({ sender: contents, senderFrame: frame }); assert.deepEqual(calls, [['get']]);
  const event = { sender: contents, senderFrame: frame };
  const off = await handlers.get(IPC.contextSource)(event,'/missing/path'); assert.equal(off.enabled,false); assert.equal(calls.length,1);
  settings.contextProfilesEnabled = true; await handlers.get(IPC.contextSource)(event,'/selected/path'); assert.deepEqual(calls.at(-1),['source','/selected/path']);
  await handlers.get(IPC.contextLaunchPreview)(event,{provider:'codex'}); assert.deepEqual(calls.at(-1),['launch',{provider:'codex'}]);
  await handlers.get(IPC.contextLearning)(event, 'project', { enabled: false, autoApply: false, threshold: .85, advisoryThreshold: .6 }, 7); assert.equal(calls.at(-1)[0], 'saveLearning');
  await handlers.get(IPC.contextFeedback)(event, { eventId: 'event' }, 7); assert.equal(calls.at(-1)[0], 'captureFeedback'); assert.equal(typeof calls.at(-1)[3], 'function');
  await handlers.get(IPC.contextFeedbackAction)(event, { kind: 'reject', id: 'candidate' }, 7); assert.deepEqual(calls.at(-1), ['feedbackAction', { kind: 'reject', id: 'candidate' }, 7]);
  const selectedImports = { label: 'Selected project', root: '/selected/path', importsEnabled: true, imports: [{ path: 'theme.css', kind: 'css', selectors: [':root'], dataClass: 'D2' }] };
  await handlers.get(IPC.contextProject)(event, selectedImports, 7); assert.deepEqual(calls.at(-1), ['saveProject', selectedImports, 7]);
});
