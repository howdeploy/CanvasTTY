import type {
  AgentProviderId,
  CreateSessionRequest,
  LaunchProfileId,
  SessionEnvironmentChoice,
  SessionMetadata,
  SessionSnapshot
} from "../../shared/contracts.ts";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { PROVIDER_CAPABILITIES } from "../../shared/contracts.ts";
import { isLaunchProfile, PROFILE_RANK, profileAvailable, profileCeiling, type LaunchProfile } from "../../shared/autoMode.ts";
import { isPathInside } from "../../agent-runtime/path-inside.mjs";
import type { TerminalManager } from "./TerminalManager.ts";
import { onDiskPath, otherSpellings } from "./onDiskPath.ts";
import { LaunchRefusal } from "./launchRefusal.ts";
import { terminalFailureDetails } from "./terminalFailureDetails.ts";
import { RESULT_CAPTURE_PROVIDERS } from "./resultCapture.ts";
import { ACCOUNTS_PLUGIN_ID, selectedAccountId } from "./accountHomeIsolation.ts";
import type { OrchestrationBudgetService } from "./OrchestrationBudgetService.ts";
import { createDiffOnlyReviewWorkspace, type DiffOnlyReviewWorkspace } from "./DiffOnlyReviewWorkspace.ts";

// Cards one parent may have in total, live or exited (the live limit is the person's setting).
const MAX_CHILDREN_PER_PARENT = 16;
/** Defaults of the person's limits (Settings → Agents). */
export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = { maxDepth: 2, maxSubagents: 8 };

export interface DelegationLimits {
  /** Levels of subagents below a top-level orchestrator (its children are level 1). */
  maxDepth: number;
  /** Live subagents below one top-level orchestrator, all levels together. */
  maxSubagents: number;
}
const MAX_OBSERVE_CHARS = 8_192;
// An exited agent's reason is in its last screen lines (OpenCode: "Error: Unexpected server error" for an unknown model).
const MAX_EXIT_WINDOW_CHARS = 16_384;
const MAX_EXIT_LINES = 20;
const CHILD_POSITION_STEP = { x: 60, y: 60 };
const MAX_RETRY_COUNT = 2;
const MAX_RETRY_OUTPUT_BYTES = 4 * 1024;
const MAX_RETRY_OUTPUT_WINDOW_CHARS = 16 * 1024;
const MAX_REVIEW_DIFF_BYTES = 64 * 1024;
const MAX_REVIEW_ANSWER_CHARS = 16 * 1024;
const REVIEW_TIMEOUT_MS = 180_000;
const REVIEW_STARTUP_QUIET_MS = 90_000;

export interface SpawnAgentRequest {
  parentSessionId: string;
  provider: AgentProviderId;
  cwd: string;
  profile?: LaunchProfileId;
  title?: string;
  /** Prompt written into the new agent's PTY once its launch has started (after its plugins prepared it). */
  initialPrompt?: string;
  /** Plugin launch options, checked by the launch exactly like the launcher's. */
  launchOptions?: CreateSessionRequest["launchOptions"];
  /** The CLI's --model and reasoning effort for this subagent (checked by the launch for its CLI). */
  model?: string;
  effort?: CreateSessionRequest["effort"];
  review?: boolean;
  /** Optional known model reserved for this worker's read-only reviewer. */
  reviewModel?: string;
  isolate?: "worktree";
  /** Internal-only role: suppresses all agent/plugin tools for a Plan-profile reviewer. */
  readOnlyReview?: boolean;
}

export interface AgentObservation {
  sessionId: string;
  status: SessionSnapshot["status"];
  loopDetected?: boolean;
  /** Raw terminal tail, capped; capabilities with result \"none\" see nothing. */
  output: string;
  /** Once the process exited: its exit code and the last lines of its screen as plain text, masked. */
  exitCode?: number | null;
  exitLines?: string;
}

/** Why waitFor returned. "done"/"failed": the process exited (exit code 0 or not); "quiet": the provider reports no
 *  status and its screen stopped changing; "closed": its card is gone. */
export type AgentWaitReason = "idle" | "needs_approval" | "done" | "failed" | "quiet" | "closed" | "timeout";

export interface AgentWaitResult {
  sessionId: string;
  reason: AgentWaitReason;
  /** The session's status as the wait ended; absent once its card is gone. */
  status?: SessionSnapshot["status"];
  exitCode: number | null;
  waitedMs: number;
  /** Masked terminal tail (masked before the cut). */
  output: string;
  /** Once the process exited: the last lines of its screen as plain text, masked (why it stopped, e.g. a bad model). */
  exitLines?: string;
  /** The final answer of the turn that ended (Codex, OpenCode subagents), masked. */
  answer?: AgentAnswer;
  /** Present when spawn_agent requested a read-only second-agent review. */
  review?: AgentReviewResult;
}

export interface AgentWaitTiming {
  /** How often a waiting call reads the session again. */
  checkMs: number;
  /** How long the screen must stay the same before an idle status counts (a CLI may still be drawing its answer). */
  settleMs: number;
  /** How long a session without status must show the same screen before it counts as "quiet". */
  quietMs: number;
}

export interface AgentControlOptions {
  /** waitFor timing; tests shorten it. */
  waitTiming?: AgentWaitTiming;
  /** The person's delegation limits (Settings → Agents), read at every spawn. */
  limits?: () => DelegationLimits;
  /** CanvasTTY's isolation layer can contain an agent on this computer now (a "contained" auto needs it). */
  containment?: () => boolean;
  /** Current host-owned provider turn epoch; loop warnings expire as soon as the turn changes. */
  currentTurnEpoch?: (sessionId: string) => number | null;
  /** Persistent task budgets. Only usage from a real provider/timeline source is counted. */
  budget?: Pick<OrchestrationBudgetService, "snapshot">;
  /** Resolves an explicit or automatic subagent environment using the already trusted environments plugin. */
  resolveSubagentEnvironment?: (request: {
    provider: AgentProviderId;
    parentSessionId: string;
    projectRoot: string;
    cwd: string;
    liveChildren: number;
    isolate?: "worktree";
  }) => SessionEnvironmentChoice | null | Promise<SessionEnvironmentChoice | null>;
  /** Returns a known model different from the worker's model. Null means a safe alternative is unavailable. */
  reviewModel?: (provider: AgentProviderId, workerModel: string | undefined) => string | null;
  /** Actual CLI model metadata/configuration, used when the worker kept its CLI default. */
  workerModel?: (session:SessionMetadata) => string | null | Promise<string|null>;
  reviewCost?: (reviewerSessionId:string) => number|null;
  /** Trusted host override: the returned diff must already be scoped to this worker and its launch. */
  reviewDiff?: (session: SessionMetadata) => Promise<string>;
  reviewTimeoutMs?: number;
  /** How long an OpenCode reviewer may take to expose its input prompt before startup is refused. */
  reviewStartupMs?: number;
  onReview?: (sessionId: string, review: AgentReviewResult) => void;
}

/** The longest wait one call may ask for (wait_for_agent's timeoutSeconds maximum). */
export const MAX_AGENT_WAIT_MS = 600_000;
const AGENT_WAIT_TIMING: AgentWaitTiming = { checkMs: 500, settleMs: 1_000, quietMs: 10_000 };

