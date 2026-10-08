import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentControlService } from '../src/main/services/AgentControlService.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { SecretRedactionRegistry } from '../src/main/services/safety/SecretRedaction.ts';
import { OrchestrationTaskBoard } from '../src/main/services/OrchestrationTaskBoard.ts';
import { availableRegistry, fakeSpawner } from './helpers/terminal.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, maxSubagents = 1) {
  const root = await mkdtemp(join(tmpdir(), 'ctty-retry-replacement-'));
  const calls = [], writes = [], removals = [];
  const fake = fakeSpawner(calls, { onWrite: data => writes.push(data) });
  let control;
  const terminals = new TerminalManager((channel, payload) => {
    if (channel === 'terminal:removed') { removals.push(payload.id); control?.forgetSession(payload.id); }
  }, availableRegistry(), undefined, undefined, true, (...args) => {
    const process = fake(...args);
    process.kills = 0;
    process.kill = () => { process.kills++; process.emitExit(143); };
    return process;
  });
  control = new AgentControlService(terminals, { limits: () => ({ maxDepth: 2, maxSubagents }), waitTiming: { checkMs: 1, settleMs: 0, quietMs: 1 } });
  const parent = terminals.create({ provider: 'codex', profile: 'normal', cwd: root, position: { x: 0, y: 0 }, role: 'orchestrator' });
  const original = await control.spawn({ parentSessionId: parent.id, provider: 'opencode', cwd: root, initialPrompt: 'original task', model: 'fixture/model' });
  const process = calls.at(-1).process;
  t.after(async () => { terminals.disposeAll(); await rm(root, { recursive: true, force: true }); });
  return { root, terminals, control, parent, original, process, calls, writes, removals };
}

async function quiet(f) {
  const waited = await f.control.waitFor(f.original.id, { timeoutMs: 100, quietMs: 1 });
  assert.equal(waited.reason, 'quiet');
}

test('quiet retry at the live limit waits for old PTY exit, retains the same owner card and history', async t => {
  const f = await fixture(t);
  f.process.emitData('original diagnostic output');
  const board = new OrchestrationTaskBoard(join(f.root, 'board'));
  const task = await board.addTask(f.root, f.parent.id, f.parent.id, { title: 'Keep owner' });
  await board.claimTask(f.root, f.parent.id, f.original.id, 'worker', task.id);
  await quiet(f);
  const stopping = deferred();
  f.process.kill = () => { f.process.kills++; stopping.resolve(); };
  const retry = f.control.retry(f.original.id);
  await stopping.promise;
  assert.equal(f.calls.length, 2, 'no successor while old process has not confirmed exit');
  assert.throws(() => f.terminals.restart(f.original.id), /retry.*already in progress/);
  await assert.rejects(f.control.retry(f.original.id), /retry.*already in progress/);
  f.process.emitExit(143);
  const replacement = await retry;
  assert.equal(replacement.id, f.original.id);
  assert.equal(f.calls.length, 3);
  assert.equal(f.control.children(f.parent.id).length, 1);
  assert.equal(f.control.descendants(f.parent.id).filter(row => row.exitCode === null).length, 1);
  assert.match(f.terminals.readBuffer(replacement.id).buffer, /original diagnostic output/);
  assert.equal((await board.listTasks(f.root, f.parent.id)).tasks[0].ownerSessionId, replacement.id);
  assert.equal(f.removals.length, 0);
  f.process.emitExit(99);
  assert.equal(f.terminals.getMetadata(replacement.id).exitCode, null, 'late old exit cannot terminate successor');
});

test('failed retry at sixteen cards reuses its card; one successor and two successful attempts per lineage', async t => {
  const f = await fixture(t, 16);
  f.process.emitExit(1);
  for (let i = 1; i < 16; i++) {
    await f.control.spawn({ parentSessionId: f.parent.id, provider: 'opencode', cwd: f.root });
    f.calls.at(-1).process.emitExit(1);
  }
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => f.control.retry(f.original.id)));
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(f.control.children(f.parent.id).length, 16);
  assert.equal(f.calls.length, 18);
  f.calls.at(-1).process.emitExit(1);
  await f.control.retry(f.original.id);
  f.calls.at(-1).process.emitExit(1);
  await assert.rejects(f.control.retry(f.original.id), /limit of 2 retries/);
  assert.equal(f.calls.length, 19);
});

