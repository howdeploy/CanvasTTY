import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { CONTAINER_BOOTSTRAP } from '../src/main/services/ContainerBootstrap.ts';
import { assertContainerProfile } from '../src/shared/containerProfiles.ts';
import { WorktreeService } from '../src/main/services/WorktreeService.ts';
import { SessionLaunchCoordinator } from '../src/main/services/SessionLaunchCoordinator.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { AgentControlService } from '../src/main/services/AgentControlService.ts';
import { ProviderAccountLaunchService } from '../src/main/services/ProviderAccountLaunchService.ts';
import { remoteContainerCommand, REMOTE_CONTAINER_HOST } from '../src/main/services/RemoteContainerHost.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerExecutionService, parseEngineInfo, buildContainerCreateArguments, verifyContainerInspection } from '../src/main/services/ContainerExecutionService.ts';
const image = 'sha256:' + 'a'.repeat(64);
const id = 'b'.repeat(64);
const profile = { id: 'sandbox', label: 'Sandbox', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/user/1000/docker.sock' }, image: 'example/agent:local', python: '/usr/bin/python3', commands: { terminal: '/bin/sh' }, network: 'none', cpus: 2, memoryMb: 1024, pids: 128, user: `${process.getuid()}:${process.getgid()}` };
const info = { ID: 'engine-a', Name: 'engine', DockerRootDir: '/var/lib/docker', OSType: 'linux', ServerVersion: '27.5.1', CgroupVersion: '2', CgroupDriver: 'systemd', CpuCfsPeriod: true, CpuCfsQuota: true, MemoryLimit: true, PidsLimit: true, SecurityOptions: [] };
const workspace = { id: '11111111-1111-4111-8111-111111111111', directory: '/tmp/owned/workspace', sourceDirectory: '/tmp/source', commit: 'c'.repeat(40) };
function inspected(record) { return { Id: id, Name: '/' + record.name, Image: image, Path: profile.python, Args: ['-I', '-S', '-c', record.bootstrap], Config: { Labels: structuredClone(record.labels), WorkingDir: '/workspace', User: record.user ?? profile.user, Env: [...(record.env ?? [])], Tty: true, OpenStdin: true, Entrypoint: [profile.python] }, Mounts: [{ Type: 'bind', Source: record.directory, Destination: '/workspace', RW: true, Propagation: 'rprivate' }], HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'], NetworkMode: record.network ?? 'none', Memory: 1073741824, NanoCpus: 2000000000, PidsLimit: 128, CgroupnsMode: 'private', Mounts: [{ Type: 'bind', Source: record.directory, Target: '/workspace', BindOptions: { NonRecursive: true, Propagation: 'rprivate' } }], Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=256m,mode=1777' }, RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none' } }, State: { Running: false, Status: 'created' } }; }
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-containers-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'workspace'); await mkdir(directory); const owned = { ...workspace, directory };
  const selectedProfile = options.profile ?? profile;
  const settings = { containerProfiles: [selectedProfile], remoteHosts: [] };
  const calls = []; let daemon = options.info ?? info; let record; let infoCalls = 0;
  const controls = { fail: null, mutate: null, running: true, exists: false, raw: null };
  const serviceOptions = { rootDirectory: root, onWorkspaceStopped: options.onWorkspaceStopped, resolveEndpoint: async p => ({ executable: p.executable, socket: p.endpoint.socket, executableIdentity: 'fixture' }), runner: async (command, args, environment) => {
    calls.push({ command, args, environment });
    if (controls.fail && args.includes(controls.fail)) throw new Error('engine failure secret-like output is redacted');
    if (controls.raw && args.includes(controls.raw.stage)) return { stdout: controls.raw.value };
    if (args.includes('info')) { if (++infoCalls === 2) await options.beforeSecondInfoGate; return { stdout: JSON.stringify(daemon) }; }
    if (args.includes('image')) return { stdout: JSON.stringify([{ Id: image, Os: 'linux', Architecture: 'amd64', Config: { Env: ['OTHER_KEY=never-copy'], Volumes: {} } }]) };
    if (args.includes('create')) {
      await options.beforeCreateGate;
      controls.exists = true;
      record = { name: args[args.indexOf('--name') + 1], labels: Object.fromEntries(args.flatMap((word, i) => word === '--label' ? [args[i + 1].split('=')] : [])), bootstrap: args.at(-1), network: args.find(a => a.startsWith('--network=')).slice(10), directory: args.find(a => a.startsWith('--mount=')).match(/src=([^,]+)/)[1], user: selectedProfile.user, env: args.filter(a => a.startsWith('--env=')).flatMap(a => { const item = a.slice(6); return item.includes('=') ? [item] : environment[item] === undefined ? [] : [`${item}=${environment[item]}`]; }) };
      if (options.failAfterCreate) { controls.exists = false; throw new Error('Create response lost; daemon outcome unknown.'); }
      await options.createGate; return { stdout: id + '\n' };
    }
    if (args.includes('inspect')) { const value = inspected(record); value.State.Running = controls.running; controls.mutate?.(value); return { stdout: JSON.stringify([value]) }; }
    if (args.includes('ls')) return { stdout: controls.exists ? id : '' };
    if (args.includes('stop')) controls.running = false;
    if (args.includes('rm')) controls.exists = false;
    return { stdout: '' };
  } };
  const makeService = () => new ContainerExecutionService(() => settings, serviceOptions);
  const service = makeService();
  return { root, calls, service, makeService, settings, workspace: owned, controls, gone: () => { controls.exists = false; }, changed: () => { daemon = { ...info, ID: 'other-engine' }; } };
}
test('container preparation creates and verifies exact owned ID before returning PTY attach, never pulls', async t => {
  const f = await fixture(t); const prepared = await f.service.prepare({ id: 'session', provider: 'terminal', cwd: '/tmp/source', profile: 'normal', isolation: { mode: 'container', profileId: 'sandbox' } }, f.workspace, { args: [], environment: {}, model: undefined });
  assert.ok(prepared.process.command.endsWith('docker')); assert.deepEqual(prepared.process.args.slice(-5), ['container', 'start', '--attach', '--interactive', id]);
  const create = f.calls.find(c => c.args.includes('create')).args;
  assert.ok(create.includes('--pull=never')); assert.ok(create.some(a => a.includes('bind-recursive=disabled'))); assert.ok(!create.some(a => a.endsWith(',rw')));
  assert.ok(create.includes(image)); assert.ok(create.includes('--env=OTHER_KEY')); assert.ok(!JSON.stringify(f.calls).includes('never-copy'));
  assert.equal((await f.service.list())[0].containerId, id);
  f.changed(); await assert.rejects(prepared.cleanup(), /identity|changed/); assert.equal(f.calls.filter(c => c.args.includes('stop')).length, 0);
  assert.equal((await f.service.list())[0].state, 'cleanup-needed');
});
test('engine limit support and rootless Docker delegation fail closed', () => {
  assert.throws(() => parseEngineInfo(profile, { ...info, CpuCfsQuota: false }), /CPU|limits/);
  assert.throws(() => parseEngineInfo(profile, { ...info, SecurityOptions: ['name=rootless'], CgroupDriver: 'cgroupfs' }), /systemd/);
});
const metadata = () => ({ id: 'session', provider: 'terminal', cwd: '/tmp/source', profile: 'normal', isolation: { mode: 'container', profileId: 'sandbox' } });
const noAccount = { args: [], environment: {} };
test('cleanup stops and removes only exact owned ID; repeating after missing container is safe', async t => {
  const f = await fixture(t); const prepared = await f.service.prepare(metadata(), f.workspace, noAccount);
  const entry = (await f.service.list())[0];
  await prepared.cleanup(); await prepared.cleanup();
  assert.deepEqual(f.calls.find(c => c.args.includes('stop')).args.slice(-5), ['container', 'stop', '-t', '5', id]);
  assert.deepEqual(f.calls.find(c => c.args.includes('rm')).args.slice(-3), ['container', 'rm', id]);
  assert.equal((await f.service.list()).length, 0);
  assert.ok(!f.calls.some(c => c.args.includes('prune') || c.args.includes('--force')));
  const second = await f.service.prepare(metadata(), f.workspace, noAccount); f.gone(); await second.cleanup();
  assert.equal((await f.service.list()).length, 0);
});
test('cleanup waits for an in-flight create and cancels its launch before releasing the workspace', async t => {
  let release;
  const beforeCreateGate = new Promise(resolve => { release = resolve; });
  let releasedLease = false;
  const f = await fixture(t, { beforeCreateGate, onWorkspaceStopped: async () => { releasedLease = true; } });
  f.controls.running = false;
  const outcome = f.service.prepare(metadata(), f.workspace, noAccount).then(prepared => ({ prepared }), error => ({ error }));
  for (let i = 0; i < 100 && !f.calls.some(call => call.args.includes('create')); i++) await new Promise(resolve => setTimeout(resolve, 2));
  const [generation] = await f.service.list();
  assert.ok(generation);
  const cleanup = f.service.cleanup(generation.id);
  await new Promise(resolve => setTimeout(resolve, 15));
  const releasedBeforeCreateSettled = releasedLease;
  release();
  await cleanup;
  const result = await outcome;
  assert.equal(releasedBeforeCreateSettled, false, 'pending creation still owns its workspace lease');
  assert.match(result.error?.message ?? '', /cancelled|cleanup/iu);
  assert.equal(releasedLease, true);
  assert.equal(f.controls.exists, false);
  assert.equal((await f.service.list()).length, 0);
  assert.deepEqual(f.calls.filter(call => call.args.includes('rm')).map(call => call.args.at(-1)), [id]);
});
test('cleanup revokes the prepared launch even when engine termination fails', async t => {
  const f = await fixture(t);
  const prepared = await f.service.prepare(metadata(), f.workspace, noAccount);
  f.controls.fail = 'stop';
  await assert.rejects(prepared.cleanup());
  f.controls.fail = null;
  assert.throws(() => prepared.assertCurrent(metadata()), /cancelled|cleanup/iu);
  await assert.rejects(prepared.beforeSpawn(), /cancelled|cleanup/iu);
  await prepared.cleanup();
  assert.equal(f.controls.exists, false);
});
test('cleanup before create waits for preparation and prevents the engine mutation', async t => {
  let release;
  const beforeSecondInfoGate = new Promise(resolve => { release = resolve; });
  let releasedLease = false;
  const f = await fixture(t, { beforeSecondInfoGate, onWorkspaceStopped: async () => { releasedLease = true; } });
  const outcome = f.service.prepare(metadata(), f.workspace, noAccount).then(prepared => ({ prepared }), error => ({ error }));
  for (let i = 0; i < 100 && f.calls.filter(call => call.args.includes('info')).length < 2; i++) await new Promise(resolve => setTimeout(resolve, 2));
  const [generation] = await f.service.list();
  const cleanup = f.service.cleanup(generation.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  const releasedEarly = releasedLease;
  release();
  await cleanup;
  assert.equal(releasedEarly, false);
  assert.match((await outcome).error?.message ?? '', /cancelled|cleanup/iu);
  assert.equal(f.calls.some(call => call.args.includes('create')), false);
  assert.equal(releasedLease, true);
});
test('unknown create outcome retains recovery ownership until the daemon exposes its exact generation', async t => {
  let releasedLease = false;
  const f = await fixture(t, { failAfterCreate: true, onWorkspaceStopped: async () => { releasedLease = true; } });
  await assert.rejects(f.service.prepare(metadata(), f.workspace, noAccount));
  assert.equal(releasedLease, false);
  const [generation] = await f.service.list();
  assert.ok(generation, 'a failed client command is not proof that the daemon did not create');
  const recovered = f.makeService();
  await assert.rejects(recovered.cleanup(generation.id), /unconfirmed|unknown/iu);
  assert.equal(releasedLease, false);
  f.controls.exists = true;
  await recovered.cleanup(generation.id);
  assert.equal(releasedLease, true);
  assert.equal(f.controls.exists, false);
  assert.equal((await recovered.list()).length, 0);
});
test('changed ownership and changed restrictions cannot clean a same-name foreign generation', async t => {
  for (const mutate of [v => { v.Config.Labels['io.canvastty.generation'] = 'foreign'; }, v => { v.HostConfig.Privileged = true; }, v => { v.Mounts[0].Source = '/tmp/foreign'; }]) {
    const f = await fixture(t); const prepared = await f.service.prepare(metadata(), f.workspace, noAccount); f.controls.mutate = mutate;
    await assert.rejects(prepared.cleanup()); assert.equal(f.calls.some(c => c.args.includes('stop')), false);
    assert.equal((await f.service.list())[0].state, 'cleanup-needed');
  }
});
test('unreachable cleanup is retained and can be retried without cached rejection', async t => {
  const f = await fixture(t); const prepared = await f.service.prepare(metadata(), f.workspace, noAccount);
  f.controls.fail = 'stop'; await assert.rejects(prepared.cleanup(), /withheld/);
  assert.equal((await f.service.list())[0].state, 'cleanup-needed');
  f.controls.fail = null; await prepared.cleanup(); assert.equal((await f.service.list()).length, 0);
});
test('missing image never creates, pulls or starts a VM; final engine recheck prevents changed endpoint attach', async t => {
  const f = await fixture(t); f.controls.fail = 'image';
  await assert.rejects(f.service.prepare(metadata(), f.workspace, noAccount));
  assert.ok(!f.calls.some(c => c.args.includes('create') || c.args.includes('pull') || c.args.includes('machine')));
  f.controls.fail = null; const prepared = await f.service.prepare(metadata(), f.workspace, noAccount); f.changed();
  await assert.rejects(prepared.beforeSpawn(), /identity/);
});
test('container secrets exist only in the scoped create environment; host HOME stays on the engine store', async t => {
  const f = await fixture(t); const secret = 'test-key-never-in-argv';
  const prepared = await f.service.prepare(metadata(), f.workspace, { args: [], environment: { CANVASTTY_PROFILE_API_KEY: secret } });
  const create = f.calls.find(c => c.args.includes('create'));
  assert.equal(create.environment.CANVASTTY_PROFILE_API_KEY, secret);
  assert.equal(create.environment.HOME, process.env.HOME);
  assert.ok(create.args.includes('--env=CANVASTTY_PROFILE_API_KEY')); assert.ok(create.args.includes('--env=HOME=/tmp'));
  assert.ok(!JSON.stringify(create.args).includes(secret)); assert.ok(!JSON.stringify(prepared.process).includes(secret));
  const recordFile = (await readdir(f.root)).find(name => name.endsWith('.json'));
  assert.ok(!(await readFile(join(f.root, recordFile), 'utf8')).includes(secret));
  await prepared.cleanup();
});
test('profile validation rejects coercible missing values and accepts existing dotted host IDs', () => {
  for (const key of ['id', 'user', 'hostId', 'executable']) { const p = { ...profile }; delete p[key]; assert.throws(() => assertContainerProfile(p)); }
  assert.doesNotThrow(() => assertContainerProfile({ ...profile, hostId: 'server.a', hostPython: '/usr/bin/python3' }));
  assert.throws(() => assertContainerProfile({ ...profile, cpus: 0 }));
});
test('shared session coordinator actually spawns the verified engine attach and preserves edited worktree after container cleanup', async t => {
  const f = await fixture(t); const source = join(f.root, 'source'); await mkdir(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'test@localhost'); git('config', 'user.name', 'Test');
  await writeFile(join(source, 'file.txt'), 'base\n'); await mkdir(join(source, 'sub')); await writeFile(join(source, 'sub', 'keep.txt'), 'committed'); git('add', '.'); git('commit', '-qm', 'base');
  const worktrees = new WorktreeService({ rootDirectory: join(f.root, 'worktrees') }); const calls = [], exits = [];
  const manager = new TerminalManager(() => {}, { get: () => { throw new Error('Host CLI discovery must not run for container launch'); } }, undefined, undefined, false,
    (command, args, options) => { calls.push({ command, args, ...options }); return { onData() {}, onExit(fn) { exits.push(fn); }, resize() {}, write() {}, kill() { exits.at(-1)?.({ exitCode: 0 }); } }; });
  const settings = { remoteHosts: [], providerAccounts: [], requiresSandboxProfiles: [], containerProfiles: [profile], apiProfiles: [], pathPolicies: [], defaultDataClass: 'D2', maxAccountsPerProviderPerHost: 1, agentBudgets: { maxLocalAgents: 4, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 } };
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings));
  manager.configureProviderLaunch(new SessionLaunchCoordinator({ prepare() { throw new Error('Shell has no account'); } }, worktrees, () => settings, { checkShell() {}, place() {} }, f.service));
  t.after(async () => { await manager.shutdown(); await worktrees.dispose(); });
  const created = manager.create({ ...metadata(), cwd: join(source, 'sub'), position: { x: 0, y: 0 } }); await manager.waitForLaunch(created.id);
  const session = manager.list()[0]; assert.equal(session.exitCode, null, session.failureDetails);
  assert.equal(calls.length, 1); assert.equal(calls[0].command, profile.executable); assert.deepEqual(calls[0].args.slice(-5), ['container', 'start', '--attach', '--interactive', id]);
  assert.equal(session.execution.executionCwd, '/workspace/sub'); assert.equal(session.execution.filesystemRestricted, true);
  assert.notEqual(session.execution.hostWorkspace, source); assert.equal(session.cwd, join(source, 'sub'));
  await writeFile(join(session.execution.hostWorkspace, 'file.txt'), 'retained output\n');
  exits[0]({ exitCode: 0 });
  for (let i = 0; i < 100 && (await f.service.list()).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await worktrees.dispose(); assert.equal((await worktrees.list())[0].state, 'retained');
  assert.match((await worktrees.review(session.execution.workspaceId)).patch, /retained output/);
  await assert.rejects(worktrees.cleanup(session.execution.workspaceId), /dirty/);
});
test('cgroup bootstrap rejects unlimited CPU/RAM/PIDs before executing the provider', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvastty-cgroup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const script = `import json,sys\nnamespace={'__name__':'fixture'}\nexec(json.loads(sys.argv[1]),namespace)\nnamespace['verify_limits'](sys.argv[2],{'cpus':2,'memoryMb':1024,'pids':128},'0::/')\n`;
  const verify = () => execFileSync('/usr/bin/python3', ['-I', '-S', '-c', script, JSON.stringify(CONTAINER_BOOTSTRAP), root], { stdio: 'pipe' });
  await writeFile(join(root, 'cpu.max'), '200000 100000'); await writeFile(join(root, 'memory.max'), '1073741824'); await writeFile(join(root, 'pids.max'), '128');
  assert.doesNotThrow(verify);
  for (const [file, valid] of [['cpu.max', '200000 100000'], ['memory.max', '1073741824'], ['pids.max', '128']]) { await writeFile(join(root, file), file === 'cpu.max' ? 'max 100000' : 'max'); assert.throws(verify); await writeFile(join(root, file), valid); }
});

