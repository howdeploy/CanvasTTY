import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerExecutionService } from '../src/main/services/ContainerExecutionService.ts';
import { REMOTE_CONTAINER_HOST } from '../src/main/services/RemoteContainerHost.ts';
import { CONTAINER_BOOTSTRAP } from '../src/main/services/ContainerBootstrap.ts';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t, state = 'workspace-retained') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-remote-review-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'host-home'), source = join(root, 'source'), registry = join(root, 'registry');
  for (const dir of [home, source, registry]) await mkdir(dir, { mode: 0o700 });
  const env = { HOME: home, PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  git(source, ['init']); await writeFile(join(source, 'entry.txt'), 'baseline\n'); await writeFile(join(source, '.gitignore'), 'ignored.txt\n'); git(source, ['add', '.']); git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
  const run = (code, request) => execFileSync('python3', ['-I', '-S', '-c', `import os,sys\nsys.platform='linux'\nos.path.expanduser=lambda p:${JSON.stringify(home)} if p=='~' else p\n` + code, JSON.stringify(request)], { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const workspace = JSON.parse(run(REMOTE_CONTAINER_HOST, { action: 'create', source }));
  const host = { id: 'review-server', label: 'Fixture server', sshHost: 'fixture.invalid' };
  const profile = { id: 'removed-profile', label: 'Removed image profile', hostId: host.id, runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/fixture.sock' }, hostPython: '/usr/bin/python3', image: 'fixture:existing', python: '/usr/bin/python3', commands: { terminal: '/bin/sh' }, network: 'none', cpus: 2, memoryMb: 1024, pids: 128, user: '1000:1000' };
  const id = randomUUID(), installation = randomUUID();
  const record = { version: 1, id, installation, profileId: profile.id, hostId: host.id, workspaceId: workspace.id, workspace, profile, endpoint: { executable: profile.executable, socket: profile.endpoint.socket, executableIdentity: 'fixture' }, engine: { identity: 'a'.repeat(64), name: 'fixture', rootless: false }, image: { id: 'sha256:' + 'c'.repeat(64), environmentNames: [] }, name: 'canvastty-' + id, labels: { 'io.canvastty.installation': installation, 'io.canvastty.session': 'session', 'io.canvastty.generation': id, 'io.canvastty.workspace': workspace.id }, sessionId: 'session', createdAt: Date.now(), state, leaseId: randomUUID(), markerToken: randomUUID(), environmentDigest: 'd'.repeat(64), hostFingerprint: digest(host), user: profile.user, bootstrap: CONTAINER_BOOTSTRAP };
  await writeFile(join(registry, 'owner'), installation, { mode: 0o600 }); await writeFile(join(registry, id + '.json'), JSON.stringify(record), { mode: 0o600 });
  const settings = { remoteHosts: [host], containerProfiles: [] }, calls = [];
  const options = { rootDirectory: registry, runner: async (command, args) => {
    assert.equal(command, 'ssh'); const words = JSON.parse(execFileSync('python3', ['-I', '-S', '-c', 'import json,sys,shlex;print(json.dumps(shlex.split(sys.argv[1])))', args.at(-1)], { encoding: 'utf8' }));
    assert.equal(words[0], profile.hostPython); assert.deepEqual(words.slice(1, 4), ['-I', '-S', '-c']); const request = JSON.parse(words[5]); calls.push(request);
    const { REMOTE_WORKSPACE_REVIEW } = await import('../src/main/services/RemoteWorkspaceReview.ts'); assert.equal(words[4], REMOTE_WORKSPACE_REVIEW, 'only the fixed read-only helper may run');
    return { stdout: run(words[4], request) };
  } };
  const service = new ContainerExecutionService(() => settings, options);
  return { root, source, workspace, record, settings, calls, service, git, options };
}

test('stopped remote output review/export is immutable, counts omitted files and does not require its removed image profile', async t => {
  const f = await fixture(t); await writeFile(join(f.workspace.directory, 'entry.txt'), 'reviewed change\n'); await writeFile(join(f.workspace.directory, 'untracked.txt'), 'explicitly omitted\n'); await writeFile(join(f.workspace.directory, 'ignored.txt'), 'also omitted\n');
  const review = await f.service.review(f.record.id);
  assert.equal(review.generationId, f.record.id); assert.equal(review.hostId, 'review-server'); assert.equal(review.baseCommit, f.workspace.commit); assert.match(review.patch, /\+reviewed change/);
  assert.equal(review.untrackedFiles, 1); assert.equal(review.ignoredFiles, 1); assert.ok(!review.patch.includes('explicitly omitted')); assert.match(review.digest, /^[a-f0-9]{64}$/);
  const exported = await f.service.exportReview(f.record.id, review.reviewId); assert.equal(exported.patch, review.patch); assert.equal(exported.digest, review.digest);
  await writeFile(join(f.workspace.directory, 'entry.txt'), 'later change\n'); await assert.rejects(f.service.exportReview(f.record.id, review.reviewId), /changed|again/i);
  assert.equal(await readFile(join(f.source, 'entry.txt'), 'utf8'), 'baseline\n'); assert.equal(await readFile(join(f.workspace.directory, 'ignored.txt'), 'utf8'), 'also omitted\n'); assert.equal((await f.service.list())[0].state, 'workspace-retained');
});

test('remote output cannot be reviewed before stop confirmation or after its fixed host changes', async t => {
  const active = await fixture(t, 'cleanup-needed'); await assert.rejects(active.service.review(active.record.id), /stop|retained|active|confirm/i); assert.equal(active.calls.length, 0);
  const f = await fixture(t); f.settings.remoteHosts[0] = { ...f.settings.remoteHosts[0], sshHost: 'other.invalid' }; await assert.rejects(f.service.review(f.record.id), /host.*changed/i); assert.equal(f.calls.length, 0);
});

test('remote review includes committed and staged changes from the saved base and preserves binary patches', async t => {
  const f = await fixture(t), cwd = f.workspace.directory;
  await writeFile(join(cwd, 'entry.txt'), 'committed output\n'); f.git(cwd, ['add', 'entry.txt']); f.git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'output']);
  await writeFile(join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 255])); f.git(cwd, ['add', 'binary.bin']);
  const result = await f.service.review(f.record.id);
  assert.notEqual(result.headCommit, result.baseCommit); assert.match(result.patch, /\+committed output/); assert.match(result.patch, /GIT binary patch/);
  assert.equal(result.untrackedFiles, 0); assert.equal(result.ignoredFiles, 0);
  const patch = join(f.root, 'review.patch'); await writeFile(patch, result.patch); f.git(f.source, ['apply', '--check', patch]);
  assert.equal(await readFile(join(f.source, 'entry.txt'), 'utf8'), 'baseline\n');
});

