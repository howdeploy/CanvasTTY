import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskCapsuleService } from '../src/main/services/TaskCapsuleService.ts';
import { CapsuleLaunchService } from '../src/main/services/CapsuleLaunchService.ts';
import { ContainerExecutionService } from '../src/main/services/ContainerExecutionService.ts';
import { capsuleEngine } from './helpers/capsule-engine.mjs';

async function fixture(t, hooks = {}) {
  const { CapsuleTestService } = await import('../src/main/services/CapsuleTestService.ts');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-test-runs-'))), source = join(root, 'source');
  await mkdir(source); execFileSync('git', ['-C', source, 'init'], { stdio: 'pipe' });
  await writeFile(join(source, 'code.ts'), 'original\n'); await writeFile(join(source, 'removed.ts'), 'delete\n'); await writeFile(join(source, 'private.txt'), 'unselected');
  const profile = { id: 'image', label: 'Image', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/fixture.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', commands: { opencode: '/usr/bin/opencode' }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: `${process.getuid()}:${process.getgid()}` };
  const settings = { defaultDataClass: 'D1', pathPolicies: [], containerProfiles: [profile], remoteHosts: [], capsuleTestProfiles: [{ id: 'unit', label: 'Unit', containerProfileId: 'image', command: '/usr/bin/node', args: ['--test'], timeoutMs: 1000, outputBytes: 1024 }] };
  const capsules = new CapsuleLaunchService(new TaskCapsuleService({ rootDirectory: join(root, 'capsules') }), () => settings);
  const capsule = await capsules.prepare({ sourceCwd: source, files: ['code.ts', 'removed.ts'], task: { text: 'Private task text not needed by tests', dataClass: 'D1' } });
  await writeFile(join(capsule.directory, 'code.ts'), 'reviewed\n'); await rm(join(capsule.directory, 'removed.ts'));
  const review = await capsules.review(capsule.id), engine = capsuleEngine(profile, hooks);
  let service, runs = 0;
  const containers = new ContainerExecutionService(() => settings, { rootDirectory: join(root, 'containers'), runner: engine.runner, resolveEndpoint: engine.resolveEndpoint, onWorkspaceStopped: (id, lease) => service.confirmStopped(id, lease) });
  const runner = async (process, options) => { runs++; const result = await hooks.run?.(process, options); engine.state.started = true; engine.state.exitCode = 0; return result ?? { output: 'passed\n', truncated: false, exitCode: 0 }; };
  service = new CapsuleTestService(capsules, containers, () => settings, { rootDirectory: join(root, 'test-runs'), runner });
  t.after(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  const start = () => service.start(capsule.id, review.reviewId, 'unit');
  return { root, source, settings, capsules, capsule, review, engine, containers, service, start, runs: () => runs, CapsuleTestService };
}

test('saved tests use a fresh frozen reviewed snapshot and persist exact result association', async t => {
  let f; f = await fixture(t, { run: async process => {
    assert.notEqual(process.cwd, f.source); assert.notEqual(process.cwd, f.capsule.directory);
    assert.deepEqual((await readdir(process.cwd)).filter(name => !name.startsWith('.canvastty-container-')), ['code.ts']);
    assert.equal(await readFile(join(process.cwd, 'code.ts'), 'utf8'), 'reviewed\n');
    assert.equal(process.environment.CANVASTTY_PROFILE_API_KEY, undefined);
  } });
  const run = await f.start(), result = await f.service.wait(run.id);
  assert.equal(result.state, 'passed'); assert.equal(result.reviewDigest, f.review.digest); assert.equal(result.output, 'passed\n'); assert.equal(result.stopped, true);
  assert.equal(await readFile(join(f.source, 'code.ts'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(f.source, 'removed.ts'), 'utf8'), 'delete\n');
  const recovered = new f.CapsuleTestService(f.capsules, f.containers, () => f.settings, { rootDirectory: join(f.root, 'test-runs'), runner: () => { throw new Error('Never replay a test'); } });
  assert.equal((await recovered.get(run.id)).state, 'passed');
});

test('stale review and unknown saved test profile cannot start a container', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.start(f.capsule.id, f.review.reviewId, 'foreign'), /profile|configured/i);
  await writeFile(join(f.capsule.directory, 'code.ts'), 'unreviewed\n');
  await assert.rejects(f.start(), /changed|review/i);
  assert.equal(f.runs(), 0); assert.equal(f.engine.calls.length, 0);
});

test('unknown container create preserves the test snapshot and recovers without rerunning', async t => {
  const f = await fixture(t, { created: () => { throw new Error('Lost reply'); } });
  f.engine.state.fail = 'ls';
  const run = await f.start(), result = await f.service.wait(run.id);
  assert.equal(result.state, 'uncertain'); assert.equal(result.stopped, false); assert.equal(f.runs(), 0);
  const recovered = new f.CapsuleTestService(f.capsules, f.containers, () => f.settings, { rootDirectory: join(f.root, 'test-runs'), runner: () => { throw new Error('Never replay'); } });
  assert.equal((await recovered.get(run.id)).state, 'uncertain');
  assert.equal(await readFile(join(result.directory, 'code.ts'), 'utf8'), 'reviewed\n');
  f.engine.state.fail = null;
  const recoveredContainers = new ContainerExecutionService(() => f.settings, { rootDirectory: join(f.root, 'containers'), runner: f.engine.runner, resolveEndpoint: f.engine.resolveEndpoint, onWorkspaceStopped: (id, lease) => recovered.confirmStopped(id, lease) });
  await recovered.confirmStopped(run.id, 'wrong-lease'); assert.equal((await recovered.get(run.id)).stopped, false);
  await recoveredContainers.cleanup((await recoveredContainers.list())[0].id);
  assert.equal((await recovered.get(run.id)).stopped, true); assert.equal((await recovered.get(run.id)).state, 'failed');
  assert.equal(f.runs(), 0);
});


test('cancelled and output-limited runs retain logs and snapshots after confirmed cleanup', async t => {
  for (const reason of ['cancelled', 'output-limit', 'timeout']) {
    const f = await fixture(t, { run: async () => ({ output: 'partial', truncated: reason === 'output-limit', exitCode: null, reason }) });
    const started = await f.start(), result = await f.service.wait(started.id);
    assert.equal(result.state, reason === 'cancelled' ? 'cancelled' : 'failed'); assert.equal(result.stopped, true);
    assert.equal(result.output, 'partial'); assert.equal(await readFile(join(result.directory, 'code.ts'), 'utf8'), 'reviewed\n');
    await f.service.cleanup(started.id); assert.equal((await f.service.list()).length, 0);
  }
});

test('snapshot mutation before create and changed command cannot start a test process', async t => {
  let f; f = await fixture(t, { info: async () => {
    const [run] = await f.service.list(); await writeFile(join(run.directory, 'code.ts'), 'unexpected');
  } });
  const started = await f.start(), result = await f.service.wait(started.id);
  assert.equal(result.state, 'failed'); assert.equal(f.runs(), 0); assert.equal(result.stopped, true);
  assert.equal(f.engine.calls.filter(call => call.args.includes('create')).length, 0);
});

test('changed private ownership blocks test cleanup and recovered malformed records stay visible', async t => {
  const f = await fixture(t), started = await f.start(); await f.service.wait(started.id);
  await writeFile(join(f.root, 'test-runs', started.id, 'owner'), 'changed');
  await assert.rejects(f.service.cleanup(started.id), /ownership/i);
  const recovered = new f.CapsuleTestService(f.capsules, f.containers, () => f.settings, { rootDirectory: join(f.root, 'test-runs') });
  assert.equal((await recovered.list())[0].state, 'unavailable');
  assert.equal(await readFile(join(started.directory, 'code.ts'), 'utf8'), 'reviewed\n');
});

test('malformed persisted result fields never recover as a successful test', async t => {
  const f = await fixture(t), started = await f.start(); await f.service.wait(started.id);
  const path = join(f.root, 'test-runs', started.id, 'manifest.json'), raw = await readFile(path, 'utf8');
  for (const patch of [{ exitCode: '0' }, { truncated: 'false' }, { createdAt: -1 }, { finishedAt: 'yesterday' }, { generationId: '../foreign' }, { reason: {} }, { imageId: {} }]) {
    const manifest = JSON.parse(raw); Object.assign(manifest.run, patch); await writeFile(path, JSON.stringify(manifest));
    const recovered = new f.CapsuleTestService(f.capsules, f.containers, () => f.settings, { rootDirectory: join(f.root, 'test-runs') });
    assert.equal((await recovered.list())[0].state, 'unavailable', JSON.stringify(patch));
  }
});
