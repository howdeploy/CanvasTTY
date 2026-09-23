import test from 'node:test';
import assert from 'node:assert/strict';
import { REMOTE_CONTAINER_ENGINE, remoteEngineHelperArguments } from '../src/main/services/RemoteContainerEngine.ts';

test('remote engine helper is fixed and bounds its nonsecret request', () => {
  const profile = { hostPython: '/usr/bin/python3' };
  assert.deepEqual(remoteEngineHelperArguments(profile, { action: 'engine' }).slice(0, 3), ['-I', '-S', '-c']);
  assert.equal(remoteEngineHelperArguments(profile, { action: 'engine' })[3], REMOTE_CONTAINER_ENGINE);
  assert.throws(() => remoteEngineHelperArguments(profile, { action: 'engine', oversized: 'x'.repeat(100_000) }), /bound/);
});

import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTAINER_BOOTSTRAP } from '../src/main/services/ContainerBootstrap.ts';
import { REMOTE_CONTAINER_HOST } from '../src/main/services/RemoteContainerHost.ts';
import { parseEngineInfo, verifyContainerInspection } from '../src/main/services/ContainerExecutionService.ts';
const stable = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(stable(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stable(value[k]))])) : value);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const sentinel = 'fixture-remote-secret-cannot-leave-host-7319';
const containerId = 'b'.repeat(64);
const imageId = 'sha256:' + 'a'.repeat(64);
const info = { ID: 'engine-a', Name: 'engine', DockerRootDir: '/var/lib/docker', OSType: 'linux', CgroupVersion: '2', CgroupDriver: 'systemd', CpuCfsPeriod: true, CpuCfsQuota: true, MemoryLimit: true, PidsLimit: true, SecurityOptions: [] };
function inspected(plan) {
  return { Id: containerId, Name: '/' + plan.name, Image: imageId, Path: plan.profile.python, Args: ['-I', '-S', '-c', CONTAINER_BOOTSTRAP], Config: { Labels: plan.labels, WorkingDir: '/workspace', User: plan.user, Env: [], Tty: true, OpenStdin: true }, Mounts: [{ Type: 'bind', Source: plan.workspace.directory, Destination: '/workspace', RW: true, Propagation: 'rprivate' }], HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'], NetworkMode: 'bridge', Memory: 1073741824, NanoCpus: 2000000000, PidsLimit: 128, CgroupnsMode: 'private', Mounts: [{ BindOptions: { NonRecursive: true } }], Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=256m,mode=1777' }, RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none' } }, State: { Running: true } };
}
async function fixture(t, runtime = 'docker') {
  const daemon = runtime === 'docker' ? info : { host: { os: 'linux', cgroupVersion: 'v2', cgroupControllers: ['cpu', 'memory', 'pids'], hostname: 'fixture', security: { rootless: true } }, store: { graphRoot: '/fixture/store', runRoot: '/fixture/run' } };
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-remote-engine-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'host-home'); await mkdir(home, { mode: 0o700 });
  const source = join(root, 'source'); await mkdir(source);
  const git = args => execFileSync('/usr/bin/git', ['-C', source, ...args], { env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
  git(['init']); await writeFile(join(source, 'entry.txt'), 'baseline\n'); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
  const wrapper = `import sys,os\nsys.platform='linux'\nos.path.expanduser=lambda p: ${JSON.stringify(home)} if p=='~' else p\n`;
  const run = (request, key = sentinel, code = REMOTE_CONTAINER_ENGINE) => {
    const result = spawnSync('python3', ['-I', '-S', '-c', wrapper + code, JSON.stringify(request)], { encoding: 'utf8', env: { PATH: process.env.PATH, FIXTURE_REMOTE_KEY: key, UNRELATED_API_KEY: 'fixture' }, maxBuffer: 4 * 1024 * 1024 });
    assert.equal((result.stdout + result.stderr).includes(sentinel), false, 'helper output must not contain the host-only credential');
    return result;
  };
  const workspaceResult = run({ action: 'create', source }, sentinel, REMOTE_CONTAINER_HOST); assert.equal(workspaceResult.status, 0, workspaceResult.stderr);
  const workspace = JSON.parse(workspaceResult.stdout);
  const executable = join(root, 'fake-engine'); const stateFile = join(root, 'engine-state.json'); const controlsFile = join(root, 'controls.json'); const templateFile = join(root, 'inspection.json'); const logFile = join(root, 'engine-log.jsonl');
  const socket = join(root, 'engine.sock'); execFileSync('python3', ['-c', 'import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.close()', socket]);
  const profile = { id: 'remote-container', label: 'Fixture', hostId: 'server-one', runtime, executable, endpoint: runtime === 'docker' ? { kind: 'unix', socket } : { kind: 'native' }, hostPython: '/usr/bin/python3', image: 'fixture:existing', python: '/usr/bin/python3', commands: { opencode: '/usr/bin/opencode' }, network: 'bridge', cpus: 2, memoryMb: 1024, pids: 128, user: runtime === 'docker' ? `${process.getuid()}:${process.getgid()}` : 'keep-id' };
  await writeFile(executable, `#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]; args=args[4:] if ${JSON.stringify(runtime)}=='docker' else args[1:]
state_path=${JSON.stringify(stateFile)}; controls_path=${JSON.stringify(controlsFile)}
controls=json.load(open(controls_path)) if os.path.exists(controls_path) else {}
with open(${JSON.stringify(logFile)},'a') as log: log.write(json.dumps({'args':args,'environmentNames':sorted(os.environ),'hasKey':bool(os.environ.get('CANVASTTY_PROFILE_API_KEY'))})+'\\n')
state=json.load(open(state_path)) if os.path.exists(state_path) else None
if controls.get('fail') in [' '.join(args[:2]), args[0]]:
    sys.stderr.write(${JSON.stringify(sentinel)}); sys.stdout.write(${JSON.stringify(sentinel)}); sys.exit(1)
if controls.get('overflow')==args[0]:
    sys.stdout.write('x'*2200000); sys.exit(0)
if args[0]=='info': print(${JSON.stringify(JSON.stringify(daemon))})
elif args[0]=='image': print(json.dumps([{'Id':${JSON.stringify(imageId)},'Os':'linux','Architecture':'amd64','Config':{'Env':['BAKED_KEY='+${JSON.stringify(sentinel)}]}}]))
elif args[:2]==['container','create']:
    state=json.load(open(${JSON.stringify(templateFile)})); env=[]
    for arg in args:
        if not arg.startswith('--env='): continue
        value=arg[6:]
        if '=' in value: env.append(value)
        elif value in os.environ: env.append(value+'='+os.environ[value])
    state['Config']['Env']=env
    json.dump(state,open(state_path,'w'))
    if controls.get('lostCreate'): sys.stdout.write(${JSON.stringify(sentinel)}); sys.exit(1)
    print(state['Id'])
elif args[:2]==['container','ls'] and '--last' in args:
    rows=controls.get('inventory',[])
    if isinstance(rows,str): print(rows)
    else:
        for row in rows: print(json.dumps(row))
elif args[:2]==['container','ls']:
    selected=args[args.index('--filter')+1]
    matches=state and (selected=='id='+state['Id'] or selected=='name=^'+state['Name'].removeprefix('/')+'$')
    print(state['Id'] if matches else '')
elif args[:2]==['container','inspect']:
    if controls.get('inspection'): state=controls['inspection']
    state['UnrelatedSecretField']=${JSON.stringify(sentinel)}
    print(json.dumps([state]))
elif args[:2]==['container','stop']:
    state['State']['Running']=False; json.dump(state,open(state_path,'w'))
elif args[:2]==['container','rm']: os.unlink(state_path)
else: sys.exit(3)
`); await chmod(executable, 0o700);
  const endpointResult = run({ action: 'endpoint', profile }, sentinel, REMOTE_CONTAINER_HOST); assert.equal(endpointResult.status, 0, endpointResult.stderr);
  const endpoint = JSON.parse(endpointResult.stdout); const id = randomUUID(); const installation = randomUUID();
  const plan = { version: 2, id, installation, sessionId: 'session', name: 'canvastty-' + id, profile, endpoint, engine: parseEngineInfo(profile, daemon), image: { id: imageId, environmentNames: ['BAKED_KEY'] }, workspace, user: profile.user, bootstrap: CONTAINER_BOOTSTRAP, labels: { 'io.canvastty.installation': installation, 'io.canvastty.session': 'session', 'io.canvastty.generation': id, 'io.canvastty.workspace': workspace.id } };
  const template = inspected(plan);
  if (runtime === 'podman') { template.EffectiveCaps = []; template.BoundingCaps = []; template.Mounts[0].Options = ['bind']; template.HostConfig.CgroupMode = 'private'; }
  await writeFile(templateFile, JSON.stringify(template));
  const request = action => ({ version: 1, action, plan, planDigest: hash(plan) });
  const create = () => run({ ...request('create-owned'), environment: { CANVASTTY_CONTAINER_RECIPE: JSON.stringify({ command: '/usr/bin/opencode', args: [] }) }, credential: { kind: 'environment', name: 'FIXTURE_REMOTE_KEY' } });
  return { root, home, profile, endpoint, plan, run, request, create, stateFile, controlsFile, logFile };
}

test('actual remote helper creates with env-only key, sanitizes inspect and cleans after source key deletion', async t => {
  const f = await fixture(t);
  const engine = f.run({ version: 1, action: 'engine', profile: f.profile, endpoint: f.endpoint }); assert.equal(engine.status, 0, engine.stderr); assert.deepEqual(JSON.parse(engine.stdout), f.plan.engine);
  const image = f.run({ version: 1, action: 'image', profile: f.profile, endpoint: f.endpoint }); assert.equal(image.status, 0, image.stderr); assert.deepEqual(JSON.parse(image.stdout), f.plan.image);
  const created = f.create(); assert.equal(created.status, 0, created.stderr); assert.equal(JSON.parse(created.stdout).containerId, containerId);
  const inspectedResult = f.run({ ...f.request('inspect-owned'), containerId }, 'rotated-value'); assert.equal(inspectedResult.status, 0, inspectedResult.stderr);
  const manifestFile = join(f.home, '.local/share/canvastty-container-workspaces/engine-generations', f.plan.id + '.json');
  const manifest = await readFile(manifestFile, 'utf8'); assert.ok(!manifest.includes(sentinel)); assert.ok(!manifest.includes('FIXTURE_REMOTE_KEY'));
  const cleaned = f.run({ ...f.request('cleanup-owned'), containerId }, ''); assert.equal(cleaned.status, 0, cleaned.stderr); assert.equal(JSON.parse(cleaned.stdout).removed, true);
  const completed = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.deepEqual(Object.keys(completed).sort(), ['containerId', 'phase', 'planDigest', 'version']); assert.equal(completed.phase, 'removed');
  const calls = (await readFile(f.logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!JSON.stringify(calls).includes(sentinel));
  const creation = calls.find(c => c.args.includes('create')); assert.equal(creation.hasKey, true); assert.ok(creation.args.includes('--env=CANVASTTY_PROFILE_API_KEY'));
  assert.ok(!creation.environmentNames.includes('FIXTURE_REMOTE_KEY')); assert.ok(!creation.environmentNames.includes('UNRELATED_API_KEY'));
  assert.deepEqual(calls.filter(c => c.args.includes('rm')).map(c => c.args.at(-1)), [containerId]);
  assert.equal(await readFile(join(f.plan.workspace.directory, 'entry.txt'), 'utf8'), 'baseline\n');
});

test('actual helper never returns engine diagnostics, malformed inspection or overflowing output', async t => {
  const f = await fixture(t); assert.equal(f.create().status, 0);
  for (const controls of [{ fail: 'container inspect' }, { overflow: 'info' }, { inspection: { Config: { Env: ['CANVASTTY_PROFILE_API_KEY=' + sentinel] } } }]) {
    await writeFile(f.controlsFile, JSON.stringify(controls));
    const result = f.run({ ...f.request('inspect-owned'), containerId }); assert.equal(result.status, 78); assert.equal(result.stdout, ''); assert.match(result.stderr, /^CanvasTTY remote container engine verification failed/);
  }
  await writeFile(f.controlsFile, '{}'); assert.equal(f.run({ ...f.request('cleanup-owned'), containerId }, '').status, 0);
});

test('host-only restriction verification agrees with local verifier for unsafe Docker mutations', async t => {
  const f = await fixture(t); assert.equal(f.create().status, 0);
  const base = JSON.parse(await readFile(f.stateFile, 'utf8'));
  const record = { ...f.plan, containerId, environmentDigest: hash([...base.Config.Env].sort()) };
  assert.deepEqual(verifyContainerInspection(record, base), { running: true });
  const mutations = [
    v => { v.Id = 'c'.repeat(64); }, v => { v.Name = '/foreign'; }, v => { v.Image = 'd'.repeat(64); },
    v => { v.Config.Labels['io.canvastty.installation'] = randomUUID(); }, v => { v.Path = '/bin/sh'; }, v => { v.Args = []; },
    v => { v.Config.User = '0:0'; if (record.user === '0:0') v.Config.User = '12:12'; }, v => { v.Config.WorkingDir = '/'; },
    v => { v.Config.Tty = false; }, v => { v.Config.OpenStdin = false; }, v => { v.Config.Env.push('HTTP_PROXY=' + sentinel); },
    v => { v.Config.Env.push(v.Config.Env[0]); }, v => { v.Config.Env[0] += 'tampered'; },
    v => { v.Config.Healthcheck = {}; }, v => { v.Config.StartupHealthCheck = {}; }, v => { v.Config.Healthcheck = { Test: ['CMD', 'bad'] }; }, v => { v.Config.StartupHealthCheck = { Test: ['CMD', 'bad'] }; }, v => { v.Config.Secrets = ['unscoped']; },
    v => { v.HostConfig.LogConfig.Type = 'json-file'; }, v => { v.HostConfig.Init = true; },
    v => { v.Mounts.push({ Type: 'tmpfs', Destination: '/extra' }); }, v => { v.Mounts.push({ Type: 'bind', Source: '/secret', Destination: '/secret' }); }, v => { v.Mounts[0].Source = '/source'; }, v => { v.Mounts[0].RW = false; }, v => { v.Mounts[0].Propagation = 'shared'; },
    v => { v.HostConfig.Mounts[0].BindOptions.NonRecursive = false; }, v => { v.HostConfig.Privileged = true; }, v => { v.HostConfig.ReadonlyRootfs = false; },
    v => { v.HostConfig.CapDrop = []; }, v => { v.HostConfig.CapAdd = ['NET_ADMIN']; }, v => { v.HostConfig.SecurityOpt = []; }, v => { v.HostConfig.NetworkMode = 'host'; },
    v => { v.HostConfig.NanoCpus = 0; }, v => { v.HostConfig.NanoCpus *= 2; }, v => { v.HostConfig.Memory *= 2; }, v => { v.HostConfig.PidsLimit = -1; },
    ...['VolumesFrom', 'Devices', 'DeviceRequests'].map(k => v => { v.HostConfig[k] = ['unexpected']; }),
    ...['PidMode', 'IpcMode', 'UTSMode'].map(k => v => { v.HostConfig[k] = 'host'; }),
    v => { v.HostConfig.CgroupnsMode = 'host'; }, v => { v.HostConfig.RestartPolicy.Name = 'always'; },
    v => { v.HostConfig.Tmpfs['/tmp'] = 'rw,size=256m'; }, v => { v.HostConfig.Tmpfs['/tmp'] = 'rw,nosuid,nodev,noexec,size=512m'; }, v => { v.HostConfig.Tmpfs['/extra'] = 'rw,size=1m'; },
  ];
  // Exercise the actual verifier in one isolated Python process, without paying for
  // an engine process for each single-field mutation (full lifecycle is tested above).
  const values = mutations.map(mutate => { const value = structuredClone(base); mutate(value); assert.throws(() => verifyContainerInspection(record, value)); return value; });
  const library = REMOTE_CONTAINER_ENGINE.slice(0, REMOTE_CONTAINER_ENGINE.lastIndexOf('\n# The error boundary'));
  const corpusFile = join(f.root, 'corpus.json'); await writeFile(corpusFile, JSON.stringify({ plan: { ...record, version: 1 }, values }));
  const script = library + `\ncorpus=json.load(open(${JSON.stringify(corpusFile)}))\nfor value in corpus['values']:\n    try: verify_inspection(corpus['plan'],${JSON.stringify(containerId)},value)\n    except Exception: continue\n    raise RuntimeError('unsafe inspection accepted')\nprint(len(corpus['values']))\n`;
  const result = spawnSync('python3', ['-I', '-S', '-c', script], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.equal(Number(result.stdout), mutations.length);
});

import { ContainerExecutionService } from '../src/main/services/ContainerExecutionService.ts';
import { SessionLaunchCoordinator } from '../src/main/services/SessionLaunchCoordinator.ts';
import { ProviderAccountLaunchService } from '../src/main/services/ProviderAccountLaunchService.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
test('real account/coordinator/container chain uses only the fixed remote helper and persists no credential', async t => {
  const f = await fixture(t); let vaultReads = 0, discovery = 0, remoteKey = sentinel; const calls = [];
  const account = { id: 'remote-account', label: 'Fixture', provider: 'opencode', hostId: 'server-one', binding: { kind: 'api-profile', profileId: 'api' } };
  const api = { id: 'api', name: 'Fixture API', hostId: 'server-one', protocol: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', defaultModel: 'fixture-model', remoteCredential: { kind: 'environment', name: 'FIXTURE_REMOTE_KEY' } };
  const settings = { containerProfiles: [f.profile], remoteHosts: [{ id: 'server-one', label: 'Fixture server', sshHost: 'fixture.invalid', workspaces: [{ localPath: '/fixture/project', remotePath: f.plan.workspace.sourceDirectory }] }], providerAccounts: [account], apiProfiles: [api], requiresSandboxProfiles: [] };
  const rootDirectory = join(f.root, 'local-container-registry');
  const options = { rootDirectory, runner: async (command, args, environment) => {
    calls.push({ command, args, environment }); assert.equal(command, 'ssh');
    const words = JSON.parse(execFileSync('python3', ['-I', '-S', '-c', 'import json,shlex,sys;print(json.dumps(shlex.split(sys.argv[1])))', args.at(-1)], { encoding: 'utf8' }));
    assert.equal(words[0], f.profile.hostPython); assert.deepEqual(words.slice(1, 4), ['-I', '-S', '-c']);
    const code = words[4]; assert.ok([REMOTE_CONTAINER_HOST, REMOTE_CONTAINER_ENGINE].includes(code)); const request = JSON.parse(words[5]);
    if (request.action === 'create-owned') await writeFile(join(f.root, 'inspection.json'), JSON.stringify(inspected(request.plan)));
    const result = f.run(request, remoteKey, code); if (result.status !== 0) throw new Error(result.stderr); return { stdout: result.stdout };
  } };
  const containers = new ContainerExecutionService(() => settings, options);
  const inventoryRow = { id: containerId, name: 'outside', image: 'fixture:existing', state: 'running', status: 'Up' };
  await writeFile(f.controlsFile, JSON.stringify({ inventory: [inventoryRow] }));
  const snapshot = (await containers.inventory())[0];
  assert.equal(snapshot.available, true); assert.equal(snapshot.profiles[0].imageAvailable, true); assert.deepEqual(snapshot.containers, [{ ...inventoryRow, managed: false }]);
  assert.equal(vaultReads, 0); assert.equal(discovery, 0);
  const accounts = new ProviderAccountLaunchService(() => settings, { get generation() { vaultReads++; throw Error('local vault touched'); }, get() { vaultReads++; throw Error('local vault touched'); } }, { discovery: { discover() { discovery++; throw Error('host CLI discovery touched'); } } });
  const coordinator = new SessionLaunchCoordinator(accounts, {}, () => settings, { checkShell: async () => {}, place() { discovery++; throw Error('host CLI discovery touched'); } }, containers);
  const metadata = { id: 'remote-api-session', provider: 'opencode', cwd: '/fixture/project', hostId: 'server-one', accountId: account.id, profile: 'normal', model: 'fixture-model', dataClass: 'D0', isolation: { mode: 'container', profileId: f.profile.id } };
  const prepared = await coordinator.prepare(metadata, false); await prepared.beforeSpawn();
  assert.equal(prepared.process.command, 'ssh'); assert.equal(prepared.process.args[0], '-tt'); assert.match(prepared.process.args.at(-1), /start-owned/);
  assert.equal(vaultReads, 0); assert.equal(discovery, 0); assert.equal(prepared.execution.sourceCwd, '/fixture/project');
  const [entry] = await containers.list(); const persisted = await readFile(join(rootDirectory, entry.id + '.json'), 'utf8'); const record = JSON.parse(persisted);
  assert.equal(record.version, 2); assert.equal(record.environmentDigest, undefined); assert.equal(record.remoteVerification.version, 1);
  assert.ok(!persisted.includes(sentinel)); assert.ok(!JSON.stringify(calls).includes(sentinel)); assert.ok(!JSON.stringify(prepared).includes(sentinel));
  // Recover after restart without the API profile: cleanup needs only its frozen
  // host/engine/workspace verification, not current account configuration.
  settings.apiProfiles = []; settings.providerAccounts = [];
  const recovered = new ContainerExecutionService(() => settings, options); await recovered.cleanup(entry.id);
  assert.equal((await recovered.list())[0].state, 'workspace-retained');
  assert.equal(await readFile(join(prepared.execution.hostWorkspace, 'entry.txt'), 'utf8'), 'baseline\n');
  settings.apiProfiles = [api]; settings.providerAccounts = [account];
  Object.assign(settings, { defaultDataClass: 'D0', pathPolicies: [], maxAccountsPerProviderPerHost: 1, agentBudgets: { maxLocalAgents: 2, maxRemoteAgentsPerHost: 2, maxChildren: 1, maxDepth: 2 } });
  const localSource = join(f.root, 'local-source'); await mkdir(localSource);
  settings.remoteHosts[0].workspaces = [{ localPath: localSource, remotePath: f.plan.workspace.sourceDirectory }];
  const launchMetadata = { ...metadata, cwd: localSource };
  const pty = [];
  const manager = new TerminalManager(() => {}, { get() { throw Error('Host provider CLI discovery touched'); } }, undefined, undefined, false,
    (command, args, options) => { pty.push({ command, args, options }); return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; });
  t.after(() => manager.shutdown()); manager.configureRemoteHosts(id => settings.remoteHosts.find(h => h.id === id) ?? null);
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings)); manager.configureProviderLaunch(new SessionLaunchCoordinator(accounts, {}, () => settings, { checkShell: async () => {}, place() { throw Error('Host discovery touched'); } }, recovered));
  assert.throws(() => manager.create({ ...launchMetadata, dataClass: 'D3', position: { x: 0, y: 0 } }), /class|policy|eligible|permits|handles/i);
  assert.equal(pty.length, 0);
  const launched = manager.create({ ...launchMetadata, position: { x: 0, y: 0 } }); await manager.waitForLaunch(launched.id);
  const current = manager.list().find(s => s.id === launched.id); assert.equal(current.exitCode, null, current.failureDetails);
  assert.equal(pty.length, 1); assert.equal(pty[0].command, 'ssh'); assert.match(pty[0].args.at(-1), /start-owned/);
  assert.equal(current.hostId, 'server-one'); assert.equal(current.accountId, account.id); assert.equal(current.model, 'fixture-model');
  assert.equal(vaultReads, 0); assert.equal(discovery, 0); assert.ok(!JSON.stringify(pty).includes(sentinel));
  remoteKey = '';
  const failed = manager.create({ ...launchMetadata, position: { x: 0, y: 0 } }); await manager.waitForLaunch(failed.id);
  assert.match(manager.list().find(s => s.id === failed.id).failureDetails, /verification failed/);
  assert.equal(pty.length, 1, 'missing host key cannot create a second PTY');
  const retained = await recovered.list(); assert.equal(retained.filter(r => r.state === 'created').length, 1); assert.equal(retained.filter(r => r.state === 'cleanup-needed').length, 0);
  await manager.shutdown();
});

test('actual Podman helper verifies native endpoint, private env and nonrecursive zero-capability recipe', async t => {
  const f = await fixture(t, 'podman'); const created = f.create(); assert.equal(created.status, 0, created.stderr);
  const original = JSON.parse(await readFile(f.stateFile, 'utf8'));
  for (const mutate of [v => { v.EffectiveCaps = ['CAP_SYS_ADMIN']; }, v => { v.BoundingCaps = ['CAP_CHOWN']; }, v => { v.Mounts[0].Options = ['rbind']; }, v => { v.HostConfig.CgroupMode = 'host'; }]) {
    const value = structuredClone(original); mutate(value); await writeFile(f.controlsFile, JSON.stringify({ inspection: value }));
    assert.equal(f.run({ ...f.request('inspect-owned'), containerId }).status, 78);
    assert.throws(() => verifyContainerInspection({ ...f.plan, containerId, environmentDigest: hash([...original.Config.Env].sort()) }, value));
  }
  await writeFile(f.controlsFile, '{}'); assert.equal(f.run({ ...f.request('cleanup-owned'), containerId }, '').status, 0);
  const calls = (await readFile(f.logFile, 'utf8')).trim().split('\n').map(JSON.parse); const args = calls.find(c => c.args.includes('create')).args;
  for (const expected of ['--http-proxy=false', '--unsetenv-all', '--read-only-tmpfs=false', '--userns=keep-id', '--image-volume=ignore']) assert.ok(args.includes(expected));
  assert.ok(args.some(a => a.includes('bind-nonrecursive')));
});

test('actual credential reader rejects unsafe file shapes and permits only the documented single newline', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-credential-reader-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const library = REMOTE_CONTAINER_ENGINE.slice(0, REMOTE_CONTAINER_ENGINE.lastIndexOf('\n# The error boundary'));
  const script = library + `
root=${JSON.stringify(root)}
# Test-only accommodation: the test fixture is below the OS shared temporary
# directory. Remove writable bits only from ancestors OUTSIDE the fixture. All
# actual fixture directories/files, links, descriptor opens and fstat checks run.
ancestor_ids=set(); parent=os.path.dirname(root)
while True:
    st=os.stat(parent); ancestor_ids.add((st.st_dev,st.st_ino))
    if parent=='/': break
    parent=os.path.dirname(parent)
original_fstat=os.fstat
def fixture_fstat(fd):
    st=original_fstat(fd)
    if (st.st_dev,st.st_ino) in ancestor_ids:
        values=list(st); values[0]=st.st_mode & ~0o022; return os.stat_result(values)
    return st
os.fstat=fixture_fstat
workspace={'sourceDirectory':root+'/source','directory':root+'/workspace'}
os.mkdir(workspace['sourceDirectory']); os.mkdir(workspace['directory'])
private=root+'/private'; os.mkdir(private,0o700)
path=private+'/key'
def write_key(value,mode=0o600):
    if os.path.lexists(path): os.unlink(path)
    fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,mode)
    os.write(fd,value); os.close(fd)
def read_key(selected=path): return credential({'kind':'key-file','path':selected},workspace)
checks=0
def denied(fn):
    global checks
    try: fn()
    except Exception: checks+=1; return
    raise RuntimeError('unsafe credential accepted')
for value in [b'key',b'key\\n',b'key\\r\\n']:
    write_key(value); require(read_key()=='key'); checks+=1
for value in [b'',b' ',b'x'*16385,b'key\\n\\n',b'key\\r',b'key\\x00',b'key\\t',b'key\\nother',b'\\xff']:
    write_key(value); denied(read_key)
write_key(b'key',0o644); denied(read_key)
write_key(b'key'); os.link(path,private+'/hardlink'); denied(read_key); os.unlink(private+'/hardlink')
os.rename(path,private+'/target'); os.symlink(private+'/target',path); denied(read_key)
os.unlink(path); os.mkfifo(path,0o600); denied(read_key); os.unlink(path)
os.mkdir(path,0o700); denied(read_key); os.rmdir(path)
write_key(b'key'); os.chmod(private,0o777); denied(read_key); os.chmod(private,0o700)
os.symlink(private,root+'/alias'); denied(lambda:read_key(root+'/alias/key'))
denied(lambda:read_key(private+'/../private/key')); denied(lambda:read_key(private+'//key'))
for where in workspace.values():
    with open(where+'/key','w') as out: out.write('key')
    os.chmod(where+'/key',0o600); denied(lambda:read_key(where+'/key'))
original=os.fstat
def wrong_owner(fd):
    st=original(fd)
    if stat.S_ISREG(st.st_mode):
        values=list(st); values[4]=st.st_uid+1; return os.stat_result(values)
    return st
os.fstat=wrong_owner; denied(read_key); os.fstat=original
for value in ['', ' ', 'key\\n', 'key\\x00', 'x'*16385]:
    os.environ['FIXTURE_KEY']=value; denied(lambda:credential({'kind':'environment','name':'FIXTURE_KEY'},workspace))
for name in ['PATH','DOCKER_HOST','PYTHONPATH','LD_PRELOAD','SHELLOPTS','TMP']:
    denied(lambda:credential({'kind':'environment','name':name},workspace))
print(checks)
`;
  // NUL cannot be put in a real process environment; exercise that string through
  // the reader's environment mapping, while preserving the real file operations.
  const safeScript = script.replace("os.environ['FIXTURE_KEY']=value;", "os.environ={'FIXTURE_KEY':value};");
  const result = spawnSync('python3', ['-I', '-S', '-c', safeScript], { encoding: 'utf8', timeout: 10_000 }); assert.equal(result.status, 0, result.stderr); assert.ok(Number(result.stdout) >= 30);
});

test('actual helper recovers lost create ID by verified name, and retains output on corrupt ownership records', async t => {
  const f = await fixture(t); assert.equal(f.create().status, 0);
  const manifestPath = join(f.home, '.local/share/canvastty-container-workspaces/engine-generations', f.plan.id + '.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); delete manifest.containerId; await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const recovered = f.run(f.request('inspect-owned'), ''); assert.equal(recovered.status, 0, recovered.stderr); assert.equal(JSON.parse(recovered.stdout).containerId, containerId);
  const restored = await readFile(manifestPath, 'utf8'); assert.equal(JSON.parse(restored).containerId, containerId);
  for (const broken of ['{}', '{not-json', JSON.stringify({ ...JSON.parse(restored), planDigest: 'f'.repeat(64) })]) {
    await writeFile(manifestPath, broken); const result = f.run({ ...f.request('cleanup-owned'), containerId }, ''); assert.equal(result.status, 78);
    assert.ok(await readFile(f.stateFile, 'utf8'));
  }
  await writeFile(manifestPath, restored); assert.equal(f.run({ ...f.request('cleanup-owned'), containerId }, '').status, 0);
});

test('legacy v1 remote shell recovery remains compatible and uses sanitized inspection', async t => {
  const f = await fixture(t);
  const created = f.run({ ...f.request('create-owned'), environment: { CANVASTTY_CONTAINER_RECIPE: JSON.stringify({ command: '/bin/sh', args: [] }) } }); assert.equal(created.status, 0, created.stderr);
  const state = JSON.parse(await readFile(f.stateFile, 'utf8')); assert.ok(!state.Config.Env.some(e => e.startsWith('CANVASTTY_PROFILE_API_KEY=')));
  const rootDirectory = join(f.root, 'legacy-registry'); await mkdir(rootDirectory, { mode: 0o700 }); await writeFile(join(rootDirectory, 'owner'), f.plan.installation, { mode: 0o600 });
  const host = { id: f.profile.hostId, label: 'Fixture server', sshHost: 'fixture.invalid' };
  const identity = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const record = { ...f.plan, version: 1, profileId: f.profile.id, hostId: f.profile.hostId, workspaceId: f.plan.workspace.id, containerId, createdAt: Date.now(), state: 'cleanup-needed', leaseId: randomUUID(), markerToken: randomUUID(), environmentDigest: identity([...state.Config.Env].sort()), hostFingerprint: identity(host), endpoint: { ...f.endpoint, hostFingerprint: identity(host) } };
  const marker = '.canvastty-container-' + record.id;
  assert.equal(f.run({ action: 'marker-write', source: record.workspace.sourceDirectory, id: record.workspaceId, name: marker, token: record.markerToken }, '', REMOTE_CONTAINER_HOST).status, 0);
  await rm(join(f.home, '.local/share/canvastty-container-workspaces/engine-generations', record.id + '.json'));
  await writeFile(join(rootDirectory, record.id + '.json'), JSON.stringify(record), { mode: 0o600 });
  const calls = [];
  const service = new ContainerExecutionService(() => ({ containerProfiles: [f.profile], remoteHosts: [host] }), { rootDirectory, runner: async (_command, args) => {
    const words = JSON.parse(execFileSync('python3', ['-I', '-S', '-c', 'import json,shlex,sys;print(json.dumps(shlex.split(sys.argv[1])))', args.at(-1)], { encoding: 'utf8' }));
    const request = JSON.parse(words.at(-1)); calls.push(request.action); const result = f.run(request, '', words[4]); if (result.status) throw Error(result.stderr); return { stdout: result.stdout };
  } });
  await service.cleanup(record.id); assert.equal((await service.list())[0].state, 'workspace-retained'); assert.ok(calls.includes('cleanup-owned'));
  assert.equal(await readFile(join(record.workspace.directory, 'entry.txt'), 'utf8'), 'baseline\n');
});

test('lost create stdout leaves a recoverable host verifier without rereading the source key', async t => {
  const f = await fixture(t); await writeFile(f.controlsFile, JSON.stringify({ lostCreate: true }));
  const failed = f.create(); assert.equal(failed.status, 78); assert.equal(failed.stdout, '');
  const path = join(f.home, '.local/share/canvastty-container-workspaces/engine-generations', f.plan.id + '.json');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).containerId, undefined);
  await writeFile(f.controlsFile, '{}'); const cleaned = f.run(f.request('cleanup-owned'), ''); assert.equal(cleaned.status, 0, cleaned.stderr); assert.equal(JSON.parse(cleaned.stdout).removed, true);
});

