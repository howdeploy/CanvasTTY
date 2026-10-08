import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LaunchPipeline } from '../src/main/services/LaunchPipeline.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { availableRegistry, fakeSpawner } from './helpers/terminal.mjs';

test('actual Accounts producer and core pipeline bind fake local launch model and endpoint', { skip: !process.env.CANVASTTY_ACCOUNTS_REPO }, async t => {
  const imported = file => import(pathToFileURL(join(process.env.CANVASTTY_ACCOUNTS_REPO, file)).href);
  const [{ AccountsService }, { startFakeOllama }] = await Promise.all([imported('src/service/accounts.ts'), imported('tests/helpers/fake-ollama.mjs')]);
  const fake = await startFakeOllama();
  const root = await mkdtemp(join(tmpdir(), 'accounts-proof-integration-'));
  t.after(async () => { await fake.close(); await rm(root, { recursive: true, force: true }); });
  const dataDir = join(root, 'accounts');
  const account = { id: 'fixture', label: 'Fixture', preset: 'ollama-local', baseUrl: fake.url, model: 'qwen3.5:9b', agents: ['claude'] };
  const service = new AccountsService({ dataDir, host: { callHost: async method => {
    assert.notEqual(method, 'secrets.get', 'keyless fake model needs no key'); return null;
  }, log() {}, emit() {} } });
  await service.save({ version: 1, accounts: [account] });
  const target = { id: 'account', label: 'Fixture', provider: 'claude', accountId: account.id, maxDataClass: 'D2', inferenceModel: account.model, endpoint: new URL(fake.url).host, accountKind: 'ollama' };
  const calls = [], contexts = [];
  const terminals = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, false, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  terminals.configureExecutionPolicy(() => ({ enabled: true, defaultDataClass: 'D2', targets: [target] }), async () => ({ model: target.inferenceModel, endpoint: target.endpoint, kind: target.accountKind, state: 'ready' }));
  terminals.configureLaunchPipeline(new LaunchPipeline({ contributors: () => [{ pluginId: 'canvastty-accounts', pluginName: 'Accounts', serviceId: 'accounts', dataDir, secrets: false,
    launch: { fields: [{ key: 'account', label: 'Account', kind: 'text' }], delegable: true } }],
    call: async (_plugin, _service, _method, params) => { contexts.push(params); return service.prepare(params); },
    secret: async () => { throw Error('no key reads'); }, runsRoot: join(root, 'runs') }));
  const session = terminals.create({ provider: 'claude', profile: 'normal', cwd: root, position: { x: 0, y: 0 }, launchOptions: { 'canvastty-accounts': { account: 'fixture' } } });
  const deadline = Date.now() + 2000;
  while (!calls.length && !terminals.getMetadata(session.id).failureDetails && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 1, terminals.getMetadata(session.id).failureDetails);
  assert.equal(contexts[0].accountRouteEvidence, true);
  assert.equal(calls[0].options.env.ANTHROPIC_BASE_URL, fake.url);
  assert.equal(calls[0].options.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'qwen3.5:9b:local');
});