export interface AgentResult {
  sessionId: string;
  state: "running" | "done" | "failed";
  /** The session's status (idle once its turn ended; state stays "running" while the CLI is open). */
  status: SessionSnapshot["status"];
  exitCode: number | null;
  output: string;
  /** Once the process exited: the last lines of its screen as plain text, masked. */
  exitLines?: string;
  /** The last turn's final answer as the agent reported it (Codex, OpenCode subagents), masked; absent otherwise. */
  answer?: AgentAnswer;
  /** Present when spawn_agent requested a read-only second-agent review. */
  review?: AgentReviewResult;
}

export interface AgentReviewResult {
  status: "pending" | "accepted" | "revise" | "rejected" | "unavailable";
  verdict?: "accept" | "revise" | "reject";
  notes?: string;
  reason?: string;
  reviewerSessionId?: string;
  model?: string;
  /** F-15 usage integrations can replace null when the provider reports a separate review cost. */
  costUsd: number | null;
}

export interface AgentAnswer {
  text: string;
  /** Only the end of a longer answer was kept. */
  truncated: boolean;
}

/** The agent's launch did not start, so text meant for it was dropped (never queued for a later launch). */
export class PromptNotDeliveredError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, message: string) {
    super(message);
    this.name = "PromptNotDeliveredError";
    this.sessionId = sessionId;
  }
}

export class AgentControlService {
  private readonly loopWarnings = new Map<string,{at:number;turnEpoch:number}>();
  private readonly terminals: TerminalManager;
  private readonly options: AgentControlOptions;
  private readonly launchRequests = new Map<string, SpawnAgentRequest>();
  private readonly retryOrigins = new Map<string, string>();
  private readonly retryCounts = new Map<string, number>();
  private readonly pendingRetries = new Map<string, number>();
  private readonly retryableQuiet = new Set<string>();
  private readonly reviewRequested = new Set<string>();
  private readonly readOnlyReviewers = new Set<string>();
  private readonly reviews = new Map<string, AgentReviewResult>();
  private readonly reviewGenerations = new Map<string, object>();
  private readonly reviewInputObservers = new Map<string, () => void>();
  private readonly reviewPending = new Map<string, Promise<AgentReviewResult>>();
  private readonly reviewControllers = new Map<string, AbortController>();
  private readonly reviewAgents = new Map<string, string>();
  private readonly reviewWatchers = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  constructor(terminals: TerminalManager, options: AgentControlOptions = {}) {
    this.terminals = terminals;
    this.options = options;
  }

