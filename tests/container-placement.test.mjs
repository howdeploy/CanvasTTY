import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerPlacementService } from '../src/main/services/ContainerPlacement.ts';
import { assertContainerPlacementRequest } from '../src/shared/containerPlacement.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';

const cwd = '/workspace/project';
const request = (extra = {}) => ({ provider: 'opencode', cwd, profile: 'normal', position: { x: 0, y: 0 }, dataClass: 'D0', containerPlacement: {}, ...extra });
const profile = (id, hostId = 'local', extra = {}) => ({ id, label: id, hostId, runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/docker.sock' }, image: 'fixture:latest', python: '/usr/bin/python3', ...(hostId === 'local' ? {} : { hostPython: '/usr/bin/python3' }), commands: { terminal: '/bin/sh', opencode: '/usr/bin/opencode', omp: '/usr/bin/omp', minimax: '/usr/bin/minimax' }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: '1000:1000', ...extra });
const host = (id, extra = {}) => ({ id, label: id, sshHost: `${id}.example.test`, workspaces: [{ localPath: cwd, remotePath: '/srv/project' }], ...extra });
const account = (id, hostId = 'local', extra = {}) => ({ id, provider: 'opencode', label: id, hostId, binding: { kind: 'api-profile', profileId: `api-${id}` }, ...extra });
const api = (id, hostId = 'local', extra = {}) => ({ id: `api-${id}`, label: id, hostId, protocol: 'openai-compatible', baseUrl: 'https://provider.example.test/v1', defaultModel: 'fixture', ...(hostId === 'local' ? { secretRef: 'OPENAI_API_KEY' } : { remoteCredential: { kind: 'environment', name: `FIXTURE_${id.toUpperCase().replaceAll('-', '_')}` } }), ...extra });
function fixture({ profiles = [profile('local')], hosts = [], accounts = [account('local')], apis = [api('local')], metrics, inventory, policyOptions } = {}) {
  const settings = { containerProfiles: profiles, remoteHosts: hosts, providerAccounts: accounts, apiProfiles: apis, defaultDataClass: 'D0', pathPolicies: [], agentBudgets: { maxLocalAgents: 4, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 }, maxAccountsPerProviderPerHost: 1 };
  const sessions = [], calls = { metrics: [], inventory: [] };
  const policy = new SessionLaunchPolicy(() => settings, policyOptions);
  const service = new ContainerPlacementService({ settings: () => settings, sessions: () => sessions, policy,
    metrics: async selected => { const id = selected?.id ?? 'local'; calls.metrics.push(id); return metrics ? metrics(id) : { hostId: id, collectedAt: 1000, reachable: true, load1: 1, cores: 4, memoryAvailableMb: 4096, memoryTotalMb: 8192, gpuVramTotalMb: null, gpuVramUsedMb: null }; },
    inventory: async ids => { calls.inventory.push(ids); if (inventory) return inventory(ids); return ids.map(id => { const p = settings.containerProfiles.find(p => p.id === id); return { hostId: p.hostId, runtime: p.runtime, checkedAt: 1000, available: true, profiles: [{ profileId: id, imageAvailable: true, imageId: 'sha256:' + 'a'.repeat(64) }], containers: [], truncated: false }; }); }
  });
  return { service, settings, sessions, calls };
}
const active = (id, hostId, extra = {}) => ({ id, provider: 'terminal', hostId, exitCode: null, ...extra });
function assessed(f, id, cap = 'D2') {
  const a = f.settings.providerAccounts.find(a => a.id === id);
  a.assessment = { profile: { training: 'none', retention: cap === 'D3' ? 'zero' : 'bounded', thirdPartyProcessing: 'no', contractualMode: 'api' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: 'Fixture assessment only.', binding: accountRouteBinding(a, f.settings.apiProfiles), models: '*' } };
}

test('the least loaded complete tuple wins; no host CLI discovery or credential read exists', async () => {
  const f = fixture({ profiles: [profile('busy', 'busy'), profile('idle', 'idle')], hosts: [host('busy'), host('idle')], accounts: [account('busy', 'busy'), account('idle', 'idle')], apis: [api('busy', 'busy'), api('idle', 'idle')] });
  f.sessions.push(active('busy-session', 'busy'));
  const resolved = await f.service.resolve(request());
  assert.equal(resolved.decision.kind, 'selected');
  assert.equal(resolved.request.isolation.profileId, 'idle');
  assert.equal(resolved.request.hostId, 'idle');
  assert.equal(resolved.request.accountId, 'idle');
  assert.equal(resolved.request.model, 'fixture');
  assert.equal(resolved.request.containerPlacement, undefined);
  assert.match(resolved.bindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(resolved.assertCurrent(), undefined);
  assert.equal(f.calls.inventory.length, 1);
  assert.deepEqual(new Set(f.calls.metrics), new Set(['busy', 'idle']));
});

test('deterministic local/remote ranking uses host, profile and account ties', async () => {
  const f = fixture({ profiles: [profile('z'), profile('a')], accounts: [account('z'), account('a')], apis: [api('z', 'local', { secretRef: 'OPENAI_API_KEY' }), api('a', 'local', { secretRef: 'ANTHROPIC_API_KEY' })] });
  f.settings.maxAccountsPerProviderPerHost = 2;
  const result = await f.service.resolve(request());
  assert.equal(result.request.isolation.profileId, 'a'); assert.equal(result.request.accountId, 'a'); assert.equal(result.request.hostId, undefined);
  assert.deepEqual(f.calls.metrics, ['local']);
});

test('model, account limit, credentials and host mapping fail before every probe', async () => {
  for (const change of [
    f => { f.settings.providerAccounts[0].models = ['other']; },
    f => { f.settings.providerAccounts.push(account('second', 'remote')); f.settings.apiProfiles.push(api('second', 'remote')); },
    f => { delete f.settings.apiProfiles[0].remoteCredential; },
    f => { f.settings.apiProfiles[0].hostId = 'other'; },
    f => { f.settings.remoteHosts[0].workspaces = []; },
    f => { f.settings.containerProfiles[0].network = 'none'; },
    f => { f.settings.remoteHosts[0].providerAccess = { mode: 'blocklist', providers: ['opencode'] }; },
  ]) {
    const f = fixture({ profiles: [profile('remote', 'remote')], hosts: [host('remote')], accounts: [account('remote', 'remote')], apis: [api('remote', 'remote')] }); change(f);
    assert.equal((await f.service.preview(request())).kind, 'none'); assert.deepEqual(f.calls, { metrics: [], inventory: [] });
  }
});

test('agent never falls back to ambient/native credentials; shell needs no account', async () => {
  const f = fixture({ accounts: [], apis: [] });
  assert.equal((await f.service.preview(request())).kind, 'none'); assert.equal(f.calls.inventory.length, 0);
  const shell = await f.service.resolve(request({ provider: 'terminal' })); assert.equal(shell.request.accountId, undefined);
  await assert.rejects(f.service.resolve(request({ provider: 'terminal', accountId: 'fixture' })), /account|request/i);
});

test('ACP, explicit host, isolation/capsule and malformed restrictions reject before probes', async () => {
  const f = fixture();
  for (const bad of [request({ transport: 'acp' }), request({ hostId: 'local' }), request({ isolation: { mode: 'container', profileId: 'local', capsuleId: 'capsule' } }), request({ containerPlacement: { profileIds: [] } }), request({ containerPlacement: { profileIds: ['local', 'local'] } }), request({ containerPlacement: { unknown: true } }), request({ containerPlacement: { profileIds: ['../unsafe'] } })]) {
    assert.throws(() => assertContainerPlacementRequest(bad)); await assert.rejects(f.service.preview(bad));
  }
  assert.deepEqual(f.calls, { metrics: [], inventory: [] });
});

test('explicit account restriction cannot be attached to a different host', async () => {
  const f = fixture({ profiles: [profile('remote', 'remote'), profile('local')], hosts: [host('remote')], accounts: [account('remote', 'remote'), account('local')], apis: [api('remote', 'remote'), api('local')] });
  const result = await f.service.resolve(request({ accountId: 'remote' }));
  assert.equal(result.request.hostId, 'remote'); assert.equal(result.request.accountId, 'remote');
  assert.deepEqual(f.calls.inventory, [['remote']]);
});

test('free-form initial task is D2 before any remote probe; assessed routes allow it', async () => {
  const f = fixture();
  assert.equal((await f.service.preview(request({ initialPrompt: 'fixture task' }))).kind, 'none'); assert.equal(f.calls.inventory.length, 0);
  assessed(f, 'local'); const result = await f.service.resolve(request({ initialPrompt: 'fixture task' })); assert.equal(result.request.dataClass, 'D2'); assert.equal(result.decision.dataClass, 'D2'); assert.equal(result.decision.model, 'fixture');
});

test('default class and sandbox requirement use the fixed candidate policy', async () => {
  const f = fixture(); f.settings.requiresSandboxProfiles = ['normal'];
  assert.equal((await f.service.preview(request())).kind, 'selected');
  f.settings.defaultDataClass = 'D2';
  assert.equal((await f.service.preview(request({ dataClass: undefined }))).kind, 'none');
});

test('live capacity is reread after async facts and on every assertCurrent', async () => {
  const f = fixture();
  const selected = await f.service.resolve(request());
  for (let i = 0; i < 4; i++) f.sessions.push(active(`a${i}`, undefined, { provider: 'opencode' }));
  assert.throws(() => selected.assertCurrent(), /changed|capacity|eligible/i);
  selected.assertCurrent('a0');
  const callsBefore = f.calls.inventory.length;
  assert.equal((await f.service.preview(request())).kind, 'none'); assert.equal(f.calls.inventory.length, callsBefore);
  const race = fixture({ inventory: async ids => { race.sessions.push(...Array.from({ length: 4 }, (_, i) => active(`a${i}`, undefined, { provider: 'opencode' }))); return ids.map(profileId => ({ hostId: 'local', runtime: 'docker', checkedAt: 1000, available: true, profiles: [{ profileId, imageAvailable: true, imageId: 'sha256:' + 'a'.repeat(64) }], containers: [], truncated: false })); } });
  assert.equal((await race.service.preview(request())).kind, 'none');
});

test('resolved tuple rechecks account, profile, host, policy and exact output; no fallback', async () => {
  for (const change of [
    f => { f.settings.containerProfiles[0].image = 'fixture:other'; },
    f => { f.settings.apiProfiles[0].defaultModel = 'other'; },
    f => { f.settings.providerAccounts[0].hostId = 'local'; },
    f => { f.settings.remoteHosts[0].sshHost = 'other.example.test'; },
    f => { f.settings.pathPolicies.push({ pattern: '**', dataClass: 'D3' }); }
  ]) {
    const f = fixture({ profiles: [profile('remote', 'remote')], hosts: [host('remote')], accounts: [account('remote', 'remote')], apis: [api('remote', 'remote')] });
    const result = await f.service.resolve(request()); const before = structuredClone(f.calls); change(f);
    assert.throws(() => result.assertCurrent(), /changed|eligible/i); assert.deepEqual(f.calls, before);
  }
});

test('engine/image and metric failures never rank as idle or leak raw diagnostic fields', async () => {
  for (const inventory of [async () => { throw Error('fixture diagnostic /private/credential'); }, async () => [], async ids => [{ hostId: 'local', runtime: 'docker', available: true, profiles: [{ profileId: ids[0], imageAvailable: false }], reason: 'fixture diagnostic /private/credential' }]]) {
    const f = fixture({ inventory }); const preview = await f.service.preview(request()); assert.equal(preview.kind, 'none'); assert.doesNotMatch(JSON.stringify(preview), /credential|diagnostic|private/);
  }
  for (const metrics of [() => null, () => ({ hostId: 'other', reachable: true }), () => ({ hostId: 'local', reachable: true, load1: NaN, cores: 1, memoryAvailableMb: 100 })]) {
    const f = fixture({ metrics }); assert.equal((await f.service.preview(request())).kind, 'none');
  }
});

test('a concurrent edit during inventory invalidates the candidate before selection', async () => {
  const f = fixture({ inventory: async ids => { f.settings.containerProfiles[0].image = 'fixture:changed'; return [{ hostId: 'local', runtime: 'docker', checkedAt: 1000, available: true, profiles: [{ profileId: ids[0], imageAvailable: true, imageId: 'sha256:' + 'a'.repeat(64) }], containers: [], truncated: false }]; } });
  const result = await f.service.preview(request()); assert.equal(result.kind, 'none'); assert.equal(result.exclusions[0].code, 'configuration-changed');
});

test('an API route without an explicit or default model is rejected before probes', async () => {
  const f = fixture(); delete f.settings.apiProfiles[0].defaultModel;
  assert.equal((await f.service.preview(request())).kind, 'none'); assert.deepEqual(f.calls, { metrics: [], inventory: [] });
  assert.equal((await f.service.preview(request({ model: 'fixture' }))).kind, 'selected');
});

test('default remote all-session limit is four, including terminal containers', async () => {
  const f = fixture({ profiles: [profile('remote', 'remote')], hosts: [host('remote')], accounts: [], apis: [] });
  f.sessions.push(...Array.from({ length: 4 }, (_, i) => active(`s${i}`, 'remote')));
  assert.equal((await f.service.preview(request({ provider: 'terminal' }))).kind, 'none'); assert.equal(f.calls.inventory.length, 0);
});

test('unsupported protocol and native home accounts cannot get engine probes', async () => {
  const f = fixture(); f.settings.apiProfiles[0].protocol = 'google';
  assert.equal((await f.service.preview(request({ provider: 'omp' }))).kind, 'none');
  f.settings.providerAccounts[0].binding = { kind: 'cli-home', directory: '/fixture/home' };
  assert.equal((await f.service.preview(request())).kind, 'none'); assert.deepEqual(f.calls, { metrics: [], inventory: [] });
});

test('caller cannot mutate an already resolved request and pass its recheck', async () => {
  const f = fixture(); const selected = await f.service.resolve(request());
  selected.request.dataClass = 'D3'; assert.throws(() => selected.assertCurrent(), /changed/);
});

test('route exclusions are bounded even with many broken account candidates', async () => {
  const f = fixture({ accounts: Array.from({ length: 100 }, (_, i) => account(`a${i}`, 'local', { bindingRequired: true })), apis: [] });
  const result = await f.service.preview(request()); assert.equal(result.kind, 'none'); assert.equal(result.exclusions.length, 64); assert.equal(result.exclusionsTruncated, true);
  assert.equal(f.calls.inventory.length, 0);
});

test('delegation eligibility and live account affinity reject before probes', async () => {
  const f = fixture();
  assert.equal((await f.service.preview(request({ role: 'subagent', parentSessionId: 'absent' }))).kind, 'none');
  f.sessions.push(active('parent', undefined, { provider: 'opencode', role: 'interactive', accountId: 'local' }));
  assert.equal((await f.service.preview(request({ role: 'subagent', parentSessionId: 'parent' }))).kind, 'none');
  f.sessions[0].allowSubagents = true;
  const selected = await f.service.resolve(request({ role: 'subagent', parentSessionId: 'parent' }));
  f.sessions[0].allowSubagents = false; assert.throws(() => selected.assertCurrent());
  f.sessions[0].hostId = 'other';
  const before = f.calls.inventory.length; assert.equal((await f.service.preview(request())).kind, 'none'); assert.equal(f.calls.inventory.length, before);
});

test('canonical project classification raises the class before engine or metrics probes', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ctplace-')));
  try {
    const f = fixture({ policyOptions: { repositoryRoot: () => directory } });
    f.settings.pathPolicies = [{ pattern: '**', dataClass: 'D2' }];
    assert.equal((await f.service.preview(request({ cwd: directory }))).kind, 'none'); assert.deepEqual(f.calls, { metrics: [], inventory: [] });
    assessed(f, 'local'); const selected = await f.service.resolve(request({ cwd: directory })); assert.equal(selected.request.dataClass, 'D2');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host class and resource constraints exclude a low load host', async () => {
  const f = fixture({ profiles: [profile('remote', 'remote')], hosts: [host('remote', { minFreeMemoryMb: 8192 })], accounts: [account('remote', 'remote')], apis: [api('remote', 'remote')] });
  assert.equal((await f.service.preview(request())).exclusions[0].code, 'resources');
  f.settings.remoteHosts[0].minFreeMemoryMb = 128; f.settings.remoteHosts[0].maxLoadPerCore = 0.1;
  assert.equal((await f.service.preview(request())).exclusions[0].code, 'resources');
  delete f.settings.remoteHosts[0].maxLoadPerCore; f.settings.remoteHosts[0].maxDataClass = 'D0'; assessed(f, 'remote');
  const before = f.calls.inventory.length; assert.equal((await f.service.preview(request({ dataClass: 'D2' }))).kind, 'none'); assert.equal(f.calls.inventory.length, before);
});

test('load ranking precedes profile id and parent caller mutations cannot change candidates', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ profiles: [profile('a', 'hot'), profile('z', 'cool')], hosts: [host('hot'), host('cool')], accounts: [account('hot', 'hot'), account('cool', 'cool')], apis: [api('hot', 'hot'), api('cool', 'cool')],
    metrics: async id => { await gate; return { hostId: id, reachable: true, load1: id === 'hot' ? 10 : 1, cores: 4, memoryAvailableMb: 4096 }; } });
  const input = request(); const pending = f.service.resolve(input); input.containerPlacement.profileIds = ['a']; input.position.x = 99; release();
  const result = await pending; assert.equal(result.request.isolation.profileId, 'z'); assert.equal(result.request.position.x, 0);
  assert.doesNotMatch(JSON.stringify(result.decision), /FIXTURE_|example.test|remoteCredential|secretRef/);
});

