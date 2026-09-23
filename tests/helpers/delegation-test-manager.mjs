import { fileURLToPath } from 'node:url';
import { TerminalManager as RealTerminalManager } from '../../src/main/services/TerminalManager.ts';

export const fixtureOrchestrationCommand = { command: process.execPath, args: [fileURLToPath(new URL('../../src/agent-browser/orchestration-helper.mjs', import.meta.url))], environment: { ELECTRON_RUN_AS_NODE: '1' } };
/** Explicit fake MCP coordinators for tests of policy, persistence and capsule ownership.
 * Socket authentication and actual provider configuration are covered by delegation-launch.test.mjs.
 * This subclass never weakens TerminalManager authorization or invokes a real provider/helper. */
export class TerminalManager extends RealTerminalManager {
  constructor(emit, registry, browser, runtime, lifecycle, spawn) {
    super(emit, registry, browser ?? { assertOrchestrationAvailable() {}, prepareLaunch() { return { agentId: 'fixture', connectionId: 'fixture', args: [], environment: {}, cleanup() {} }; } }, runtime, lifecycle, spawn);
    this.configureOrchestration({ isEnabled: true, prepareLaunch({ terminalSessionId }) { return { environment: { CANVASTTY_TERMINAL_SESSION_ID: terminalSessionId, CANVASTTY_ORCHESTRATION_CAPABILITY: 'fixture-only' }, cleanup() {} }; } });
    this.configureAcp({});
  }
  configureAcp(options) { super.configureAcp({ orchestrationCommand: fixtureOrchestrationCommand, ...options }); }
}