import { spawn } from 'node:child_process';
test('host generation lock serializes another SSH cleanup behind unfinished host work', async t => {
  const f = await fixture(t); assert.equal(f.create().status, 0);
  const lockPath = join(f.home, '.local/share/canvastty-container-workspaces/engine-generations', f.plan.id + '.json.lock');
  const child = spawn('python3', ['-I', '-S', '-c', 'import os,sys,fcntl,time;fd=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX);print("locked",flush=True);time.sleep(0.6);os.close(fd)', lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(Error('Fixture lock holder exited')); }); });
  const began = Date.now(); const cleaned = f.run({ ...f.request('cleanup-owned'), containerId }, '');
  assert.equal(cleaned.status, 0, cleaned.stderr); assert.ok(Date.now() - began >= 500, 'helper cleanup bypassed generation lock');
  const calls = (await readFile(f.logFile, 'utf8')).trim().split('\n').map(JSON.parse); assert.deepEqual(calls.filter(c => c.args.includes('rm')).map(c => c.args.at(-1)), [containerId]);
});

test('invalid source credential can release its generation after the host proves create was never dispatched', async t => {
  const f = await fixture(t);
  const failed = f.run({ ...f.request('create-owned'), environment: { CANVASTTY_CONTAINER_RECIPE: '{}' }, credential: { kind: 'environment', name: 'FIXTURE_REMOTE_KEY' } }, '');
  assert.equal(failed.status, 78);
  const cleaned = f.run(f.request('cleanup-owned'), ''); assert.equal(cleaned.status, 0, cleaned.stderr); assert.equal(JSON.parse(cleaned.stdout).removed, true); assert.equal(JSON.parse(cleaned.stdout).containerId, null);
  const calls = (await readFile(f.logFile, 'utf8')).trim().split('\n').map(JSON.parse); assert.ok(!calls.some(c => c.args.includes('create') || c.args.includes('rm')));
  assert.equal(await readFile(join(f.plan.workspace.directory, 'entry.txt'), 'utf8'), 'baseline\n');
});

