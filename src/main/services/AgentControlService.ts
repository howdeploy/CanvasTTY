import { codexPromptInput } from "./codexInput.ts";
import type {
  AgentProviderId,
  CreateSessionRequest,
  LaunchProfileId,
  SessionEnvironmentChoice,
  SessionMetadata,
  SessionSnapshot
} from "../../shared/contracts.ts";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROVIDER_CAPABILITIES } from "../../shared/contracts.ts";
import { isLaunchProfile, PROFILE_RANK, profileAvailable, profileCeiling, type LaunchProfile } from "../../shared/autoMode.ts";
import { isPathInside } from "../../agent-runtime/path-inside.mjs";
import type { TerminalManager } from "./TerminalManager.ts";
import { onDiskPath, otherSpellings } from "./onDiskPath.ts";
import { LaunchRefusal } from "./launchRefusal.ts";
import { terminalFailureDetails } from "./terminalFailureDetails.ts";
import { renderedTerminalText } from "./renderedTerminalText.ts";
import { RESULT_CAPTURE_PROVIDERS } from "./resultCapture.ts";
import { PLUGIN_DATA_FOLDER, privateAppData } from "./isolation/isolationPaths.ts";

// Cards one parent may have in total, live or exited (the live limit is the person's setting).
const MAX_CHILDREN_PER_PARENT = 16;
const NO_WORKTREE = "The environments plugin does not provide a worktree for this launch: no trusted environments plugin offers one for this agent in this Git project. Spawn it without isolate.";
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
const MAX_EXIT_LINES = 20;
/**
 * How much of the scrollback (masked first) the plain-text output is rendered from: several full redraws of a
 * full-screen TUI, and many screens of a line-based CLI, while each call still masks a bounded window.
 */
const MAX_SCREEN_SOURCE_CHARS = 65_536;
const CHILD_POSITION_STEP = { x: 60, y: 60 };

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
  /** "worktree": run it in a worktree of the installed environments plugin; refused when none is available. */
  isolate?: "worktree";
}

/** What an environment resolver gets for one subagent (AgentControlOptions.resolveSubagentEnvironment). */
export interface SubagentEnvironmentRequest {
  provider: AgentProviderId;
  parentSessionId: string;
  /** The folder of the agent the person started: the task's project. */
  projectRoot: string;
  cwd: string;
  liveChildren: number;
  isolate?: "worktree";
}

export interface AgentObservation {
  sessionId: string;
  status: SessionSnapshot["status"];
  /** The screen's text as a terminal shows it (no control sequences), masked, capped to its last characters. */
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
  /** The screen's text as a terminal shows it (no control sequences), masked, capped to its last characters. */
  output: string;
  /** Once the process exited: the last lines of its screen as plain text, masked (why it stopped, e.g. a bad model). */
  exitLines?: string;
  /** The final answer of the turn that ended (Codex, OpenCode subagents), masked. */
  answer?: AgentAnswer;
  /** Why a Codex or OpenCode subagent has no answer and never will in this launch (read its output instead). */
  answerUnavailable?: AgentAnswerUnavailable;
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
  /** CanvasTTY's userData folder: a subagent never works in its private data (tokens, account homes, plugin data). */
  userDataPath?: string;
  /**
   * The environment a new subagent runs in (a trusted environments plugin's worktree), or null for this computer's
   * folder. Absent: subagents run in their folder and `isolate: "worktree"` is refused.
   */
  resolveSubagentEnvironment?: (request: SubagentEnvironmentRequest) => SessionEnvironmentChoice | null | Promise<SessionEnvironmentChoice | null>;
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
  /** The screen's text as a terminal shows it (no control sequences), masked, capped to its last characters. */
  output: string;
  /** Once the process exited: the last lines of its screen as plain text, masked. */
  exitLines?: string;
  /** The last turn's final answer as the agent reported it (Codex, OpenCode subagents), masked; absent otherwise. */
  answer?: AgentAnswer;
  /** Why a Codex or OpenCode subagent has no answer and never will in this launch (read its output instead). */
  answerUnavailable?: AgentAnswerUnavailable;
}

