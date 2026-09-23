import { assertIsolationRequest } from "../../shared/isolation.ts";
import type {
  AgentProviderId,
  IsolationRequest,
  DataClass,
  LaunchProfileId,
  ProviderAccount,
  SessionSnapshot
} from "../../shared/contracts.ts";
import {
  CANVAS_LAUNCHER_ITEMS,
  DATA_CLASS_RANK,
  PROVIDER_CAPABILITIES,
  dataClassSatisfies,
  providerMaxDataClass
} from "../../shared/contracts.ts";
import { assertLaunchPolicyFields, selectLaunchAccount } from "./SessionLaunchPolicy.ts";
import type { TerminalManager } from "./TerminalManager.ts";
import type { PlacementDecision, PlacementRequest } from "./HostPlacement.ts";

// Compatibility backstop for embedders without a configured launch policy.
// Production also applies the live, conservative AgentBudgets at launch.
const MAX_CHILDREN_PER_PARENT = 16;
const MAX_OBSERVE_CHARS = 8_192;
const CHILD_POSITION_STEP = { x: 60, y: 60 };

// A requested host is either the literal "auto" or something shaped like a
// host id. Settings ids are free-form strings, but the spawn surface only ever
// echoes one back to the terminal manager, so a conservative shape — no
// whitespace, no shell punctuation — is required up front rather than trusted.
const SPAWN_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

// Every agent provider id, for the cross-provider account lookup below.
const AGENT_PROVIDERS: readonly AgentProviderId[] = CANVAS_LAUNCHER_ITEMS.filter(
  (id): id is AgentProviderId => id !== "terminal"
);

export interface SpawnAgentRequest {
  isolation?: IsolationRequest;
  parentSessionId: string;
  provider: AgentProviderId;
  cwd: string;
  profile?: LaunchProfileId;
  title?: string;
  /** Prompt queued until the new agent's PTY is ready. */
  initialPrompt?: string;
  /** WHERE the agent should run — never WHICH agent: "auto" asks the
   *  placement coordinator to pick a configured host, a host id names one
   *  explicitly, and undefined stays local. The provider is always the
   *  orchestrator's choice; placement decides location only. */
  host?: string;
  /** Confidentiality tier of the data this task will touch (Roadmap D4).
   *  Absent falls back to the service's defaultDataClass option, and beyond
   *  that to D2 — an unclassified repo is never implicitly public. */
  dataClass?: DataClass;
  /** Model the orchestrator wants this account's tier to run. With account
   *  routing configured it must be covered by the chosen (or some) account
   *  of the provider; absent means no account filtering (v1). */
  model?: string;
  /** Explicit provider account (AppSettings.providerAccounts id). Must
   *  exist, belong to request.provider, cover request.model, and be cleared
   *  for the task's data class under the account's own (possibly shared,
   *  possibly tightened) cap. */
  accountId?: string;
  allowSubagents?: boolean;
}

/** Legacy embedding options. Production configures SessionLaunchPolicy on the
 * terminal manager so every entry point, including restore, shares live policy. */
export interface AgentControlOptions {
  defaultDataClass?: DataClass;
  accounts?: (provider: AgentProviderId) => ProviderAccount[];
  /** Optional cwd classification. Failures reject the launch. */
  pathClass?: (cwd: string) => DataClass | null;
}

/** What spawn("auto") needs from the placement layer: a decision for one
 *  provider and local workspace. HostPlacementService satisfies this shape;
 *  tests inject a fake. Absent entirely, "auto" fails open to a local spawn. */
export interface AgentPlacementCoordinator {
  place(request: PlacementRequest): Promise<PlacementDecision>;
}

export interface AgentObservation {
  sessionId: string;
  status: SessionSnapshot["status"];
  /** Raw terminal tail, capped; capabilities with result \"none\" see nothing. */
  output: string;
}

export interface AgentResult {
  sessionId: string;
  state: "running" | "done" | "failed";
  exitCode: number | null;
  output: string;
}

