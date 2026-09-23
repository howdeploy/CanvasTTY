import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DECISION_SETTINGS, validateDecisionSettings } from '../src/shared/decisions.ts';
import { rankRoutes } from '../src/main/services/decision/rules.ts';
import { JevBackend } from '../src/main/services/decision/JevBackend.ts';

const request = { model: 'jev-latest', state: { category: 'code', candidates: [{ id: 'c0', local: true, rank: 0 }, { id: 'c1', local: false, rank: 1 }] }, questions: { route: { type: 'choice', instructions: 'Choose an eligible route', criteria: { c0: 'First eligible route', c1: 'Second eligible route' } } } };
const response = () => ({ model: 'jev-1.13.0', answers: { route: { type: 'choice', choice: 'c0', probabilities: { c0: 0.8, c1: 0.2 }, confidence: 0.9 } }, usage: { input_tokens: 10, output_tokens: 5 } });

test('decision settings default off and exact bounded rules preserve stable fallback order', () => {
 assert.equal(DEFAULT_DECISION_SETTINGS.mode, 'off');
 assert.throws(() => validateDecisionSettings({ ...DEFAULT_DECISION_SETTINGS, surprise: true }));
 const routes = [{ id: 'a', provider: 'claude', hostId: 'local', transport: 'pty' }, { id: 'b', provider: 'codex', hostId: 'local', transport: 'pty' }];
 const settings = validateDecisionSettings({ ...DEFAULT_DECISION_SETTINGS, mode: 'rules', routes, rules: [{ id: 'code', category: 'code', taskContains: 'проверь', pathPattern: '**/src', maxDataClass: 'D2', prefer: ['b'] }] });
 assert.deepEqual(rankRoutes(settings, { category: 'code', cwd: '/repo/src', initialPrompt: 'Проверь код', dataClass: 'D2' }, routes).routes.map(r => r.id), ['b', 'a']);
 assert.deepEqual(rankRoutes(settings, { category: 'review', cwd: '/repo/src', dataClass: 'D2' }, routes).routes.map(r => r.id), ['a', 'b']);
});