export interface AgentAnswerUnavailable {
  /** "status_hooks_off": CanvasTTY status hooks were off for its launch, so it has no hooks to report an answer. */
  reason: "status_hooks_off";
  message: string;
}

const STATUS_HOOKS_OFF_MESSAGE = "This subagent's final answer cannot be captured because CanvasTTY status hooks are off "
  + "(Settings → Agents; turning them on applies to agents started or restarted afterwards). Read its output instead: "
  + "the output field here, or observe_agent.";

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
  private readonly terminals: TerminalManager;
  private readonly options: AgentControlOptions;
  /**
   * The card revision at which wait_for_agent last returned needs_approval for a subagent. While the card is still at
   * that same prompt, the next wait waits for the person's answer instead of returning it again.
   */
  private readonly reportedApprovals = new Map<string, number | undefined>();

  constructor(terminals: TerminalManager, options: AgentControlOptions = {}) {
    this.terminals = terminals;
    this.options = options;
  }

  /**
   * Creates the subagent card. With an initial prompt it resolves only once the prompt reached the agent's PTY
   * (after an asynchronous launch has started) and rejects with PromptNotDeliveredError when that launch did not
   * start; the card stays, so the caller can inspect or cancel it. `promptWaitMs` bounds that wait (the launch and
   * the CLI's readiness together; LAUNCH_INPUT_WAIT_MS without it).
   */
  spawn(request: SpawnAgentRequest, signal?: AbortSignal, promptWaitMs?: number): Promise<SessionMetadata> {
    if (!request || typeof request.parentSessionId !== "string") {
      throw new Error("A parent session id is required.");
    }
    const parent = this.requireSession(request.parentSessionId);
    const capabilities = PROVIDER_CAPABILITIES[request.provider];
    if (!capabilities) throw new Error("Unknown agent provider.");
    if (!capabilities.send) throw new Error(`${request.provider} cannot receive prompts.`);
    const inheritance = this.subagentLaunchOptions(parent.id, request.provider, request.launchOptions, request.model);
    if (inheritance.launchOptions !== request.launchOptions) request = { ...request, launchOptions: inheritance.launchOptions };

    const lineage = this.lineage(parent.id);
    const root = lineage.at(-1)!;
    // What the request asks for first (its folder, its profile), then the person's limits.
    const cwd = subagentFolder(root.cwd, parent.cwd, request.cwd, this.options.userDataPath);
    if ("error" in cwd) throw new DelegationRefusal(cwd.error);
    const profile = subagentProfile(parent.profile, request.provider, request.profile, this.containment());
    if ("error" in profile) throw new DelegationRefusal(profile.error);
    const { live } = this.spawnCapacity(parent.id);
    const resolve = this.options.resolveSubagentEnvironment;
    if (!resolve) {
      if (request.isolate === "worktree") throw new DelegationRefusal(NO_WORKTREE);
      return this.createSubagent(parent.id, request, cwd.cwd, profile.profile, null, signal, promptWaitMs);
    }
    const refusal = (error: unknown): DelegationRefusal => (
      new DelegationRefusal(`The environments plugin could not prepare this subagent: ${error instanceof Error ? error.message : "unknown error"}`)
    );
    let environment: SessionEnvironmentChoice | null | Promise<SessionEnvironmentChoice | null>;
    try {
      environment = resolve({
        provider: request.provider,
        parentSessionId: parent.id,
        projectRoot: root.cwd,
        cwd: cwd.cwd,
        liveChildren: live,
        ...(request.isolate ? { isolate: request.isolate } : {})
      });
    } catch (error) {
      throw refusal(error);
    }
    if (environment instanceof Promise) {
      // The delivery budget also covers the asynchronous environment lookup.
      const startedAt = Date.now();
      return environment.then(
        (choice) => this.createSubagent(parent.id, request, cwd.cwd, profile.profile, choice, signal,
          promptWaitMs === undefined ? undefined : Math.max(0, promptWaitMs - (Date.now() - startedAt))),
        (error: unknown) => { throw refusal(error); }
      );
    }
    return this.createSubagent(parent.id, request, cwd.cwd, profile.profile, environment, signal, promptWaitMs);
  }

  /**
   * Checks the person's limits for one more child of this parent (throws a DelegationRefusal); the live subagents of
   * its orchestration otherwise.
   */
  private spawnCapacity(parentId: string): { live: number } {
    const children = this.children(parentId);
    if (children.length >= MAX_CHILDREN_PER_PARENT) {
      throw new DelegationRefusal(`Session ${parentId} already has ${MAX_CHILDREN_PER_PARENT} subagent cards; cancel_agent the finished ones first.`);
    }
    const lineage = this.lineage(parentId);
    const root = lineage.at(-1)!;
    const limits = this.limits();
    // The parent is at level lineage.length - 1 below its top-level agent; the new card one further down.
    if (lineage.length > limits.maxDepth) {
      throw new DelegationRefusal(`Subagents may nest at most ${limits.maxDepth} level${limits.maxDepth === 1 ? "" : "s"} deep below the agent the person started; this one would be level ${lineage.length}. The person sets this limit in Settings → Agents.`);
    }
    const live = this.descendants(root.id).filter((session) => session.exitCode === null).length;
    if (live >= limits.maxSubagents) {
      throw new DelegationRefusal(`This orchestration already runs ${live} live subagent${live === 1 ? "" : "s"}, its limit (Settings → Agents, set by the person). Wait for one to finish or cancel_agent one first.`);
    }
    return { live };
  }

  private createSubagent(
    parentId: string,
    request: SpawnAgentRequest,
    cwd: string,
    profile: LaunchProfile,
    environment: SessionEnvironmentChoice | null,
    signal?: AbortSignal,
    promptWaitMs?: number
  ): Promise<SessionMetadata> {
    if (request.isolate === "worktree" && !environment) return Promise.reject(new DelegationRefusal(NO_WORKTREE));
    // A call cancelled before its agent starts launches nothing.
    if (signal?.aborted) return Promise.reject(spawnCanceled());
    let parent: SessionMetadata;
    let cascade: number;
    try {
      // An asynchronous environment lookup may race another spawn or the parent's end: the parent and the limits are
      // checked again right before the synchronous card creation, which takes the live slot.
      parent = this.requireSession(parentId);
      this.spawnCapacity(parentId);
      cascade = this.children(parentId).length;
    } catch (error) {
      return Promise.reject(error);
    }
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
    }, { ...(RESULT_CAPTURE_PROVIDERS.has(request.provider) ? { captureResult: true } : {}), origin: "subagent" });
    if (request.initialPrompt === undefined || request.initialPrompt.length === 0) return Promise.resolve(created);
    const input = request.provider === "codex"
      ? codexPromptInput(request.initialPrompt) : `${request.initialPrompt}\r`;
    return this.deliver(created.id, input, "prompt", signal, promptWaitMs)
      .then(() => this.terminals.getMetadata(created.id) ?? created, (error: unknown) => {
        // Cancelled while it started: nobody receives its id, so the card is closed instead of left running.
        if (!signal?.aborted) throw error;
        try { this.terminals.dispose(created.id); } catch { /* it already ended */ }
        throw spawnCanceled();
      });
  }

  /**
   * The plugin launch options a subagent of this parent starts with. A plugin the spawn does not name keeps the
   * orchestrator's own values, which the person chose: a subagent never falls back silently to its CLI's default model
   * and sign-in (for OpenCode that is OpenCode Zen, a third-party service) while its orchestrator runs on a model the
   * person picked through a plugin. Naming a plugin is an explicit choice (checked by the launch: another value needs
   * the plugin's delegable declaration). Another CLI cannot inherit a plugin choice that set the orchestrator's model,
   * and is refused unless the spawn names that plugin. An explicit model next to an inherited choice that sets the model is refused.
   */
  subagentLaunchOptions(
    parentSessionId: string,
    provider: AgentProviderId,
    requested: SpawnAgentRequest["launchOptions"],
    model?: string
  ): { launchOptions: SpawnAgentRequest["launchOptions"]; sources: Record<string, "inherited" | "explicit"> } {
    const parent = this.requireSession(parentSessionId);
    const sources: Record<string, "inherited" | "explicit"> = {};
    for (const pluginId of Object.keys(requested ?? {})) sources[pluginId] = "explicit";
    const parentOptions = this.terminals.launchOptionsOf(parent.id);
    const unnamed = Object.keys(parentOptions ?? {}).filter((pluginId) => !Object.hasOwn(sources, pluginId));
    if (!parentOptions || unnamed.length === 0) return { launchOptions: requested, sources };
    const modelSetBy = new Set(this.terminals.modelSetByOf(parent.id));
    const modelPlugins = unnamed.filter((pluginId) => modelSetBy.has(pluginId));
    if (parent.provider !== provider) {
      if (modelPlugins.length === 0) return { launchOptions: requested, sources };
      const named = modelPlugins.map((pluginId) => pluginId.slice(0, 80)).join(", ");
      // The person chose those options for this CLI; another CLI would run on its own default model and sign-in.
      throw new DelegationRefusal(`This orchestrator's model is set by its ${named} launch options, which the person chose for ${parent.provider}; `
        + `a ${provider} subagent would not get that model. Spawn a ${parent.provider} subagent instead.`);
    }
    if (model !== undefined && modelPlugins.length > 0) {
      const named = modelPlugins.map((pluginId) => pluginId.slice(0, 80)).join(", ");
      throw new DelegationRefusal(`This subagent inherits its orchestrator's ${named} launch options, which set its model; it cannot also take model ${model.slice(0, 80)}. `
        + `Omit model, or pass launchOptions for ${named} that choose the model you want.`);
    }
    // A plugin turned off since the orchestrator started is left out, unless it set the model: then the subagent would
    // run on its CLI's own default model and sign-in, so it is refused instead.
    const gone = new Set(this.terminals.unavailableLaunchPlugins(Object.fromEntries(unnamed.map((pluginId) => [pluginId, parentOptions[pluginId]]))));
    const goneModel = modelPlugins.filter((pluginId) => gone.has(pluginId));
    if (goneModel.length > 0) {
      const named = goneModel.map((pluginId) => pluginId.slice(0, 80)).join(", ");
      throw new DelegationRefusal(`This orchestrator's model is set by its ${named} launch options, and ${named} is now disabled, removed or not trusted; `
        + "a subagent would run on its CLI's own default model instead. The person can turn the plugin back on, or start the orchestrator again.");
    }
    const launchOptions: NonNullable<SpawnAgentRequest["launchOptions"]> = { ...(requested ?? {}) };
    for (const pluginId of unnamed.filter((id) => !gone.has(id))) {
      launchOptions[pluginId] = parentOptions[pluginId]!;
      sources[pluginId] = "inherited";
    }
    return { launchOptions, sources };
  }

  /** The profile a subagent of this parent gets for this request (what spawn will use), or why it gets none. */
  profileFor(parentSessionId: string, provider: AgentProviderId, requested?: unknown): { profile: LaunchProfile; inherited: boolean } | { error: string } {
    return subagentProfile(this.requireSession(parentSessionId).profile, provider, requested, this.containment());
  }

  /** Validates at once (throws); resolves once the text reached the agent, and rejects when it did not. */
  send(sessionId: string, text: string, submit = true, signal?: AbortSignal, waitMs?: number): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities.send) throw new Error(`${session.provider} cannot receive prompts.`);
    if (typeof text !== "string" || text.length === 0) throw new Error("Prompt text is required.");
    if (session.exitCode !== null) throw new Error("Agent session has already exited.");
    // The card shows a prompt only the person may answer (OpenCode's own shell prompt, for example): text typed into
    // it now, or the Enter after it, would answer that prompt on the person's behalf.
    if (session.status === "needs_approval") throw new DelegationRefusal(APPROVAL_REFUSAL);
    const input = session.provider === "codex" ? codexPromptInput(text, submit) : submit ? `${text}\r` : text;
    return this.deliver(sessionId, input, "text", signal, waitMs);
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

  async observe(sessionId: string, maxChars = MAX_OBSERVE_CHARS): Promise<AgentObservation> {
    const session = this.observableSession(sessionId);
    const buffer = this.terminals.readBuffer(sessionId).buffer;
    const exitLines = session.exitCode === null ? null : await this.screenExitLines(sessionId, buffer);
    return {
      sessionId: session.id,
      status: session.status,
      output: await this.screenText(sessionId, buffer, maxChars),
      ...(session.exitCode === null ? {} : { exitCode: session.exitCode }),
      ...(exitLines ? { exitLines } : {})
    };
  }

  private observableSession(sessionId: string): SessionMetadata {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities.observe) throw new Error(`${session.provider} cannot be observed.`);
    return session;
  }

  async result(sessionId: string): Promise<AgentResult> {
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
    const exitLines = session.exitCode === null ? null : await this.screenExitLines(sessionId, buffer);
    return {
      sessionId: session.id,
      state: session.exitCode === null
        ? "running"
        : session.exitCode === 0 ? "done" : "failed",
      status: session.status,
      exitCode: session.exitCode,
      output: buffer ? await this.screenText(sessionId, buffer, MAX_OBSERVE_CHARS) : "",
      ...(exitLines ? { exitLines } : {}),
      ...(answer ? { answer } : this.answerUnavailable(sessionId))
    };
  }

  /**
   * Waits until the agent is at rest (idle, needs_approval, exited, or quiet when it reports no status), its card
   * closed, or the timeout passed. Only reads metadata and the output offset while it waits; the tail is read and
   * masked once, as it returns. Rejects with an AbortError once `signal` aborts.
   */
  async waitFor(sessionId: string, request: { timeoutMs: number; signal?: AbortSignal }): Promise<AgentWaitResult> {
    const { signal } = request;
    signal?.throwIfAborted();
    const first = this.requireSession(sessionId);
    if (first.provider === "terminal") throw new Error("Plain terminals are not agents.");
    if (typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs)) throw new Error("A wait timeout is required.");
    const timing = this.options.waitTiming ?? AGENT_WAIT_TIMING;
    const timeoutMs = Math.min(MAX_AGENT_WAIT_MS, Math.max(0, request.timeoutMs));
    const started = Date.now();
    const answer = async (session: SessionMetadata | null, reason: AgentWaitReason): Promise<AgentWaitResult> => {
      const waitedMs = Date.now() - started;
      if (reason === "needs_approval") this.reportedApprovals.set(sessionId, session?.revision);
      else if (session?.status !== "needs_approval") this.reportedApprovals.delete(sessionId);
      if (!session) return { sessionId, reason, exitCode: null, waitedMs, output: "" };
      let observable = false;
      try { observable = Boolean(this.observableSession(sessionId)); } catch { observable = false; }
      let output = "";
      let exitLines: string | null = null;
      if (observable) {
        try {
          const buffer = this.terminals.readBuffer(sessionId).buffer;
          output = await this.screenText(sessionId, buffer, MAX_OBSERVE_CHARS);
          if (session.exitCode !== null) exitLines = await this.screenExitLines(sessionId, buffer);
        } catch { output = ""; }
      }
      const answer = reason === "timeout" || reason === "needs_approval" ? null : this.answer(sessionId);
      return { sessionId, reason, status: session.status, exitCode: session.exitCode, waitedMs, output,
        ...(exitLines ? { exitLines } : {}), ...(answer ? { answer } : this.answerUnavailable(sessionId)) };
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
      // A prompt this wait already returned (the card has not changed since) is the person's to answer: wait for it.
      const reported = this.reportedApprovals.has(sessionId) && this.reportedApprovals.get(sessionId) === session.revision;
      if (session.status === "needs_approval" && !reported) return answer(session, "needs_approval");
      if (session.status !== "needs_approval") this.reportedApprovals.delete(sessionId);
      // After a prompt, an idle that no turn followed (the CLI's startup idle, or one reported before the turn began)
      // is not the answer: only an idle after a turn that started since that prompt is. A CLI that never reports its
      // turns still ends as "quiet" once its screen stops changing.
      const progress = this.turnProgress(sessionId);
      const awaitingTurn = progress !== null && progress.promptSent && !progress.turnStartedSincePrompt;
      if (!awaitingTurn && (session.status === "idle" || session.status === "done" || session.status === "failed") && quietFor >= timing.settleMs) {
        return answer(session, session.status);
      }
      if ((session.status === "unavailable" || awaitingTurn) && quietFor >= timing.quietMs) return answer(session, "quiet");
      const waited = now - started;
      if (waited >= timeoutMs) return answer(session, "timeout");
      await pause(Math.min(timing.checkMs, timeoutMs - waited), signal);
    }
  }

  cancel(sessionId: string): void {
    this.requireSession(sessionId);
    this.terminals.dispose(sessionId);
  }

  /** Through the terminal manager's one delivery rule: exactly once, into the launch that is starting now. */
  private async deliver(sessionId: string, data: string, what: "prompt" | "text", signal?: AbortSignal, waitMs?: number): Promise<void> {
    // waitMs (AGENT_TOOL_DELIVERY_MS for the orchestration tools) also caps the wait for Codex's composer.
    const codex = this.requireSession(sessionId).provider === "codex";
    const delivery = await this.terminals.deliverInput(sessionId, data, waitMs, signal, codex);
    if (!delivery.delivered) {
      throw new PromptNotDeliveredError(sessionId, `The ${what} for agent ${sessionId} was not delivered: ${delivery.reason}`);
    }
  }

  /**
   * The last lines of the screen, rendered like `output` (a TUI that redraws only the cells that changed would
   * otherwise read as its redraws joined together) from the same window as `output` (a line drawn early and never
   * redrawn, such as the model's status line, is still on the screen), masked before it is cut and again after.
   */
  private async screenExitLines(sessionId: string, buffer: string): Promise<string | null> {
    const source = fromSequenceBoundary(this.redactTail(buffer, MAX_SCREEN_SOURCE_CHARS), buffer.length > MAX_SCREEN_SOURCE_CHARS);
    let screen: string;
    try {
      screen = this.redactTail(await renderedTerminalText(source, this.geometry(sessionId)), MAX_SCREEN_SOURCE_CHARS);
    } catch {
      screen = source;
    }
    const text = terminalFailureDetails(screen);
    if (!text) return null;
    return text.split("\n").slice(-MAX_EXIT_LINES).join("\n");
  }

  /**
   * The text the agent's terminal shows, as plain text: a TUI's redraws (cursor moves, erases, colors) rendered by a
   * headless terminal instead of returned as escape sequences. Masked twice: the scrollback before it is rendered
   * (a held value the TUI wrote whole is gone before any redraw can split it), and the rendered text before its
   * last `maxChars` are cut (a value the screen shows across wrapped rows or box sides). Should the rendering fail,
   * the masked raw tail is returned as before.
   */
  private async screenText(sessionId: string, buffer: string, maxChars: number): Promise<string> {
    const source = fromSequenceBoundary(this.redactTail(buffer, MAX_SCREEN_SOURCE_CHARS), buffer.length > MAX_SCREEN_SOURCE_CHARS);
    try {
      return this.redactTail(await renderedTerminalText(source, this.geometry(sessionId)), maxChars);
    } catch {
      return this.redactTail(buffer, maxChars);
    }
  }

  private geometry(sessionId: string): { cols: number; rows: number } | null {
    try { return typeof this.terminals.geometry === "function" ? this.terminals.geometry(sessionId) : null; } catch { return null; }
  }

  /** Plugin launch secrets never reach another agent through observed output: the tail as masking the whole text leaves it. */
  private redactTail(text: string, maxChars: number): string {
    if (typeof this.terminals.redactSecretsTail === "function") return this.terminals.redactSecretsTail(text, maxChars);
    return tail(typeof this.terminals.redactSecrets === "function" ? this.terminals.redactSecrets(text) : text, maxChars);
  }

  private turnProgress(sessionId: string): { promptSent: boolean; turnStartedSincePrompt: boolean } | null {
    try { return typeof this.terminals.turnProgress === "function" ? this.terminals.turnProgress(sessionId) : null; } catch { return null; }
  }

  /** Says so when no answer can be captured for this agent, so an orchestrator reads its output instead of waiting for one. */
  private answerUnavailable(sessionId: string): { answerUnavailable?: AgentAnswerUnavailable } {
    try {
      const reason = typeof this.terminals.answerUnavailable === "function" ? this.terminals.answerUnavailable(sessionId) : null;
      return reason === "status_hooks_off" ? { answerUnavailable: { reason, message: STATUS_HOOKS_OFF_MESSAGE } } : {};
    } catch { return {}; }
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

/** send_to_agent while the subagent's card waits for the person (needs_approval). */
export const APPROVAL_REFUSAL = "This subagent is waiting for the person to answer a prompt in its card (needs_approval); "
  + "only the person may answer it, so nothing was sent. Tell the person what it asks (wait_for_agent's output shows it), "
  + "then call wait_for_agent again: it waits for their answer.";

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
 * same folder on macOS). A relative folder is taken from the orchestrator's own folder. Never CanvasTTY's private
 * data under `userDataPath` (a project such as the home folder contains it): a folder inside one plugin's data only
 * when the project itself is a folder inside that same plugin's data (an environment's worktree).
 */
