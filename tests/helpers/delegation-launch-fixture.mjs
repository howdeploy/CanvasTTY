import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from '../../src/main/services/TerminalManager.ts';
import { AgentControlService } from '../../src/main/services/AgentControlService.ts';
import { SessionLaunchPolicy } from '../../src/main/services/SessionLaunchPolicy.ts';
import { ProviderAccountLaunchService } from '../../src/main/services/ProviderAccountLaunchService.ts';
import { AgentBrowserBridge } from '../../src/main/services/agent-browser/AgentBrowserBridge.ts';
import { OrchestrationGateway } from '../../src/main/services/agent-browser/OrchestrationGateway.ts';
import { OrchestrationBridge } from '../../src/main/services/agent-browser/OrchestrationBridge.ts';
import { ScopedOrchestrationHandler } from '../../src/main/services/agent-browser/OrchestrationTools.ts';

export async function delegationLaunchFixture(hooks = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ctty-delegation-')));
  const calls = [], events = [];
  let secretReads = 0, browserRegistrations = 0;
  const registry = { get: provider => ({ state: 'available', provider, executable: `/fixture/${provider}`, launcher: 'native', environment: { PATH: '/usr/bin' }, checked: [] }), snapshot: () => ({}) };
  const settings = { lastDirectory: root, defaultDataClass: 'D0', pathPolicies: [], providerAccounts: [], apiProfiles: [], remoteHosts: [], containerProfiles: [], requiresSandboxProfiles: [], maxAccountsPerProviderPerHost: 1, agentBudgets: { maxLocalAgents: 12, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 }, contextProfilesEnabled: false, ...hooks.settings };
  // Disabled browser gateway never creates a browser capability. All homes and CLI resolutions are synthetic.
  const browserGateway = { isEnabled: false, registerAgent() { browserRegistrations++; throw Error('Browser permission is disabled'); }, revokeTerminalSession() {} };
  const helper = { command: process.execPath, args: [join(process.cwd(), 'src/agent-browser/orchestration-helper.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const bridge = new AgentBrowserBridge(browserGateway, { helper: { ...helper, args: [join(root, 'unused-browser.mjs')] }, ...(hooks.missingHelper ? {} : { orchestrationHelper: helper }), providerClis: registry, environment: {}, runtimeDirectory: join(root, 'config'), hermesHomeDirectory: join(root, 'hermes'), kimiHomeDirectory: join(root, 'kimi'), probeKimiPerRunConfig: () => true });
  const manager = new TerminalManager((channel, payload) => { events.push({ channel, payload }); hooks.emit?.(channel, payload); }, registry, hooks.missingBridge ? undefined : bridge, undefined, true, (command, args, options) => {
    const call = { command, args, options, writes: [], exit: undefined };
    calls.push(call);
    return { pid: 30000 + calls.length, write: text => call.writes.push(text), resize() {}, kill() {}, pause() {}, resume() {}, onData() { return { dispose() {} }; }, onExit(fn) { call.exit = fn; return { dispose() {} }; } };
  });
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings, { repositoryRoot: () => root }));
  const accounts = new ProviderAccountLaunchService(() => settings, { generation: 0, get: async () => { secretReads++; return 'synthetic-only'; } }, { temporaryRoot: root });
  manager.configureProviderLaunch(accounts);
  const control = new AgentControlService(manager);
  const scope = new ScopedOrchestrationHandler(control);
  const gateway = new OrchestrationGateway({ runtimeDirectory: join(root, 'runtime'), handler: scope, ...hooks.gatewayOptions });
  if (!hooks.stoppedGateway) await gateway.start();
  manager.configureOrchestration(new OrchestrationBridge(gateway));
  return { root, manager, control, scope, gateway, bridge, settings, registry, accounts, helper, calls, events, secretReads: () => secretReads, browserRegistrations: () => browserRegistrations,
    async cleanup() { await manager.shutdown(); await gateway.stop(); await rm(root, { recursive: true, force: true }); } };
}
