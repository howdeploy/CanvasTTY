import { UNVERIFIED_EXECUTION_PROTECTION, type ExecutionProtection } from "../../shared/executionProtection.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentProviderId, LaunchProfileId, SessionRole } from "../../shared/contracts.ts";
import type { RuntimePermissionDecision, RuntimePermissionRequest } from "./agent-runtime/RuntimeGateway.ts";
import { actionFromHook, checkBaseProtection } from "./safety/baseProtection.ts";
import type { PrivateData } from "./safety/commandFacts.ts";
import { DEFAULT_DECIDE_TIMEOUT_MS, MAX_DECIDE_TIMEOUT_MS } from "../../agent-runtime/runtime-protocol.mjs";

/** A trusted plugin service that declared `decide` (PluginManager.decisionServices). */
export interface DecisionService {
  pluginId: string;
  pluginName: string;
  serviceId: string;
  /** Agents it decides for; all when omitted. */
  appliesTo?: AgentProviderId[];
  /** The person separately let this plugin allow tool calls. Without it an allow counts as no opinion. */
  mayAllow: boolean;
  /** Its `decide.timeoutMs`: how long it may take (1-60 s); 3 s when omitted. */
  timeoutMs?: number;
}

/** What the core knows about the session a hook call comes from. */
export interface DecisionSession {
  provider: AgentProviderId;
  role: SessionRole;
  /** The session's working folder: "outside" is measured from here. */
  cwd: string;
  /** The agent's own config folders (CLAUDE_CONFIG_DIR of this run), whose plans and memory are not "outside". */
  configDirs: string[];
  /** The profile the card runs in. */
  profile?: LaunchProfileId;
}

/**
 * Whether the agent's hook can hand a question to the person. Only Claude Code takes "ask" from a hook; for every
 * other CLI an ask would silently become "go on", so it is a deny with the reason instead.
 */
export function hookCanAsk(provider: AgentProviderId): boolean {
  return provider === "claude";
}

export interface DecisionHooksDependencies {
  executionProtection?(sessionId: string): ExecutionProtection;
  baseProtection(): boolean;
  services(): DecisionService[];
  call(pluginId: string, serviceId: string, method: "canvastty.decide", params: unknown, timeoutMs: number): Promise<unknown>;
  session(sessionId: string): DecisionSession | null;
  /** Host-owned root task, scoped to the receiving plugin. */
  launchOptions?(sessionId: string, pluginId: string): { task?: string; dataClass?: string } | undefined;
  /** Core-owned human approval path; never exposed as a plugin capability. */
  humanApprovalEnabled?(): boolean;
  resolveHumanAsk?(
    sessionId: string,
    request: RuntimePermissionRequest,
    decision: RuntimePermissionDecision,
    signal: AbortSignal
  ): Promise<"allow" | "deny" | null>;
  home?: string;
  /** CanvasTTY's own tokens, secret stores and sockets (canvasTtyPrivateData of its userData folder). */
  privateData?: PrivateData;
  timeoutMs?: number;
}

/** What a decision service receives (`canvastty.decide`). */
export interface DecisionRequest {
  executionProtection?: ExecutionProtection;
  event: "pre-tool";
  sessionId: string;
  provider: AgentProviderId;
  role: SessionRole;
  cwd: string;
  /** The agent's current folder as its CLI reported it, when it did. */
  agentCwd: string | null;
  tool: { name: string; kind: "shell" | "edit" | "other"; command: string | null; paths: string[] };
  /** The tool input as the agent sent it; null when it was over 40 KB (then `truncated`). */
  input: unknown;
  truncated: boolean;
  /** How long CanvasTTY waits for this answer (the service's `decide.timeoutMs`, capped by the session's gate). */
  budgetMs: number;
  /** The card's launch profile (auto, normal, acceptEdits, plan, yolo). */
  profile: LaunchProfileId | null;
  /** The agent can put an "ask" in front of the person; false: an ask is turned into a deny with its reason. */
  canAsk: boolean;
  launchOptions?: { task?: string; dataClass?: string };
}

type Verdict = "deny" | "ask" | "allow";
interface Answer { verdict: Verdict | null; reason: string; service: DecisionService }

