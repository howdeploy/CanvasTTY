import type { AgentProviderId, LaunchProfileId } from "../../shared/contracts.ts";
import type { ReasoningEffort } from "../../shared/launchModel.ts";

export interface ModelRouteCandidate {
  /** Stable id minted from the host's provider directory, never accepted from the router as a model name. */
  id: string;
  provider: AgentProviderId;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  available?: boolean;
  default?: boolean;
  /** True only for a model observed on a live CanvasTTY session when the CLI list is unavailable/stale. */
  observed?: boolean;
}

export interface ModelRouteRequest {
  executionStrategy?: import("../../shared/executionStrategy.ts").ExecutionStrategy;
  sessionId: string;
  task: string;
  provider: AgentProviderId;
  profile: LaunchProfileId;
  cwd: string;
  requested: { model?: string; reasoningEffort?: ReasoningEffort };
  candidates: ModelRouteCandidate[];
  humanChoice: { provider?: AgentProviderId; model?: string; reasoningEffort?: ReasoningEffort } | null;
  budget?: {
    limits: { tokens: number | null; costUsd: number | null; durationMs: number | null };
    usage: { tokens: number | null; costUsd: number | null; durationMs: number | null };
    remaining: { tokens: number | null; costUsd: number | null; durationMs: number | null };
    paused: boolean;
  };
}

export interface ModelRouteResponse {
  candidateId: string;
  reason: string;
  escalated?: boolean;
}

/** Installed plugin adapter. The host enforces the deadline and revalidates the chosen id and provider. */
export interface ExecutionStrategyRequest {
  sessionId: string; task: string; cwd: string; budget?: ModelRouteRequest["budget"];
}
export interface ExecutionStrategyResponse {
  source?: "jev" | "fallback";
  goal: import("../../shared/executionStrategy.ts").ResolvedExecutionGoal;
  reason: string;
  category?: import("../../shared/executionStrategy.ts").ExecutionStrategy["category"];
  difficulty?: import("../../shared/executionStrategy.ts").ExecutionStrategy["difficulty"];
  confident?: boolean;
}
export interface ModelRouter {
  strategy?(request: ExecutionStrategyRequest): Promise<ExecutionStrategyResponse>;
  route(request: ModelRouteRequest): Promise<ModelRouteResponse>;
}

export interface ModelRoutingInfo {
  source: "explicit" | "router" | "default";
  candidateId?: string;
  reason: string;
  escalated?: boolean;
}

/** Check the current opt-in before calling a router and before accepting its asynchronous answer. */
export function experimentalModelRouter(router: ModelRouter, enabled: () => boolean = () => false): ModelRouter {
  const requireEnabled = (): void => {
    if (enabled() !== true) throw new Error("Experimental model routing is disabled; not verified live.");
  };
  return { ...(router.strategy ? { strategy: async (request: ExecutionStrategyRequest) => {
    requireEnabled();
    const answer = await router.strategy!(request);
    requireEnabled();
    return answer;
  } } : {}), route: async (request) => {
    requireEnabled();
    const answer = await router.route(request);
    requireEnabled();
    return answer;
  } };
}
