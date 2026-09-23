import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextProfileStore } from '../src/main/services/ContextProfileStore.ts';
import { ContextLaunchService } from '../src/main/services/ContextLaunchService.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { TerminalManager } from './helpers/delegation-test-manager.mjs';
import { persistedTerminalSession } from '../src/main/services/TerminalSessionStore.ts';
import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';
const request = (cwd, extra = {}) => ({ provider: 'claude', cwd, profile: 'normal', position: { x: 0, y: 0 }, ...extra });
function fixture(t, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-runtime-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'source'); mkdirSync(cwd);
  const store = new ContextProfileStore(join(root, 'profiles')), context = new ContextLaunchService(store);
  const settings = { contextProfilesEnabled: true, defaultDataClass: 'D0', pathPolicies: [], providerAccounts: [], remoteHosts: [], ...extra };
  const calls = [], events = [], exits = [];
  const manager = new TerminalManager((...event) => events.push(event), { get: provider => ({ state: 'available', provider, executable: '/fake/' + provider, launcher: 'native', environment: {}, checked: [] }) }, undefined, undefined, false, (command, args, options) => {
    calls.push({ command, args, options }); return { pid: 1, onData() {}, onExit(callback) { exits.push(callback); }, kill() {}, write() { throw new Error('No startup typing'); }, resize() {} };
  }); t.after(() => manager.disposeAll());
  const policy = new SessionLaunchPolicy(() => settings, { context }); manager.configureLaunchPolicy(policy); manager.configureContextLaunch(context, () => settings.contextProfilesEnabled);
  return { root, cwd, store, context, settings, calls, events, exits, manager, policy };
}
async function addRules(f) {
  let state = await f.store.saveProject({ root: f.cwd, label: 'P' }, 0); f.projectId = state.projects[0].id;
  state = await f.store.saveTask({ projectId: f.projectId, label: 'Task' }, state.revision); f.taskId = state.tasks[0].id;
  for (const input of [
    { scope: 'user', key: 'tone', value: 'PUBLIC_LOSER', dataClass: 'D0' },
    { scope: 'project', ownerId: f.projectId, key: 'tone', value: 'PRIVATE_WINNER', dataClass: 'D2' }
  ]) state = await f.store.saveRule({ category: 'design', tags: [], enabled: true, ...input }, state.revision);
}
test('common policy rejects freeform task and retained history before low-clearance routing', t => {
  const f = fixture(t);
  assert.throws(() => f.policy.check(request(f.cwd, { provider: 'codex', dataClass: 'D0', initialPrompt: 'private task' }), []), /D2/);
  assert.throws(() => f.policy.check({ ...request(f.cwd, { provider: 'codex' }), dataClassInherited: true, disclosureClass: 'D2' }, []), /D2/);
});
test('disabled runtime has zero context store/source I/O and no metadata text', t => {
  const f = fixture(t, { contextProfilesEnabled: false });
  f.manager.configureContextLaunch(new ContextLaunchService({ capture() { throw new Error('Context accessed while off'); } }), () => false);
  const session = f.manager.create(request(f.cwd, { provider: 'codex' })); assert.equal(f.calls.length, 1); assert.equal(session.contextSummary, undefined);
});
test('real manager delivers passive projection once and retains private disclosure floor', async t => {
  const f = fixture(t); await addRules(f);
  const account = { id: 'private', label: 'Private', provider: 'claude' };
  account.assessment = { profile: { training: 'none', retention: 'bounded', thirdPartyProcessing: 'no', contractualMode: 'business' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: 'Explicit test assessment', binding: accountRouteBinding(account), models: '*' } };
  f.settings.providerAccounts = [account];
  const session = f.manager.create(request(f.cwd, { context: { enabled: true } }));
  assert.equal(f.calls[0].args.filter(x => String(x).includes('PRIVATE_WINNER')).length, 1);
  assert.equal(session.disclosureClass, 'D2'); assert.equal(session.contextSummary.status, 'delivered');
  assert.doesNotMatch(JSON.stringify(persistedTerminalSession(session)), /PRIVATE_WINNER|PUBLIC_LOSER/);
  f.settings.defaultDataClass = 'D0'; f.settings.contextProfilesEnabled = false;
  assert.equal(f.policy.check({ ...session, dataClassInherited: true }, [], session.id).dataClass, 'D2');
});
test('deferred Grok detects same-class disk edit before preparation or spawn', async t => {
  const f = fixture(t); await addRules(f);
  const session = f.manager.create(request(f.cwd, { provider: 'grok', context: { enabled: true } }));
  const path = join(f.root, 'profiles', 'profiles.json'); const raw = readFileSync(path, 'utf8'); writeFileSync(path, raw.replace('PRIVATE_WINNER', 'EDITED_WINNER'), { mode: 0o600 });
  f.manager.resize(session.id, 80, 24); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 0); assert.match(f.manager.list()[0].failureDetails, /changed|reload|stale/i);
});
test('fixed projection uses actual assessed API cap and filters winners before disclosure', async t => {
  const f = fixture(t); await addRules(f);
  const capture = f.context.capture({ enabled: true, provider: 'codex' }, { sourceCwd: f.cwd, assertCurrent() {} });
  const low = f.policy.evaluateFixed(request(f.cwd, { provider: 'codex' }), [], undefined, capture);
  assert.doesNotMatch(low.context.text, /PRIVATE_WINNER|PUBLIC_LOSER/);
  const account = { id: 'api', provider: 'opencode', label: 'API', hostId: 'local', binding: { kind: 'api-profile', profileId: 'api' } };
  f.settings.apiProfiles = [{ id: 'api', name: 'API', protocol: 'openai-compatible', baseUrl: 'https://api.invalid/v1', defaultModel: 'test-model', secretRef: 'OPENAI_API_KEY' }];
  account.assessment = { profile: { training: 'none', retention: 'bounded', contractualMode: 'api', thirdPartyProcessing: 'unknown' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: ['https://api.invalid/privacy'], binding: accountRouteBinding(account, f.settings.apiProfiles), models: '*' } };
  f.settings.providerAccounts = [account];
  const apiCapture = f.context.capture({ enabled: true, provider: 'opencode' }, { sourceCwd: f.cwd, assertCurrent() {} });
  const high = f.policy.evaluateFixed(request(f.cwd, { provider: 'opencode', accountId: 'api' }), [], undefined, apiCapture);
  assert.match(high.context.text, /PRIVATE_WINNER/); assert.equal(high.request.dataClass, 'D2');
});

