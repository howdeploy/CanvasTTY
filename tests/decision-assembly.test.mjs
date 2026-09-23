import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleDecisionRoutes, mergeDecisionRoutes } from '../src/main/services/decision/routeAssembly.ts';
import { rankRoutes } from '../src/main/services/decision/rules.ts';
import { DEFAULT_DECISION_SETTINGS, normalizeDecisionSettings, validateDecisionSettings } from '../src/shared/decisions.ts';
import { decisionRoutingFixture } from './helpers/decision-routing-fixture.mjs';

test('automatic assembly covers accounts, ambient CLIs, cached servers, account models and effort variants', () => {
  const settings = {
    apiProfiles: [],
    remoteHosts: [{ id: 'srv', label: 'Server', sshHost: 'srv.example' }],
    providerAccounts: [
      { id: 'max', provider: 'claude', label: 'Max', hostId: 'local', binding: { kind: 'cli-home', directory: '/tmp/claude-max' }, models: ['opus', 'sonnet', 'claude-*'] },
      { id: 'srv-codex', provider: 'codex', label: 'Server Codex', hostId: 'srv', binding: { kind: 'cli-home', directory: '/srv/accounts/codex' } },
      { id: 'broken', provider: 'grok', label: 'Broken', bindingRequired: true, binding: { kind: 'cli-home', directory: '/tmp/grok' } }
    ]
  };
  const sources = { localCli: p => ['claude', 'cursor', 'grok'].includes(p), remoteAvailable: (host, p) => host === 'srv' && ['codex', 'opencode'].includes(p) };
  const routes = assembleDecisionRoutes(settings, sources, ['low', 'high']);
  const tuples = routes.map(r => [r.provider, r.accountId ?? '-', r.hostId, r.model ?? '-', r.effort ?? '-']);
  assert.deepEqual(tuples, [
    ['codex', 'srv-codex', 'srv', '-', 'low'], ['codex', 'srv-codex', 'srv', '-', 'high'],
    ['claude', 'max', 'local', 'opus', 'low'], ['claude', 'max', 'local', 'opus', 'high'],
    ['claude', 'max', 'local', 'sonnet', 'low'], ['claude', 'max', 'local', 'sonnet', 'high'],
    ['opencode', '-', 'srv', '-', '-'],
    ['cursor', '-', 'local', '-', '-']
  ]);
  // A broken configured account never falls back to the ambient CLI login.
  assert.equal(routes.some(r => r.provider === 'grok'), false);
  assert.deepEqual(assembleDecisionRoutes(settings, sources, ['low', 'high']).map(r => r.id), routes.map(r => r.id));
  assert.ok(routes.every(r => /^auto-[0-9a-f]{16}$/u.test(r.id)));
  const merged = mergeDecisionRoutes([{ id: 'mine', provider: 'cursor', hostId: 'local', transport: 'pty', cost: 1 }], routes);
  assert.equal(merged.filter(r => r.provider === 'cursor').length, 1);
  assert.deepEqual(merged.find(r => r.provider === 'cursor'), { id: 'mine', provider: 'cursor', hostId: 'local', transport: 'pty', cost: 1, automatic: false });
});

test('without a matching rule, difficulty trades effort against cost; unknown difficulty keeps configured order', () => {
  const settings = { ...DEFAULT_DECISION_SETTINGS, rules: [] };
  const routes = [
    { id: 'high', provider: 'claude', hostId: 'local', transport: 'pty', effort: 'high' },
    { id: 'low', provider: 'claude', hostId: 'local', transport: 'pty', effort: 'low' },
    { id: 'medium', provider: 'codex', hostId: 'local', transport: 'pty', effort: 'medium' },
    { id: 'strong-declared', provider: 'cursor', hostId: 'local', transport: 'pty', quality: 5, cost: 5 }
  ];
  const order = difficulty => rankRoutes(settings, { cwd: '/p', dataClass: 'D0', ...(difficulty ? { difficulty } : {}) }, routes).routes.map(r => r.id);
  assert.deepEqual(order(), ['high', 'low', 'medium', 'strong-declared']);
  assert.equal(order('simple')[0], 'low');
  assert.equal(order('hard')[0], 'strong-declared');
  assert.equal(order('normal')[0], 'medium');
});

