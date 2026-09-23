import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskCapsuleService } from '../src/main/services/TaskCapsuleService.ts';

async function fixture(t) {
  const sourceDirectory = await mkdtemp(join(tmpdir(), 'canvastty-capsule-source-'));
  const service = new TaskCapsuleService();
  t.after(async () => { await service.dispose(); await rm(sourceDirectory, { recursive: true, force: true }); });
  await mkdir(join(sourceDirectory, 'src'));
  await writeFile(join(sourceDirectory, 'src/button.ts'), 'export const label = "Before";\n');
  await writeFile(join(sourceDirectory, '.env'), 'TOKEN=secret\n');
  await mkdir(join(sourceDirectory, '.git'));
  return { sourceDirectory, service, files: ['src/button.ts'], task: 'Change label', dataClass: 'D1', classifyFile: () => 'D1' };
}

test('capsules contain only explicit files and Task.md; review yields an applicable patch without applying it', async (t) => {
  const input = await fixture(t);
  const capsule = await input.service.create(input);
  assert.ok(!capsule.directory.startsWith(input.sourceDirectory));
  assert.deepEqual((await readdir(capsule.directory)).sort(), ['Task.md', 'src']);
  assert.equal(await readFile(join(capsule.directory, 'Task.md'), 'utf8'), 'Change label');
  await writeFile(join(capsule.directory, 'src/button.ts'), 'export const label = "After";\n');
  const review = await input.service.review(capsule.id);
  assert.deepEqual(review.changedFiles, ['src/button.ts']);
  assert.match(review.patch, /^diff --git a\/src\/button.ts b\/src\/button.ts/m);
  assert.match(review.patch, /-export const label = "Before";/);
  assert.match(review.patch, /\+export const label = "After";/);
  assert.equal(await readFile(join(input.sourceDirectory, 'src/button.ts'), 'utf8'), 'export const label = "Before";\n');
  execFileSync('git', ['apply', '--check', '-'], { cwd: input.sourceDirectory, input: review.patch });
  await input.service.cleanup(capsule.id);
  await assert.rejects(readFile(join(capsule.directory, 'Task.md')), { code: 'ENOENT' });
  assert.equal(await readFile(join(input.sourceDirectory, '.env'), 'utf8'), 'TOKEN=secret\n');
});

test('capsules reject traversal, sensitive paths, symlinks, and files above the declared class', async (t) => {
  const input = await fixture(t);
  for (const file of ['../outside', '/etc/passwd', '.git/config', '.env', 'nested/.ENV.local', '.ssh/id_rsa', 'credentials.json', 'config/production.json', 'Task.md']) {
    await assert.rejects(input.service.create({ ...input, files: [file] }), /unsafe|reserved|sensitive/i, file);
  }
  await symlink(join(input.sourceDirectory, 'src/button.ts'), join(input.sourceDirectory, 'linked.ts'));
  await symlink(join(input.sourceDirectory, 'src'), join(input.sourceDirectory, 'linked'));
  await assert.rejects(input.service.create({ ...input, files: ['linked.ts'] }), /symbolic|symlink/i);
  await assert.rejects(input.service.create({ ...input, files: ['linked/button.ts'] }), /symbolic|symlink/i);
  await assert.rejects(input.service.create({ ...input, classifyFile: () => 'D2' }), /D2.*D1/);
  await assert.rejects(input.service.create({ ...input, classifyFile: () => 'unknown' }), /classification/i);
});

test('review preserves deletions and immutable baseline and refuses new unselected files or symlinks', async (t) => {
  const input = await fixture(t);
  const capsule = await input.service.create(input);
  await writeFile(join(input.sourceDirectory, 'src/button.ts'), 'source changed independently\n');
  await rm(join(capsule.directory, 'src/button.ts'));
  const review = await input.service.review(capsule.id);
  assert.match(review.patch, /deleted file mode/);
  assert.match(review.patch, /^diff --git a\/src\/button.ts b\/src\/button.ts/m);
  assert.match(review.patch, /-export const label = "Before";/);
  await writeFile(join(capsule.directory, 'extra.txt'), 'not selected');
  await assert.rejects(input.service.review(capsule.id), /unselected/i);
  await rm(join(capsule.directory, 'extra.txt'));
  await symlink(join(input.sourceDirectory, '.env'), join(capsule.directory, 'src/button.ts'));
  await assert.rejects(input.service.review(capsule.id), /symbolic|symlink/i);
});

test('capsule bounds apply to count, file size, task size, and review output', async (t) => {
  const input = await fixture(t);
  await assert.rejects(input.service.create({ ...input, files: Array(129).fill('src/button.ts') }), /128|count/i);
  await assert.rejects(input.service.create({ ...input, task: 'x'.repeat(65_537) }), /task.*large/i);
  const capsule = await input.service.create(input);
  await writeFile(join(capsule.directory, 'src/button.ts'), Buffer.alloc(1_048_577));
  await assert.rejects(input.service.review(capsule.id), /large|limit/i);
});

test('patch review ignores forced Git colors', async (t) => {
  const input = await fixture(t);
  const capsule = await input.service.create(input);
  const config = join(input.sourceDirectory, 'color.gitconfig');
  await writeFile(config, '[color]\n  ui = always\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  });
  await writeFile(join(capsule.directory, 'src/button.ts'), 'changed\n');
  const { patch } = await input.service.review(capsule.id);
  assert.equal(patch.includes('\x1b'), false);
  execFileSync('git', ['apply', '--check', '-'], { cwd: input.sourceDirectory, input: patch });
});
