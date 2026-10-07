import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeFlush, claudeUsage, codexUsage, CODEX_COPY_WINDOW } from '../src/main/services/usageReaders.ts';

const context = { profile: 'default', session: 'from-file-name' };
const at = (seconds) => new Date(Date.parse('2026-09-20T10:00:00Z') + seconds * 1000).toISOString();
const meta = (id, seconds, originator = 'codex_cli_rs') => ({ type: 'session_meta', timestamp: at(seconds), payload: { id, originator, instructions: 'PRIVATE-INSTRUCTIONS' } });
const usage = (input, cached, output, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
const count = (seconds, total, last) => ({ type: 'event_msg', timestamp: at(seconds), payload: { type: 'token_count', info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}) } } });
const run = (state, lines) => lines.map((line) => codexUsage(line, state, context));
const roundTrip = (value) => JSON.parse(JSON.stringify(value));

test('Codex fresh lineage counts the first total, then differences; reasoning and cache are not added twice', () => {
  const state = {};
  const [first, second, repeat] = run(state, [
    meta('session-a', 0),
    count(1, usage(1000, 200, 50, 30), usage(1000, 200, 50, 30)),
    count(2, usage(1600, 700, 80, 40), usage(600, 500, 30, 10)),
    count(3, usage(1600, 700, 80, 40), usage(600, 500, 30, 10)),
  ]).slice(1);
  assert.deepEqual([first.input, first.cached, first.output], [1000, 200, 50]);
  assert.deepEqual([second.input, second.cached, second.output], [600, 500, 30]);
  assert.equal(repeat, null, 'rate-limit repeats of the same cumulative total are not usage');
  assert.equal(first.session, 'session-a');
  assert.equal(first.from, Date.parse(at(1)));
  assert.equal(first.timing, 'event');
  assert.equal(first.app, 'Codex CLI');
  assert.equal(JSON.stringify([first, second, state]).includes('PRIVATE'), false);
});

test('Codex first reading of a resumed or compacted lineage is not incremental: only last_token_usage counts', () => {
  const state = {};
  const [event] = run(state, [meta('resumed', 0), count(5, usage(90_000, 80_000, 4000), usage(3000, 2500, 120))]).slice(1);
  assert.deepEqual([event.input, event.cached, event.output], [3000, 2500, 120]);
  const next = codexUsage(count(6, usage(94_000, 83_000, 4200), usage(4000, 3000, 200)), state, context);
  assert.deepEqual([next.input, next.output], [4000, 200]);

  const withoutLast = {};
  assert.deepEqual(run(withoutLast, [meta('old', 0), count(1, usage(90_000, 0, 4000))]), [null, null], 'no previous and no last: baseline only');
  assert.equal(codexUsage(count(2, usage(90_500, 0, 4100)), withoutLast, context).input, 500);
});

test('Codex decreases rebaseline instead of counting negative or retrospective totals', () => {
  const state = {};
  run(state, [meta('s', 0), count(1, usage(100, 0, 10), usage(100, 0, 10))]);
  assert.equal(codexUsage(count(2, usage(50, 0, 5), usage(20, 0, 2)), state, context), null);
  assert.equal(codexUsage(count(3, usage(70, 0, 9), usage(20, 0, 4)), state, context).input, 20);
  const reset = codexUsage(count(4, usage(30, 0, 3), usage(30, 0, 3)), state, context);
  assert.deepEqual([reset.input, reset.output], [30, 3], 'a reset to a single fresh request counts that request');
});

test('Codex invalid counters are ignored without disturbing the baseline', () => {
  const state = {};
  run(state, [meta('s', 0), count(1, usage(100, 0, 10), usage(100, 0, 10))]);
  for (const bad of [
    { ...usage(100, 0, 10), input_tokens: -5 },
    { ...usage(100, 0, 10), input_tokens: '999999' },
    { ...usage(100, 0, 10), output_tokens: 1.5 },
    { ...usage(100, 0, 10), input_tokens: 2 ** 60 },
    usage(100, 500, 10),
    { cached_input_tokens: 1 },
  ]) assert.equal(codexUsage(count(2, bad, usage(1, 0, 1)), state, context), null);
  assert.equal(codexUsage({ type: 'event_msg', timestamp: at(2), payload: { type: 'token_count', info: null, rate_limits: {} } }, state, context), null);
  assert.equal(codexUsage(count(3, usage(130, 0, 12), usage(30, 0, 2)), state, context).input, 30);
  assert.equal(codexUsage({ ...count(4, usage(140, 0, 13), usage(10, 0, 1)), timestamp: 'garbage' }, state, context), null);
  assert.equal(codexUsage(count(5, usage(150, 0, 14), usage(10, 0, 1)), state, context).input, 10, 'an untimed reading still advances the baseline');
});

test('Codex forked rollout: copied parent history is baseline only, ids match the parent, new usage counts once', () => {
  const parentLines = [meta('parent', 0), count(10, usage(1000, 0, 100), usage(1000, 0, 100)), count(20, usage(1500, 400, 160), usage(500, 400, 60))];
  const parent = run({}, parentLines).filter(Boolean);
  const fork = {};
  const forkEvents = run(fork, [
    meta('fork', 1000),
    { ...parentLines[0], timestamp: at(1000) },
    { ...parentLines[1], timestamp: at(1000) },
    { ...parentLines[2], timestamp: at(1000) },
    count(1000 + CODEX_COPY_WINDOW / 1000 + 30, usage(1800, 600, 200), usage(300, 200, 40)),
  ]).filter(Boolean);
  assert.equal(parent.length, 2);
  assert.equal(forkEvents.length, 1, 'copied token_count lines with rewritten timestamps are not usage');
  assert.deepEqual([forkEvents[0].input, forkEvents[0].output, forkEvents[0].session], [300, 40, 'fork']);

  // A copy of the same rollout (same first session_meta) repeats the parent's ids exactly.
  const duplicate = run({}, parentLines.map((line) => ({ ...line, timestamp: at(5000) }))).filter(Boolean);
  assert.deepEqual(duplicate.map((event) => event.id), parent.map((event) => event.id));
});

