import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeService } from '../src/main/services/WorktreeService.ts';
import { SessionLaunchCoordinator } from '../src/main/services/SessionLaunchCoordinator.ts';
import { TerminalManager } from './helpers/delegation-test-manager.mjs';
import { TerminalSessionStore, persistedTerminalSession } from '../src/main/services/TerminalSessionStore.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { HostPlacementService } from '../src/main/services/HostPlacement.ts';
import { ScopedOrchestrationHandler } from '../src/main/services/agent-browser/OrchestrationTools.ts';
import { AgentControlService } from '../src/main/services/AgentControlService.ts';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-workspace-runtime-')));
  const source = join(root, 'source'); await mkdir(source);
  git(source, 'init', '-q'); git(source, 'config', 'user.email', 'test@localhost'); git(source, 'config', 'user.name', 'Test');
  await writeFile(join(source, 'code.txt'), 'committed\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
  const worktrees = new WorktreeService({ rootDirectory: join(root, 'managed') });
  const settings = { providerAccounts: [], remoteHosts: [], pathPolicies: [], requiresSandboxProfiles: [], defaultDataClass: 'D0', maxAccountsPerProviderPerHost: 1, agentBudgets: { maxLocalAgents: 1, maxRemoteAgentsPerHost: 1, maxChildren: 4, maxDepth: 2 } };
  const calls = [], exits = [], bridges = [];
  let accountCalls = 0, probes = 0;
  const accounts = { prepare: async () => { accountCalls++; await options.accountGate?.promise; return { remoteExecutable: '/fake/codex', args: [], environment: {}, unsetEnvironment: [], bindingDigest: '', skipBridges: false, assertCurrent() {}, cleanup: async () => { await options.cleanupGate?.promise; } }; } };
  const manager = new TerminalManager(() => {}, { get: provider => ({ state: 'available', provider, executable: `/fake/${provider}`, launcher: 'native', environment: {}, checked: [] }) },
    { assertOrchestrationAvailable() {}, prepareLaunch: input => { bridges.push(input.cwd); return input.includeOrchestration ? { agentId: 'fixture', connectionId: 'fixture', args: [], environment: {}, cleanup() {} } : null; } }, undefined, false,
    (command, args, input) => { calls.push({ command, args, ...input }); let exit; return { onData() {}, onExit: callback => { exit = callback; exits.push(callback); }, write() {}, resize() {}, kill: () => { if (options.confirmKill !== false) exit?.({ exitCode: 0 }); } }; });
  const capacity = excludeId => {
    const sessions = manager.listMetadata().filter(session => session.id !== excludeId && session.exitCode === null);
    return { activeSessions: id => sessions.filter(session => session.hostId === id).length, hasAgentCapacity: id => sessions.filter(session => session.hostId === id).length < settings.agentBudgets.maxRemoteAgentsPerHost };
  };
  const placement = new HostPlacementService({ capacity,
    metrics: async host => { probes++; await options.probeGate?.promise; return { hostId: host.id, reachable: true, cores: 4, load1: options.overloaded ? 10 : 0.2, memoryAvailableMb: 8192 }; },
    discovery: async host => ({ hostId: host.id, reachable: true, providers: [{ provider: 'codex', installed: true }] }),
    access: async () => ({ reachable: true, providers: { codex: true } }) });
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings));
  manager.configureRemoteHosts(id => settings.remoteHosts.find(host => host.id === id));
  manager.configureProviderLaunch(new SessionLaunchCoordinator(accounts, worktrees, () => settings, placement));
  t.after(async () => { options.accountGate?.release(); options.cleanupGate?.release(); options.probeGate?.release(); await manager.shutdown(); await worktrees.dispose(); await rm(root, { recursive: true, force: true }); });
  const create = (patch = {}) => manager.create({ provider: 'codex', cwd: source, profile: 'normal', position: { x: 0, y: 0 }, ...patch });
  const remote = () => { settings.remoteHosts.push({ id: 'host', label: 'Host', sshHost: 'host.example', maxSessions: 1, maxLoadPerCore: 1, workspaces: [{ localPath: source, remotePath: '/srv/project' }] }); };
  return { root, source, worktrees, settings, manager, create, calls, exits, bridges, remote, probes: () => probes, accountCalls: () => accountCalls };
}

