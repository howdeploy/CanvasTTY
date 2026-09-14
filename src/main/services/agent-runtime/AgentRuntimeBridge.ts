import type { ProviderId } from "../../../shared/contracts.ts";
import { AGENT_RUNTIME_ENV, CAPTURE_RESULT_ENV } from "../../../agent-runtime/runtime-protocol.mjs";
import type { RuntimeGateway, RuntimeLifecycleState } from "./RuntimeGateway.ts";
import {
  ProviderRuntimeLaunchAdapters,
  type ProviderRuntimeLaunchOptions
} from "./ProviderRuntimeLaunch.ts";

export interface PrepareAgentRuntimeLaunchInput {
  terminalSessionId: string;
  provider: Exclude<ProviderId, "terminal">;
  cwd: string;
  captureResult?: boolean;
}

export interface PreparedAgentRuntimePtyLaunch {
  args: string[];
  environment: Record<string, string>;
  cleanup(): void;
}

export interface AgentRuntimeLaunchCoordinator {
  prepareLaunch(input: PrepareAgentRuntimeLaunchInput): PreparedAgentRuntimePtyLaunch;
  currentStatus(terminalSessionId: string): RuntimeLifecycleState | null;
}

export interface AgentRuntimeBridgeOptions extends ProviderRuntimeLaunchOptions {
  recoverOnStart?: boolean;
  coreHooksEnabled?: boolean;
}

export class AgentRuntimeBridge implements AgentRuntimeLaunchCoordinator {
  private readonly gateway: RuntimeGateway;
  private readonly providers: ProviderRuntimeLaunchAdapters;
  private readonly activeSessions = new Set<string>();
  private coreHooksEnabled: boolean;

  constructor(gateway: RuntimeGateway, options: AgentRuntimeBridgeOptions) {
    this.gateway = gateway;
    this.providers = new ProviderRuntimeLaunchAdapters(options);
    this.coreHooksEnabled = options.coreHooksEnabled !== false;
    if (options.recoverOnStart) this.providers.recoverConfigurations();
  }

  prepareLaunch(input: PrepareAgentRuntimeLaunchInput): PreparedAgentRuntimePtyLaunch {
    const capability = this.coreHooksEnabled
      ? this.gateway.registerSession(input.terminalSessionId, input.provider, input.captureResult === true)
      : null;
    let prepared;
    try {
      prepared = this.providers.prepare(input.provider, input.terminalSessionId, this.coreHooksEnabled);
    } catch (error) {
      if (capability) this.gateway.revokeTerminalSession(input.terminalSessionId);
      throw error;
    }
    this.activeSessions.add(input.terminalSessionId);
    let cleaned = false;
    return {
      args: prepared.args,
      environment: {
        ...prepared.environment,
        ...(input.captureResult ? { [CAPTURE_RESULT_ENV]: "1" } : {}),
        ...(capability ? {
          [AGENT_RUNTIME_ENV.address]: capability.address,
          [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
          [AGENT_RUNTIME_ENV.provider]: capability.provider,
          [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
        } : {})
      },
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        this.activeSessions.delete(input.terminalSessionId);
        try {
          prepared.releaseConfiguration();
        } finally {
          this.gateway.revokeTerminalSession(input.terminalSessionId);
        }
      }
    };
  }

  currentStatus(terminalSessionId: string): RuntimeLifecycleState | null {
    return this.coreHooksEnabled ? this.gateway.currentStatus(terminalSessionId) : null;
  }

  setCoreHooksEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.coreHooksEnabled === next) return;
    this.coreHooksEnabled = next;
    if (next) return;
    for (const terminalSessionId of this.activeSessions) {
      this.gateway.revokeTerminalSession(terminalSessionId);
    }
  }
}
