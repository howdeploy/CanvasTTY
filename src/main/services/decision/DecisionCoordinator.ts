import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DATA_CLASS_RANK, REASONING_EFFORTS, type AgentProviderId, type AppSettings, type CreateSessionRequest, type DataClass, type LimitsSnapshot, type ReasoningEffort, type SessionSnapshot } from '../../../shared/contracts.ts';
import { DECISION_CATEGORIES, DECISION_DIFFICULTIES, exactRecord, routeEconomics, validateDecisionSettings, type DecisionInput, type DecisionRecommendation, type DecisionRoute } from '../../../shared/decisions.ts';
import { assertContextLaunchSelection } from '../../../shared/contextRuntime.ts';
import type { TerminalManager, OwnedContextLaunch } from '../TerminalManager.ts';
import type { AgentControlService } from '../AgentControlService.ts';
import type { DecisionSecrets } from './DecisionSecrets.ts';
import { JevBackend } from './JevBackend.ts';
import { MAX_DECISION_CHOICES, validateEvaluationResult, type DecisionBackend, type EvaluationRequest } from './DecisionBackend.ts';
import { rankRoutes } from './rules.ts';
import { assembleDecisionRoutes, mergeDecisionRoutes } from './routeAssembly.ts';

type Route = DecisionRoute & { automatic: boolean };
interface Candidate { route: Route; request: CreateSessionRequest; context: OwnedContextLaunch }
interface Pending { controller: AbortController; owner?: string; expiresAt: number; inputHash: string; selected?: Candidate; assertCurrent(excludeId?: string): void }
type Headroom = 'high' | 'medium' | 'low' | null;

const INPUT_KEYS = ['cwd', 'profile', 'initialPrompt', 'dataClass', 'context', 'allowSubagents', 'transport', 'accountId', 'model', 'effort', 'hostId', 'isolation', 'category', 'difficulty', 'provider', 'title'];
const TASK_TEXT_LIMIT = 2000;
const LIMITS_TIMEOUT_MS = 2000;

function policySnapshot(settings: AppSettings): string {
  return JSON.stringify([settings.decisions, settings.defaultDataClass, settings.pathPolicies, settings.providerAccounts, settings.apiProfiles, settings.remoteHosts, settings.agentBudgets, settings.maxAccountsPerProviderPerHost, settings.requiresSandboxProfiles, settings.containerProfiles, settings.contextProfilesEnabled]);
}

/** Highest used share across a provider's reported windows, bucketed. Only ambient CLI logins are
 * measured by LimitsService, so account-bound routes stay unknown. */
function headroomByProvider(snapshot: LimitsSnapshot | null): Map<AgentProviderId, Headroom> {
  const result = new Map<AgentProviderId, Headroom>();
  for (const entry of snapshot?.providers ?? []) {
    if (entry.state === 'unavailable') continue;
    const used = entry.windows.map(window => window.usedPercent).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (!used.length) continue;
    const peak = Math.max(...used);
    result.set(entry.provider, peak < 50 ? 'high' : peak < 85 ? 'medium' : 'low');
  }
  return result;
}

function describeCandidate(candidate: Record<string, unknown>): string {
  return Object.entries(candidate).filter(([key]) => key !== 'id').map(([key, value]) => `${key}: ${value ?? 'unknown'}`).join('; ');
}

export interface DecisionCoordinatorOptions {
  settings(): AppSettings;
  terminals: TerminalManager;
  control: AgentControlService;
  secrets: Pick<DecisionSecrets, 'get' | 'generation'>;
  providerSecretGeneration?(): number;
  remoteAvailable?(hostId: string, provider: DecisionRoute['provider']): boolean;
  /** Local CLI detection, used only to assemble automatic routes. */
  localCliAvailable?(provider: AgentProviderId): boolean;
  /** Cached subscription usage; read only when an evaluator call is about to be made. */
  limits?(): Promise<LimitsSnapshot | null>;
  backend?: DecisionBackend;
  now?(): number;
}

/** No constructor I/O, polling, model workers or background recommendations. */
export class DecisionCoordinator {
  private readonly options: DecisionCoordinatorOptions;
  private readonly pending = new Map<string, Pending>();
  private calls: number[] = [];
  private disposed = false;

  constructor(options: DecisionCoordinatorOptions) { this.options = options; }

  private now(): number { return (this.options.now ?? Date.now)(); }

  invalidate(owner?: string): void {
    for (const [id, pending] of this.pending) {
      if (owner === undefined || pending.owner === owner) { pending.controller.abort(new Error('Decision authority changed.')); this.pending.delete(id); }
    }
  }

