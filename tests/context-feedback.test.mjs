import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextProfileStore } from '../src/main/services/ContextProfileStore.ts';
import { ContextLaunchService } from '../src/main/services/ContextLaunchService.ts';
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-feedback-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), other = join(root, 'other'); mkdirSync(source); mkdirSync(other);
  const store = new ContextProfileStore(join(root, 'profiles'));
  let state = await store.saveProject({ label: 'First', root: source }, 0);
  const projectId = state.projects[0].id;
  state = await store.saveProject({ label: 'Second', root: other }, state.revision);
  const otherId = state.projects[1].id;
  const settings = async (patch = {}, id = projectId) => store.saveLearning(id, { enabled: true, autoApply: true, threshold: .85, advisoryThreshold: .6, ...patch }, store.get().revision);
  const capture = async (eventId, value = 'cream', extra = {}) => store.captureFeedback({ eventId, projectId, kind: 'correction', category: 'design', key: 'button.text', value, ...extra }, store.get().revision);
  const preview = (id = projectId, extra = {}) => store.preview({ projectId: id, maxDataClass: 'D3', ...extra });
  return { root, source, other, store, projectId, otherId, settings, capture, preview };
}
test('feedback learning defaults off and does not resolve optional session evidence', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(f.store.captureFeedback({ eventId: 'one', projectId: f.projectId, kind: 'correction', category: 'design', key: 'k', value: 'v', sessionId: 'session' }, f.store.get().revision, () => { calls++; throw Error('Optional source accessed'); }), /disabled/);
  assert.equal(calls, 0); assert.deepEqual(f.preview().included, []);
});
test('unique events raise a heuristic score; replay, project isolation and suggestions cannot forge confirmation', async t => {
  const f = await fixture(t); await f.settings();
  let state = await f.capture('one'); assert.equal(state.feedback.candidates[0].score, .45);
  state = await f.capture('one'); assert.equal(state.feedback.evidence.length, 1);
  await assert.rejects(f.capture('one', 'black'), /replay/);
  state = await f.capture('suggestion', 'cream', { kind: 'suggestion' }); assert.equal(state.feedback.candidates[0].score, .45);
  await f.capture('two'); assert.equal(f.store.get().feedback.candidates[0].score, .71); assert.equal(f.preview().included.length, 0);
  await f.capture('three'); assert.equal(f.store.get().feedback.candidates[0].score, .9); assert.match(f.preview().text, /cream/);
  assert.equal(f.preview(f.otherId, { includeInferred: true }).included.length, 0);
  assert.equal(f.store.get().rules.length, 0);
});
test('alternating conflicting evidence lowers scores and class floors never decrease after undo', async t => {
  const f = await fixture(t); await f.settings();
  for (let i = 0; i < 8; i++) await f.capture('event-' + i, i % 2 ? 'black' : 'cream', { dataClass: i === 0 ? 'D3' : 'D0' });
  let state = f.store.get(); assert.ok(state.feedback.candidates.every(c => c.score < .6 && c.dataClass === 'D3'));
  assert.equal(f.preview().included.length, 0);
  state = await f.store.feedbackAction({ kind: 'undo-evidence', id: state.feedback.evidence[0].id }, state.revision);
  assert.ok(state.feedback.candidates.every(c => c.dataClass === 'D3'));
  assert.equal(state.feedback.evidence[0].undone, true);
});
test('accepted, reject, disable, undo and threshold changes alter the next actual captured projection', async t => {
  const f = await fixture(t); await f.settings({ threshold: .7 }); await f.capture('one'); await f.capture('two');
  const launch = new ContextLaunchService(f.store), intent = { provider: 'claude', enabled: true }, source = { sourceCwd: f.source, assertCurrent() {} }, route = { provider: 'claude', maxDataClass: 'D3' };
  const old = launch.capture(intent, source); assert.match(launch.project(old, route).text, /cream/);
  await f.settings({ threshold: .95 }); assert.throws(() => old.assertCurrent(), /revision/); assert.equal(launch.project(launch.capture(intent, source), route).text, '');
  let state = f.store.get(), id = state.feedback.candidates[0].id;
  state = await f.store.feedbackAction({ kind: 'accept', id }, state.revision); assert.match(f.preview().text, /cream/); assert.equal(f.preview().included[0].source, 'inferred');
  for (const kind of ['reject', 'accept', 'disable', 'accept', 'undo-accept']) {
    state = await f.store.feedbackAction({ kind, id }, state.revision); assert.equal(!!f.preview().text, kind === 'accept');
  }
  await f.settings({ enabled: false, threshold: .7 }); assert.equal(f.preview(f.projectId, { includeInferred: true }).text, '');
});
test('explicit and live imported preferences retain precedence over learned candidates', async t => {
  const f = await fixture(t); await f.settings(); await f.capture('one', 'learned', { key: 'design.css.--text' });
  let state = f.store.get(); state = await f.store.feedbackAction({ kind: 'accept', id: state.feedback.candidates[0].id }, state.revision);
  writeFileSync(join(f.source, 'theme.css'), ':root { --text: cream; }');
  state = await f.store.saveProject({ ...state.projects[0], importsEnabled: true, imports: [{ path: 'theme.css', kind: 'css' }] }, state.revision);
  assert.match(f.preview().text, /cream/); assert.doesNotMatch(f.preview().text, /learned/);
  await f.store.saveRule({ scope: 'project', ownerId: f.projectId, category: 'design', key: 'design.css.--text', value: 'explicit', tags: [], enabled: true }, state.revision);
  assert.match(f.preview().text, /explicit/); assert.doesNotMatch(f.preview().text, /cream|learned/);
});
test('capture rejects forged authority, mismatched session projects, invalid identities and oversized evidence', async t => {
  const f = await fixture(t); await f.settings();
  for (const extra of [{ source: 'explicit' }, { projectId: 'missing' }, { provenance: {} }, { score: 1 }, { root: f.other }, { value: 'x'.repeat(5000) }, { before: { a: { b: { c: { d: { e: [] } } } } } }]) await assert.rejects(f.capture('event', 'cream', extra));
  const input = { eventId: 'session-event', projectId: f.projectId, kind: 'accepted-change', category: 'design', key: 'k', value: 'v', dataClass: 'D0', sessionId: 'session' };
  await assert.rejects(f.store.captureFeedback(input, f.store.get().revision), /session/);
  await assert.rejects(f.store.captureFeedback(input, f.store.get().revision, () => ({ sessionId: 'session', generation: 'generation', sourceCwd: f.other, dataClass: 'D3', assertCurrent() {} })), /project/);
  let state = await f.store.captureFeedback(input, f.store.get().revision, () => ({ sessionId: 'session', generation: 'generation', sourceCwd: f.source, dataClass: 'D3', assertCurrent() {} }));
  assert.equal(state.feedback.candidates[0].dataClass, 'D3'); assert.equal(state.feedback.evidence[0].provenance.sessionGeneration, 'generation');
});

