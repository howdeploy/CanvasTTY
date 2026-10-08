import type { AgentGateway } from "./AgentGateway.ts";
import { ProviderLaunchAdapters } from "./ProviderLaunch.ts";
import type { PreparedProviderLaunch, ProviderLaunchOptions } from "./ProviderLaunch.ts";
import { randomUUID } from "node:crypto";
import { AGENT_BROWSER_ENV, type AgentProvider } from "./protocol.ts";

export { AGENT_BROWSER_ENV } from "./protocol.ts";

export interface PrepareAgentBrowserLaunchInput {
  terminalSessionId: string;
  provider: AgentProvider;
  cwd: string;
  /** Strict OS network modes must never receive the host-side browser capability. */
  networkMode?: "open" | "allowed-domains" | "offline";
  /** Include the canvastty_agents MCP server: orchestrators, and sessions a plugin tool applies to. */
  includeOrchestration?: boolean;
  /** The canvastty_agents tools this session may use (default: the core tools). */
  orchestrationTools?: readonly string[];
}

export interface PreparedAgentBrowserPtyLaunch {
  agentId: string;
  connectionId: string;
  args: string[];
  environment: Record<string, string>;
  retainUntilExit?(): void;
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

  /** Background provider probes a first launch would otherwise run on the main thread (Kimi's `--help`). */
  warmProviderProbes(): Promise<void> {
    return this.providers.warmKimiProbe();
  }

  prepareLaunch(input: PrepareAgentBrowserLaunchInput): PreparedAgentBrowserPtyLaunch | null {
    // The browser gateway can make external requests from the host, outside an agent's OS network policy. Strict
    // launches may retain orchestration only; never issue a browser token or write browser credentials into config.
    if (input.networkMode && input.networkMode !== "open") {
      return input.includeOrchestration ? this.prepareOrchestrationOnly(input) : null;
    }
    // Browser access off: no canvastty_browser and no browser capability, but a session that gets canvastty_agents
    // (orchestrators, plugin tools) still gets it; that server has its own capability and gateway.
    if (!this.gateway.isEnabled) return input.includeOrchestration ? this.prepareOrchestrationOnly(input) : null;
    const capability = this.gateway.registerAgent(input);
    let providerLaunch;
    try {
      providerLaunch = this.providers.prepare(input.provider, capability.connectionId, {
        ...(input.includeOrchestration ? { orchestration: true } : {}),
        ...(input.orchestrationTools ? { orchestrationTools: input.orchestrationTools } : {})
      });
    } catch (error) {
      this.gateway.revokeTerminalSession(input.terminalSessionId);
      throw error;
    }

    return this.launchWith(providerLaunch, capability.agentId, capability.connectionId, () => this.gateway.revokeTerminalSession(input.terminalSessionId), {
      [AGENT_BROWSER_ENV.address]: capability.address,
      [AGENT_BROWSER_ENV.agentId]: capability.agentId,
      [AGENT_BROWSER_ENV.connectionId]: capability.connectionId,
      [AGENT_BROWSER_ENV.terminalSessionId]: capability.terminalSessionId,
      [AGENT_BROWSER_ENV.provider]: capability.provider,
      [AGENT_BROWSER_ENV.capabilityToken]: capability.capabilityToken
    }, () => this.gateway.holdPendingForTerminal(capability.connectionId));
  }

  private prepareOrchestrationOnly(input: PrepareAgentBrowserLaunchInput): PreparedAgentBrowserPtyLaunch {
    const connectionId = randomUUID();
    const providerLaunch = this.providers.prepare(input.provider, connectionId, {
      orchestration: true,
      browser: false,
      ...(input.orchestrationTools ? { orchestrationTools: input.orchestrationTools } : {})
    });
    return this.launchWith(providerLaunch, "", connectionId, () => undefined, {});
  }

  private launchWith(
    providerLaunch: PreparedProviderLaunch,
    agentId: string,
    connectionId: string,
    revoke: () => void,
    browserEnvironment: Record<string, string>,
    /** Keeps the browser capability's pending work until the process exits (browser access on only). */
    retain?: () => void
  ): PreparedAgentBrowserPtyLaunch {
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
      agentId,
      connectionId,
      args: providerLaunch.args,
      environment: { ...providerLaunch.environment, ...browserEnvironment },
      ...(retain ? {
        retainUntilExit: () => {
          if (!cleaned) retain();
        }
      } : {}),
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try {
          releaseConfigurationSafely();
        } finally {
          revoke();
        }
      }
    };
  }
}