  dispose(): void { this.disposed = true; this.invalidate(); }

  cancel(id: string, owner?: string): void {
    const pending = this.pending.get(id);
    if (pending && pending.owner !== owner) throw new Error('Recommendation belongs to another caller.');
    pending?.controller.abort();
    this.pending.delete(id);
  }

  /** Preview of automatic tuples; the same assembly runs at recommendation time. */
  assemble(efforts: unknown): DecisionRoute[] {
    if (!Array.isArray(efforts) || efforts.length > REASONING_EFFORTS.length || efforts.some(effort => !(REASONING_EFFORTS as readonly unknown[]).includes(effort))) throw new Error('Invalid reasoning effort list.');
    return this.automaticRoutes(this.options.settings(), efforts as ReasoningEffort[]);
  }

  private automaticRoutes(settings: AppSettings, efforts: readonly ReasoningEffort[]): DecisionRoute[] {
    return assembleDecisionRoutes(settings, {
      localCli: provider => this.options.localCliAvailable?.(provider) ?? false,
      remoteAvailable: (hostId, provider) => this.options.remoteAvailable?.(hostId, provider) ?? false
    }, efforts);
  }

  private sessions(excludeId?: string): string {
    return JSON.stringify(this.options.terminals.listMetadata().filter(s => s.id !== excludeId).map(s => [s.id, s.provider, s.role, s.allowSubagents, s.parentSessionId, s.hostId, s.accountId, s.model, s.effort, s.dataClass, s.disclosureClass, s.exitCode, s.startedAt, s.launchBinding]));
  }

  private async headroom(): Promise<Map<AgentProviderId, Headroom>> {
    if (!this.options.limits) return new Map();
    try {
      const snapshot = await Promise.race([this.options.limits(), new Promise<null>(resolve => setTimeout(() => resolve(null), LIMITS_TIMEOUT_MS))]);
      return headroomByProvider(snapshot);
    } catch { return new Map(); }
  }