test('worktree launch uses execution cwd for PTY and bridges, preserves source and restarts in the same checkout', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'code.txt'), 'source dirty\n');
  const first = f.create({ isolation: { mode: 'worktree' } });
  assert.equal(first.execution.state, 'preparing');
  assert.equal(f.calls.length, 0);
  await f.manager.waitForLaunch(first.id);
  const session = f.manager.list()[0];
  assert.equal(session.exitCode, null, session.failureDetails);
  assert.equal(session.cwd, f.source);
  assert.notEqual(session.execution.executionCwd, f.source);
  assert.equal(session.execution.filesystemRestricted, false);
  assert.equal(f.calls[0].cwd, session.execution.executionCwd);
  assert.deepEqual(f.bridges, [session.execution.executionCwd]);
  assert.equal(await readFile(join(session.execution.executionCwd, 'code.txt'), 'utf8'), 'committed\n');
  assert.equal(await readFile(join(f.source, 'code.txt'), 'utf8'), 'source dirty\n');
  await writeFile(join(session.execution.executionCwd, 'code.txt'), 'agent output\n');
  f.exits[0]({ exitCode: 0 });
  await f.worktrees.dispose();
  f.manager.restart(first.id); await f.manager.waitForLaunch(first.id);
  assert.equal(f.calls[1].cwd, f.calls[0].cwd);
  assert.equal(await readFile(join(f.calls[1].cwd, 'code.txt'), 'utf8'), 'agent output\n');
  f.manager.dispose(first.id); await f.worktrees.dispose();
  const recovery = new WorktreeService({ rootDirectory: join(f.root, 'managed') });
  const retained = await recovery.list();
  assert.equal(retained[0].state, 'retained');
  assert.match((await recovery.review(retained[0].id)).patch, /agent output/);
  await assert.rejects(recovery.cleanup(retained[0].id), /dirty/);
});

test('direct launches do not create managed storage, and unsupported or forged requests fail before preparation', async t => {
  const f = await fixture(t);
  for (const isolation of [{ mode: 'container' }, { mode: 'worktree', executionCwd: '/tmp' }, { mode: 'worktree', ref: '--help' }]) assert.throws(() => f.create({ isolation }));
  assert.throws(() => f.create({ execution: { workspaceId: 'forged' } }), /main process/);
  const session = f.create(); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls[0].cwd, f.source); assert.equal(f.probes(), 0);
  await assert.rejects(access(join(f.root, 'managed')), { code: 'ENOENT' });
});

test('a workspace reservation counts toward budgets and cancellation during provider preparation never spawns', async t => {
  const accountGate = gate(); const f = await fixture(t, { accountGate });
  const session = f.create({ isolation: { mode: 'worktree' } });
  while (!f.accountCalls()) await new Promise(resolve => setTimeout(resolve, 5));
  assert.throws(() => f.create(), /limit/);
  const work = (await f.worktrees.list())[0];
  await assert.rejects(f.worktrees.cleanup(work.id), /reserved|busy/);
  const pending = f.manager.waitForLaunch(session.id); f.manager.dispose(session.id); accountGate.release(); await pending;
  assert.equal(f.calls.length, 0);
  assert.equal((await f.worktrees.list())[0].state, 'retained');
  await f.worktrees.cleanup(work.id);
});

test('unconfirmed process termination preserves output and disables recovered cleanup or reuse', async t => {
  const f = await fixture(t, { confirmKill: false });
  const session = f.create({ isolation: { mode: 'worktree' } }); await f.manager.waitForLaunch(session.id);
  f.manager.dispose(session.id); await f.worktrees.dispose();
  const recovered = new WorktreeService({ rootDirectory: join(f.root, 'managed') });
  const work = (await recovered.list())[0];
  assert.equal(work.state, 'uncertain');
  await assert.rejects(recovered.cleanup(work.id), /unconfirmed/);
  await assert.rejects(recovered.reuse(work.id, f.source), /unconfirmed/);
});

test('late cleanup of a previous generation cannot release a restarted worktree reservation', async t => {
  const cleanupGate = gate(); const f = await fixture(t, { cleanupGate });
  const first = f.create({ isolation: { mode: 'worktree' } }); await f.manager.waitForLaunch(first.id);
  const id = f.manager.list()[0].execution.workspaceId;
  f.exits[0]({ exitCode: 0 });
  f.manager.restart(first.id); await f.manager.waitForLaunch(first.id);
  cleanupGate.release(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.worktrees.list())[0].state, 'running');
  await assert.rejects(f.worktrees.cleanup(id), /reserved|busy/);
});

