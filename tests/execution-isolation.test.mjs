import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContainerPlan, checkContainerRuntime, detectContainerRuntime, validateLocalContainerWorkspace, ISOLATION_MODES } from '../src/main/services/ExecutionIsolation.ts';

const request = { runtime: 'podman', image: 'registry.example.com/agents/codex:1', workspace: '/srv/project', command: 'codex', args: ['--', 'hello; $(whoami)'] };

test('both container runtimes receive bounded, hardened argv and only an explicit workspace mount', () => {
  assert.deepEqual(ISOLATION_MODES, ['direct', 'worktree', 'container']);
  for (const runtime of ['docker', 'podman']) {
    const plan = buildContainerPlan({ ...request, runtime });
    assert.equal(plan.command, runtime);
    for (const flag of ['--rm', '--interactive', '--tty', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none', '--cpus=2', '--memory=2048m', '--pids-limit=256', '--pull=never']) {
      assert.ok(plan.args.includes(flag), flag);
    }
    assert.ok(plan.args.includes('--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777'));
    assert.deepEqual(plan.args.filter((arg) => arg.startsWith('--mount=')), [`--mount=type=bind,src=/srv/project,dst=/workspace,readonly=false,${runtime === 'docker' ? 'bind-recursive=disabled' : 'bind-nonrecursive'},bind-propagation=rprivate`]);
    assert.equal(plan.args[plan.args.indexOf('--entrypoint') + 1], 'codex');
    assert.deepEqual(plan.args.slice(-3), [request.image, '--', 'hello; $(whoami)']);
    assert.equal(plan.args.some((arg) => /privileged|host|docker.sock|podman.sock/.test(arg)), false);
  }
});

test('container plans reject injected runtimes, image flags, dangerous mounts, and unbounded limits', () => {
  for (const image of ['', '--privileged', 'image --network=host', 'image\n--privileged', 'image;curl bad']) {
    assert.throws(() => buildContainerPlan({ ...request, image }), /image/i);
  }
  for (const workspace of ['/', '/var', '/tmp', '/srv', '/home', '/home/runner', '/Users/runner', '/var/run', '/etc', '/private/etc', '/private/var', '/private/var/root', '/System/Library', '/Library/Keychains', '/srv/work,src=/var/run', '/srv/../etc', '/home/runner/.ssh', 'relative']) {
    assert.throws(() => buildContainerPlan({ ...request, workspace }), /workspace/i, workspace);
  }
  for (const limits of [{ cpus: 0 }, { cpus: NaN }, { memoryMb: 0 }, { pids: -1 }, { pids: 1.1 }, { memoryMb: 999999 }]) {
    assert.throws(() => buildContainerPlan({ ...request, limits }), /limit/i);
  }
  assert.throws(() => buildContainerPlan({ ...request, runtime: 'sh' }), /runtime/i);
  assert.throws(() => buildContainerPlan({ ...request, network: 'host' }), /network/i);
});

test('SSH plans safely quote remote argv and cannot inject an SSH option or remote shell command', () => {
  const plan = buildContainerPlan({ ...request, workspace: "/srv/project's files", remote: { host: 'build.example', user: 'runner', port: 2222 } });
  assert.equal(plan.command, 'ssh');
  assert.ok(plan.args.includes('-tt'));
  const piped = buildContainerPlan({ ...request, tty: false, remote: { host: 'build.example' } });
  assert.ok(!piped.args.includes('-tt'));
  assert.ok(!piped.args.at(-1).includes('--tty'));
  assert.deepEqual(plan.args.slice(0, 6), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-p', '2222']);
  assert.equal(plan.args.at(-2), 'runner@build.example');
  assert.ok(plan.args.at(-1).includes("'hello; $(whoami)'"));
  assert.ok(plan.args.at(-1).includes("project'\"'\"'s files"));
  for (const remote of [{ host: '-oProxyCommand=bad' }, { host: 'box;curl bad' }, { host: 'box', user: 'u@bad' }, { host: 'box', port: 0 }]) {
    assert.throws(() => buildContainerPlan({ ...request, remote }), /remote|SSH/i);
  }
});

test('runtime checks probe info on demand, prefer an existing rootless runtime, and never launch a VM', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    return { stdout: JSON.stringify({ host: { security: { rootless: true } } }) };
  };
  const status = await checkContainerRuntime('podman', undefined, runner);
  assert.equal(status.available, true);
  assert.equal(status.rootless, true);
  assert.deepEqual(calls, [{ command: 'podman', args: ['info', '--format=json'] }]);
  const missing = await checkContainerRuntime('docker', undefined, async () => { throw new Error('daemon unavailable'); });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /daemon unavailable/);
  const remoteCalls = [];
  await checkContainerRuntime('docker', { host: 'linux.example' }, async (command, args) => {
    remoteCalls.push({ command, args });
    return { stdout: '{"ServerVersion":"28.0.0","SecurityOptions":["name=rootless"]}' };
  });
  assert.equal(remoteCalls[0].command, 'ssh');
  assert.ok(!remoteCalls[0].args.includes('-tt'));
  const empty = await checkContainerRuntime('docker', undefined, async () => ({ stdout: '{}' }));
  assert.equal(empty.available, false);
  assert.equal(remoteCalls[0].args.at(-1), "'docker' 'info' '--format=json'");
});


test('runtime detection prefers already available rootless Docker over rootful Podman', async () => {
  const status = await detectContainerRuntime(undefined, async (command, args) => {
    assert.deepEqual(args, ['info', '--format=json']);
    return { stdout: command === 'docker' ? '{"ServerVersion":"28.0.0","SecurityOptions":["name=rootless"]}' : '{"host":{"security":{"rootless":false}}}' };
  });
  assert.equal(status.runtime, 'docker');
  assert.equal(status.rootless, true);
  assert.equal(await detectContainerRuntime(undefined, async () => { throw new Error('not running'); }), undefined);
});


test('local workspace validation canonicalizes safe directories and rejects links to broad mounts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canvastty-container-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.match(await validateLocalContainerWorkspace(directory), /canvastty-container-path-/);
  await symlink('/', join(directory, 'host-root'));
  await assert.rejects(validateLocalContainerWorkspace(join(directory, 'host-root')), /workspace/);
  await writeFile(join(directory, 'file'), 'not a directory');
  await assert.rejects(validateLocalContainerWorkspace(join(directory, 'file')), /directory/);
});