test('Podman native recipe uses real inspect keys, zero capabilities and nonrecursive mounts', async t => {
  const podman = { ...profile, runtime: 'podman', executable: '/usr/bin/podman', endpoint: { kind: 'native' }, user: 'keep-id' };
  const podmanInfo = { host: { hostname: 'host', os: 'linux', cgroupVersion: 'v2', cgroupControllers: ['cpu', 'memory', 'pids'], security: { rootless: true } }, store: { graphRoot: '/home/runner/.local/share/containers/storage', runRoot: '/run/user/1000/containers' } };
  const f = await fixture(t, { profile: podman, info: podmanInfo });
  f.controls.mutate = value => { delete value.HostConfig.CgroupnsMode; delete value.HostConfig.Mounts; value.HostConfig.CgroupMode = 'private'; value.HostConfig.CapDrop = ['CAP_CHOWN']; value.EffectiveCaps = null; value.BoundingCaps = []; value.Mounts[0].Options = ['bind']; value.HostConfig.Tmpfs['/tmp'] = 'rw,nosuid,nodev,noexec,size=268435456,notmpcopyup'; };
  const prepared = await f.service.prepare(metadata(), f.workspace, noAccount); const args = f.calls.find(call => call.args.includes('create')).args;
  assert.ok(args.includes('--remote=false')); assert.ok(args.includes('--userns=keep-id')); assert.ok(args.includes('--http-proxy=false')); assert.ok(args.includes('--unsetenv-all')); assert.ok(args.some(a => a.includes('bind-nonrecursive'))); assert.ok(args.some(a => a.includes('notmpcopyup')));
  await prepared.beforeSpawn(); await prepared.cleanup();
});
test('unexpected image env and active health checks are rejected before attach', async t => {
  for (const mutate of [v => v.Config.Env.push('LD_PRELOAD=/workspace/hook.so'), v => { v.Config.Healthcheck = { Test: ['CMD', '/unapproved'] }; }]) {
    const f = await fixture(t); f.controls.mutate = mutate;
    await assert.rejects(f.service.prepare(metadata(), f.workspace, noAccount), /environment|healthchecks/);
    assert.equal(f.calls.some(call => call.args.includes('start')), false); assert.equal((await f.service.list())[0].state, 'cleanup-needed');
  }
});
test('malformed engine JSON cannot echo raw response secrets into launch diagnostics', async t => {
  const f = await fixture(t); f.controls.raw = { stage: 'image', value: 'dummy-private-key: invalid JSON' };
  await assert.rejects(f.service.prepare(metadata(), f.workspace, noAccount), error => /withheld/.test(error.message) && !error.message.includes('dummy-private-key'));
});
test('late create completion after cancellation cleans its exact generation and marker without starting', async t => {
  let release; const createGate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { createGate }); let current = true;
  const pending = f.service.prepare(metadata(), f.workspace, noAccount, () => { if (!current) throw new Error('cancelled'); });
  while (!f.calls.some(call => call.args.includes('create'))) await new Promise(resolve => setTimeout(resolve, 2));
  current = false; release(); await assert.rejects(pending, /cancelled/);
  assert.equal(f.calls.some(call => call.args.includes('start')), false);
  assert.equal((await f.service.list()).length, 0); assert.equal((await readdir(f.workspace.directory)).length, 0);
});
test('recovery keeps generations and verifies ownership again before removal', async t => {
  const f = await fixture(t); await f.service.prepare(metadata(), f.workspace, noAccount);
  const recovered = f.makeService(); const entries = await recovered.list();
  assert.equal(entries.length, 1); assert.equal(entries[0].state, 'cleanup-needed');
  f.controls.mutate = value => { value.Config.Labels['io.canvastty.installation'] = 'foreign'; };
  await assert.rejects(recovered.cleanup(entries[0].id), /identity/);
  f.controls.mutate = null; await recovered.cleanup(entries[0].id); assert.equal((await recovered.list()).length, 0);
});
test('container profile policy keeps source confidentiality and fails before probes on wrong host', () => {
  const settings = { remoteHosts: [], providerAccounts: [], apiProfiles: [], pathPolicies: [{ pattern: '**', dataClass: 'D3' }], defaultDataClass: 'D2', maxAccountsPerProviderPerHost: 1, containerProfiles: [profile] };
  const policy = new SessionLaunchPolicy(() => settings);
  const request = { ...metadata(), cwd: process.cwd(), dataClass: 'D2' };
  assert.equal(policy.classify(request).dataClass, 'D3');
  assert.throws(() => policy.classify({ ...request, hostId: 'other' }), /exact execution host/);
  assert.throws(() => policy.classify(request, true), /exact execution host/);
});
test('remote container command keeps argv quoted and disables forwarding, without a host provider probe', () => {
  const host = { id: 'server.a', label: 'Server', sshHost: 'server.example', sshUser: 'runner', sshPort: 2222 };
  const launch = remoteContainerCommand(host, '/usr/bin/podman', ['image', 'inspect', "name'with-space"], true);
  assert.equal(launch.command, 'ssh'); assert.equal(launch.args[0], '-tt'); assert.ok(launch.args.includes('ForwardAgent=no'));
  assert.match(launch.args.at(-1), /'name'\\''with-space'/);
  assert.throws(() => remoteContainerCommand({ ...host, sshHost: '-bad' }, 'anything', []));
});

async function gitSource(root) {
  const source = join(root, 'repo'); await mkdir(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'test@localhost'); git('config', 'user.name', 'Test');
  await writeFile(join(source, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  return source;
}
test('real policy + coordinator + account adapter + MCP control launch a scoped API child, without host CLI discovery', async t => {
  for (const runtime of ['opencode', 'minimax', 'omp']) await t.test(runtime, async t => {
  const f = await fixture(t); const source = await gitSource(f.root);
  const containerProfile = { ...profile, network: 'bridge', commands: { [runtime]: `/usr/local/bin/${runtime}`, terminal: '/bin/sh' } };
  f.settings.containerProfiles = [containerProfile];
  const settings = { ...f.settings, providerAccounts: [{ id: 'api-account', label: 'API', provider: runtime, binding: { kind: 'api-profile', profileId: 'api-profile' } }],
    apiProfiles: [{ id: 'api-profile', name: 'API', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', secretRef: 'OPENAI_API_KEY', defaultModel: 'fixture-model' }],
    requiresSandboxProfiles: [], pathPolicies: [], defaultDataClass: 'D0', maxAccountsPerProviderPerHost: 1, agentBudgets: { maxLocalAgents: 2, maxRemoteAgentsPerHost: 2, maxChildren: 1, maxDepth: 2 } };
  const calls = []; let keyReads = 0, hostProbes = 0;
  const worktrees = new WorktreeService({ rootDirectory: join(f.root, 'managed') });
  const accounts = new ProviderAccountLaunchService(() => settings, { generation: 0, get: async () => { keyReads++; return 'fixture-api-key'; } }, { temporaryRoot: join(f.root, 'api-configs') });
  const manager = new TerminalManager(() => {}, { get() { throw new Error('Host CLI discovery must not run'); } }, undefined, undefined, false,
    (command, args, options) => { calls.push({ command, args, ...options }); return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; });
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings));
  manager.configureProviderLaunch(new SessionLaunchCoordinator(accounts, worktrees, () => settings, { checkShell: async () => { hostProbes++; }, place: async () => { hostProbes++; throw new Error('wrong discovery'); } }, f.service));
  const control = new AgentControlService(manager, { place: async () => { hostProbes++; throw new Error('Generic placement must not handle containers'); } });
  t.after(async () => { await manager.shutdown(); await worktrees.dispose(); });
  const parent = manager.create({ provider: 'terminal', cwd: source, profile: 'normal', position: { x: 0, y: 0 }, role: 'orchestrator' }); await manager.waitForLaunch(parent.id);
  const request = { parentSessionId: parent.id, provider: runtime, cwd: source, isolation: { mode: 'container', profileId: profile.id }, accountId: 'api-account', initialPrompt: '! literal\n/command @file $(literal)' };
  assert.throws(() => control.spawn({ ...request, host: 'auto' }), /exact host/);
  const child = await control.spawn(request); await manager.waitForLaunch(child.id);
  const actual = manager.list().find(s => s.id === child.id); assert.equal(actual.exitCode, null, actual.failureDetails);
  assert.equal(calls.at(-1).command, profile.executable); assert.equal(hostProbes, 0); assert.equal(keyReads, 1);
  assert.equal(actual.cwd, source); assert.equal(actual.dataClass, 'D0');
  const create = f.calls.find(c => c.args.includes('create'));
  assert.equal(create.environment.CANVASTTY_PROFILE_API_KEY, 'fixture-api-key');
  const argv = JSON.parse(create.environment.CANVASTTY_CONTAINER_RECIPE).args;
  if (runtime !== 'minimax') assert.ok(argv.includes('--model'));
  assert.equal(argv.at(-1), 'CanvasTTY task:\n! literal\n/command @file $(literal)');
  assert.throws(() => control.spawn(request), /child limit/);
  await manager.shutdown(); assert.equal((await f.service.list()).length, 0);
  });
});

test('container-specific MiniMax and OMP preparation leaves no host config files and uses fixed private bootstrap recipes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvastty-api-container-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const runtime of ['minimax', 'omp']) {
    const settings = { remoteHosts: [], providerAccounts: [{ id: 'account', label: 'API', provider: runtime, binding: { kind: 'api-profile', profileId: 'backend' } }], apiProfiles: [{ id: 'backend', name: 'Backend', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', secretRef: 'OPENAI_API_KEY', defaultModel: 'model' }] };
    const service = new ProviderAccountLaunchService(() => settings, { generation: 0, get: async () => 'dummy-bootstrap-key' }, { temporaryRoot: join(root, runtime) });
    const prepared = await service.prepare({ ...metadata(), provider: runtime, accountId: 'account', dataClass: 'D0' }, false, { target: 'container' });
    assert.equal(prepared.environment.CANVASTTY_PROFILE_API_KEY, 'dummy-bootstrap-key'); assert.equal(prepared.containerRecipe.runtime, runtime);
    assert.equal(prepared.environment.MINIMAX_DATA_DIR, undefined); assert.equal(prepared.environment.PI_CODING_AGENT_DIR, undefined);
    assert.equal((await readdir(root)).length, 0);
    await prepared.cleanup();
  }
});

test('fixed bootstrap validates mounts/marker/caps and writes MiniMax or OMP config privately before exec', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvastty-bootstrap-')); t.after(() => rm(root, { recursive: true, force: true }));
  const script = String.raw`
import os,sys,json,io,tempfile,builtins,stat
namespace={'__name__':'fixture'}; exec(json.loads(sys.argv[1]),namespace)
root=sys.argv[2]; runtime=sys.argv[3]
workspace=os.path.join(root,runtime); os.mkdir(workspace)
marker={'name':'.canvastty-container-11111111-1111-4111-8111-111111111111','token':'22222222-2222-4222-8222-222222222222'}
with open(os.path.join(workspace,marker['name']),'w') as f: f.write(marker['token'])
recipe={'command':'/bin/sh','args':[],'cwd':'/workspace','limits':{'cpus':2,'memoryMb':1024,'pids':128},'marker':marker,'api':{'runtime':runtime,'provider':'fixture','model':'model','baseUrl':'https://api.example/v1','api':'openai-completions'}}
os.environ.clear(); os.environ.update({'CANVASTTY_CONTAINER_RECIPE':json.dumps(recipe),'CANVASTTY_PROFILE_API_KEY':'dummy-bootstrap-key','UNRELATED_API_KEY':'not-in-child'})
original_open=builtins.open; original_os_open=os.open; original_unlink=os.unlink
original_realpath=os.path.realpath; original_isdir=os.path.isdir; original_stat=os.stat
original_mkstemp=tempfile.mkstemp; original_mkdtemp=tempfile.mkdtemp
mounts='1 0 0:1 / / ro - overlay overlay ro\n2 1 0:2 / /workspace rw - ext4 workspace rw\n3 1 0:3 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw\n'
files={'/proc/self/status':'NoNewPrivs:\t1\n'+''.join(k+':\t00000000\n' for k in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']),'/proc/self/cgroup':'0::/','/proc/self/mountinfo':mounts,'/sys/fs/cgroup/cpu.max':'200000 100000','/sys/fs/cgroup/memory.max':'1073741824','/sys/fs/cgroup/pids.max':'128'}
def opened(path,*args,**kwargs): return io.StringIO(files[path]) if path in files else original_open(path,*args,**kwargs)
builtins.open=opened
os.open=lambda path,*args,**kwargs: original_os_open(path.replace('/workspace/',workspace+'/'),*args,**kwargs)
os.unlink=lambda path,*args,**kwargs: original_unlink(path.replace('/workspace/',workspace+'/'),*args,**kwargs)
os.path.realpath=lambda path: path if path=='/workspace' else original_realpath(path)
os.path.isdir=lambda path: True if path=='/workspace' else original_isdir(path)
os.stat=lambda path,*args,**kwargs: original_stat(workspace if path=='/workspace' else path,*args,**kwargs)
tempfile.mkstemp=lambda **kwargs: original_mkstemp(**dict(kwargs,dir=workspace))
tempfile.mkdtemp=lambda **kwargs: original_mkdtemp(**dict(kwargs,dir=root))
os.chdir=lambda path: None
captured=[]
os.execve=lambda command,args,env: captured.append((command,args,env))
namespace['run']()
assert len(captured)==1
command,args,env=captured[0]; assert 'UNRELATED_API_KEY' not in env
config_root=env['MINIMAX_DATA_DIR' if runtime=='minimax' else 'PI_CODING_AGENT_DIR']
assert stat.S_IMODE(original_stat(config_root).st_mode)==0o700
config_path=os.path.join(config_root,'config.yaml' if runtime=='minimax' else 'models.yml')
assert stat.S_IMODE(original_stat(config_path).st_mode)==0o600
with original_open(config_path) as f: config=json.load(f)
if runtime=='minimax':
    assert config['custom_provider']['fixture']['options']['apiKey']=='dummy-bootstrap-key'
    assert 'CANVASTTY_PROFILE_API_KEY' not in env
else:
    assert config['providers']['fixture']['apiKey']=='CANVASTTY_PROFILE_API_KEY'
    assert env['CANVASTTY_PROFILE_API_KEY']=='dummy-bootstrap-key'
assert not os.path.exists(os.path.join(workspace,marker['name']))
`;
  for (const runtime of ['minimax', 'omp']) assert.doesNotThrow(() => execFileSync('/usr/bin/python3', ['-I', '-S', '-c', script, JSON.stringify(CONTAINER_BOOTSTRAP), root, runtime], { stdio: 'pipe' }));
});

test('fixed remote helper creates and verifies a retained checkout using only temporary fixtures', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-remote-helper-'))); t.after(() => rm(root, { recursive: true, force: true })); const source = await gitSource(root);
  const invoke = request => JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-c', "import os,sys,json; source=json.loads(sys.argv[1]); root=sys.argv[2]; request=sys.argv[3]; os.path.expanduser=lambda value:root; sys.platform='linux'; sys.argv=['helper',request]; exec(source)", JSON.stringify(REMOTE_CONTAINER_HOST), root, JSON.stringify(request)], { encoding: 'utf8' }));
  const work = invoke({ action: 'create', source }); assert.notEqual(work.directory, source); assert.equal(work.relativeCwd, '');
  await writeFile(join(work.directory, 'file.txt'), 'remote output\n');
  assert.equal(invoke({ action: 'verify', source, id: work.id }).id, work.id); assert.equal(await readFile(join(work.directory, 'file.txt'), 'utf8'), 'remote output\n');
  const marker = { source, id: work.id, name: '.canvastty-container-11111111-1111-4111-8111-111111111111', token: '22222222-2222-4222-8222-222222222222' };
  invoke({ ...marker, action: 'marker-write' }); assert.equal(await readFile(join(work.directory, marker.name), 'utf8'), marker.token);
  invoke({ ...marker, action: 'marker-remove' }); assert.ok(!(await readdir(work.directory)).includes(marker.name));
});

test('remote shell lifecycle uses owned host workspace and exact engine; rejects rootful UID mismatch before create', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-remote-container-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const remoteProfile = { ...profile, hostId: 'server.a', hostPython: '/usr/bin/python3', user: '1000:1000' };
  const host = { id: 'server.a', label: 'Fixture', sshHost: 'server.example', sshUser: 'runner', workspaces: [{ localPath: '/tmp/source', remotePath: '/srv/source' }] };
  const settings = { containerProfiles: [remoteProfile], remoteHosts: [host], providerAccounts: [], requiresSandboxProfiles: [] };
  const calls = []; let owner = 2000;
  const service = new ContainerExecutionService(() => settings, { rootDirectory: root, runner: async (command, args, env) => {
    assert.equal(command, 'ssh'); assert.equal(env.CANVASTTY_PROFILE_API_KEY, undefined);
    const words = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-c', 'import json,shlex,sys;print(json.dumps(shlex.split(sys.argv[1])))', args.at(-1)], { encoding: 'utf8' }));
    assert.equal(words[0], '/usr/bin/python3', 'all remote operations use a fixed helper, never raw engine stdout');
    const request = JSON.parse(words.at(-1)); calls.push({ helper: request.action });
    if (request.action === 'endpoint') return { stdout: JSON.stringify({ executable: remoteProfile.executable, socket: remoteProfile.endpoint.socket, executableIdentity: 'remote-engine', home: '/home/runner', configDirectory: '/home/runner/.local/share/canvastty-container-workspaces/engine-config' }) };
    if (request.action === 'create' || request.action === 'verify') return { stdout: JSON.stringify({ ...workspace, directory: '/srv/owned/workspace', sourceDirectory: '/srv/source', relativeCwd: '', uid: owner, gid: owner }) };
    if (request.action === 'engine') return { stdout: JSON.stringify(parseEngineInfo(remoteProfile, info)) };
    if (request.action === 'image') return { stdout: JSON.stringify({ id: image, environmentNames: [] }) };
    if (['create-owned', 'inspect-owned', 'cleanup-owned'].includes(request.action)) return { stdout: JSON.stringify({ version: 1, generationId: request.plan.id, planDigest: request.planDigest, containerId: id, verified: true, ...(request.action === 'cleanup-owned' ? { removed: true } : { state: { running: false } }) }) };
    return { stdout: '{}' };
  } });
  const coord = new SessionLaunchCoordinator({ prepare() { throw new Error('Shell has no account'); } }, {}, () => settings, { checkShell: async () => {}, place() { throw new Error('Host CLI discovery prohibited'); } }, service);
  const request = { ...metadata(), hostId: host.id };
  await assert.rejects(coord.prepare(request, false), /UID:GID/);
  assert.equal(calls.some(call => call.helper === 'create-owned'), false);
  owner = 1000;
  const prepared = await coord.prepare(request, false); await prepared.beforeSpawn();
  assert.equal(prepared.process.command, 'ssh'); assert.equal(prepared.process.args[0], '-tt');
  assert.match(prepared.process.args.at(-1), /start-owned/);
  assert.equal(prepared.execution.sourceCwd, '/tmp/source'); assert.equal(prepared.execution.hostWorkspace, '/srv/owned/workspace');
  assert.equal(prepared.execution.executionCwd, '/workspace');
  await prepared.cleanup(); assert.equal((await service.list())[0].state, 'workspace-retained');
  assert.ok(calls.some(call => call.helper === 'cleanup-owned'));
  const resumed = await coord.prepare({ ...request, execution: prepared.execution }, true); await resumed.cleanup();
  settings.remoteHosts[0] = { ...host, sshHost: 'other.example' };
  await assert.rejects(prepared.beforeSpawn(), /host changed/);
});

test('failed prepare keeps local workspace reserved until exact container cleanup confirms termination', async t => {
  let worktrees;
  const f = await fixture(t, { onWorkspaceStopped: async (id, lease) => worktrees.confirmContainerStopped(id, lease) });
  const source = await gitSource(f.root); worktrees = new WorktreeService({ rootDirectory: join(f.root, 'managed') }); t.after(() => worktrees.dispose());
  const settings = { ...f.settings, providerAccounts: [], requiresSandboxProfiles: [] };
  const coord = new SessionLaunchCoordinator({}, worktrees, () => settings, {}, f.service);
  f.controls.mutate = value => { value.HostConfig.Privileged = true; };
  await assert.rejects(coord.prepare({ ...metadata(), cwd: source }, false), /restrictions/);
  const saved = (await worktrees.list())[0], generation = (await f.service.list())[0];
  assert.equal(saved.state, 'uncertain');
  await assert.rejects(worktrees.cleanup(saved.id), /active|running|reserved/);
  f.controls.mutate = null; await f.service.cleanup(generation.id);
  assert.equal((await worktrees.list())[0].state, 'retained');
  await worktrees.cleanup(saved.id); assert.equal((await worktrees.list()).length, 0);
});