test('explicit remote UI preflight excludes its own maxSessions=1 reservation and records mapped cwd', async t => {
  const f = await fixture(t); f.remote();
  const session = f.create({ hostId: 'host' }); await f.manager.waitForLaunch(session.id);
  const actual = f.manager.list()[0];
  assert.equal(actual.exitCode, null, actual.failureDetails);
  assert.equal(f.calls.length, 1); assert.equal(f.probes(), 1);
  assert.equal(actual.execution.executionCwd, '/srv/project');
  assert.equal(f.calls[0].cwd, f.source);
});

test('overloaded explicit remote launch and restart fail, with no fallback or account preparation', async t => {
  const f = await fixture(t, { overloaded: true }); f.remote();
  const session = f.create({ hostId: 'host' }); await f.manager.waitForLaunch(session.id);
  assert.match(f.manager.list()[0].failureDetails, /resource constraints/);
  f.manager.restart(session.id); await f.manager.waitForLaunch(session.id);
  assert.match(f.manager.list()[0].failureDetails, /resource constraints/);
  assert.equal(f.calls.length, 0); assert.equal(f.accountCalls(), 0);
});

test('policy changes during remote wait are rechecked, and unsupported isolation is rejected before probes', async t => {
  const probeGate = gate(); const f = await fixture(t, { probeGate }); f.remote();
  assert.throws(() => f.create({ hostId: 'host', isolation: { mode: 'worktree' } }), /local/i);
  assert.equal(f.probes(), 0);
  const session = f.create({ hostId: 'host' });
  while (!f.probes()) await new Promise(resolve => setTimeout(resolve, 5));
  f.settings.remoteHosts[0].maxLoadPerCore = 0.01;
  probeGate.release(); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 0); assert.equal(f.manager.list()[0].status, 'failed');
});

test('worktree ownership persists through terminal restore without trusting an execution path', async t => {
  const f = await fixture(t); const session = f.create({ isolation: { mode: 'worktree' } }); await f.manager.waitForLaunch(session.id);
  const descriptor = persistedTerminalSession(f.manager.list()[0]);
  assert.ok(descriptor.workspaceId); assert.equal(descriptor.execution, undefined);
  f.exits[0]({ exitCode: 0 }); f.manager.dispose(session.id); await f.worktrees.dispose();
  const store = new TerminalSessionStore(join(f.root, 'state')); await store.replace([descriptor]);
  f.manager.configureSessionPersistence(store, true); await f.manager.restorePersistedSessions(); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].cwd, f.calls[0].cwd);
});

test('required isolation remains settings-owned and MCP forwards the bounded worktree choice', async t => {
  const f = await fixture(t); f.settings.requiresSandboxProfiles = ['yolo'];
  assert.throws(() => f.create({ profile: 'yolo' }), /requires/);
  f.settings.agentBudgets.maxLocalAgents = 2;
  const parent = f.create({ role: 'orchestrator' }); await f.manager.waitForLaunch(parent.id);
  const handler = new ScopedOrchestrationHandler(new AgentControlService(f.manager));
  const result = await handler.execute(parent.id, { tool: 'spawn_agent', arguments: { provider: 'codex', cwd: f.source, isolation: 'worktree', worktreeRef: 'HEAD', profile: 'yolo' } });
  await f.manager.waitForLaunch(result.sessionId);
  const child = f.manager.list().find(item => item.id === result.sessionId);
  assert.deepEqual(child.isolation, { mode: 'worktree', ref: 'HEAD' }); assert.equal(child.execution.mode, 'worktree');
});

test('remote shell launches share bounded resource checks without provider endpoint probes', async t => {
  const f = await fixture(t, { overloaded: true }); f.remote();
  const session = f.create({ provider: 'terminal', hostId: 'host' }); await f.manager.waitForLaunch(session.id);
  assert.match(f.manager.list()[0].failureDetails, /resource constraints/);
  assert.equal(f.calls.length, 0); assert.equal(f.accountCalls(), 0); assert.equal(f.probes(), 1);
});