test('undo blocks even a high-scoring automatic candidate; manual acceptance wins competing automatic values', async t => {
  const f = await fixture(t); await f.settings({ threshold: .5, advisoryThreshold: .5 });
  for (const id of ['a', 'b', 'c']) await f.capture(id);
  let state = f.store.get(), id = state.feedback.candidates[0].id; assert.match(f.preview().text, /cream/);
  state = await f.store.feedbackAction({ kind: 'undo-accept', id }, state.revision); assert.equal(f.preview().text, '');
  await f.capture('more'); assert.equal(f.preview().text, '');
  state = await f.store.feedbackAction({ kind: 'accept', id }, f.store.get().revision);
  await f.capture('alternative', 'black', { kind: 'suggestion' });
  assert.match(f.preview().text, /cream/); assert.doesNotMatch(f.preview().text, /black/);
  state = f.store.get(); await f.store.feedbackAction({ kind: 'accept', id: state.feedback.candidates[1].id }, state.revision);
  assert.match(f.preview().text, /black/); assert.doesNotMatch(f.preview().text, /cream/);
});
test('persisted feedback stays bounded and project roots cannot rebind existing evidence', async t => {
  const f = await fixture(t); await f.settings();
  for (let n = 0; n < 32; n++) await f.capture('event-' + n);
  await assert.rejects(f.capture('too-many'), /inventory/);
  assert.equal(f.store.get().feedback.evidence.length, 32);
  let state = await f.settings({ enabled: false }); const third = join(f.root, 'third'); mkdirSync(third);
  await assert.rejects(f.store.saveProject({ ...state.projects[0], root: third }, state.revision), /original root/);
  const loaded = new ContextProfileStore(join(f.root, 'profiles')); assert.equal(loaded.get().feedback.evidence.length, 32);
  state = await f.store.remove('project', f.projectId, state.revision); assert.deepEqual(state.feedback, { candidates: [], evidence: [] });
});
test('policy/source floors are refreshed and disabled capture does not read optional policies', async t => {
  const f = await fixture(t); let calls = 0, policies = [];
  const store = new ContextProfileStore(join(f.root, 'other-profiles'), () => { calls++; return policies; });
  let state = await store.saveProject({ root: f.source, label: 'Policy' }, 0), projectId = state.projects[0].id;
  const input = { projectId, eventId: 'one', kind: 'correction', key: 'k', value: 'secret-class', category: 'design', dataClass: 'D0' };
  await assert.rejects(store.captureFeedback(input, state.revision), /disabled/); assert.equal(calls, 0);
  state = await store.saveLearning(projectId, { enabled: true, autoApply: false, threshold: .85, advisoryThreshold: .6 }, state.revision);
  state = await store.captureFeedback(input, state.revision); assert.equal(state.feedback.candidates[0].dataClass, 'D2');
  state = await store.feedbackAction({ kind: 'accept', id: state.feedback.candidates[0].id }, state.revision);
  policies = [{ pattern: '**', dataClass: 'D3' }];
  assert.equal(store.preview({ projectId, maxDataClass: 'D2' }).text, '');
  assert.equal(store.preview({ projectId, maxDataClass: 'D3' }).dataClass, 'D3');
});
test('canonical evidence dedup ignores JSON property order, and failed source guard leaves store unchanged', async t => {
  const f = await fixture(t); await f.settings(); await f.capture('one', { b: 2, a: 1 });
  await f.capture('one', { a: 1, b: 2 }); assert.equal(f.store.get().feedback.evidence.length, 1);
  const revision = f.store.get().revision;
  await assert.rejects(f.store.captureFeedback({ projectId: f.projectId, eventId: 'guard', kind: 'correction', category: 'design', key: 'x', value: 'y', sessionId: 'live' }, revision, () => ({ sessionId: 'live', generation: 'generation', sourceCwd: f.source, dataClass: 'D2', assertCurrent() { throw Error('Session no longer current'); } })), /current/);
  assert.equal(f.store.get().revision, revision);
  for (const settings of [{ enabled: true, autoApply: true, threshold: .4, advisoryThreshold: .2 }, { enabled: true, autoApply: true, threshold: .7, advisoryThreshold: .8 }, { enabled: true, autoApply: true, threshold: .8, advisoryThreshold: .6, source: 'explicit' }]) await assert.rejects(f.store.saveLearning(f.projectId, settings, revision));
});

