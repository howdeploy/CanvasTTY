import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerExecutionService } from '../src/main/services/ContainerExecutionService.ts';
import { capsuleEngine } from './helpers/capsule-engine.mjs';

async function fixture(t, hooks = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-test-container-'))), directory = join(root, 'snapshot'); await mkdir(directory);
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = { id: 'image', label: 'Image', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/fixture.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', commands: { opencode: '/usr/bin/opencode' }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: `${process.getuid()}:${process.getgid()}` };
  const testProfile = { id: 'tests', label: 'Unit tests', containerProfileId: 'image', command: '/usr/bin/node', args: ['--test', 'component.test.mjs'], timeoutMs: 5000, outputBytes: 8192 };
  const settings = { containerProfiles: [profile], remoteHosts: [], capsuleTestProfiles: [testProfile] };
  const engine = capsuleEngine(profile, hooks), stopped = [];
  const containers = new ContainerExecutionService(() => settings, { rootDirectory: join(root, 'containers'), runner: engine.runner, resolveEndpoint: engine.resolveEndpoint, onWorkspaceStopped: (...args) => { stopped.push(args); } });
  const workspace = { kind: 'capsule-test', id: randomUUID(), directory, sourceDirectory: directory };
  const prepare = active => containers.prepareTest('tests', workspace, active, randomUUID(), async () => {});
  return { root, profile, testProfile, settings, engine, stopped, containers, workspace, prepare };
}

test('saved tests force a local secret-free network-none noninteractive container', async t => {
  const f = await fixture(t), prepared = await f.prepare(); await prepared.beforeSpawn();
  const call = f.engine.calls.find(item => item.args.includes('create'));
  assert.ok(call.args.includes('--network=none')); assert.ok(!call.args.includes('--tty')); assert.ok(!call.args.includes('--interactive')); assert.ok(call.args.includes('--pull=never'));
  const recipe = JSON.parse(call.environment.CANVASTTY_CONTAINER_RECIPE);
  assert.equal(recipe.command, f.testProfile.command); assert.deepEqual(recipe.args, f.testProfile.args); assert.equal(recipe.api, undefined);
  assert.ok(!call.args.includes('--env=CANVASTTY_PROFILE_API_KEY'));
  assert.deepEqual(call.args.filter(arg => arg.startsWith('--mount=')), [`--mount=type=bind,src=${f.workspace.directory},dst=/workspace,readonly=false,bind-recursive=disabled,bind-propagation=rprivate`]);
  assert.ok(!prepared.process.args.includes('--interactive'));
  await assert.rejects(f.containers.testExit(prepared.generationId), /exit|finish/i);
  f.engine.state.started = true; f.engine.state.exitCode = 0;
  assert.equal((await f.containers.testExit(prepared.generationId)).exitCode, 0);
  await prepared.cleanup(); assert.equal(f.stopped[0][2], 'capsule-test');
});

test('test preparation rejects changed saved commands and remote test workspaces before create', async t => {
  let f; f = await fixture(t, { info: () => { f.settings.capsuleTestProfiles[0].args.push('changed'); } });
  await assert.rejects(f.prepare(), /changed|profile/i);
  assert.equal(f.engine.calls.filter(call => call.args.includes('create')).length, 0);
  f.settings.containerProfiles[0].hostId = 'server'; f.settings.containerProfiles[0].hostPython = '/usr/bin/python3';
  await assert.rejects(f.prepare(), /local/i);
});

test('test cleanup after restart retains exact purpose without requiring the deleted test profile', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  f.settings.capsuleTestProfiles = [];
  const recovered = new ContainerExecutionService(() => f.settings, { rootDirectory: join(f.root, 'containers'), runner: f.engine.runner, resolveEndpoint: f.engine.resolveEndpoint, onWorkspaceStopped: (...args) => f.stopped.push(args) });
  assert.equal((await recovered.list())[0].state, 'cleanup-needed');
  await recovered.cleanup(prepared.generationId); assert.equal(f.stopped[0][2], 'capsule-test');
});

test('test inspection refuses a daemon that enables network or an interactive terminal', async t => {
  for (const change of [record => { record.HostConfig.NetworkMode = 'bridge'; }, record => { record.Config.Tty = true; }, record => { record.Config.OpenStdin = true; }]) {
    const f = await fixture(t, { inspect: change });
    await assert.rejects(f.prepare(), /identity|restriction|entrypoint/i);
    assert.equal((await f.containers.list())[0].state, 'cleanup-needed');
    assert.equal(f.stopped.length, 0);
  }
});

test('saved test profiles keep literal argv and refuse missing, excessive or arbitrary fields', async () => {
  const { assertCapsuleTestProfile, normalizeCapsuleTestProfiles } = await import('../src/shared/capsules.ts');
  const profile = { id: 'unit', label: 'Unit', containerProfileId: 'image', command: '/usr/bin/node', args: ['--test', 'literal $HOME; `text`'], timeoutMs: 1000, outputBytes: 1024 };
  assertCapsuleTestProfile(profile);
  assert.deepEqual(normalizeCapsuleTestProfiles([profile, profile]), [profile]);
  for (const patch of [{ id: undefined }, { containerProfileId: undefined }, { args: [null] }, { args: ['x'.repeat(4097)] }, { command: 'node' }, { command: '/usr/../bin/node' }, { timeoutMs: 120001 }, { outputBytes: 1048577 }, { env: { FAKE: 'fixture' } }]) assert.throws(() => assertCapsuleTestProfile({ ...profile, ...patch }));
});
