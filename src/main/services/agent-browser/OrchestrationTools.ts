import { executionStrategy, executionGuidance, normalizeExecutionStrategy, isExecutionGoal, type ExecutionStrategy } from "../../../shared/executionStrategy.ts";
import type { OrchestrationCommandHandler, OrchestrationRequest } from "./orchestration-protocol.ts";
import { ACCOUNTS_PLUGIN_ID, selectedAccountId } from "../accountHomeIsolation.ts";
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
import type { ModelRouteCandidate, ModelRouteRequest, ModelRouter, ModelRoutingInfo } from "../ModelRouter.ts";
import type { OrchestrationBudgetService } from "../OrchestrationBudgetService.ts";
import type { OrchestrationTaskBoard, OrchestrationTaskPatch } from "../OrchestrationTaskBoard.ts";
import type { OrchestrationTemplateService } from "../OrchestrationTemplateService.ts";
import type { SecretGrantService } from "../SecretGrantService.ts";
import { HumanQuestionError, type HumanQuestionRequest, type HumanQuestionService } from "../HumanQuestionService.ts";

const TASK_TOOL_NAMES = new Set(["list_tasks", "claim_task", "update_task", "complete_task"]);
const ORCHESTRATOR_ONLY_ADDITIONAL_TOOLS = new Set(["retry_agent"]);
const SECRET_TOOL_NAMES = new Set(["request_secret", "run_secret_request"]);

