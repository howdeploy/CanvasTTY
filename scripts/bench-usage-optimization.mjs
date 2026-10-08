#!/usr/bin/env node
// Fresh synthetic journal, public load/usage APIs, no application data or private homes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2] ?? '.');
const { SessionTimelineService } = await import(pathToFileURL(join(root, 'src/main/services/SessionTimelineService.ts')));
const directory = await mkdtemp(join(tmpdir(), 'canvastty-usage-bench-'));
try {
  const journal = join(directory, 'session-timeline');
  await mkdir(journal);
  const sessions = 1_000, counters = 8;
  const events = [];
  for (let session = 0; session < sessions; session++) for (let counter = 0; counter < counters; counter++) {
    const sessionId = `session-${session}`;
    events.push(JSON.stringify({id: `event-${session}-${counter}`, sessionId, at: 1_000, type: 'usage', summary: 'Fixture usage',
      detail: JSON.stringify({input:100 + counter, output:10, total:110 + counter, cost:counter / 1_000,
        source:'fixture-provider', cumulative:true, counterId:`counter-${counter}`})}));
  }
  await writeFile(join(journal, '0000000000001000-fixture.ndjson'), events.join('\n') + '\n');
  const service = new SessionTimelineService(directory, text => text);
  await service.load();
  const sampleUsage = service.usage(['session-0']);
  const sampleRows = service.usageCounters('session-0');
  assert.deepEqual(sampleUsage.tokens, {input:828, output:80, total:908});
  assert.equal(sampleUsage.source, 'fixture-provider');
  assert.equal(sampleRows.length, counters);
  assert.deepEqual(sampleRows.map(row => row.legacyId), Array.from({length:counters}, (_, i) => `counter-${i}`));
  assert.equal(sampleRows.reduce((sum, row) => sum + row.tokens, 0), sampleUsage.tokens.total);
  assert.equal(sampleRows.reduce((sum, row) => sum + row.costUsd, 0), sampleUsage.cost);

  const refresh = () => {
    let tokenSum = 0, counterCount = 0;
    for (let session = 0; session < sessions; session++) {
      const id = `session-${session}`;
      const usage = service.usage([id]);
      const rows = service.usageCounters(id);
      tokenSum += usage.tokens.total; counterCount += rows.length;
    }
    return {tokenSum, counterCount};
  };
  const assertTotals = ({tokenSum, counterCount}) => {
    assert.equal(tokenSum, 908_000); assert.equal(counterCount, 8_000);
  };
  assertTotals(refresh()); // Identical warm-up before timing every sample.
  const samples = [];
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    const totals = refresh();
    samples.push(performance.now() - started);
    assertTotals(totals);
  }
  process.stdout.write(JSON.stringify({node:process.version, sessions, counters, correctness:true,
    refresh_ms:[...samples].sort((a,b)=>a-b)[1], samples, heap_used_bytes:process.memoryUsage().heapUsed}, null, 2) + '\n');
} finally { await rm(directory, {recursive:true, force:true}); }
