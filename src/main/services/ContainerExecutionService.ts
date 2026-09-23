import { ProbeLimiter } from "./RemoteProbeCache.ts";
import { remoteContainerCommand, remoteHostHelperArguments } from "./RemoteContainerHost.ts";
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AppSettings, ContainerAvailability, ContainerProfile, RetainedContainer, SessionMetadata } from '../../shared/contracts.ts';
import { assertContainerProfile } from '../../shared/containerProfiles.ts';
import { CONTAINER_BOOTSTRAP } from './ContainerBootstrap.ts';
import { resolveTerminalLaunch } from './terminalLaunch.ts';
import type { PreparedProviderAccountLaunch } from './ProviderAccountLaunchService.ts';
import type { IsolatedWorktree } from './WorktreeService.ts';

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const MAX_RECORDS = 512;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const imageId = (value: unknown): string => { if (typeof value !== 'string' || !HEX.test(value.replace(/^sha256:/u, ''))) throw new Error('Engine returned an invalid image identity.'); return `sha256:${value.replace(/^sha256:/u, '')}`; };
interface Endpoint { hostFingerprint?: string; configDirectory?: string; home?: string; executable: string; socket?: string; executableIdentity: string }
interface Engine { identity: string; rootless: boolean; name: string }
interface Image { id: string; environmentNames: string[] }
interface ContainerWorkspace extends IsolatedWorktree { uid?: number; gid?: number }
interface RecordEntry extends RetainedContainer {
  version: 1; installation: string; profile: ContainerProfile; endpoint: Endpoint; engine: Engine; image: Image;
  name: string; labels: Record<string, string>; workspace: IsolatedWorktree; sessionId: string; createdAt: number;
  user: string; bootstrap: string; hostFingerprint?: string; leaseId: string; markerToken: string; environmentDigest: string;
  /** Durable uncertainty: a failed client can leave a create request running in the daemon. */
  createRequested?: boolean;
}
export type ContainerRunner = (command: string, args: string[], environment: Record<string, string>) => Promise<{ stdout: string }>;
interface Options { rootDirectory: string; runner?: ContainerRunner; resolveEndpoint?: (profile: ContainerProfile) => Promise<Endpoint>; onWorkspaceStopped?: (workspaceId: string, leaseId: string) => Promise<void> }
function object(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid engine response.'); return value as Record<string, any>; }
function engineJson(raw: string): unknown { try { return JSON.parse(raw); } catch { throw new Error("Container engine returned invalid JSON; response content is withheld."); } }
function one(raw: string): Record<string, any> { const value = engineJson(raw); if (!Array.isArray(value) || value.length !== 1) throw new Error('Expected exactly one owned engine object.'); return object(value[0]); }
function safeEnvironment(): Record<string, string> {
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}
export function parseEngineInfo(profile: ContainerProfile, input: unknown): Engine {
  const data = object(input); let rootless: boolean; let identity: unknown; let name: string;
  if (profile.runtime === 'docker') {
    rootless = Array.isArray(data.SecurityOptions) && data.SecurityOptions.includes('name=rootless');
    if (data.OSType !== 'linux' || data.CgroupVersion !== '2' || data.CpuCfsPeriod !== true || data.CpuCfsQuota !== true || data.MemoryLimit !== true || data.PidsLimit !== true) throw new Error('Container CPU, memory and PID limits require verified Linux cgroup v2 support.');
    if (rootless && data.CgroupDriver !== 'systemd') throw new Error('Rootless Docker limits require systemd delegation.');
    if (!data.ID || typeof data.ID !== 'string' || !data.Name || !data.DockerRootDir) throw new Error('Docker did not identify its daemon.');
    if (Array.isArray(data.SecurityOptions) && data.SecurityOptions.some((s: unknown) => typeof s === 'string' && s.includes('userns'))) throw new Error('Rootful Docker user namespace remapping needs a separately verified workspace recipe.');
    name = data.Name; identity = [data.ID, data.Name, data.DockerRootDir, rootless];
  } else {
    const host = object(data.host), store = object(data.store), security = object(host.security);
    rootless = security.rootless === true;
    if (host.os !== 'linux' || host.cgroupVersion !== 'v2' || !Array.isArray(host.cgroupControllers) || ['cpu', 'memory', 'pids'].some(c => !host.cgroupControllers.includes(c))) throw new Error('Podman CPU, memory and PID limits require delegated cgroup v2 controllers.');
    if (typeof host.hostname !== 'string' || typeof store.graphRoot !== 'string' || typeof store.runRoot !== 'string') throw new Error('Podman did not identify its host and storage.');
    name = host.hostname; identity = [name, store.graphRoot, store.runRoot, rootless];
  }
  return { identity: hash(identity), rootless, name: String(name).slice(0, 200) };
}
function parseImage(raw: string): Image {
  const value = one(raw); const config = object(value.Config ?? {});
  if (value.Os !== 'linux' || !value.Architecture || (config.Volumes && Object.keys(object(config.Volumes)).length)) throw new Error('Image must be an existing Linux image without declared writable volumes.');
  const env = config.Env ?? [];
  if (!Array.isArray(env) || env.length > 512) throw new Error('Image environment exceeds its bound.');
  const names = env.map((entry: unknown) => { if (typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(entry)) throw new Error('Invalid image environment.'); return entry.split('=', 1)[0]!; });
  return { id: imageId(value.Id), environmentNames: [...new Set<string>(names)] };
}
export function buildContainerCreateArguments(record: RecordEntry, environmentNames: string[]): string[] {
  const p = record.profile;
  const mount = `type=bind,src=${record.workspace.directory},dst=/workspace,readonly=false,${p.runtime === 'docker' ? 'bind-recursive=disabled' : 'bind-nonrecursive'},bind-propagation=rprivate`;
  return ['container', 'create', '--name', record.name, ...Object.entries(record.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    '--interactive', '--tty', '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--network=${p.network}`,
    `--cpus=${p.cpus}`, `--memory=${p.memoryMb}m`, `--pids-limit=${p.pids}`, '--cgroupns=private', '--restart=no', '--stop-signal=SIGTERM', '--log-driver=none',
    `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777${p.runtime === 'podman' ? ',notmpcopyup' : ''}`, '--workdir=/workspace', `--mount=${mount}`, '--entrypoint', p.python,
    ...(p.runtime === 'docker' ? ['--no-healthcheck', ...record.image.environmentNames.filter(name => !environmentNames.includes(name)).map(name => `--env=${name}`)] : ['--health-cmd=none', '--image-volume=ignore', '--http-proxy=false', '--unsetenv-all', '--read-only-tmpfs=false', '--systemd=false', '--sdnotify=ignore']),
    ...(record.user === 'keep-id' ? ['--userns=keep-id'] : [`--user=${record.user}`]), ...environmentNames.map(name => `--env=${name}`), '--env=HOME=/tmp', '--env=PATH=/usr/local/bin:/usr/bin:/bin', '--env=TERM=xterm-256color', '--env=LANG=C.UTF-8', record.image.id, '-I', '-S', '-c', CONTAINER_BOOTSTRAP];
}
export function verifyContainerInspection(record: RecordEntry, input: unknown): { running: boolean } {
  const v = object(input), c = object(v.Config), h = object(v.HostConfig), state = object(v.State);
  const p = record.profile;
  if (v.Id !== record.containerId || String(v.Name).replace(/^\//u, '') !== record.name || imageId(v.Image) !== record.image.id ||
    Object.entries(record.labels).some(([key, value]) => c.Labels?.[key] !== value) || c.WorkingDir !== '/workspace' ||
    (record.user !== 'keep-id' && c.User !== record.user) || v.Path !== p.python || JSON.stringify(v.Args) !== JSON.stringify(['-I', '-S', '-c', CONTAINER_BOOTSTRAP]) || c.Tty !== true || c.OpenStdin !== true) throw new Error('Owned container identity or entrypoint changed; retained without cleanup permission.');
  const processEnvironment = c.Env;
  const allowedEnvironment = new Set(['HOME', 'PATH', 'TERM', 'LANG', 'CANVASTTY_CONTAINER_RECIPE', 'CANVASTTY_PROFILE_API_KEY', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'HOSTNAME', 'container']);
  if (!Array.isArray(processEnvironment) || processEnvironment.length > 16 || processEnvironment.some((entry: unknown) => typeof entry !== 'string' || !allowedEnvironment.has(entry.split('=', 1)[0]!)) || hash(processEnvironment.filter((entry: string) => !entry.startsWith('HOSTNAME=') && !entry.startsWith('container=')).sort()) !== record.environmentDigest) throw new Error('Container environment differs from its scoped launch recipe.');
  if (c.Healthcheck && JSON.stringify(c.Healthcheck.Test) !== JSON.stringify(['NONE']) || c.StartupHealthCheck || c.Secrets && (!Array.isArray(c.Secrets) || c.Secrets.length)) throw new Error('Container image healthchecks or implicit secrets are not disabled.');
  if (h.LogConfig?.Type !== 'none' || h.Init === true) throw new Error('Container logging or implicit init mount differs from the fixed recipe.');
  if (!Array.isArray(v.Mounts)) throw new Error('Container mount inspection is unavailable.');
  const binds = v.Mounts.filter((m: any) => m.Type !== 'tmpfs');
  if (binds.length !== 1 || binds[0].Type !== 'bind' || binds[0].Source !== record.workspace.directory || binds[0].Destination !== '/workspace' || binds[0].RW !== true || binds[0].Propagation !== 'rprivate') throw new Error('Container workspace mount differs from its owned workspace.');
  if (p.runtime === 'docker' && (!Array.isArray(h.Mounts) || h.Mounts.length !== 1 || h.Mounts[0]?.BindOptions?.NonRecursive !== true)) throw new Error('Nonrecursive workspace bind was not enforced.');
  const cpus = typeof h.NanoCpus === 'number' && h.NanoCpus > 0 ? h.NanoCpus / 1e9 : typeof h.CpuQuota === 'number' && typeof h.CpuPeriod === 'number' && h.CpuPeriod > 0 ? h.CpuQuota / h.CpuPeriod : NaN;
  const empty = (value: unknown): boolean => value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0;
  const zeroCaps = (value: unknown): boolean => value === null || Array.isArray(value) && value.length === 0;
  const capsDropped = p.runtime === 'docker' ? Array.isArray(h.CapDrop) && h.CapDrop.some((cap: unknown) => cap === 'ALL' || cap === 'all') : zeroCaps(v.EffectiveCaps) && zeroCaps(v.BoundingCaps);
  if (p.runtime === 'podman' && (!Array.isArray(binds[0].Options) || !binds[0].Options.includes('bind') || binds[0].Options.includes('rbind'))) throw new Error('Podman nonrecursive workspace bind was not applied.');
  if (h.Privileged !== false || h.ReadonlyRootfs !== true || !capsDropped || !empty(h.CapAdd) ||
    !Array.isArray(h.SecurityOpt) || !h.SecurityOpt.some((s: unknown) => s === 'no-new-privileges' || s === 'no-new-privileges=true') || h.NetworkMode !== p.network ||
    !Number.isFinite(cpus) || cpus <= 0 || cpus > p.cpus + 0.000001 || !Number.isFinite(h.Memory) || h.Memory <= 0 || h.Memory > p.memoryMb * 1048576 || !Number.isInteger(h.PidsLimit) || h.PidsLimit <= 0 || h.PidsLimit > p.pids ||
    !empty(h.VolumesFrom) || !empty(h.Devices) || !empty(h.DeviceRequests) || h.PidMode === 'host' || h.IpcMode === 'host' || h.UTSMode === 'host' || (p.runtime === 'docker' ? h.CgroupnsMode : h.CgroupMode) !== 'private' || h.RestartPolicy?.Name !== 'no') throw new Error('Container restrictions or hard resource limits were not applied.');
  const tmpOptions = typeof h.Tmpfs?.['/tmp'] === 'string' ? h.Tmpfs['/tmp'].split(',') as string[] : [];
  const size = tmpOptions.find(option => option.startsWith('size='))?.match(/^size=(\d+)([kmg]?)$/iu);
  const tmpBytes = size ? Number(size[1]) * ({ '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[size[2]!.toLowerCase()] ?? NaN) : NaN;
  if (!h.Tmpfs || Object.keys(h.Tmpfs).length !== 1 || !Number.isFinite(tmpBytes) || tmpBytes <= 0 || tmpBytes > 256 * 1024 ** 2 || !['noexec', 'nosuid', 'nodev'].every(flag => tmpOptions.includes(flag))) throw new Error('Container private temporary filesystem was not applied.');
  return { running: state.Running === true };
}

/** On-demand engine lifecycle; no context discovery, image pull, VM startup or ambient credential mounts. */
export class ContainerExecutionService {
  private readonly settings: () => Pick<AppSettings, 'containerProfiles' | 'remoteHosts'>;
  private readonly options: Options;
  private readonly runner: ContainerRunner;
  private initialized?: Promise<void>;
  private readonly limiter = new ProbeLimiter();
  private installation = '';
  private records = new Map<string, RecordEntry>();
  private readonly remoteReservations = new Map<string, string>();
  private readonly preparing = new Map<string, { cancelled: boolean; settled: Promise<void> }>();
  private busy = new Map<string, Promise<void>>();
  constructor(settings: () => Pick<AppSettings, 'containerProfiles' | 'remoteHosts'>, options: Options) {
    this.settings = settings; this.options = options;
    this.runner = options.runner ?? (async (command, args, env) => { const r = await exec(command, args, { env, timeout: 20_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }); return { stdout: r.stdout }; });
  }
  profile(id: string): ContainerProfile { const p = this.settings().containerProfiles?.find(item => item.id === id); if (!p) throw new Error('Selected container profile is no longer configured.'); assertContainerProfile(p); return structuredClone(p); }
  private async endpoint(profile: ContainerProfile): Promise<Endpoint> {
    if (this.options.resolveEndpoint) return this.options.resolveEndpoint(profile);
    if (profile.hostId !== 'local') {
      const hostFingerprint = hash(this.host(profile));
      const result = await this.remoteHelper(profile, { action: 'endpoint', profile });
      if (hash(this.host(profile)) !== hostFingerprint || typeof result.executable !== 'string' || !result.executable.startsWith('/') || typeof result.executableIdentity !== 'string' || typeof result.home !== 'string' || typeof result.configDirectory !== 'string' || (profile.endpoint.kind === 'unix' && typeof result.socket !== 'string')) throw new Error('Remote engine endpoint identity changed or is invalid.');
      return { ...result, hostFingerprint };
    }
    if (profile.endpoint.kind === 'native' && process.platform !== 'linux') throw new Error('Native Podman is supported on Linux. Select the UNIX socket of an already running Podman machine on this computer.');
    const executable = await realpath(profile.executable); const file = await lstat(executable);
    if (!file.isFile() || !(file.mode & 0o111)) throw new Error('Container engine executable is unavailable.');
    let socket: string | undefined;
    if (profile.endpoint.kind === 'unix') { socket = await realpath(profile.endpoint.socket); if (!(await lstat(socket)).isSocket()) throw new Error('The configured engine endpoint is not a running UNIX socket.'); }
    return { executable, socket, executableIdentity: hash([executable, file.dev, file.ino, file.mtimeMs, file.size]) };
  }
  private args(p: ContainerProfile, endpoint: Endpoint, words: string[]): string[] {
    return p.runtime === 'docker' ? ['--config', endpoint.configDirectory ?? join(this.options.rootDirectory, 'engine-config'), '--host', `unix://${endpoint.socket}`, ...words]
      : [...(endpoint.socket ? ['--remote=true', '--url', `unix://${endpoint.socket}`] : ['--remote=false']), ...words];
  }
  private async run(p: ContainerProfile, endpoint: Endpoint, words: string[], values: Record<string, string> = {}, active: () => void = () => {}): Promise<string> {
    try {
      if (p.hostId !== 'local' && endpoint.hostFingerprint !== hash(this.host(p))) throw new Error('Remote host changed.');
      const args = this.args(p, endpoint, words);
      const launch = p.hostId === 'local' ? { command: endpoint.executable, args } : remoteContainerCommand(this.host(p), '/usr/bin/env', ['-i', `HOME=${endpoint.home}`, 'PATH=/usr/local/bin:/usr/bin:/bin', ...Object.entries(values).map(([key, value]) => `${key}=${value}`), endpoint.executable, ...args]);
      const result = await this.limiter.run(() => { active(); if (p.hostId !== 'local' && endpoint.hostFingerprint !== hash(this.host(p))) throw new Error('Remote host changed.'); return this.runner(launch.command, launch.args, p.hostId === 'local' ? { ...safeEnvironment(), ...values } : safeEnvironment()); }); if (Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) throw new Error(); return result.stdout; }
    catch { throw new Error('Selected container engine operation failed or timed out. Check the saved endpoint and existing image; diagnostic output is withheld to protect credentials.'); }
  }
  private async engine(p: ContainerProfile, endpoint: Endpoint): Promise<Engine> { return parseEngineInfo(p, engineJson(await this.run(p, endpoint, p.runtime === 'docker' ? ['info', '--format', '{{json .}}'] : ['info', '--format=json']))); }
  private async verifyEngine(record: RecordEntry): Promise<void> {
    if (hash(this.profile(record.profileId)) !== hash(record.profile)) throw new Error('Container profile changed; restore its saved endpoint before cleanup.');
    if (record.hostId !== 'local' && hash(this.host(record.profile)) !== record.hostFingerprint) throw new Error('Remote execution host changed; container cleanup retained.');
    const endpoint = await this.endpoint(record.profile);
    if (hash(endpoint) !== hash(record.endpoint) || (await this.engine(record.profile, endpoint)).identity !== record.engine.identity) throw new Error('Container engine identity changed; retained without fallback.');
  }
  async probe(profileId: string): Promise<ContainerAvailability> {
    const p = this.profile(profileId);
    try { await this.initialize(); const endpoint = await this.endpoint(p); const engine = await this.engine(p, endpoint); const image = parseImage(await this.run(p, endpoint, ['image', 'inspect', p.image])); return { available: true, runtime: p.runtime, rootless: engine.rootless, imageId: image.id }; }
    catch (error) { return { available: false, runtime: p.runtime, reason: error instanceof Error ? error.message : 'Container profile unavailable.' }; }
  }
  async prepare(metadata: SessionMetadata, workspace: ContainerWorkspace, account: Pick<PreparedProviderAccountLaunch, 'args' | 'environment' | 'model' | 'containerRecipe'>, active: () => void = () => {}, leaseId = randomUUID(), executionCwd = '/workspace'): Promise<Pick<PreparedProviderAccountLaunch, 'process' | 'cleanup' | 'assertCurrent' | 'beforeSpawn'>> {
    if (metadata.isolation?.mode !== 'container') throw new Error('Container profile is required.');
    const p = this.profile(metadata.isolation.profileId);
    if (p.hostId !== (metadata.hostId ?? 'local')) throw new Error('Container profile belongs to another execution host.');
    if (p.hostId !== 'local' && this.remoteReservations.get(workspace.id) !== leaseId) throw new Error('Remote workspace reservation is missing or changed.');
    if (p.hostId !== 'local' && Object.keys(account.environment).length) throw new Error('Remote API credentials need a provisioned remote adapter. Local vault keys are never sent over SSH.');
    const command = p.commands[metadata.provider]; if (!command) throw new Error('Selected image profile has no supported command for this provider.');
    if (metadata.provider !== 'terminal' && p.network !== 'bridge') throw new Error('Cloud API container launch requires an explicitly selected bridge network profile. Bridge permits general outbound access.');
    if (p.hostId === 'local') {
      if (await realpath(workspace.directory) !== workspace.directory || !(await lstat(workspace.directory)).isDirectory() || /[,\x00-\x1f\x7f]/u.test(workspace.directory)) throw new Error('Container needs its canonical owned workspace directory.');
    }
    active(); await this.initialize(); active();
    if (this.records.size >= MAX_RECORDS) throw new Error('Container recovery registry is full. Clean retained containers first.');
    const endpoint = await this.endpoint(p); active(); const engine = await this.engine(p, endpoint); active();
    if (engine.rootless && p.runtime === 'docker' && p.user !== '0:0') throw new Error('Rootless Docker requires explicit container user 0:0 to preserve workspace ownership.');
    if (p.hostId === 'local' && p.runtime === 'docker' && !engine.rootless) {
      const owner = await lstat(workspace.directory);
      if (p.user !== `${owner.uid}:${owner.gid}`) throw new Error('Rootful Docker user must match the owned workspace UID:GID.');
    }
    if (p.hostId !== 'local' && p.runtime === 'docker' && !engine.rootless && (!Number.isInteger(workspace.uid) || !Number.isInteger(workspace.gid) || p.user !== `${workspace.uid}:${workspace.gid}`)) throw new Error('Rootful Docker user must match the remote owned workspace UID:GID.');
    if (p.runtime === 'podman' && p.user !== 'keep-id') throw new Error('Podman workspace execution requires explicit keep-id mapping.');
    const image = parseImage(await this.run(p, endpoint, ['image', 'inspect', p.image])); active();
    const id = randomUUID();
    const record: RecordEntry = { version: 1, installation: this.installation, id, profileId: p.id, hostId: p.hostId, workspaceId: workspace.id, workspace, profile: p, endpoint, engine, image, name: `canvastty-${id}`, labels: { 'io.canvastty.installation': this.installation, 'io.canvastty.session': metadata.id, 'io.canvastty.generation': id, 'io.canvastty.workspace': workspace.id }, sessionId: metadata.id, createdAt: Date.now(), state: 'preparing', leaseId, markerToken: randomUUID(), environmentDigest: '', ...(p.hostId !== 'local' ? { hostFingerprint: hash(this.host(p)) } : {}), user: p.user, bootstrap: CONTAINER_BOOTSTRAP };
    const resolved = metadata.provider === 'terminal' ? { args: [], environment: {} } : resolveTerminalLaunch(metadata.provider, metadata.profile, account.args, { platform: 'linux', environment: account.environment, model: account.model, providerCli: { provider: metadata.provider, state: 'available', executable: command, launcher: 'native', environment: {}, checked: [] } });
    if (!Array.isArray(resolved.args)) throw new Error('Container command requires bounded argv.');
    const environment: Record<string, string> = { ...account.environment, ...resolved.environment, CANVASTTY_CONTAINER_RECIPE: JSON.stringify({ command, args: resolved.args, cwd: executionCwd, marker: { name: `.canvastty-container-${id}`, token: record.markerToken }, limits: { cpus: p.cpus, memoryMb: p.memoryMb, pids: p.pids }, api: account.containerRecipe }) };
    const allowed = new Set(['CANVASTTY_PROFILE_API_KEY', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'CANVASTTY_CONTAINER_RECIPE']);
    if (Object.keys(environment).some(name => !allowed.has(name))) throw new Error('Container launch includes an unsupported host credential or configuration path.');
    if (Buffer.byteLength(JSON.stringify(environment)) > 128 * 1024) throw new Error('Container launch recipe exceeds its bound.');
    record.environmentDigest = hash(Object.entries({ ...environment, HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8' }).map(([name, value]) => `${name}=${value}`).sort());
    let settlePreparation!: () => void;
    const preparation = { cancelled: false, settled: new Promise<void>(resolve => { settlePreparation = resolve; }) };
    let createDispatched = false;
    record.createRequested = false;
    const finishPreparation = (): void => { this.preparing.delete(id); settlePreparation(); };
    const currentGeneration = (): void => {
      active();
      if (preparation.cancelled || this.records.get(id) !== record || record.state === 'cleanup-needed' || record.state === 'workspace-retained') throw new Error('Container launch cancelled by cleanup.');
    };
    this.preparing.set(id, preparation);
    this.records.set(id, record);
    try {
      await this.persist(record);
      currentGeneration(); await this.marker(record, 'write'); currentGeneration(); await this.verifyEngine(record); currentGeneration();
      record.createRequested = true; await this.persist(record);
      const created = (await this.run(p, endpoint, buildContainerCreateArguments(record, Object.keys(environment)), environment, () => { currentGeneration(); createDispatched = true; })).trim();
      if (!HEX.test(created)) throw new Error('Container create did not return its full ID. An owned recovery record is retained.');
      record.containerId = created; await this.persist(record); currentGeneration();
      await this.verifyEngine(record); currentGeneration();
      verifyContainerInspection(record, one(await this.run(p, endpoint, ['container', 'inspect', created])));
      currentGeneration(); record.state = 'created'; await this.persist(record); currentGeneration();
      const startArgs = this.args(p, endpoint, ['container', 'start', '--attach', '--interactive', created]);
      const process = p.hostId === 'local' ? { command: endpoint.executable, args: startArgs } : remoteContainerCommand(this.host(p), '/usr/bin/env', ['-i', `HOME=${endpoint.home}`, 'PATH=/usr/local/bin:/usr/bin:/bin', endpoint.executable, ...startArgs], true);
      return { process: { ...process, cwd: metadata.cwd, environment: safeEnvironment() },
        beforeSpawn: async () => { currentGeneration(); await this.verifyEngine(record); currentGeneration(); verifyContainerInspection(record, one(await this.run(p, endpoint, ['container', 'inspect', created]))); currentGeneration(); },
        assertCurrent: current => { currentGeneration(); if (current.isolation?.mode !== 'container' || current.isolation.profileId !== p.id || (current.hostId ?? 'local') !== p.hostId || hash(this.profile(p.id)) !== hash(p)) throw new Error('Container launch profile changed before spawn.'); }, cleanup: () => this.cleanup(id) };
    } catch (error) {
      if (!createDispatched) record.createRequested = false;
      record.state = 'cleanup-needed'; record.reason = 'Container preparation failed. Owned workspace retained.'; await this.persist(record);
      // Release the preparation fence before joining cleanup: cleanup can already
      // be waiting for this failed preparation, so awaiting the whole prepare deadlocks.
      finishPreparation();
      await this.cleanup(id).catch(() => undefined); throw error;
    } finally { finishPreparation(); }
  }
  async list(): Promise<RetainedContainer[]> { await this.initialize(); return [...this.records.values()].map(({ id, profileId, hostId, workspaceId, containerId, state, reason, workspace }) => ({ id, profileId, hostId, workspaceId, containerId, state, reason, hostWorkspace: workspace.directory })); }
  async cleanup(id: string): Promise<void> {
    await this.initialize(); if (!UUID.test(id)) throw new Error('Invalid container generation.');
    if (this.busy.has(id)) return this.busy.get(id);
    const record = this.records.get(id); if (!record || record.state === 'workspace-retained') return;
    const preparation = this.preparing.get(id);
    if (preparation) preparation.cancelled = true;
    record.state = 'cleanup-needed';
    const task = (async (): Promise<void> => {
      try {
        // A missing engine object proves nothing while create is still pending.
        // Keep the marker, durable record and workspace lease until it settles.
        await preparation?.settled;
        await this.verifyEngine(record);
        const selector = record.containerId ? `id=${record.containerId}` : `name=^${record.name}$`;
        const listed = (await this.run(record.profile, record.endpoint, ['container', 'ls', '--all', '--no-trunc', '--filter', selector, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean);
        if (!listed.length) {
          if (!record.containerId && record.createRequested !== false) throw new Error('Container create outcome is unconfirmed; retain this generation until the daemon outcome is known.');
          await this.finishCleanup(record); return;
        }
        if (listed.length !== 1 || !HEX.test(listed[0]!) || record.containerId && listed[0] !== record.containerId) throw new Error('Owned container lookup is ambiguous; retained.');
        if (!record.containerId) {
          // Locate only our unpredictable name, then validate every ownership field before acting.
          const found = one(await this.run(record.profile, record.endpoint, ['container', 'inspect', record.name]));
          if (typeof found.Id !== 'string' || !HEX.test(found.Id)) throw new Error('Owned container ID could not be recovered.');
          record.containerId = found.Id; await this.persist(record);
        }
        const current = verifyContainerInspection(record, one(await this.run(record.profile, record.endpoint, ['container', 'inspect', record.containerId])));
        if (current.running) { await this.verifyEngine(record); await this.run(record.profile, record.endpoint, ['container', 'stop', '-t', '5', record.containerId]); }
        await this.verifyEngine(record);
        if (verifyContainerInspection(record, one(await this.run(record.profile, record.endpoint, ['container', 'inspect', record.containerId]))).running) throw new Error('Container termination is unconfirmed; retained.');
        await this.run(record.profile, record.endpoint, ['container', 'rm', record.containerId]);
        await this.finishCleanup(record);
      } catch (error) { record.state = 'cleanup-needed'; record.reason = 'Exact owned container cleanup is unconfirmed; retain its workspace and restore the selected engine.'; await this.persist(record); throw error; }
    })(); this.busy.set(id, task); try { await task; } finally { this.busy.delete(id); }
  }
  async blocksWorkspace(id: string): Promise<boolean> { await this.initialize(); return [...this.records.values()].some(r => r.workspaceId === id && r.state !== 'workspace-retained'); }
  async releaseRemoteWorkspace(id: string, leaseId: string): Promise<void> {
    if (this.remoteReservations.get(id) === leaseId && !await this.blocksWorkspace(id)) this.remoteReservations.delete(id);
  }
  private host(p: ContainerProfile) { const host = this.settings().remoteHosts.find(h => h.id === p.hostId); if (!host) throw new Error('Selected remote container host no longer exists.'); return host; }
  private async remoteHelper(p: ContainerProfile, request: Record<string, unknown>): Promise<any> {
    const host = this.host(p); const identity = hash(host);
    const launch = remoteContainerCommand(host, p.hostPython!, remoteHostHelperArguments(p, request));
    try { const result = await this.limiter.run(() => { if (hash(this.host(p)) !== identity) throw new Error(); return this.runner(launch.command, launch.args, safeEnvironment()); }); if (hash(this.host(p)) !== identity || Buffer.byteLength(result.stdout) > 16384) throw new Error(); return object(JSON.parse(result.stdout)); } catch { throw new Error('Remote container host verification failed. No engine, image or VM was started.'); }
  }
  async remoteWorkspace(p: ContainerProfile, source: string, id?: string, leaseId = randomUUID()): Promise<ContainerWorkspace & { executionCwd: string }> {
    await this.initialize();
    if (id) {
      const blocked = await this.blocksWorkspace(id);
      if (blocked || this.remoteReservations.has(id)) throw new Error('Remote workspace already has an active or unconfirmed generation.');
      this.remoteReservations.set(id, leaseId);
    }
    try {
      const value = await this.remoteHelper(p, { action: id ? 'verify' : 'create', source, ...(id ? { id } : {}) });
      if (!UUID.test(value.id) || id && value.id !== id || typeof value.directory !== 'string' || !value.directory.startsWith('/') || /[,\x00-\x1f\x7f]/u.test(value.directory) || typeof value.sourceDirectory !== 'string' || !/^[a-f0-9]{40,64}$/u.test(value.commit) || !Number.isSafeInteger(value.uid) || value.uid < 0 || !Number.isSafeInteger(value.gid) || value.gid < 0) throw new Error('Remote owned workspace response is invalid.');
      if (typeof value.relativeCwd !== 'string' || value.relativeCwd.startsWith('/') || value.relativeCwd.split('/').includes('..')) throw new Error('Invalid remote workspace subdirectory.');
      if (await this.blocksWorkspace(value.id)) throw new Error('A previous container generation still owns this remote workspace. Clean that generation first.');
      if (this.remoteReservations.has(value.id) && this.remoteReservations.get(value.id) !== leaseId) throw new Error('Remote workspace is already reserved.');
      this.remoteReservations.set(value.id, leaseId);
      return { id: value.id, directory: value.directory, sourceDirectory: value.sourceDirectory, commit: value.commit, uid: value.uid, gid: value.gid, executionCwd: value.relativeCwd ? `/workspace/${value.relativeCwd}` : '/workspace' };
    } catch (error) { if (id && this.remoteReservations.get(id) === leaseId) this.remoteReservations.delete(id); throw error; }
  }

  private async marker(record: RecordEntry, action: 'write' | 'remove'): Promise<void> {
    const name = `.canvastty-container-${record.id}`;
    if (record.hostId !== 'local') {
      await this.remoteHelper(record.profile, { action: `marker-${action}`, source: record.workspace.sourceDirectory, id: record.workspaceId, name, token: record.markerToken }); return;
    }
    if (await realpath(record.workspace.directory) !== record.workspace.directory) throw new Error('Owned workspace directory identity changed.');
    const path = join(record.workspace.directory, name);
    if (action === 'write') { await writeFile(path, record.markerToken, { flag: 'wx', mode: 0o600 }); return; }
    let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.nlink !== 1 || info.size > 128 || (await readFile(path, 'utf8')) !== record.markerToken) throw new Error('Container workspace marker changed; output retained.');
    await unlink(path);
  }
  private async finishCleanup(record: RecordEntry): Promise<void> {
    await this.marker(record, 'remove');
    if (record.hostId === 'local') { await this.options.onWorkspaceStopped?.(record.workspaceId, record.leaseId); await unlink(join(this.options.rootDirectory, `${record.id}.json`)); this.records.delete(record.id); }
    else { if (this.remoteReservations.get(record.workspaceId) === record.leaseId) this.remoteReservations.delete(record.workspaceId); record.state = 'workspace-retained'; record.reason = 'Container stopped. Remote workspace retained at its recorded host path; review and export over SSH. Automatic remote workspace deletion is unavailable.'; await this.persist(record); }
  }
  private async initialize(): Promise<void> { return this.initialized ??= this.load(); }
  private async load(): Promise<void> {
    const root = this.options.rootDirectory;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root); if (!rootStat.isDirectory() || await realpath(root) !== root || rootStat.mode & 0o077) throw new Error('Container registry must be a canonical private directory.');
    const privateRead = async (path: string, limit: number): Promise<string> => { const info = await lstat(path); if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > limit) throw new Error('Container recovery record is not private or exceeds its bound.'); return readFile(path, 'utf8'); };
    try { this.installation = (await privateRead(join(root, 'owner'), 128)).trim(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.installation = randomUUID(); await writeFile(join(root, 'owner'), this.installation, { flag: 'wx', mode: 0o600 }); }
    if (!UUID.test(this.installation)) throw new Error('Invalid container installation identity.');
    const entries = await readdir(root); if (entries.length > MAX_RECORDS + 8) throw new Error('Container registry exceeds its recovery bound.');
    for (const name of entries.filter(name => UUID.test(name.replace(/\.json$/u, '')) && name.endsWith('.json'))) {
      const r: RecordEntry = JSON.parse(await privateRead(join(root, name), 64 * 1024));
      assertContainerProfile(r.profile);
      if (r.createRequested !== undefined && typeof r.createRequested !== 'boolean') throw new Error('Container creation recovery state is invalid.');
      if (!HEX.test(r.environmentDigest) || !UUID.test(r.markerToken) || !UUID.test(r.leaseId) || r.version !== 1 || r.installation !== this.installation || `${r.id}.json` !== name || r.profileId !== r.profile.id || r.hostId !== r.profile.hostId || !UUID.test(r.workspaceId) || r.workspace.id !== r.workspaceId || r.containerId !== undefined && !HEX.test(r.containerId) || r.name !== `canvastty-${r.id}` || r.bootstrap !== CONTAINER_BOOTSTRAP || r.labels['io.canvastty.installation'] !== this.installation || r.labels['io.canvastty.generation'] !== r.id || r.labels['io.canvastty.workspace'] !== r.workspaceId || r.labels['io.canvastty.session'] !== r.sessionId) throw new Error('Container recovery identity is invalid; records are retained without cleanup.');
      if (r.state !== 'workspace-retained') { r.state = 'cleanup-needed'; r.reason = 'Recovered generation: inspect and clean its exact owned container before workspace reuse.'; } this.records.set(r.id, r);
    }
    const config = join(root, 'engine-config'); await mkdir(config, { mode: 0o700, recursive: true });
    await writeFile(join(config, 'config.json'), '{}', { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(config)).isDirectory() || await realpath(config) !== config || (await privateRead(join(config, 'config.json'), 10)).trim() !== '{}') throw new Error('Engine configuration directory was modified.');
  }
  private async persist(record: RecordEntry): Promise<void> {
    const path = join(this.options.rootDirectory, `${record.id}.json`), temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); await rename(temporary, path);
  }
}