test('bounded engine capture terminates a descendant holding pipes after its parent exits', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-engine-capture-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'owned-child.pid');
  const library = REMOTE_CONTAINER_ENGINE.slice(0, REMOTE_CONTAINER_ENGINE.lastIndexOf('\n# The error boundary'));
  const child = `import subprocess,sys; p=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(8)']); open(${JSON.stringify(marker)},'w').write(str(p.pid))`;
  const script = library + `
try:
    try: capture([sys.executable,'-I','-S','-c',${JSON.stringify(child)}],{},timeout=0.3)
    except Exception: pass
    else: raise RuntimeError('capture did not enforce its deadline')
    pid=int(open(${JSON.stringify(marker)}).read())
    time.sleep(0.1)
    observed=subprocess.run(['/bin/ps','-o','stat=','-p',str(pid)],capture_output=True,text=True).stdout.strip()
    require(not observed or observed.startswith('Z'))
    print('bounded')
finally:
    if os.path.exists(${JSON.stringify(marker)}):
        try: os.kill(int(open(${JSON.stringify(marker)}).read()),signal.SIGKILL)
        except ProcessLookupError: pass
`;
  const result = spawnSync('python3', ['-I', '-S', '-c', script], { encoding: 'utf8', timeout: 10_000 }); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'bounded');
});

