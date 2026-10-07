import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import * as collector from '../src/main/services/LocalUsageCollector.ts';

test('SQLite discovery uses absolute PATH entries, never the working directory or a shell', async () => {
  assert.equal(typeof collector.discoverSqlite, 'function');
  const seen = [];
  const result = await collector.discoverSqlite({ PATH: ':relative:/missing:/tools with spaces;literal' }, 'linux', async path => {
    seen.push(path);
    return path === '/tools with spaces;literal/sqlite3';
  });
  assert.equal(result, '/tools with spaces;literal/sqlite3');
  assert.deepEqual(seen, ['/missing/sqlite3', '/tools with spaces;literal/sqlite3']);
  assert.equal(await collector.discoverSqlite({ PATH: '' }, 'darwin', async () => true), null);
});

test('Collector resolves sqlite from supplied PATH and uses safe read-only argument-vector execution', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'sqlite-discovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.hermes'));
  await writeFile(join(home, '.hermes', 'state.db'), 'fixture');
  const executable = join(home, process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3');
  await writeFile(executable, 'fixture');
  await chmod(executable, 0o700);
  const calls = [];
  const c = new collector.LocalUsageCollector(home, {}, {}, {
    sqliteEnvironment: { PATH: home },
    sqliteRunner: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: '[]' };
    }
  });
  await c.collect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, executable);
  assert.ok(calls[0].args.includes('-safe'));
  assert.ok(calls[0].args.includes('-readonly'));
  assert.equal(calls[0].args[calls[0].args.indexOf('-init') + 1], devNull);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.env, {});
});

test('SQLite without safe mode is reported unavailable, never retried without protection', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'sqlite-old-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.hermes'));
  await writeFile(join(home, '.hermes', 'state.db'), 'fixture');
  let calls = 0;
  const c = new collector.LocalUsageCollector(home, {}, {}, {
    sqlite: join(home, 'old-sqlite3'),
    sqliteRunner: async () => { calls++; throw Object.assign(new Error('unsupported'), { stderr: 'sqlite3: Error: unknown option: -safe' }); }
  });
  const result = await c.collect();
  assert.equal(calls, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.events, []);
  assert.match(result.coverage.join('\n'), /sqlite3 lacks required -safe support/);
});

test('Missing sqlite is explicit and does not suppress independent log coverage', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'sqlite-missing-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.hermes'));
  await writeFile(join(home, '.hermes', 'state.db'), 'fixture');
  const result = await new collector.LocalUsageCollector(home, {}, {}, {
    sqliteEnvironment: { PATH: '' },
    sqliteRunner: async () => { assert.fail('must not start an executable when PATH is empty'); }
  }).collect();
  assert.equal(result.complete, false);
  assert.equal(result.lost, false);
  assert.match(result.coverage.join('\n'), /sqlite3 is unavailable \(not found on PATH\)/);
  assert.match(result.coverage.join('\n'), /Codex .*not present/);
});

test('Windows discovery handles case-insensitive Path, spaces and native exe only', async () => {
  const seen = [];
  assert.equal(await collector.discoverSqlite({ Path: ';relative;\\root-relative;C:\\missing;C:\\Program Files\\SQLite', PATHEXT: '.CMD;.EXE' }, 'win32', async path => {
    seen.push(path);
    return path === 'C:\\Program Files\\SQLite\\sqlite3.exe';
  }), 'C:\\Program Files\\SQLite\\sqlite3.exe');
  assert.deepEqual(seen, ['C:\\missing\\sqlite3.exe', 'C:\\Program Files\\SQLite\\sqlite3.exe']);
});