import { AgentControlService } from '../src/main/services/AgentControlService.ts';
import { TerminalSessionStore } from '../src/main/services/TerminalSessionStore.ts';
import { SessionLaunchCoordinator } from '../src/main/services/SessionLaunchCoordinator.ts';
import { ProviderAccountLaunchService } from '../src/main/services/ProviderAccountLaunchService.ts';
function assessed(account, profiles = []) {
  return { ...account, assessment: { profile: { training: 'none', retention: 'bounded', thirdPartyProcessing: 'no', contractualMode: 'business' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: 'Explicit private test route', binding: accountRouteBinding(account, profiles), models: '*' } } };
}
test('structured native prompts cannot bypass mandatory task floor by opening a blank low route', t => {
  const f = fixture(t, { contextProfilesEnabled: false });
  const session = f.manager.create(request(f.cwd, { provider: 'codex' }));
  assert.throws(() => new AgentControlService(f.manager).send(session.id, 'private later task'), /D2/);
});
test('trusted selection rejects forged authority even while disabled and scoped children cannot supply overrides', t => {
  const f = fixture(t, { contextProfilesEnabled: false });
  for (const forged of [{ disclosureClass: 'D0' }, { contextSummary: {} }, { sourceCwd: f.cwd }, { context: { enabled: false, projectId: 'forged' } }, { context: { enabled: true, current: [{ key: 'a', category: 'design', value: 'b', source: 'explicit' }] } }]) assert.throws(() => f.manager.create(request(f.cwd, forged)));
  const parent = f.manager.create(request(f.cwd, { role: 'orchestrator' }));
  assert.throws(() => new AgentControlService(f.manager).spawn({ parentSessionId: parent.id, provider: 'claude', cwd: f.cwd, context: { enabled: true } }), /inherited/);
});
test('owned worktree child and grandchild map to original source; other registered project excludes task/current', async t => {
  const f = fixture(t); await addRules(f);
  const execution = join(f.root, 'execution'), other = join(f.root, 'other'); mkdirSync(execution); mkdirSync(other);
  let state = await f.store.saveRule({ scope: 'task', ownerId: f.taskId, category: 'testing', key: 'task-rule', value: 'TASK_ONLY', tags: [], enabled: true, dataClass: 'D0' }, f.store.get().revision);
  await f.store.saveProject({ root: other, label: 'Other' }, state.revision);
  f.settings.providerAccounts = [assessed({ id: 'claude', provider: 'claude', label: 'Private', binding: { kind: 'cli-home', directory: f.cwd } })];
  f.settings.agentBudgets = { maxLocalAgents: 8, maxRemoteAgentsPerHost: 4, maxChildren: 6, maxDepth: 4 };
  const accounts = new ProviderAccountLaunchService(() => f.settings, { generation: 0, get: async () => { throw Error('No secrets'); } });
  const worktrees = { create: async () => ({ id: '11111111-1111-4111-8111-111111111111', sourceDirectory: f.cwd, directory: execution, commit: 'fake' }), setRunning: async () => {}, retain: async () => {} };
  f.manager.configureProviderLaunch(new SessionLaunchCoordinator(accounts, worktrees, () => f.settings, {}));
  const parent = f.manager.create(request(f.cwd, { role: 'orchestrator', isolation: { mode: 'worktree' }, context: { enabled: true, taskId: f.taskId, current: [{ key: 'current-rule', category: 'design', value: 'CURRENT_ONLY', dataClass: 'D0' }] } }));
  await f.manager.waitForLaunch(parent.id); assert.equal(f.calls[0].options.cwd, execution);
  const control = new AgentControlService(f.manager);
  const child = control.spawn({ parentSessionId: parent.id, provider: 'claude', cwd: execution, allowSubagents: true }); await f.manager.waitForLaunch(child.id);
  const grandchild = control.spawn({ parentSessionId: child.id, provider: 'codex', cwd: execution }); await f.manager.waitForLaunch(grandchild.id);
  const separate = control.spawn({ parentSessionId: parent.id, provider: 'codex', cwd: other }); await f.manager.waitForLaunch(separate.id);
  const payloads = f.calls.map(call => call.args.join('\n'));
  assert.match(payloads[1], /TASK_ONLY/); assert.match(payloads[1], /CURRENT_ONLY/); assert.match(payloads[1], /PRIVATE_WINNER/);
  assert.match(payloads[2], /TASK_ONLY/); assert.match(payloads[2], /CURRENT_ONLY/); assert.doesNotMatch(payloads[2], /PRIVATE_WINNER|PUBLIC_LOSER/);
  assert.doesNotMatch(payloads[3], /TASK_ONLY|CURRENT_ONLY|PRIVATE_WINNER/);
  assert.equal(f.manager.list().find(x => x.id === grandchild.id).contextSummary.projectId, f.projectId);
});
test('same-class change during account await rejects before spawn and cleans private configuration', async t => {
  const f = fixture(t); await addRules(f);
  const api = { id: 'api', name: 'API', protocol: 'openai-compatible', baseUrl: 'https://api.invalid/v1', secretRef: 'OPENAI_API_KEY', defaultModel: 'model-a' };
  f.settings.apiProfiles = [api]; f.settings.providerAccounts = [assessed({ id: 'api', provider: 'opencode', label: 'API', binding: { kind: 'api-profile', profileId: 'api' } }, [api])];
  let release, reads = 0;
  const account = new ProviderAccountLaunchService(() => f.settings, { generation: 0, get: () => { reads++; return new Promise(resolve => release = resolve); } }, { temporaryRoot: f.root });
  f.manager.configureProviderLaunch(new SessionLaunchCoordinator(account, {}, () => f.settings, {}));
  const session = f.manager.create(request(f.cwd, { provider: 'opencode', initialPrompt: 'task', context: { enabled: true } }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const rule = f.store.get().rules.find(r => r.value === 'PRIVATE_WINNER');
  await f.store.saveRule({ ...rule, value: 'EDITED_WINNER' }, f.store.get().revision);
  release('fixture-secret'); await f.manager.waitForLaunch(session.id);
  assert.equal(reads, 1); assert.equal(f.calls.length, 0); assert.match(f.manager.list()[0].failureDetails, /changed/);
});
test('native context restore refuses unknown conversation before account preparation', async t => {
  const f = fixture(t); await addRules(f);
  f.settings.providerAccounts = [assessed({ id: 'claude', label: 'Private', provider: 'claude' })];
  const session = f.manager.create(request(f.cwd, { context: { enabled: true, current: [{ category: 'design', key: 'current', value: 'NEVER_PERSIST_THIS' }] } }));
  const store = new TerminalSessionStore(f.root); await store.replace([persistedTerminalSession(session)]);
  assert.doesNotMatch(readFileSync(store.filePath, 'utf8'), /PRIVATE_WINNER|NEVER_PERSIST_THIS|PUBLIC_LOSER/);
  const restored = fixture(t); let preparations = 0;
  restored.manager.configureSessionPersistence(store, true);
  restored.manager.configureProviderLaunch({ async prepare() { preparations++; throw Error('No prepare expected'); } });
  await restored.manager.restorePersistedSessions();
  assert.equal(preparations, 0); assert.equal(restored.calls.length, 0);
  assert.match(restored.manager.list()[0].failureDetails, /Native context resume/);
});

import { execFileSync } from 'node:child_process';
import { WorktreeService } from '../src/main/services/WorktreeService.ts';
test('real Git WorktreeService ownership maps a derived child to the original registered project', async t => {
  const f = fixture(t); await addRules(f);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = args => execFileSync('git', ['-C', f.cwd, ...args], { env: environment, stdio: 'pipe' });
  git(['init', '-q']); writeFileSync(join(f.cwd, 'source.txt'), 'owned fixture\n'); git(['add', 'source.txt']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  f.settings.providerAccounts = [assessed({ id: 'claude', provider: 'claude', label: 'Private', binding: { kind: 'cli-home', directory: f.cwd } })];
  const worktrees = new WorktreeService({ rootDirectory: join(f.root, 'owned-worktrees') });
  f.manager.configureProviderLaunch(new SessionLaunchCoordinator(new ProviderAccountLaunchService(() => f.settings, { generation: 0, get: async () => { throw Error('No secrets'); } }), worktrees, () => f.settings, {}));
  const parent = f.manager.create(request(f.cwd, { role: 'orchestrator', isolation: { mode: 'worktree' }, context: { enabled: true, taskId: f.taskId } }));
  assert.equal(parent.contextSummary.status, 'waiting');
  await f.manager.waitForLaunch(parent.id);
  const ready = f.manager.list()[0]; assert.equal(ready.contextSummary.status, 'delivered'); assert.notEqual(ready.execution.executionCwd, f.cwd);
  const child = new AgentControlService(f.manager).spawn({ parentSessionId: parent.id, provider: 'claude', cwd: ready.execution.executionCwd }); await f.manager.waitForLaunch(child.id);
  const created = f.manager.list().find(x => x.id === child.id);
  assert.equal(created.contextSummary.projectId, f.projectId); assert.equal(created.contextSummary.taskId, f.taskId);
  assert.match(f.calls[1].args.join('\n'), /PRIVATE_WINNER/);
  await f.manager.shutdown();
});

import { HostPlacementService } from '../src/main/services/HostPlacement.ts';
import { ContainerPlacementService } from '../src/main/services/ContainerPlacement.ts';
test('native auto projects exact host/account routes before actual host probes and keeps the selected low route', async t => {
  const f = fixture(t); await addRules(f);
  f.settings.remoteHosts = ['high', 'low'].map(id => ({ id, label: id, sshHost: `${id}.invalid`, maxDataClass: id === 'high' ? 'D2' : 'D1', workspaces: [{ localPath: f.cwd, remotePath: '/work' }] }));
  f.settings.providerAccounts = ['high', 'low'].map(id => assessed({ id, label: id, provider: 'claude', hostId: id, ...(id === 'low' ? { maxDataClass: 'D1' } : {}) }));
  f.manager.configureRemoteHosts(id => f.settings.remoteHosts.find(h => h.id === id));
  const projections = [], probes = [], project = f.context.project.bind(f.context);
  f.context.project = (capture, route) => { const value = project(capture, route); projections.push({ route, value }); return value; };
  const placement = new HostPlacementService({ activeSessions: () => 0, metrics: async host => {
    assert.ok(projections.some(p => p.route.hostId === 'high') && projections.some(p => p.route.hostId === 'low'));
    probes.push(host.id); return { reachable: true, load1: host.id === 'low' ? 0 : 2, cores: 2, memoryAvailableMb: 4000 };
  }, discovery: async host => ({ reachable: true, providers: [{ provider: 'claude', installed: true }] }) });
  const parent = f.manager.create(request(f.cwd, { provider: 'codex', role: 'orchestrator' }));
  const control = new AgentControlService(f.manager, { place: req => placement.place(f.settings.remoteHosts, req) });
  const child = await control.spawn({ parentSessionId: parent.id, provider: 'claude', cwd: f.cwd, host: 'auto' });
  assert.equal(child.hostId, 'low'); assert.equal(child.accountId, 'low');
  assert.match(projections.find(p => p.route.hostId === 'high').value.text, /PRIVATE_WINNER/);
  assert.doesNotMatch(projections.find(p => p.route.hostId === 'low').value.text, /PRIVATE_WINNER|PUBLIC_LOSER/);
  assert.deepEqual(new Set(probes), new Set(['high', 'low']));
  assert.doesNotMatch(f.calls.at(-1).args.join('\n'), /PRIVATE_WINNER|PUBLIC_LOSER/);
});
test('container candidates project before probes, mandatory task excludes low cap, and same-class edit invalidates async choice', async t => {
  const f = fixture(t); await addRules(f);
  const profile = { id: 'image', label: 'Image', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/fixture.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', commands: { omp: '/usr/bin/omp' }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: '1000:1000' };
  f.settings.containerProfiles = [profile]; f.settings.maxAccountsPerProviderPerHost = 2;
  f.settings.apiProfiles = ['low', 'high'].map(id => ({ id, name: id, protocol: 'openai-compatible', baseUrl: 'https://api.invalid/v1', secretRef: id === 'low' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY', defaultModel: 'model-a' }));
  f.settings.providerAccounts = ['low', 'high'].map(id => assessed({ id, label: id, provider: 'omp', binding: { kind: 'api-profile', profileId: id }, ...(id === 'low' ? { maxDataClass: 'D1' } : {}) }, f.settings.apiProfiles));
  const projected = [], project = f.context.project.bind(f.context); f.context.project = (capture, route) => { const value = project(capture, route); projected.push({ route, value }); return value; };
  let mutate = false, inventories = 0;
  const placement = new ContainerPlacementService({ settings: () => f.settings, sessions: () => [], policy: f.policy,
    inventory: async ids => { inventories++; assert.ok(projected.length >= 2); return [{ hostId: 'local', runtime: 'docker', available: true, profiles: [{ profileId: 'image', imageAvailable: true, imageId: 'sha256:' + 'a'.repeat(64) }] }]; },
    metrics: async () => { if (mutate) { const rule = f.store.get().rules.find(r => r.value === 'PRIVATE_WINNER'); await f.store.saveRule({ ...rule, value: 'EDITED_SAME_CLASS' }, f.store.get().revision); } return { hostId: 'local', reachable: true, load1: 0, cores: 4, memoryAvailableMb: 4096 }; }
  });
  const input = request(f.cwd, { provider: 'omp', containerPlacement: {} });
  const capture = f.manager.prepareContextLaunch(input).capture;
  const selected = await placement.resolve(input, capture);
  assert.equal(projected.find(p => p.route.accountId === 'low').value.includedDataClass, 'D0'); assert.equal(projected.find(p => p.route.accountId === 'high').value.includedDataClass, 'D2');
  assert.doesNotMatch(projected.find(p => p.route.accountId === 'low').value.text, /PRIVATE_WINNER|PUBLIC_LOSER/);
  const task = await placement.resolve({ ...input, initialPrompt: 'private task', dataClass: 'D0' }, capture); assert.equal(task.request.accountId, 'high');
  mutate = true; await assert.rejects(placement.resolve(input, capture), /verify current|changed/); assert.throws(() => selected.assertCurrent(), /changed/); assert.equal(inventories, 3);
});

import { ContainerExecutionService } from '../src/main/services/ContainerExecutionService.ts';
import { capsuleEngine } from './helpers/capsule-engine.mjs';
test('actual policy/account/coordinator/worktree/container chain exposes context and task exactly once in engine recipe', async t => {
  const f = fixture(t); await addRules(f);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = args => execFileSync('git', ['-C', f.cwd, ...args], { env: environment, stdio: 'pipe' });
  git(['init', '-q']); writeFileSync(join(f.cwd, 'source.txt'), 'fixture\n'); git(['add', 'source.txt']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  const profile = { id: 'image', label: 'Image', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/fixture.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', commands: { omp: '/usr/bin/omp' }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: `${process.getuid()}:${process.getgid()}` };
  f.settings.containerProfiles = [profile]; f.settings.apiProfiles = [{ id: 'api', name: 'API', protocol: 'openai-compatible', baseUrl: 'https://api.invalid/v1', secretRef: 'OPENAI_API_KEY', defaultModel: 'model-a' }];
  f.settings.providerAccounts = [assessed({ id: 'api', label: 'API', provider: 'omp', binding: { kind: 'api-profile', profileId: 'api' } }, f.settings.apiProfiles)];
  const engine = capsuleEngine(profile), worktrees = new WorktreeService({ rootDirectory: join(f.root, 'worktrees') });
  const containers = new ContainerExecutionService(() => f.settings, { rootDirectory: join(f.root, 'containers'), runner: engine.runner, resolveEndpoint: engine.resolveEndpoint, onWorkspaceStopped: (id, lease) => worktrees.confirmContainerStopped(id, lease) });
  const accounts = new ProviderAccountLaunchService(() => f.settings, { generation: 0, get: async () => 'fixture-only-key' });
  f.manager.configureProviderLaunch(new SessionLaunchCoordinator(accounts, worktrees, () => f.settings, {}, containers));
  const session = f.manager.create(request(f.cwd, { provider: 'omp', isolation: { mode: 'container', profileId: 'image' }, initialPrompt: 'ONE_CONTAINER_TASK', context: { enabled: true } }));
  assert.equal(session.contextSummary.status, 'waiting'); await f.manager.waitForLaunch(session.id);
  const final = f.manager.list()[0]; assert.equal(final.status, 'unavailable', final.failureDetails); assert.equal(final.contextSummary.status, 'delivered');
  const recipe = JSON.parse(engine.calls.find(call => call.args.includes('create')).environment.CANVASTTY_CONTAINER_RECIPE);
  assert.equal(recipe.args.filter(arg => arg.includes('PRIVATE_WINNER')).length, 1); assert.equal(recipe.args.filter(arg => arg.includes('ONE_CONTAINER_TASK')).length, 1);
  assert.deepEqual(recipe.args.slice(0, 1), ['--append-system-prompt']); assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(persistedTerminalSession(final)), /PRIVATE_WINNER|ONE_CONTAINER_TASK/);
  await f.manager.shutdown();
});

test('fresh native restart reports the newly delivered digest/revision and starts context after an off launch', async t => {
  const f = fixture(t); await addRules(f); f.settings.providerAccounts = [assessed({ id: 'claude', label: 'Private', provider: 'claude' })];
  const original = f.manager.create(request(f.cwd)); f.exits[0]({ exitCode: 0 });
  const rule = f.store.get().rules.find(r => r.value === 'PRIVATE_WINNER'); await f.store.saveRule({ ...rule, value: 'RESTART_CHANGED' }, f.store.get().revision);
  const restarted = f.manager.restart(original.id); assert.notEqual(restarted.contextSummary.digest, original.contextSummary.digest); assert.equal(restarted.contextSummary.revision, f.store.get().revision); assert.equal(restarted.contextSummary.status, 'delivered'); assert.match(f.calls[1].args.join('\n'), /RESTART_CHANGED/);
  f.settings.contextProfilesEnabled = false;
  const off = f.manager.create(request(f.cwd)); assert.equal(off.contextSummary, undefined); f.exits[2]({ exitCode: 0 }); f.settings.contextProfilesEnabled = true;
  const enabled = f.manager.restart(off.id); assert.equal(enabled.contextSummary.status, 'delivered'); assert.match(f.calls[3].args.join('\n'), /RESTART_CHANGED/);
});

test('launcher source lookup returns only matching owned tasks, without raw rules', async t => {
  const f = fixture(t); await addRules(f);
  const other = join(f.root,'other'); mkdirSync(other);
  let state = await f.store.saveProject({ root: other, label:'Other' }, f.store.get().revision);
  await f.store.saveTask({projectId:state.projects.at(-1).id,label:'OTHER_TASK'},state.revision);
  const selected = f.store.source(f.cwd);
  assert.equal(selected.project.id,f.projectId); assert.deepEqual(selected.tasks.map(t=>t.id),[f.taskId]);
  assert.doesNotMatch(JSON.stringify(selected),/PRIVATE_WINNER|PUBLIC_LOSER|OTHER_TASK/);
  const path=join(f.root,'profiles','profiles.json'); writeFileSync(path,readFileSync(path,'utf8').replace('PRIVATE_WINNER','SAME_CLASS_EDIT'),{mode:0o600});
  assert.throws(()=>f.store.source(f.cwd),/changed|reload/);
});
test('explicit launch preview uses actual route cap, no sessions or processes, and off has zero IO', async t => {
  const f=fixture(t); await addRules(f);
  const low = await f.manager.previewContextLaunch(request(f.cwd,{provider:'codex',context:{enabled:true}}));
  assert.equal(low.enabled,true); assert.equal(low.text,''); assert.equal(low.dataClass,'D0');
  f.settings.providerAccounts=[assessed({id:'a',provider:'claude',label:'Private'})];
  const high = await f.manager.previewContextLaunch(request(f.cwd,{context:{enabled:true,taskId:f.taskId,current:[{category:'design',key:'tone',value:'CURRENT_WINNER',dataClass:'D2'}]}}));
  assert.match(high.text,/CURRENT_WINNER/); assert.doesNotMatch(high.text,/PRIVATE_WINNER|PUBLIC_LOSER/); assert.equal(high.route.accountId,'a'); assert.equal(high.dataClass,'D2');
  assert.equal(f.calls.length,0); assert.deepEqual(f.manager.list(),[]);
  await assert.rejects(f.manager.previewContextLaunch(request(f.cwd,{context:{enabled:true,taskId:'unknown'}})),/task/);
  await assert.rejects(f.manager.previewContextLaunch(request(f.cwd,{context:{enabled:true},disclosureClass:'D0'})),/owned/);
  f.settings.contextProfilesEnabled=false;
  f.manager.configureContextLaunch(new ContextLaunchService({capture(){throw Error('Off IO');}}),()=>false);
  const off=await f.manager.previewContextLaunch(request('/missing/source',{context:{enabled:true}}));
  assert.equal(off.enabled,false);assert.equal(off.text,'');assert.equal(f.calls.length,0);
});
test('a parent per-launch context opt-out is inherited without reading project context', async t => {
  const f=fixture(t); f.manager.configureContextLaunch(new ContextLaunchService({capture(){throw Error('Opt-out IO');}}),()=>true);
  const parent=f.manager.create(request(f.cwd,{role:'orchestrator',context:{enabled:false}}));
  const child=new AgentControlService(f.manager).spawn({parentSessionId:parent.id,provider:'claude',cwd:f.cwd});
  assert.equal(child.contextSummary,undefined); assert.equal(persistedTerminalSession(child).contextDisabled,true);
});

test('learned project context uses configured threshold in native transport and fresh revocation retains history floor', async t => {
  const f = fixture(t); let state = await f.store.saveProject({ label: 'Learning', root: f.cwd }, 0), projectId = state.projects[0].id;
  state = await f.store.saveLearning(projectId, { enabled: true, autoApply: true, threshold: .7, advisoryThreshold: .6 }, state.revision);
  for (const eventId of ['first', 'second']) state = await f.store.captureFeedback({ projectId, eventId, kind: 'accepted-change', category: 'design', key: 'learned', value: 'LEARNED_LITERAL' }, state.revision);
  f.settings.providerAccounts = [assessed({ id: 'claude-learning', provider: 'claude', label: 'Learning account' })];
  const first = f.manager.create(request(f.cwd)); assert.equal(f.calls[0].args.filter(a => String(a).includes('LEARNED_LITERAL')).length, 1); assert.equal(first.disclosureClass, 'D2');
  const proof = f.manager.contextFeedbackEvidence(first.id); assert.equal(proof.sourceCwd, f.cwd); proof.assertCurrent();
  state = await f.store.feedbackAction({ kind: 'reject', id: state.feedback.candidates[0].id }, state.revision);
  f.manager.create(request(f.cwd)); assert.doesNotMatch(f.calls[1].args.join('\n'), /LEARNED_LITERAL/);
  assert.equal(f.manager.list().find(s => s.id === first.id).disclosureClass, 'D2');
  f.manager.dispose(first.id); assert.throws(() => proof.assertCurrent(), /current/); assert.throws(() => f.manager.contextFeedbackEvidence(first.id), /current/);
});