test('Jev uses official fixed endpoint and validates probabilities and noul without leaking credentials', async () => {
 let calls = 0;
 const backend = new JevBackend(async (url, options) => { calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer fixture'); return new Response(JSON.stringify(response())); });
 const result = await backend.evaluate(request, 'fixture', new AbortController().signal);
 assert.equal(result.model, 'jev-1.13.0'); assert.equal(result.answers.route.choice, 'c0'); assert.equal(result.usage.input_tokens, 10); assert.equal(calls, 1);
 for (const change of [r => { r.answers.route.probabilities.c0 = 0.7; }, r => { r.answers.route.choice = 'unknown'; }, r => { r.answers.route.confidence = 2; }, r => { r.answers.route.probabilities.c9 = 0; }, r => { r.answers.route.probabilities = { c1: 0.2 }; }, r => { r.answers.route.type = 'noul'; }, r => { delete r.answers.route; }, r => { delete r.model; }, r => { r.model = 'gpt-5'; }]) {
  const value = response(); change(value);
  await assert.rejects(new JevBackend(async () => new Response(JSON.stringify(value))).evaluate(request, 'fixture', new AbortController().signal));
 }
 // Documented variations must not discard a valid answer: jev-latest naming, extra metadata, partial or rounded
 // distributions, missing confidence and chat-style usage names.
 for (const change of [r => { r.model = 'jev-latest'; }, r => { r.model = 'jev-1.13'; }, r => { r.id = 'resp_1'; r.answers.route.legend = {}; r.answers.extra = r.answers.route; }, r => { delete r.answers.route.probabilities.c1; }, r => { r.answers.route.probabilities = { c0: 0.8004, c1: 0.2004 }; }, r => { delete r.answers.route.confidence; }, r => { r.usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }; }, r => { r.usage = { input_tokens: -1, output_tokens: 2 }; }]) {
  const value = response(); change(value);
  const accepted = await new JevBackend(async () => new Response(JSON.stringify(value))).evaluate(request, 'fixture', new AbortController().signal);
  assert.equal(accepted.answers.route.choice, 'c0');
 }
 const chatUsage = { ...response(), usage: { prompt_tokens: 7, completion_tokens: 3 } };
 assert.deepEqual((await new JevBackend(async () => new Response(JSON.stringify(chatUsage))).evaluate(request, 'fixture', new AbortController().signal)).usage, { input_tokens: 7, output_tokens: 3 });
 const pinned = { ...request, model: 'jev-1.13' };
 await assert.rejects(new JevBackend(async () => new Response(JSON.stringify({ ...response(), model: 'jev-2.0.0' }))).evaluate(pinned, 'fixture', new AbortController().signal), /version/);
 const noul = { ...request, questions: { score: { type: 'noul', instructions: 'Relevant evidence' } } };
 const good = { model: 'jev-1.13.0', answers: { score: { type: 'noul', noul: 0.4 } }, usage: { input_tokens: 1, output_tokens: 2 } };
 assert.equal((await new JevBackend(async () => new Response(JSON.stringify(good))).evaluate(noul, 'fixture', new AbortController().signal)).answers.score.noul, 0.4);
 await assert.rejects(new JevBackend(async () => new Response('{"model":"a","model":"b"}')).evaluate(request, 'fixture', new AbortController().signal), /duplicate/i);
 await assert.rejects(new JevBackend(async () => new Response(' '.repeat(65537))).evaluate(request, 'fixture', new AbortController().signal), /large|limit/i);
});

import { decisionRoutingFixture } from './helpers/decision-routing-fixture.mjs';
import { OrchestrationClient, readOrchestrationIdentity } from '../src/agent-browser/orchestration-helper.mjs';
async function fixture(t, hooks) { const f = await decisionRoutingFixture(hooks); t.after(() => f.cleanup()); return f; }
const launch = f => ({ cwd: f.root, profile: 'normal' });
async function parentClient(t, f) {
 const parent = f.manager.create({ ...launch(f), provider: 'claude', position: { x: 0, y: 0 }, allowSubagents: true }); await f.manager.waitForLaunch(parent.id);
 const client = new OrchestrationClient(readOrchestrationIdentity(f.calls[0].options.env)); t.after(() => client.close()); await client.connect(); return { parent, client };
}
test('authenticated MCP recommends, consumes exact review, auto-spawns, while explicit provider bypasses disabled decisions', async t => {
 const f = await fixture(t), { parent, client } = await parentClient(t, f);
 const review = await client.call('recommend_agent', { cwd: f.root }); assert.equal(review.selected.provider, 'claude'); assert.equal(f.calls.length, 1);
 const result = await client.call('launch_recommended_agent', { recommendationId: review.id }); await f.manager.waitForLaunch(result.sessionId);
 assert.equal(f.manager.list().find(s => s.id === result.sessionId).parentSessionId, parent.id);
 assert.equal(f.manager.list().find(s => s.id === result.sessionId).exitCode, null, f.manager.list().find(s => s.id === result.sessionId).failureDetails);
 const automatic = await client.call('spawn_agent', { provider: 'auto', cwd: f.root }); await f.manager.waitForLaunch(automatic.sessionId);
 assert.equal(automatic.provider, 'claude'); assert.equal(f.browserRegistrations(), 0);
 f.settings.decisions.mode = 'off'; f.coordinator.invalidate();
 const explicit = await client.call('spawn_agent', { provider: 'codex', cwd: f.root }); await f.manager.waitForLaunch(explicit.sessionId);
 assert.equal(explicit.provider, 'codex'); assert.equal(f.evaluatorCalls(), 0); assert.equal(f.decisionSecretReads(), 0);
 await assert.rejects(client.call('spawn_agent', { provider: 'auto', cwd: f.root }), /disabled/);
});
test('Jev receives no raw task/path/account/model labels and only eligible routes; disabled/single/zero do no evaluation', async t => {
 const f = await fixture(t, { decisions: { mode: 'jev', cloudMetadata: true } }); await f.secrets.set('synthetic-decision');
 const result = await f.coordinator.recommend({ ...launch(f), category: 'code' }); assert.equal(result.engine, 'jev'); assert.equal(f.evaluatorCalls(), 1);
 const payload = JSON.stringify(f.payloads[0]); for (const value of [f.root, 'claude-local', 'codex-local', 'synthetic-decision']) assert.equal(payload.includes(value), false);
 // Agent and model identities and reasoning traits are the routing signal; paths, route/account ids and secrets are not.
 assert.equal(payload.includes('"agent":"claude"'), true); assert.equal(payload.includes('limitHeadroom'), true); assert.equal(payload.includes('"text"'), false);
 f.settings.decisions.routes = [f.settings.decisions.routes[0]]; await f.coordinator.recommend(launch(f)); assert.equal(f.evaluatorCalls(), 1); assert.equal(f.decisionSecretReads(), 1);
 await assert.rejects(f.coordinator.recommend({ ...launch(f), initialPrompt: 'PRIVATE_TASK' }), /No eligible/); assert.equal(f.evaluatorCalls(), 1);
 f.settings.decisions.mode = 'off'; await assert.rejects(f.coordinator.recommend(launch(f)), /disabled/); assert.equal(f.decisionSecretReads(), 1);
});
test('stale recommendations never retarget after configuration, session, expiry or key changes', async t => {
 let now = 100;
 const f = await fixture(t, { now: () => now });
 let review = await f.coordinator.recommend(launch(f)); now += 60001; await assert.rejects(f.coordinator.launch(review.id), /expired/);
 review = await f.coordinator.recommend(launch(f)); f.settings.decisions.routes.reverse(); await assert.rejects(f.coordinator.launch(review.id), /changed/);
 review = await f.coordinator.recommend(launch(f)); await f.secrets.set('new-synthetic'); await assert.rejects(f.coordinator.launch(review.id), /absent/);
 review = await f.coordinator.recommend(launch(f)); f.manager.create({ ...launch(f), provider: 'codex', position: { x: 0, y: 0 } }); await assert.rejects(f.coordinator.launch(review.id), /changed/);
});
test('key/grant/session revocation aborts pending evaluator and suppresses late result', async t => {
 let observedSignal, finish;
 const f = await fixture(t, { decisions: { mode: 'jev', cloudMetadata: true }, evaluate(request, key, signal) { observedSignal = signal; return new Promise(resolve => { finish = () => resolve(response()); }); } });
 await f.secrets.set('synthetic');
 const pending = f.coordinator.recommend(launch(f));
 while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
 await f.secrets.remove(); assert.equal(observedSignal.aborted, true); finish(); await assert.rejects(pending, /changed|abort/);
});

import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';
import { DecisionCoordinator } from '../src/main/services/decision/DecisionCoordinator.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { IPC } from '../src/shared/contracts.ts';
import { validateOrchestrationArguments } from '../src/agent-browser/orchestration-catalog.mjs';
function assessed(account, profiles = []) { return { ...account, assessment: { profile: { training: 'none', retention: 'bounded', thirdPartyProcessing: 'no', contractualMode: 'business' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: 'Explicit synthetic route assessment', binding: accountRouteBinding(account, profiles), models: '*' } } }; }
test('concurrent recommendations reserve one actual evaluator call under minute budget', async t => {
 const f = await fixture(t, { decisions: { mode: 'jev', cloudMetadata: true, maxCallsPerMinute: 1 } });
 let release, reads = 0, calls = 0; const held = new Promise(resolve => { release = resolve; });
 const coordinator = new DecisionCoordinator({ settings: () => f.settings, terminals: f.manager, control: f.control, secrets: { generation: 0, async get() { reads++; await held; return 'synthetic'; } }, backend: { async evaluate() { calls++; return response(); } } }); t.after(() => coordinator.dispose());
 const a = coordinator.recommend(launch(f)), b = coordinator.recommend(launch(f));
 while (reads !== 2) await new Promise(resolve => setTimeout(resolve, 1)); release();
 const results = await Promise.all([a, b]); assert.equal(calls, 1); assert.equal(results.filter(r => r.fallbackReason === 'evaluation-budget').length, 1);
});
test('adversarial valid glob patterns have bounded work in a real subprocess', async () => {
 const code = `import { rankRoutes } from './src/main/services/decision/rules.ts'; const route={id:'a',provider:'claude',hostId:'local',transport:'pty'}; const config={rules:[{id:'r',pathPattern:'**'+'*a'.repeat(22)+'b',prefer:['a']}]}; console.log(rankRoutes(config,{cwd:'/'+'a'.repeat(4095),dataClass:'D0'},[route]).routes[0].id);`;
 const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 1500, maxBuffer: 1024 }); assert.equal(result.stdout.trim(), 'a');
});
test('account-host affinity and max1/max2 limits apply before model calls, credentials, or process preparation', async t => {
 const f = await fixture(t, { decisions: { mode: 'jev', cloudMetadata: true } });
 const a = assessed({ id: 'a', label: 'Private A', provider: 'claude', hostId: 'local', models: ['allowed'], binding: { kind: 'cli-home', directory: f.root } });
 const b = assessed({ ...a, id: 'b', label: 'Private B', binding: { kind: 'cli-home', directory: `${f.root}/second-home` } });
 f.settings.providerAccounts = [a, b]; f.settings.decisions.routes = [{ id: 'route', provider: 'claude', accountId: 'a', model: 'allowed', hostId: 'local', transport: 'pty' }];
 await assert.rejects(f.coordinator.recommend({ ...launch(f), initialPrompt: 'private task' }), /No eligible/);
 f.settings.maxAccountsPerProviderPerHost = 2; const review = await f.coordinator.recommend({ ...launch(f), initialPrompt: 'private task' }); assert.equal(review.selected.accountId, 'a'); assert.equal(review.dataClass, 'D2');
 await assert.rejects(f.coordinator.recommend({ ...launch(f), model: 'forbidden' }), /No eligible/);
 await assert.rejects(f.coordinator.recommend({ ...launch(f), hostId: 'other-host' }), /No eligible/);
 f.settings.providerAccounts.push(assessed({ ...b, id: 'c', binding: { kind: 'cli-home', directory: `${f.root}/third-home` } }));
 await assert.rejects(f.coordinator.recommend(launch(f)), /No eligible/);
 assert.equal(f.secretReads(), 0); assert.equal(f.decisionSecretReads(), 0); assert.equal(f.evaluatorCalls(), 0); assert.equal(f.calls.length, 0);
});
test('unsupported transport/models and exhausted ordinary capacity never reach evaluator', async t => {
 const f = await fixture(t, { decisions: { mode: 'jev', cloudMetadata: true } });
 for (const route of [{ id: 'm', provider: 'minimax', model: 'unqualified', hostId: 'local', transport: 'pty' }, { id: 'c', provider: 'claude', hostId: 'local', transport: 'acp' }, { id: 'r', provider: 'codex', hostId: 'remote', transport: 'pty' }]) {
  f.settings.decisions.routes = [route]; await assert.rejects(f.coordinator.recommend(launch(f)), /No eligible/);
 }
 f.settings.decisions.routes = [{ id: 'c', provider: 'claude', hostId: 'local', transport: 'pty' }];
 f.settings.agentBudgets.maxLocalAgents = 1; const parent = f.manager.create({ ...launch(f), provider: 'claude', position: { x: 0, y: 0 } }); await f.manager.waitForLaunch(parent.id);
 await assert.rejects(f.coordinator.recommend(launch(f)), /No eligible/); assert.equal(f.decisionSecretReads(), 0); assert.equal(f.evaluatorCalls(), 0);
});
test('grant changes, caller disposal and foreign owner reject pending or reviewed decisions', async t => {
 let finish, signal;
 const f = await fixture(t, { decisions: { mode: 'jev', cloudMetadata: true }, evaluate(_r, _k, s) { signal = s; return new Promise(resolve => { finish = () => resolve(response()); }); } }); await f.secrets.set('synthetic');
 const { parent } = await parentClient(t, f);
 const pending = f.coordinator.recommend(launch(f), parent.id); while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
 f.manager.dispose(parent.id); assert.equal(signal.aborted, true); finish(); await assert.rejects(pending);
 finish = undefined; const next = f.coordinator.recommend(launch(f)); while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
 f.settings.decisions.cloudMetadata = false; f.coordinator.invalidate(); assert.equal(signal.aborted, true); finish(); await assert.rejects(next);
 f.settings.decisions.mode = 'rules'; const review = await f.coordinator.recommend(launch(f)); await assert.rejects(f.coordinator.launch(review.id, 'foreign'), /another caller/);
});
test('evaluator errors and low confidence use fixed fallback; rules override scoring without a credential read', async t => {
 const f = await fixture(t, { decisions: { mode: 'jev', cloudMetadata: true }, evaluate() { const result = response(); result.answers.route.confidence = 0.1; return result; } }); await f.secrets.set('synthetic');
 const low = await f.coordinator.recommend(launch(f)); assert.equal(low.engine, 'rules'); assert.equal(low.fallbackReason, 'low-confidence');
 f.settings.decisions.rules = [{ id: 'prefer-codex', prefer: ['codex-local'] }]; const byRule = await f.coordinator.recommend(launch(f)); assert.equal(byRule.selected.provider, 'codex'); assert.equal(f.evaluatorCalls(), 1); assert.equal(f.decisionSecretReads(), 1);
});
test('bounded strict adapter rejects every missing/extra/type/byte/depth/id error and cancels deadline without retry', async () => {
 for (const source of ['{"x":1,"\\u0078":2}', '{"x":1e999}', '['.repeat(18) + '0' + ']'.repeat(18), JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), JSON.stringify({ ...response(), answers: [] })]) await assert.rejects(new JevBackend(async () => new Response(source)).evaluate(request, 'synthetic', new AbortController().signal));
 let calls = 0, signal;
 const backend = new JevBackend(async (_u, options) => { calls++; signal = options.signal; return new Promise(() => {}); });
 await assert.rejects(backend.evaluate(request, 'synthetic', new AbortController().signal), /deadline/); assert.equal(calls, 1); assert.equal(signal.aborted, true);
 const aborted = new AbortController(); aborted.abort(); await assert.rejects(backend.evaluate(request, 'synthetic', aborted.signal)); assert.equal(calls, 1);
});
test('decision IPC rejects foreign renderer, exposes no secret value, and catalog rejects unknown nested fields', async () => {
 const source = await readFile(new URL('../src/main/ipc/registerIpc.ts', import.meta.url), 'utf8'), handlers = new Map(), calls = [];
 const frame = {}, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
 const code = stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*$/gmu, '').replace('export function registerIpc', 'function registerIpc');
 const decisions = Object.fromEntries(['recommend', 'launch', 'cancel', 'invalidate'].map(name => [name, (...args) => { calls.push([name, ...args]); return {}; }]));
 const secrets = Object.fromEntries(['status', 'set', 'remove'].map(name => [name, (...args) => { calls.push([name, ...args]); return name === 'status' ? { configured: true } : undefined; }]));
 runInNewContext(code + '\nregisterIpc', { IPC, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }, PluginBrowserOpenBroker: class {}, observeWindowState() {}, createWindowStateObserver: () => () => {} })({ decisions, decisionSecrets: secrets, getMainWindow: () => window });
 const channels = [IPC.decisionRecommend, IPC.decisionLaunch, IPC.decisionCancel, IPC.decisionSecretStatus, IPC.decisionSecretSet, IPC.decisionSecretRemove];
 for (const channel of channels) for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }]) await assert.rejects(async () => handlers.get(channel)(event, {}), /trusted/);
 assert.equal(calls.length, 0);
 assert.deepEqual(await handlers.get(IPC.decisionSecretStatus)({ sender: contents, senderFrame: frame }), { configured: true });
 assert.equal(validateOrchestrationArguments('recommend_agent', { cwd: '/a', policy: { trusted: true } }).ok, false);
 assert.equal(validateOrchestrationArguments('launch_recommended_agent', { recommendationId: 'a', provider: 'codex' }).ok, false);
});

