import type { OrchestrationCommandHandler, OrchestrationRequest } from "./orchestration-protocol.ts";
import { selectedAccountId } from "../accountHomeIsolation.ts";
import { orchestrationBridgeError } from "./orchestration-protocol.ts";
import type { AgentProviderId, ProviderId, SessionRole } from "../../../shared/contracts.ts";
import { launchEffortProblem, launchModelProblem } from "../../../shared/launchModel.ts";
import { PromptNotDeliveredError, type AgentControlService, type AgentResult, type AgentReviewResult, type SpawnAgentRequest } from "../AgentControlService.ts";
import { LaunchRefusal } from "../launchRefusal.ts";
import type { PluginAgentTools } from "../PluginAgentTools.ts";
import {
  DEFAULT_AGENT_WAIT_SECONDS,
  MAX_AGENT_WAIT_SECONDS,
  ORCHESTRATION_TOOL_DEFINITIONS,
  isPluginOrchestrationTool,
  unknownProviderMessage
} from "../../../agent-browser/orchestration-catalog.mjs";
import { AGENT_PROVIDERS } from "../../../shared/contracts.ts";
import { listProviderDirectory, type ProviderDirectorySources } from "../providerDirectory.ts";
import type { McpToolDefinition } from "../../../agent-browser/orchestration-catalog.mjs";
import type { OrchestrationBudgetService } from "../OrchestrationBudgetService.ts";
import type { OrchestrationTaskBoard, OrchestrationTaskPatch } from "../OrchestrationTaskBoard.ts";
import type { OrchestrationTemplateService } from "../OrchestrationTemplateService.ts";

const TASK_TOOL_NAMES = new Set(["list_tasks", "claim_task", "update_task", "complete_task"]);
const ORCHESTRATOR_ONLY_ADDITIONAL_TOOLS = new Set(["retry_agent"]);

export interface ScopedOrchestrationIntegrations {
  taskBoard?: OrchestrationTaskBoard;
  budget?: Pick<OrchestrationBudgetService, "snapshot">;
  templates?: OrchestrationTemplateService;
}

/**
 * The only bridge between the orchestration MCP surface and session control.
 * Every tool call is scoped to the authenticated orchestrator's own subtree:
 * a foreign session id is a protocol error, never a filtered result, so an
 * orchestrator cannot probe sessions it does not own.
 */
export class ScopedOrchestrationHandler implements OrchestrationCommandHandler {
  private readonly control: AgentControlService;
  private readonly plugins: Pick<PluginAgentTools, "list" | "call"> | null;
  private readonly providers: ProviderDirectorySources;
  private readonly integrations: ScopedOrchestrationIntegrations;

  constructor(
    control: AgentControlService,
    plugins: Pick<PluginAgentTools, "list" | "call"> | null = null,
    providers: ProviderDirectorySources = { cli: () => null, limits: () => null },
    integrations: ScopedOrchestrationIntegrations = {}
  ) {
    this.control = control;
    this.plugins = plugins;
    this.providers = providers;
    this.integrations = integrations;
  }

  /** Orchestrators see core tools; agents also see task-board tools scoped to their own root. */
  listTools(sessionId: string): McpToolDefinition[] {
    if (this.control.isReadOnlyReviewer(sessionId)) return [];
    const session = this.control.status(sessionId);
    const core = ORCHESTRATION_TOOL_DEFINITIONS.filter((tool) => {
      if (TASK_TOOL_NAMES.has(tool.name)) return Boolean(this.integrations.taskBoard);
      if (tool.name === "get_task_budget") return Boolean(this.integrations.budget);
      if (tool.name === "list_orchestration_templates" || tool.name === "apply_orchestration_template") return Boolean(this.integrations.templates);
      if (ORCHESTRATOR_ONLY_ADDITIONAL_TOOLS.has(tool.name)) return session.role === "orchestrator";
      return session.role === "orchestrator";
    });
    return [
      ...core,
      ...(this.plugins?.list(session.role, session.provider) ?? [])
    ];
  }

