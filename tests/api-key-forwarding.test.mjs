import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderAccountLaunchService } from '../src/main/services/ProviderAccountLaunchService.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { remoteAgentLaunch } from '../src/main/services/remoteAgentLaunch.ts';
import { consumeRemoteSecretsPrefix, deliverRemoteSecrets, newRemoteSecretFile } from '../src/main/services/remoteSecretHandoff.ts';
import { accountForwardsKey, accountRunsOnHost } from '../src/shared/providerAccountPolicy.ts';
import { selectLaunchAccount } from '../src/shared/launchAccountPolicy.ts';
import { assembleDecisionRoutes } from '../src/main/services/decision/routeAssembly.ts';

const profile = { id: 'backend', name: 'Backend', protocol: 'openai-compatible', baseUrl: 'https://api.example/v1', secretRef: 'OPENAI_API_KEY', defaultModel: 'chosen-model' };
const apiAccount = { id: 'api', label: 'API', provider: 'opencode', binding: { kind: 'api-profile', profileId: 'backend' } };
const host = { id: 'srv', label: 'Server', sshHost: 'srv.example', workspaces: [{ localPath: '/tmp', remotePath: '/srv/project' }] };
const cliAccount = { id: 'sub', label: 'Subscription', provider: 'codex', hostId: 'srv', binding: { kind: 'cli-home', directory: '/srv/homes/codex' } };

test('only an OpenCode account whose key is in this app is forwarded to other computers', () => {
  assert.equal(accountForwardsKey(apiAccount, 'opencode', [profile]), true);
  assert.equal(accountForwardsKey(apiAccount, 'omp', [profile]), false);
  assert.equal(accountForwardsKey({ ...apiAccount, hostId: 'srv' }, 'opencode', [profile]), false);
  assert.equal(accountForwardsKey(apiAccount, 'opencode', [{ ...profile, hostId: 'srv', secretRef: undefined, remoteCredential: { kind: 'environment', name: 'KEY' } }]), false);
  assert.equal(accountRunsOnHost(apiAccount, 'opencode', 'srv', [profile]), true);
  assert.equal(accountRunsOnHost(cliAccount, 'codex', 'other', []), false);
  assert.equal(selectLaunchAccount([apiAccount], 'opencode', undefined, 'api', undefined, { hostId: 'srv', limit: 1 }, [profile]).id, 'api');
  assert.throws(() => selectLaunchAccount([cliAccount], 'codex', undefined, 'sub', undefined, { hostId: 'local', limit: 1 }, []), /bound to host srv/);
});

test('a forwarded launch keeps the key out of the environment and argv and delivers it before spawn', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'canvastty-forward-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = { providerAccounts: [apiAccount], apiProfiles: [profile], remoteHosts: [host] };
  const deliveries = [];
  const service = new ProviderAccountLaunchService(() => settings, { get: async () => 'secret-value', generation: 0 }, {
    temporaryRoot: directory,
    discovery: { discover: async () => ({ hostId: 'srv', collectedAt: 0, reachable: true, providers: [{ provider: 'opencode', installed: true, path: '/usr/local/bin/opencode' }] }) },
    deliverSecrets: async (target, file, secrets) => { deliveries.push({ target: target.id, file, secrets }); }
  });
  const metadata = { id: 's', provider: 'opencode', profile: 'normal', cwd: '/tmp', accountId: 'api', hostId: 'srv', model: 'chosen-model', transport: 'pty' };
  const prepared = await service.prepare(metadata, false);
  assert.equal(prepared.environment.CANVASTTY_PROFILE_API_KEY, undefined);
  assert.match(prepared.environment.OPENCODE_CONFIG_CONTENT, /\{env:CANVASTTY_PROFILE_API_KEY\}/);
  assert.deepEqual(prepared.remoteSecretFile.names, ['CANVASTTY_PROFILE_API_KEY']);
  assert.equal(deliveries.length, 0);
  await prepared.beforeSpawn();
  assert.deepEqual(deliveries.map(d => [d.target, d.secrets.CANVASTTY_PROFILE_API_KEY]), [['srv', 'secret-value']]);
  const launch = remoteAgentLaunch(host, '/srv/project', prepared.remoteExecutable, { args: [], environment: prepared.environment, unsetEnvironment: prepared.unsetEnvironment, absoluteExecutable: true, secretFile: prepared.remoteSecretFile });
  const command = launch.args.at(-1);
  assert.equal(command.includes('secret-value'), false);
  assert.ok(command.startsWith(consumeRemoteSecretsPrefix(prepared.remoteSecretFile)));
  assert.equal(command.includes("'-u' 'CANVASTTY_PROFILE_API_KEY'"), false, 'the forwarded variable survives the account environment reset');
  await assert.rejects(service.prepare({ ...metadata, provider: 'omp' }, false), /incompatible|forward|OpenCode/i);
});

test('delivery writes NAME:base64 lines over stdin and reports a missing /dev/shm clearly', async () => {
  const file = newRemoteSecretFile(['KEY']);
  let seen;
  await deliverRemoteSecrets(host, file, { KEY: 'a=b:c' }, async (_host, script, input) => { seen = { script, input }; return { code: 0, stdout: 'CTTY_OK\n', stderr: '' }; });
  assert.equal(seen.input, `KEY:${Buffer.from('a=b:c').toString('base64')}\n`);
  assert.equal(seen.script.includes('a=b:c'), false);
  assert.match(seen.script, /umask 077/);
  await assert.rejects(deliverRemoteSecrets(host, file, { KEY: 'x' }, async () => ({ code: 4, stdout: 'CTTY_NO_SHM\n', stderr: '' })), /\/dev\/shm/);
  assert.throws(() => newRemoteSecretFile(['bad-name']), /Invalid/);
});

test('a forwarded account may run on several computers at once; a subscription account may not', () => {
  const settings = { providerAccounts: [apiAccount, cliAccount], apiProfiles: [profile], remoteHosts: [host, { ...host, id: 'srv2' }], pathPolicies: [], defaultDataClass: 'D0', maxAccountsPerProviderPerHost: 1,
    agentBudgets: { maxLocalAgents: 4, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 } };
  const policy = new SessionLaunchPolicy(() => settings);
  const running = [{ id: 'a', provider: 'opencode', accountId: 'api', hostId: 'srv', exitCode: null }];
  assert.equal(policy.check({ provider: 'opencode', accountId: 'api', hostId: 'srv2', cwd: '/tmp', profile: 'normal' }, running).hostId, 'srv2');
  const sub = [{ id: 'b', provider: 'codex', accountId: 'sub', hostId: 'srv2', exitCode: null }];
  assert.throws(() => policy.check({ provider: 'codex', accountId: 'sub', hostId: 'srv', cwd: '/tmp', profile: 'normal' }, sub), /still running on another host/);
});

test('route assembly offers a forwarded account on every server where its CLI is installed', () => {
  const settings = { providerAccounts: [apiAccount], apiProfiles: [profile], remoteHosts: [host, { ...host, id: 'srv2' }] };
  const routes = assembleDecisionRoutes(settings, { localCli: () => true, remoteAvailable: hostId => hostId === 'srv2' }, []);
  assert.deepEqual(routes.filter(r => r.provider === 'opencode').map(r => [r.accountId, r.hostId]), [['api', 'local'], ['api', 'srv2']]);
});