export class AgentControlService {
  private readonly terminals: TerminalManager;
  private readonly placement?: AgentPlacementCoordinator;
  private readonly options?: AgentControlOptions;

  constructor(
    terminals: TerminalManager,
    placement?: AgentPlacementCoordinator,
    options?: AgentControlOptions
  ) {
    this.terminals = terminals;
    this.placement = placement;
    this.options = options;
  }

  // Local launches remain synchronous. Remote placement (automatic or explicit)
  // uses async preflight when configured; callers may always await the result.
  spawn(request: SpawnAgentRequest): SessionSnapshot | Promise<SessionSnapshot> {
    if (!request || typeof request.parentSessionId !== "string") {
      throw new Error("A parent session id is required.");
    }
    if (request.initialPrompt !== undefined && (typeof request.initialPrompt !== "string" || request.initialPrompt.length >= 131_072)) throw new Error("Initial agent prompt exceeds the input limit or is invalid.");
    const parent = this.requireSession(request.parentSessionId);
    if (parent.role === "subagent" && parent.allowSubagents !== true) throw new Error("Agent delegation is disabled for this parent.");
    assertLaunchPolicyFields(request);
    assertIsolationRequest(request.isolation);
    if (request.isolation?.mode === "worktree" && request.host !== undefined) throw new Error("Worktree isolation supports local launches only.");
    if (request.isolation?.mode === "container" && request.host === "auto") throw new Error("Container launch requires the exact host configured in its profile; automatic host placement is unavailable.");
    const capabilities = PROVIDER_CAPABILITIES[request.provider];
    if (!capabilities) throw new Error("Unknown agent provider.");
    if (!capabilities.send) throw new Error(`${request.provider} cannot receive prompts.`);

    // Preserve policy checks for legacy embedders; production is checked again
    // by TerminalManager immediately before launching.
    const policyConfigured = request.dataClass !== undefined
      || this.options?.defaultDataClass !== undefined
      || this.options?.pathClass !== undefined;
    const pathClass = resolvePathClass(this.options?.pathClass, request.cwd);
    const requestedDataClass = request.dataClass ?? this.options?.defaultDataClass ?? "D2";
    const effectiveDataClass = pathClass !== null
      && DATA_CLASS_RANK[pathClass] > DATA_CLASS_RANK[requestedDataClass]
      ? pathClass
      : requestedDataClass;
    if (policyConfigured && !this.terminals.hasLaunchPolicy()) {
      const maxDataClass = providerMaxDataClass(request.provider);
      if (!dataClassSatisfies(effectiveDataClass, maxDataClass)) {
        throw new Error(
          `Provider ${request.provider} handles at most ${maxDataClass}; this task is ${effectiveDataClass}.`
        );
      }
    }
    const host = normalizeSpawnHost(request.host);
    const model = request.model;

    const account = this.resolveAccount(request, model, effectiveDataClass);

    const classifiedLaunch = this.terminals.classifyLaunchRequest({
      isolation: request.isolation, provider: request.provider, cwd: request.cwd, profile: request.profile ?? "normal",
      position: { x: 0, y: 0 },
      ...(request.dataClass !== undefined ? { dataClass: request.dataClass } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(request.accountId !== undefined ? { accountId: request.accountId } : {}),
      ...(host !== undefined && host !== "auto" ? { hostId: host } : {})
    }, host === "auto");
    const classified = policyConfigured || pathClass !== null || classifiedLaunch.dataClass !== undefined;
    if (host === "auto") {
      const eligibleAccounts = this.terminals.placementAccounts(classifiedLaunch)
        ?? (account ? [account] : undefined);
      const hostIds = eligibleAccounts ? [...new Set(eligibleAccounts.map((candidate) => candidate.hostId ?? "local"))] : undefined;
      const localAccount = eligibleAccounts?.find((candidate) => (candidate.hostId ?? "local") === "local");
      if (hostIds?.every((id) => id === "local")) return this.createChild(request, undefined, localAccount?.id);
      if (!this.placement) {
        if (eligibleAccounts && !localAccount) throw new Error("Bound account host is unavailable: no placement coordinator.");
        return this.createChild(request, undefined, localAccount?.id);
      }
      return this.placement.place({
        provider: request.provider, localWorkspace: request.cwd,
        ...(classified ? { dataClass: classifiedLaunch.dataClass ?? effectiveDataClass } : {}),
        ...(hostIds ? { eligibleHostIds: hostIds.filter((id) => id !== "local") } : {})
      }).then((decision) => {
        const hostId = decision.kind === "remote" ? decision.host.id : "local";
        const selected = eligibleAccounts?.find((candidate) => (candidate.hostId ?? "local") === hostId);
        if (eligibleAccounts && !selected) throw new Error(`Bound account host is unavailable: ${decision.kind === "local" ? decision.reason : "placement selected an unbound host"}.`);
        return this.createChild(request, hostId === "local" ? undefined : hostId, selected?.id);
      });
    }
    // Explicit MCP hosts use the same dynamic preflight, restricted to exactly
    // that host. The synchronous terminal boundary still rechecks live policy.
    if (host !== undefined && this.placement && request.isolation?.mode !== "container") {
      return this.placement.place({ provider: request.provider, localWorkspace: request.cwd,
        ...(classified ? { dataClass: classifiedLaunch.dataClass ?? effectiveDataClass } : {}), eligibleHostIds: [host]
      }).then((decision) => {
        if (decision.kind !== "remote" || decision.host.id !== host) throw new Error(`Requested host ${host} is unavailable: ${decision.kind === "local" ? decision.reason : "host mismatch"}.`);
        return this.createChild(request, host, classifiedLaunch.accountId ?? account?.id);
      });
    }
    return this.createChild(request, host, classifiedLaunch.accountId ?? account?.id);
  }

  /** Account selection for one spawn. Returns the account to record on the
   *  session, or undefined when no account machinery applies (no getter, no
   *  model, or no accounts configured for the provider). Throws before
   *  anything launches when the explicit or auto-picked account does not
   *  cover the model or the task's data class. */
  private resolveAccount(
    request: SpawnAgentRequest,
    model: string | undefined,
    effectiveDataClass: DataClass
  ): ProviderAccount | undefined {
    const accountsFor = this.options?.accounts;
    if (!accountsFor) return undefined;
    const accounts = AGENT_PROVIDERS.flatMap((provider) => accountsFor(provider));
    const classified = request.dataClass !== undefined || this.options?.defaultDataClass !== undefined || this.options?.pathClass !== undefined;
    // Legacy callers without a model keep their default CLI unless explicit.
    if (model === undefined && request.accountId === undefined) return undefined;
    return selectLaunchAccount(accounts, request.provider, model, request.accountId, classified ? effectiveDataClass : undefined);
  }

  private createChild(request: SpawnAgentRequest, hostId?: string, accountId?: string): SessionSnapshot {
    const parent = this.requireSession(request.parentSessionId);
    if (parent.role === "subagent" && parent.allowSubagents !== true) throw new Error("Agent delegation is disabled for this parent.");
    const cascade = this.children(parent.id).length;
    if (!this.terminals.hasLaunchPolicy() && this.children(parent.id).filter((child) => child.exitCode === null).length >= MAX_CHILDREN_PER_PARENT) {
      throw new Error(`Session ${parent.id} already has ${MAX_CHILDREN_PER_PARENT} subagents.`);
    }
    const created = this.terminals.create({
      ...(request.isolation ? { isolation: request.isolation } : {}),
      provider: request.provider,
      cwd: request.cwd,
      profile: request.profile ?? "normal",
      position: {
        x: parent.position.x + CHILD_POSITION_STEP.x * (cascade + 1),
        y: parent.position.y + CHILD_POSITION_STEP.y * (cascade + 1)
      },
      ...(request.title !== undefined ? { title: request.title } : {}),
      role: "subagent",
      parentSessionId: parent.id,
      ...(hostId !== undefined ? { hostId } : {}),
      ...((accountId ?? request.accountId) !== undefined ? { accountId: accountId ?? request.accountId } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.dataClass !== undefined ? { dataClass: request.dataClass } : {}),
      allowSubagents: request.allowSubagents ?? false
    });
    if (request.initialPrompt !== undefined && request.initialPrompt.length > 0) {
      this.send(created.id, request.initialPrompt);
    }
    return created;
  }

  send(sessionId: string, text: string, submit = true): void {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (!capabilities.send) throw new Error(`${session.provider} cannot receive prompts.`);
    if (typeof text !== "string" || text.length === 0) throw new Error("Prompt text is required.");
    if (session.exitCode !== null) throw new Error("Agent session has already exited.");
    this.terminals.input(sessionId, submit ? `${text}\r` : text);
  }

  status(sessionId: string): SessionSnapshot {
    return this.requireSession(sessionId);
  }

  children(parentSessionId: string): SessionSnapshot[] {
    this.requireSession(parentSessionId);
    return this.terminals.list()
      .filter((session) => session.parentSessionId === parentSessionId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** True when sessionId is parentSessionId itself or any of its descendants. */
  isInSubtree(parentSessionId: string, sessionId: string): boolean {
    if (typeof parentSessionId !== "string" || typeof sessionId !== "string") return false;
    const snapshots = new Map(this.terminals.list().map((session) => [session.id, session]));
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
    return {
      sessionId: session.id,
      status: session.status,
      output: tail(this.terminals.readBuffer(sessionId).buffer, maxChars)
    };
  }

  result(sessionId: string): AgentResult {
    const session = this.requireSession(sessionId);
    if (session.provider === "terminal") throw new Error("Plain terminals are not agents.");
    const capabilities = PROVIDER_CAPABILITIES[session.provider as AgentProviderId];
    if (capabilities.result === "none") {
      return { sessionId: session.id, state: "running", exitCode: session.exitCode, output: "" };
    }
    const buffer = capabilities.result === "terminal"
      ? this.terminals.readBuffer(sessionId).buffer
      : "";
    return {
      sessionId: session.id,
      state: session.exitCode === null
        ? "running"
        : session.exitCode === 0 ? "done" : "failed",
      exitCode: session.exitCode,
      output: tail(buffer, MAX_OBSERVE_CHARS)
    };
  }

  cancel(sessionId: string): void {
    this.requireSession(sessionId);
    this.terminals.dispose(sessionId);
  }

  private requireSession(sessionId: string): SessionSnapshot {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("A session id is required.");
    }
    const session = this.terminals.list().find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("Terminal session does not exist.");
    return session;
  }
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

// A configured resolver is a policy boundary: lookup failures cannot loosen it.
function resolvePathClass(
  resolver: ((cwd: string) => DataClass | null) | undefined,
  cwd: string
): DataClass | null {
  if (resolver === undefined) return null;
  const resolved = resolver(cwd);
  if (resolved === null) return null;
  if (typeof resolved !== "string" || (DATA_CLASS_RANK as Record<string, number>)[resolved] === undefined) {
    throw new Error("Invalid path data class returned by launch policy.");
  }
  return resolved;
}

// Validates the requested host: undefined (local), "auto", or a host-id-shaped
// string. Anything else throws before the parent is even counted — a malformed
// host must fail loudly at the boundary instead of reaching the launch layer.
function normalizeSpawnHost(host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  if (typeof host !== "string") throw new Error("Agent host must be \"auto\" or a host id.");
  if (host === "auto") return host;
  if (host === "local") return undefined;
  if (!SPAWN_HOST_ID_PATTERN.test(host)) {
    throw new Error(`Agent host must be "auto" or a host id: ${JSON.stringify(host)}.`);
  }
  return host;
}