const DECIDE_TIMEOUT_MS = DEFAULT_DECIDE_TIMEOUT_MS;
/** Base protection's answer to a shell call, or a file write whose target it cannot see, cut before it was sent. */
export const TOO_LARGE_MESSAGE = 'CanvasTTY blocked this tool call: its input is too large to check (over 40 KB), so base protection cannot see what it does. Split the work into smaller steps: keep commands short, and write long content with the file tool in parts.';
const MAX_REASON = 500;
const MAX_SERVICES = 8;

/**
 * Decision hooks (EP-5). For every shell or file-writing tool call an agent's hook reports, base protection runs
 * first and its deny is final. Then trusted decision services run in parallel within their configured budgets; any
 * deny wins. An ask can be resolved only by the trusted core human path when enabled. Otherwise Claude keeps its
 * native ask and other CLIs are denied. An allow counts only from a plugin the person separately let allow.
 */
export class DecisionHooks {
  private readonly deps: DecisionHooksDependencies;

  constructor(deps: DecisionHooksDependencies) {
    this.deps = deps;
  }

  /** Whether a launch of this agent needs the decision hook at all. A plugin list that cannot be read counts as yes. */
  wanted(provider: AgentProviderId): boolean {
    if (this.protects()) return true;
    const services = this.applicable(provider);
    return services === null || services.length > 0;
  }

  /** The longest plugin or human wait for this agent: the session's gate is sized for it at launch. */
  budgetMs(provider: AgentProviderId): number {
    return Math.max(
      DECIDE_TIMEOUT_MS,
      ...(this.humanApprovalEnabled() ? [MAX_DECIDE_TIMEOUT_MS] : []),
      ...(this.applicable(provider) ?? []).map((service) => this.timeoutFor(service))
    );
  }

  private timeoutFor(service: DecisionService): number {
    return this.deps.timeoutMs ?? service.timeoutMs ?? DECIDE_TIMEOUT_MS;
  }

  async decide(sessionId: string, request: RuntimePermissionRequest, signal: AbortSignal): Promise<RuntimePermissionDecision> {
    const session = this.deps.session(sessionId);
    if (!session) return { behavior: "none" };
    if (this.protects()) {
      const home = this.deps.home ?? homedir();
      const base = checkBaseProtection({
        toolName: request.toolName,
        toolInput: request.toolInput,
        preview: request.toolInputPreview,
        root: session.cwd,
        commandCwd: request.cwd,
        home,
        agentRoots: [join(home, ".claude"), ...session.configDirs],
        ...(this.deps.privateData ? { privateData: this.deps.privateData } : {})
      });
      if (base) return { behavior: "deny", message: base.message };
      // Cut input: the rules could not see the command, or where a file tool writes. Unchecked is not allowed.
      if (request.truncated) {
        const cut = actionFromHook(request.toolName, request.toolInput, request.toolInputPreview);
        if (cut.kind === "shell" || cut.kind === "edit" && cut.paths.length === 0) return { behavior: "deny", message: TOO_LARGE_MESSAGE };
      }
    }
    const services = this.applicable(session.provider);
    // The plugin list itself failed: that is the gateway's failure (the person is asked, or a fail-closed gate
    // denies), never "no plugin has an opinion".
    if (services === null) throw new Error("decision services unavailable");
    if (services.length === 0) return { behavior: "none" };
    const action = actionFromHook(request.toolName, request.toolInput, request.toolInputPreview);
    const params: Omit<DecisionRequest, "budgetMs"> = {
      event: "pre-tool",
      sessionId,
      provider: session.provider,
      role: session.role,
      cwd: session.cwd,
      agentCwd: request.cwd,
      tool: { name: request.toolName, kind: action.kind ?? "other", command: action.command, paths: action.paths },
      input: request.toolInput,
      truncated: request.truncated,
      profile: session.profile ?? null,
      canAsk: hookCanAsk(session.provider)
    };
    // A service trusted after this card started gets no more time than the card's gate allows; the signal ends it.
    const answers = await Promise.all(services.map((service) => {
      const timeoutMs = this.timeoutFor(service);
      return this.ask(service, { ...params, executionProtection: this.deps.executionProtection?.(sessionId) ?? UNVERIFIED_EXECUTION_PROTECTION, launchOptions: this.deps.launchOptions?.(sessionId, service.pluginId), budgetMs: timeoutMs }, timeoutMs, signal);
    }));
    const merged = mergeDecisions(answers, request.truncated);
    if (merged.behavior === "ask") {
      const human = await this.resolveHumanAsk(sessionId, request, merged, signal);
      if (human) return { behavior: human, message: human === "allow" ? "Approved by the person." : "Denied by the person." };
    }
    // An agent that cannot ask would go on as if nobody objected: the person has to approve, so it is stopped.
    if (merged.behavior === "ask" && !hookCanAsk(session.provider)) {
      return { behavior: "deny", message: `${merged.message ?? "CanvasTTY asks the person about this tool call."} ${session.provider} cannot ask the person from here, so it was not run: tell the person what you want to do and why, and let them decide.` };
    }
    return merged;
  }

