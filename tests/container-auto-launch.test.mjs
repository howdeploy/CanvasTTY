import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from './helpers/delegation-test-manager.mjs';
import { ContainerPlacementService } from '../src/main/services/ContainerPlacement.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { SessionLaunchCoordinator } from '../src/main/services/SessionLaunchCoordinator.ts';
import { AgentControlService } from '../src/main/services/AgentControlService.ts';
import { ScopedOrchestrationHandler } from '../src/main/services/agent-browser/OrchestrationTools.ts';
import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';
import { validateOrchestrationArguments } from '../src/agent-browser/orchestration-catalog.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const prepared = () => ({ args: [], environment: {}, unsetEnvironment: [], skipBridges: true, bindingDigest: 'fixture', assertCurrent() {}, async cleanup() {} });
async function fixture(t, { remote = false, holdInventory, holdAccount, beforeSpawn } = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ct-auto-')));
  const hostId = remote ? 'server' : 'local';
  const profile = { id: 'profile', label: 'Fixture', hostId, runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/docker.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', ...(remote ? { hostPython: '/usr/bin/python3' } : {}), commands: { terminal: '/bin/sh', opencode: '/usr/bin/opencode' }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: '1000:1000' };
  const account = { id: 'account', provider: 'opencode', label: 'Fixture', hostId, binding: { kind: 'api-profile', profileId: 'api' } };
  const api = { id: 'api', label: 'Fixture', hostId, protocol: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', defaultModel: 'fixture', ...(remote ? { remoteCredential: { kind: 'environment', name: 'FIXTURE_REMOTE_KEY' } } : { secretRef: 'OPENAI_API_KEY' }) };
  account.assessment = { profile: { training: 'none', retention: 'bounded', thirdPartyProcessing: 'no', contractualMode: 'api' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: 'Fixture only.', binding: accountRouteBinding(account, [api]), models: '*' } };
  const settings = { containerProfiles: [profile], providerAccounts: [account], apiProfiles: [api], remoteHosts: remote ? [{ id: hostId, label: 'Fixture', sshHost: 'fixture.invalid', workspaces: [{ localPath: cwd, remotePath: '/srv/project' }] }] : [], defaultDataClass: 'D0', pathPolicies: [], requiresSandboxProfiles: [], maxAccountsPerProviderPerHost: 1, agentBudgets: { maxLocalAgents: 4, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 } };
  const calls = { inventory: 0, metrics: 0, accounts: 0, workspace: 0, containers: 0, process: [], exits: [], startup: [] };
  const manager = new TerminalManager(() => {}, { get: provider => ({ state: 'available', provider, executable: '/fixture/cli', launcher: 'native', environment: {}, checked: [] }) }, undefined, undefined, false, (...args) => {
    calls.process.push(args); let exit; return { onData() {}, onExit(fn) { exit = fn; calls.exits.push(fn); }, write() {}, resize() {}, kill() { exit?.({ exitCode: 0 }); } };
  });
  const policy = new SessionLaunchPolicy(() => settings); manager.configureLaunchPolicy(policy);
  manager.configureRemoteHosts(id => settings.remoteHosts.find(h => h.id === id) ?? null);
  const placement = new ContainerPlacementService({ settings: () => settings, sessions: () => manager.listMetadata(), policy,
    metrics: async host => { calls.metrics++; return { hostId: host?.id ?? 'local', collectedAt: 1, reachable: true, load1: 0, cores: 4, memoryAvailableMb: 4096, memoryTotalMb: 8192, gpuVramTotalMb: null, gpuVramUsedMb: null }; },
    inventory: async ids => { calls.inventory++; await holdInventory?.promise; return ids.map(profileId => ({ hostId, runtime: 'docker', checkedAt: 1, available: true, profiles: [{ profileId, imageAvailable: true, imageId: 'sha256:' + 'a'.repeat(64) }], containers: [], truncated: false })); }
  });
  const workspace = { id: 'workspace', directory: cwd, sourceDirectory: cwd, commit: 'fixture', executionCwd: '/workspace' };
  const worktrees = { async create() { calls.workspace++; return workspace; }, async reuse() { return workspace; }, async reserve() {}, async setRunning() {}, async retain() {} };
  const containers = { profile: id => { assert.equal(id, profile.id); return settings.containerProfiles[0]; }, async remoteWorkspace() { calls.workspace++; return workspace; }, async releaseRemoteWorkspace() {}, async blocksWorkspace() { return false; },
    async prepare(metadata, _workspace, accountLaunch, assertCurrent) { calls.containers++; calls.startup.push(accountLaunch.startup); assertCurrent(); return { ...prepared(), process: { command: '/fixture/engine', args: ['attach'], cwd, environment: {} }, beforeSpawn }; }
  };
  const accounts = { async prepare(metadata) { if (metadata.provider === 'opencode') { calls.accounts++; await holdAccount?.promise; } return { ...prepared(), skipBridges: metadata.provider === 'opencode' }; } };
  manager.configureProviderLaunch(new SessionLaunchCoordinator(accounts, worktrees, () => settings, { async checkShell() {}, place() { throw Error('Unexpected native host placement'); } }, containers));
  t.after(async () => { holdInventory?.resolve(); holdAccount?.resolve(); await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, settings, calls, manager, placement, request: extra => ({ provider: 'opencode', cwd, profile: 'normal', position: { x: 0, y: 0 }, containerPlacement: {}, ...extra }) };
}

test('sync create rejects unresolved placement without reserving or spawning; fixed create remains sync', async t => {
  const f = await fixture(t);
  assert.throws(() => f.manager.create(f.request()), /placement|asynchronous/i);
  assert.equal(f.manager.list().length, 0); assert.equal(f.calls.process.length, 0);
  const session = f.manager.create({ provider: 'terminal', cwd: f.cwd, profile: 'normal', position: { x: 0, y: 0 } });
  assert.equal(typeof session.id, 'string'); assert.equal(session instanceof Promise, false); await f.manager.waitForLaunch(session.id);
});

test('invalid transient requests and missing coordinator reject before every probe and reservation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.createWithPlacement(f.request()), /unavailable/i);
  f.manager.configureContainerPlacement(f.placement);
  for (const extra of [{ hostId: 'local' }, { isolation: { mode: 'container', profileId: 'profile' } }, { transport: 'acp' }, { containerPlacement: { profileIds: [] } }, { containerPlacement: { unknown: true } }, { execution: {} }, { cwd: '/fixture/missing' }, { initialPrompt: '\0' }]) {
    await assert.rejects(f.manager.previewContainerPlacement(f.request(extra)));
    await assert.rejects(f.manager.createWithPlacement(f.request(extra)));
  }
  assert.equal(f.calls.inventory, 0); assert.equal(f.calls.metrics, 0); assert.equal(f.manager.list().length, 0);
});

test('preview and launch share the real planner; resolved class/account/profile persist with no transient intent', async t => {
  const f = await fixture(t); f.manager.configureContainerPlacement(f.placement);
  const request = f.request({ initialPrompt: 'Inspect fixture' });
  const preview = await f.manager.previewContainerPlacement(request);
  assert.equal(preview.kind, 'selected'); assert.equal(preview.accountId, 'account'); assert.equal(preview.dataClass, 'D2');
  assert.equal(f.manager.list().length, 0); assert.equal(f.calls.accounts, 0);
  const created = await f.manager.createWithPlacement(request); await f.manager.waitForLaunch(created.id);
  const live = f.manager.list()[0]; assert.equal(live.exitCode, null, live.failureDetails);
  assert.equal(live.accountId, preview.accountId); assert.equal(live.isolation.profileId, preview.profileId);
  assert.equal(live.dataClass, 'D2'); assert.equal(live.dataClassInherited, true); assert.equal(live.disclosureClass, 'D2'); assert.equal(live.containerPlacement, undefined);
  assert.equal(f.calls.inventory, 2); assert.equal(f.calls.process.length, 1); assert.equal(f.calls.workspace, 1);
});

test('no eligible route reserves no session, account, workspace or process', async t => {
  const f = await fixture(t); f.manager.configureContainerPlacement(f.placement); f.settings.containerProfiles = [];
  assert.equal((await f.manager.previewContainerPlacement(f.request())).kind, 'none');
  await assert.rejects(f.manager.createWithPlacement(f.request()), /eligible route/);
  assert.equal(f.manager.list().length, 0); assert.equal(f.calls.accounts, 0); assert.equal(f.calls.workspace, 0); assert.equal(f.calls.process.length, 0);
});

test('caller edits during probes cannot change provider, account restriction, task or placement', async t => {
  const holdInventory = deferred(), f = await fixture(t, { holdInventory }); f.manager.configureContainerPlacement(f.placement);
  const request = f.request({ containerPlacement: { profileIds: ['profile'] }, initialPrompt: 'Original task' });
  const pending = f.manager.createWithPlacement(request);
  request.provider = 'terminal'; request.accountId = 'other'; request.initialPrompt = 'Changed task'; request.containerPlacement.profileIds[0] = 'other';
  holdInventory.resolve(); const created = await pending; await f.manager.waitForLaunch(created.id);
  assert.equal(created.provider, 'opencode'); assert.equal(created.accountId, 'account'); assert.equal(created.isolation.profileId, 'profile');
  assert.equal(f.calls.startup[0].task, 'Original task');
});

for (const action of ['abort', 'dispose', 'restart']) test(`${action} during MCP probes cannot create a late child`, async t => {
  const holdInventory = deferred(), f = await fixture(t, { holdInventory }); f.manager.configureContainerPlacement(f.placement);
  const parent = f.manager.create({ provider: 'codex', cwd: f.cwd, profile: 'normal', position: { x: 0, y: 0 }, role: 'orchestrator' }); await f.manager.waitForLaunch(parent.id);
  const control = new AgentControlService(f.manager), handler = new ScopedOrchestrationHandler(control), abort = new AbortController();
  const pending = handler.execute(parent.id, { tool: 'spawn_agent', arguments: { provider: 'opencode', cwd: f.cwd, isolation: 'container', containerRoute: 'auto' } }, abort.signal);
  await Promise.resolve();
  assert.equal(f.calls.inventory, 1, 'the request is waiting on actual planner probes');
  if (action === 'abort') abort.abort();
  else if (action === 'dispose') f.manager.dispose(parent.id);
  else { f.calls.exits[0]({ exitCode: 0 }); f.manager.restart(parent.id); await f.manager.waitForLaunch(parent.id); }
  holdInventory.resolve(); await assert.rejects(pending, /./);
  assert.equal(f.manager.list().filter(s => s.role === 'subagent').length, 0); assert.equal(f.calls.workspace, 0); assert.equal(f.calls.accounts, 0);
});

test('new live remote shell sessions consume the default host capacity while account preparation awaits', async t => {
  const holdAccount = deferred(), f = await fixture(t, { remote: true, holdAccount }); f.manager.configureContainerPlacement(f.placement);
  const created = await f.manager.createWithPlacement(f.request());
  while (f.calls.accounts === 0) await new Promise(resolve => setImmediate(resolve));
  // Shells do not consume the agent budget. A host with no explicit maxSessions
  // still has the planner's default four-session limit, checked again after await.
  for (let i = 0; i < 4; i++) {
    const shell = f.manager.create({ provider: 'terminal', cwd: f.cwd, hostId: 'server', profile: 'normal', position: { x: i, y: 0 } });
    await f.manager.waitForLaunch(shell.id);
  }
  assert.equal(f.calls.process.length, 4);
  holdAccount.resolve(); await f.manager.waitForLaunch(created.id);
  const live = f.manager.list().find(s => s.id === created.id); assert.equal(live.exitCode, 1); assert.match(live.failureDetails, /changed|eligible/);
  assert.equal(f.calls.workspace, 0); assert.equal(f.calls.containers, 0); assert.equal(f.calls.inventory, 1);
});

test('cancellation after selection while account preparation awaits blocks every allocation', async t => {
  const holdAccount = deferred(), f = await fixture(t, { holdAccount }); f.manager.configureContainerPlacement(f.placement);
  const abort = new AbortController(), created = await f.manager.createWithPlacement(f.request(), abort.signal);
  while (f.calls.accounts === 0) await new Promise(resolve => setImmediate(resolve));
  abort.abort(); holdAccount.resolve(); await f.manager.waitForLaunch(created.id);
  assert.equal(f.manager.list()[0].exitCode, 1); assert.equal(f.calls.workspace, 0); assert.equal(f.calls.containers, 0); assert.equal(f.calls.process.length, 0);
});

test('an already aborted request and absent parent do not trigger probes', async t => {
  const f = await fixture(t); f.manager.configureContainerPlacement(f.placement); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.manager.createWithPlacement(f.request(), abort.signal));
  await assert.rejects(f.manager.createWithPlacement(f.request({ role: 'subagent', parentSessionId: 'missing' })), /Parent/);
  assert.equal(f.calls.inventory, 0); assert.equal(f.calls.metrics, 0); assert.equal(f.manager.list().length, 0);
});

test('shutdown during top-level probes cannot create a late session', async t => {
  const holdInventory = deferred(), f = await fixture(t, { holdInventory }); f.manager.configureContainerPlacement(f.placement);
  const pending = f.manager.createWithPlacement(f.request()); assert.equal(f.calls.inventory, 1);
  await f.manager.shutdown(); holdInventory.resolve(); await assert.rejects(pending, /shut down/i);
  assert.equal(f.manager.list().length, 0); assert.equal(f.calls.accounts, 0); assert.equal(f.calls.workspace, 0); assert.equal(f.calls.process.length, 0);
});

for (const remote of [false, true]) for (const change of ['profile', 'account', 'policy', 'capacity', ...(remote ? ['host'] : [])]) test(`${remote ? 'remote' : 'local'} ${change} changed during account await blocks workspace allocation without rerouting`, async t => {
  const holdAccount = deferred(), f = await fixture(t, { remote, holdAccount }); f.manager.configureContainerPlacement(f.placement);
  const created = await f.manager.createWithPlacement(f.request());
  while (f.calls.accounts === 0) await new Promise(resolve => setImmediate(resolve));
  if (change === 'profile') f.settings.containerProfiles[0].image = 'fixture:changed';
  if (change === 'account') f.settings.providerAccounts[0].label = 'Changed';
  if (change === 'host') f.settings.remoteHosts[0].sshHost = 'changed.invalid';
  if (change === 'policy') f.settings.pathPolicies.push({ pattern: '**', dataClass: 'D3' });
  if (change === 'capacity') f.settings.agentBudgets[remote ? 'maxRemoteAgentsPerHost' : 'maxLocalAgents'] = 0;
  holdAccount.resolve(); await f.manager.waitForLaunch(created.id);
  const live = f.manager.list().find(s => s.id === created.id); assert.equal(live.exitCode, 1); assert.match(live.failureDetails, /changed|capacity|eligible|limit|budget/i);
  assert.equal(f.calls.workspace, 0); assert.equal(f.calls.containers, 0); assert.equal(f.calls.process.length, 0); assert.equal(f.calls.inventory, 1);
});

test('changes after final preparation block spawn; later restart stays fixed and drops initial auto guard', async t => {
  let first = true, f;
  f = await fixture(t, { beforeSpawn: async () => { if (first) { first = false; f.settings.containerProfiles[0].image = 'fixture:changed'; } } }); f.manager.configureContainerPlacement(f.placement);
  const created = await f.manager.createWithPlacement(f.request()); await f.manager.waitForLaunch(created.id);
  assert.equal(f.manager.list()[0].exitCode, 1); assert.equal(f.calls.process.length, 0);
  f.manager.restart(created.id); await f.manager.waitForLaunch(created.id);
  assert.equal(f.manager.list()[0].exitCode, null, f.manager.list()[0].failureDetails);
  assert.equal(f.calls.inventory, 1); assert.equal(f.calls.process.length, 1); assert.equal(f.manager.list()[0].isolation.profileId, 'profile');
});

test('scoped MCP translates auto intent, uses same route and returns selected IDs; explicit host cannot combine', async t => {
  const f = await fixture(t, { remote: true }); f.manager.configureContainerPlacement(f.placement);
  const parent = f.manager.create({ provider: 'codex', cwd: f.cwd, profile: 'normal', position: { x: 10, y: 10 }, role: 'orchestrator' }); await f.manager.waitForLaunch(parent.id);
  const handler = new ScopedOrchestrationHandler(new AgentControlService(f.manager));
  const args = { provider: 'opencode', cwd: f.cwd, isolation: 'container', containerRoute: 'auto', containerProfileIds: ['profile'] };
  assert.equal(validateOrchestrationArguments('spawn_agent', args).ok, true);
  for (const bad of [{ ...args, host: 'local' }, { ...args, host: 'auto' }, { ...args, containerProfileId: 'profile' }, { ...args, worktreeRef: 'HEAD' }, { ...args, isolation: 'direct' }, { ...args, containerProfileIds: [] }]) await assert.rejects(handler.execute(parent.id, { tool: 'spawn_agent', arguments: bad }));
  assert.equal(f.calls.inventory, 0);
  const result = await handler.execute(parent.id, { tool: 'spawn_agent', arguments: args }); await f.manager.waitForLaunch(result.sessionId);
  assert.equal(result.hostId, 'server'); assert.equal(result.accountId, 'account'); assert.deepEqual(result.isolation, { mode: 'container', profileId: 'profile' });
  const live = f.manager.list().find(s => s.id === result.sessionId); assert.equal(live.exitCode, null, live.failureDetails); assert.equal(live.parentSessionId, parent.id); assert.ok(live.position.x > parent.position.x);
});
