#!/usr/bin/env node
// Deterministic synthetic terminal output; never reads application state or real secrets.
// Node 24+: node scripts/bench-redaction-optimization.mjs [--module path] [--runs 3]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const modulePath = resolve(option('--module', 'src/main/services/safety/SecretRedaction.ts'));
const digest = value => createHash('sha256').update(value).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

if (args.includes('--child')) {
  const { SecretRedactionRegistry } = await import(pathToFileURL(modulePath).href);
  const ordinaryLine = 'Compilation finished; waiting.\n';
  const padding = ordinaryLine.repeat(1_500);
  const secrets = Array.from({ length: 64 }, (_, i) => `fixture${String(i).padStart(3, '0')}Z${'abCD42'.repeat(2_700)}`);
  const registry = new SecretRedactionRegistry();
  registry.add('benchmark', secrets);
  const chunks = secrets.map(secret => padding + secret.slice(0, 8_000) + '\n│ ' + secret.slice(8_000) + '\n');
  const input = chunks.join('');
  const expected = secrets.map(() => padding + '<redacted:secret>\n').join('');
  assert.ok(input.length <= 16_000_000, 'fixture must fit the history limit');
  const started = performance.now();
  const output = registry.redact(input);
  const redactionMs = performance.now() - started;
  assert.equal(output, expected, 'whole output including all wrapped held values must remain exact');
  const ordinary = ordinaryLine.repeat(100_000);
  const ordinaryStarted = performance.now();
  assert.equal(registry.redact(ordinary), ordinary);
  const ordinaryMs = performance.now() - ordinaryStarted;
  process.stdout.write(JSON.stringify({ redaction_ms: redactionMs, ordinary_ms: ordinaryMs,
    correctness: true, input_chars: input.length, known_values: secrets.length,
    output_sha256: digest(output), max_rss_kib: process.resourceUsage().maxRSS,
    array_buffers_bytes: process.memoryUsage().arrayBuffers }));
} else {
  const runs = Number(option('--runs', '3'));
  assert.ok(Number.isSafeInteger(runs) && runs > 0 && runs <= 10);
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--max-semi-space-size=2',
      fileURLToPath(import.meta.url), '--child', '--module', modulePath], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1_000_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
    });
    assert.equal(child.status, 0, child.stderr || String(child.error));
    samples.push(JSON.parse(child.stdout));
    process.stderr.write(`redaction run ${run + 1}/${runs}: ${samples.at(-1).redaction_ms.toFixed(1)} ms\n`);
  }
  assert.ok(samples.every(sample => sample.correctness && sample.output_sha256 === samples[0].output_sha256));
  process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform,
    source_sha256: digest(readFileSync(modulePath)), runs, correctness: true,
    redaction_ms: median(samples.map(sample => sample.redaction_ms)),
    ordinary_ms: median(samples.map(sample => sample.ordinary_ms)),
    max_rss_kib: median(samples.map(sample => sample.max_rss_kib)),
    array_buffers_bytes: median(samples.map(sample => sample.array_buffers_bytes)),
    input_chars: samples[0].input_chars, output_sha256: samples[0].output_sha256, samples }, null, 2) + '\n');
}
