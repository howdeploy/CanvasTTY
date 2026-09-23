import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerExecutionService } from '../src/main/services/ContainerExecutionService.ts';
import { capsuleEngine } from './helpers/capsule-engine.mjs';

async function fixture(t, provider, kind = 'worktree') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-context-container-'))), directory = join(root, 'workspace'); await mkdir(directory);
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = { id: 'image', label: 'Image', hostId: 'local', runtime: 'docker', executable: '/usr/bin/docker', endpoint: { kind: 'unix', socket: '/run/fixture.sock' }, image: 'fixture:existing', python: '/usr/bin/python3', commands: { [provider]: `/usr/bin/${provider}` }, network: 'bridge', cpus: 1, memoryMb: 512, pids: 64, user: `${process.getuid()}:${process.getgid()}` };
  const engine = capsuleEngine(profile), registry = join(root, 'containers');
  const service = new ContainerExecutionService(() => ({ containerProfiles: [profile], remoteHosts: [] }), { rootDirectory: registry, runner: engine.runner, resolveEndpoint: engine.resolveEndpoint });
  const workspace = { kind, id: randomUUID(), directory, sourceDirectory: directory, ...(kind === 'worktree' ? { commit: 'c'.repeat(40) } : {}) };
  const metadata = { id: 'session', provider, cwd: directory, profile: 'normal', isolation: { mode: 'container', profileId: profile.id, ...(kind === 'capsule' ? { capsuleId: workspace.id } : {}) } };
  return { engine, service, registry, prepare: account => service.prepare(metadata, workspace, account, () => {}, randomUUID(), '/workspace', kind === 'capsule' ? async () => {} : undefined) };
}
const context = 'CanvasTTY standing context.\n[design] palette = "Русский `literal` $(literal)"';
const task = 'Implement ! / @ -- literal task';
test('actual container recipes retain context and use only the owned Task.md instruction for selected-file capsules', async t => {
  for (const provider of ['opencode', 'minimax', 'omp']) for (const kind of ['worktree', 'capsule']) {
    const f = await fixture(t, provider, kind);
    const account = { args: [], environment: {}, startup: { context, task }, ...(provider === 'minimax' ? {} : { model: 'fixture/model' }) };
    const prepared = await f.prepare(account), recipe = JSON.parse(f.engine.calls.find(call => call.args.includes('create')).environment.CANVASTTY_CONTAINER_RECIPE);
    assert.equal(recipe.args.filter(arg => arg.includes(context)).length, 1, `${provider}/${kind}`);
    if (provider === 'omp') assert.deepEqual(recipe.args.slice(0, 2), ['--append-system-prompt', context]);
    if (kind === 'capsule') { assert.match(recipe.args.at(-1), /Read \/workspace\/Task.md/); assert.ok(!recipe.args.at(-1).includes(task)); }
    else assert.ok(recipe.args.at(-1).endsWith(`CanvasTTY task:\n${task}`));
    assert.ok(!recipe.args.includes('--print'));
    for (const name of (await readdir(f.registry)).filter(name => name.endsWith('.json'))) {
      const saved = await readFile(join(f.registry, name), 'utf8'); assert.ok(!saved.includes(context)); assert.ok(!saved.includes(task));
    }
    await prepared.cleanup();
  }
});
test('complete serialized container recipe over bootstrap limit rejects before engine create', async t => {
  const f = await fixture(t, 'opencode');
  await assert.rejects(f.prepare({ args: ['--fixture', 'x'.repeat(16000)], environment: {}, startup: { context: 'c'.repeat(50000), task } }), /recipe|bound/);
  assert.equal(f.engine.calls.some(call => call.args.includes('create')), false);
});
