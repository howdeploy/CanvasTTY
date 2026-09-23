import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskCapsuleService } from '../src/main/services/TaskCapsuleService.ts';
import { CapsuleLaunchService } from '../src/main/services/CapsuleLaunchService.ts';
import { ContainerExecutionService } from '../src/main/services/ContainerExecutionService.ts';
import { ProviderAccountLaunchService } from '../src/main/services/ProviderAccountLaunchService.ts';
import { SessionLaunchCoordinator } from '../src/main/services/SessionLaunchCoordinator.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { WorktreeService } from '../src/main/services/WorktreeService.ts';
import { capsuleEngine } from './helpers/capsule-engine.mjs';
import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';
import { normalizePersistedTerminalSessions, persistedTerminalSession } from '../src/main/services/TerminalSessionStore.ts';

async function fixture(t, hooks = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-capsule-runtime-'))), source = join(root, 'source');
  await mkdir(source); const git = args => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git(['init']); await writeFile(join(source, 'code.ts'), 'committed\n'); await writeFile(join(source, 'private.txt'), 'excluded\n'); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base']);
  await writeFile(join(source, 'code.ts'), 'selected dirty bytes\n');
  const profile = { id: 'image', label: 'Image', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/fixture.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', commands: { opencode: '/usr/bin/opencode' }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: `${process.getuid()}:${process.getgid()}` };
  const settings = { containerProfiles: [profile], remoteHosts: [], providerAccounts: [{ id: 'api', label: 'API', provider: 'opencode', binding: { kind: 'api-profile', profileId: 'backend' } }], apiProfiles: [{ id: 'backend', name: 'Backend', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', secretRef: 'OPENAI_API_KEY', defaultModel: 'fixture-model' }], defaultDataClass: 'D2', pathPolicies: [{ pattern: '/code.ts', dataClass: 'D1' }], requiresSandboxProfiles: [], maxAccountsPerProviderPerHost: 1 };
  settings.providerAccounts[0].assessment = { profile: { training: 'may-train', retention: 'persistent', thirdPartyProcessing: 'unknown', contractualMode: 'api' }, evidence: { kind: 'user-attested', reviewedAt: '2026-09-21', sources: [], note: 'Synthetic fixture only', models: '*', binding: accountRouteBinding(settings.providerAccounts[0], settings.apiProfiles) } };
  const storage = new TaskCapsuleService({ rootDirectory: join(root, 'capsules') }), capsules = new CapsuleLaunchService(storage, () => settings);
  const capsule = await capsules.prepare({ sourceCwd: source, files: ['code.ts'], task: { text: 'Update code.ts; read Task.md.', dataClass: 'D1' } });
  const engine = capsuleEngine(profile, hooks), worktrees = new WorktreeService({ rootDirectory: join(root, 'worktrees') });
  const containers = new ContainerExecutionService(() => settings, { rootDirectory: join(root, 'containers'), runner: engine.runner, resolveEndpoint: engine.resolveEndpoint, onWorkspaceStopped: (id, lease, kind) => kind === 'capsule' ? storage.confirmContainerStopped(id, lease) : worktrees.confirmContainerStopped(id, lease) });
  let keyReads = 0; const accounts = new ProviderAccountLaunchService(() => settings, { generation: 0, get: async () => { keyReads++; await hooks.account?.(); return 'fixture'; } });
  const calls = [], exits = [];
  const manager = new TerminalManager(() => {}, { get() { throw new Error('No host discovery'); } }, undefined, undefined, false, (command, args, options) => { calls.push({ command, args, ...options }); let exit; return { onData() {}, onExit(cb) { exit = cb; exits.push(cb); }, write() {}, resize() {}, kill() { exit?.({ exitCode: 0 }); } }; });
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings, { capsulePolicy: r => capsules.classify(r) }));
  const coordinator = new SessionLaunchCoordinator(accounts, worktrees, () => settings, { checkShell() { throw new Error('No remote access'); }, place() { throw new Error('No placement'); } }, containers, capsules);
  manager.configureProviderLaunch(coordinator);
  t.after(async () => { await manager.shutdown(); await worktrees.dispose(); await rm(root, { recursive: true, force: true }); });
  const create = () => manager.create({ provider: 'opencode', profile: 'normal', cwd: source, accountId: 'api', position: { x: 0, y: 0 }, isolation: { mode: 'container', profileId: profile.id, capsuleId: capsule.id } });
  return { root, source, storage, capsules, capsule, engine, worktrees, containers, settings, manager, coordinator, create, calls, exits, keyReads: () => keyReads };
}

test('real capsule launch mounts only selected current files and retains output after confirmed cleanup', async t => {
  const f = await fixture(t), session = f.create(); await f.manager.waitForLaunch(session.id);
  const actual = f.manager.list()[0]; assert.equal(actual.exitCode, null, actual.failureDetails);
  assert.equal(actual.execution.workspaceId, f.capsule.id); assert.equal(actual.dataClass, 'D1');
  assert.equal(actual.execution.hostWorkspace, f.capsule.directory); assert.equal(actual.execution.executionCwd, '/workspace');
  const create = f.engine.calls.find(c => c.args.includes('create'));
  const args = JSON.parse(create.environment.CANVASTTY_CONTAINER_RECIPE).args;
  assert.match(args[args.indexOf('--prompt') + 1], /Read \/workspace\/Task.md/);
  assert.match(create.args.find(a => a.startsWith('--mount=')), new RegExp(f.capsule.id));
  assert.equal(await readFile(join(f.capsule.directory, 'code.ts'), 'utf8'), 'selected dirty bytes\n');
  await assert.rejects(readFile(join(f.capsule.directory, 'private.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.capsule.directory, '.git')), { code: 'ENOENT' });
  assert.equal((await f.storage.list())[0].state, 'running'); assert.equal((await f.worktrees.list()).length, 0);
  await writeFile(join(f.capsule.directory, 'code.ts'), 'agent output\n');
  await f.manager.shutdown(); assert.equal((await f.storage.list())[0].state, 'retained');
  assert.match((await f.storage.review(f.capsule.id)).patch, /agent output/);
  assert.equal(await readFile(join(f.source, 'code.ts'), 'utf8'), 'selected dirty bytes\n');
});

test('changed capsule files during account preparation never reach container create', async t => {
  let f; f = await fixture(t, { account: async () => { await writeFile(join(f.capsule.directory, 'code.ts'), 'changed after capture'); } });
  const session = f.create(); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 0); assert.equal(f.engine.calls.some(c => c.args.includes('create')), false);
  assert.match(f.manager.list()[0].failureDetails, /capsule.*changed|changed.*capsule/i);
  assert.equal((await f.storage.list())[0].state, 'retained');
});

test('changed capsule after daemon create is stopped before PTY spawn, including unexpected owned-looking files', async t => {
  const f = await fixture(t, { created: async directory => { await writeFile(join(directory, '.canvastty-foreign'), 'not a launch marker'); } });
  const session = f.create(); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 0); assert.match(f.manager.list()[0].failureDetails, /Unselected capsule/);
  assert.equal(f.engine.state.exists, false); assert.equal((await f.storage.list())[0].state, 'retained');
});

test('current path policy is rechecked after a credential wait and never falls back to a full checkout', async t => {
  let f; f = await fixture(t, { account: async () => { f.settings.pathPolicies = []; } });
  const session = f.create(); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 0); assert.equal(f.engine.calls.some(c => c.args.includes('create')), false);
  assert.match(f.manager.list()[0].failureDetails, /policy changed|D2/);
  assert.equal((await f.worktrees.list()).length, 0); assert.equal((await f.storage.list())[0].state, 'retained');
});

test('unknown create result survives app recovery and holds its capsule until exact generation cleanup', async t => {
  let f; f = await fixture(t, { created: async () => { f.engine.state.exists = false; throw new Error('Lost daemon response'); } });
  const session = f.create(); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 0); assert.equal((await f.storage.list())[0].state, 'uncertain');
  const [generation] = await f.containers.list(); assert.ok(generation);
  const recovered = new TaskCapsuleService({ rootDirectory: join(f.root, 'capsules') });
  assert.equal((await recovered.list())[0].state, 'uncertain');
  await assert.rejects(recovered.review(f.capsule.id), /running|unconfirmed/);
  await assert.rejects(f.containers.cleanup(generation.id), /unconfirmed|unknown/);
  f.engine.state.exists = true; await f.containers.cleanup(generation.id);
  const after = new TaskCapsuleService({ rootDirectory: join(f.root, 'capsules') });
  assert.equal((await after.list())[0].state, 'retained');
});

test('cancellation during account preparation releases its lease without creating a container', async t => {
  let release, entered; const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { account: async () => { entered(); await gate; } });
  const session = f.create(); const pending = f.manager.waitForLaunch(session.id); await ready;
  f.manager.dispose(session.id); release(); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.engine.calls.some(c => c.args.includes('create')), false);
  assert.equal((await f.storage.list())[0].state, 'retained');
});