  /**
   * Creates the subagent card. With an initial prompt it resolves only once the prompt reached the agent's PTY
   * (after an asynchronous launch has started) and rejects with PromptNotDeliveredError when that launch did not
   * start; the card stays, so the caller can inspect or cancel it.
   */
  spawn(request: SpawnAgentRequest, signal?: AbortSignal): Promise<SessionMetadata> {
    if (!request || typeof request.parentSessionId !== "string") {
      throw new Error("A parent session id is required.");
    }
    const parent = this.requireSession(request.parentSessionId);
    const capabilities = PROVIDER_CAPABILITIES[request.provider];
    if (!capabilities) throw new Error("Unknown agent provider.");
    if (!capabilities.send) throw new Error(`${request.provider} cannot receive prompts.`);
    const account = this.subagentAccount(parent.id, request.provider, request.launchOptions);
    if (account.launchOptions !== request.launchOptions) request = { ...request, launchOptions: account.launchOptions };

    const taskScope = this.taskRoot(parent.id);
    // What the request asks for first (its folder, its profile), then the person's limits.
    const cwd = subagentFolder(taskScope.cwd, parent.cwd, request.cwd);
    if ("error" in cwd) throw new DelegationRefusal(cwd.error);
    this.requireBudgetActive(parent.id);
    const profile = subagentProfile(parent.profile, request.provider, request.profile, this.containment());
    if ("error" in profile) throw new DelegationRefusal(profile.error);
    const { live } = this.assertSpawnCapacity(parent.id);
    const resolveEnvironment = this.options.resolveSubagentEnvironment;
    if (!resolveEnvironment) {
      if (request.isolate === "worktree") throw new DelegationRefusal("The environments plugin does not provide a worktree for this launch.");
      return this.createSubagent(parent, request, cwd.cwd, profile.profile, null, signal);
    }
    let environment: SessionEnvironmentChoice | null | Promise<SessionEnvironmentChoice | null>;
    try {
      environment = resolveEnvironment({
          provider: request.provider,
          parentSessionId: parent.id,
          projectRoot: taskScope.cwd,
          cwd: cwd.cwd,
          liveChildren: live,
          ...(request.isolate ? { isolate: request.isolate } : {})
        });
    } catch (error) {
      throw new DelegationRefusal(`The environments plugin could not prepare this subagent: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (environment && typeof (environment as Promise<SessionEnvironmentChoice | null>).then === "function") {
      return Promise.resolve(environment).then(
        (choice) => this.createSubagent(parent, request, cwd.cwd, profile.profile, choice, signal),
        (error: unknown) => { throw new DelegationRefusal(`The environments plugin could not prepare this subagent: ${error instanceof Error ? error.message : "unknown error"}`); }
      );
    }
    return this.createSubagent(parent, request, cwd.cwd, profile.profile, environment as SessionEnvironmentChoice | null, signal);
  }

  private createSubagent(
    parent: SessionMetadata,
    request: SpawnAgentRequest,
    cwd: string,
    profile: LaunchProfile,
    environment: SessionEnvironmentChoice | null,
    signal?: AbortSignal
  ): Promise<SessionMetadata> {
    if (request.isolate === "worktree" && !environment) {
      throw new DelegationRefusal("The environments plugin does not provide a worktree for this launch.");
    }
    // A call cancelled before its agent starts launches nothing.
    if (signal?.aborted) return Promise.reject(spawnCanceled());
    // An asynchronous environment lookup may race another spawn or a human budget change.
    // Recheck immediately before synchronous card creation, which reserves the live slot.
    this.requireSession(parent.id);
    this.requireBudgetActive(parent.id);
    const { childrenCount } = this.assertSpawnCapacity(parent.id);
    const cascade = childrenCount;
    const created = this.terminals.create({
      provider: request.provider,
      cwd,
      profile,
      position: {
        x: parent.position.x + CHILD_POSITION_STEP.x * (cascade + 1),
        y: parent.position.y + CHILD_POSITION_STEP.y * (cascade + 1)
      },
      ...(request.title !== undefined ? { title: request.title } : {}),
      role: "subagent",
      parentSessionId: parent.id,
      ...(environment ? { environment } : {}),
      ...(request.launchOptions !== undefined ? { launchOptions: request.launchOptions } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {})
    }, { ...(RESULT_CAPTURE_PROVIDERS.has(request.provider) ? { captureResult: true } : {}), origin: "subagent", captureReviewDiff: request.review === true });
    this.launchRequests.set(created.id, { ...request, cwd, profile });
    this.retryOrigins.set(created.id, created.id);
    if (request.review === true) this.trackReview(created.id);
    if (request.readOnlyReview === true) this.readOnlyReviewers.add(created.id);
    if (request.initialPrompt === undefined || request.initialPrompt.length === 0) return Promise.resolve(created);
    return this.deliver(created.id, `${request.initialPrompt}\r`, "prompt", signal)
      .then(() => {
        this.scheduleReview(created.id);
        return this.terminals.getMetadata(created.id) ?? created;
      }, (error: unknown) => {
        // Cancelled while it started: nobody receives its id, so the card is closed instead of left running.
        if (!signal?.aborted) throw error;
        try { this.terminals.dispose(created.id); } catch { /* it already ended */ }
        throw spawnCanceled();
      });
  }

  /**
   * Which model account a subagent of this parent runs on. A spawn that names no account inherits the orchestrator's
   * own: it never falls back silently to the CLI's default model (for OpenCode that is OpenCode Zen, a third party).
   * Naming one is explicit: "none" runs on the CLI's own sign-in, another account needs the plugin's delegable
   * declaration (checked by the launch). An orchestrator without an account keeps the request as it is.
   */
  subagentAccount(parentSessionId: string, provider: AgentProviderId, requested: SpawnAgentRequest["launchOptions"]): {
    launchOptions: SpawnAgentRequest["launchOptions"];
    account: string | null;
    source: "inherited" | "explicit" | "none";
  } {
    const parent = this.requireSession(parentSessionId);
    const named = requested?.[ACCOUNTS_PLUGIN_ID];
    if (named !== undefined) {
      const account = selectedAccountId(requested);
      return { launchOptions: requested, account: account === "default" ? null : account, source: "explicit" };
    }
    const parentAccount = typeof this.terminals.modelAccountOf === "function" ? this.terminals.modelAccountOf(parent.id) : undefined;
    if (!parentAccount) return { launchOptions: requested, account: null, source: "none" };
    if (parent.provider !== provider) {
      throw new DelegationRefusal(`This orchestrator runs on model account ${parentAccount.slice(0, 40)} for ${parent.provider}; a ${provider} subagent cannot inherit it. `
        + `Pass launchOptions {"${ACCOUNTS_PLUGIN_ID}":{"account":"<id>"}} with a ${provider} account (list_accounts / pick_account), or {"account":"none"} to run it on ${provider}'s own sign-in and default model.`);
    }
    return { launchOptions: { ...(requested ?? {}), [ACCOUNTS_PLUGIN_ID]: { account: parentAccount } }, account: parentAccount, source: "inherited" };
  }

  /** The profile a subagent of this parent gets for this request (what spawn will use), or why it gets none. */
  profileFor(parentSessionId: string, provider: AgentProviderId, requested?: unknown): { profile: LaunchProfile; inherited: boolean } | { error: string } {
    return subagentProfile(this.requireSession(parentSessionId).profile, provider, requested, this.containment());
  }

  /** Validates at once (throws); resolves once the text reached the agent, and rejects when it did not. */
  send(sessionId: string, text: string, submit = true, signal?: AbortSignal): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities.send) throw new Error(`${session.provider} cannot receive prompts.`);
    if (typeof text !== "string" || text.length === 0) throw new Error("Prompt text is required.");
    if (session.exitCode !== null) throw new Error("Agent session has already exited.");
    this.assertInputAllowed(sessionId);
    return this.deliver(sessionId, submit ? `${text}\r` : text, "text", signal);
  }

  status(sessionId: string): SessionMetadata {
    return this.requireSession(sessionId);
  }

  children(parentSessionId: string): SessionMetadata[] {
    this.requireSession(parentSessionId);
    return this.terminals.listMetadata()
      .filter((session) => session.parentSessionId === parentSessionId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The session, its parent, and so on up to the agent the person started (last). */
  lineage(sessionId: string): SessionMetadata[] {
    const byId = new Map(this.terminals.listMetadata().map((session) => [session.id, session]));
    const chain: SessionMetadata[] = [];
    for (let current = byId.get(sessionId); current && chain.length < 64; current = current.parentSessionId ? byId.get(current.parentSessionId) : undefined) {
      if (chain.includes(current)) break;
      chain.push(current);
    }
    if (chain.length === 0) throw new Error("Terminal session does not exist.");
    return chain;
  }

  /** The top-level orchestrator and project folder governing this session's shared task scope. */
  taskRoot(sessionId: string): { id: string; cwd: string; startedAt: number } {
    const root = this.lineage(sessionId).at(-1)!;
    const taskScope = root.taskScope;
    return taskScope ? { ...taskScope } : { id: root.id, cwd: root.cwd, startedAt: root.startedAt };
  }

  /** Resolve every card against one host snapshot, sharing parent traversal and preserving continuation scopes. */
  taskRoots(sessions: readonly SessionMetadata[]): Map<string, { id: string; cwd: string; startedAt: number }> {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const resolved = new Map<string, { id: string; cwd: string; startedAt: number }>();
    const visiting = new Set<string>();
    const resolveTaskRoot = (sessionId: string): { id: string; cwd: string; startedAt: number } | null => {
      const cached = resolved.get(sessionId);
      if (cached) return cached;
      const session = byId.get(sessionId);
      if (!session || visiting.has(sessionId)) return null;
      visiting.add(sessionId);
      const scope = (session.parentSessionId ? resolveTaskRoot(session.parentSessionId) : null)
        ?? session.taskScope
        ?? { id: session.id, cwd: session.cwd, startedAt: session.startedAt };
      visiting.delete(sessionId);
      resolved.set(sessionId, scope);
      return scope;
    };
    for (const session of sessions) resolveTaskRoot(session.id);
    return resolved;
  }

  /** Called when TerminalManager removes a card; retries belonging to a live replacement retain their shared count. */
  forgetSession(sessionId: string): void {
    this.loopWarnings.delete(sessionId);
    this.reviewInputObservers.get(sessionId)?.();
    this.reviewInputObservers.delete(sessionId);
    this.invalidateReview(sessionId);
    this.reviewGenerations.delete(sessionId);
    this.launchRequests.delete(sessionId);
    this.retryableQuiet.delete(sessionId);
    this.reviewRequested.delete(sessionId);
    this.readOnlyReviewers.delete(sessionId);
    this.reviews.delete(sessionId);

    const sourceId = this.retryOrigins.get(sessionId) ?? sessionId;
    this.retryOrigins.delete(sessionId);
    if (!this.pendingRetries.has(sourceId) && ![...this.retryOrigins.values()].includes(sourceId)) this.retryCounts.delete(sourceId);

    for (const [workerId, workerReviewerId] of this.reviewAgents) {
      if (workerReviewerId !== sessionId) continue;
      this.reviewAgents.delete(workerId);
    }
  }

  /** Apply the terminal manager's existing secret masks to host-only task context before it leaves the core. */
  maskText(text: string, maxChars: number): string {
    return this.redactTail(text, Math.max(0, Math.min(65_536, maxChars)));
  }

  /** Every card below this one, at any depth. */
  descendants(sessionId: string): SessionMetadata[] {
    const all = this.terminals.listMetadata();
    const found: SessionMetadata[] = [];
    const queue = [sessionId];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const session of all) {
        if (session.parentSessionId !== id || seen.has(session.id)) continue;
        seen.add(session.id);
        found.push(session);
        queue.push(session.id);
      }
    }
    return found;
  }

  private limits(): DelegationLimits {
    try {
      const limits = this.options.limits?.();
      if (limits && Number.isInteger(limits.maxDepth) && Number.isInteger(limits.maxSubagents)) return limits;
    } catch { /* the defaults */ }
    return DEFAULT_DELEGATION_LIMITS;
  }

  private assertSpawnCapacity(parentSessionId: string, replacingSessionId?: string): { live: number; childrenCount: number } {
    const childrenCount = this.children(parentSessionId).filter(session => session.id !== replacingSessionId).length;
    if (childrenCount >= MAX_CHILDREN_PER_PARENT) {
      throw new DelegationRefusal(`Session ${parentSessionId} already has ${MAX_CHILDREN_PER_PARENT} subagent cards; cancel_agent the finished ones first.`);
    }
    const lineage = this.lineage(parentSessionId);
    const limits = this.limits();
    if (lineage.length > limits.maxDepth) {
      throw new DelegationRefusal(`Subagents may nest at most ${limits.maxDepth} level${limits.maxDepth === 1 ? "" : "s"} deep below the agent the person started; this one would be level ${lineage.length}. The person sets this limit in Settings → Agents.`);
    }
    const live = this.descendants(lineage.at(-1)!.id)
      .filter(session => session.id !== replacingSessionId && session.exitCode === null).length;
    if (live >= limits.maxSubagents) {
      throw new DelegationRefusal(`This orchestration already runs ${live} live subagent${live === 1 ? "" : "s"}, its limit (Settings → Agents, set by the person). Wait for one to finish or cancel_agent one first.`);
    }
    return { live, childrenCount };
  }

  private containment(): boolean {
    try { return this.options.containment?.() === true; } catch { return false; }
  }

  /** True when sessionId is parentSessionId itself or any of its descendants. */
  isInSubtree(parentSessionId: string, sessionId: string): boolean {
    if (typeof parentSessionId !== "string" || typeof sessionId !== "string") return false;
    const snapshots = new Map(this.terminals.listMetadata().map((session) => [session.id, session]));
    let current: string | undefined = sessionId;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (current === parentSessionId) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = snapshots.get(current)?.parentSessionId;
    }
    return false;
  }

  observe(sessionId: string, maxChars = MAX_OBSERVE_CHARS): AgentObservation {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities.observe) throw new Error(`${session.provider} cannot be observed.`);
    const buffer = this.terminals.readBuffer(sessionId).buffer;
    const exitLines = session.exitCode === null ? null : this.exitLines(buffer);
    return {
      sessionId: session.id,
      status: session.status,
      ...(this.hasCurrentLoopWarning(sessionId) ? {loopDetected:true} : {}),
      // Masked before the cut (a cut inside a secret would leave a tail no pattern recognizes), over a window
      // wider than any match rather than the whole scrollback.
      output: this.redactTail(buffer, maxChars),
      ...(session.exitCode === null ? {} : { exitCode: session.exitCode }),
      ...(exitLines ? { exitLines } : {})
    };
  }

  result(sessionId: string): AgentResult {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (capabilities.result === "none") {
      return { sessionId: session.id, state: "running", status: session.status, exitCode: session.exitCode, output: "" };
    }
    const answer = this.answer(sessionId);
    const buffer = capabilities.result === "terminal"
      ? this.terminals.readBuffer(sessionId).buffer
      : "";
    return {
      sessionId: session.id,
      state: session.exitCode === null
        ? "running"
        : session.exitCode === 0 ? "done" : "failed",
      status: session.status,
      exitCode: session.exitCode,
      output: this.redactTail(buffer, MAX_OBSERVE_CHARS),
      ...(session.exitCode !== null && this.exitLines(buffer) ? { exitLines: this.exitLines(buffer)! } : {}),
      ...(answer ? { answer } : {})
    };
  }

  /** Gets a result with its review; tool calls defer unfinished reviews to stay within client deadlines. */
  async resultWithReview(sessionId: string, options: { deferReview?: boolean } = {}): Promise<AgentResult> {
    const current = this.result(sessionId);
    if (!this.reviewRequested.has(sessionId)) return current;
    const status = this.resultLifecycleStatus(sessionId) ?? current.status;
    if (status !== "idle" && status !== "done" && status !== "failed" && current.exitCode === null) {
      return { ...current, review: this.reviewWithCost(this.reviews.get(sessionId) ?? { status: "pending", costUsd: null }) };
    }
    if (options.deferReview) {
      void this.ensureReview(sessionId);
      return { ...current, review: this.reviewWithCost(this.reviews.get(sessionId) ?? { status: "pending", costUsd: null }) };
    }
    const generation = this.reviewGeneration(sessionId);
    const review = await this.ensureReview(sessionId);
    return { ...this.result(sessionId), review: this.reviewWithCost(
      this.reviewGenerations.get(sessionId) === generation ? review : supersededReview()) };
  }

  private reviewWithCost(review:AgentReviewResult):AgentReviewResult{
    try{
      const cost=review.reviewerSessionId ? this.options.reviewCost?.(review.reviewerSessionId) : null;
      return typeof cost==="number" && Number.isFinite(cost) && cost>=0 ? {...review,costUsd:cost} : review;
    }catch{return review;}
  }

  /** Host-only signal from the trusted loop detector; it never stops a process itself. */
  markLoopDetected(sessionId:string):boolean {
    const session=this.requireSession(sessionId);
    if(session.role!=="subagent" || session.exitCode!==null)return false;
    const turnEpoch=this.options.currentTurnEpoch?.(sessionId);
    if(typeof turnEpoch!=="number" || !Number.isSafeInteger(turnEpoch) || turnEpoch<=0)return false;
    this.loopWarnings.set(sessionId,{at:Date.now(),turnEpoch});
    return true;
  }

  /** Current host loop warning, shared by retry eligibility and companion attention. */
  hasCurrentLoopWarning(sessionId:string):boolean {
    const warning=this.loopWarnings.get(sessionId);
    if(!warning)return false;
    const age=Date.now()-warning.at;
    if(!Number.isFinite(age) || age<0 || age>60_000)return false;
    return this.options.currentTurnEpoch?.(sessionId)===warning.turnEpoch;
  }

  /** Retry is restricted to a failed, observed quiet or recently looping agent. */
  async retry(sessionId: string, reason?: string, signal?: AbortSignal): Promise<SessionMetadata> {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities?.send) throw new Error(`${session.provider} cannot receive prompts.`);
    const hasWorktreeBadge = session.environment?.kind === "worktree";
    const pluginContext = hasWorktreeBadge ? this.terminals.pluginContext(sessionId) : null;
    if (hasWorktreeBadge && pluginContext?.environment?.kind !== "worktree") {
      throw new DelegationRefusal("The agent's worktree environment is unavailable; its retry was not started locally.");
    }
    const failed = (session.exitCode !== null && session.exitCode !== 0) || session.status === "failed";
    if (!failed && !this.retryableQuiet.has(sessionId) && !this.hasCurrentLoopWarning(sessionId)) {
      throw new DelegationRefusal("retry_agent works only for a failed or quiet subagent; a running agent must finish or be canceled first.");
    }
    const sourceId = this.retryOrigins.get(sessionId) ?? sessionId;
    if (this.pendingRetries.has(sourceId)) throw new DelegationRefusal("A retry of this agent is already in progress.");
    const count = this.retryCounts.get(sourceId) ?? 0;
    if (count >= MAX_RETRY_COUNT) throw new DelegationRefusal(`This agent has already used its limit of ${MAX_RETRY_COUNT} retries.`);
    const original = this.launchRequests.get(sessionId) ?? this.launchRequests.get(sourceId);
    if (!original) throw new DelegationRefusal("CanvasTTY no longer has the original launch request for this agent, so it cannot retry it safely.");
    const raw = this.terminals.readBuffer(sessionId).buffer;
    const output = utf8Tail(this.redactTail(raw, MAX_RETRY_OUTPUT_WINDOW_CHARS), MAX_RETRY_OUTPUT_BYTES);
    const failureReason = (typeof reason === "string" && reason.trim().slice(0, 500))
      || session.failureDetails
      || (session.exitCode !== null ? `process exited with code ${session.exitCode}` : "the agent stopped producing output");
    const context = [
      "\n\nCanvasTTY retry context:",
      `Failure reason: ${this.redactTail(failureReason, 500)}`,
      output ? `Masked output tail (up to ${MAX_RETRY_OUTPUT_BYTES} UTF-8 bytes):\n${output}` : "No terminal output was available."
    ].join("\n");
    const retryPrompt = `${original.initialPrompt ?? ""}${context}`;
    // Reserve synchronously: concurrent tool calls must share the same finite allowance.
    this.retryCounts.set(sourceId, count + 1);
    this.pendingRetries.set(sourceId, (this.pendingRetries.get(sourceId) ?? 0) + 1);
    try {
      if (signal?.aborted) throw spawnCanceled();
      const parentId = session.parentSessionId ?? original.parentSessionId;
      const validate = (): void => {
        const parent = this.requireSession(parentId);
        const taskScope = this.taskRoot(parentId);
        const cwd = subagentFolder(taskScope.cwd, parent.cwd, hasWorktreeBadge ? original.cwd : session.cwd);
        if ("error" in cwd) throw new DelegationRefusal(cwd.error);
        const profile = this.profileFor(parentId, session.provider as AgentProviderId, session.profile);
        if ("error" in profile) throw new DelegationRefusal(profile.error);
        if (profile.profile !== session.profile) throw new DelegationRefusal("The original launch profile is no longer allowed; choose a new agent with an allowed profile.");
        this.requireBudgetActive(parentId);
        // This replaces the same card, and the manager waits for its old PTY to exit before starting a successor.
        this.assertSpawnCapacity(parentId, sessionId);
      };
      validate();
      const retried = await this.terminals.retryAgentLaunch(sessionId, retryPrompt, validate, signal, () => this.invalidateReview(sessionId));
      this.loopWarnings.delete(sessionId);
      this.retryableQuiet.delete(sessionId);
      this.scheduleReview(sessionId);
      this.retryOrigins.set(retried.id, sourceId);
      // Each attempt starts from the original request, with only this attempt's masked failure context appended.
      this.launchRequests.set(retried.id, original);
      if (original.review === true) this.trackReview(retried.id);
      return retried;
    } catch (error) {
      this.retryCounts.set(sourceId, Math.max(0, (this.retryCounts.get(sourceId) ?? 1) - 1));
      throw error;
    } finally {
      const pending = (this.pendingRetries.get(sourceId) ?? 1) - 1;
      if (pending > 0) this.pendingRetries.set(sourceId, pending);
      else {
        this.pendingRetries.delete(sourceId);
        if (![...this.retryOrigins.values()].includes(sourceId)) this.retryCounts.delete(sourceId);
      }
    }
  }

  taskBudget(sessionId: string): ReturnType<OrchestrationBudgetService["snapshot"]> | null {
    if (!this.options.budget) return null;
    const root = this.taskRoot(sessionId);
    return this.options.budget.snapshot(root.id, root.startedAt);
  }

  isReadOnlyReviewer(sessionId: string): boolean {
    return this.readOnlyReviewers.has(sessionId);
  }

  /** App-level PTY input gate. A hard task pause blocks input without signaling or killing any process. */
  assertInputAllowed(sessionId: string): void {
    this.requireSession(sessionId);
    this.requireBudgetActive(sessionId);
  }

  /**
   * Waits until the agent is at rest (idle, needs_approval, exited, or quiet when it reports no status), its card
   * closed, or the timeout passed. Only reads metadata and the output offset while it waits; the tail is read and
   * masked once, as it returns. Rejects with an AbortError once `signal` aborts.
   */
  async waitFor(sessionId: string, request: { timeoutMs: number; signal?: AbortSignal; quietMs?: number; deferReview?: boolean }): Promise<AgentWaitResult> {
    const { signal } = request;
    signal?.throwIfAborted();
    const first = this.requireSession(sessionId);
    if (first.provider === "terminal") throw new Error("Plain terminals are not agents.");
    if (typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs)) throw new Error("A wait timeout is required.");
    const base = this.options.waitTiming ?? AGENT_WAIT_TIMING;
    const timing = request.quietMs !== undefined ? { ...base, quietMs: Math.max(base.quietMs, request.quietMs) } : base;
    const timeoutMs = Math.min(MAX_AGENT_WAIT_MS, Math.max(0, request.timeoutMs));
    const started = Date.now();
    const answer = async (session: SessionMetadata | null, reason: AgentWaitReason): Promise<AgentWaitResult> => {
      const waitedMs = Date.now() - started;
      if (!session) return { sessionId, reason, exitCode: null, waitedMs, output: "" };
      if (reason === "quiet") this.retryableQuiet.add(sessionId);
      else if (reason === "idle" || reason === "done" || reason === "failed") this.retryableQuiet.delete(sessionId);
      let observation: AgentObservation | null = null;
      try { observation = this.observe(sessionId); } catch { observation = null; }
      const finalAnswer: AgentAnswer | null = reason === "timeout" || reason === "needs_approval" ? null : this.answer(sessionId);
      let review: AgentReviewResult | undefined;
      const generation = this.reviewGeneration(sessionId);
      if (this.reviewRequested.has(sessionId) && (reason === "idle" || reason === "done" || reason === "failed" || reason === "quiet")) {
        if (request.deferReview) {
          const readiness = this.reviewReadiness(sessionId, reason === "quiet");
          if (!readiness) void this.ensureReview(sessionId, reason === "quiet");
          review = this.reviewWithCost(readiness ?? this.reviews.get(sessionId) ?? { status: "pending", costUsd: null });
        } else {
          const result = await this.ensureReview(sessionId, reason === "quiet");
          review = this.reviewWithCost(this.reviewGenerations.get(sessionId) === generation ? result : supersededReview());
        }
      }
      return { sessionId, reason, status: session.status, exitCode: session.exitCode, waitedMs, output: observation?.output ?? "",
        ...(observation?.exitLines ? { exitLines: observation.exitLines } : {}), ...(finalAnswer ? { answer: finalAnswer } : {}), ...(review ? { review } : {}) };
    };
    let offset = this.outputOffset(sessionId);
    let changedAt = started;
    for (;;) {
      const session = this.terminals.getMetadata(sessionId);
      if (!session) return answer(null, "closed");
      const now = Date.now();
      const current = this.outputOffset(sessionId);
      if (current !== offset) { offset = current; changedAt = now; }
      const quietFor = now - changedAt;
      if (session.exitCode !== null) return answer(session, session.exitCode === 0 ? "done" : "failed");
      const status = this.resultLifecycleStatus(sessionId) ?? session.status;
      if (status === "needs_approval") return answer(session, "needs_approval");
      // After a prompt, an idle that no turn followed (the CLI's startup idle, or one reported before the turn began)
      // is not the answer: only an idle after a turn that started since that prompt is. A CLI that never reports its
      // turns still ends as "quiet" once its screen stops changing.
      const progress = this.turnProgress(sessionId);
      const awaitingTurn = progress !== null && progress.promptSent && !progress.turnStartedSincePrompt;
      if (!awaitingTurn && (status === "idle" || status === "done" || status === "failed") && quietFor >= timing.settleMs) {
        return answer(session, status);
      }
      if ((status === "unavailable" || awaitingTurn) && quietFor >= timing.quietMs) return answer(session, "quiet");
      const waited = now - started;
      if (waited >= timeoutMs) return answer(session, "timeout");
      await pause(Math.min(timing.checkMs, timeoutMs - waited), signal);
    }
  }

  cancel(sessionId: string): void {
    this.requireSession(sessionId);
    this.terminals.dispose(sessionId);
  }

  /** Restores review ownership without starting a watcher before the next prompt is actually delivered. */
  private trackReview(sessionId: string): void {
    this.reviewRequested.add(sessionId);
    if (this.reviewInputObservers.has(sessionId)) return;
    this.reviewInputObservers.set(sessionId, this.terminals.observeInputWrites(sessionId, (_data, submitted) => {
      this.invalidateReview(sessionId);
      const generation = this.reviewGeneration(sessionId);
      this.retryableQuiet.delete(sessionId);
      if (!submitted) {
        this.reviews.set(sessionId, { status: "unavailable", reason: "Input has not been submitted as a new worker task.", costUsd: null });
        return;
      }
      return () => queueMicrotask(() => {
        if (this.reviewRequested.has(sessionId) && this.reviewGenerations.get(sessionId) === generation) this.scheduleReview(sessionId);
      });
    }));
  }

  private reviewGeneration(sessionId: string): object {
    let generation = this.reviewGenerations.get(sessionId);
    if (!generation) { generation = {}; this.reviewGenerations.set(sessionId, generation); }
    return generation;
  }

  private invalidateReview(sessionId: string): void {
    const reviewerIds = new Set([this.reviews.get(sessionId)?.reviewerSessionId, this.reviewAgents.get(sessionId)]);
    this.reviewGenerations.set(sessionId, {});
    this.reviews.delete(sessionId);
    this.reviewWatchers.get(sessionId)?.controller.abort();
    this.reviewWatchers.delete(sessionId);
    this.reviewControllers.get(sessionId)?.abort();
    this.reviewControllers.delete(sessionId);
    this.reviewPending.delete(sessionId);
    this.reviewAgents.delete(sessionId);
    for (const reviewerId of reviewerIds) this.disposeReviewer(reviewerId);
  }

  private disposeReviewer(reviewerId: string | undefined): void {
    if (!reviewerId) return;
    this.readOnlyReviewers.delete(reviewerId);
    try { this.terminals.dispose(reviewerId); } catch { /* the reviewer may already have ended */ }
  }

  private reviewReadiness(sessionId: string, quiet = false): AgentReviewResult | null {
    // An old idle/answer can remain visible until the provider acknowledges the submitted input.
    const progress = this.turnProgress(sessionId);
    if (progress?.promptSent && !progress.turnStartedSincePrompt && !this.answer(sessionId)) {
      return quiet || this.terminals.getMetadata(sessionId)?.exitCode !== null
        ? { status: "unavailable", reason: "The provider did not report a new completed turn or final answer after the submitted input.", costUsd: null }
        : { status: "pending", costUsd: null };
    }
    return null;
  }

  private async ensureReview(sessionId: string, quiet = false): Promise<AgentReviewResult> {
    const readiness = this.reviewReadiness(sessionId, quiet);
    if (readiness) return readiness;
    const generation = this.reviewGeneration(sessionId);
    const cached = this.reviews.get(sessionId);
    if (cached) return cached;
    const active = this.reviewPending.get(sessionId);
    if (active) {
      const result = await active;
      return this.reviewGenerations.get(sessionId) === generation ? result : supersededReview();
    }
    const controller = new AbortController();
    this.reviewControllers.set(sessionId, controller);
    // Store the guarded promise, so every concurrent caller observes invalidation, not the raw verdict.
    const pending = this.performReview(sessionId, controller.signal).catch((error: unknown): AgentReviewResult => ({
      status: "unavailable",
      reason: this.redactTail(error instanceof Error ? error.message : "The reviewer failed.", 500),
      costUsd: null
    })).then(result => {
      if (controller.signal.aborted || this.reviewGenerations.get(sessionId) !== generation) {
        this.disposeReviewer(result.reviewerSessionId);
        return supersededReview();
      }
      this.reviews.set(sessionId, result);
      try { this.options.onReview?.(sessionId, result); } catch { /* review observers cannot affect the result */ }
      return result;
    }).finally(() => {
      if (this.reviewPending.get(sessionId) === pending) this.reviewPending.delete(sessionId);
      if (this.reviewControllers.get(sessionId) === controller) this.reviewControllers.delete(sessionId);
    });
    this.reviewPending.set(sessionId, pending);
    const result = await pending;
    return this.reviewGenerations.get(sessionId) === generation ? result : supersededReview();
  }

  private async performReview(sessionId: string, signal: AbortSignal): Promise<AgentReviewResult> {
    const worker = this.requireSession(sessionId);
    const request = this.launchRequests.get(sessionId);
    if (!request) return { status: "unavailable", reason: "CanvasTTY no longer has the worker launch details.", costUsd: null };
    // A worker on a model account (Accounts plugin) is reviewed on that same account unless a review model was named:
    // the agent's own sign-in may not exist, and only the account carries the key for this model.
    const account = request.reviewModel ? null : selectedModelAccount(request.launchOptions);
    if (!account && !request.reviewModel && !this.options.reviewModel) return { status: "unavailable", reason: "No different known reviewer model is available.", costUsd: null };
    let workerModel=worker.model ?? request.model;
    if(!workerModel)try{workerModel=await this.options.workerModel?.(worker) ?? undefined;}catch{ /* Unknown remains unknown. */ }
    if(signal.aborted)return {status:"unavailable",reason:"The worker session was removed before review.",costUsd:null};
    let model: string | null;
    try { model = account ? `account:${account}` : request.reviewModel ?? this.options.reviewModel?.(worker.provider as AgentProviderId, workerModel) ?? null; }
    catch { model = null; }
    if (!model || (!account && workerModel && model === workerModel)) {
      return { status: "unavailable", reason: "No known model different from the worker's model is available.", costUsd: null };
    }
    const profile = this.profileFor(this.lineage(sessionId).at(-1)!.id, worker.provider as AgentProviderId, "plan");
    if ("error" in profile) return { status: "unavailable", reason: `A read-only Plan reviewer is unavailable: ${profile.error}`, costUsd: null };
    let diff: string;
    try {
      diff = this.options.reviewDiff ? await this.options.reviewDiff(worker) : await this.terminals.readReviewDiff(sessionId);
    } catch (error) {
      return { status: "unavailable", reason: `The worker diff could not be read: ${error instanceof Error ? error.message : "unknown error"}`, costUsd: null };
    }
    if (signal.aborted) return { status: "unavailable", reason: "The worker session was removed before review.", costUsd: null };
    const maskedDiff = utf8Tail(this.redactTail(diff, MAX_REVIEW_DIFF_BYTES + 8_192), MAX_REVIEW_DIFF_BYTES);
    const answer = this.answer(sessionId);
    const maskedAnswer = answer ? this.redactTail(answer.text, MAX_REVIEW_ANSWER_CHARS) : "No final answer was available from this provider.";
    const root = this.lineage(sessionId).at(-1)!;
    const prompt = [
      "Review only the supplied answer and diff. The temporary review workspace also contains the same patch as review.diff. Do not inspect or modify project files; this is a read-only review.",
      "Return one JSON object with exactly these fields: verdict (accept, revise, or reject) and findings (short actionable notes).",
      "Use accept when no material issue is visible, revise when the author can address concrete issues, and reject when the result does not satisfy the request.",
      "Worker answer:", maskedAnswer,
      "Diff:", maskedDiff || "(No reviewable diff was found.)"
    ].join("\n\n");
    let reviewer: SessionMetadata | undefined;
    let keepReviewer = false;
    let reviewerAccount: Awaited<ReturnType<TerminalManager["prepareReviewerAccount"]>> | undefined;
    let workspace: DiffOnlyReviewWorkspace;
    try {
      workspace = createDiffOnlyReviewWorkspace(maskedDiff);
    } catch (error) {
      return { status: "unavailable", reason: `The diff-only review workspace could not be prepared: ${error instanceof Error ? error.message : "unknown error"}`, costUsd: null, model };
    }
    try {
      try {
        reviewerAccount = account
          ? await this.terminals.prepareReviewerAccount({ taskRootSessionId: root.id, provider: worker.provider as AgentProviderId, workspace,
            launchOptions: { [MODEL_ACCOUNTS_PLUGIN_ID]: { account } } })
          : undefined;
        if (signal.aborted) throw new Error("The worker session was removed before review.");
        reviewer = this.terminals.createReadOnlyReviewer({
          taskRootSessionId: root.id,
          provider: worker.provider as AgentProviderId,
          workspace,
          title: `Review: ${worker.title}`.slice(0, 80),
          ...(reviewerAccount ? { account: reviewerAccount } : { model })
        });
        // Once creation succeeds, TerminalManager owns the contribution and cleans it up with the session.
        reviewerAccount = undefined;
        this.readOnlyReviewers.add(reviewer.id);
        // OpenCode's fresh home has no conversation until submission; wait for its rendered input prompt or hook.
        if (worker.provider === "opencode") {
          const readyBy = Date.now() + (this.options.reviewStartupMs ?? REVIEW_STARTUP_QUIET_MS);
          const ready = (): boolean => typeof this.terminals.inputReady === "function"
            ? this.terminals.inputReady(reviewer!.id)
            : (this.resultLifecycleStatus(reviewer!.id) ?? this.terminals.getMetadata(reviewer!.id)?.status) !== "unavailable";
          while (Date.now() < readyBy && !ready()) await pause(250, signal);
          if (!ready()) throw new Error("The reviewer CLI did not expose its input prompt before the startup deadline.");
        }
        await this.deliver(reviewer.id, `${prompt}\r`, "prompt", signal);
      } catch (error) {
        return { status: "unavailable", reason: `The read-only reviewer could not start: ${error instanceof Error ? error.message : "unknown error"}`, costUsd: null, model };
      }
      const reviewerSession = reviewer!;
      this.reviewAgents.set(sessionId, reviewerSession.id);
      if (signal.aborted) {
        return { status: "unavailable", reason: "The worker session was removed before review.", reviewerSessionId: reviewerSession.id, model, costUsd: null };
      }
      const waited = await this.waitFor(reviewerSession.id, {
        timeoutMs: this.options.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS,
        // A reviewer starts its CLI in a fresh, empty home (OpenCode may fetch its provider package first) and reports
        // no turn until then: ten silent seconds are not yet "stopped responding".
        quietMs: REVIEW_STARTUP_QUIET_MS,
        signal
      }).catch((error: unknown) => ({
        sessionId: reviewerSession.id, reason: "failed" as const, exitCode: 1, waitedMs: 0, output: "",
        exitLines: error instanceof Error ? this.redactTail(error.message, 500) : "review failed"
      }));
      if (signal.aborted) {
        return { status: "unavailable", reason: "The worker session was removed during review.", reviewerSessionId: reviewerSession.id, model, costUsd: null };
      }
      if (waited.reason === "timeout" || waited.reason === "quiet" || waited.reason === "failed" || !waited.answer) {
        return {
          status: "unavailable",
          reason: waited.reason === "timeout" ? "The reviewer timed out." : waited.reason === "quiet" ? "The reviewer stopped responding without a readable verdict." : waited.exitLines ? `The reviewer failed before returning a verdict: ${this.redactTail(waited.exitLines, 500)}` : "The reviewer failed before returning a verdict.",
          reviewerSessionId: reviewerSession.id,
          model,
          costUsd: null
        };
      }
      const parsed = parseReview(waited.answer.text);
      if (!parsed) {
        return { status: "unavailable", reason: "The reviewer did not return a valid accept, revise, or reject verdict.", reviewerSessionId: reviewerSession.id, model, costUsd: null };
      }
      keepReviewer = true;
      return {
        status: parsed.verdict === "accept" ? "accepted" : parsed.verdict === "revise" ? "revise" : "rejected",
        verdict: parsed.verdict,
        notes: [account ? "Reviewed on the worker's model account (the same model; name reviewModel for another)." : "", parsed.findings ? this.redactTail(parsed.findings, 8_000) : ""].filter(Boolean).join("\n") || undefined,
        reviewerSessionId: reviewerSession.id,
        model,
        costUsd: null
      };
    } finally {
      if (reviewerAccount) await reviewerAccount.contribution.cleanup().catch(() => undefined);
      if (reviewer && this.reviewAgents.get(sessionId) === reviewer.id) this.reviewAgents.delete(sessionId);
      if (!keepReviewer) {
        if (reviewer) try { this.terminals.dispose(reviewer.id); } catch { /* the task may already have removed it */ }
        workspace.cleanup();
        if (reviewer) this.readOnlyReviewers.delete(reviewer.id);
      }
    }
  }


  private requireBudgetActive(sessionId: string): void {
    if (!this.options.budget) return;
    let snapshot: ReturnType<OrchestrationBudgetService["snapshot"]>;
    const root = this.taskRoot(sessionId);
    try { snapshot = this.options.budget.snapshot(root.id, root.startedAt); }
    catch (error) { throw new DelegationRefusal(`Task budget state is unavailable; new subagent activity is paused. ${error instanceof Error ? error.message : ""}`); }
    if (snapshot.paused) throw new DelegationRefusal(snapshot.reason ?? "This task's budget is exhausted. Increase or clear it in CanvasTTY before continuing.");
  }

  private scheduleReview(sessionId: string): void {
    if (!this.reviewRequested.has(sessionId) || this.reviewWatchers.has(sessionId)) return;
    const controller = new AbortController();
    let watcher: { controller: AbortController; promise: Promise<void> };
    const promise = this.monitorReview(sessionId, controller.signal).catch(() => undefined).finally(() => {
      if (this.reviewWatchers.get(sessionId) === watcher) this.reviewWatchers.delete(sessionId);
    });
    watcher = { controller, promise };
    this.reviewWatchers.set(sessionId, watcher);
  }

  /** Waits for the worker's next completed turn and starts its review without requiring a result poll. */
  private async monitorReview(sessionId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const session = this.terminals.getMetadata(sessionId);
      if (!session || !this.reviewRequested.has(sessionId)) return;
      if (session.exitCode !== null) {
        await this.ensureReview(sessionId);
        return;
      }
      const result = await this.waitFor(sessionId, { timeoutMs: MAX_AGENT_WAIT_MS, signal });
      if (signal.aborted) return;
      if (result.reason === "idle" || result.reason === "done" || result.reason === "failed" || result.reason === "quiet") {
        const review = result.review ?? await this.ensureReview(sessionId, result.reason === "quiet");
        if (signal.aborted) return;
        if (review.status !== "pending") return;
      }
      if (result.reason === "closed") return;
      // Approval and quiet states need a later human input or another output sample; avoid spinning on either.
      await pause(1_000, signal);
    }
  }

  /** Through the terminal manager's one delivery rule: exactly once, into the launch that is starting now. */
  private async deliver(sessionId: string, data: string, what: "prompt" | "text", signal?: AbortSignal): Promise<void> {
    const delivery = await this.terminals.deliverInput(sessionId, data, undefined, signal);
    if (!delivery.delivered) {
      throw new PromptNotDeliveredError(sessionId, `The ${what} for agent ${sessionId} was not delivered: ${delivery.reason}`);
    }
  }

  /** The last lines of an exited agent's screen as plain text: masked over the whole tail window before it is cut. */
  private exitLines(buffer: string): string | null {
    const text = terminalFailureDetails(this.redactTail(buffer, MAX_EXIT_WINDOW_CHARS));
    if (!text) return null;
    return text.split("\n").slice(-MAX_EXIT_LINES).join("\n");
  }

  /** Plugin launch secrets never reach another agent through observed output: the tail as masking the whole text leaves it. */
  private redactTail(text: string, maxChars: number): string {
    if (typeof this.terminals.redactSecretsTail === "function") return this.terminals.redactSecretsTail(text, maxChars);
    return tail(typeof this.terminals.redactSecrets === "function" ? this.terminals.redactSecrets(text) : text, maxChars);
  }

  private resultLifecycleStatus(sessionId: string): "idle" | "working" | "needs_approval" | null {
    return typeof this.terminals.resultLifecycleState === "function" ? this.terminals.resultLifecycleState(sessionId) : null;
  }

  private turnProgress(sessionId: string): { promptSent: boolean; turnStartedSincePrompt: boolean } | null {
    try { return typeof this.terminals.turnProgress === "function" ? this.terminals.turnProgress(sessionId) : null; } catch { return null; }
  }

  private answer(sessionId: string): AgentAnswer | null {
    try {
      const answer = typeof this.terminals.answer === "function" ? this.terminals.answer(sessionId) : null;
      return answer ? { text: answer.text, truncated: answer.truncated } : null;
    } catch { return null; }
  }

  /** How much output the session produced so far; changes whenever its screen does. */
  private outputOffset(sessionId: string): number {
    try {
      if (typeof this.terminals.outputOffset === "function") return this.terminals.outputOffset(sessionId) ?? -1;
      return this.terminals.readBuffer(sessionId).outputOffset;
    } catch { return -1; }
  }

  /** A lookup by id: metadata only, so no other session's scrollback is copied. */
  private requireSession(sessionId: string): SessionMetadata {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("A session id is required.");
    }
    const session = this.terminals.getMetadata(sessionId);
    if (!session) throw new Error("Terminal session does not exist.");
    return session;
  }
}