test('remote review refuses unsafe output, hidden index state and oversized patches without modifying files', async t => {
  const scenarios = [
    ['symbolic link', async f => symlink(join(f.source, 'entry.txt'), join(f.workspace.directory, 'linked'))],
    ['hard link', async f => link(join(f.source, 'entry.txt'), join(f.workspace.directory, 'linked'))],
    ['fifo', async f => execFileSync('mkfifo', [join(f.workspace.directory, 'pipe')])],
    ['nested repository', async f => { await mkdir(join(f.workspace.directory, 'nested')); await mkdir(join(f.workspace.directory, 'nested', '.git')); }],
    ['active marker', async f => writeFile(join(f.workspace.directory, '.canvastty-container-' + randomUUID()), 'active')],
    ['hidden index', async f => f.git(f.workspace.directory, ['update-index', '--assume-unchanged', 'entry.txt'])],
    ['skip worktree', async f => f.git(f.workspace.directory, ['update-index', '--skip-worktree', 'entry.txt'])],
    ['oversized file', async f => writeFile(join(f.workspace.directory, 'oversized'), Buffer.alloc(16777217))],
    ['oversized patch', async f => writeFile(join(f.workspace.directory, 'entry.txt'), 'large output\n'.repeat(50000))],
    ['linked Git pointer', async f => { const pointer = join(f.workspace.directory, '.git'); const target = join(f.root, 'pointer'); await writeFile(target, await readFile(pointer)); await rm(pointer); await symlink(target, pointer); }]
  ];
  for (const [name, mutate] of scenarios) await t.test(name, async t => {
    const f = await fixture(t); await mutate(f); await assert.rejects(f.service.review(f.record.id), /review failed/);
    assert.equal(await readFile(join(f.source, 'entry.txt'), 'utf8'), 'baseline\n'); assert.equal((await f.service.list())[0].state, 'workspace-retained');
  });
});

test('remote Git review disables external diff, textconv, clean/process filters and fsmonitor hooks', async t => {
  const f = await fixture(t), cwd = f.workspace.directory, executed = join(f.root, 'external-executed');
  const command = `printf ran > '${executed}'; cat`;
  for (const [name, value] of [['diff.external', command], ['diff.fixture.command', command], ['diff.fixture.textconv', command], ['filter.fixture.clean', command], ['filter.fixture.process', command], ['filter.fixture.required', 'true'], ['core.fsmonitor', command]]) f.git(cwd, ['config', name, value]);
  await writeFile(join(cwd, '.gitattributes'), 'entry.txt filter=fixture diff=fixture\n');
  await writeFile(join(cwd, 'entry.txt'), 'unfiltered contents\n');
  const review = await f.service.review(f.record.id); assert.match(review.patch, /\+unfiltered contents/); assert.equal(review.untrackedFiles, 1);
  await assert.rejects(access(executed), { code: 'ENOENT' });
});

test('remote review reports executable mode changes even when the repository ignores file modes', async t => {
  const f = await fixture(t); f.git(f.workspace.directory, ['config', 'core.fileMode', 'false']);
  await chmod(join(f.workspace.directory, 'entry.txt'), 0o755);
  const review = await f.service.review(f.record.id);
  assert.match(review.patch, /old mode 100644\nnew mode 100755/);
});

test('remote review locks reuse, invalidates older tokens and does not persist snapshots across restart', async t => {
  const f = await fixture(t); let unblock, entered;
  const pending = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { unblock = resolve; });
  const options = { ...f.options, runner: async (...args) => { entered(); await gate; return f.options.runner(...args); } };
  const service = new ContainerExecutionService(() => f.settings, options);
  const reviewing = service.review(f.record.id); await pending;
  await assert.rejects(service.remoteWorkspace(f.record.profile, f.source, f.workspace.id), /review|active/);
  await assert.rejects(service.review(f.record.id), /progress/);
  unblock(); const first = await reviewing; const second = await service.review(f.record.id);
  assert.throws(() => service.cachedReview(f.record.id, first.reviewId), /expired/);
  assert.throws(() => service.cachedReview(randomUUID(), second.reviewId), /saved/);
  const copy = service.cachedReview(f.record.id, second.reviewId); copy.patch = 'tampered';
  assert.notEqual(service.cachedReview(f.record.id, second.reviewId).patch, copy.patch);
  const restarted = new ContainerExecutionService(() => f.settings, f.options); await restarted.list();
  assert.throws(() => restarted.cachedReview(f.record.id, second.reviewId), /expired/);
  assert.equal(await service.blocksWorkspace(f.workspace.id), false);
});
