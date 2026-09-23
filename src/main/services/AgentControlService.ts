import type {
  AgentProviderId,
  DataClass,
  LaunchProfileId,
  ProviderAccount,
  SessionSnapshot
} from "../../shared/contracts.ts";
import {
  CANVAS_LAUNCHER_ITEMS,
  DATA_CLASS_RANK,
  PROVIDER_CAPABILITIES,
  accountEffectiveMaxDataClass,
  accountSupportsModel,
  dataClassSatisfies,
  eligibleAccountsForModel,
  providerMaxDataClass
} from "../../shared/contracts.ts";
import type { TerminalManager } from "./TerminalManager.ts";
import type { PlacementDecision, PlacementRequest } from "./HostPlacement.ts";

// Roadmap F1 preview: a programmatic parent must not be able to fan out
// without bound. The real budgets setting arrives with resource management;
// until then this hard cap is the only backstop.
const MAX_CHILDREN_PER_PARENT = 16;
const MAX_OBSERVE_CHARS = 8_192;
const CHILD_POSITION_STEP = { x: 60, y: 60 };

// A requested host is either the literal "auto" or something shaped like a
// host id. Settings ids are free-form strings, but the spawn surface only ever
// echoes one back to the terminal manager, so a conservative shape — no
// whitespace, no shell punctuation — is required up front rather than trusted.
const SPAWN_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

// Account ids ride the same conservative shape for the same reason: the id is
// only ever echoed into session metadata, never executed, but a malformed one
// must fail loudly at the boundary instead of reaching the launch layer.
const SPAWN_ACCOUNT_ID_PATTERN = SPAWN_HOST_ID_PATTERN;
const SPAWN_MODEL_MAX_LENGTH = 100;

// Every agent provider id, for the cross-provider account lookup below.
const AGENT_PROVIDERS: readonly AgentProviderId[] = CANVAS_LAUNCHER_ITEMS.filter(
  (id): id is AgentProviderId => id !== "terminal"
);

export interface SpawnAgentRequest {
  parentSessionId: string;
  provider: AgentProviderId;
  cwd: string;
  profile?: LaunchProfileId;
  title?: string;
  /** Prompt written into the new agent's PTY immediately after launch. */
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
}

/** Service-level policy (Roadmap D4). defaultDataClass classifies tasks that
 *  carry no explicit dataClass of their own. */
export interface AgentControlOptions {
  defaultDataClass?: DataClass;
  /** Accounts per provider, injected as a GETTER so every spawn reads the
   *  live settings rather than a constructor-time snapshot. Absent disables
   *  account routing entirely (fail-open: models pass through unrestricted
   *  and no accountId is recorded) — the wiring until the settings plumbing
   *  lands is tests-only. */
  accounts?: (provider: AgentProviderId) => ProviderAccount[];
  /** Path-class resolver (Roadmap D6): maps a session cwd to the data class
   *  the operator's pathPolicies assign it, or null when no policy covers
   *  the path. Absent disables path classification entirely. A resolved
   *  class can only RAISE the effective tier (strictest-of request, default,
   *  and path), never lower it, and the raise rides the same
   *  policyConfigured fail-open condition as the provider gate: with no
   *  classification in play at all, spawning keeps its pre-policy behavior.
   *  The resolver should be a pure settings lookup; a throwing or malformed
   *  result reads as "no policy" so broken wiring can never take spawning
   *  down. */
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