/** A delegation rule refused the request; the text says why, for the orchestrator to adapt instead of retrying. */
export class DelegationRefusal extends LaunchRefusal {
  constructor(message: string) {
    super(message);
    this.name = "DelegationRefusal";
  }
}

/**
 * The launch profile of a subagent: never more than its orchestrator's (plan < normal < acceptEdits < auto < yolo),
 * never YOLO. Asked for: that profile, when its CLI has it and it is not above the orchestrator's. Not asked for: the
 * orchestrator's, or the next lower one its CLI has, so a person who runs the orchestrator in auto is not asked about
 * every step of its subagents. `containment`: CanvasTTY's isolation layer runs here (a CLI without an auto mode of its
 * own gets auto only inside it).
 */
export function subagentProfile(
  parent: LaunchProfile,
  provider: AgentProviderId,
  requested?: unknown,
  containment = false
): { profile: LaunchProfile; inherited: boolean } | { error: string } {
  const ceiling = profileCeiling(parent);
  if (requested !== undefined) {
    if (requested === "yolo") {
      return { error: "YOLO (bypass) is never given to a subagent. Use profile auto or a lower one; the person alone launches agents in YOLO." };
    }
    if (!isLaunchProfile(requested)) return { error: "profile must be auto, normal, acceptEdits or plan." };
    if (PROFILE_RANK[requested] > PROFILE_RANK[ceiling]) {
      return { error: `This orchestrator runs in the ${parent} profile, so its subagents get at most ${ceiling}; ${requested} would give a subagent more than its orchestrator. Only the person can launch an agent with more.` };
    }
    if (!profileAvailable(provider, requested, containment)) {
      return { error: requested === "auto"
        ? `${provider} has no auto mode of its own, and CanvasTTY's agent isolation is not available here to contain it; use profile normal.`
        : `${provider} has no ${requested} mode; call list_providers for the profiles it takes.` };
    }
    return { profile: requested, inherited: false };
  }
  const order: LaunchProfile[] = ["auto", "acceptEdits", "normal", "plan"];
  const start = order.indexOf(ceiling);
  const profile = order.slice(start < 0 ? 0 : start).find((candidate) => profileAvailable(provider, candidate, containment)) ?? "normal";
  return { profile, inherited: true };
}

