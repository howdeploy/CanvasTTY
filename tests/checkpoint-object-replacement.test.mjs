import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import test from 'node:test';
import { GitCheckpoints } from '../src/main/services/GitCheckpoints.ts';
const exec = promisify(execFile);

async function gitFixture(t, prefix, { branch, content = 'saved\n', message = 'saved', project = false, executable = 'git' } = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = project ? join(root, 'project') : root;
  if (project) await mkdir(dir);
  const git = async (...args) => (await exec(executable, ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();
  await git('init', ...(branch ? ['-b', branch] : []), '-q');
  // These fixtures compare exact bytes; pin the repository against a global core.autocrlf (Windows runners set true).
  await git('config', 'core.autocrlf', 'false');
  if (content !== null) {
    await writeFile(join(dir, 'file'), content);
    await git('add', 'file');
    await git('commit', '-qm', message);
  }
  return { root, dir, git };
}

test('replacement refs cannot change checkpoint preview or restored tracked content', async t => {
  const { dir, git } = await gitFixture(t, 'ctty-checkpoint-replace-', { content: 'TRUSTED-CONTENT\n', message: 'trusted' });
  const trustedOid = await git('rev-parse', 'HEAD');
  const checkpoints = new GitCheckpoints(text => text);
  await checkpoints.capture('session', dir);
  const saved = (await checkpoints.list('session', dir))[0];
  await writeFile(join(dir, 'file'), 'AGENT-SUBSTITUTION\n');
  await git('add', 'file'); await git('commit', '-qm', 'replacement');
  const replacement = await git('rev-parse', 'HEAD');
  await git('replace', trustedOid, replacement);
  await writeFile(join(dir, 'file'), 'CURRENT-CONTENT\n');
  const preview = await checkpoints.preview('session', dir, saved.id);
  assert.match(preview.text, /-TRUSTED-CONTENT/u);
  assert.doesNotMatch(preview.text, /AGENT-SUBSTITUTION/u);
  await checkpoints.restore('session', dir, saved.id);
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'TRUSTED-CONTENT\n');
});

test('a CRLF working copy in a core.autocrlf repository restores with its CRLF line endings', async t => {
  const { dir, git } = await gitFixture(t, 'ctty-checkpoint-autocrlf-', { content: null });
  await git('config', 'core.autocrlf', 'true');
  await writeFile(join(dir, 'file'), 'first\r\nsecond\r\n');
  await git('add', 'file'); await git('commit', '-qm', 'crlf');
  await writeFile(join(dir, 'file'), 'edited\r\nsecond\r\n');
  const checkpoints = new GitCheckpoints(text => text);
  await checkpoints.capture('session', dir);
  const saved = (await checkpoints.list('session', dir))[0];
  await writeFile(join(dir, 'file'), 'later\r\n');
  await checkpoints.restore('session', dir, saved.id);
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'edited\r\nsecond\r\n', 'Git normalizes on capture and converts back on restore');
  assert.equal(await git('status', '--porcelain'), 'M file');
});

test('protected checkpoint packs survive deleted source refs and immediate Git garbage collection', async t => {
  const { root, dir, git } = await gitFixture(t, 'ctty-checkpoint-gc-', { project: true });
  const storage=join(root,'private','checkpoints.json');
  const checkpoints=new GitCheckpoints(text=>text,50,storage);await checkpoints.capture('session',dir);
  const saved=(await checkpoints.list('session',dir))[0];
  const oldBranch=await git('branch','--show-current');await git('checkout','--orphan','replacement');
  await writeFile(join(dir,'file'),'replacement\n');await git('add','file');await git('commit','-qm','unrelated');
  await git('branch','-D',oldBranch);await git('update-ref','-d',saved.id);
  await git('reflog','expire','--expire=now','--all');await git('gc','--prune=now');
  const restarted=new GitCheckpoints(text=>text,50,storage);
  await assert.doesNotReject(async()=>{
    assert.match((await restarted.preview('session',dir,saved.id)).text,/-saved/u);
    await restarted.restore('session',dir,saved.id);
    assert.equal(await readFile(join(dir,'file'),'utf8'),'saved\n');
  },'host checkpoint survives ref deletion and immediate Git garbage collection');
});

