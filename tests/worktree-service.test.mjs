import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorktreeService } from '../src/main/services/WorktreeService.ts';

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
async function fixture(t) {
  const sourceDirectory = await mkdtemp(join(tmpdir(), 'canvastty-worktree-source-'));
  git(sourceDirectory, 'init', '-q');
  git(sourceDirectory, 'config', 'user.email', 'test@localhost');
  git(sourceDirectory, 'config', 'user.name', 'Test');
  await writeFile(join(sourceDirectory, 'code.txt'), 'committed\n');
  await writeFile(join(sourceDirectory, '.gitignore'), 'ignored.txt\n');
  git(sourceDirectory, 'add', '.');
  git(sourceDirectory, 'commit', '-qm', 'Initial');
  const service = new WorktreeService();
  t.after(async () => { await service.dispose(); await rm(sourceDirectory, { recursive: true, force: true }); });
  return { sourceDirectory, service };
}

test('detached worktrees preserve original branch, index, dirty files, and untracked files', async (t) => {
  const { sourceDirectory, service } = await fixture(t);
  const originalBranch = git(sourceDirectory, 'symbolic-ref', 'HEAD');
  await writeFile(join(sourceDirectory, 'code.txt'), 'uncommitted\n');
  await writeFile(join(sourceDirectory, 'local.txt'), 'untracked');
  const originalStatus = git(sourceDirectory, 'status', '--porcelain');
  const workspace = await service.create({ sourceDirectory });
  assert.equal(await readFile(join(workspace.directory, 'code.txt'), 'utf8'), 'committed\n');
  assert.equal(git(workspace.directory, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(git(sourceDirectory, 'symbolic-ref', 'HEAD'), originalBranch);
  assert.equal(git(sourceDirectory, 'status', '--porcelain'), originalStatus);
  await service.cleanup(workspace.id);
  await assert.rejects(access(workspace.directory), { code: 'ENOENT' });
  assert.equal(await readFile(join(sourceDirectory, 'code.txt'), 'utf8'), 'uncommitted\n');
});

test('worktree cleanup refuses tracked, untracked, and ignored changes without force-removal', async (t) => {
  const { sourceDirectory, service } = await fixture(t);
  const workspace = await service.create({ sourceDirectory });
  for (const file of ['code.txt', 'new.txt', 'ignored.txt']) {
    await writeFile(join(workspace.directory, file), 'keep me');
    await assert.rejects(service.cleanup(workspace.id), /dirty|changes/i);
    assert.equal(await readFile(join(workspace.directory, file), 'utf8'), 'keep me');
    if (file === 'code.txt') git(workspace.directory, 'restore', file);
    else await rm(join(workspace.directory, file));
  }
  await service.cleanup(workspace.id);
});

test('worktree creation accepts existing refs, rejects option injection, and does not execute checkout hooks', async (t) => {
  const { sourceDirectory, service } = await fixture(t);
  git(sourceDirectory, 'branch', 'safe-ref');
  const marker = join(sourceDirectory, 'hook-ran');
  await writeFile(join(sourceDirectory, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const workspace = await service.create({ sourceDirectory, ref: 'safe-ref' });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.equal(workspace.commit, git(sourceDirectory, 'rev-parse', 'HEAD'));
  for (const ref of ['--help', '-b', 'HEAD\n--force', 'HEAD;touch /tmp/unexpected', 'missing-ref']) {
    await assert.rejects(service.create({ sourceDirectory, ref }));
  }
  await service.cleanup(workspace.id);
});

test('cleanup retains changes hidden by index flags', async (t) => {
  const { sourceDirectory, service } = await fixture(t);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    const workspace = await service.create({ sourceDirectory });
    git(workspace.directory, 'update-index', `--${flag}`, 'code.txt');
    await writeFile(join(workspace.directory, 'code.txt'), 'hidden changes\n');
    assert.equal(git(workspace.directory, 'status', '--porcelain'), '');
    await assert.rejects(service.cleanup(workspace.id), /index flags|hidden|retained/i);
    assert.equal(await readFile(join(workspace.directory, 'code.txt'), 'utf8'), 'hidden changes\n');
    git(workspace.directory, 'update-index', `--no-${flag}`, 'code.txt');
    git(workspace.directory, 'restore', 'code.txt');
    await service.cleanup(workspace.id);
  }
});

test('durable worktrees recover edited output independently of terminal persistence', async (t) => {
  const { sourceDirectory } = await fixture(t);
  const rootDirectory = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-owned-workspaces-')));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const first = new WorktreeService({ rootDirectory });
  const workspace = await first.create({ sourceDirectory, sessionId: 'session-one' });
  await writeFile(join(workspace.directory, 'code.txt'), 'retained edit\n');
  await first.dispose();
  const recovered = new WorktreeService({ rootDirectory });
  await recovered.recover();
  assert.equal((await recovered.list())[0].id, workspace.id);
  assert.equal((await recovered.reuse(workspace.id, sourceDirectory)).directory, workspace.directory);
  assert.match((await recovered.review(workspace.id)).patch, /retained edit/);
  await assert.rejects(recovered.cleanup(workspace.id), /dirty|changes/);
});

test('durable ownership verification retains forged, missing and symlinked records without deleting files', async t => {
  const { sourceDirectory } = await fixture(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-worktree-ownership-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mutation of ['missing', 'forged', 'symlink', 'marker']) {
    const rootDirectory = join(root, mutation);
    const first = new WorktreeService({ rootDirectory });
    const workspace = await first.create({ sourceDirectory });
    const manifestPath = join(rootDirectory, workspace.id, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (mutation === 'missing') await rm(manifestPath);
    if (mutation === 'forged') { manifest.workspace.directory = sourceDirectory; await writeFile(manifestPath, JSON.stringify(manifest)); }
    if (mutation === 'marker') await writeFile(join(rootDirectory, workspace.id, 'owner'), 'invalid-owner');
    if (mutation === 'symlink') {
      const { rename, symlink } = await import('node:fs/promises');
      await rename(workspace.directory, `${workspace.directory}-retained`);
      await symlink(sourceDirectory, workspace.directory);
    }
    const recovered = new WorktreeService({ rootDirectory });
    const entry = (await recovered.list())[0];
    assert.equal(entry.state, 'unavailable', mutation);
    await assert.rejects(recovered.cleanup(workspace.id));
    assert.equal(await readFile(join(sourceDirectory, 'code.txt'), 'utf8'), 'committed\n');
    await access(join(workspace.directory, 'code.txt'));
  }
});

test('new commits survive recovery even with a clean index; review export preserves an immutable snapshot', async t => {
  const { sourceDirectory } = await fixture(t);
  const rootDirectory = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-worktree-commits-')));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const service = new WorktreeService({ rootDirectory }); const workspace = await service.create({ sourceDirectory });
  await writeFile(join(workspace.directory, 'code.txt'), 'new commit\n');
  git(workspace.directory, 'add', 'code.txt'); git(workspace.directory, 'commit', '-qm', 'generated');
  assert.equal(git(workspace.directory, 'status', '--porcelain'), '');
  const recovered = new WorktreeService({ rootDirectory }); await recovered.recover();
  await assert.rejects(recovered.cleanup(workspace.id), /new commits/);
  const review = await recovered.review(workspace.id); assert.match(review.patch, /new commit/);
  await writeFile(join(workspace.directory, 'code.txt'), 'later change\n');
  assert.equal(recovered.exportReview(workspace.id, review.reviewId).patch, review.patch);
  assert.throws(() => recovered.exportReview(workspace.id, 'forged'), /expired/);
});

test('repository paths ending in spaces never resolve to a different sibling repository', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-worktree-spaces-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  for (const name of ['source', 'source ']) {
    const directory = join(parent, name); await mkdir(directory);
    git(directory, 'init', '-q'); git(directory, 'config', 'user.email', 'test@localhost'); git(directory, 'config', 'user.name', 'Test');
    await writeFile(join(directory, 'identity.txt'), name); git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'base');
  }
  const service = new WorktreeService({ rootDirectory: join(parent, 'managed') });
  const workspace = await service.create({ sourceDirectory: join(parent, 'source ') });
  assert.equal(workspace.sourceDirectory, join(parent, 'source '));
  assert.equal(await readFile(join(workspace.directory, 'identity.txt'), 'utf8'), 'source ');
  await service.cleanup(workspace.id);
});

test('ephemeral embedding releases only its matching generation lease after confirmed exit', async t => {
  const { sourceDirectory, service } = await fixture(t);
  const workspace = await service.create({ sourceDirectory, leaseId: 'first-generation' });
  await assert.rejects(service.review(workspace.id), /reserved|busy/);
  await service.retain(workspace.id, true, 'wrong-generation');
  await assert.rejects(service.cleanup(workspace.id), /reserved|busy/);
  await service.retain(workspace.id, true, 'first-generation');
  await service.cleanup(workspace.id);
});