test('session choices are main-verified, project-local, bounded and do no optional work when learning is off', async t => {
  const f = await fixture(t); let reads = 0;
  assert.deepEqual(f.store.feedbackSessions(f.projectId, () => { reads++; return []; }, () => { throw Error('Unexpected session read'); }), []); assert.equal(reads, 0);
  await f.settings();
  const candidates = [{ id: 'source', title: 'Source agent', provider: 'claude', buffer: 'NEVER_RETURN_BUFFER' }, { id: 'other', title: 'Other agent', provider: 'codex' }, { id: 'closed', title: 'Closed agent', provider: 'claude' }];
  const choices = f.store.feedbackSessions(f.projectId, () => candidates, id => { if (id === 'closed') throw Error('Closed session'); return { sessionId: id, generation: 'generation', sourceCwd: id === 'source' ? f.source : f.other, dataClass: 'D2', assertCurrent() {} }; });
  assert.deepEqual(choices, [{ id: 'source', title: 'Source agent', provider: 'claude' }]); assert.doesNotMatch(JSON.stringify(choices), /BUFFER|buffer/);
  await assert.rejects(async () => f.store.feedbackSessions('unknown', () => candidates, () => {}), /Unknown/);
  reads = 0; f.store.feedbackSessions(f.projectId, () => Array.from({ length: 200 }, (_, i) => ({ id: 'id-' + i, title: 'Session', provider: 'claude' })), id => { reads++; return { sessionId: id, generation: 'g', sourceCwd: f.source, dataClass: 'D2', assertCurrent() {} }; }); assert.equal(reads, 128);
});