  // Synchronous for every host choice that needs no probing: local, a concrete
  // host id (validated downstream by the terminal manager), and "auto" with no
  // coordinator attached, which fails open to a local spawn. Only "auto" with
  // a coordinator returns a promise, because placement probes hosts
  // asynchronously; callers can always simply await the result.
  spawn(request: SpawnAgentRequest): SessionSnapshot | Promise<SessionSnapshot> {
    if (!request || typeof request.parentSessionId !== "string") {
      throw new Error("A parent session id is required.");
    }
    this.requireSession(request.parentSessionId);
    const capabilities = PROVIDER_CAPABILITIES[request.provider];
    if (!capabilities) throw new Error("Unknown agent provider.");
    if (!capabilities.send) throw new Error(`${request.provider} cannot receive prompts.`);

    // Roadmap D4 + D6: the confidentiality gate. Classification follows the
    // data, never the vendor brand: a task may only reach providers whose
    // default data-handling path is cleared for the task's tier or higher,
    // and the error names both sides of the violation. The tier starts from
    // the request (or the service default) — D2 once any classification is
    // in play, because an unclassified repo is never implicitly public — and
    // the task's PATH can only raise it: a restricted cwd (pathClass
    // resolver) tightens the check even without an explicit dataClass, while
    // a public path never lowers an explicit or default classification. A
    // caller that supplies no classification at all keeps the pre-policy
    // behavior until the settings wiring turns the option on for every
    // spawn.
    const policyConfigured = request.dataClass !== undefined
      || this.options?.defaultDataClass !== undefined;
    const pathClass = resolvePathClass(this.options?.pathClass, request.cwd);
    const requestedDataClass = request.dataClass ?? this.options?.defaultDataClass ?? "D2";
    const effectiveDataClass = pathClass !== null
      && DATA_CLASS_RANK[pathClass] > DATA_CLASS_RANK[requestedDataClass]
      ? pathClass
      : requestedDataClass;
    if (policyConfigured) {
      const maxDataClass = providerMaxDataClass(request.provider);
      if (!dataClassSatisfies(effectiveDataClass, maxDataClass)) {
        throw new Error(
          `Provider ${request.provider} handles at most ${maxDataClass}; this task is ${effectiveDataClass}.`
        );
      }
    }
    const host = normalizeSpawnHost(request.host);
    const model = normalizeSpawnModel(request.model);

    // Multi-account routing: pick WHICH subscription of the provider runs
    // this task. Runs after the privacy gate and before placement, so a tier
    // or shared-account violation fails loudly without probing any host.
    // With no accounts getter attached the stage fails open — the model (and
    // any accountId) pass through unvalidated, exactly the pre-account
    // behavior.
    const account = this.resolveAccount(request, model, effectiveDataClass);

    // "auto" asks placement WHERE the session should run. The provider was
    // fixed by the caller and is passed through untouched — the scheduler can
    // only pick a location, never a different model or CLI. A local decision
    // (or no coordinator at all) drops the hostId and spawns locally. When
    // any classification is in play the effective class rides along so hosts
    // are filtered by their own ceilings too (Roadmap D5); with none in play
    // the request keeps its legacy shape.
    const classified = policyConfigured || pathClass !== null;
    if (host === "auto" && this.placement) {
      const placement = this.placement;
      return placement
        .place({
          provider: request.provider,
          localWorkspace: request.cwd,
          ...(classified ? { dataClass: effectiveDataClass } : {})
        })
        .then((decision) => this.createChild(
          request,
          decision.kind === "remote" ? decision.host.id : undefined,
          account?.id
        ));
    }
    return this.createChild(request, host === "auto" ? undefined : host, account?.id);
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
    const providerAccounts = accountsFor(request.provider);
    if (request.accountId !== undefined) {
      const accountId = normalizeSpawnAccountId(request.accountId);
      const account = providerAccounts.find((candidate) => candidate.id === accountId);
      if (!account) {
        throw new Error(accountLookupError(accountsFor, request.provider, accountId));
      }
      return this.requireAccountCovers(account, model, providerAccounts, request, effectiveDataClass);
    }
    // No model given: no account filtering in v1 — the CLI keeps whatever
    // default model it would have picked.
    if (model === undefined || providerAccounts.length === 0) return undefined;
    const eligible = eligibleAccountsForModel(providerAccounts, request.provider, model);
    if (eligible.length === 0) {
      throw new Error(`No ${request.provider} account covers model ${model}.`);
    }
    // Deterministic v1: the FIRST eligible account in settings order wins.
    // Load- and quota-aware selection arrives with resource management.
    return this.requireAccountCovers(eligible[0]!, model, providerAccounts, request, effectiveDataClass);
  }