export function subagentFolder(projectRoot: string, parentCwd: string, requested: unknown, userDataPath?: string): { cwd: string } | { error: string } {
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
  if (userDataPath && insidePrivateData(root, folder, userDataPath, real)) {
    return { error: `A subagent cannot work in ${requested}: it is CanvasTTY's private data (tokens, account homes, plugins' data). Only the person can start an agent there.` };
  }
  return { cwd: folder };
}

/**
 * `folder` (a real path) is inside CanvasTTY's private data, and not inside a project that is itself a folder within
 * one plugin's data (an environment's worktree; then that plugin folder is the project's own).
 */
function insidePrivateData(root: string, folder: string, userDataPath: string, real: (path: string) => string | null): boolean {
  const inside = (base: string, path: string): boolean => isPathInside(base, path) || isPathInside(base.normalize("NFC"), path.normalize("NFC"));
  const data = real(resolve(userDataPath)) ?? resolve(userDataPath);
  for (const hidden of privateAppData(data)) {
    const base = real(hidden) ?? hidden;
    if (!inside(base, folder)) continue;
    if (hidden !== join(data, PLUGIN_DATA_FOLDER)) return true;
    // <plugin-data>/<pluginId>/…: the project must be strictly inside that same plugin's folder.
    const plugin = relative(base.normalize("NFC"), folder.normalize("NFC")).split(sep)[0];
    if (!plugin) return true;
    const pluginFolder = join(base, plugin);
    if (!inside(pluginFolder, root) || inside(root, pluginFolder)) return true;
  }
  return false;
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

function spawnCanceled(): Error {
  return new DOMException("The spawn was canceled before its agent started.", "AbortError");
}

/**
 * A window cut from the end of a terminal stream may begin inside an escape sequence, whose rest (`18;9H`, `m`) a
 * terminal would print as text. A cut window therefore starts at its first escape or line break instead.
 */
function fromSequenceBoundary(window: string, cut: boolean): string {
  if (!cut) return window;
  const starts = [window.indexOf("\u001b"), window.indexOf("\n")].filter((index) => index >= 0);
  return starts.length > 0 ? window.slice(Math.min(...starts)) : window;
}
