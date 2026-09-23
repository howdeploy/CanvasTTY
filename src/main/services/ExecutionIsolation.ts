import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const ISOLATION_MODES = ['direct', 'worktree', 'container'] as const;
export type IsolationMode = typeof ISOLATION_MODES[number];
export type ContainerRuntime = 'podman' | 'docker';
export interface RemoteContainerHost { host: string; user?: string; port?: number }
export interface ContainerLimits { cpus?: number; memoryMb?: number; pids?: number }
export interface ContainerRequest {
  runtime: ContainerRuntime;
  image: string;
  /** Absolute path on the execution host. No credentials or other host directories are mounted. */
  workspace: string;
  command: string;
  args?: string[];
  limits?: ContainerLimits;
  network?: 'none' | 'bridge';
  /** PTY launches default to a container TTY; disable for piped jobs. */
  tty?: boolean;
  remote?: RemoteContainerHost;
}
export interface ContainerCommandPlan { command: string; args: string[] }
export interface ContainerRuntimeStatus {
  runtime: ContainerRuntime;
  available: boolean;
  rootless: boolean;
  reason?: string;
}
export type ContainerProbeRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;

function assertRuntime(runtime: unknown): asserts runtime is ContainerRuntime {
  if (runtime !== 'podman' && runtime !== 'docker') throw new Error('Unsupported container runtime.');
}
function limit(value: number | undefined, fallback: number, min: number, max: number, integer = false): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max || (integer && !Number.isInteger(resolved))) {
    throw new Error('Invalid container resource limit.');
  }
  return resolved;
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
function remotePlan(plan: ContainerCommandPlan, remote?: RemoteContainerHost, tty = false): ContainerCommandPlan {
  if (!remote) return plan;
  if (typeof remote.host !== 'string' || remote.host.length > 253 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(remote.host) ||
    (remote.user !== undefined && (typeof remote.user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/u.test(remote.user))) ||
    (remote.port !== undefined && (!Number.isInteger(remote.port) || remote.port < 1 || remote.port > 65535))) {
    throw new Error('Invalid remote SSH target.');
  }
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (remote.port !== undefined) args.push('-p', String(remote.port));
  if (tty) args.push('-tt');
  args.push('--', remote.user ? `${remote.user}@${remote.host}` : remote.host, [plan.command, ...plan.args].map(shellQuote).join(' '));
  return { command: 'ssh', args };
}

function assertWorkspacePath(workspace: string): void {
  const systemVar = /^\/(?:private\/)?var(?:\/|$)/u.test(workspace) &&
    !/^\/(?:private\/)?var\/(?:tmp\/[^/]+|folders\/[^/]+\/[^/]+\/[TC]\/[^/]+)/u.test(workspace);
  if (typeof workspace !== 'string' || workspace.length > 4096 || !posix.isAbsolute(workspace) || posix.normalize(workspace) !== workspace ||
    /[,\x00-\x1f\x7f]/u.test(workspace) || workspace === '/' || workspace.split('/').filter(Boolean).length < 2 ||
    /^\/(?:etc|proc|sys|dev|run|root|System|Library|usr|bin|sbin)(?:\/|$)/u.test(workspace) || systemVar ||
    /^\/private\/etc(?:\/|$)/u.test(workspace) || workspace === '/private/tmp' ||
    /^\/(?:home|Users)(?:\/[^/]+)?\/?$/u.test(workspace) ||
    /(?:^|\/)(?:\.ssh|\.aws|\.azure|\.config|\.docker|\.gnupg|credentials?|secrets?)(?:\/|$)/iu.test(workspace)) {
    throw new Error('Container workspace must be a limited absolute project directory.');
  }
}

/** Resolve on the local execution host before constructing a mount plan. */
export async function validateLocalContainerWorkspace(workspace: string): Promise<string> {
  const canonical = await realpath(workspace);
  assertWorkspacePath(canonical);
  if (!(await lstat(canonical)).isDirectory()) throw new Error('Container workspace must be a directory.');
  return canonical;
}

