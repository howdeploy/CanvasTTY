import type { OrchestrationGateway } from "./OrchestrationGateway.ts";
import { ORCHESTRATION_ENV } from "./orchestration-protocol.ts";

export interface PrepareOrchestrationLaunchInput {
  terminalSessionId: string;
}

export interface PreparedOrchestrationPtyLaunch {
  environment: Record<string, string>;
  cleanup(): void;
}

export interface OrchestrationLaunchCoordinator {
  readonly isEnabled: boolean;
  prepareLaunch(input: PrepareOrchestrationLaunchInput): PreparedOrchestrationPtyLaunch | null;
}

/** Issues the per-PTY orchestration capability and exposes it as child
 * environment values; revoking happens when the owning session ends. */
export class OrchestrationBridge implements OrchestrationLaunchCoordinator {
  private readonly gateway: OrchestrationGateway;

  constructor(gateway: OrchestrationGateway) {
    this.gateway = gateway;
  }

  get isEnabled(): boolean {
    return this.gateway.isEnabled;
  }

  prepareLaunch(input: PrepareOrchestrationLaunchInput): PreparedOrchestrationPtyLaunch | null {
    if (!this.gateway.isEnabled) return null;
    const capability = this.gateway.registerOrchestrator({ terminalSessionId: input.terminalSessionId });
    let cleaned = false;
    return {
      environment: {
        [ORCHESTRATION_ENV.address]: capability.address,
        [ORCHESTRATION_ENV.capabilityToken]: capability.capabilityToken,
        [ORCHESTRATION_ENV.terminalSessionId]: capability.terminalSessionId
      },
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        this.gateway.revokeTerminalSession(input.terminalSessionId);
      }
    };
  }
}
