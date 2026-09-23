import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskCapsuleService } from '../src/main/services/TaskCapsuleService.ts';
import { CapsuleLaunchService } from '../src/main/services/CapsuleLaunchService.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { AgentControlService } from '../src/main/services/AgentControlService.ts';
import { ScopedOrchestrationHandler } from '../src/main/services/agent-browser/OrchestrationTools.ts';
import { validateOrchestrationArguments } from '../src/agent-browser/orchestration-catalog.mjs';
import { encodeOrchestrationServerMessage } from '../src/main/services/agent-browser/orchestration-protocol.ts';
import { ProviderAccountLaunchService } from '../src/main/services/ProviderAccountLaunchService.ts';
import { SessionLaunchCoordinator } from '../src/main/services/SessionLaunchCoordinator.ts';
import { ContainerExecutionService } from '../src/main/services/ContainerExecutionService.ts';
import { WorktreeService } from '../src/main/services/WorktreeService.ts';
import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';
import { capsuleEngine } from './helpers/capsule-engine.mjs';

async function fixture(t, hooks = {}) {
  const { ScopedCapsuleControl } = await import('../src/main/services/ScopedCapsuleControl.ts');
  const { CapsuleTestService } = await import('../src/main/services/CapsuleTestService.ts');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-capsule-scope-'))), source = join(root, 'source');
  await mkdir(source); execFileSync('git', ['-C', source, 'init'], { stdio: 'pipe' }); await writeFile(join(source, 'code.ts'), 'baseline\n');
  const profile = { id: 'image', label: 'Image', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/fixture.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', commands: { opencode: '/usr/bin/opencode' }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: `${process.getuid()}:${process.getgid()}` };
  const settings = { containerProfiles: [profile], remoteHosts: [], providerAccounts: [{ id: 'api', label: 'API', provider: 'opencode', binding: { kind: 'api-profile', profileId: 'backend' } }], apiProfiles: [{ id: 'backend', name: 'Backend', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', secretRef: 'OPENAI_API_KEY', defaultModel: 'fixture-model' }], defaultDataClass: 'D1', pathPolicies: [{ pattern: '/code.ts', dataClass: 'D1' }], requiresSandboxProfiles: [], maxAccountsPerProviderPerHost: 1 };
  settings.providerAccounts[0].assessment = { profile: { training: 'may-train', retention: 'persistent', thirdPartyProcessing: 'unknown', contractualMode: 'api' }, evidence: { kind: 'user-attested', reviewedAt: '2026-09-21', sources: [], note: 'Synthetic fixture', models: '*', binding: accountRouteBinding(settings.providerAccounts[0], settings.apiProfiles) } };
  const storage = new TaskCapsuleService({ rootDirectory: join(root, 'capsules'), beforeApplyWrite: hooks.beforeApplyWrite }), capsules = new CapsuleLaunchService(storage, () => settings);
  const calls = [], exits = [];
  const registry = { get(provider) { return { state: 'available', provider, executable: `/fixture/${provider}`, launcher: 'native', environment: { PATH: '/usr/bin' }, checked: [] }; } };
  const manager = new TerminalManager(() => {}, registry, undefined, undefined, false, (command, args, options) => { calls.push({ command, args, options }); let exit; return { onData() {}, onExit(cb) { exit = cb; exits.push(cb); }, write() {}, resize() {}, kill() { exit?.({ exitCode: 0 }); } }; });
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings, { capsulePolicy: request => capsules.classify(request) }));
  const parent = manager.create({ provider: 'claude', profile: 'normal', role: 'orchestrator', cwd: source, position: { x: 0, y: 0 } });
  const foreign = manager.create({ provider: 'claude', profile: 'normal', role: 'orchestrator', cwd: source, position: { x: 0, y: 0 } });
  const engine = capsuleEngine(profile, hooks), worktrees = new WorktreeService({ rootDirectory: join(root, 'worktrees') });
  let tests;
  const containers = new ContainerExecutionService(() => settings, { rootDirectory: join(root, 'containers'), runner: engine.runner, resolveEndpoint: engine.resolveEndpoint, onWorkspaceStopped: (id, lease, kind) => kind === 'capsule-test' ? tests.confirmStopped(id, lease) : kind === 'capsule' ? storage.confirmContainerStopped(id, lease) : worktrees.confirmContainerStopped(id, lease) });
  const accounts = new ProviderAccountLaunchService(() => settings, { generation: 0, get: async () => { await hooks.account?.(); return 'fixture'; } });
  manager.configureProviderLaunch(new SessionLaunchCoordinator(accounts, worktrees, () => settings, undefined, containers, capsules));
  settings.capsuleTestProfiles = [{ id: 'unit', label: 'Unit', containerProfileId: 'image', command: '/usr/bin/node', args: ['--test'], timeoutMs: 1000, outputBytes: 32768 }];
  tests = new CapsuleTestService(capsules, containers, () => settings, { rootDirectory: join(root, 'test-runs'), runner: async () => { engine.state.started = true; engine.state.exitCode = 0; return { output: 'x'.repeat(20000), exitCode: 0, truncated: false }; } });
  const control = new AgentControlService(manager), scope = new ScopedCapsuleControl(manager, control, capsules, tests);
  const handler = new ScopedOrchestrationHandler(control, scope);
  const run = (tool, args, id = parent.id, signal) => handler.execute(id, { id: 'request', tool, arguments: args }, signal);
  const spawn = () => run('spawn_capsule_agent', { provider: 'opencode', files: ['code.ts'], task: 'Update selected code', accountId: 'api', containerProfileId: 'image' });
  const stop = async child => {
    manager.dispose(child.sessionId);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await capsules.summary(child.capsuleId)).state === 'retained') return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Fixture container stop did not settle.');
  };
  t.after(async () => { await tests.shutdown(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, source, settings, storage, capsules, manager, parent, foreign, engine, calls, exits, control, run, spawn, stop, tests };
}

test('capsule catalog validates bounded unique path arrays and exact operation fields', () => {
  const args = { provider: 'opencode', files: ['code.ts'], task: 'Task', containerProfileId: 'image' };
  assert.equal(validateOrchestrationArguments('spawn_capsule_agent', args).ok, true);
  for (const files of [[], ['code.ts', 'CODE.ts'], [null], ['x'.repeat(1025)], Array(129).fill('x')]) assert.equal(validateOrchestrationArguments('spawn_capsule_agent', { ...args, files }).ok, false);
  for (const extra of [{ trusted: true }, { dataClass: 'D0' }, { cwd: '/foreign' }, { initialPrompt: 'raw' }, { command: '/bin/sh' }]) assert.equal(validateOrchestrationArguments('spawn_capsule_agent', { ...args, ...extra }).ok, false);
});

test('authenticated parent launches exact capsule, reviews bounded pages and applies its retained output', async t => {
  const f = await fixture(t), child = await f.spawn(); await f.manager.waitForLaunch(child.sessionId);
  assert.equal(f.control.status(child.sessionId).exitCode, null, f.control.status(child.sessionId).failureDetails);
  assert.equal(f.control.status(child.sessionId).parentSessionId, f.parent.id);
  assert.equal(f.control.status(child.sessionId).allowSubagents, false);
  await f.stop(child); const c = f.storage.describe(child.capsuleId);
  await writeFile(join(c.directory, 'code.ts'), `${'line of output\n'.repeat(16000)}`);
  const review = await f.run('review_capsule', { capsuleId: child.capsuleId });
  assert.equal(review.patch.length, 8192); assert.ok(review.nextOffset > 0);
  encodeOrchestrationServerMessage({ v: 1, type: 'response', id: 'request', result: review });
  const next = await f.run('read_capsule_patch', { capsuleId: child.capsuleId, reviewId: review.reviewId, offset: review.nextOffset });
  assert.equal(next.offset, review.nextOffset); assert.equal(next.digest, review.digest);
  const applied = await f.run('apply_capsule', { capsuleId: child.capsuleId, reviewId: review.reviewId });
  assert.equal(applied.digest, review.digest); assert.equal(await readFile(join(f.source, 'code.ts'), 'utf8'), 'line of output\n'.repeat(16000));
  await f.run('apply_capsule', { capsuleId: child.capsuleId, reviewId: review.reviewId });
});

test('foreign parent, child self and generic prompt/spawn routes cannot use capsule authority', async t => {
  const f = await fixture(t), child = await f.spawn(); await f.manager.waitForLaunch(child.sessionId);
  for (const id of [f.foreign.id, child.sessionId]) await assert.rejects(f.run('review_capsule', { capsuleId: child.capsuleId }, id), /not authorized/i);
  assert.throws(() => f.control.send(child.sessionId, 'raw parent data'), /Task.md|capsule/i);
  assert.throws(() => f.control.spawn({ parentSessionId: f.parent.id, provider: 'opencode', cwd: f.source, isolation: { mode: 'container', profileId: 'image', capsuleId: child.capsuleId } }), /capsule/i);
  const userCapsule = await f.capsules.prepare({ sourceCwd: f.source, files: ['code.ts'], task: { text: 'User task', dataClass: 'D1' } });
  await assert.rejects(f.run('review_capsule', { capsuleId: userCapsule.id }), /not authorized/i);
  await assert.rejects(f.run('review_capsule', { capsuleId: '11111111-1111-4111-8111-111111111111' }), /not authorized/i);
});

test('parent source class cannot be lowered through agent-authored task text', async t => {
  const f = await fixture(t); f.settings.defaultDataClass = 'D2';
  await assert.rejects(f.spawn(), /policy|class|D2|changed|authoriz/i);
  assert.equal(f.engine.calls.filter(call => call.args.includes('create')).length, 0);
});

test('expired parent generation and policy changes during preparation deny process launch', async t => {
  let f; f = await fixture(t, { account: async () => { f.exits[0]({ exitCode: 0 }); } });
  const child = await f.spawn(); await f.manager.waitForLaunch(child.sessionId);
  assert.equal(f.control.status(child.sessionId).exitCode, 1);
  assert.equal(f.engine.calls.filter(call => call.args.includes('create')).length, 0);
  await assert.rejects(f.run('review_capsule', { capsuleId: child.capsuleId }), /not authorized/i);
});

test('restarting the same parent id revokes persisted capsule ownership', async t => {
  const f = await fixture(t), child = await f.spawn(); await f.manager.waitForLaunch(child.sessionId); await f.stop(child);
  const before = f.manager.capsuleAuthority(f.parent.id).generation;
  f.exits[0]({ exitCode: 0 });
  f.manager.configureProviderLaunch({ async prepare() { return { args: [], environment: {}, unsetEnvironment: [], skipBridges: true, bindingDigest: 'fixture', assertCurrent() {}, async cleanup() {} }; } });
  f.manager.restart(f.parent.id); await f.manager.waitForLaunch(f.parent.id);
  assert.notEqual(f.manager.capsuleAuthority(f.parent.id).generation, before);
  const recovered = new TaskCapsuleService({ rootDirectory: join(f.root, 'capsules') }); await recovered.recover();
  assert.equal(recovered.describe(child.capsuleId).owner.generation, before);
  await assert.rejects(f.run('review_capsule', { capsuleId: child.capsuleId }), /not authorized/i);
  assert.deepEqual((await f.run('list_capsules', {})).capsules, []);
  assert.equal((await f.capsules.list()).length, 1);
});

test('parent expiry at the apply write boundary preserves original source and retained output', async t => {
  let f; f = await fixture(t, { beforeApplyWrite: () => f.exits[0]({ exitCode: 0 }) });
  const child = await f.spawn(); await f.manager.waitForLaunch(child.sessionId); await f.stop(child);
  await writeFile(join(f.storage.describe(child.capsuleId).directory, 'code.ts'), 'new output\n');
  const review = await f.run('review_capsule', { capsuleId: child.capsuleId });
  await assert.rejects(f.run('apply_capsule', { capsuleId: child.capsuleId, reviewId: review.reviewId }), /rolled back|authorized/i);
  assert.equal(await readFile(join(f.source, 'code.ts'), 'utf8'), 'baseline\n');
  assert.equal((await f.capsules.summary(child.capsuleId)).state, 'retained');
});

test('source policy changes revoke scope; unrelated UI settings do not', async t => {
  const f = await fixture(t), child = await f.spawn(); await f.manager.waitForLaunch(child.sessionId); await f.stop(child);
  f.settings.theme = 'light'; assert.equal((await f.run('list_capsules', {})).capsules[0].capsuleId, child.capsuleId);
  const review = await f.run('review_capsule', { capsuleId: child.capsuleId });
  f.settings.pathPolicies = [{ pattern: '/code.ts', dataClass: 'D2' }];
  await assert.rejects(f.run('apply_capsule', { capsuleId: child.capsuleId, reviewId: review.reviewId }), /not authorized/i);
  assert.equal(await readFile(join(f.source, 'code.ts'), 'utf8'), 'baseline\n');
});


test('canceling the authenticated request before source write prevents the apply', async t => {
  const cancellation = new AbortController();
  const f = await fixture(t, { beforeApplyWrite: () => cancellation.abort() });
  const child = await f.spawn(); await f.manager.waitForLaunch(child.sessionId); await f.stop(child);
  await writeFile(join(f.storage.describe(child.capsuleId).directory, 'code.ts'), 'cancelled output\n');
  const review = await f.run('review_capsule', { capsuleId: child.capsuleId });
  await assert.rejects(f.run('apply_capsule', { capsuleId: child.capsuleId, reviewId: review.reviewId }, f.parent.id, cancellation.signal), /rolled back|cancel/i);
  assert.equal(await readFile(join(f.source, 'code.ts'), 'utf8'), 'baseline\n');
  assert.equal((await f.capsules.summary(child.capsuleId)).state, 'retained');
});


test('scoped saved tests bind exact review and page output only to the owning live parent', async t => {
  const f = await fixture(t), child = await f.spawn(); await f.manager.waitForLaunch(child.sessionId); await f.stop(child);
  assert.equal((await f.run('list_capsule_test_profiles', {})).profiles[0].id, 'unit');
  const review = await f.run('review_capsule', { capsuleId: child.capsuleId });
  const started = await f.run('test_capsule', { capsuleId: child.capsuleId, reviewId: review.reviewId, testProfileId: 'unit' });
  await f.tests.wait(started.runId);
  const result = await f.run('get_capsule_test_result', { runId: started.runId });
  assert.equal(result.state, 'passed'); assert.equal(result.reviewDigest, review.digest); assert.equal(result.output.length, 8192); assert.equal(result.nextOffset, 8192);
  encodeOrchestrationServerMessage({ v: 1, type: 'response', id: 'test', result });
  assert.equal((await f.run('list_capsule_tests', { capsuleId: child.capsuleId })).tests[0].runId, started.runId);
  await assert.rejects(f.run('get_capsule_test_result', { runId: started.runId }, f.foreign.id), /not authorized/i);
  await assert.rejects(f.run('cancel_capsule_test', { runId: started.runId }, f.foreign.id), /not authorized/i);
  await assert.rejects(f.run('test_capsule', { capsuleId: child.capsuleId, reviewId: review.reviewId, testProfileId: 'unit', command: '/bin/sh' }), /Unexpected/);
});