test('capsule identity survives persistence and mismatched saved workspace identities are refused', async t => {
  const f = await fixture(t), session = f.create(); await f.manager.waitForLaunch(session.id);
  const saved = persistedTerminalSession(f.manager.list()[0]);
  const state = { version: 1, sessions: [saved] };
  assert.equal(normalizePersistedTerminalSessions(state).sessions[0].isolation.capsuleId, f.capsule.id);
  assert.equal(normalizePersistedTerminalSessions({ ...state, sessions: [{ ...saved, workspaceId: '11111111-1111-4111-8111-111111111111' }] }).sessions.length, 0);
  const bad = { ...f.manager.list()[0], execution: { ...f.manager.list()[0].execution, workspaceId: '11111111-1111-4111-8111-111111111111' } };
  await assert.rejects(f.coordinator.prepare(bad, false), /identity/);
});

test('unclassified initial prompts cannot bypass the capsule Task.md capture', async t => {
  const f = await fixture(t);
  assert.throws(() => f.manager.create({ provider: 'opencode', profile: 'normal', cwd: f.source, accountId: 'api', position: { x: 0, y: 0 }, isolation: { mode: 'container', profileId: 'image', capsuleId: f.capsule.id }, initialPrompt: 'Unclassified source text' }), /Task.md|classified/);
  assert.equal(f.keyReads(), 0);
});
