// Canonical deterministic measurement of the actual coordinator/policy chain with synthetic PTYs.
// This is a development benchmark, never invoked by the application or a startup hook.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decisionRoutingFixture } from '../tests/helpers/decision-routing-fixture.mjs';
const bytes = await readFile(new URL('../tests/fixtures/decision-benchmark.json', import.meta.url));
const fixtures = JSON.parse(bytes.toString()), samples = [];
for (const item of fixtures.cases) {
 const f = await decisionRoutingFixture();
 try {
  if (item.single) f.settings.decisions.routes = f.settings.decisions.routes.slice(0, 1);
  if (item.preferCodex) f.settings.decisions.rules = [{ id: 'code', category: 'code', prefer: ['codex-local'] }];
  for (const phase of ['cold', 'warm']) {
   const cpu = process.cpuUsage(), started = performance.now(); let outcome, error = null, response = null;
   // Task text is fixture documentation only. This metadata-only benchmark does not launch free-form tasks.
   const input = { cwd: f.root, profile: 'normal', category: item.category, dataClass: item.dataClass };
   try { response = await f.coordinator.recommend(input); outcome = response.selected.provider;
    if (item.revoke) { f.settings.decisions.minConfidence = f.settings.decisions.minConfidence === .8 ? .9 : .8; try { await f.coordinator.launch(response.id); outcome = 'unexpected-launch'; } catch { outcome = 'stale-rejected'; } }
    else f.coordinator.cancel(response.id);
   } catch { outcome = null; error = 'no-eligible-route'; }
   const latencyMs = performance.now() - started, used = process.cpuUsage(cpu);
   samples.push({ fixture: item.id, phase, engine: 'rules', language: 'ru', outcome, expected: item.expected, passed: outcome === item.expected, error,
    latencyMs, processCpuMicros: used.user + used.system, processMaxRssKiB: process.resourceUsage().maxRSS, processRssBytes: process.memoryUsage().rss,
    requestBytes: Buffer.byteLength(JSON.stringify(input)), resultBytes: response ? Buffer.byteLength(JSON.stringify(response)) : 0,
    evaluatorCalls: f.evaluatorCalls(), providerProcesses: f.calls.length, secretReads: f.decisionSecretReads(), tokens: null, cost: null, taskCompletionQuality: null, searchRecall: null, mandatoryContextRetention: null });
  }
 } finally { await f.cleanup(); }
}
console.log(JSON.stringify({ schema: 1, provenance: fixtures.provenance, fixtureSha256: createHash('sha256').update(bytes).digest('hex'), runtime: process.version, platform: process.platform, architecture: process.arch, measurements: 'Wall time and process CPU/RSS are measured; process peak RSS is cumulative. Cold means first action after fixture creation, not a cold operating-system cache. Model/search/context quality and billing are unknown.', samples }, null, 2));
if (samples.some(s => !s.passed)) process.exitCode = 1;