/** Pure argv construction: does not install, start, or probe any container runtime. */
export function buildContainerPlan(input: ContainerRequest): ContainerCommandPlan {
  assertRuntime(input.runtime);
  if (typeof input.image !== 'string' || input.image.length > 512 ||
    !/^(?:[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/u.test(input.image)) {
    throw new Error('A valid, explicit container image is required.');
  }
  const workspace = input.workspace;
  assertWorkspacePath(workspace);
  if (typeof input.command !== 'string' || !input.command || input.command.startsWith('-') || input.command.length > 4096 || /[\x00-\x1f\x7f]/u.test(input.command) ||
    (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 256 || input.args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 65_536)))) {
    throw new Error('Invalid container command arguments.');
  }
  if (input.tty !== undefined && typeof input.tty !== 'boolean') throw new Error('Invalid container TTY option.');
  if (input.network !== undefined && input.network !== 'none' && input.network !== 'bridge') throw new Error('Unsupported container network.');
  const cpus = limit(input.limits?.cpus, 2, 0.1, 32);
  const memoryMb = limit(input.limits?.memoryMb, 2048, 128, 65_536, true);
  const pids = limit(input.limits?.pids, 256, 16, 4096, true);
  const args = [
    'run', '--rm', '--interactive', ...(input.tty === false ? [] : ['--tty']), '--pull=never', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', `--network=${input.network ?? 'none'}`,
    `--cpus=${cpus}`, `--memory=${memoryMb}m`, `--memory-swap=${memoryMb}m`, `--pids-limit=${pids}`,
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777', '--env=HOME=/tmp',
    '--workdir=/workspace', `--mount=type=bind,src=${workspace},dst=/workspace,readonly=false,${input.runtime === 'docker' ? 'bind-recursive=disabled' : 'bind-nonrecursive'},bind-propagation=rprivate`,
    '--entrypoint', input.command, input.image, ...(input.args ?? [])
  ];
  return remotePlan({ command: input.runtime, args }, input.remote, input.tty !== false);
}

const defaultProbeRunner: ContainerProbeRunner = async (command, args) => {
  const { stdout } = await execute(command, args, { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  return { stdout };
};

/** Read-only on-demand check. In particular, never invokes Desktop, machine start, or a VM manager. */
export async function checkContainerRuntime(
  runtime: ContainerRuntime,
  remote?: RemoteContainerHost,
  runner: ContainerProbeRunner = defaultProbeRunner
): Promise<ContainerRuntimeStatus> {
  assertRuntime(runtime);
  const plan = remotePlan({ command: runtime, args: ['info', '--format=json'] }, remote);
  try {
    const result = JSON.parse((await runner(plan.command, plan.args)).stdout) as Record<string, unknown>;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid runtime info response.');
    if (!(typeof result.ServerVersion === 'string' && result.ServerVersion.length > 0) &&
      !(result.host && typeof result.host === 'object' && !Array.isArray(result.host))) {
      throw new Error('Runtime info did not identify an available container engine.');
    }
    const host = result.host as { security?: { rootless?: boolean } } | undefined;
    const options = result.SecurityOptions;
    const rootless = host?.security?.rootless === true || (Array.isArray(options) && options.some((option) => option === 'name=rootless' || option === 'rootless'));
    return { runtime, available: true, rootless };
  } catch (error) {
    return { runtime, available: false, rootless: false, reason: error instanceof Error ? error.message.slice(0, 500) : 'Container runtime is unavailable.' };
  }
}

/** Prefer an already available rootless engine; probing never starts stopped engines. */
export async function detectContainerRuntime(remote?: RemoteContainerHost, runner?: ContainerProbeRunner): Promise<ContainerRuntimeStatus | undefined> {
  const statuses = await Promise.all([
    checkContainerRuntime('podman', remote, runner),
    checkContainerRuntime('docker', remote, runner)
  ]);
  return statuses.find((status) => status.available && status.rootless) ?? statuses.find((status) => status.available);
}