  private humanApprovalEnabled(): boolean {
    try { return this.deps.humanApprovalEnabled?.() === true; } catch { return false; }
  }

  private async resolveHumanAsk(
    sessionId: string,
    request: RuntimePermissionRequest,
    decision: RuntimePermissionDecision,
    signal: AbortSignal
  ): Promise<"allow" | "deny" | null> {
    const resolver = this.deps.resolveHumanAsk;
    if (!this.humanApprovalEnabled() || !resolver || signal.aborted) return null;
    try {
      const result = await resolver(sessionId, request, decision, signal);
      if (signal.aborted || result !== "allow" && result !== "deny") return null;
      return result;
    } catch {
      return null;
    }
  }

  private protects(): boolean {
    // A settings read that fails counts as on.
    try { return this.deps.baseProtection() !== false; } catch { return true; }
  }

  /** The decision services for this agent; null when the list could not be read. */
  private applicable(provider: AgentProviderId): DecisionService[] | null {
    let services: DecisionService[];
    try { services = this.deps.services(); } catch { return null; }
    return services
      .filter((service) => !service.appliesTo || service.appliesTo.includes(provider))
      .slice(0, MAX_SERVICES);
  }

  private async ask(service: DecisionService, params: DecisionRequest, timeoutMs: number, signal: AbortSignal): Promise<Answer> {
    const late = (reason: string): Answer => ({ verdict: "ask", reason, service });
    if (signal.aborted) return late("it did not answer in time");
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        this.deps.call(service.pluginId, service.serviceId, "canvastty.decide", params, timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("did not answer in time")), timeoutMs);
          onAbort = () => reject(new Error("did not answer in time"));
          signal.addEventListener("abort", onAbort, { once: true });
        })
      ]);
      return parseAnswer(result, service);
    } catch (error) {
      const message = error instanceof Error && /in time/iu.test(error.message) ? "it did not answer in time" : "it could not answer";
      return late(message);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}

/** `null`, `{}` or `{ verdict: "none" }` is no opinion; anything unreadable is an ask. */
function parseAnswer(value: unknown, service: DecisionService): Answer {
  if (value === null || value === undefined) return { verdict: null, reason: "", service };
  if (typeof value !== "object" || Array.isArray(value)) return { verdict: "ask", reason: "its answer could not be read", service };
  const record = value as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? clean(record.reason) : "";
  if (record.verdict === undefined || record.verdict === "none") return { verdict: null, reason, service };
  if (record.verdict === "deny" || record.verdict === "ask" || record.verdict === "allow") return { verdict: record.verdict, reason, service };
  return { verdict: "ask", reason: "its answer could not be read", service };
}

/** Any deny wins; else any ask; else an allow from a plugin the person let allow; else no verdict. */
export function mergeDecisions(answers: readonly Answer[], truncated: boolean): RuntimePermissionDecision {
  const because = (answer: Answer): string => answer.reason ? ` (${answer.reason.replace(/[.!?\s]+$/u, "")})` : "";
  const deny = answers.find((answer) => answer.verdict === "deny");
  if (deny) {
    return { behavior: "deny", message: `CanvasTTY plugin "${deny.service.pluginName}" blocked this tool call${because(deny)}. If it is needed, ask the person.` };
  }
  const ask = answers.find((answer) => answer.verdict === "ask");
  if (ask) return { behavior: "ask", message: `CanvasTTY plugin "${ask.service.pluginName}" asks the person about this tool call${because(ask)}.` };
  const allow = answers.find((answer) => answer.verdict === "allow" && answer.service.mayAllow);
  // Cut input is never allowed: the plugin did not see all of it.
  if (allow && truncated) return { behavior: "ask", message: "The tool input was too large to check in full." };
  if (allow) return { behavior: "allow", message: `Allowed by CanvasTTY plugin "${allow.service.pluginName}"${because(allow)}.` };
  return { behavior: "none" };
}

function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/gu, " ").trim().slice(0, MAX_REASON);
}
