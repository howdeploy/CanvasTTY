import type { AgentGateway } from "./AgentGateway.ts";
import { ProviderLaunchAdapters } from "./ProviderLaunch.ts";
import type { ProviderLaunchOptions } from "./ProviderLaunch.ts";
import { AGENT_BROWSER_ENV, type AgentProvider } from "./protocol.ts";

export { AGENT_BROWSER_ENV } from "./protocol.ts";

export interface PrepareAgentBrowserLaunchInput {
  terminalSessionId: string;
  provider: AgentProvider;
  cwd: string;
  /** Include the canvastty_agents MCP server; only orchestrator sessions set this. */
  includeOrchestration?: boolean;
}

export interface PreparedAgentBrowserPtyLaunch {
  agentId: string;
  connectionId: string;
  args: string[];
  environment: Record<string, string>;
  cleanup(): void;
}

export interface AgentBrowserLaunchCoordinator {
  prepareLaunch(input: PrepareAgentBrowserLaunchInput): PreparedAgentBrowserPtyLaunch | null;
}

export interface AgentBrowserBridgeOptions extends ProviderLaunchOptions {
  recoverHermesOnStart?: boolean;
  recoverKimiOnStart?: boolean;
}

export class AgentBrowserBridge implements AgentBrowserLaunchCoordinator {
  private readonly gateway: AgentGateway;
  private readonly providers: ProviderLaunchAdapters;

  constructor(gateway: AgentGateway, options: AgentBrowserBridgeOptions) {
    this.gateway = gateway;
    this.providers = new ProviderLaunchAdapters(options);
    if (options.recoverHermesOnStart) this.providers.recoverHermesConfiguration();
    if (options.recoverKimiOnStart) this.providers.recoverKimiConfiguration();
  }

  get isEnabled(): boolean {
    return this.gateway.isEnabled;
  }

  setEnabled(enabled: boolean): void {
    this.gateway.setEnabled(enabled);
  }

  providerClisRefreshed(): void {
    this.providers.providerClisRefreshed();
  }

  prepareLaunch(input: PrepareAgentBrowserLaunchInput): PreparedAgentBrowserPtyLaunch | null {
    if (!this.gateway.isEnabled) return null;
    const capability = this.gateway.registerAgent(input);
    let providerLaunch;
    try {
      providerLaunch = this.providers.prepare(input.provider, capability.connectionId, {
        ...(input.includeOrchestration ? { orchestration: true } : {})
      });
    } catch (error) {
      this.gateway.revokeTerminalSession(input.terminalSessionId);
      throw error;
    }

    let configurationReleased = false;
    const releaseConfiguration = () => {
      if (configurationReleased) return;
      providerLaunch.releaseConfiguration();
      configurationReleased = true;
    };
    const releaseConfigurationSafely = () => {
      try {
        releaseConfiguration();
      } catch {
        console.warn("CanvasTTY deferred cleanup of temporary provider browser configuration to recovery.");
      }
    };
    let cleaned = false;
    return {
      agentId: capability.agentId,
      connectionId: capability.connectionId,
      args: providerLaunch.args,
      environment: {
        ...providerLaunch.environment,
        [AGENT_BROWSER_ENV.address]: capability.address,
        [AGENT_BROWSER_ENV.agentId]: capability.agentId,
        [AGENT_BROWSER_ENV.connectionId]: capability.connectionId,
        [AGENT_BROWSER_ENV.terminalSessionId]: capability.terminalSessionId,
        [AGENT_BROWSER_ENV.provider]: capability.provider,
        [AGENT_BROWSER_ENV.capabilityToken]: capability.capabilityToken
      },
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try {
          releaseConfigurationSafely();
        } finally {
          this.gateway.revokeTerminalSession(input.terminalSessionId);
        }
      }
    };
  }
}