test('deleting an agent-writable checkpoint ref cannot hide the host-registered checkpoint', async t => {
  const { dir, git } = await gitFixture(t, 'ctty-checkpoint-ref-delete-');
  const checkpoints = new GitCheckpoints(text => text);
  await checkpoints.capture('session', dir);
  const saved = (await checkpoints.list('session', dir))[0];
  await git('update-ref', '-d', saved.id);
  await writeFile(join(dir, 'file'), 'later\n');
  assert.equal((await checkpoints.list('session', dir))[0].id, saved.id);
  await checkpoints.restore('session', dir, saved.id);
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'saved\n');
});

test('repository reference hooks cannot block host checkpoint capture', async t => {
  const { dir, git } = await gitFixture(t, 'ctty-checkpoint-hooks-', { branch: 'main' });
  await writeFile(join(dir, '.git', 'hooks', 'reference-transaction'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
  const head = await git('rev-parse', 'HEAD');
  await assert.rejects(git('update-ref', 'refs/test/hook-check', head), undefined, 'fixture hook should be active for ordinary Git commands');

  const checkpoints = new GitCheckpoints(text => text);
  await checkpoints.capture('session', dir);
  assert.equal((await checkpoints.list('session', dir)).length, 1);
});

test('restoring a clean merge-HEAD checkpoint keeps the merge tree in the index', async t => {
  const { dir, git } = await gitFixture(t, 'ctty-checkpoint-merge-head-', { branch: 'main', content: null });
  await writeFile(join(dir, 'base.txt'), 'base\n');
  await git('add', 'base.txt'); await git('commit', '-qm', 'base');
  await git('checkout', '-b', 'feature');
  await writeFile(join(dir, 'feature.txt'), 'feature\n');
  await git('add', 'feature.txt'); await git('commit', '-qm', 'feature');
  await git('checkout', 'main');
  await writeFile(join(dir, 'main.txt'), 'main\n');
  await git('add', 'main.txt'); await git('commit', '-qm', 'main');
  await git('merge', '--no-ff', 'feature', '-m', 'merge feature');

  const checkpoints = new GitCheckpoints(text => text);
  await checkpoints.capture('session', dir);
  const saved = (await checkpoints.list('session', dir))[0];
  await writeFile(join(dir, 'main.txt'), 'changed after checkpoint\n');
  await checkpoints.restore('session', dir, saved.id);

  assert.equal(await readFile(join(dir, 'main.txt'), 'utf8'), 'main\n');
  assert.equal(await git('diff', '--cached', '--name-only'), '', 'restored index should match the clean merge checkpoint');
  assert.equal(await git('write-tree'), await git('rev-parse', `${saved.id}^{tree}`));
});

test('restore holds a pruned checkpoint pack through Git GC with retention set to one', async t => {
  const { root, dir, git } = await gitFixture(t, 'ctty-checkpoint-restore-lease-', { branch: 'main', project: true });
  const storage = join(root, 'private', 'checkpoints.json');
  const checkpoints = new GitCheckpoints(text => text, 1, storage);
  await checkpoints.capture('session', dir);
  const saved = (await checkpoints.list('session', dir))[0];

  const oldBranch = await git('branch', '--show-current');
  await git('checkout', '--orphan', 'replacement');
  await writeFile(join(dir, 'file'), 'replacement\n');
  await git('add', 'file'); await git('commit', '-qm', 'unrelated');
  await git('branch', '-D', oldBranch);

  const capture = checkpoints.capture.bind(checkpoints);
  checkpoints.capture = async (session, cwd) => {
    await capture(session, cwd);
    await git('reflog', 'expire', '--expire=now', '--all');
    await git('gc', '--prune=now');
  };
  await assert.doesNotReject(checkpoints.restore('session', dir, saved.id), 'restore must retain its source pack through capture-time pruning and GC');
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'saved\n');
  assert.equal((await checkpoints.list('session', dir)).length, 1, 'the new pre-restore checkpoint should remain under retention one');
});

test('a failed registry replacement keeps retained checkpoint packs and refs intact', async t => {
  const { root, dir, git } = await gitFixture(t, 'ctty-checkpoint-retention-atomic-', { branch: 'main', project: true });
  const storage = join(root, 'private', 'checkpoints.json');
  const checkpoints = new GitCheckpoints(text => text, 1, storage);
  await checkpoints.capture('session', dir);
  const saved = (await checkpoints.list('session', dir))[0];
  const registry = await readFile(storage, 'utf8');
  const packDirectory = join(root, 'private', 'checkpoint-objects', (await readdir(join(root, 'private', 'checkpoint-objects')))[0]);
  const legacyPack = (await readdir(packDirectory)).find(name => name.endsWith('.pack'));
  assert.ok(legacyPack);
  const legacySidecars = [legacyPack.slice(0, -5) + '.idx', legacyPack.slice(0, -5) + '.rev'];
  for (const name of legacySidecars) await writeFile(join(packDirectory, name), 'legacy unused sidecar');

  // A directory at the registry filename makes the final atomic rename fail after pack creation.
  await rm(storage);
  await mkdir(storage);
  await writeFile(join(dir, 'file'), 'new checkpoint\n');
  await assert.rejects(checkpoints.capture('session', dir));

  assert.deepEqual((await checkpoints.list('session', dir)).map(row => row.id), [saved.id]);
  assert.deepEqual((await git('for-each-ref', '--format=%(refname)', 'refs/canvastty/session')).split('\n'), [saved.id]);
  for (const name of legacySidecars) assert.equal(await readFile(join(packDirectory, name), 'utf8'), 'legacy unused sidecar');

  await rm(storage, { recursive: true, force: true });
  await writeFile(storage, registry, { mode: 0o600 });
  const restarted = new GitCheckpoints(text => text, 1, storage);
  await restarted.restore('session', dir, saved.id);
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'saved\n');
  assert.ok((await readdir(packDirectory)).every(name => name.endsWith('.pack')), 'pruning legacy checkpoints removes their unused index and reverse-index files');
});