/**
 * Where a subagent may work: its orchestrator's project folder (the folder the person chose for the agent it
 * descends from) or a folder inside it, compared as real paths in the spelling the disk uses (NFC and NFD name the
 * same folder on macOS). A relative folder is taken from the orchestrator's own folder.
 */
export function subagentFolder(projectRoot: string, parentCwd: string, requested: unknown): { cwd: string } | { error: string } {
  if (typeof requested !== "string" || requested.trim().length === 0) return { error: "cwd is required: a folder inside this project." };
  const wanted = onDiskPath(isAbsolute(requested) ? requested : resolve(parentCwd, requested));
  const real = (path: string): string | null => {
    for (const spelling of [path, ...otherSpellings(path)]) {
      try { return realpathSync.native(spelling); } catch { /* the next spelling */ }
    }
    return null;
  };
  const root = real(onDiskPath(projectRoot));
  const folder = real(wanted);
  if (!folder) return { error: `The folder ${requested} does not exist. A subagent works in this project's folder (${projectRoot}) or a folder inside it.` };
  if (!root || !(isPathInside(root, folder) || isPathInside(root.normalize("NFC"), folder.normalize("NFC")))) {
    return { error: `A subagent works only inside this project's folder (${projectRoot}); ${requested} is outside it. Only the person can start an agent in another folder.` };
  }
  return { cwd: folder };
}

