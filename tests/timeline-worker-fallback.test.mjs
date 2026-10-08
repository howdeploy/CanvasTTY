import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('a failed timeline worker does not prevent loading persisted usage and events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ctty-timeline-worker-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const services = join(root, 'services'), data = join(root, 'data');
  await mkdir(services);
  const source = new URL('../src/main/services/', import.meta.url);
  for (const name of ['SessionTimelineService.ts', 'TimelineSearchIndex.ts', 'TimelineJournalReader.ts'])
    await copyFile(new URL(name, source), join(services, name));
  try { await copyFile(new URL('TimelineIndexScan.ts', source), join(services, 'TimelineIndexScan.ts')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(join(services, 'SessionTimelineIndexWorker.ts'), 'throw new Error("fixture worker startup failure");');
  await mkdir(join(data, 'session-timeline'), { recursive: true });
  await writeFile(join(data, 'session-timeline', '0000000000000001-fixture.ndjson'), JSON.stringify({
    id: 'event', at: 1, sessionId: 'card', type: 'usage', summary: 'Provider usage',
    detail: JSON.stringify({ input: 12, output: 7, cost: 0.25, source: 'fixture' })
  }) + '\n');
  const { SessionTimelineService } = await import(pathToFileURL(join(services, 'SessionTimelineService.ts')));
  const timeline = new SessionTimelineService(data, text => text);
  await timeline.load();
  assert.equal(timeline.usage(['card']).tokens.total, 19);
  assert.equal(timeline.usage(['card']).cost, 0.25);
  assert.equal((await timeline.page('card', undefined, 20, { query: 'Provider', types: ['usage'] })).items.length, 1);
});
