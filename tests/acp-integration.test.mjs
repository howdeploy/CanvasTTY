import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TerminalSessionStore, persistedTerminalSession } from '../src/main/services/TerminalSessionStore.ts';
import { PassThrough } from 'node:stream';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { AgentControlService } from '../src/main/services/AgentControlService.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { SessionLaunchCoordinator } from '../src/main/services/SessionLaunchCoordinator.ts';
import { ProviderAccountLaunchService } from '../src/main/services/ProviderAccountLaunchService.ts';
import { ScopedOrchestrationHandler } from '../src/main/services/agent-browser/OrchestrationTools.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fakeAgent(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.frames = []; child.killed = false;
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); return true; };
  child.frame = frame => child.stdout.write(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`));
  child.reply = (id, result) => child.frame({ id, result });
  child.update = update => child.frame({ method: 'session/update', params: { sessionId: 'fixture-session', update } });
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); child.frames.push(frame);
      queueMicrotask(() => {
        if (options.onFrame?.(frame, child)) return;
        if (frame.method === 'initialize') child.reply(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
        if (frame.method === 'session/new' || frame.method === 'session/load') child.reply(frame.id, { sessionId: 'fixture-session', configOptions: [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: options.model ?? 'model-a', options: [{ value: options.model ?? 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' }] }] });
        if (frame.method === 'session/prompt') { child.prompt = frame; if (!options.hold) { child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Visible answer ✓' } }); child.reply(frame.id, { stopReason: 'end_turn' }); } }
        if (frame.method === 'session/cancel' && child.prompt) child.reply(child.prompt.id, { stopReason: 'cancelled' });
      });
    }
  });
  return child;
}
function fixture(options = {}) {
  let settings = { defaultDataClass: 'D0', providerAccounts: [], apiProfiles: [], pathPolicies: [], remoteHosts: [], agentBudgets: { maxLocalAgents: 4, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 }, ...options.settings };
  const children = [], ptys = [], writes = [], exits = [];
  const registry = { get: provider => ({ state: 'available', provider, executable: `/fixture/${provider}`, launcher: 'native', environment: {}, checked: [] }) };
  const terminals = new TerminalManager(() => {}, registry, undefined, undefined, true, (...args) => { ptys.push(args); return { write: text => writes.push(text), resize() {}, kill() {}, onData() {}, onExit(callback) { exits.push(callback); } }; });
  terminals.configureLaunchPolicy(new SessionLaunchPolicy(() => settings, { repositoryRoot: () => process.cwd() }));
  const accounts = new ProviderAccountLaunchService(() => settings, { generation: 0, get: options.fakeSecret ?? (async () => { throw Error('No credential reads'); }) }, { temporaryRoot: options.temporaryRoot });
  terminals.configureProviderLaunch(new SessionLaunchCoordinator(accounts, {}, () => settings, {}));
  terminals.configureAcp({ spawn: (command, args, config) => { const child = fakeAgent(options); child.launchConfig = config; if (options.kill) child.kill = signal => options.kill(child, signal); children.push({ child, command, args, config }); return child; }, deadlines: options.deadlines });
  const control = new AgentControlService(terminals);
  return { terminals, control, children, ptys, writes, exits, settings, update: patch => { settings = { ...settings, ...patch }; } };
}
const request = extra => ({ provider: 'cursor', cwd: process.cwd(), profile: 'normal', position: { x: 0, y: 0 }, ...extra });

test('real policy/coordinator/control chain admits one ACP initial prompt, observes and completes without exiting', async t => {
  const f = fixture(); t.after(() => f.terminals.disposeAll());
  const parent = f.terminals.create(request({ provider: 'terminal', role: 'orchestrator' })); await f.terminals.waitForLaunch(parent.id);
  const scope = new ScopedOrchestrationHandler(f.control);
  const { sessionId } = await scope.execute(parent.id, { tool: 'spawn_agent', arguments: { provider: 'cursor', cwd: process.cwd(), transport: 'acp', prompt: 'Do once' } });
  await f.terminals.waitForLaunch(sessionId); await tick();
  assert.equal(f.ptys.length, 1); assert.equal(f.children.length, 1);
  const child = f.children[0].child;
  assert.deepEqual(f.children[0].args, ['acp']);
  assert.deepEqual(child.frames[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.equal(child.frames.filter(f => f.method === 'session/prompt').length, 1);
  assert.match((await scope.execute(parent.id, { tool: 'observe_agent', arguments: { sessionId } })).output, /Visible answer/);
  const result = await scope.execute(parent.id, { tool: 'get_agent_result', arguments: { sessionId } });
  assert.equal(result.state, 'done'); assert.equal(f.control.status(sessionId).exitCode, null); assert.equal(child.killed, false);
  f.control.send(sessionId, 'Again'); await tick(); assert.equal(child.frames.filter(f => f.method === 'session/prompt').length, 2);
});

test('default PTY starts no ACP and passes its initial task once as literal argv', async t => {
  const f = fixture(); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ initialPrompt: 'Only once' })); await f.terminals.waitForLaunch(session.id);
  assert.equal(f.children.length, 0); assert.deepEqual(f.writes, []);
  assert.equal(f.ptys[0][1].at(-1), 'CanvasTTY task:\nOnly once');
  f.exits[0]({ exitCode: 0 });
  f.terminals.restart(session.id); await f.terminals.waitForLaunch(session.id);
  assert.equal(f.ptys.length, 2); assert.equal(f.ptys[1][1].includes('CanvasTTY task:\nOnly once'), false);
});

test('account, privacy, budget and unsupported route deny ACP before subprocess creation', async t => {
  const f = fixture(); t.after(() => f.terminals.disposeAll());
  for (const extra of [{ accountId: 'missing' }, { dataClass: 'D3' }, { hostId: 'remote' }, { isolation: { mode: 'container', profileId: 'x' } }, { provider: 'codex' }]) assert.throws(() => f.terminals.create(request({ transport: 'acp', ...extra })));
  f.update({ agentBudgets: { ...f.settings.agentBudgets, maxLocalAgents: 0 } });
  assert.throws(() => f.terminals.create(request({ transport: 'acp' })));
  assert.equal(f.children.length, 0); assert.equal(f.ptys.length, 0);
});

export { fixture, fakeAgent, tick, request };

test('all three providers share configOptions-only model negotiation without login or PTY flags', async t => {
  for (const provider of ['cursor', 'minimax', 'kimi']) {
    const model = provider === 'minimax' ? 'm:minimax:MODEL:u' : 'model-b';
    const f = fixture({ model, onFrame(frame, child) {
      if (frame.method === 'session/new') { child.reply(frame.id, { sessionId: 'fixture-session', configOptions: [{ id: 'catalog-model', type: 'select', category: 'model', currentValue: 'other', options: [{ value: 'other', name: 'Other' }, { value: model, name: 'Requested' }] }] }); return true; }
      if (frame.method === 'session/set_config_option') { assert.equal(frame.params.value, model); child.reply(frame.id, { configOptions: [{ id: 'catalog-model', type: 'select', category: 'model', currentValue: model, options: [{ value: model, name: 'Requested' }] }] }); return true; }
    } }); t.after(() => f.terminals.disposeAll());
    const session = f.terminals.create(request({ provider, transport: 'acp', model: provider === 'minimax' ? 'minimax/MODEL' : model, initialPrompt: 'Go' }));
    await f.terminals.waitForLaunch(session.id); await tick();
    assert.equal(f.control.result(session.id).state, 'done', f.control.status(session.id).failureDetails);
    assert.equal(f.control.status(session.id).acp.effectiveModel, model);
    assert.deepEqual(f.children[0].args, ['acp']); assert.equal(f.children[0].child.frames.some(f => f.method === 'authenticate'), false);
  }
});

test('MiniMax API keeps private data roots and confirms provider-qualified values even with slash/Unicode model names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvastty-acp-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const model = 'MODEL/variant:✓%'; let privateRoot;
  const f = fixture({ temporaryRoot: root, fakeSecret: async () => 'fixture-only-value', settings: {
    providerAccounts: [{ id: 'mini', provider: 'minimax', label: 'Mini', models: [model], binding: { kind: 'api-profile', profileId: 'api' } }],
    apiProfiles: [{ id: 'api', name: 'Fixture', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', secretRef: 'MINIMAX_API_KEY', defaultModel: model }]
  }, onFrame(frame, child) {
    if (frame.method !== 'session/new') return;
    privateRoot = child.launchConfig.env.MINIMAX_DATA_DIR;
    assert.equal(child.launchConfig.env.MAVIS_DATA_DIR, privateRoot);
    const config = JSON.parse(readFileSync(join(privateRoot, 'config.yaml'), 'utf8'));
    const provider = `custom_provider:${Object.keys(config.custom_provider)[0]}`;
    const value = `m:${encodeURIComponent(provider)}:${encodeURIComponent(model)}:u`;
    child.reply(frame.id, { sessionId: 'fixture-session', configOptions: [{ id: 'model', type: 'select', category: 'model', currentValue: value, options: [{ value, name: model }, { value: `m:other:${encodeURIComponent(model)}:u`, name: model }] }] }); return true;
  } }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ provider: 'minimax', transport: 'acp', accountId: 'mini', model, initialPrompt: 'Go' }));
  await f.terminals.waitForLaunch(session.id); await tick();
  assert.equal(f.control.result(session.id).state, 'done', f.control.status(session.id).failureDetails);
  assert.deepEqual(f.children[0].args, ['acp']);
  await assert.rejects(f.terminals.selectAcpModel(session.id, `m:other:${encodeURIComponent(model)}:u`), /different MiniMax provider/);
  await f.terminals.shutdown(); assert.equal(existsSync(privateRoot), false);
});

test('permissions require exact offered option and owning session; cancellation rejects pending approvals and preserves session', async t => {
  const f = fixture({ hold: true }); t.after(() => f.terminals.disposeAll());
  const one = f.terminals.create(request({ transport: 'acp' })); const two = f.terminals.create(request({ transport: 'acp' }));
  await Promise.all([f.terminals.waitForLaunch(one.id), f.terminals.waitForLaunch(two.id)]);
  f.control.send(one.id, 'Wait'); await tick(); const child = f.children[0].child;
  const permission = id => child.frame({ id, method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { title: 'Write selected file', rawInput: { secret: 'DO_NOT_SHOW' } }, options: [{ optionId: 'vendor-allow-exact', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }] } });
  permission(0); const token = f.control.status(one.id).acp.permissions[0].requestId;
  assert.equal(child.frames.some(frame => frame.id === 0), false);
  assert.throws(() => f.terminals.decideAcpPermission(two.id, token, 'vendor-allow-exact'), /absent|expired/);
  assert.throws(() => f.terminals.decideAcpPermission(one.id, token, 'allow_once'), /invalid option/);
  f.terminals.decideAcpPermission(one.id, token, 'vendor-allow-exact');
  assert.deepEqual(child.frames.find(frame => frame.id === 0).result, { outcome: { outcome: 'selected', optionId: 'vendor-allow-exact' } });
  assert.throws(() => f.terminals.decideAcpPermission(one.id, token, 'vendor-allow-exact'), /absent|expired/);
  permission('second'); f.control.cancel(one.id); await tick();
  assert.equal(child.frames.find(frame => frame.id === 'second').result.outcome.outcome, 'cancelled');
  assert.equal(f.control.result(one.id).stopReason, 'cancelled'); assert.equal(f.control.status(one.id).exitCode, null);
  assert.equal(child.frames.find(frame => frame.method === 'session/cancel').id, undefined);
  assert.equal(JSON.stringify(f.control.status(one.id)).includes('DO_NOT_SHOW'), false);
});

test('foreign permission requests, Cursor extensions and privileged inbound commands cannot grant or execute', async t => {
  const f = fixture({ hold: true }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id); f.control.send(session.id, 'Go'); await tick();
  const child = f.children[0].child;
  child.frame({ id: 0, method: 'session/request_permission', params: { sessionId: 'foreign', options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] } });
  for (const method of ['cursor/ask_question', 'cursor/create_plan', 'fs/write_text_file', 'terminal/create']) child.frame({ id: method, method, params: { sessionId: 'fixture-session', command: 'NO_EXECUTION' } });
  assert.equal(child.frames.find(frame => frame.id === 0).result.outcome.outcome, 'cancelled');
  for (const method of ['cursor/ask_question', 'cursor/create_plan']) assert.equal(child.frames.find(frame => frame.id === method).result.outcome.outcome, 'cancelled');
  for (const method of ['fs/write_text_file', 'terminal/create']) assert.equal(child.frames.find(frame => frame.id === method).error.code, -32601);
});

test('overlap and terminal keystrokes cannot submit ACP prompts; scoped control rejects siblings', async t => {
  const f = fixture({ hold: true }); t.after(() => f.terminals.disposeAll());
  const parent = f.terminals.create(request({ provider: 'terminal', role: 'orchestrator' })); await f.terminals.waitForLaunch(parent.id);
  const child = f.control.spawn({ parentSessionId: parent.id, provider: 'kimi', cwd: process.cwd(), transport: 'acp' }); await f.terminals.waitForLaunch(child.id);
  const sibling = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(sibling.id);
  f.terminals.input(child.id, 'raw\r'); assert.throws(() => f.control.send(child.id, 'draft', false), /complete submitted/);
  f.control.send(child.id, 'real'); assert.throws(() => f.control.send(child.id, 'second'), /active turn/);
  const scope = new ScopedOrchestrationHandler(f.control);
  await assert.rejects(scope.execute(parent.id, { tool: 'send_to_agent', arguments: { sessionId: sibling.id, prompt: 'No' } }));
  await tick(); assert.equal(f.children[0].child.frames.filter(frame => frame.method === 'session/prompt').length, 1);
});

test('unresponsive cancelled process holds budget until its confirmed exit; restart ignores old generation', async t => {
  const f = fixture({ hold: true, deadlines: { cancel: 5 }, kill: () => true, settings: { agentBudgets: { maxLocalAgents: 1, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 } }, onFrame(frame) { if (frame.method === 'session/cancel') return true; } }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp', initialPrompt: 'At most once' })); await f.terminals.waitForLaunch(session.id); await tick();
  f.control.cancel(session.id); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.control.status(session.id).exitCode, null); assert.throws(() => f.terminals.create(request({ transport: 'acp' })), /concurrency/);
  const old = f.children[0].child; old.emit('exit', 0); assert.equal(f.control.status(session.id).exitCode, 1);
  f.terminals.restart(session.id); await f.terminals.waitForLaunch(session.id); await tick();
  old.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE' } });
  assert.equal(f.control.observe(session.id).output.includes('STALE'), false);
  assert.equal(f.children[1].child.frames.some(frame => frame.method === 'session/prompt'), false);
  f.children[1].child.emit('exit', 0);
});

test('restore loads only the bound known ACP conversation and never replays an initial task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvastty-acp-restore-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(); const session = f.terminals.create(request({ transport: 'acp', initialPrompt: 'Once' })); await f.terminals.waitForLaunch(session.id); await tick();
  const saved = persistedTerminalSession(f.control.status(session.id)); f.terminals.disposeAll();
  const store = new TerminalSessionStore(root); await store.replace([saved]);
  const restored = fixture(); t.after(() => restored.terminals.disposeAll()); restored.terminals.configureSessionPersistence(store, true);
  await restored.terminals.restorePersistedSessions(); await restored.terminals.waitForLaunch(session.id);
  assert.equal(restored.children[0].child.frames.some(frame => frame.method === 'session/load'), true);
  assert.equal(restored.children[0].child.frames.some(frame => frame.method === 'session/new' || frame.method === 'session/prompt'), false);
  await restored.terminals.shutdown();
  for (const descriptor of [{ ...saved, acpResume: undefined }, { ...saved, acpResume: { ...saved.acpResume, binding: '0'.repeat(64) } }]) {
    await store.replace([descriptor]); const refused = fixture(); refused.terminals.configureSessionPersistence(store, true); await refused.terminals.restorePersistedSessions(); await refused.terminals.waitForLaunch(session.id);
    assert.equal(refused.children.length, 0); assert.match(refused.control.status(session.id).failureDetails, /resume unavailable/); await refused.terminals.shutdown();
  }
  await store.flush();
});

test('initialization timeout cannot release the session budget while its process remains alive', async t => {
  const f = fixture({ deadlines: { initialize: 5 }, kill: () => true, onFrame(frame) { return frame.method === 'initialize'; } }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id);
  assert.equal(f.control.status(session.id).exitCode, null);
  assert.equal(f.control.status(session.id).acp.phase, 'failed');
  f.children[0].child.emit('exit', 0); assert.equal(f.control.status(session.id).exitCode, 1);
});

test('broken stdin while cancelling permission cannot recurse or leave the process alive', async t => {
  const f = fixture({ hold: true }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id); f.control.send(session.id, 'Go'); await tick();
  const child = f.children[0].child;
  child.frame({ id: 0, method: 'session/request_permission', params: { sessionId: 'fixture-session', options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] } });
  child.stdin.write = () => { throw Error('broken pipe'); };
  assert.doesNotThrow(() => child.emit('error', Error('fixture failure'))); await tick();
  assert.equal(child.killed, true); assert.equal(f.control.status(session.id).acp.permissions.length, 0); assert.equal(f.control.result(session.id).state, 'failed');
});

test('dispose retains the central capacity reservation until confirmed process exit', async t => {
  const f = fixture({ kill: () => true, settings: { agentBudgets: { maxLocalAgents: 1, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 } } }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id);
  f.terminals.dispose(session.id); assert.equal(f.terminals.list().length, 0);
  assert.throws(() => f.terminals.create(request({ transport: 'acp' })), /concurrency/);
  f.children[0].child.emit('exit', 0);
  const next = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(next.id); f.children[1].child.emit('exit', 0);
});

test('streaming UTF-8 and multiple frames preserve visible text and omit thoughts/raw tool payloads', async t => {
  const f = fixture({ hold: true }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id); f.control.send(session.id, 'Go'); await tick();
  const child = f.children[0].child;
  const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A✓Б' } } } }) + '\n');
  const split = frame.indexOf(Buffer.from('✓')) + 1; child.stdout.write(frame.subarray(0, split)); child.stdout.write(frame.subarray(split));
  child.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_THOUGHT' } });
  child.update({ sessionUpdate: 'tool_call', title: 'Read file', rawInput: 'PRIVATE_RAW', rawOutput: 'PRIVATE_OUTPUT' });
  child.reply(child.prompt.id, { stopReason: 'end_turn' }); await tick();
  assert.equal(f.control.result(session.id).output, 'A✓Б'); assert.equal(JSON.stringify(f.control.status(session.id)).includes('PRIVATE_'), false);
  assert.equal(f.control.status(session.id).acp.activity, 'Read file');
});

for (const [name, corrupt] of [
  ['malformed JSON', child => child.stdout.write('{broken\n')],
  ['invalid UTF-8', child => child.stdout.write(Buffer.from([0xc3, 0x28, 10]))],
  ['oversized frame', child => child.stdout.write(Buffer.alloc(1_048_577, 32))],
  ['foreign session update', child => child.frame({ method: 'session/update', params: { sessionId: 'foreign', update: {} } })],
  ['unknown response ID', child => child.reply(999, {})],
  ['invalid JSON-RPC discriminator', child => child.stdout.write('{"jsonrpc":"2.0","id":123,"method":"x","result":{}}\n')]
]) test(`${name} fails closed, tears down pending turn and never falls back to PTY`, async t => {
  const f = fixture({ hold: true }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id); f.control.send(session.id, 'Go'); await tick();
  corrupt(f.children[0].child); await tick();
  assert.equal(f.control.result(session.id).state, 'failed'); assert.equal(f.children[0].child.killed, true); assert.equal(f.ptys.length, 0);
});

for (const [name, onFrame] of [
  ['protocol v2', (frame, child) => { if (frame.method === 'initialize') { child.reply(frame.id, { protocolVersion: 2 }); return true; } }],
  ['invalid session ID', (frame, child) => { if (frame.method === 'session/new') { child.reply(frame.id, { sessionId: '' }); return true; } }],
  ['authentication required', (frame, child) => { if (frame.method === 'session/new') { child.frame({ id: frame.id, error: { code: -32000, message: 'SENSITIVE_RAW' } }); return true; } }],
  ['legacy-only Kimi model response', (frame, child) => { if (frame.method === 'session/new') { child.reply(frame.id, { sessionId: 'fixture-session', models: { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'A' }] } }); return true; } }],
  ['unconfirmed model setter', (frame, child) => { if (frame.method === 'session/new') { child.reply(frame.id, { sessionId: 'fixture-session', configOptions: [{ id: 'model', type: 'select', category: 'model', currentValue: 'wrong', options: [{ value: 'wrong', name: 'Wrong' }, { value: 'model-a', name: 'A' }] }] }); return true; } if (frame.method === 'session/set_config_option') { child.reply(frame.id, {}); return true; } }]
]) test(`${name} rejects requested model before prompt and does not trigger login`, async t => {
  const f = fixture({ onFrame }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ provider: 'kimi', model: 'model-a', transport: 'acp', initialPrompt: 'Never' })); await f.terminals.waitForLaunch(session.id); await tick();
  assert.equal(f.control.result(session.id).state, 'failed'); assert.equal(f.children[0].child.frames.some(frame => frame.method === 'session/prompt' || frame.method === 'authenticate'), false);
  assert.equal(JSON.stringify(f.control.status(session.id)).includes('SENSITIVE_RAW'), false); assert.deepEqual(f.children[0].args, ['acp']);
});

test('effective model updates recheck policy, cancel an incompatible turn and block later prompts', async t => {
  const f = fixture({ hold: true }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id); f.control.send(session.id, 'Go'); await tick();
  f.update({ defaultDataClass: 'D3' });
  const child = f.children[0].child;
  child.update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', type: 'select', category: 'model', currentValue: 'model-b', options: [{ value: 'model-b', name: 'B' }] }] }); await tick();
  assert.equal(f.control.status(session.id).acp.effectiveModel, 'model-b'); assert.equal(f.control.result(session.id).stopReason, 'cancelled');
  assert.throws(() => f.control.send(session.id, 'Denied'), /D3/);
});

test('expired permissions cancel safely and server ID replay cannot obtain a grant', async t => {
  const f = fixture({ hold: true, deadlines: { permission: 5 } }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id); f.control.send(session.id, 'Go'); await tick();
  const child = f.children[0].child; const ask = () => child.frame({ id: 'reused', method: 'session/request_permission', params: { sessionId: 'fixture-session', options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] } });
  ask(); const token = f.control.status(session.id).acp.permissions[0].requestId; await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(child.frames.find(frame => frame.id === 'reused').result.outcome.outcome, 'cancelled'); assert.throws(() => f.terminals.decideAcpPermission(session.id, token, 'yes'));
  ask(); await tick(); assert.equal(f.control.result(session.id).state, 'failed');
});

test('worktree ACP uses execution cwd while policy keeps source cwd and cleanup waits for process exit', async t => {
  const { realpath, mkdir } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-acp-worktree-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), execution = join(root, 'worktree'); await mkdir(source); await mkdir(execution);
  const f = fixture({ kill: () => true }); const retained = [];
  const accounts = new ProviderAccountLaunchService(() => f.settings, { generation: 0, get: async () => { throw Error('No secrets'); } });
  const worktrees = { create: async () => ({ id: 'fixture-worktree', sourceDirectory: source, directory: execution, commit: 'fixture-commit' }), setRunning: async () => {}, retain: async (...args) => { retained.push(args); } };
  f.terminals.configureProviderLaunch(new SessionLaunchCoordinator(accounts, worktrees, () => f.settings, {}));
  const session = f.terminals.create(request({ transport: 'acp', cwd: source, isolation: { mode: 'worktree' } })); await f.terminals.waitForLaunch(session.id);
  assert.equal(f.children[0].config.cwd, execution); assert.equal(f.children[0].child.frames.find(frame => frame.method === 'session/new').params.cwd, execution);
  assert.equal(f.control.status(session.id).cwd, source); assert.equal(f.control.status(session.id).execution.filesystemRestricted, false);
  f.terminals.dispose(session.id); assert.equal(retained.length, 0);
  f.children[0].child.emit('exit', 0); await tick(); assert.ok(retained.every(args => args[1] === true));
});

test('ACP supplies scoped orchestration only to an authorized owner and revokes it on failure', async t => {
  const f = fixture(); t.after(() => f.terminals.disposeAll()); let prepared = 0, revoked = 0;
  f.terminals.configureOrchestration({ isEnabled: true, prepareLaunch({ terminalSessionId }) { prepared++; return { environment: { CANVASTTY_TERMINAL_SESSION_ID: terminalSessionId, FIXTURE_SCOPE: `scope-${terminalSessionId}` }, cleanup() { revoked++; } }; } });
  f.terminals.configureAcp({ spawn(command, args, config) { const child = fakeAgent(); f.children.push({ child, command, args, config }); return child; }, orchestrationCommand: { command: '/fixture/node', args: ['/fixture/scoped-helper.mjs'], environment: { ELECTRON_RUN_AS_NODE: '1' } } });
  const interactive = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(interactive.id);
  assert.deepEqual(f.children[0].child.frames.find(frame => frame.method === 'session/new').params.mcpServers, []);
  const owner = f.terminals.create(request({ transport: 'acp', role: 'orchestrator' })); await f.terminals.waitForLaunch(owner.id);
  const server = f.children[1].child.frames.find(frame => frame.method === 'session/new').params.mcpServers[0];
  assert.equal(server.type, undefined); assert.deepEqual(server.args, ['/fixture/scoped-helper.mjs']); assert.ok(server.env.some(entry => entry.name === 'CANVASTTY_TERMINAL_SESSION_ID' && entry.value === owner.id));
  assert.equal(prepared, 1); f.children[1].child.emit('error', Error('fixture failure')); await tick(); assert.equal(revoked, 1);
});

test('unsupported loadSession is visible and never creates a replacement conversation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvastty-acp-load-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(); const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id);
  const saved = persistedTerminalSession(f.control.status(session.id)); await f.terminals.shutdown();
  const store = new TerminalSessionStore(root); await store.replace([saved]);
  const restored = fixture({ onFrame(frame, child) { if (frame.method === 'initialize') { child.reply(frame.id, { protocolVersion: 1, agentCapabilities: {} }); return true; } } });
  restored.terminals.configureSessionPersistence(store, true); await restored.terminals.restorePersistedSessions(); await restored.terminals.waitForLaunch(session.id); await tick();
  assert.match(restored.control.status(session.id).failureDetails, /resume unavailable/);
  assert.equal(restored.children[0].child.frames.some(frame => frame.method === 'session/new' || frame.method === 'session/load'), false); await restored.terminals.shutdown();
});

test('Cursor authenticates only its advertised existing-login RPC and refuses a failed check before session creation', async t => {
  const f = fixture({ onFrame(frame, child) {
    if (frame.method === 'initialize') { child.reply(frame.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'cursor_login' }] }); return true; }
    if (frame.method === 'authenticate') { assert.equal(frame.params.methodId, 'cursor_login'); child.frame({ id: frame.id, error: { code: -32000, message: 'not logged in' } }); return true; }
  } }); t.after(() => f.terminals.disposeAll());
  const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id); await tick();
  assert.equal(f.control.result(session.id).state, 'failed'); assert.equal(f.children[0].child.frames.some(frame => frame.method === 'session/new'), false); assert.deepEqual(f.children[0].args, ['acp']);
});

test('turn output is bounded and stop reasons remain distinct from process completion', async t => {
  const f = fixture({ hold: true }); t.after(() => f.terminals.disposeAll()); const session = f.terminals.create(request({ transport: 'acp' })); await f.terminals.waitForLaunch(session.id);
  for (const stopReason of ['refusal', 'max_tokens', 'max_turn_requests']) {
    f.control.send(session.id, 'Go'); await tick(); const child = f.children[0].child; child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(300_000) } }); child.reply(child.prompt.id, { stopReason }); await tick();
    assert.equal(f.control.result(session.id).stopReason, stopReason); assert.equal(f.control.status(session.id).acp.output.length, 240_000); assert.ok(f.terminals.readBuffer(session.id).buffer.length <= 240_000); assert.equal(f.control.status(session.id).exitCode, null);
  }
});


test('an ACP parent being disposed loses capsule authority before its process exits', async t => {
  const f = fixture({ kill: () => true }); t.after(() => f.terminals.disposeAll());
  const parent = f.terminals.create(request({ transport: 'acp', role: 'orchestrator' }));
  await f.terminals.waitForLaunch(parent.id);
  assert.ok(f.terminals.capsuleAuthority(parent.id).generation);
  f.terminals.dispose(parent.id);
  assert.throws(() => f.terminals.capsuleAuthority(parent.id), /not authorized/i);
  f.children[0].child.emit('exit', 0); await tick();
});


test('actual manager/coordinator passes adversarial startup literally for every supported native agent', async t => {
  const text = '! command\n/command @file -x `code` $(code) Русский';
  for (const provider of ['codex', 'claude', 'qwen', 'opencode', 'hermes', 'grok', 'omp', 'pi', 'cursor', 'minimax', 'devin', 'antigravity']) {
    const f = fixture(); t.after(() => f.terminals.disposeAll());
    const session = f.terminals.create(request({ provider, initialPrompt: text }));
    if (provider === 'grok') { assert.equal(f.ptys.length, 0); f.terminals.resize(session.id, 90, 30); }
    await f.terminals.waitForLaunch(session.id);
    assert.equal(f.ptys.length, 1, `${provider}: ${f.terminals.list()[0].failureDetails}`);
    assert.equal(f.ptys[0][1].at(-1), `CanvasTTY task:\n${text}`, provider); assert.deepEqual(f.writes, []);
  }
});