/** Sleeps, or rejects with an AbortError as soon as `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The wait was canceled.");
  error.name = "AbortError";
  return error;
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let value = bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
  // A UTF-8 byte window can begin in the middle of a code point; drop that partial character.
  if (value.startsWith("\uFFFD")) value = value.slice(1);
  return value;
}

function parseReview(text: string): { verdict: "accept" | "revise" | "reject"; findings: string } | null {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) return null;
  let value: unknown;
  try { value = JSON.parse(match[0]); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.verdict !== "accept" && record.verdict !== "revise" && record.verdict !== "reject") return null;
  const findings = typeof record.findings === "string" ? record.findings : typeof record.notes === "string" ? record.notes : "";
  return { verdict: record.verdict, findings: findings.slice(0, 8_000) };
}

function spawnCanceled(): Error {
  return new DOMException("The spawn was canceled before its agent started.", "AbortError");
}

const MODEL_ACCOUNTS_PLUGIN_ID = "canvastty-accounts";
/** The model account a worker was launched on through the Accounts plugin, if any. */
function selectedModelAccount(launchOptions: SpawnAgentRequest["launchOptions"]): string | null {
  const account = launchOptions?.[MODEL_ACCOUNTS_PLUGIN_ID]?.account;
  return typeof account === "string" && account && account !== "none" ? account : null;
}

function supersededReview(): AgentReviewResult {
  return { status: "unavailable", reason: "The worker prompt changed or the session was removed before this review completed.", costUsd: null };
}
