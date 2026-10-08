import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { PluginAgentTools } from '../src/main/services/PluginAgentTools.ts';
import { createDiffOnlyReviewWorkspace } from '../src/main/services/DiffOnlyReviewWorkspace.ts';
import { availableRegistry, fakeSpawner } from './helpers/terminal.mjs';

for (const mode of ['success', 'no-root', 'root-ended', 'mismatch', 'revoked']) {
  test(`reviewer route preflight uses a live task-root plugin caller (${mode})`, async t => {
    const terminals = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, false, fakeSpawner([]));
    t.after(() => terminals.disposeAll());
    const root = terminals.create({ provider: 'codex', profile: 'normal', cwd: tmpdir(), position: { x: 0, y: 0 }, role: 'orchestrator' });
    const workspace = createDiffOnlyReviewWorkspace('+ fixture');
    t.after(() => workspace.cleanup());
    const target = { id: 'fixture', label: 'Fixture', provider: 'claude', accountId: 'fixture', inferenceModel: 'approved', endpoint: 'api.fixture.invalid', accountKind: 'api-key', maxDataClass: 'D3' };
    let policy = { enabled: true, defaultDataClass: 'D2', targets: [target] };
    let queried = 0, preparedId;
    const pluginTools = new PluginAgentTools({
      providers: () => [{ pluginId: 'canvastty-accounts', pluginName: 'Accounts', serviceId: 'accounts', tools: [{ name: 'list_routes', description: 'Public routes', roles: ['orchestrator'], inputSchema: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'], additionalProperties: false } }] }],
      caller: id => terminals.getMetadata(id), redact: text => text,
      call: async (_plugin, _service, _method, params) => {
        queried++;
        assert.equal(params.callerSessionId, root.id);
        assert.equal(params.input.provider, 'claude', 'requested reviewer provider survives a Codex root caller');
        if (mode === 'root-ended') terminals.dispose(root.id);
        if (mode === 'revoked') policy = { ...policy, targets: [] };
        return { routes: [{ provider: 'claude', accountId: target.accountId, model: mode === 'mismatch' ? 'changed' : target.inferenceModel, endpoint: target.endpoint, kind: target.accountKind, state: 'ready' }] };
      }
    });
    // The production main/index adapter requires a live PluginAgentTools caller before parsing public routes.
    terminals.configureExecutionPolicy(() => policy, async (id, provider, accountId) => {
      const answer = await pluginTools.call(id, 'orchestrator', 'canvastty-accounts__list_routes', { provider });
      if (answer.isError) return null;
      const parsed = JSON.parse(answer.content);
      const row = parsed?.routes?.find(r => r?.provider === provider && r.accountId === accountId);
      return row && [row.model, row.endpoint, row.kind, row.state].every(v => typeof v === 'string')
        ? { model: row.model, endpoint: row.endpoint, kind: row.kind, state: row.state } : null;
    });
    terminals.configureLaunchPipeline({ normalizeOptions: (_provider, options) => options, unavailable: () => [], forgetSession: async () => {}, prepare: async params => {
      preparedId = params.sessionId;
      return { ok: true, env: {}, envSources: {}, args: [], secrets: [], thirdPartyModel: false, accountId: target.accountId,
        accountRoute: { model: target.inferenceModel, endpoint: target.endpoint, kind: target.accountKind }, apiDomains: [target.endpoint], cleanup: async () => {} };
    } });
    if (mode === 'no-root') terminals.dispose(root.id);
    const prepare = () => terminals.prepareReviewerAccount({ taskRootSessionId: root.id, provider: 'claude', workspace, launchOptions: { 'canvastty-accounts': { account: target.accountId } } });
    if (mode === 'success') {
      const account = await prepare();
      assert.equal(account.id, preparedId);
      assert.notEqual(account.id, root.id, 'temporary preparation/cleanup identity stays separate');
      await account.contribution.cleanup();
    } else {
      await assert.rejects(prepare(), /review task|execution target|account route/i);
      assert.equal(preparedId, undefined, 'refusal precedes launch preparation');
    }
    assert.equal(queried, mode === 'no-root' ? 0 : 1);
  });
}