test('legacy decision settings keep their routes when new fields are added', () => {
  const legacy = { mode: 'rules', routes: [{ id: 'r1', provider: 'claude', hostId: 'local', transport: 'pty' }], rules: [], jevModel: 'jev-latest', cloudMetadata: false, minConfidence: 0.8, maxCallsPerMinute: 6 };
  const normalized = normalizeDecisionSettings(legacy);
  assert.equal(normalized.routes[0].id, 'r1');
  assert.equal(normalized.autoRoutes, true);
  assert.deepEqual(normalized.autoEfforts, ['low', 'medium', 'high']);
  assert.equal(normalized.taskText, 'off');
  assert.throws(() => validateDecisionSettings({ ...normalized, routes: [{ id: 'x', provider: 'cursor', hostId: 'local', transport: 'pty', effort: 'high' }] }), /reasoning effort/);
  assert.equal(validateDecisionSettings({ ...normalized, jevModel: 'jev-1.13' }).jevModel, 'jev-1.13');
});

test('recommendation launches the chosen effort and Jev sees effort, economics and limit headroom but no task text by default', async t => {
  const limits = async () => ({ fetchedAt: 0, providers: [{ provider: 'claude', state: 'available', source: 'cli', fetchedAt: 0, windows: [{ id: 'w', bucketId: 'b', slot: 'primary', isDefaultBucket: true, label: null, usedPercent: 91, used: null, limit: null, windowMinutes: 300, resetsAt: null }] }] });
  const f = await decisionRoutingFixture({ limits, decisions: { mode: 'jev', cloudMetadata: true, routes: [
    { id: 'claude-low', provider: 'claude', hostId: 'local', transport: 'pty', effort: 'low' },
    { id: 'claude-high', provider: 'claude', hostId: 'local', transport: 'pty', effort: 'high' }
  ] } });
  t.after(() => f.cleanup());
  f.settings.defaultDataClass = 'D0';
  await f.secrets.set('synthetic-decision');
  const result = await f.coordinator.recommend({ cwd: f.root, profile: 'normal', category: 'code', difficulty: 'hard' });
  assert.equal(result.engine, 'jev');
  assert.equal(result.candidateCount, 2);
  // Hard tasks rank the stronger effort first; the fixture evaluator picks rank 0.
  assert.equal(result.selected.effort, 'high');
  const state = f.payloads[0].state;
  assert.deepEqual(state.task, { category: 'code', difficulty: 'hard', dataClass: 'D0', delegation: false });
  assert.deepEqual(state.candidates.map(c => [c.agent, c.effort, c.cost, c.quality, c.limitHeadroom]), [['claude', 'high', 3, 4, 'low'], ['claude', 'low', 1, 2, 'low']]);
  assert.match(f.payloads[0].questions.route.criteria.c0, /effort: high/);
  const before = f.calls.length;
  const session = await f.coordinator.launch(result.id);
  assert.equal(session.effort, 'high');
  await f.manager.waitForLaunch(session.id);
  assert.ok(f.calls.length > before);
  const argv = f.calls.at(-1).args;
  assert.deepEqual(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2), ['--effort', 'high']);
});

test('task text reaches Jev only with an explicit grant at or above the task class', async t => {
  const routes = [{ id: 'devin', provider: 'devin', hostId: 'local', transport: 'pty' }, { id: 'agy', provider: 'antigravity', hostId: 'local', transport: 'pty' }];
  for (const [taskText, expected] of [['off', false], ['D1', false], ['D2', true]]) {
    const f = await decisionRoutingFixture({ decisions: { mode: 'jev', cloudMetadata: true, taskText, routes } });
    try {
      await f.secrets.set('synthetic-decision');
      await f.coordinator.recommend({ cwd: f.root, profile: 'normal', initialPrompt: 'Rename the button label' });
      assert.equal(f.payloads[0].state.task.text === 'Rename the button label', expected, taskText);
    } finally { await f.cleanup(); }
  }
});

test('automatic routes appear at recommendation time from detected CLIs without saved routes', async t => {
  const f = await decisionRoutingFixture({ localCliAvailable: p => p === 'claude' || p === 'devin', decisions: { mode: 'rules', routes: [], autoEfforts: ['medium'] } });
  t.after(() => f.cleanup());
  f.settings.defaultDataClass = 'D0';
  const preview = f.coordinator.assemble(['medium']);
  assert.deepEqual(preview.map(r => [r.provider, r.effort ?? '-']), [['claude', 'medium'], ['devin', '-']]);
  const result = await f.coordinator.recommend({ cwd: f.root, profile: 'normal', difficulty: 'normal' });
  assert.equal(result.automatic, true);
  assert.equal(result.candidateCount, 2);
  assert.throws(() => f.coordinator.assemble(['turbo']), /effort/);
});