test('an interrupted pack leaves no temporary files and preserves the last checkpoint', async t => {
  if (process.platform === 'win32') return t.skip('the interrupted Git fixture uses a POSIX shell');
  const realGit = (await exec('/bin/sh', ['-c', 'command -v git'])).stdout.trim();
  const { root, dir, git } = await gitFixture(t, 'ctty-checkpoint-pack-interrupt-', { branch: 'main', project: true, executable: realGit });
  const storage = join(root, 'private', 'checkpoints.json');
  const bin = join(root, 'bin');
  await mkdir(bin);
  const checkpoints = new GitCheckpoints(text => text, 50, storage);
  await checkpoints.capture('session', dir);
  const saved = (await checkpoints.list('session', dir))[0];
  const registry = JSON.parse(await readFile(storage, 'utf8'));
  const packFolders = await readdir(join(root, 'private', 'checkpoint-objects'));
  assert.equal(packFolders.length, 1);
  const packDirectory = join(root, 'private', 'checkpoint-objects', packFolders[0]);
  const existingFiles = (await readdir(packDirectory)).sort();
  await writeFile(join(dir, 'file'), 'changed\n');
  await writeFile(join(bin, 'git'), `#!/bin/sh
interrupted=false
for argument in "$@"; do
  [ "$argument" = pack-objects ] && interrupted=true
  prefix="$argument"
done
if [ "$interrupted" = true ]; then
  while IFS= read -r object; do :; done
  printf 'unfinished pack' > "$(dirname "$prefix")/tmp_pack_interrupted"
  printf 'unfinished index' > "$prefix.partial.idx"
  printf 'fixture pack interrupted\\n' >&2
  exit 73
fi
exec "$CTTY_REAL_GIT" "$@"
`, { mode: 0o755 });
  // Keep the PATH override inside a child so other tests and host commands always use real Git.
  const code = `
    import assert from 'node:assert/strict';
    import { readFile, readdir } from 'node:fs/promises';
    import { GitCheckpoints } from ${JSON.stringify(new URL('../src/main/services/GitCheckpoints.ts', import.meta.url).href)};
    const checkpoints = new GitCheckpoints(text => text, 50, ${JSON.stringify(storage)});
    await assert.rejects(checkpoints.capture('session', ${JSON.stringify(dir)}), /fixture pack interrupted/u);
    assert.deepEqual((await readdir(${JSON.stringify(packDirectory)})).sort(), ${JSON.stringify(existingFiles)}, 'failed pack creation must not leave temporary or partial pack files');
    assert.deepEqual(JSON.parse(await readFile(${JSON.stringify(storage)}, 'utf8')), ${JSON.stringify(registry)});
    assert.deepEqual((await checkpoints.list('session', ${JSON.stringify(dir)})).map(row => row.id), [${JSON.stringify(saved.id)}]);
    process.env.PATH = process.env.CTTY_ORIGINAL_PATH;
    await checkpoints.capture('session', ${JSON.stringify(dir)});
    assert.equal((await checkpoints.list('session', ${JSON.stringify(dir)})).length, 2, 'a later capture still works after the interrupted one');
    await checkpoints.restore('session', ${JSON.stringify(dir)}, ${JSON.stringify(saved.id)});
    assert.equal(await readFile(${JSON.stringify(join(dir, 'file'))}, 'utf8'), 'saved\\n');
  `;
  const result = await exec(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', code], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CTTY_REAL_GIT: realGit, CTTY_ORIGINAL_PATH: process.env.PATH ?? '' },
    timeout: 15_000
  });
  // Node 22/23 announce type stripping as an ExperimentalWarning; only that notice (and Node's trace hint) is tolerated.
  const nodeExperimentalNotice = /^\(node:\d+\) ExperimentalWarning: [^\n]*\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?/gmu;
  assert.equal(result.stderr.replace(nodeExperimentalNotice, ''), '');
  assert.ok((await readdir(packDirectory)).every(name => name.endsWith('.pack')), 'new checkpoints retain only complete packs, without unused indexes or staging folders');
});