test('Codex ids are scoped to the session lineage: independent sessions with equal counters stay distinct', () => {
  const lines = (id) => [meta(id, 0), count(10, usage(1000, 0, 100), usage(1000, 0, 100)), count(20, usage(1500, 400, 160), usage(500, 400, 60))];
  const a = run({}, lines('session-a')).filter(Boolean), b = run({}, lines('session-b')).filter(Boolean);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  for (let index = 0; index < 2; index++) assert.notEqual(a[index].id, b[index].id, `event ${index}`);
  // Without session_meta the file-derived session is the lineage.
  const unnamed = (session) => codexUsage(count(10, usage(1000, 0, 100), usage(1000, 0, 100)), {}, { ...context, session });
  assert.notEqual(unnamed('file-a').id, unnamed('file-b').id);
  assert.equal(unnamed('file-a').id, unnamed('file-a').id);
});

test('Codex rollouts written by the Hermes app-server runtime are excluded (accounted in Hermes state.db)', () => {
  const state = {};
  assert.deepEqual(run(state, [meta('h', 0, 'hermes'), count(1, usage(100, 0, 10), usage(100, 0, 10))]), [null, null]);
  assert.equal(state.external, 'Hermes');
});

test('Codex reader state is JSON-serializable and resumes identically', () => {
  const state = {};
  run(state, [meta('s', 0), count(1, usage(100, 0, 10), usage(100, 0, 10))]);
  const resumed = roundTrip(state);
  const a = codexUsage(count(2, usage(150, 0, 12), usage(50, 0, 2)), state, context);
  const b = codexUsage(count(2, usage(150, 0, 12), usage(50, 0, 2)), resumed, context);
  assert.deepEqual(a, b);
});

const assistant = (id, seconds, value, extra = {}) => ({
  type: 'assistant', timestamp: at(seconds), sessionId: 'claude-session', requestId: 'req_1', uuid: `u-${seconds}`,
  message: { id, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'PRIVATE-ANSWER' }], usage: value },
  ...extra,
});
const claudeTokens = (input, read, write, output) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output });

test('Claude streamed entries of one message become one event with maxima; content never leaves', () => {
  const state = {};
  assert.equal(claudeUsage(assistant('msg_1', 0, claudeTokens(5, 1000, 200, 1)), state, context), null);
  assert.equal(claudeUsage({ type: 'user', timestamp: at(1), message: { content: 'PRIVATE-PROMPT' } }, state, context), null);
  assert.equal(claudeUsage(assistant('msg_1', 2, claudeTokens(5, 1000, 200, 350)), state, context), null);
  const event = claudeUsage(assistant('msg_2', 9, claudeTokens(7, 1400, 0, 20)), state, context);
  assert.deepEqual([event.input, event.cached, event.output], [1205, 1000, 350]);
  assert.deepEqual([event.from, event.to, event.session, event.provider], [Date.parse(at(0)), Date.parse(at(2)), 'claude-session', 'claude']);
  const last = claudeFlush(roundTrip(state), context);
  assert.deepEqual([last.input, last.output], [1407, 20]);
  assert.equal(JSON.stringify([event, last, state]).includes('PRIVATE'), false);
});

test('Claude copied transcripts reuse the message id; synthetic, invalid and non-assistant records are ignored', () => {
  const a = {}, b = {};
  claudeUsage(assistant('msg_x', 0, claudeTokens(10, 0, 0, 5)), a, context);
  claudeUsage({ ...assistant('msg_x', 0, claudeTokens(10, 0, 0, 5)), sessionId: 'resumed-copy' }, b, context);
  assert.equal(claudeFlush(a, context).id, claudeFlush(b, context).id);

  const state = {};
  for (const record of [
    assistant('msg_s', 0, claudeTokens(0, 0, 0, 0), { message: { id: 'msg_s', model: '<synthetic>', usage: claudeTokens(0, 0, 0, 0) } }),
    assistant('msg_e', 0, claudeTokens(1, 0, 0, 1), { isApiErrorMessage: true }),
    assistant('msg_bad', 0, { ...claudeTokens(1, 0, 0, 1), output_tokens: -1 }),
    assistant('msg_bad2', 0, { ...claudeTokens(1, 0, 0, 1), cache_read_input_tokens: 'x' }),
    assistant('bad id with spaces', 0, claudeTokens(1, 0, 0, 1)),
    { ...assistant('msg_t', 0, claudeTokens(1, 0, 0, 1)), timestamp: 'never' },
    { type: 'summary', summary: 'PRIVATE' },
  ]) assert.equal(claudeUsage(record, state, context), null);
  assert.equal(claudeFlush(state, context), null);

  const unnamed = {};
  claudeUsage({ ...assistant('msg_n', 0, claudeTokens(1, 0, 0, 1)), sessionId: undefined }, unnamed, context);
  assert.equal(claudeFlush(unnamed, context).session, 'from-file-name');
});