  /** The two checks every selected account passes: its tier covers the
   *  requested model, and its effective data-class cap (which shared accounts
   *  tighten) admits the task's tier — the PATH-RAISED tier, so a restricted
   *  cwd cannot slip past a shared-account cap on a technically-D1 request.
   *  The privacy check rides the same policyConfigured condition as the
   *  provider gate above: with no classification in play at all, the account
   *  stage keeps the pre-policy behavior instead of imposing an implicit D2. */
  private requireAccountCovers(
    account: ProviderAccount,
    model: string | undefined,
    providerAccounts: readonly ProviderAccount[],
    request: SpawnAgentRequest,
    effectiveDataClass: DataClass
  ): ProviderAccount {
    if (!accountSupportsModel(account, model)) {
      const eligible = eligibleAccountsForModel(providerAccounts, request.provider, model)
        .map((candidate) => candidate.label);
      throw new Error(
        `Account ${account.label}${account.tier !== undefined ? ` (tier ${account.tier})` : ""} does not cover model ${model}; eligible accounts: ${eligible.length > 0 ? eligible.join(", ") : "none"}.`
      );
    }
    const policyConfigured = request.dataClass !== undefined
      || this.options?.defaultDataClass !== undefined;
    if (policyConfigured) {
      const accountCap = accountEffectiveMaxDataClass(account);
      if (!dataClassSatisfies(effectiveDataClass, accountCap)) {
        throw new Error(
          `Account ${account.label} handles at most ${accountCap}; this task is ${effectiveDataClass}.`
        );
      }
    }
    return account;
  }

  private createChild(request: SpawnAgentRequest, hostId?: string, accountId?: string): SessionSnapshot {
    const parent = this.requireSession(request.parentSessionId);
    const cascade = this.children(parent.id).length;
    if (cascade >= MAX_CHILDREN_PER_PARENT) {
      throw new Error(`Session ${parent.id} already has ${MAX_CHILDREN_PER_PARENT} subagents.`);
    }
    const created = this.terminals.create({
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
      ...(accountId !== undefined ? { accountId } : {})
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

// Runs the injected path-class resolver defensively: the resolver is settings
// wiring, and a broken or malformed lookup must read as "no policy" (null),
// never as a failed spawn.
function resolvePathClass(
  resolver: ((cwd: string) => DataClass | null) | undefined,
  cwd: string
): DataClass | null {
  if (resolver === undefined) return null;
  try {
    const resolved = resolver(cwd);
    if (typeof resolved !== "string") return null;
    const rank = (DATA_CLASS_RANK as Record<string, number>)[resolved];
    return rank === undefined ? null : resolved as DataClass;
  } catch {
    return null;
  }
}

// Validates the requested host: undefined (local), "auto", or a host-id-shaped
// string. Anything else throws before the parent is even counted — a malformed
// host must fail loudly at the boundary instead of reaching the launch layer.
function normalizeSpawnHost(host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  if (typeof host !== "string") throw new Error("Agent host must be \"auto\" or a host id.");
  if (host === "auto") return host;
  if (!SPAWN_HOST_ID_PATTERN.test(host)) {
    throw new Error(`Agent host must be "auto" or a host id: ${JSON.stringify(host)}.`);
  }
  return host;
}

// Validates the requested model: undefined (the CLI's own default) or a short
// non-blank id. The string is placement bookkeeping, never a shell argument,
// but a malformed value still fails at the boundary rather than trusted.
function normalizeSpawnModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  if (typeof model !== "string") throw new Error("Agent model must be a string.");
  if (model.trim().length === 0 || model.length > SPAWN_MODEL_MAX_LENGTH) {
    throw new Error(
      `Agent model must be a non-blank string of at most ${SPAWN_MODEL_MAX_LENGTH} characters.`
    );
  }
  return model;
}

// Account ids share the host-id shape: short, no whitespace, no shell
// punctuation. An explicit accountId that cannot even be an id fails here.
function normalizeSpawnAccountId(accountId: string): string {
  if (typeof accountId !== "string" || !SPAWN_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error(`Agent account id must be an account id: ${JSON.stringify(accountId)}.`);
  }
  return accountId;
}

// Explains WHY an explicit accountId could not be used, naming what was
// found: an account with that id under a DIFFERENT provider is reported as a
// provider mismatch; an id configured nowhere is reported as missing.
function accountLookupError(
  accountsFor: (provider: AgentProviderId) => ProviderAccount[],
  provider: AgentProviderId,
  accountId: string
): string {
  for (const candidate of AGENT_PROVIDERS) {
    if (candidate === provider) continue;
    if (accountsFor(candidate).some((account) => account.id === accountId)) {
      return `Account ${accountId} belongs to provider ${candidate}, not ${provider}.`;
    }
  }
  return `Account ${accountId} is not configured.`;
}
