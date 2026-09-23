import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse as yaml } from 'yaml';
import { launchOptions, reconcileLaunchDraft } from '../src/renderer/src/features/launcher/launchDraft.ts';
import { ProviderLaunchAdapters } from '../src/main/services/agent-browser/ProviderLaunch.ts';
import { delegationLaunchFixture } from './helpers/delegation-launch-fixture.mjs';

async function fixture(t, hooks) { const f = await delegationLaunchFixture(hooks); t.after(() => f.cleanup()); return f; }
const request = (f, extra = {}) => ({ provider: 'claude', cwd: f.root, profile: 'normal', position: { x: 0, y: 0 }, ...extra });

test('renderer permission defaults off; enabled draft reaches real main and only orchestration MCP without browser access', async t => {
  const f = await fixture(t);
  const initial = reconcileLaunchDraft(null, 'claude', f.settings);
  assert.equal(initial.allowSubagents, false);
  const plainOptions = launchOptions(initial, f.settings);
  assert.equal(plainOptions.allowSubagents, undefined);
  const plain = f.manager.create({ ...plainOptions, position: { x: 0, y: 0 } }); await f.manager.waitForLaunch(plain.id);
  assert.equal(f.calls[0].args.includes('--mcp-config'), false);
  assert.equal(f.calls[0].options.env.CANVASTTY_ORCHESTRATION_CAPABILITY, undefined);
  const draft = { ...initial, allowSubagents: true, model: 'fixture-model' };
  assert.equal(reconcileLaunchDraft(draft, 'claude', { ...f.settings, lastDirectory: '/different' }), draft);
  const options = launchOptions(draft, f.settings);
  assert.equal(options.allowSubagents, true); assert.equal(options.role, undefined);
  await f.manager.previewContextLaunch({ ...options, position: { x: 0, y: 0 } }); assert.equal(f.calls.length, 1);
  const parent = f.manager.create({ ...options, position: { x: 0, y: 0 } }); await f.manager.waitForLaunch(parent.id);
  assert.equal(f.manager.list().find(s => s.id === parent.id).role, 'interactive');
  const call = f.calls[1], config = JSON.parse(call.args[call.args.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ['canvastty_agents']);
  assert.ok(call.options.env.CANVASTTY_ORCHESTRATION_CAPABILITY);
  assert.equal(Object.keys(call.options.env).some(k => /^CANVASTTY_AGENT_/.test(k)), false);
  assert.equal(f.browserRegistrations(), 0);
});

test('unsupported delegation routes and unavailable runtime fail before account preparation or spawn', async t => {
  const f = await fixture(t); let prepared = 0;
  f.manager.configureProviderLaunch({ handlesTerminals: true, async prepare() { prepared++; throw Error('must not prepare'); } });
  for (const extra of [{ provider: 'terminal' }, { provider: 'grok' }, { provider: 'minimax' }, { hostId: 'remote' }, { isolation: { mode: 'container', profileId: 'image' } }, { containerPlacement: {} }]) {
    if (extra.containerPlacement) await assert.rejects(f.manager.createWithPlacement(request(f, { allowSubagents: true, ...extra })), /delegat/i);
    else assert.throws(() => f.manager.create(request(f, { allowSubagents: true, ...extra })), /delegat/i);
  }
  assert.throws(() => f.manager.create(request(f, { provider: 'terminal', role: 'orchestrator' })), /delegat/i);
  assert.equal(prepared, 0); assert.equal(f.calls.length, 0); assert.equal(f.secretReads(), 0);
  f.gateway.setEnabled(false);
  assert.throws(() => f.manager.create(request(f, { allowSubagents: true })), /delegat/i);
});

test('orchestration-only configs for every measured native adapter contain no browser entry or browser grants', async t => {
  const f = await fixture(t);
  for (const provider of ['claude', 'codex', 'qwen', 'opencode', 'hermes', 'kimi']) {
    const launch = f.bridge.prepareLaunch({ provider, terminalSessionId: `only-${provider}`, cwd: f.root, includeOrchestration: true });
    assert.ok(launch, `${provider} needs MCP when browser access is disabled`);
    let config = JSON.stringify([launch.args, launch.environment]);
    if (provider === 'hermes') { const doc = yaml(await readFile(join(f.root, 'hermes/config.yaml'), 'utf8')); assert.deepEqual(Object.keys(doc.mcp_servers), ['canvastty_agents']); config += JSON.stringify(doc); }
    if (provider === 'kimi') config += await readFile(launch.args[1], 'utf8') + await readFile(join(f.root, 'kimi/config.toml'), 'utf8');
    assert.match(config, /canvastty_agents/); assert.doesNotMatch(config, /canvastty_browser|CANVASTTY_AGENT_/);
    launch.cleanup();
  }
  assert.equal(f.browserRegistrations(), 0);
});

test('missing helper, bridge or stopped gateway refuses explicit delegation, without silent fallback', async t => {
  for (const hooks of [{ missingHelper: true }, { missingBridge: true }, { stoppedGateway: true }]) {
    const f = await fixture(t, hooks);
    assert.throws(() => f.manager.create(request(f, { allowSubagents: true })), /delegat|helper|gateway/i);
    assert.equal(f.secretReads(), 0); assert.equal(f.calls.length, 0);
  }
});

import { OrchestrationClient, readOrchestrationIdentity } from '../src/agent-browser/orchestration-helper.mjs';
import { TerminalSessionStore, persistedTerminalSession } from '../src/main/services/TerminalSessionStore.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFile } from 'node:fs/promises';

function clientFor(t, env) {
  const client = new OrchestrationClient(readOrchestrationIdentity(env), { connectTimeoutMs: 1000 });
  t.after(() => client.close()); return client;
}
function fakeAcp(refuse = false, model = 'fixture-model') {
  const child = new EventEmitter(); child.frames = []; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      const frame = JSON.parse(line); child.frames.push(frame);
      if (!frame.id) continue;
      const result = frame.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: false, sse: false } } } : { sessionId: 'fixture-acp', configOptions: [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model, options: [{ value: model, name: 'Fixture' }] }] };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...(refuse && frame.method === 'session/new' ? { error: { code: -32602, message: 'MCP server refused by fixture agent' } } : { result }) })}\n`));
    }
  }); return child;
}

test('real authenticated socket delegates an ordinary child; exit and restart revoke old capabilities', async t => {
  const f = await fixture(t), parent = f.manager.create(request(f, { allowSubagents: true })); await f.manager.waitForLaunch(parent.id);
  const oldEnv = f.calls[0].options.env, client = clientFor(t, oldEnv); await client.connect();
  const result = await client.call('spawn_agent', { provider: 'codex', cwd: f.root }); await f.manager.waitForLaunch(result.sessionId);
  const child = f.manager.list().find(s => s.id === result.sessionId);
  assert.equal(child.parentSessionId, parent.id); assert.equal(child.role, 'subagent'); assert.equal(child.allowSubagents, false);
  assert.equal(f.calls[1].options.env.CANVASTTY_ORCHESTRATION_CAPABILITY, undefined);
  const reconnectToken = client.reconnectToken;
  client.socket.destroy();
  const reconnectDeadline = Date.now() + 2000;
  while (client.reconnectToken === reconnectToken && Date.now() < reconnectDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.notEqual(client.reconnectToken, reconnectToken);
  assert.equal(client.identity.connectionId, oldEnv.CANVASTTY_ORCHESTRATION_CONNECTION_ID);
  await client.call('list_agents', {});
  f.calls[0].exit({ exitCode: 0 });
  await assert.rejects(clientFor(t, oldEnv).connect());
  f.manager.restart(parent.id); await f.manager.waitForLaunch(parent.id);
  const nextEnv = f.calls.at(-1).options.env; assert.notEqual(nextEnv.CANVASTTY_ORCHESTRATION_CAPABILITY, oldEnv.CANVASTTY_ORCHESTRATION_CAPABILITY);
  await assert.rejects(clientFor(t, oldEnv).connect()); await clientFor(t, nextEnv).connect();
  f.manager.dispose(parent.id); await assert.rejects(clientFor(t, nextEnv).connect());
});

test('expired bootstrap and unsupported or unavailable restore never gain authority', async t => {
  let now = 100;
  const f = await fixture(t, { gatewayOptions: { now: () => now, capabilityTtlMs: 5 } });
  const session = f.manager.create(request(f, { allowSubagents: true })); await f.manager.waitForLaunch(session.id);
  const env = f.calls[0].options.env; now += 6; await assert.rejects(clientFor(t, env).connect());
  const saved = persistedTerminalSession(f.manager.list()[0]); f.manager.dispose(session.id);
  const other = await fixture(t, { missingHelper: true }), store = new TerminalSessionStore(join(other.root, 'saved'));
  await store.replace([saved]); other.manager.configureSessionPersistence(store, true); await other.manager.restorePersistedSessions();
  assert.match(other.manager.list()[0].failureDetails, /delegat|helper/i); assert.equal(other.calls.length, 0); assert.equal(other.secretReads(), 0);
  const unsupported = await fixture(t), store2 = new TerminalSessionStore(join(unsupported.root, 'saved'));
  await store2.replace([{ ...saved, provider: 'minimax' }]); unsupported.manager.configureSessionPersistence(store2, true); await unsupported.manager.restorePersistedSessions();
  assert.match(unsupported.manager.list()[0].failureDetails, /delegat/i); assert.equal(unsupported.calls.length, 0);
  assert.throws(() => f.manager.restart(session.id), /does not exist/);
});

test('custom PTY homes reject before home access; configured ACP injects only its scoped MCP server and honors refusal', async t => {
  const f = await fixture(t);
  for (const provider of ['kimi', 'hermes']) {
    f.settings.providerAccounts = [{ id: 'custom', label: 'Custom', provider, binding: { kind: 'cli-home', directory: join(f.root, 'deliberately-missing') } }];
    assert.throws(() => f.manager.create(request(f, { provider, accountId: 'custom', allowSubagents: true })), /custom account home/i);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.secretReads(), 0);
  f.settings.providerAccounts = [];
  const children = [];
  f.manager.configureAcp({ orchestrationCommand: { command: f.helper.command, args: f.helper.args, environment: f.helper.env }, spawn() { const child = fakeAcp(children.length === 1, children.length === 2 ? 'm:minimax:fixture-model:u' : 'fixture-model'); children.push(child); return child; } });
  for (const provider of ['kimi', 'cursor', 'minimax']) {
    const before = children.length;
    f.settings.providerAccounts = provider === 'kimi' ? [{ id: 'custom-kimi', label: 'Custom ACP', provider, binding: { kind: 'cli-home', directory: f.root } }] : [];
    const session = f.manager.create(request(f, { provider, transport: 'acp', allowSubagents: true })); await f.manager.waitForLaunch(session.id);
    const server = children[before].frames.find(frame => frame.method === 'session/new').params.mcpServers;
    assert.deepEqual(server.map(s => s.name), ['canvastty_agents']);
    const env = Object.fromEntries(server[0].env.map(e => [e.name, e.value]));
    assert.ok(env.CANVASTTY_ORCHESTRATION_CAPABILITY); assert.equal(Object.keys(env).some(k => /^CANVASTTY_AGENT_/.test(k)), false);
    if (provider === 'cursor') { assert.match(f.manager.list().find(s => s.id === session.id).failureDetails, /ACP request failed.*-32602/); await assert.rejects(clientFor(t, env).connect()); }
    else { assert.equal(f.manager.list().find(s => s.id === session.id).exitCode, null, f.manager.list().find(s => s.id === session.id).failureDetails); const client = clientFor(t, env); await client.connect(); }
  }
  assert.equal(f.calls.length, 0); assert.equal(f.browserRegistrations(), 0);
});

test('policy rejects unsupported native and remote API routes before secret or engine preparation', async t => {
  const f = await fixture(t);
  const api = { id: 'api', name: 'Fixture', protocol: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', secretRef: 'OPENAI_API_KEY', defaultModel: 'fixture-model' };
  const account = { id: 'api-account', label: 'Fixture', provider: 'minimax', binding: { kind: 'api-profile', profileId: 'api' } };
  f.settings.apiProfiles = [api]; f.settings.providerAccounts = [account];
  const metadata = { ...request(f, { provider: 'minimax', allowSubagents: true, accountId: account.id }), role: 'interactive' };
  await assert.rejects(f.accounts.prepare(metadata, false), /delegat/i);
  await assert.rejects(f.accounts.prepare({ ...metadata, provider: 'opencode', hostId: 'remote' }, false), /delegat/i);
  assert.equal(f.secretReads(), 0);
});

test('standalone shared configs preserve user browser entries through guarded cleanup and recovery', async t => {
  const f = await fixture(t);
  const options = { helper: f.helper, orchestrationHelper: f.helper, providerClis: f.registry, runtimeDirectory: join(f.root, 'fallback'), hermesHomeDirectory: join(f.root, 'standalone-hermes'), kimiHomeDirectory: join(f.root, 'standalone-kimi'), environment: {}, probeKimiPerRunConfig: () => false };
  const adapters = new ProviderLaunchAdapters(options);
  for (const provider of ['hermes', 'kimi']) {
    const launch = adapters.prepare(provider, `standalone-${provider}`, { browser: false, orchestration: true });
    assert.throws(() => adapters.prepare(provider, 'browser-on'), /browser permission changed/);
    const path = provider === 'hermes' ? join(options.hermesHomeDirectory, 'config.yaml') : join(options.kimiHomeDirectory, 'mcp.json');
    const doc = provider === 'hermes' ? yaml(await readFile(path, 'utf8')) : JSON.parse(await readFile(path, 'utf8'));
    const servers = provider === 'hermes' ? doc.mcp_servers : doc.mcpServers;
    assert.deepEqual(Object.keys(servers), ['canvastty_agents']); servers.canvastty_browser = { command: 'user-owned' };
    await writeFile(path, JSON.stringify(doc));
    if (provider === 'hermes') adapters.recoverHermesConfiguration(); else adapters.recoverKimiConfiguration();
    const after = provider === 'hermes' ? yaml(await readFile(path, 'utf8')).mcp_servers : JSON.parse(await readFile(path, 'utf8')).mcpServers;
    assert.deepEqual(after, { canvastty_browser: { command: 'user-owned' } });
    // Recovery owns this interrupted launch now; do not release a second time.
  }
});

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test('actual stdio helper process authenticates using the launch identity and creates an ordinary child', async t => {
  const f = await fixture(t), parent = f.manager.create(request(f, { allowSubagents: true })); await f.manager.waitForLaunch(parent.id);
  const env = Object.fromEntries(Object.entries(f.calls[0].options.env).filter(([key]) => key.startsWith('CANVASTTY_ORCHESTRATION_') || key === 'CANVASTTY_TERMINAL_SESSION_ID'));
  const helper = spawn(process.execPath, f.helper.args, { cwd: f.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0;
  const lines = createInterface({ input: helper.stdout });
  lines.on('line', line => { const frame = JSON.parse(line); pending.get(frame.id)?.resolve(frame); pending.delete(frame.id); });
  helper.once('exit', () => { for (const waiter of pending.values()) waiter.reject(Error('Helper exited before response')); pending.clear(); });
  helper.stderr.resume();
  t.after(async () => { lines.close(); const stopped = new Promise(resolve => helper.once('exit', resolve)); if (helper.exitCode === null) { helper.kill(); await stopped; } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const next = ++id; const timer = setTimeout(() => { pending.delete(next); reject(Error(`Helper ${method} timed out`)); }, 2000); pending.set(next, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); helper.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`); });
  const initialized = await rpc('initialize', {}); assert.equal(initialized.result.serverInfo.name, 'canvastty_agents');
  const tools = await rpc('tools/list', {}); assert.ok(tools.result.tools.some(tool => tool.name === 'spawn_agent')); assert.equal(tools.result.tools.some(tool => tool.name.startsWith('browser')), false);
  const created = await rpc('tools/call', { name: 'spawn_agent', arguments: { provider: 'codex', cwd: f.root } }); assert.equal(created.result.isError, false);
  const result = JSON.parse(created.result.content[0].text); await f.manager.waitForLaunch(result.sessionId);
  assert.equal(f.manager.list().find(s => s.id === result.sessionId).parentSessionId, parent.id);
});

import { terminalEnvironment } from '../src/main/services/TerminalManager.ts';
import { ORCHESTRATION_ENV } from '../src/main/services/agent-browser/orchestration-protocol.ts';
test('ordinary PTY environment cannot inherit any orchestration identity from the app process', () => {
  const inherited = Object.fromEntries(Object.values(ORCHESTRATION_ENV).map(key => [key, 'foreign-scope']));
  const environment = terminalEnvironment({ ...inherited, PATH: '/fixture' });
  for (const key of Object.values(ORCHESTRATION_ENV)) assert.equal(environment[key], undefined, key);
  assert.equal(environment.PATH, '/fixture');
});

test('gateway stopping rejects new delegation synchronously before preparation', async t => {
  const f = await fixture(t);
  const stopping = f.gateway.stop();
  assert.throws(() => f.manager.create(request(f, { allowSubagents: true })), /delegat/i);
  await stopping;
  assert.equal(f.calls.length, 0); assert.equal(f.secretReads(), 0);
});