test('cleanup can retry after its successful response was lost without keeping HMAC material', async t => {
  const f = await fixture(t); assert.equal(f.create().status, 0);
  assert.equal(f.run({ ...f.request('cleanup-owned'), containerId }, '').status, 0);
  const retried = f.run({ ...f.request('cleanup-owned'), containerId }, ''); assert.equal(retried.status, 0, retried.stderr); assert.equal(JSON.parse(retried.stdout).removed, true);
});

for (const runtime of ['docker', 'podman']) test(`actual ${runtime} remote helper projects only bounded inventory and cannot mutate unknown containers`, async t => {
  const f = await fixture(t, runtime);
  const row = { id: containerId, name: runtime === 'podman' ? ['outside'] : 'outside', image: 'fixture:existing', state: 'running', status: 'Up 1 minute' };
  await writeFile(f.controlsFile, JSON.stringify({ inventory: [row] }));
  const request = { version: 1, action: 'inventory', profile: f.profile, endpoint: f.endpoint, engineIdentity: f.plan.engine.identity };
  let result = f.run(request); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { rows: [{ ...row, name: 'outside' }], truncated: false });
  let calls = (await readFile(f.logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 3); assert.deepEqual(calls[1].args.slice(0, 7), ['container', 'ls', '--all', '--no-trunc', '--last', '65', '--format']);
  assert.equal(calls[0].hasKey, false); assert.equal(calls[0].environmentNames.includes('FIXTURE_REMOTE_KEY'), false);
  for (const bad of [{ ...row, command: sentinel }, { ...row, id: 'short' }, { ...row, status: '\u001b[0m' }, { ...row, image: 'x'.repeat(513) }]) {
    await writeFile(f.controlsFile, JSON.stringify({ inventory: [bad] })); result = f.run(request); assert.equal(result.status, 78); assert.equal(result.stdout, '');
  }
  await writeFile(f.controlsFile, JSON.stringify({ inventory: Array.from({ length: 65 }, (_, i) => ({ ...row, id: i.toString(16).padStart(64, '0') })) }));
  result = f.run(request); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).rows.length, 64); assert.equal(JSON.parse(result.stdout).truncated, true);
  assert.equal(f.run({ ...request, engineIdentity: 'f'.repeat(64) }).status, 78);
  assert.equal(f.run({ ...request, credential: { kind: 'environment', name: 'FIXTURE_REMOTE_KEY' } }).status, 78);
  assert.equal(f.run({ ...request, endpoint: { ...f.endpoint, executableIdentity: 'changed' } }).status, 78);
  calls = (await readFile(f.logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.every(call => call.args[0] === 'info' || call.args[0] === 'container' && call.args[1] === 'ls'), true);
});
