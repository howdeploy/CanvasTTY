import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalUsageCollector, discoverSqlite } from '../src/main/services/LocalUsageCollector.ts';

const SQLITE = await discoverSqlite();
let needsSqlite = SQLITE ? false : 'requires sqlite3 on PATH';
if (SQLITE) {
  try { execFileSync(SQLITE, ['-safe', '-init', devNull, '-json', ':memory:', 'SELECT 1'], { env: {}, stdio: 'pipe' }); }
  catch { needsSqlite = 'requires sqlite3 with -safe and -json support'; }
}
const MINUTE = 60_000, DAY = 86_400_000;
const T0 = Math.floor(Date.now() / 1000) * 1000 - 30 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();
const seconds = (ms) => ms / 1000;

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'usage-collector-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
/** Names and content hashes of every file below `dir` (symlinks are not followed). */
async function snapshot(dir) {
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    out[path] = entry.isFile() ? createHash('sha256').update(await readFile(path)).digest('hex') : entry.isSymbolicLink() ? 'link' : 'dir';
  }
  return out;
}
/** Collects and asserts that no source file was created, removed or changed. */
async function collectUntouched(collector, now, home) {
  const before = await snapshot(home);
  const result = await collector.collect(now);
  assert.deepEqual(await snapshot(home), before, 'collection must not modify any source store');
  assert.equal(JSON.stringify([result, collector.state]).includes('PRIVATE'), false, 'no conversation content may leave the collector');
  return result;
}

// ---- Hermes fixtures: the Hermes accounting schema (sessions + session_model_usage) with conversation columns.
const sql = (db, statement) => execFileSync(SQLITE, ['-init', devNull, db, statement], { env: {}, shell: false });
const SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'cli', model TEXT, system_prompt TEXT, title TEXT,
  started_at REAL NOT NULL DEFAULT 0, ended_at REAL, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0,
  billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL, api_call_count INTEGER DEFAULT 0);
CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT);
CREATE TABLE session_model_usage (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, model TEXT NOT NULL,
  billing_provider TEXT NOT NULL DEFAULT '', billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0,
  cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL,
  PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task));
CREATE INDEX idx_session_model_usage_session ON session_model_usage(session_id);
`;
const session = (id, provider, [i, o, cr, cw], started) => `
INSERT INTO sessions (id, model, system_prompt, title, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider, billing_base_url, billing_mode)
  VALUES ('${id}', 'model', 'PRIVATE-PROMPT', 'PRIVATE-TITLE ${id}', ${seconds(started)}, ${i}, ${o}, ${cr}, ${cw}, 7, '${provider}', 'https://example.invalid/v1', '');