for (const mode of ['failed delivery', 'canceled delivery']) test(`${mode} stops replacement, preserves diagnostic card and refunds allowance`, async t => {
  const f = await fixture(t);
  f.process.emitData('failure history');
  f.process.emitExit(7);
  const originalDelivery = f.terminals.deliverInput.bind(f.terminals);
  const controller = new AbortController();
  f.terminals.deliverInput = async () => {
    if (mode === 'canceled delivery') controller.abort();
    return { delivered: false, reason: 'fixture rejection' };
  };
  await assert.rejects(f.control.retry(f.original.id, undefined, controller.signal), /canceled|not delivered/);
  assert.equal(f.calls.at(-1).process.kills, 1);
  assert.equal(f.control.children(f.parent.id).length, 1);
  assert.equal(f.terminals.getMetadata(f.original.id).status, 'failed');
  assert.match(f.terminals.getMetadata(f.original.id).failureDetails, /previous process was stopped; it was not restored/);
  assert.match(f.terminals.readBuffer(f.original.id).buffer, /failure history/);
  assert.equal(f.control.retryCounts.get(f.original.id), 0);
  f.terminals.deliverInput = originalDelivery;
  await f.control.retry(f.original.id);
  assert.match(f.writes.at(-1), /^original task\n\nCanvasTTY retry context:/);
  assert.equal((f.writes.at(-1).match(/CanvasTTY retry context:/g) ?? []).length, 1);
  f.calls.at(-1).process.emitExit(1);
  await f.control.retry(f.original.id);
  f.calls.at(-1).process.emitExit(1);
  await assert.rejects(f.control.retry(f.original.id), /limit of 2 retries/);
});

