import test from 'node:test';
import assert from 'node:assert/strict';
import { runCapsuleTestProcess } from '../src/main/services/CapsuleTestProcess.ts';

const launch = code => ({ command: process.execPath, args: ['-e', code], cwd: process.cwd(), environment: {} });
const options = extra => ({ timeoutMs: 3000, outputBytes: 1024, signal: new AbortController().signal, assertCurrent() {}, ...extra });

test('test client captures both pipes under one total bound and preserves exit status', async () => {
  const result = await runCapsuleTestProcess(launch("process.stdout.write('stdout'); process.stderr.write('stderr'); process.exitCode = 7"), options());
  assert.equal(result.exitCode, 7); assert.match(result.output, /stdout/); assert.match(result.output, /stderr/); assert.equal(result.truncated, false);
  const bounded = await runCapsuleTestProcess(launch("process.stdout.write('x'.repeat(3000)); setInterval(() => {}, 1000)"), options());
  assert.equal(bounded.reason, 'output-limit'); assert.equal(bounded.output.length, 1024); assert.equal(bounded.truncated, true);
});

test('test client deadline, cancellation and revoked authority terminate capture', async () => {
  const timeout = await runCapsuleTestProcess(launch('setInterval(() => {}, 1000)'), options({ timeoutMs: 100 }));
  assert.equal(timeout.reason, 'timeout');
  const cancellation = new AbortController(), pending = runCapsuleTestProcess(launch('setInterval(() => {}, 1000)'), options({ signal: cancellation.signal }));
  setTimeout(() => cancellation.abort(), 50); assert.equal((await pending).reason, 'cancelled');
  let current = true;
  const revoked = runCapsuleTestProcess(launch('setInterval(() => {}, 1000)'), options({ assertCurrent() { if (!current) throw new Error('Revoked'); } }));
  current = false; assert.equal((await revoked).reason, 'cancelled');
});

test('an exited client with a descendant holding its pipes cannot hang a test run', async () => {
  const started = Date.now();
  const result = await runCapsuleTestProcess(launch("require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] }).unref(); process.exit(0)"), options());
  assert.equal(result.reason, 'failed'); assert.ok(Date.now() - started < 2800);
});