  async recommend(input: DecisionInput, owner?: string, signal?: AbortSignal): Promise<DecisionRecommendation> {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('Decision coordinator is disposed.');
    const settings = this.options.settings(), config = validateDecisionSettings(settings.decisions);
    if (config.mode === 'off') throw new Error('Decision routing is disabled.');
    exactRecord(input, INPUT_KEYS, ['cwd', 'profile']);
    if (typeof input.cwd !== 'string' || input.cwd.length > 4096 || !isAbsolute(input.cwd) || /[\x00-\x1f\x7f]/u.test(input.cwd)
      || input.category !== undefined && !DECISION_CATEGORIES.includes(input.category)
      || input.difficulty !== undefined && !DECISION_DIFFICULTIES.includes(input.difficulty)
      || input.effort !== undefined && !(REASONING_EFFORTS as readonly unknown[]).includes(input.effort)
      || input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)
      || Buffer.byteLength(JSON.stringify(input)) > 196608) throw new Error('Invalid decision launch request.');
    if (input.isolation?.mode === 'container' && input.isolation.capsuleId) throw new Error('Selected-file capsule routing is owned by the capsule operation.');
    if (input.context !== undefined) { if (owner !== undefined) throw new Error('Child context is inherited.'); assertContextLaunchSelection(input.context); }
    input = structuredClone(input);
    if (owner) input.cwd = this.options.terminals.resolveOwnedChildCwd(input.cwd, owner);
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex'), snapshot = policySnapshot(settings), sessions = this.sessions();
    const secretGeneration = this.options.secrets.generation, providerGeneration = this.options.providerSecretGeneration?.();
    const id = randomUUID(), controller = new AbortController(), expiresAt = this.now() + 60000;
    const candidates: Candidate[] = [];
    const remoteAvailable = this.options.remoteAvailable ?? (() => false);
    const assertCurrent = (excludeId?: string): void => {
      signal?.throwIfAborted(); controller.signal.throwIfAborted();
      const currentSettings = this.options.settings();
      if (this.disposed || this.now() >= expiresAt || policySnapshot(currentSettings) !== snapshot || this.sessions(excludeId) !== sessions
        || this.options.secrets.generation !== secretGeneration || this.options.providerSecretGeneration?.() !== providerGeneration) throw new Error('Recommendation expired or policy changed. Recommend again.');
      for (const candidate of candidates) {
        candidate.context.assertAuthority?.(); candidate.context.capture?.assertCurrent(); candidate.context.context?.assertCurrent();
        this.options.terminals.assertDecisionRuntime(candidate.request, currentSettings, remoteAvailable);
      }
    };
    const routes: Route[] = config.autoRoutes
      ? mergeDecisionRoutes(config.routes, this.automaticRoutes(settings, config.autoEfforts))
      : config.routes.map(route => ({ ...route, automatic: false }));
    // Ephemeral per-provider captures deliberately preserve the exact final provider's context projection.
    for (const route of routes) {
      if (input.provider !== undefined && input.provider !== route.provider || input.accountId !== undefined && input.accountId !== route.accountId
        || input.model !== undefined && input.model !== route.model || input.effort !== undefined && input.effort !== route.effort
        || input.hostId !== undefined && input.hostId !== route.hostId || input.transport !== undefined && input.transport !== route.transport) continue;
      const { category: _category, difficulty: _difficulty, provider: _provider, hostId: _host, ...base } = input;
      const request: CreateSessionRequest = {
        ...base, provider: route.provider, accountId: route.accountId, model: route.model, hostId: route.hostId === 'local' ? undefined : route.hostId, transport: route.transport,
        ...(route.effort ? { effort: route.effort } : {}), position: { x: 0, y: 0 },
        ...(owner ? { parentSessionId: owner, role: 'subagent', allowSubagents: input.allowSubagents ?? false } : {})
      };
      try {
        const context = this.options.terminals.prepareContextLaunch(request);
        const evaluated = this.options.terminals.evaluateContextLaunch(request, context);
        // Routing chooses automatically, so the ambient provider estimate is enforced rather than warned.
        if ((evaluated as { privacyNotice?: unknown }).privacyNotice) continue;
        this.options.terminals.assertDecisionRuntime(evaluated, settings, remoteAvailable);
        const fixed = { ...route, ...(evaluated.accountId !== undefined ? { accountId: evaluated.accountId } : {}), ...(evaluated.model !== undefined ? { model: evaluated.model } : {}) };
        // Policy may fill an ambient account/default model, but never reinterpret an explicit binding.
        if (route.accountId !== undefined && route.accountId !== evaluated.accountId || route.model !== undefined && route.model !== evaluated.model || evaluated.hostId !== request.hostId) continue;
        candidates.push({ route: fixed, request: evaluated, context });
      } catch { /* Invalid tuples are removed before evaluator credentials or egress. */ }
    }
    if (!candidates.length) throw new Error('No eligible configured route satisfies policy, runtime and capacity constraints.');
    const dataClass = candidates.reduce<DataClass>((max, c) => DATA_CLASS_RANK[c.request.dataClass!] > DATA_CLASS_RANK[max] ? c.request.dataClass! : max, candidates[0]!.request.dataClass!);
    const ranked = rankRoutes(config, { ...input, dataClass }, candidates.map(c => c.route));
    let selected = candidates.find(c => c.route.id === ranked.routes[0]!.id)!;
    for (const [key, value] of this.pending) if (value.expiresAt <= this.now()) { value.controller.abort(); this.pending.delete(key); }
    if (this.pending.size >= 64) throw new Error('Recommendation limit reached. Cancel an unused recommendation.');
    const pending: Pending = { controller, owner, expiresAt, inputHash, assertCurrent };
    this.pending.set(id, pending);
    const abort = (): void => { controller.abort(signal?.reason); this.pending.delete(id); };
    signal?.addEventListener('abort', abort, { once: true });
    let engine: DecisionRecommendation['engine'] = 'rules', confidence: number | null = null, fallbackReason: string | undefined, evaluatorModel: string | null = null, usage: DecisionRecommendation['usage'] = null;
    try {
      assertCurrent();
      if (config.mode === 'jev' && candidates.length > 1 && !ranked.ruleId) {
        if (!config.cloudMetadata) fallbackReason = 'metadata-grant-required';
        else {
          this.calls = this.calls.filter(at => at > this.now() - 60000);
          if (this.calls.length >= config.maxCallsPerMinute) fallbackReason = 'evaluation-budget';
          else {
            let key: string | null = null;
            try { key = await this.options.secrets.get(); } catch { fallbackReason = 'credential-unavailable'; }
            assertCurrent();
            this.calls = this.calls.filter(at => at > this.now() - 60000);
            if (this.calls.length >= config.maxCallsPerMinute) fallbackReason = 'evaluation-budget';
            else if (!key) fallbackReason ??= 'credential-required';
            else {
              // Reserve the evaluator slot before any further await so concurrent requests cannot overshoot the budget.
              this.calls.push(this.now());
              const choices = ranked.routes.slice(0, MAX_DECISION_CHOICES);
              const headroom = await this.headroom();
              assertCurrent();
              const taskText = config.taskText !== 'off' && input.initialPrompt?.trim() && DATA_CLASS_RANK[dataClass] <= DATA_CLASS_RANK[config.taskText]
                ? input.initialPrompt.trim().slice(0, TASK_TEXT_LIMIT) : undefined;
              const state = {
                task: { category: input.category ?? 'general', difficulty: input.difficulty ?? 'unknown', dataClass, delegation: input.allowSubagents === true, ...(taskText ? { text: taskText } : {}) },
                candidates: choices.map((route, rank) => {
                  const economics = routeEconomics(route);
                  return {
                    id: `c${rank}`, rank, agent: route.provider, model: route.model ?? 'default', effort: route.effort ?? 'default',
                    cost: economics.cost, quality: economics.quality, local: route.hostId === 'local', transport: route.transport,
                    limitHeadroom: route.accountId === undefined ? headroom.get(route.provider) ?? null : null
                  };
                })
              };
              const request: EvaluationRequest = {
                model: config.jevModel, state,
                questions: { route: {
                  type: 'choice',
                  instructions: 'Choose the route most likely to complete this task correctly at the lowest total cost. Cost and quality are relative 1-5 estimates (null = unknown). Higher reasoning effort usually improves accuracy on hard, ambiguous or multi-step work but spends more tokens, time and subscription limits; simple tasks should use low effort and cost. Avoid routes whose limit headroom is low. When traits do not distinguish routes, prefer the lower rank.',
                  criteria: Object.fromEntries(state.candidates.map(candidate => [candidate.id, describeCandidate(candidate)]))
                } }
              };
              try {
                const result = validateEvaluationResult(await (this.options.backend ?? new JevBackend()).evaluate(request, key, controller.signal), request);
                assertCurrent();
                evaluatorModel = result.model; usage = result.usage;
                const answer = result.answers.route;
                if (!answer || answer.type !== 'choice') throw new Error('Invalid routing result.');
                const index = state.candidates.findIndex(c => c.id === answer.choice);
                if (index < 0) throw new Error('Unknown route.');
                if (answer.confidence < config.minConfidence) fallbackReason = 'low-confidence';
                else { selected = candidates.find(c => c.route.id === choices[index]!.id)!; engine = 'jev'; confidence = answer.confidence; }
              } catch { assertCurrent(); fallbackReason = 'evaluation-unavailable'; }
            }
          }
        }
      }
      assertCurrent();
      pending.selected = selected;
      const { automatic, ...route } = selected.route;
      return {
        id, selected: structuredClone(route), automatic, engine, confidence, ...(ranked.ruleId ? { ruleId: ranked.ruleId } : {}), ...(fallbackReason ? { fallbackReason } : {}),
        expiresAt, dataClass: selected.request.dataClass!, contextBytes: Buffer.byteLength(selected.context.context?.text ?? ''), candidateCount: candidates.length, evaluatorModel, usage
      };
    } catch (error) { controller.abort(); this.pending.delete(id); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  async launch(id: string, owner?: string, position = { x: 0, y: 0 }, signal?: AbortSignal): Promise<SessionSnapshot> {
    if (typeof id !== 'string' || id.length > 64) throw new Error('Invalid recommendation ID.');
    exactRecord(position, ['x', 'y'], ['x', 'y']);
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Invalid launch position.');
    const pending = this.pending.get(id);
    if (!pending?.selected || pending.owner !== owner) throw new Error('Recommendation is absent or belongs to another caller.');
    signal?.throwIfAborted(); pending.assertCurrent(); this.pending.delete(id);
    const { request, context } = pending.selected;
    this.options.terminals.evaluateContextLaunch(request, context);
    const guard = (excludeId?: string): void => { signal?.throwIfAborted(); pending.assertCurrent(excludeId); };
    if (!owner) return this.options.terminals.createPlanned({ ...request, position }, context, guard);
    return await this.options.control.spawnDecision({
      parentSessionId: owner, provider: request.provider as DecisionRoute['provider'], cwd: request.cwd, profile: request.profile, model: request.model, effort: request.effort,
      accountId: request.accountId, dataClass: request.dataClass, host: request.hostId, transport: request.transport, isolation: request.isolation,
      initialPrompt: request.initialPrompt, title: request.title, allowSubagents: request.allowSubagents
    }, { context, assertCurrent: guard }, signal);
  }
}