test('aborted and invalid requests do not stop an existing quiet process', async t => {
  const f = await fixture(t);
  await quiet(f);
  await assert.rejects(f.control.retry(f.original.id, undefined, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(f.process.kills, 0);
  const registry = f.terminals.providerClis;
  f.terminals.providerClis = { ...registry, get: () => ({ state: 'unavailable' }) };
  await assert.rejects(f.control.retry(f.original.id), /CLI is unavailable/);
  assert.equal(f.process.kills, 0);
  assert.equal(f.calls.length, 2);
});

for (const closed of ['source', 'parent']) test(`${closed} closure while stopping prevents replacement`, async t => {
  const f = await fixture(t);
  await quiet(f);
  const stopping = deferred();
  f.process.kill = () => { stopping.resolve(); };
  const retry = f.control.retry(f.original.id);
  await stopping.promise;
  f.terminals.dispose(closed === 'source' ? f.original.id : f.parent.id);
  f.process.emitExit(143);
  await assert.rejects(retry, /closed or restarted/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.terminals.getMetadata(f.original.id), null);
});

test('parent restart while stopping invalidates retry without starting a successor', async t => {
  const f = await fixture(t);
  await quiet(f);
  const stopping = deferred();
  f.process.kill = () => { stopping.resolve(); };
  const retry = f.control.retry(f.original.id);
  await stopping.promise;
  f.calls[0].process.emitExit(1);
  f.terminals.restart(f.parent.id);
  f.process.emitExit(143);
  await assert.rejects(retry, /closed or restarted/);
  assert.equal(f.calls.length, 3, 'only parent restarted');
  assert.equal(f.control.retryCounts.get(f.original.id), 0);
});

function delayedPolicy(f) {
  const entered = deferred(), release = deferred();
  let cleanups = 0;
  f.terminals.configureLaunchPipeline({
    normalizeOptions: (_provider, options) => options,
    unavailable: () => [],
    hasPolicy: () => true,
    forgetSession: async () => {},
    prepare: async () => {
      entered.resolve();
      await release.promise;
      return { ok: true, env: {}, args: [], secrets: [], cleanup: async () => { cleanups++; } };
    }
  });
  return { entered, release, cleanups: () => cleanups };
}

for (const mode of ['cancel', 'close source', 'close parent', 'restart parent']) test(`${mode} during asynchronous retry preparation cannot launch an orphan`, async t => {
  const f = await fixture(t);
  f.process.emitData('retained failure history');
  f.process.emitExit(1);
  const policy = delayedPolicy(f);
  t.after(() => policy.release.resolve());
  const controller = new AbortController();
  const retry = f.control.retry(f.original.id, undefined, controller.signal);
  // Install rejection handling before releasing asynchronous preparation.
  const rejected = assert.rejects(retry, /canceled|closed|restarted|not delivered/);
  await policy.entered.promise;
  assert.throws(() => f.terminals.restart(f.original.id), /already in progress/);
  if (mode === 'cancel') controller.abort();
  if (mode === 'close source') f.terminals.dispose(f.original.id);
  if (mode === 'close parent') f.terminals.dispose(f.parent.id);
  if (mode === 'restart parent') {
    // The parent has a plain launch; avoid delaying that unrelated restart with the fixture policy.
    f.terminals.launchPipeline.hasPolicy = provider => provider === 'opencode';
    f.calls[0].process.emitExit(1);
    f.terminals.restart(f.parent.id);
  }
  policy.release.resolve();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, mode === 'restart parent' ? 3 : 2, 'no replacement PTY escaped the stale preparation');
  assert.equal(policy.cleanups(), 1, 'the unused contribution was cleaned exactly once');
  if (mode === 'cancel' || mode === 'restart parent') {
    assert.match(f.terminals.readBuffer(f.original.id).buffer, /retained failure history/);
    assert.equal(f.terminals.getMetadata(f.original.id).status, 'failed');
    assert.equal(f.control.retryCounts.get(f.original.id), 0);
  }
});

test('retry retains descendant ownership and counts their live capacity', async t => {
  const f = await fixture(t, 2);
  const child = await f.control.spawn({ parentSessionId: f.original.id, provider: 'opencode', cwd: f.root });
  const childProcess = f.calls.at(-1).process;
  await quiet(f);
  const replacement = await f.control.retry(f.original.id);
  assert.equal(replacement.id, f.original.id);
  assert.equal(f.terminals.getMetadata(child.id).parentSessionId, replacement.id);
  assert.equal(childProcess.kills, 0, 'the retained child still has the same owning card');
  assert.equal(f.control.descendants(f.parent.id).filter(row => row.exitCode === null).length, 2);
  assert.throws(() => f.control.spawn({ parentSessionId: f.parent.id, provider: 'opencode', cwd: f.root }), /2 live subagents/);
});

test('a synchronous spawn failure leaves a stopped diagnostic card and refunds the failed launch', async t => {
  const f = await fixture(t);
  f.process.emitData('original error evidence');
  f.process.emitExit(3);
  const spawn = f.terminals.spawnPty;
  f.terminals.spawnPty = () => { throw new Error('fixture spawn unavailable'); };
  await assert.rejects(f.control.retry(f.original.id), /fixture spawn unavailable/);
  const stopped = f.terminals.getMetadata(f.original.id);
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.failureDetails, /fixture spawn unavailable/);
  assert.match(stopped.failureDetails, /original error evidence/);
  assert.equal(f.control.retryCounts.get(f.original.id), 0);
  f.terminals.spawnPty = spawn;
  await f.control.retry(f.original.id);
  assert.equal(f.control.retryCounts.get(f.original.id), 1);
});

test('asynchronous retry launch retains its original model, profile and folder', async t => {
  const f = await fixture(t);
  f.process.emitExit(1);
  const policy = delayedPolicy(f);
  t.after(() => policy.release.resolve());
  const retry = f.control.retry(f.original.id);
  await policy.entered.promise;
  policy.release.resolve();
  const successor = await retry;
  assert.equal(successor.id, f.original.id);
  assert.equal(successor.profile, f.original.profile);
  assert.equal(successor.cwd, f.original.cwd);
  assert.equal(successor.model, 'fixture/model');
  assert.ok(f.calls.at(-1).args.includes('fixture/model'));
  assert.equal(f.calls.length, 3, 'contributed replacement passed its launch epoch guard');
  assert.match(f.writes.at(-1), /^original task/);
});

test('retry masks failure evidence before sending it to the fresh conversation', async t => {
  const f = await fixture(t);
  const registry = new SecretRedactionRegistry();
  const secret = 'fixture-private-value-for-retry-redaction';
  registry.add('fixture', [secret]);
  f.terminals.configureRedaction(registry);
  f.process.emitData(`Failure context: ${secret}\n`);
  f.process.emitExit(1);
  await f.control.retry(f.original.id, `Do not forward ${secret}`);
  assert.equal(f.writes.at(-1).includes(secret), false);
  assert.match(f.writes.at(-1), /Masked output tail/);
});
