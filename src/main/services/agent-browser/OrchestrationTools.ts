import type { IsolationRequest } from "../../../shared/contracts.ts";
import type { OrchestrationCommandHandler, OrchestrationRequest } from "./orchestration-protocol.ts";
import { orchestrationBridgeError } from "./orchestration-protocol.ts";
import type { AgentControlService } from "../AgentControlService.ts";
import type { ScopedCapsuleControl } from '../ScopedCapsuleControl.ts';

/**
 * The only bridge between the orchestration MCP surface and session control.
 * Every tool call is scoped to the authenticated orchestrator's own subtree:
 * a foreign session id is a protocol error, never a filtered result, so an
 * orchestrator cannot probe sessions it does not own.
 */
export class ScopedOrchestrationHandler implements OrchestrationCommandHandler {
  private readonly control: AgentControlService;
  private capsules?: ScopedCapsuleControl;

  constructor(control: AgentControlService, capsules?: ScopedCapsuleControl) {
    this.control = control;
    this.capsules = capsules;
  }
  configureCapsules(capsules: ScopedCapsuleControl): void { this.capsules = capsules; }

  async execute(sessionId: string, request: OrchestrationRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      signal?.throwIfAborted();
      switch (request.tool) {
        case 'spawn_capsule_agent': case 'list_capsules': case 'review_capsule': case 'read_capsule_patch': case 'apply_capsule': case 'recover_capsule_apply':
        case 'preview_capsule_review_agent': case 'launch_capsule_review_agent': case 'list_capsule_test_profiles': case 'test_capsule': case 'validate_capsule_conventions': case 'list_capsule_tests': case 'get_capsule_test_result': case 'cancel_capsule_test':
          if (!this.capsules) throw new Error('Scoped capsule control is unavailable.');
          return await this.capsules.execute(sessionId, request.tool, request.arguments, signal);
        case "spawn_agent":
          return await this.spawn(sessionId, request.arguments, signal);
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

  // The spawn may await a placement decision (host "auto"), so the whole call
  // stays async even though the local fast path resolves synchronously.
  private async spawn(orchestratorId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const auto = args.containerRoute === 'auto';
    if (args.containerRoute !== undefined && !auto) throw new Error('Unsupported container route.');
    if (auto && (args.isolation !== 'container' || args.host !== undefined || args.containerProfileId !== undefined || args.worktreeRef !== undefined)) throw new Error('Container auto-placement requires container isolation without a fixed host, profile or worktree ref.');
    if (!auto && args.containerProfileIds !== undefined) throw new Error('containerProfileIds requires automatic container placement.');
    if (args.worktreeRef !== undefined && args.isolation !== "worktree") throw new Error("worktreeRef requires worktree isolation.");
    if (args.containerProfileId !== undefined && args.isolation !== "container") throw new Error("containerProfileId requires container isolation.");
    const isolation = auto || args.isolation === undefined ? undefined : args.isolation === "container" ? { mode: "container", profileId: args.containerProfileId } : { mode: args.isolation, ...(args.worktreeRef !== undefined ? { ref: args.worktreeRef } : {}) };
    const created = await this.control.spawn({
      ...(auto ? { containerPlacement: { ...(args.containerProfileIds !== undefined ? { profileIds: args.containerProfileIds as string[] } : {}) } } : {}),
      ...(isolation ? { isolation: isolation as IsolationRequest } : {}),
      parentSessionId: orchestratorId,
      provider: args.provider as never,
      ...(args.transport !== undefined ? { transport: args.transport as never } : {}),
      cwd: args.cwd as string,
      ...(args.model !== undefined ? { model: args.model as string } : {}),
      ...(args.accountId !== undefined ? { accountId: args.accountId as string } : {}),
      ...(args.dataClass !== undefined ? { dataClass: args.dataClass as never } : {}),
      ...(args.profile !== undefined ? { profile: args.profile as never } : {}),
      ...(args.allowSubagents !== undefined ? { allowSubagents: args.allowSubagents as boolean } : {}),
      ...(args.host !== undefined ? { host: args.host as string } : {}),
      ...(args.title !== undefined ? { title: args.title as string } : {}),
      ...(args.prompt !== undefined ? { initialPrompt: args.prompt as string } : {})
    }, signal);
    return {
      sessionId: created.id,
      provider: created.provider,
      status: created.status,
      title: created.title,
      hostId: created.hostId ?? 'local',
      ...(created.accountId !== undefined ? { accountId: created.accountId } : {}),
      ...(created.isolation ? { isolation: created.isolation } : {})
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
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
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
