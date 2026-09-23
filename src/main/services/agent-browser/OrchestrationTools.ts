import type { OrchestrationCommandHandler, OrchestrationRequest } from "./orchestration-protocol.ts";
import { orchestrationBridgeError } from "./orchestration-protocol.ts";
import type { AgentControlService } from "../AgentControlService.ts";

/**
 * The only bridge between the orchestration MCP surface and session control.
 * Every tool call is scoped to the authenticated orchestrator's own subtree:
 * a foreign session id is a protocol error, never a filtered result, so an
 * orchestrator cannot probe sessions it does not own.
 */
export class ScopedOrchestrationHandler implements OrchestrationCommandHandler {
  private readonly control: AgentControlService;

  constructor(control: AgentControlService) {
    this.control = control;
  }

  async execute(sessionId: string, request: OrchestrationRequest): Promise<Record<string, unknown>> {
    try {
      switch (request.tool) {
        case "spawn_agent":
          return this.spawn(sessionId, request.arguments);
        case "send_to_agent":
          return this.send(sessionId, request.arguments);
        case "observe_agent":
          return this.observe(sessionId, request.arguments);
        case "get_agent_result":
          return this.result(sessionId, request.arguments);
        case "cancel_agent":
          return this.cancel(sessionId, request.arguments);
        case "list_agents":
          return this.list(sessionId);
        default:
          throw orchestrationBridgeError("INVALID_REQUEST", "Unsupported orchestration tool.", false);
      }
    } catch (error) {
      if (error && typeof error === "object" && "bridgeError" in error) throw error;
      throw orchestrationBridgeError(
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : "Orchestration command failed.",
        true
      );
    }
  }

  private spawn(orchestratorId: string, args: Record<string, unknown>): Record<string, unknown> {
    const created = this.control.spawn({
      parentSessionId: orchestratorId,
      provider: args.provider as never,
      cwd: args.cwd as string,
      ...(args.title !== undefined ? { title: args.title as string } : {}),
      ...(args.prompt !== undefined ? { initialPrompt: args.prompt as string } : {})
    });
    return {
      sessionId: created.id,
      provider: created.provider,
      status: created.status,
      title: created.title
    };
  }

  private send(orchestratorId: string, args: Record<string, unknown>): Record<string, unknown> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    this.control.send(
      args.sessionId as string,
      args.prompt as string,
      args.submit === undefined ? true : Boolean(args.submit)
    );
    return { sessionId: args.sessionId as string, sent: true };
  }

  private observe(orchestratorId: string, args: Record<string, unknown>): Record<string, unknown> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    const observation = this.control.observe(
      args.sessionId as string,
      args.maxChars as number | undefined
    );
    return { sessionId: observation.sessionId, status: observation.status, output: observation.output };
  }

  private result(orchestratorId: string, args: Record<string, unknown>): Record<string, unknown> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    const result = this.control.result(args.sessionId as string);
    return {
      sessionId: result.sessionId,
      state: result.state,
      exitCode: result.exitCode,
      output: result.output
    };
  }

  private cancel(orchestratorId: string, args: Record<string, unknown>): Record<string, unknown> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    this.control.cancel(args.sessionId as string);
    return { sessionId: args.sessionId as string, canceled: true };
  }

  private list(orchestratorId: string): Record<string, unknown> {
    return {
      agents: this.control.children(orchestratorId).map((session) => ({
        sessionId: session.id,
        provider: session.provider,
        status: session.status,
        title: session.title
      }))
    };
  }

  private requireOwned(orchestratorId: string, sessionId: string): void {
    if (!this.control.isInSubtree(orchestratorId, sessionId)) {
      throw orchestrationBridgeError(
        "INVALID_REQUEST",
        "That session is not part of this orchestrator's subtree.",
        false
      );
    }
  }
}