test('startup removes interrupted staging from dead owners while keeping live captures and packs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ctty-checkpoint-staging-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, 'private', 'checkpoints.json');
  const projectPacks = join(root, 'private', 'checkpoint-objects', 'a'.repeat(64));
  await mkdir(projectPacks, { recursive: true });
  const owner = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await once(owner, 'exit');
  assert.ok(Number.isSafeInteger(owner.pid));
  const deadFolder = join(projectPacks, `.pending-${owner.pid}-aBc123`);
  const liveFolder = join(projectPacks, `.pending-${process.pid}-xYz456`);
  for (const folder of [deadFolder, liveFolder]) {
    await mkdir(folder);
    await writeFile(join(folder, 'tmp_pack'), 'incomplete');
  }
  const packName = `pack-${'b'.repeat(40)}.pack`;
  await writeFile(join(projectPacks, packName), 'retained pack');
  const checkpoints = new GitCheckpoints(text => text, 50, storage);
  // load runs even for a nonrepository and with no registry: first-capture failures leave no row.
  assert.deepEqual(await checkpoints.list('session', root), []);
  assert.deepEqual((await readdir(projectPacks)).sort(), [liveFolder.slice(projectPacks.length + 1), packName].sort());
  assert.equal(await readFile(join(liveFolder, 'tmp_pack'), 'utf8'), 'incomplete');
  assert.equal(await readFile(join(projectPacks, packName), 'utf8'), 'retained pack');
});