  async execute(sessionId: string, request: OrchestrationRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      if (signal?.aborted) throw canceledError();
      const session = this.control.status(sessionId);
      if (this.control.isReadOnlyReviewer(sessionId)) {
        throw orchestrationBridgeError("INVALID_REQUEST", "Read-only reviewers cannot call agent or plugin tools.", false);
      }
      if (isPluginOrchestrationTool(request.tool)) return await this.plugin(sessionId, session, request);
      if (TASK_TOOL_NAMES.has(request.tool)) {
        if (session.provider === "terminal") throw orchestrationBridgeError("INVALID_REQUEST", "Plain terminals cannot use the orchestration task board.", false);
        return await this.taskTool(sessionId, request.tool, request.arguments);
      }
      if (request.tool === "get_task_budget") {
        const budget = this.control.taskBudget(sessionId);
        return budget ? ({ budget } as Record<string, unknown>) : { available: false, reason: "No task budget is configured." };
      }
      if (request.tool === "list_orchestration_templates") return await this.listTemplates(sessionId);
      if (request.tool === "apply_orchestration_template") return await this.applyTemplate(sessionId, request.arguments);
      // Plugin tools may reach other roles' sessions through the same bridge; the core tools never do.
      if (session.role !== "orchestrator") {
        throw orchestrationBridgeError("INVALID_REQUEST", "Only orchestrator sessions can use CanvasTTY's agent tools.", false);
      }
      switch (request.tool) {
        case "list_providers":
          return this.listProviders(session);
        case "wait_for_agent":
          return await this.wait(sessionId, request.arguments, signal);
        case "spawn_agent":
          return await this.spawn(sessionId, request.arguments, signal);
        case "send_to_agent":
          return await this.send(sessionId, request.arguments, signal);
        case "observe_agent":
          return this.observe(sessionId, request.arguments);
        case "get_agent_result":
          return await this.result(sessionId, request.arguments);
        case "cancel_agent":
          return this.cancel(sessionId, request.arguments);
        case "list_agents":
          return this.list(sessionId);
        case "retry_agent":
          return await this.retry(sessionId, request.arguments, signal);
        default:
          throw orchestrationBridgeError("INVALID_REQUEST", "Unsupported orchestration tool.", false);
      }
    } catch (error) {
      if (error && typeof error === "object" && "bridgeError" in error) throw error;
      // The launch was refused, cancelled or superseded: retrying the same call would not deliver it either.
      if (error instanceof PromptNotDeliveredError) throw orchestrationBridgeError("INVALID_REQUEST", error.message, false);
      // A delegation or launch rule said no: the same call would be refused again.
      if (error instanceof LaunchRefusal) throw orchestrationBridgeError("INVALID_REQUEST", error.message, false);
      throw orchestrationBridgeError(
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : "Orchestration command failed.",
        true
      );
    }
  }

  private async plugin(
    sessionId: string,
    session: { role: SessionRole; provider: ProviderId },
    request: OrchestrationRequest
  ): Promise<Record<string, unknown>> {
    if (!this.plugins?.list(session.role, session.provider).some((tool) => tool.name === request.tool)) {
      throw orchestrationBridgeError("INVALID_REQUEST", "That plugin tool is not available to this session.", false);
    }
    try {
      this.control.assertInputAllowed(sessionId);
      const result = await this.plugins.call(sessionId, session.role, request.tool, request.arguments);
      return { pluginTool: true, text: result.content, isError: result.isError };
    } catch (error) {
      throw orchestrationBridgeError("INVALID_REQUEST", error instanceof Error ? error.message : "The plugin tool failed.", false);
    }
  }

  private listProviders(session: { role: SessionRole; provider: ProviderId }): Record<string, unknown> {
    const pluginTools = this.plugins?.list(session.role, session.provider).map((tool) => tool.name) ?? [];
    return listProviderDirectory(this.providers, pluginTools) as unknown as Record<string, unknown>;
  }

  private async taskTool(sessionId: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const board = this.integrations.taskBoard;
    if (!board) throw orchestrationBridgeError("INVALID_REQUEST", "The shared task board is not configured.", false);
    const lineage = this.control.lineage(sessionId);
    const root = this.control.taskRoot(sessionId);
    const actor = lineage[0]!;
    const authorityId=actor.role==="orchestrator" && !actor.parentSessionId ? root.id : sessionId;
    try {
      switch (tool) {
        case "list_tasks":
          return await board.listTasks(root.cwd, root.id);
        case "claim_task":
          return { task: await board.claimTask(root.cwd, root.id, sessionId, this.control.maskText(actor.title,65_536), args.taskId as string) };
        case "update_task": {
          const patch: OrchestrationTaskPatch = {};
          for (const key of ["title", "description", "progress", "status", "ownerSessionId", "ownerName", "dependencies"]) {
            if (Object.prototype.hasOwnProperty.call(args, key)) Object.assign(patch, { [key]: args[key] });
          }
          if(patch.ownerSessionId && this.control.taskRoot(patch.ownerSessionId).id!==root.id)throw new Error("Task owner must belong to this orchestration tree.");
          for(const key of ["title","description","progress","ownerName"] as const)if(typeof patch[key]==="string")patch[key]=this.control.maskText(patch[key]!,65_536);
          return { task: await board.updateTask(root.cwd, root.id, authorityId, args.taskId as string, patch) };
        }
        case "complete_task":
          return { task: await board.completeTask(root.cwd, root.id, authorityId, args.taskId as string, this.control.maskText(args.result as string,65_536)) };
        default:
          throw orchestrationBridgeError("INVALID_REQUEST", "Unsupported task-board tool.", false);
      }
    } catch (error) {
      if (error && typeof error === "object" && "bridgeError" in error) throw error;
      throw orchestrationBridgeError("INVALID_REQUEST", error instanceof Error ? error.message : "Task-board operation failed.", false);
    }
  }

  private async listTemplates(sessionId: string): Promise<Record<string, unknown>> {
    const service = this.integrations.templates;
    if (!service) throw orchestrationBridgeError("INVALID_REQUEST", "Orchestration templates are not configured.", false);
    const root = this.control.taskRoot(sessionId);
    const listing = await service.list(root.cwd);
    return { ...listing, templates: listing.templates.filter(template => template.trusted === true) } as unknown as Record<string, unknown>;
  }

  private async applyTemplate(sessionId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const service = this.integrations.templates;
    if (!service) throw orchestrationBridgeError("INVALID_REQUEST", "Orchestration templates are not configured.", false);
    const root = this.control.taskRoot(sessionId);
    const available = await service.list(root.cwd);
    const template = available.templates.find((item) => item.id === args.templateId);
    if (!template) throw orchestrationBridgeError("INVALID_REQUEST", `Template "${String(args.templateId).slice(0, 80)}" is not available. Call list_orchestration_templates for the current choices.`, false);
    return {
      templateId: template.id,
      name: template.name,
      expectedSubagents: template.expectedSubagents,
      instructions: service.instructions(template).replace("{{TASK}}", args.task as string),
      ...(available.errors.length > 0 ? { templateErrors: available.errors } : {})
    };
  }

  private async retry(orchestratorId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const target = args.sessionId as string;
    if (target === orchestratorId) throw orchestrationBridgeError("INVALID_REQUEST", "retry_agent retries a subagent, not this session.", false);
    this.requireOwned(orchestratorId, target);
    if (signal?.aborted) throw canceledError();
    const created = await this.control.retry(target, args.reason as string | undefined, signal);
    // Retry owns cancellation cleanup and retains this same card's diagnostic history.
    return { sessionId: created.id, provider: created.provider, title: created.title, profile: created.profile,
      ...(created.model !== undefined ? { model: created.model } : {}), ...(created.effort !== undefined ? { effort: created.effort } : {}) };
  }

  private async wait(orchestratorId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const target = args.sessionId as string;
    // Its own session is in its subtree, but waiting on itself would only ever time out.
    if (target === orchestratorId) {
      throw orchestrationBridgeError("INVALID_REQUEST", "wait_for_agent waits for a subagent, not for this session.", false);
    }
    this.requireOwned(orchestratorId, target);
    const seconds = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : DEFAULT_AGENT_WAIT_SECONDS;
    // OpenCode's MCP client can impose a 60-second request deadline, even when the helper allows longer.
    const clientLimitMs = this.control.status(orchestratorId).provider === "opencode" ? 50_000 : 100_000;
    try {
      const result = await this.control.waitFor(target, {
        timeoutMs: Math.min(clientLimitMs, Math.min(MAX_AGENT_WAIT_SECONDS, Math.max(1, seconds)) * 1_000),
        deferReview: true,
        ...(signal ? { signal } : {})
      });
      if (result.reason === "closed") return { ...result };
      return { ...result, ...(result.reason === "timeout" || result.review?.status === "pending"
        ? { message: "Still running. Call wait_for_agent again for progress." } : {}) };
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw canceledError();
      throw error;
    }
  }

  private async spawn(orchestratorId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!(AGENT_PROVIDERS as readonly unknown[]).includes(args.provider)) {
      throw orchestrationBridgeError("INVALID_REQUEST", unknownProviderMessage(args.provider), false);
    }
    const provider = args.provider as AgentProviderId;
    const hasExplicitModel = args.model !== undefined;
    const problem = (hasExplicitModel ? launchModelProblem(provider, args.model) : null)
      ?? (args.effort !== undefined ? launchEffortProblem(provider, args.effort) : null);
    if (problem) throw orchestrationBridgeError("INVALID_REQUEST", `${problem} Call list_providers for what ${provider} takes.`, false);
    const profile = this.control.profileFor(orchestratorId, provider, args.profile);
    if ("error" in profile) throw orchestrationBridgeError("INVALID_REQUEST", profile.error, false);
    if (hasExplicitModel) {
      let unknown: string | null = null;
      try { unknown = await this.providers.checkModel?.(provider, args.model as string) ?? null; } catch { unknown = null; }
      if (unknown) throw orchestrationBridgeError("INVALID_REQUEST", unknown, false);
    }
    if (args.reviewModel !== undefined) {
      if (args.review !== true) throw orchestrationBridgeError("INVALID_REQUEST", "reviewModel can be set only when review:true.", false);
      const reviewProblem = launchModelProblem(provider, args.reviewModel);
      if (reviewProblem) throw orchestrationBridgeError("INVALID_REQUEST", `${reviewProblem} Call list_providers for the valid reviewer models.`, false);
      const unknownReviewModel = await this.providers.checkModel?.(provider, args.reviewModel as string) ?? null;
      if (unknownReviewModel) throw orchestrationBridgeError("INVALID_REQUEST", unknownReviewModel, false);
      if (hasExplicitModel && args.reviewModel === args.model) {
        throw orchestrationBridgeError("INVALID_REQUEST", "The review model must differ from the worker model.", false);
      }
    }
    let model = hasExplicitModel ? args.model as string : undefined;
    let effort = args.effort as SpawnAgentRequest["effort"] | undefined;
    if (!hasExplicitModel && this.control.taskBudget(orchestratorId)?.paused) {
      throw orchestrationBridgeError("INVALID_REQUEST", this.control.taskBudget(orchestratorId)?.reason ?? "This task's budget is exhausted.", false);
    }
    // A spawn without an account runs on the orchestrator's account (never silently on the CLI's default model).
    let launchOptions = args.launchOptions as SpawnAgentRequest["launchOptions"];
    let accountSource: "inherited" | "explicit" | "none" = "none";
    if (typeof this.control.subagentAccount === "function") {
      try {
        const account = this.control.subagentAccount(orchestratorId, provider, launchOptions);
        launchOptions = account.launchOptions;
        accountSource = account.source;
      } catch (error) {
        throw orchestrationBridgeError("INVALID_REQUEST", error instanceof Error ? error.message : String(error), false);
      }
    }
    const accountId = selectedAccountId(launchOptions as Record<string, unknown> | undefined);
    // A model account supplies its model and remains visible in the launch result.
    const accountChosen = accountId !== "default";
    if (args.reviewModel !== undefined && model === args.reviewModel) {
      throw orchestrationBridgeError("INVALID_REQUEST", "The review model must differ from the selected worker model.", false);
    }
    if (signal?.aborted) throw canceledError();
    const created = await this.control.spawn({
      parentSessionId: orchestratorId,
      provider: args.provider as never,
      cwd: args.cwd as string,
      ...(args.title !== undefined ? { title: args.title as string } : {}),
      ...(args.prompt !== undefined ? { initialPrompt: args.prompt as string } : {}),
      ...(launchOptions !== undefined ? { launchOptions } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(args.isolate === "worktree" ? { isolate: "worktree" as const } : {}),
      ...(args.review === true ? { review: true } : {}),
      ...(typeof args.reviewModel === "string" ? { reviewModel: args.reviewModel } : {}),
      profile: profile.profile
    }, signal).catch((error: unknown) => {
      if (signal?.aborted) throw canceledError();
      throw error;
    });
    if (signal?.aborted) {
      // Canceled while the agent was starting: nobody will receive its id, so close it.
      try {
        this.control.cancel(created.id);
      } catch {
        // It already ended.
      }
      throw canceledError();
    }
    const servedBy = {
      provider,
      account: accountChosen ? accountId : null,
      accountSource: accountChosen ? accountSource : "none",
      model: created.model ?? (accountChosen ? `set by model account ${accountId.slice(0, 40)}` : defaultModelText(provider))
    };
    return {
      sessionId: created.id,
      provider: created.provider,
      status: created.status,
      title: created.title,
      profile: created.profile,
      ...(profile.inherited ? { profileInherited: true } : {}),
      ...(created.model !== undefined ? { model: created.model } : {}),
      ...(created.effort !== undefined ? { effort: created.effort } : {}),
      servedBy,
      ...(args.review === true ? { reviewRequested: true } : {}),
      ...(args.isolate === "worktree" ? { isolationRequested: "worktree" } : {}),
    };
  }

  private async send(orchestratorId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    try {
      await this.control.send(
        args.sessionId as string,
        args.prompt as string,
        args.submit === undefined ? true : Boolean(args.submit),
        signal
      );
    } catch (error) {
      if (signal?.aborted) throw canceledError();
      throw error;
    }
    if (signal?.aborted) throw canceledError();
    return { sessionId: args.sessionId as string, sent: true };
  }

  private observe(orchestratorId: string, args: Record<string, unknown>): Record<string, unknown> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    const observation = this.control.observe(
      args.sessionId as string,
      args.maxChars as number | undefined
    );
    return {
      sessionId: observation.sessionId,
      status: observation.status,
      output: observation.output,
      ...(observation.exitCode !== undefined ? { exitCode: observation.exitCode } : {}),
      ...(observation.exitLines ? { exitLines: observation.exitLines } : {})
    };
  }

  private async result(orchestratorId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    const result = await this.control.resultWithReview(args.sessionId as string, { deferReview: true });
    return {
      sessionId: result.sessionId,
      state: result.state,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
      ...(result.exitLines ? { exitLines: result.exitLines } : {}),
      ...(result.answer ? { answer: result.answer } : {}),
      ...(result.review ? { review: result.review } : {})
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
        title: session.title,
        profile: session.profile,
        ...(session.model !== undefined ? { model: session.model } : {})
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

function canceledError(): Error {
  return orchestrationBridgeError("CANCELED", "Orchestration command was canceled.", true);
}

/** What serves a subagent that names neither a model nor a model account. */
function defaultModelText(provider: AgentProviderId): string {
  return provider === "opencode"
    ? "OpenCode's default model (its own configuration decides; with none set OpenCode uses its free OpenCode Zen model on opencode.ai)"
    : `${provider}'s default model`;
}