INSERT INTO messages (session_id, role, content) VALUES ('${id}', 'user', 'PRIVATE-MESSAGE');`;
const modelRow = (id, model, provider, task, [i, o, cr, cw], first, last) => `
INSERT INTO session_model_usage (session_id, model, billing_provider, billing_base_url, billing_mode, task, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen)
  VALUES ('${id}', '${model}', '${provider}', 'https://example.invalid/v1', '${provider === 'openai-codex' ? 'subscription_included' : ''}', '${task}', 1, ${i}, ${o}, ${cr}, ${cw}, 3, ${seconds(first)}, ${seconds(last)});`;
const hermesDb = async (dir, statements) => {
  await mkdir(dir, { recursive: true });
  const db = join(dir, 'state.db');
  sql(db, SCHEMA + statements);
  return db;
};
const brief = (events) => events.map((e) => [e.session, e.provider, e.profile, e.input, e.output, e.cached, e.from, e.to, e.timing, e.app]);

test('Hermes: baseline on first observation, per-model rows instead of aggregates, poll deltas with cache, stable ids', { skip: needsSqlite }, async (t) => {
  const home = await fixture(t);
  const db = await hermesDb(join(home, '.hermes'), [
    session('s1', 'openai-codex', [1000, 100, 200, 0], T0 - DAY),
    modelRow('s1', 'gpt-5.5', 'openai-codex', '', [900, 90, 200, 0], T0 - DAY, T0 - DAY),
    modelRow('s1', 'gemini-flash', 'openrouter', 'title_generation', [100, 10, 0, 0], T0 - DAY, T0 - DAY),
    session('s2', 'anthropic', [500, 50, 0, 0], T0 - DAY),
  ].join(''));
  const collector = new LocalUsageCollector(home, {}, {});
  const first = await collectUntouched(collector, T0, home);
  assert.deepEqual(first.events, [], 'existing cumulative counters are never allocated retrospectively');
  assert.match(first.coverage.join('\n'), /Hermes default: 2 per-model rows; 1 session aggregates without per-model rows; first observation, counters baselined\./);

  sql(db, `
    UPDATE session_model_usage SET input_tokens = 1000, output_tokens = 100, cache_read_tokens = 250, last_seen = ${seconds(T0 + 30_000)} WHERE session_id = 's1' AND task = '';
    UPDATE sessions SET input_tokens = 1100, output_tokens = 110, cache_read_tokens = 250 WHERE id = 's1';
    UPDATE sessions SET input_tokens = 520, output_tokens = 55 WHERE id = 's2';`
    + session('s3', 'anthropic', [300, 30, 0, 10], T0 + 40_000) + modelRow('s3', 'claude-opus-5', 'anthropic', '', [300, 30, 0, 10], T0 + 40_000, T0 + 40_000)
    + session('s4', 'openai-codex', [5000, 500, 0, 0], T0 - 7 * DAY) + modelRow('s4', 'gpt-5.5', 'openai-codex', '', [5000, 500, 0, 0], T0 - 7 * DAY, T0 + 45_000));
  const second = await collectUntouched(collector, T0 + MINUTE, home);
  assert.deepEqual(brief(second.events), [
    ['s1', 'codex', 'default', 150, 10, 50, T0, T0 + 30_000, 'poll-delta', 'Hermes'],
    ['s3', 'unknown', 'default', 310, 30, 0, T0, T0 + 40_000, 'poll-delta', 'Hermes'],
    ['s2', 'unknown', 'default', 20, 5, 0, T0, T0 + MINUTE, 'poll-delta', 'Hermes'],
  ], 'aggregate of s1 is not added; s3 was created after the last poll; s4 only appeared (older first_seen) and is baselined');

  assert.deepEqual((await collectUntouched(collector, T0 + 2 * MINUTE, home)).events, []);
  sql(db, `UPDATE session_model_usage SET input_tokens = 10 WHERE session_id = 's1' AND task = ''`);
  assert.deepEqual((await collectUntouched(collector, T0 + 3 * MINUTE, home)).events, [], 'a decrease rebaselines');
  sql(db, `UPDATE session_model_usage SET input_tokens = 20 WHERE session_id = 's1' AND task = ''`);

  const persisted = JSON.parse(JSON.stringify(collector.state));
  const replay = new LocalUsageCollector(home, persisted, {});
  const fourth = await collectUntouched(collector, T0 + 4 * MINUTE, home);
  assert.deepEqual(brief(fourth.events), [['s1', 'codex', 'default', 10, 0, 0, T0 + 3 * MINUTE, T0 + 30_000 > T0 + 3 * MINUTE ? 0 : T0 + 4 * MINUTE, 'poll-delta', 'Hermes']]);
  assert.deepEqual((await replay.collect(T0 + 4 * MINUTE)).events.map((e) => e.id), fourth.events.map((e) => e.id),
    'recomputing from the same persisted baseline yields the same event ids (history deduplicates a lost commit)');
});

test('Hermes discovery: default, profiles (symlinks followed, dot entries ignored), HERMES_HOME root; clones counted once', { skip: needsSqlite }, async (t) => {
  const home = await fixture(t);
  const profiles = join(home, '.hermes', 'profiles');
  const defaultDb = await hermesDb(join(home, '.hermes'), session('dup', 'openai-codex', [100, 10, 0, 0], T0 - DAY) + modelRow('dup', 'gpt-5.5', 'openai-codex', '', [100, 10, 0, 0], T0 - DAY, T0 - DAY));
  const workDb = await hermesDb(join(home, 'elsewhere', 'work-home'), session('dup', 'openai-codex', [100, 10, 0, 0], T0 - DAY) + modelRow('dup', 'gpt-5.5', 'openai-codex', '', [100, 10, 0, 0], T0 - DAY, T0 - DAY)
    + session('w1', 'openai-codex', [5, 1, 0, 0], T0 - DAY) + modelRow('w1', 'gpt-5.5', 'openai-codex', '', [5, 1, 0, 0], T0 - DAY, T0 - DAY));
  await mkdir(profiles, { recursive: true });
  await symlink(join(home, 'elsewhere', 'work-home'), join(profiles, 'work'));
  await symlink(join(profiles, 'work'), join(profiles, 'alias'));
  const deletedDb = await hermesDb(join(profiles, '.deleted'), session('gone', 'openai-codex', [1, 1, 0, 0], T0 - DAY));
  await mkdir(join(profiles, 'ghost'));
  await symlink(join(home, 'missing.db'), join(profiles, 'ghost', 'state.db'));
  const customRoot = join(home, 'custom-root');
  const customDb = await hermesDb(customRoot, session('c1', 'anthropic', [1, 1, 0, 0], T0 - DAY));
  const teamDb = await hermesDb(join(customRoot, 'profiles', 'team'), session('t1', 'nous', [1, 1, 0, 0], T0 - DAY));
  const environment = { HERMES_HOME: join(customRoot, 'profiles', 'team') };

  const collector = new LocalUsageCollector(home, {}, environment);
  const first = await collectUntouched(collector, T0, home);
  const hermesLines = first.coverage.filter((line) => line.startsWith('Hermes '));
  assert.deepEqual(hermesLines.map((line) => line.split(':')[0]), ['Hermes default', 'Hermes work', 'Hermes custom-root', 'Hermes team']);
  assert.match(first.coverage.join('\n'), /Hermes: 1 session ids appear in several databases; counted once\./);

  for (const db of [defaultDb, workDb]) sql(db, `UPDATE session_model_usage SET input_tokens = 200 WHERE session_id = 'dup'`);
  sql(workDb, `UPDATE session_model_usage SET input_tokens = 15 WHERE session_id = 'w1'`);
  sql(customDb, `UPDATE sessions SET input_tokens = 21 WHERE id = 'c1'`);
  sql(teamDb, `UPDATE sessions SET input_tokens = 31 WHERE id = 't1'`);
  sql(deletedDb, `UPDATE sessions SET input_tokens = 999 WHERE id = 'gone'`);
  const second = await collectUntouched(collector, T0 + MINUTE, home);
  const bySession = Object.fromEntries(second.events.map((e) => [e.session, e]));
  assert.deepEqual(Object.keys(bySession).sort(), ['c1', 'dup', 'dup' in bySession ? 't1' : 't1', 'w1'].sort());
  assert.equal(second.events.filter((e) => e.session === 'dup').length, 1, 'a cloned session id is not double counted');
  assert.equal(bySession.dup.input, 100);
  assert.deepEqual([bySession.w1.profile, bySession.c1.profile, bySession.t1.profile], ['work', 'custom-root', 'team']);
  assert.deepEqual([bySession.c1.provider, bySession.t1.provider], ['unknown', 'unknown']);
  assert.equal(existsSync(join(home, 'missing.db')), false, 'a dangling state.db is never created');
});

test('Hermes errors are reported in coverage: corrupt file, unsupported schema, invalid counters, missing sqlite3', { skip: needsSqlite }, async (t) => {
  const home = await fixture(t);
  await mkdir(join(home, '.hermes'), { recursive: true });
  await writeFile(join(home, '.hermes', 'state.db'), 'this is not a database file, only some text that is long enough');
  await mkdir(join(home, '.hermes', 'profiles', 'odd'), { recursive: true });
  sql(join(home, '.hermes', 'profiles', 'odd', 'state.db'), 'CREATE TABLE notes (body TEXT)');
  const okDb = await hermesDb(join(home, '.hermes', 'profiles', 'ok'), session('good', 'openai-codex', [1, 1, 0, 0], T0 - DAY)
    + modelRow('good', 'gpt-5.5', 'openai-codex', '', [10, 1, 0, 0], T0 - DAY, T0 - DAY)
    + session('bad', 'openai-codex', [1, 1, 0, 0], T0 - DAY)
    + `INSERT INTO session_model_usage (session_id, model, input_tokens, output_tokens) VALUES ('bad', 'm', 'lots', 1), ('bad', 'n', -4, 1), ('bad', 'o', 1.5, 1);`);

  const collector = new LocalUsageCollector(home, {}, {});
  const first = await collectUntouched(collector, T0, home);
  const coverage = first.coverage.join('\n');
  assert.match(coverage, /Hermes default: database is corrupt or not SQLite; not collected this time\./);
  assert.match(coverage, /Hermes odd: unsupported accounting schema; not collected this time\./);
  // 'bad' has only invalid per-model rows, so its session aggregate exceeds them and is reported, never counted.
  assert.match(coverage, /Hermes ok: 1 per-model rows; first observation, counters baselined; 1 sessions with aggregate usage beyond their per-model rows \(difference not counted\); 3 rows with invalid counters skipped\./);

  sql(okDb, `UPDATE session_model_usage SET input_tokens = 25 WHERE session_id = 'good'`);
  const second = await collectUntouched(collector, T0 + MINUTE, home);
  assert.deepEqual(second.events.map((e) => [e.session, e.input]), [['good', 15]]);

  const missing = new LocalUsageCollector(home, {}, {}, { sqlite: join(home, 'no-such-sqlite3') });
  const result = await missing.collect(T0);
  assert.deepEqual(result.events, []);
  assert.equal(result.coverage.filter((line) => line.includes('sqlite3 is unavailable')).length, 3);
});

test('Hermes queries select accounting columns only, read-only, and never touch conversation tables', { skip: needsSqlite }, async (t) => {
  const home = await fixture(t);
  await hermesDb(join(home, '.hermes'), session('s', 'openai-codex', [1, 1, 0, 0], T0) + modelRow('s', 'gpt-5.5', 'openai-codex', '', [1, 1, 0, 0], T0, T0));
  const argumentsSeen = [];
  await new LocalUsageCollector(home, {}, {}, {
    sqlite: SQLITE,
    sqliteRunner: async (file, args, options) => {
      argumentsSeen.push(...args);
      return { stdout: execFileSync(file, args, { ...options, encoding: 'utf8' }) };
    }
  }).collect(T0);
  const statements = argumentsSeen.filter((argument) => /^\s*SELECT/i.test(argument));
  assert.equal(statements.length, 2);
  assert.ok(argumentsSeen.includes('-readonly') && argumentsSeen.includes('-safe') && argumentsSeen.some((a) => /^file:.*\?mode=ro&readonly_shm=1$/.test(a)));
  for (const statement of statements) {
    assert.doesNotMatch(statement, /\*|system_prompt|title|messages|content|INSERT|UPDATE|DELETE|CREATE|DROP|ATTACH|PRAGMA\s/i);
  }
});

test('Hermes WAL stores: live writer, stopped writer without -wal/-shm, and orphaned WAL never gain side files', { skip: needsSqlite }, async (t) => {
  const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
  if (!DatabaseSync) return t.skip('node:sqlite unavailable');
  const home = await fixture(t);
  const dir = join(home, '.hermes'), path = join(dir, 'state.db');
  await mkdir(dir);
  const writer = new DatabaseSync(path);
  writer.exec('PRAGMA journal_mode=WAL;' + SCHEMA + session('w', 'openai-codex', [0, 0, 0, 0], T0 - DAY) + modelRow('w', 'gpt-5.5', 'openai-codex', '', [100, 10, 0, 0], T0 - DAY, T0 - DAY));
  const collector = new LocalUsageCollector(home, {}, {});
  await collectUntouched(collector, T0, home);

  writer.exec(`BEGIN IMMEDIATE; UPDATE session_model_usage SET input_tokens = 150`);
  assert.deepEqual((await collectUntouched(collector, T0 + MINUTE, home)).events, [], 'an open write transaction is invisible and does not block');
  writer.exec('COMMIT');
  assert.deepEqual((await collectUntouched(collector, T0 + 2 * MINUTE, home)).events.map((e) => e.input), [50]);

  writer.exec(`UPDATE session_model_usage SET input_tokens = 180`);
  writer.close();
  assert.deepEqual((await readdir(dir)).sort(), ['state.db'], 'a stopped writer removed -wal/-shm');
  const stopped = await collectUntouched(collector, T0 + 3 * MINUTE, home);
  assert.deepEqual(stopped.events.map((e) => e.input), [30]);
  assert.deepEqual((await readdir(dir)).sort(), ['state.db']);

  await writeFile(`${path}-wal`, Buffer.alloc(4096, 1));
  const orphaned = await collectUntouched(collector, T0 + 4 * MINUTE, home);
  assert.match(orphaned.coverage.join('\n'), /Hermes default: WAL without shared-memory index/);
  assert.deepEqual((await readdir(dir)).sort(), ['state.db', 'state.db-wal']);
});

// ---- JSONL fixtures
const NOW = Math.floor(Date.now() / 1000) * 1000;
const tokens = ([input, cached, output]) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: Math.floor(output / 2), total_tokens: input + output });
const codexMeta = (id, at, originator = 'codex_cli_rs') => JSON.stringify({ timestamp: iso(at), type: 'session_meta', payload: { id, timestamp: iso(at), cwd: '/private/PRIVATE', originator, cli_version: '0.50.0', instructions: 'PRIVATE-INSTRUCTIONS', source: 'cli', model_provider: 'openai' } });
const codexPrompt = (at) => JSON.stringify({ timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE-PROMPT' }] } });
const codexCount = (at, total, last, extra = {}) => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tokens(total), last_token_usage: tokens(last), model_context_window: 258_400 }, rate_limits: null, ...extra } });
/** Cumulative token_count lines for successive requests. */
function lineage(start, requests) {
  let total = [0, 0, 0];
  return requests.map((request, index) => {
    total = total.map((value, k) => value + request[k]);
    return codexCount(start + index * MINUTE, total, request);
  });
}
const rollout = (home, name, folder = 'sessions/2026/09/20') => join(home, '.codex', folder, `rollout-2026-09-20T10-00-00-${name}.jsonl`);
const write = async (path, lines, tail = '\n') => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, lines.join('\n') + tail); };
const inputs = (events) => events.map((e) => e.input);

test('Codex logs: partial lines, completed tails, oversized and unparsable lines, repeated polls and window', async (t) => {
  const home = await fixture(t);
  const id = randomUUID(), path = rollout(home, id), start = NOW - 60 * MINUTE;
  const requests = [[1000, 0, 50], [300, 200, 20], [400, 300, 30], [500, 400, 40], [600, 500, 50], [700, 600, 60], [800, 700, 70], [900, 800, 80]];
  const counts = lineage(start, requests);
  await write(path, [codexMeta(id, start - MINUTE), codexPrompt(start), counts[0], counts[1], counts[2].slice(0, 40)], '');
  const collector = new LocalUsageCollector(home, {}, {});
  const first = await collectUntouched(collector, NOW, home);
  assert.deepEqual(inputs(first.events), [1000, 300], 'the partial third record is not consumed');
  assert.deepEqual([first.events[0].session, first.events[0].app, first.events[0].profile, first.events[0].provider], [id, 'Codex CLI', 'default', 'codex']);

  await appendFile(path, counts[2].slice(40) + '\n' + counts[3] + '\n');
  assert.deepEqual(inputs((await collectUntouched(collector, NOW, home)).events), [400, 500]);
  assert.deepEqual((await collectUntouched(collector, NOW, home)).events, [], 'an unchanged file is not re-read');

  await appendFile(path, counts[4]);
  assert.deepEqual(inputs((await collectUntouched(collector, NOW, home)).events), [600], 'a complete final object without newline is consumed');
  const huge = codexCount(start + 5 * MINUTE, [4400, 2600, 330], requests[5], { padding: 'x'.repeat(17 * 1024 * 1024) });
  await appendFile(path, '\n' + huge + '\n{"type":"event_msg","payload":{"type":"token_count" BROKEN\n' + counts[6] + '\n');
  const skipped = await collectUntouched(collector, NOW, home);
  assert.deepEqual(inputs(skipped.events), [700 + 800], 'the oversized record is skipped; the next cumulative difference still covers it');
  assert.match(skipped.coverage.join('\n'), /Codex ~\/\.codex\/sessions: 1 logs in window, 1 read \(\d+\.\d MiB\), 1 unparsable accounting lines, 1 oversized lines skipped\./);

  await appendFile(path, codexCount(NOW + 10 * MINUTE, [6000, 4000, 500], [100, 0, 10]) + '\n');
  assert.deepEqual((await collectUntouched(collector, NOW, home)).events, [], 'records from the future are not usage');

  const old = rollout(home, randomUUID());
  await write(old, [codexMeta('old', NOW - 40 * DAY), ...lineage(NOW - 40 * DAY, [[5, 0, 5]])]);
  await utimes(old, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
  const resumed = new LocalUsageCollector(home, JSON.parse(JSON.stringify(collector.state)), {});
  assert.deepEqual((await collectUntouched(resumed, NOW, home)).events, [], 'persisted cursors resume; logs outside the 30-day window are skipped');
});

test('Codex logs: truncation, in-place rewrite, replacement and archiving keep cursors safe', async (t) => {
  const home = await fixture(t);
  const id = randomUUID(), path = rollout(home, id), start = NOW - 50 * MINUTE;
  const counts = lineage(start, [[100, 0, 10], [200, 0, 20], [300, 0, 30]]);
  await write(path, [codexMeta(id, start), ...counts]);
  const collector = new LocalUsageCollector(home, {}, {});
  const all = await collectUntouched(collector, NOW, home);
  const seen = new Set(all.events.map((e) => e.id));
  assert.equal(all.events.length, 3);

  await writeFile(path, [codexMeta(id, start), counts[0]].join('\n') + '\n');
  const truncated = await collectUntouched(collector, NOW, home);
  assert.deepEqual(inputs(truncated.events), [100]);
  assert.equal(truncated.lost, true, 'truncation may remove unread accounting; a replay cannot certify completeness');
  assert.equal(truncated.complete, false);
  assert.ok(truncated.events.every((e) => seen.has(e.id)), 're-reading after truncation repeats stable ids only');

  const other = randomUUID();
  await writeFile(path, [codexMeta(other, start), ...lineage(start, [[7, 0, 1], [8, 0, 1], [9, 0, 1], [10, 0, 1]])].join('\n') + '\n');
  assert.deepEqual(inputs((await collectUntouched(collector, NOW, home)).events), [7, 8, 9, 10], 'a rewritten head resets the cursor');

  await writeFile(path + '.tmp', [codexMeta(id, start), ...counts].join('\n') + '\n');
  await rename(path + '.tmp', path);
  const replaced = await collectUntouched(collector, NOW, home);
  assert.deepEqual(inputs(replaced.events), [100, 200, 300]);
  assert.ok(replaced.events.every((e) => seen.has(e.id)));

  const archived = rollout(home, id, 'archived_sessions');
  await mkdir(dirname(archived), { recursive: true });
  await rename(path, archived);
  const moved = await collectUntouched(collector, NOW, home);
  assert.deepEqual(moved.events, [], 'an archived (renamed) rollout keeps its cursor');
  assert.match(moved.coverage.join('\n'), /Codex ~\/\.codex\/archived_sessions: 1 logs in window, 0 read/);
  await appendFile(archived, codexCount(start + 3 * MINUTE, [1000, 0, 100], [400, 0, 40]) + '\n');
  assert.deepEqual(inputs((await collectUntouched(collector, NOW, home)).events), [400]);
});

test('Codex logs: forked and resumed rollouts, Hermes runtime rollouts, symlinked and looping directories, CODEX_HOME', async (t) => {
  const home = await fixture(t);
  const parent = randomUUID(), start = NOW - 50 * MINUTE;
  const parentCounts = lineage(start, [[1000, 0, 100], [500, 400, 50]]);
  await write(rollout(home, parent), [codexMeta(parent, start), codexPrompt(start), ...parentCounts]);
  const fork = randomUUID(), forkedAt = NOW - 20 * MINUTE;
  const rewritten = (line) => JSON.stringify({ ...JSON.parse(line), timestamp: iso(forkedAt) });
  await write(rollout(home, fork, 'sessions/2026/09/21'), [
    codexMeta(fork, forkedAt), rewritten(codexMeta(parent, start)), rewritten(codexPrompt(start)), ...parentCounts.map(rewritten),
    codexCount(forkedAt + MINUTE, [1800, 700, 190], [300, 300, 40]),
  ]);
  const resumed = randomUUID();
  await write(rollout(home, resumed, 'sessions/2026/09/21'), [codexMeta(resumed, NOW - 10 * MINUTE), codexCount(NOW - 9 * MINUTE, [90_000, 80_000, 4000], [3000, 2500, 120])]);
  const hermes = randomUUID();
  await write(rollout(home, hermes), [codexMeta(hermes, start, 'hermes'), ...lineage(start, [[999, 0, 99]])]);

  const external = join(home, 'external-sessions');
  const linked = randomUUID();
  await write(join(external, `rollout-${linked}.jsonl`), [codexMeta(linked, start), ...lineage(start, [[11, 0, 1]])]);
  await symlink(external, join(home, '.codex', 'sessions', 'linked'));
  await symlink(join(home, '.codex', 'sessions'), join(home, '.codex', 'sessions', '2026', 'loop'));
  const codexHome = join(home, 'codex-work');
  const work = randomUUID();
  await write(join(codexHome, 'sessions', `rollout-${work}.jsonl`), [codexMeta(work, start), ...lineage(start, [[22, 0, 2]])]);
  await symlink(join(home, '.codex'), join(home, 'codex-alias'));

  const collector = new LocalUsageCollector(home, {}, { CODEX_HOME: codexHome });
  const result = await collectUntouched(collector, NOW, home);
  const bySession = (session) => result.events.filter((e) => e.session === session).map((e) => [e.input, e.output]);
  assert.deepEqual(bySession(parent), [[1000, 100], [500, 50]]);
  assert.deepEqual(bySession(fork), [[300, 40]], 'the copied parent history is not counted again');
  assert.deepEqual(bySession(resumed), [[3000, 120]], 'the first reading of a resumed lineage counts only its last request');
  assert.deepEqual(bySession(hermes), []);
  assert.deepEqual(bySession(linked), [[11, 1]]);
  assert.deepEqual(result.events.filter((e) => e.session === work).map((e) => e.profile), ['codex-work']);
  assert.match(result.coverage.join('\n'), /1 Hermes runtime rollouts excluded/);

  const aliased = await collectUntouched(new LocalUsageCollector(home, {}, { CODEX_HOME: join(home, 'codex-alias') }), NOW, home);
  assert.equal(aliased.events.length, result.events.length - 1, 'a CODEX_HOME alias of ~/.codex is read once');
});

test('Codex logs: independent sessions with equal counters both count; duplicate copies of one rollout count once', async (t) => {
  const home = await fixture(t);
  const start = NOW - 40 * MINUTE, requests = [[1000, 0, 100], [500, 400, 60]];
  const a = randomUUID(), b = randomUUID();
  await write(rollout(home, a), [codexMeta(a, start), ...lineage(start, requests)]);
  await write(rollout(home, b, 'sessions/2026/09/21'), [codexMeta(b, start + MINUTE), ...lineage(start + MINUTE, requests)]);
  // A byte-identical copy (another inode) of rollout a, e.g. restored from a backup into archived_sessions.
  await write(rollout(home, a, 'archived_sessions'), [codexMeta(a, start), ...lineage(start, requests)]);
  const collector = new LocalUsageCollector(home, {}, {});
  const result = await collectUntouched(collector, NOW, home);
  const bySession = (session) => result.events.filter((e) => e.session === session).map((e) => [e.input, e.output]);
  assert.deepEqual(bySession(a), [[1000, 100], [500, 60]], 'the copy of a is not counted again');
  assert.deepEqual(bySession(b), [[1000, 100], [500, 60]], 'b is not collapsed into a by equal counters');
  assert.equal(new Set(result.events.map((e) => e.id)).size, 4);
  assert.deepEqual((await collectUntouched(new LocalUsageCollector(home, JSON.parse(JSON.stringify(collector.state)), {}), NOW, home)).events, [],
    'persisted cursors neither re-emit nor rebaseline');
});

const CLAUDE_SESSION = randomUUID();
const assistant = (id, at, [input, read, write, output], extra = {}) => JSON.stringify({
  parentUuid: null, isSidechain: false, userType: 'external', cwd: '/private/PRIVATE', sessionId: CLAUDE_SESSION, version: '2.1.0',
  type: 'assistant', uuid: randomUUID(), timestamp: iso(at), requestId: `req_${id}`,
  message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'PRIVATE-ANSWER' }], stop_reason: null,
    usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output, service_tier: 'standard' } },
  ...extra,
});
const human = (at) => JSON.stringify({ type: 'user', sessionId: CLAUDE_SESSION, timestamp: iso(at), uuid: randomUUID(), message: { role: 'user', content: 'PRIVATE-PROMPT' } });

test('Claude transcripts: streamed updates, idle flush, copied transcripts, subagents and all config roots', async (t) => {
  const home = await fixture(t);
  const project = join(home, '.claude', 'projects', '-Users-me-PRIVATE-project');
  const main = join(project, `${CLAUDE_SESSION}.jsonl`), start = NOW - 30 * MINUTE;
  await write(main, [human(start), assistant('msg_1', start + 1000, [5, 1000, 200, 1]), assistant('msg_1', start + 4000, [5, 1000, 200, 300]), human(start + 5000),
    assistant('msg_2', start + 9000, [7, 1400, 0, 2])]);
  const collector = new LocalUsageCollector(home, {}, {});
  const first = await collectUntouched(collector, NOW, home);
  assert.deepEqual(first.events.map((e) => [e.input, e.cached, e.output, e.from, e.to, e.session, e.provider, e.app]),
    [[1205, 1000, 300, start + 1000, start + 4000, CLAUDE_SESSION, 'claude', 'Claude Code']], 'msg_2 may still stream and waits');

  await appendFile(main, assistant('msg_2', start + 12_000, [7, 1400, 0, 90]) + '\n');
  assert.deepEqual((await collectUntouched(collector, NOW, home)).events, [], 'still recently modified');
  const idle = await collectUntouched(collector, NOW + 10 * MINUTE, home);
  assert.deepEqual(idle.events.map((e) => [e.input, e.output]), [[1407, 90]], 'an idle transcript flushes its last message with the final usage');

  const copy = join(home, '.claude', 'projects', '-Users-me-other', `${randomUUID()}.jsonl`);
  await write(copy, [assistant('msg_1', start + 4000, [5, 1000, 200, 300]), assistant('msg_2', start + 12_000, [7, 1400, 0, 90]), assistant('msg_3', NOW - MINUTE, [1, 0, 0, 1])]);
  const subagent = join(project, CLAUDE_SESSION, 'subagents', 'agent-a1b2.jsonl');
  await write(subagent, [assistant('msg_sub', start + 20_000, [50, 0, 0, 5], { isSidechain: true }), assistant('msg_sub2', start + 25_000, [60, 0, 0, 6], { isSidechain: true })]);
  const xdg = join(home, '.config', 'claude', 'projects', 'p', `${randomUUID()}.jsonl`);
  await write(xdg, [assistant('msg_xdg', start, [9, 0, 0, 9]), assistant('msg_xdg2', start + 1000, [8, 0, 0, 8])]);
  const later = await collectUntouched(collector, NOW + 10 * MINUTE, home);
  const ids = new Set([...first.events, ...idle.events].map((e) => e.id));
  const copied = later.events.filter((e) => ids.has(e.id));
  assert.equal(copied.length, 2, 'copied messages keep their stable ids, so the history deduplicates them');
  assert.deepEqual(later.events.filter((e) => !ids.has(e.id)).map((e) => e.input).sort((a, b) => a - b), [1, 8, 9, 50, 60]);
});

test('Claude print-mode (-p) sessions with normal persistence are collected once as Claude Code', async (t) => {
  const home = await fixture(t);
  // Shape of a persisted `claude -p` worker transcript (Claude Code 2.1.x, entrypoint sdk-cli), accounting fields verbatim.
  const session = randomUUID(), project = join(home, '.claude', 'projects', '-private-var-folders-xx-T');
  const start = NOW - 30 * MINUTE;
  const common = { parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd: '/private/PRIVATE', sessionId: session, version: '2.1.276' };
  const usage = { input_tokens: 2, cache_creation_input_tokens: 11396, cache_read_input_tokens: 18487, output_tokens: 465,
    output_tokens_details: { thinking_tokens: 131 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: 11396, ephemeral_5m_input_tokens: 0 }, inference_geo: 'not_available',
    iterations: [{ input_tokens: 2, cache_creation_input_tokens: 11396, cache_read_input_tokens: 18487, output_tokens: 465, type: 'message' }], speed: 'standard' };
  const streamed = (at, type) => JSON.stringify({ ...common, type: 'assistant', uuid: randomUUID(), timestamp: iso(at), requestId: 'req_print',
    message: { model: 'claude-opus-5', id: 'msg_print', type: 'message', role: 'assistant', content: [{ type, text: 'PRIVATE-ANSWER' }], stop_reason: null, usage } });
  await write(join(project, `${session}.jsonl`), [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(start), sessionId: session, content: 'PRIVATE-PROMPT' }),
    JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: iso(start), sessionId: session }),
    JSON.stringify({ ...common, type: 'user', uuid: randomUUID(), timestamp: iso(start), message: { role: 'user', content: 'PRIVATE-PROMPT' } }),
    JSON.stringify({ ...common, type: 'attachment', uuid: randomUUID(), timestamp: iso(start), attachment: { type: 'total_tokens_reminder', text: 'PRIVATE' } }),
    streamed(start + 5000, 'thinking'), streamed(start + 9700, 'text'),
    JSON.stringify({ type: 'last-prompt', sessionId: session, lastPrompt: 'PRIVATE-PROMPT' }),
  ]);
  const collector = new LocalUsageCollector(home, {}, {});
  assert.deepEqual((await collectUntouched(collector, NOW, home)).events, [], 'the last message waits until the transcript idles');
  const result = await collectUntouched(collector, NOW + 10 * MINUTE, home);
  assert.deepEqual(result.events.map((e) => [e.provider, e.app, e.session, e.profile, e.input, e.cached, e.output, e.from, e.to, e.timing]),
    [['claude', 'Claude Code', session, 'default', 2 + 18487 + 11396, 18487, 465, start + 5000, start + 9700, 'event']],
    'one message; iterations and nested details are not added again; no Hermes attribution without provenance');
  assert.match(result.coverage.join('\n'), /Claude Code ~\/\.claude\/projects: 1 logs in window, 0 read/);
  assert.deepEqual((await collectUntouched(collector, NOW + 20 * MINUTE, home)).events, [], 'the flushed message is not emitted again');
});

test('Collector: byte budget resumes backlog, overlapping calls do not duplicate, unreadable files and corrupt state are safe', async (t) => {
  const home = await fixture(t);
  const id = randomUUID(), path = rollout(home, id), start = NOW - 100 * MINUTE;
  await write(path, [codexMeta(id, start), ...lineage(start, Array.from({ length: 60 }, (_, k) => [100 + k, 0, 10]))]);
  const reference = (await new LocalUsageCollector(home, {}, {}).collect(NOW)).events.map((e) => e.id);
  assert.equal(reference.length, 60);

  const budgeted = new LocalUsageCollector(home, {}, {}, { byteBudget: 4096 });
  const collected = [];
  let rounds = 0, deferred = false;
  for (; rounds < 50; rounds++) {
    const result = await budgeted.collect(NOW);
    collected.push(...result.events.map((e) => e.id));
    deferred ||= result.coverage.some((line) => line.startsWith('Logs: read budget reached'));
    if (!result.events.length && rounds > 0) break;
  }
  assert.ok(deferred && rounds > 2);
  assert.deepEqual(collected, reference, 'a budget-split read yields exactly the events of one full read');

  const concurrent = new LocalUsageCollector(home, {}, {});
  const results = await Promise.all([concurrent.collect(NOW), concurrent.collect(NOW), concurrent.collect(NOW)]);
  assert.deepEqual(results.flatMap((r) => r.events.map((e) => e.id)), reference);

  if (process.getuid?.() !== 0) {
    const locked = rollout(home, randomUUID());
    await write(locked, [codexMeta('locked', start), ...lineage(start, [[5, 0, 1]])]);
    await chmod(locked, 0);
    const blocked = await concurrent.collect(NOW);
    assert.deepEqual(blocked.events, []);
    assert.match(blocked.coverage.join('\n'), /1 entries unreadable/);
    await chmod(locked, 0o644);
    assert.deepEqual(inputs((await concurrent.collect(NOW)).events), [5]);
  }

  const corrupt = { version: 2, files: { zz: 1, ['a'.repeat(24)]: { node: 5 }, ['b'.repeat(24)]: null }, hermes: 'nope', extra: true };
  const tolerant = new LocalUsageCollector(home, corrupt, {});
  assert.equal(tolerant.state, corrupt, 'the caller keeps its state object');
  assert.deepEqual(Object.keys(corrupt).sort(), ['files', 'hermes', 'version']);
  assert.equal((await tolerant.collect(NOW)).events.length, 61);
  assert.throws(() => new LocalUsageCollector(home, { files: { [id]: { offset: 999_999, inode: 1 } }, hermes: {} }, {}), /Unsupported usage collector version/);
  assert.doesNotThrow(() => JSON.stringify(tolerant.state));
});

test('Collector coverage is explicit and never claims full coverage', async (t) => {
  const home = await fixture(t);
  const result = await new LocalUsageCollector(home, {}, {}).collect(NOW);
  const coverage = result.coverage.join('\n');
  assert.deepEqual(result.events, []);
  assert.match(coverage, /Hermes: no state\.db found\./);
  assert.match(coverage, /Codex ~\/\.codex\/sessions: not present\./);
  assert.match(coverage, /Claude Code ~\/\.claude\/projects: not present\./);
  assert.match(coverage, /This is not a complete record of usage on this device\./);
  assert.match(coverage, /baselined the first time a database is observed/);
  assert.match(coverage, /account or plan a log was billed to is not verified/);
});

test('Collector health: complete only when every discovered log was read to its end; permanent loss is flagged', async (t) => {
  const home = await fixture(t);
  const empty = await new LocalUsageCollector(home, {}, {}).collect(NOW);
  assert.deepEqual([empty.complete, empty.lost], [true, false], 'absent default roots are normal, not a problem');

  const id = randomUUID(), path = rollout(home, id), start = NOW - 100 * MINUTE;
  await write(path, [codexMeta(id, start), ...lineage(start, Array.from({ length: 20 }, (_, k) => [100 + k, 0, 10]))]);
  const collector = new LocalUsageCollector(home, {}, {}, { byteBudget: 1024 });
  const backlog = await collector.collect(NOW);
  assert.deepEqual([backlog.complete, backlog.lost], [false, false], 'a read backlog is incomplete, not lost');
  let drained = backlog;
  for (let round = 0; round < 50 && !drained.complete; round++) drained = await collector.collect(NOW);
  assert.deepEqual([drained.complete, drained.lost], [true, false], 'the drained backlog is complete');

  await symlink(join(home, 'missing.jsonl'), join(dirname(path), 'dangling.jsonl'));
  assert.equal((await collector.collect(NOW)).complete, true, 'a dangling symlink is not a discovered log');

  await appendFile(path, '{"timestamp":"x","type":"event_msg","payload":{"type":"token_count",\n');
  const broken = await collector.collect(NOW);
  assert.deepEqual([broken.complete, broken.lost], [false, true], 'a consumed unparsable accounting line is lost');
  const after = await collector.collect(NOW);
  assert.deepEqual([after.complete, after.lost], [true, false], 'a loss is reported once, by the run that consumed it');

  if (process.getuid?.() !== 0) {
    const locked = rollout(home, randomUUID());
    await write(locked, [codexMeta('locked', start), ...lineage(start, [[5, 0, 1]])]);
    await chmod(locked, 0);
    const unreadable = await collector.collect(NOW);
    assert.deepEqual([unreadable.complete, unreadable.lost], [false, false], 'an unreadable log is retried, not lost');
    await chmod(locked, 0o644);
    const recovered = await collector.collect(NOW);
    assert.deepEqual([recovered.complete, inputs(recovered.events)], [true, [5]]);

    const projects = join(home, '.claude', 'projects');
    await mkdir(projects, { recursive: true });
    await chmod(projects, 0);
    t.after(() => chmod(projects, 0o755).catch(() => undefined));
    const closed = await collector.collect(NOW);
    assert.equal(closed.complete, false, 'a present but unreadable root is incomplete');
    assert.match(closed.coverage.join('\n'), /Claude Code ~\/\.claude\/projects: not readable/);
    await chmod(projects, 0o755);
    assert.equal((await collector.collect(NOW)).complete, true);
  }
  assert.equal(JSON.stringify([drained, broken]).includes(home), false, 'health carries no paths');
});

test('Collector health: Hermes read failures are incomplete; counters baselined without history are lost', { skip: needsSqlite }, async (t) => {
  const home = await fixture(t);
  const db = await hermesDb(join(home, '.hermes'), session('s1', 'openai-codex', [100, 10, 0, 0], T0 - DAY)
    + modelRow('s1', 'gpt-5.5', 'openai-codex', '', [100, 10, 0, 0], T0 - DAY, T0 - MINUTE));
  const collector = new LocalUsageCollector(home, {}, {});
  const first = await collector.collect(T0);
  assert.deepEqual([first.complete, first.lost], [false, true], 'usage before the first observation of an active database is never counted');
  const steady = await collector.collect(T0 + MINUTE);
  assert.deepEqual([steady.complete, steady.lost], [true, false]);
  sql(db, `INSERT INTO session_model_usage (session_id, model, billing_provider, input_tokens, output_tokens, first_seen, last_seen) VALUES ('s1', 'new', 'openai-codex', 5, 1, ${seconds(T0 + 1.5 * MINUTE)}, ${seconds(T0 + 1.5 * MINUTE)})`);
  const added = await collector.collect(T0 + 2 * MINUTE);
  assert.deepEqual([added.complete, added.lost, inputs(added.events)], [true, false, [5]], 'a row created after the last observation is counted from zero');

  const profile = join(home, '.hermes', 'profiles', 'broken');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'state.db'), 'this is not a database file, only some text that is long enough');
  const failed = await collector.collect(T0 + 3 * MINUTE);
  assert.deepEqual([failed.complete, failed.lost], [false, false], 'a database that cannot be read is incomplete');
});