test('selected complete tuple cannot borrow an eligible account from another host', async () => {
  const f = fixture({ profiles: [profile('a', 'idle'), profile('z', 'busy')], hosts: [host('idle'), host('busy')], accounts: [account('idle', 'idle', { models: ['other'] }), account('busy', 'busy')], apis: [api('idle', 'idle'), api('busy', 'busy')] });
  f.sessions.push(active('s', 'busy'));
  const result = await f.service.resolve(request()); assert.equal(result.request.hostId, 'busy'); assert.equal(result.request.accountId, 'busy'); assert.deepEqual(f.calls.metrics, ['busy']);
});

test('malformed or duplicate image facts are never availability proof', async () => {
  for (const facts of [
    [{ profileId: 'local', imageAvailable: true, imageId: 'arbitrary' }],
    [{ profileId: 'local', imageAvailable: true, imageId: 'sha256:' + 'a'.repeat(64) }, { profileId: 'local', imageAvailable: true, imageId: 'sha256:' + 'a'.repeat(64) }]
  ]) {
    const f = fixture({ inventory: async () => [{ hostId: 'local', runtime: 'docker', available: true, profiles: facts }] });
    assert.equal((await f.service.preview(request())).kind, 'none');
  }
});

test('fresh settings failures return closed diagnostics without private source errors', async () => {
  const service = new ContainerPlacementService({ settings: () => { throw Error('fixture diagnostic /private/credential'); }, sessions: () => [], policy: { check: () => { throw Error('unused'); } }, metrics: async () => null, inventory: async () => [] });
  await assert.rejects(service.preview(request()), error => /could not verify current configuration/.test(error.message) && !/credential|diagnostic|private/.test(error.message));
});