import { ContextProfileStore } from '../src/main/services/ContextProfileStore.ts';
import { ContextLaunchService } from '../src/main/services/ContextLaunchService.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { DecisionSecrets } from '../src/main/services/decision/DecisionSecrets.ts';
import { ProviderSecretsService } from '../src/main/services/ProviderSecretsService.ts';
import { SettingsStore } from '../src/main/services/SettingsStore.ts';
import { join } from 'node:path';

test('exact reviewed provider context is carried to real launch, optional filtering and changes invalidate stale review', async t => {
 const f = await fixture(t);
 f.settings.contextProfilesEnabled = true;
 const profiles = new ContextProfileStore(join(f.root, 'contexts')), context = new ContextLaunchService(profiles);
 f.manager.configureContextLaunch(context, () => f.settings.contextProfilesEnabled);
 f.manager.configureLaunchPolicy(new SessionLaunchPolicy(() => f.settings, { context, repositoryRoot: () => f.root }));
 let state = await profiles.saveProject({ root: f.root, label: 'Synthetic' }, 0);
 state = await profiles.saveRule({ scope: 'project', ownerId: state.projects[0].id, category: 'design', key: 'tone', value: 'PRIVATE_CONTEXT_SENTINEL', tags: [], enabled: true, dataClass: 'D2' }, state.revision);
 f.settings.providerAccounts = [assessed({ id: 'private', provider: 'claude', label: 'Private route', hostId: 'local', binding: { kind: 'cli-home', directory: f.root } })];
 f.settings.decisions.routes[0].accountId = 'private';
 f.settings.decisions.rules = [{ id: 'private-first', prefer: ['claude-local'] }];
 const review = await f.coordinator.recommend({ ...launch(f), context: { enabled: true } }); assert.ok(review.contextBytes > 0); assert.equal(review.dataClass, 'D2');
 const created = await f.coordinator.launch(review.id); await f.manager.waitForLaunch(created.id);
 assert.equal(f.manager.list().find(s => s.id === created.id).exitCode, null, f.manager.list().find(s => s.id === created.id).failureDetails);
 assert.equal(f.calls[0].args.filter(a => String(a).includes('PRIVATE_CONTEXT_SENTINEL')).length, 1);
 f.settings.decisions.rules = [{ id: 'public-first', prefer: ['codex-local'] }];
 const low = await f.coordinator.recommend({ ...launch(f), context: { enabled: true } }); assert.equal(low.contextBytes, 0); assert.equal(low.selected.provider, 'codex');
 const stale = await f.coordinator.recommend({ ...launch(f), context: { enabled: true } });
 await profiles.saveRule({ ...state.rules[0], value: 'CHANGED_CONTEXT_SENTINEL' }, state.revision);
 await assert.rejects(f.coordinator.launch(stale.id), /changed|stale/);
 const disabled = await f.coordinator.recommend({ ...launch(f), context: { enabled: false } }); assert.equal(disabled.contextBytes, 0);
});
test('separate Jev store never falls back to provider keys and notifies revocation without plaintext status', async t => {
 const f = await fixture(t), encryption = { isAvailable: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() };
 const provider = new ProviderSecretsService(f.root, encryption); await provider.set('OPENAI_API_KEY', 'provider-only-synthetic');
 let changed = 0; const store = new DecisionSecrets(f.root, encryption, () => changed++);
 assert.equal(await store.get(), null); assert.deepEqual(await store.status(), { configured: false });
 await store.set('decision-only-synthetic'); assert.deepEqual(await store.status(), { configured: true }); assert.equal(await provider.get('OPENAI_API_KEY'), 'provider-only-synthetic');
 const reloaded = new DecisionSecrets(f.root, encryption); assert.equal(await reloaded.get(), 'decision-only-synthetic');
 await store.remove(); assert.equal(changed, 2); assert.equal(await store.get(), null);
 let revocations = 0; const unsubscribe = provider.onChanged(() => revocations++); await provider.set('OPENAI_API_KEY', 'next-provider-synthetic'); unsubscribe(); await provider.delete('OPENAI_API_KEY'); assert.equal(revocations, 1);
});
test('settings persist validated route configuration and invalid updates leave saved decision policy intact', async t => {
 const f = await fixture(t); const settings = new SettingsStore(join(f.root, 'settings-test'), 'ru');
 assert.equal(settings.get().decisions.mode, 'off');
 const accepted = await settings.update({ decisions: f.settings.decisions }); assert.equal(accepted.decisions.mode, 'rules');
 await assert.rejects(settings.update({ decisions: { ...f.settings.decisions, cloudSource: true } }));
 assert.deepEqual(settings.get().decisions, accepted.decisions);
 const reopened = new SettingsStore(join(f.root, 'settings-test'), 'ru'); await reopened.load(); assert.deepEqual(reopened.get().decisions, accepted.decisions);
});