export interface ScopedOrchestrationIntegrations {
  router?: ModelRouter;
  taskBoard?: OrchestrationTaskBoard;
  budget?: Pick<OrchestrationBudgetService, "snapshot">;
  templates?: OrchestrationTemplateService;
  /** Main-process grant manager; approval/revocation APIs are never exposed through agent tools. */
  secretGrants?: Pick<SecretGrantService, "requestSecret" | "runSecretRequest">;
  /** A bounded, memory-only human question channel; replies never grant permissions. */
  humanQuestions?: Pick<HumanQuestionService, "request">;
  /** Timeline persistence records how the route was selected on the child session. */
  onRouting?(sessionId: string, route: ModelRoutingInfo, task?: string): void;
  onReview?(sessionId: string, review: AgentReviewResult): void;
  onRouteOutcome?(sessionId: string, outcome: {
    parentSessionId: string;
    task: string;
    status: "failed" | "accepted" | "rejected" | "rework";
  }): void;
  routeTimeoutMs?: number;
  /**
   * The model accounts an orchestrator may delegate for a provider (the accounts plugin's launch choices, only when
   * it declared them delegable). With two or more, a subagent that would inherit its orchestrator's account lets the
   * router choose among them; the chosen ACCOUNT then sets the model, so no second --model is ever added.
   */
  accountCandidates?(provider: AgentProviderId, sessionId: string): Promise<Array<{ id: string; label: string }>>;
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** The model an account label names ("GLM 5.3 Flash · Z.AI · glm-5.3-flash"): its last " · " part, for ranking only. */
function accountModelLabel(label: string): string | undefined {
  const tail = label.split(" · ").at(-1)?.trim() ?? "";
  return /^[A-Za-z0-9._:/-]{1,100}$/u.test(tail) ? tail : undefined;
}

/**
 * The only bridge between the orchestration MCP surface and session control.
 * Every tool call is scoped to the authenticated orchestrator's own subtree:
 * a foreign session id is a protocol error, never a filtered result, so an
 * orchestrator cannot probe sessions it does not own.
 */
export class ScopedOrchestrationHandler implements OrchestrationCommandHandler {
  private readonly strategyPending = new Map<string, Promise<ExecutionStrategy>>();
  private readonly control: AgentControlService;
  private readonly plugins: Pick<PluginAgentTools, "list" | "call"> | null;
  private readonly providers: ProviderDirectorySources;
  private readonly integrations: ScopedOrchestrationIntegrations;
  private readonly routedTasks = new Map<string, { parentSessionId: string; task: string; review: boolean; attempt: number }>();
  private readonly routeWatchers = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly reviewCallbacksSent = new Set<string>();
  private readonly outcomeCallbacksSent = new Set<string>();

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
      if (tool.name === "get_execution_strategy") return session.role === "orchestrator" && Boolean(this.control.executionContext?.(sessionId).goal);
      if (tool.name === "ask_user") return Boolean(this.integrations.humanQuestions) && session.provider !== "terminal";
      if (TASK_TOOL_NAMES.has(tool.name)) return Boolean(this.integrations.taskBoard);
      if (tool.name === "get_task_budget") return Boolean(this.integrations.budget);
      if (tool.name === "list_orchestration_templates" || tool.name === "apply_orchestration_template") return Boolean(this.integrations.templates);
      if (SECRET_TOOL_NAMES.has(tool.name)) return Boolean(this.integrations.secretGrants) && session.provider !== "terminal";
      if (ORCHESTRATOR_ONLY_ADDITIONAL_TOOLS.has(tool.name)) return session.role === "orchestrator";
      return session.role === "orchestrator";
    });
    return [
      ...core,
      ...(this.plugins?.list(session.role, session.provider) ?? [])
    ];
  }

  /** Forget per-session route state when TerminalManager removes the corresponding card. */
  forgetSession(sessionId: string): void {
    this.routeWatchers.get(sessionId)?.controller.abort();
    this.routeWatchers.delete(sessionId);
    this.routedTasks.delete(sessionId);
    for (const key of this.reviewCallbacksSent) if (key.startsWith(`${sessionId}:`)) this.reviewCallbacksSent.delete(key);
    for (const key of this.outcomeCallbacksSent) if (key.startsWith(`${sessionId}:`)) this.outcomeCallbacksSent.delete(key);
  }

  async execute(sessionId: string, request: OrchestrationRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      if (signal?.aborted) throw canceledError();
      const session = this.control.status(sessionId);
      if (this.control.isReadOnlyReviewer(sessionId)) {
        throw orchestrationBridgeError("INVALID_REQUEST", "Read-only reviewers cannot call agent or plugin tools.", false);
      }
      if (request.tool === "ask_user") return await this.askUser(sessionId, request.arguments, signal);
      if (SECRET_TOOL_NAMES.has(request.tool)) return await this.secretTool(sessionId, request.tool, request.arguments, signal);
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
        case "get_execution_strategy": {
          const strategy = await this.resolveStrategy(sessionId, typeof request.arguments.task === "string" ? request.arguments.task : undefined);
          return strategy ? { strategy, instructions: executionGuidance(strategy) } : { available: false, reason: "This session has no execution goal." };
        }
        case "list_execution_targets": {
          const targets = this.control.executionTargets(sessionId);
          return { enabled: targets !== null, targets: targets ?? [] };
        }
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

  private async secretTool(sessionId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const service = this.integrations.secretGrants;
    if (!service) throw orchestrationBridgeError("INVALID_REQUEST", "Secret-grant controls are unavailable.", false);
    if (this.control.status(sessionId).provider === "terminal") {
      throw orchestrationBridgeError("INVALID_REQUEST", "Provider secrets are available to agent sessions only.", false);
    }
    try {
      this.control.assertInputAllowed(sessionId);
      if (tool === "request_secret") {
        const request = service.requestSecret(
          sessionId,
          args.secretId as string,
          this.control.maskText(args.reason as string, 1_000)
        );
        return { pendingApproval: true, request };
      }
      if (tool === "run_secret_request") {
        const result = await service.runSecretRequest(sessionId, {
          secretId: args.secretId as string,
          ...(typeof args.apiProfileId === "string" ? { apiProfileId: args.apiProfileId } : {}),
          method: args.method as string,
          path: args.path as string,
          ...(args.body && typeof args.body === "object" && !Array.isArray(args.body) ? { body: args.body as Record<string, unknown> } : {}),
          ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {})
        }, signal);
        return { ...result };
      }
      throw new Error("Unsupported secret operation.");
    } catch (error) {
      if (signal?.aborted) throw canceledError();
      throw orchestrationBridgeError("INVALID_REQUEST", error instanceof Error ? error.message : "Secret operation failed.", false);
    }
  }

  private async askUser(sessionId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const service = this.integrations.humanQuestions;
    if (!service) throw orchestrationBridgeError("INVALID_REQUEST", "Human questions are not configured.", false);
    if (this.control.status(sessionId).provider === "terminal") {
      throw orchestrationBridgeError("INVALID_REQUEST", "Plain terminal sessions cannot ask human questions.", false);
    }
    if (signal?.aborted) throw canceledError();
    try {
      return { ...await service.request(sessionId, args as unknown as HumanQuestionRequest, signal) };
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw canceledError();
      if (error instanceof HumanQuestionError) {
        throw orchestrationBridgeError(error.code, error.message, error.code === "TIMEOUT");
      }
      throw orchestrationBridgeError("INTERNAL_ERROR", error instanceof Error ? error.message : "The human question failed.", true);
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
      this.publishResult(target, { ...this.control.result(target), ...(result.review ? { review: result.review } : {}) });
      return { ...result, ...(result.reason === "timeout" || result.review?.status === "pending"
        ? { message: "Still running. Call wait_for_agent again for progress." } : {}) };
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw canceledError();
      throw error;
    }
  }

  private async resolveStrategy(sessionId: string, task?: string): Promise<ExecutionStrategy | undefined> {
    const context = this.control.executionContext?.(sessionId);
    if (!context?.goal) return undefined;
    if (context.strategy) return this.control.rememberExecutionStrategy(sessionId, context.strategy);
    const pending = this.strategyPending.get(context.rootId);
    if (pending) return pending;
    const resolve = async (): Promise<ExecutionStrategy> => {
      const overall = this.control.maskText(context.task || task || "", 8000).trim();
      let strategy = executionStrategy("auto", "balanced", "fallback", overall
        ? "The strategy classifier is unavailable; balanced host defaults apply."
        : "No overall task was supplied. Balanced defaults apply; worker prompts are not classified as the overall task.");
      if (overall && this.integrations.router?.strategy) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const budget = this.control.taskBudget(sessionId);
          if (budget?.paused) throw new Error("The shared task budget is paused.");
          const answer = await Promise.race([
            this.integrations.router.strategy({ sessionId: this.control.lineage(sessionId).at(-1)!.id, task: overall, cwd: this.control.taskRoot(sessionId).cwd,
              ...(budget ? { budget: { limits: budget.limits, usage: budget.usage, remaining: budget.remaining, paused: budget.paused } } : {}) }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Strategy classifier timed out.")), this.integrations.routeTimeoutMs ?? 2000); })
          ]);
          if (answer && isExecutionGoal(answer.goal) && String(answer.goal) !== "auto" && (answer.source === undefined || answer.source === "jev" || answer.source === "fallback") && typeof answer.reason === "string" && answer.reason.trim()) {
            strategy = normalizeExecutionStrategy({ ...executionStrategy("auto", answer.goal, answer.source ?? "jev", this.control.maskText(answer.reason, 500)),
              category: answer.category, difficulty: answer.difficulty, confident: answer.confident })!;
          } else strategy.reason = "The classifier returned an invalid strategy; balanced host defaults apply.";
        } catch { /* The fallback is explicit and cannot grant additional permissions or budget. */ }
        finally { if (timer) clearTimeout(timer); }
      }
      return this.control.rememberExecutionStrategy(sessionId, strategy);
    };
    const work = resolve();
    this.strategyPending.set(context.rootId, work);
    try { return await work; }
    finally { if (this.strategyPending.get(context.rootId) === work) this.strategyPending.delete(context.rootId); }
  }

  private async spawn(orchestratorId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    // Only the root's overall task feeds strategy selection. A worker prompt must never substitute for it.
    const strategy = this.control.executionContext?.(orchestratorId).goal ? await this.resolveStrategy(orchestratorId) : undefined;
    const reviewRequested = args.review === true || strategy?.review === "required";
    if (!(AGENT_PROVIDERS as readonly unknown[]).includes(args.provider)) {
      throw orchestrationBridgeError("INVALID_REQUEST", unknownProviderMessage(args.provider), false);
    }
    const provider = args.provider as AgentProviderId;
    let targetId:string|undefined;
    const targets=this.control.executionTargets(orchestratorId);
    if(args.executionTargetId!==undefined && typeof args.executionTargetId!=="string")throw orchestrationBridgeError("INVALID_REQUEST","Invalid execution target id.",false);
    if (targets !== null) {
      const explicitTarget = typeof args.executionTargetId === "string" && args.executionTargetId !== "auto";
      const readyAccounts = !explicitTarget && this.integrations.accountCandidates ? await this.integrations.accountCandidates(provider, orchestratorId).catch(() => []) : [];
      const offered = targets.filter(t => t.provider === provider && (args.executionTargetId && args.executionTargetId !== "auto" || t.accountId === "default" || readyAccounts.some(a => a.id === t.accountId)) && (args.model === undefined || args.model === "auto" || t.model === args.model) && (args.launchOptions === undefined || selectedAccountId(args.launchOptions as SpawnAgentRequest["launchOptions"]) === t.accountId));
      if (args.executionTargetId && args.executionTargetId !== "auto") {
        targetId = offered.find(t => t.id === args.executionTargetId)?.id;
      }
      else if (offered.length === 1) {
        targetId = offered[0]!.id;
      }
      else if (offered.length > 1 && this.integrations.router) {
        const profile = this.control.profileFor(orchestratorId, provider, args.profile);
        if ("error" in profile) {
          throw orchestrationBridgeError("INVALID_REQUEST", profile.error, false);
        }
        const answer = await this.askRouter({ sessionId: orchestratorId, task: typeof args.prompt === "string" ? args.prompt : "", provider, profile: profile.profile, cwd: this.control.taskRoot(orchestratorId).cwd, requested: {}, humanChoice: null, candidates: offered.map(t => ({ id: t.id, provider: t.provider, model: t.inferenceModel ?? t.model, available: true, ...(typeof args.effort === "string" ? { reasoningEffort: args.effort as never } : {}) })), ...(strategy ? { executionStrategy: strategy } : {}), ...(this.control.taskBudget(orchestratorId) ? { budget: this.control.taskBudget(orchestratorId)! } : {}) }, signal);
        targetId = offered.find(t => t.id === answer?.candidateId)?.id;
      }
      if (!targetId) {
        throw orchestrationBridgeError("INVALID_REQUEST", "No permitted execution target was selected; choose an available target id. No default launch was attempted.", false);
      }
      const selected = offered.find(t => t.id === targetId)!;
      args = { ...args, model: selected.model, executionTargetId: targetId };
    }
    else if (args.executionTargetId !== undefined) {
      throw orchestrationBridgeError("INVALID_REQUEST", "Execution target policy is not enabled.", false);
    }
    const hasExplicitModel = args.model !== undefined && args.model !== "auto";
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
      if (!reviewRequested) throw orchestrationBridgeError("INVALID_REQUEST", "reviewModel can be set only when review:true.", false);
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
    let routing: ModelRoutingInfo | undefined;
    if (hasExplicitModel) routing = { source: "explicit", reason: "The spawn_agent call supplied a model; the router did not override it." };
    if (!hasExplicitModel && this.control.taskBudget(orchestratorId)?.paused) {
      throw orchestrationBridgeError("INVALID_REQUEST", this.control.taskBudget(orchestratorId)?.reason ?? "This task's budget is exhausted.", false);
    }
    // A spawn without an account runs on the orchestrator's account (never silently on the CLI's default model).
    let launchOptions = args.launchOptions as SpawnAgentRequest["launchOptions"];
    let accountSource: "inherited" | "explicit" | "routed" | "none" = "none";
    if (!targetId && typeof this.control.subagentAccount === "function") {
      try {
        const account = this.control.subagentAccount(orchestratorId, provider, launchOptions);
        launchOptions = account.launchOptions;
        accountSource = account.source;
      } catch (error) {
        throw orchestrationBridgeError("INVALID_REQUEST", error instanceof Error ? error.message : String(error), false);
      }
    }
    if(targetId) accountSource="explicit";
    let accountId = targetId ? targets!.find(t=>t.id===targetId)!.accountId : selectedAccountId(launchOptions as Record<string, unknown> | undefined);
    // A model account passes its own --model: the router must not add a second one (OpenCode crashed on two).
    const accountChosen = accountId !== "default";
    if(targetId) {routing={source:"explicit",candidateId:targetId,reason:"Selected a person-approved execution target."};}
    else if (!hasExplicitModel && accountChosen && accountSource === "inherited" && this.integrations.router && this.integrations.accountCandidates) {
      // The router may move an inherited subagent to another delegable account; it never adds a model.
      const route = await this.routeAccount(orchestratorId, provider, args, profile.profile, accountId, signal);
      if (route.account && route.account !== accountId) {
        const current = (launchOptions as Record<string, Record<string, unknown>> | undefined)?.[ACCOUNTS_PLUGIN_ID] ?? {};
        launchOptions = { ...(launchOptions ?? {}), [ACCOUNTS_PLUGIN_ID]: { ...current, account: route.account } } as SpawnAgentRequest["launchOptions"];
        accountId = route.account;
        accountSource = "routed";
      }
      routing = route.info;
    } else if (!hasExplicitModel && accountChosen) {
      routing = { source: "default", reason: `Model account ${accountId.slice(0, 40)}${accountSource === "inherited" ? " (inherited from the orchestrator)" : ""} decides the model; the router was not asked.` };
    } else if (!hasExplicitModel && this.integrations.router) {
      const route = await this.routeModel(orchestratorId, provider, args, profile.profile, signal);
      model = route.model;
      effort = route.effort;
      routing = route.info;
    } else if (args.model === "auto") {
      routing = { source: "default", reason: this.integrations.router ? "No listed models are available to route." : "No model router is installed; using the provider default." };
    }
    if (args.reviewModel !== undefined && model === args.reviewModel) {
      throw orchestrationBridgeError("INVALID_REQUEST", "The review model must differ from the selected worker model.", false);
    }
    if (signal?.aborted) throw canceledError();
    const created = await this.control.spawn({
      parentSessionId: orchestratorId,
      ...(targetId?{executionTargetId:targetId}:{}),
      provider: args.provider as never,
      cwd: args.cwd as string,
      ...(args.title !== undefined ? { title: args.title as string } : {}),
      ...(args.prompt !== undefined ? { initialPrompt: args.prompt as string } : {}),
      ...(!targetId && launchOptions !== undefined ? { launchOptions } : targetId && args.launchOptions!==undefined ? {launchOptions:args.launchOptions as SpawnAgentRequest["launchOptions"]} : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(args.review === true ? { review: true } : {}),
      ...(typeof args.reviewModel === "string" ? { reviewModel: args.reviewModel } : {}),
      ...(args.isolate === "worktree" ? { isolate: "worktree" as const } : {}),
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
    if (!routing && !accountChosen) {
      // Nothing routed it: the card still says which provider and model serve it.
      const reason = `No model account: served by ${provider}'s own sign-in and ${servedBy.model}.`;
      try { this.integrations.onRouting?.(created.id, { source: "default", reason }, undefined); } catch { /* display only */ }
    }
    if (routing) {
      const safeRouting = { ...routing, reason: this.control.maskText(routing.reason, 500) };
      const task = this.control.maskText(String(args.prompt ?? ""), 8_000);
      this.routedTasks.set(created.id, { parentSessionId: orchestratorId, task, review: reviewRequested, attempt: 0 });
      try { this.integrations.onRouting?.(created.id, safeRouting, task); } catch { /* timeline failures do not undo a launch */ }
      this.scheduleRouteWatch(created.id);
      routing = safeRouting;
    }
    return {
      ...(strategy ? { executionStrategy: strategy, instructions: executionGuidance(strategy) } : {}),
      sessionId: created.id,
      provider: created.provider,
      status: created.status,
      title: created.title,
      profile: created.profile,
      ...(profile.inherited ? { profileInherited: true } : {}),
      ...(created.model !== undefined ? { model: created.model } : {}),
      ...(created.effort !== undefined ? { effort: created.effort } : {}),
      ...(routing ? { routing } : {}),
      servedBy,
      ...(reviewRequested ? { reviewRequested: true } : {}),
      ...(args.isolate === "worktree" ? { isolationRequested: "worktree" } : {})
    };
  }

  /** Asks the router with the host deadline; null on timeout or failure (the caller keeps its default). */
  private async askRouter(request: ModelRouteRequest, signal?: AbortSignal): Promise<{ candidateId: string; reason: string; escalated?: boolean } | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      const response = await Promise.race([
        this.integrations.router!.route(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Model router timed out after 2 seconds.")), this.integrations.routeTimeoutMs ?? 2_000);
          timer.unref?.();
          if (signal) {
            const onAbort = (): void => reject(canceledError());
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbort = () => signal.removeEventListener("abort", onAbort);
          }
        })
      ]);
      return response && typeof response === "object" && typeof response.candidateId === "string" ? response : null;
    } catch (error) {
      if (signal?.aborted) throw canceledError();
      return null;
    } finally {
      clearTimeout(timer);
      removeAbort?.();
    }
  }

  /** Account routing: candidates are the delegable accounts for this provider; the current (inherited) one is the default. */
  private async routeAccount(
    sessionId: string,
    provider: AgentProviderId,
    args: Record<string, unknown>,
    profile: string,
    currentAccount: string,
    signal?: AbortSignal
  ): Promise<{ account?: string; info: ModelRoutingInfo }> {
    const keep = (reason: string) => ({ info: { source: "default" as const, reason: `${reason} Model account ${currentAccount.slice(0, 40)} (inherited from the orchestrator) decides the model.` } });
    let offered: Array<{ id: string; label: string }> = [];
    try { offered = await this.integrations.accountCandidates!(provider, sessionId); } catch { offered = []; }
    const seen = new Set<string>();
    const accounts = (Array.isArray(offered) ? offered : []).filter((item) => item && typeof item.id === "string" && ACCOUNT_ID.test(item.id)
      && typeof item.label === "string" && !seen.has(item.id) && seen.add(item.id)).slice(0, 32);
    if (accounts.length < 2 || !accounts.some((item) => item.id === currentAccount)) return keep("No other delegable model account to route to.");
    const candidates: ModelRouteCandidate[] = accounts.map((item, index) => {
      const model = accountModelLabel(item.label);
      return { id: `account-${index}`, provider, ...(model ? { model } : {}),
        ...(args.effort ? { reasoningEffort: args.effort as SpawnAgentRequest["effort"] } : {}), available: true, ...(item.id === currentAccount ? { default: true } : {}) };
    });
    if (signal?.aborted) throw canceledError();
    const budget = this.control.taskBudget(sessionId);
    const response = await this.askRouter({
      sessionId,
      task: this.control.maskText(String(args.prompt ?? ""), 8_000),
      provider,
      profile: profile as ModelRouteRequest["profile"],
      cwd: String(args.cwd ?? ""),
      requested: args.effort ? { reasoningEffort: args.effort as SpawnAgentRequest["effort"] } : {},
      candidates,
      humanChoice: null,
      ...(this.control.executionContext?.(sessionId).strategy ? { executionStrategy: this.control.executionContext(sessionId).strategy } : {}),
      ...(budget ? { budget: { limits: budget.limits, usage: budget.usage, remaining: budget.remaining, paused: budget.paused } } : {})
    }, signal);
    const index = response ? candidates.findIndex((candidate) => candidate.id === response.candidateId) : -1;
    if (!response || index < 0) return keep(response ? "The model router chose an account that was not offered." : "The model router failed or timed out.");
    const account = accounts[index]!.id;
    const reason = typeof response.reason === "string" ? response.reason.trim().slice(0, 400) : "Model router selected a listed account.";
    return {
      account,
      info: { source: "router", candidateId: response.candidateId, reason: `${reason} Model account ${account.slice(0, 40)} sets the model.`,
        ...(response.escalated === true ? { escalated: true } : {}) }
    };
  }

  private async routeModel(
    sessionId: string,
    provider: AgentProviderId,
    args: Record<string, unknown>,
    profile: string,
    signal?: AbortSignal
  ): Promise<{ model?: string; effort?: SpawnAgentRequest["effort"]; info: ModelRoutingInfo }> {
    const directory = listProviderDirectory(this.providers);
    const entry = directory.providers.find((candidate) => candidate.id === provider);
    const listedModels = entry?.model.known ?? [];
    const models = [...new Set(listedModels)].slice(0, 64);
    if (!entry || models.length === 0) {
      return { ...(args.effort !== undefined ? { effort: args.effort as SpawnAgentRequest["effort"] } : {}),
        info: { source: "default", reason: "The provider did not list known models; using its default." } };
    }
    const requestedEffort = args.effort as SpawnAgentRequest["effort"] | undefined;
    const effortChoices: Array<SpawnAgentRequest["effort"] | undefined> = requestedEffort
      ? [requestedEffort]
      : [undefined, ...((entry.efforts ?? []) as SpawnAgentRequest["effort"][])];
    const candidates: ModelRouteCandidate[] = [];
    const makeCandidate = (id: string, model?: string, reasoningEffort?: SpawnAgentRequest["effort"], isDefault = false): ModelRouteCandidate => ({
      id,
      provider,
      ...(model !== undefined ? { model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      available: entry.available,
      ...(isDefault ? { default: true } : {})
    });
    for (const model of models.slice(0, 32)) {
      for (const candidateEffort of effortChoices) {
        if (candidates.length >= 191) break;
        const suffix = candidateEffort ?? "default";
        candidates.push(makeCandidate(`m${candidates.length}-${suffix}`, model, candidateEffort));
      }
    }
    for (const candidateEffort of effortChoices) {
      if (candidates.length >= 192) break;
      candidates.push(makeCandidate(`provider-default-${candidateEffort ?? "default"}`, undefined, candidateEffort, true));
    }
    if (signal?.aborted) throw canceledError();
    const budget = this.control.taskBudget(sessionId);
    const routeRequest: ModelRouteRequest = {
      sessionId,
      task: this.control.maskText(String(args.prompt ?? ""), 8_000),
      provider,
      profile: profile as ModelRouteRequest["profile"],
      cwd: String(args.cwd ?? ""),
      requested: {
        ...(typeof args.model === "string" && args.model !== "auto" ? { model: args.model } : {}),
        ...(requestedEffort ? { reasoningEffort: requestedEffort } : {})
      },
      candidates,
      // An effort is a constraint on every candidate, not an explicit choice of model. Explicit models bypass
      // routeModel entirely; keeping this null lets installed rules/Jev choose among the listed candidates.
      humanChoice: null,
      ...(this.control.executionContext?.(sessionId).strategy ? { executionStrategy: this.control.executionContext(sessionId).strategy } : {}),
      ...(budget ? { budget: { limits: budget.limits, usage: budget.usage, remaining: budget.remaining, paused: budget.paused } } : {})
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      const response = await Promise.race([
        this.integrations.router!.route(routeRequest),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Model router timed out after 2 seconds.")), this.integrations.routeTimeoutMs ?? 2_000);
          timer.unref?.();
          if (signal) {
            const onAbort = (): void => reject(canceledError());
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbort = () => signal.removeEventListener("abort", onAbort);
          }
        })
      ]);
      if (!response || typeof response !== "object" || typeof response.candidateId !== "string") {
        throw orchestrationBridgeError("INVALID_REQUEST", "The model router returned an invalid candidate id.", false);
      }
      const selected = candidates.find((candidate) => candidate.id === response.candidateId);
      if (!selected || selected.provider !== provider || selected.available === false) {
        throw orchestrationBridgeError("INVALID_REQUEST", "The model router selected a model or effort that was not listed for this provider.", false);
      }
      if (requestedEffort && selected.reasoningEffort !== requestedEffort) {
        throw orchestrationBridgeError("INVALID_REQUEST", "The model router tried to replace the explicitly requested reasoning effort.", false);
      }
      if (selected.model && (!models.includes(selected.model) || launchModelProblem(provider, selected.model))) {
        throw orchestrationBridgeError("INVALID_REQUEST", "The model router selected a model that is not in list_providers.", false);
      }
      if (selected.reasoningEffort && (!(entry.efforts ?? []).includes(selected.reasoningEffort)
        || launchEffortProblem(provider, selected.reasoningEffort))) {
        throw orchestrationBridgeError("INVALID_REQUEST", "The model router selected an effort that is not in list_providers.", false);
      }
      if (selected.model && selected.observed !== true) {
        const unknown = await this.providers.checkModel?.(provider, selected.model) ?? null;
        if (unknown) throw orchestrationBridgeError("INVALID_REQUEST", unknown, false);
      }
      const reason = typeof response.reason === "string" ? response.reason.trim().slice(0, 500) : "Model router selected a listed candidate.";
      return {
        ...(selected.model ? { model: selected.model } : {}),
        ...(selected.reasoningEffort ? { effort: selected.reasoningEffort } : {}),
        info: {
          source: "router",
          candidateId: selected.id,
          reason,
          ...(response.escalated === true ? { escalated: true } : {})
        }
      };
    } catch (error) {
      if (signal?.aborted) throw canceledError();
      const reason = error instanceof Error && /timed out/u.test(error.message) ? "The model router timed out; the provider default was used." : "The model router failed; the provider default was used.";
      return {
        ...(requestedEffort ? { effort: requestedEffort } : {}),
        info: { source: "default", reason }
      };
    } finally {
      clearTimeout(timer);
      removeAbort?.();
    }
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
    const route = this.routedTasks.get(args.sessionId as string);
    if (route) route.attempt += 1;
    this.scheduleRouteWatch(args.sessionId as string);
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
    this.publishResult(args.sessionId as string, result);
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

  private publishResult(sessionId: string, result: AgentResult, waitReason?: string): void {
    const route = this.routedTasks.get(sessionId);
    if (!route) return;
    if (result.review) {
      const reviewKey = `${sessionId}:${route.attempt}:${result.review.reviewerSessionId ?? result.review.status}`;
      if (!this.reviewCallbacksSent.has(reviewKey)) {
        this.reviewCallbacksSent.add(reviewKey);
        try { this.integrations.onReview?.(sessionId, result.review); } catch { /* a plugin observer cannot affect results */ }
      }
    }
    let status: "failed" | "accepted" | "rejected" | "rework" | undefined;
    if (result.state === "failed" || waitReason === "quiet") status = "failed";
    else if (result.review?.status === "accepted") status = "accepted";
    else if (result.review?.status === "rejected") status = "rejected";
    else if (result.review?.status === "revise") status = "rework";
    else if (!route.review && (result.state === "done" || result.status === "idle")) status = "accepted";
    if (!status) return;
    const key = `${sessionId}:${route.attempt}:${status}:${result.review?.reviewerSessionId ?? "worker"}`;
    if (this.outcomeCallbacksSent.has(key)) return;
    this.outcomeCallbacksSent.add(key);
    try { this.integrations.onRouteOutcome?.(sessionId, { parentSessionId: route.parentSessionId, task: route.task, status }); }
    catch { /* a plugin observer cannot affect results */ }
  }

  private scheduleRouteWatch(sessionId: string): void {
    if (!this.routedTasks.has(sessionId) || this.routeWatchers.has(sessionId)) return;
    const controller = new AbortController();
    let watcher: { controller: AbortController; promise: Promise<void> };
    const promise = (async () => {
      for (;;) {
        if (controller.signal.aborted) return;
        let session;
        try { session = this.control.status(sessionId); } catch { return; }
        if (session.exitCode !== null) {
          const final = await this.control.resultWithReview(sessionId);
          this.publishResult(sessionId, final, session.exitCode === 0 ? "done" : "failed");
          return;
        }
        const waited = await this.control.waitFor(sessionId, {
          timeoutMs: MAX_AGENT_WAIT_SECONDS * 1_000,
          signal: controller.signal
        }).catch(() => null);
        if (!waited || waited.reason === "closed") return;
        if (waited.reason === "timeout" || waited.reason === "needs_approval") {
          await new Promise((resolve) => setTimeout(resolve, waited.reason === "timeout" ? 0 : 1_000));
          continue;
        }
        const final = await this.control.resultWithReview(sessionId);
        this.publishResult(sessionId, final, waited.reason);
        return;
      }
    })().catch(() => undefined).finally(() => {
      if (this.routeWatchers.get(sessionId) === watcher) this.routeWatchers.delete(sessionId);
    });
    watcher = { controller, promise };
    this.routeWatchers.set(sessionId, watcher);
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
