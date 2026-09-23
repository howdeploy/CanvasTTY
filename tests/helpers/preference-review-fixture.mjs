import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskCapsuleService } from '../../src/main/services/TaskCapsuleService.ts';
import { CapsuleLaunchService } from '../../src/main/services/CapsuleLaunchService.ts';
import { ContainerExecutionService } from '../../src/main/services/ContainerExecutionService.ts';
import { ProviderAccountLaunchService } from '../../src/main/services/ProviderAccountLaunchService.ts';
import { SessionLaunchCoordinator } from '../../src/main/services/SessionLaunchCoordinator.ts';
import { SessionLaunchPolicy } from '../../src/main/services/SessionLaunchPolicy.ts';
import { TerminalManager } from './delegation-test-manager.mjs';
import { WorktreeService } from '../../src/main/services/WorktreeService.ts';
import { AgentControlService } from '../../src/main/services/AgentControlService.ts';
import { PreferenceReviewService } from '../../src/main/services/PreferenceReviewService.ts';
import { ScopedCapsuleControl } from '../../src/main/services/ScopedCapsuleControl.ts';
import { ContextProfileStore } from '../../src/main/services/ContextProfileStore.ts';
import { ContextLaunchService } from '../../src/main/services/ContextLaunchService.ts';
import { capsuleEngine } from './capsule-engine.mjs';
import { accountRouteBinding } from '../../src/shared/providerAccountPolicy.ts';

/** Actual services, fake PTY/account/daemon only. No live discovery, auth, SSH or process launch. */
export async function preferenceReviewFixture(t, hooks = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-preference-runtime-'))), source = join(root, 'source');
  await mkdir(source); execFileSync('git', ['init', source], { stdio: 'ignore' });
  await writeFile(join(source, 'code.ts'), 'private before\n'); await writeFile(join(source, 'excluded.txt'), 'never mounted');
  const profile = { id: 'image', label: 'Review image', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/fixture.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', commands: { opencode: '/usr/bin/opencode' }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: `${process.getuid()}:${process.getgid()}` };
  const settings = { contextProfilesEnabled: true, containerProfiles: [profile], remoteHosts: [], providerAccounts: [{ id: 'api', label: 'Review API', provider: 'opencode', binding: { kind: 'api-profile', profileId: 'backend' } }], apiProfiles: [{ id: 'backend', name: 'Backend', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', secretRef: 'OPENAI_API_KEY', defaultModel: 'fixture-model' }], defaultDataClass: 'D2', pathPolicies: [], requiresSandboxProfiles: [], maxAccountsPerProviderPerHost: 1 };
  settings.providerAccounts[0].assessment = { profile: { training: 'none', retention: 'bounded', thirdPartyProcessing: 'no', contractualMode: 'api' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: 'Synthetic fixture only', models: '*', binding: accountRouteBinding(settings.providerAccounts[0], settings.apiProfiles) } };
  const parentAccount = { id: 'parent', provider: 'claude', label: 'Fixture parent' };
  parentAccount.assessment = { profile: { training: 'none', retention: 'bounded', thirdPartyProcessing: 'no', contractualMode: 'business' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: 'Synthetic parent fixture', models: '*', binding: accountRouteBinding(parentAccount) } };
  settings.providerAccounts.push(parentAccount);
  hooks.settings?.(settings);
  const store = new ContextProfileStore(join(root, 'context')), context = new ContextLaunchService(store);
  let state = await store.saveProject({ root: source, label: 'Review project' }, 0), projectId = state.projects[0].id;
  state = await store.saveRule({ scope: 'project', ownerId: projectId, category: 'design', key: 'tone', value: 'REVIEW_PRIVATE_PREFERENCE', dataClass: 'D2', tags: [], enabled: true }, state.revision);
  await store.saveRule({ scope: 'project', ownerId: projectId, category: 'design', key: 'restricted', value: 'NEVER_DISCLOSE_D3', dataClass: 'D3', tags: [], enabled: true }, state.revision);
  const storage = new TaskCapsuleService({ rootDirectory: join(root, 'capsules') }), capsules = new CapsuleLaunchService(storage, () => settings);
  const calls = [], events = [], exits = [];
  const manager = new TerminalManager((...event) => events.push(event), { get(provider) { return { provider, state: 'available', executable: `/fixture/${provider}`, launcher: 'native', environment: {}, checked: [] }; } }, undefined, undefined, false,
    (command, args, options) => { calls.push({ command, args, options }); let exit; return { onData() {}, onExit(cb) { exits.push(cb); exit = cb; }, write() {}, resize() {}, kill() { exit?.({ exitCode: 0 }); } }; });
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings, { context, capsulePolicy: r => capsules.classify(r) }));
  manager.configureContextLaunch(context, () => settings.contextProfilesEnabled);
  const parent = manager.create({ provider: 'claude', profile: 'normal', role: 'orchestrator', cwd: source, position: { x: 0, y: 0 }, ...(hooks.parentContextOff ? { context: { enabled: false } } : {}) });
  const engine = capsuleEngine(profile, hooks), worktrees = new WorktreeService({ rootDirectory: join(root, 'worktrees') });
  const containers = new ContainerExecutionService(() => settings, { rootDirectory: join(root, 'containers'), runner: engine.runner, resolveEndpoint: engine.resolveEndpoint, onWorkspaceStopped: (id, lease, kind) => ['capsule', 'advisory-review'].includes(kind) ? storage.confirmContainerStopped(id, lease) : worktrees.confirmContainerStopped(id, lease) });
  let keyReads = 0;
  const secrets = { get generation() { hooks.beforeSecret?.(); return 0; }, get: async () => { keyReads++; await hooks.account?.(); return 'fixture'; } };
  const accounts = new ProviderAccountLaunchService(() => settings, secrets), coordinator = new SessionLaunchCoordinator(accounts, worktrees, () => settings, { checkShell() { throw Error('No SSH'); }, place() { throw Error('No placement'); } }, containers, capsules), prepared = new Map();
  manager.configureProviderLaunch({ handlesTerminals: true, async prepare(...args) { const result = await coordinator.prepare(...args); prepared.set(args[0].id, result); return result; } });
  const control = new AgentControlService(manager), reviews = new PreferenceReviewService(capsules, manager, control, containers, () => settings), scope = new ScopedCapsuleControl(manager, control, capsules, undefined, undefined, reviews);
  const original = await capsules.prepareForParent(parent.id, ['code.ts'], 'Change selected code');
  if (hooks.deleted) await rm(join(original.directory, 'code.ts')); else await writeFile(join(original.directory, 'code.ts'), 'private after\n');
  const review = await capsules.review(original.id);
  const input = { capsuleId: original.id, reviewId: review.reviewId, parentSessionId: parent.id, accountId: 'api', model: 'fixture-model', containerProfileId: 'image' };
  const stop = async id => { manager.dispose(id); await prepared.get(id)?.cleanup(); };
  const cleanup = async () => { await manager.shutdown(); for (const p of prepared.values()) await p.cleanup().catch(() => {}); await rm(root, { recursive: true, force: true }); };
  t?.after(cleanup);
  return { root, source, settings, storage, capsules, store, context, projectId, manager, parent, engine, containers, worktrees, calls, events, exits, control, reviews, scope, original, review, input, prepared, stop, cleanup, keyReads: () => keyReads };
}
