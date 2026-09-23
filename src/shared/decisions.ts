import {
  CANVAS_LAUNCHER_ITEMS,
  DATA_CLASSES,
  REASONING_EFFORTS,
  reasoningEffortsFor,
  type AgentProviderId,
  type CreateSessionRequest,
  type DataClass,
  type ReasoningEffort,
  type SessionSnapshot
} from './contracts.ts';

export const DECISION_CATEGORIES = ['general', 'code', 'review', 'research', 'writing'] as const;
export type DecisionCategory = typeof DECISION_CATEGORIES[number];
/** How hard the person expects the task to be; it steers the effort/cost trade-off. */
export const DECISION_DIFFICULTIES = ['simple', 'normal', 'hard'] as const;
export type DecisionDifficulty = typeof DECISION_DIFFICULTIES[number];
/** 1 = cheapest / weakest, 5 = most expensive / strongest. Absent means "derive from effort". */
export type DecisionScore = 1 | 2 | 3 | 4 | 5;

export const MAX_DECISION_ROUTES = 48;
export const MAX_DECISION_RULES = 32;

export interface DecisionRoute {
  id: string;
  provider: AgentProviderId;
  accountId?: string;
  model?: string;
  /** Reasoning effort passed to the CLI; absent keeps its default. */
  effort?: ReasoningEffort;
  /** Operator's relative cost and answer-quality estimates for this exact tuple. */
  cost?: DecisionScore;
  quality?: DecisionScore;
  hostId: string;
  transport: 'pty' | 'acp';
}

export interface DecisionRule {
  id: string;
  category?: DecisionCategory;
  taskContains?: string;
  pathPattern?: string;
  maxDataClass?: DataClass;
  prefer: string[];
}

export interface DecisionSettings {
  mode: 'off' | 'rules' | 'jev';
  routes: DecisionRoute[];
  rules: DecisionRule[];
  /** Add every launchable agent/account/computer tuple at recommendation time. */
  autoRoutes: boolean;
  /** Effort variants generated for agents whose CLI supports reasoning effort. */
  autoEfforts: ReasoningEffort[];
  jevModel: string;
  cloudMetadata: boolean;
  /** Highest task class whose literal text may be sent to Jev; 'off' never sends it. */
  taskText: 'off' | 'D1' | 'D2';
  minConfidence: number;
  maxCallsPerMinute: number;
}

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  mode: 'off',
  routes: [],
  rules: [],
  autoRoutes: true,
  autoEfforts: ['low', 'medium', 'high'],
  jevModel: 'jev-latest',
  cloudMetadata: false,
  taskText: 'off',
  minConfidence: 0.8,
  maxCallsPerMinute: 6
};

export type DecisionInput = Omit<CreateSessionRequest, 'provider' | 'position' | 'role' | 'parentSessionId' | 'containerPlacement'> & {
  category?: DecisionCategory;
  difficulty?: DecisionDifficulty;
  provider?: AgentProviderId;
};

export interface DecisionRecommendation {
  id: string;
  selected: DecisionRoute;
  /** True when the selected tuple was assembled automatically rather than configured. */
  automatic: boolean;
  engine: 'rules' | 'jev';
  ruleId?: string;
  confidence: number | null;
  fallbackReason?: string;
  expiresAt: number;
  dataClass: DataClass;
  contextBytes: number;
  candidateCount: number;
  evaluatorModel: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
}

export interface DecisionApi {
  recommend(input: DecisionInput): Promise<DecisionRecommendation>;
  launch(id: string, position: { x: number; y: number }): Promise<SessionSnapshot>;
  cancel(id: string): Promise<void>;
  /** Preview of automatically assembled tuples for the given effort variants. */
  assemble(efforts: ReasoningEffort[]): Promise<DecisionRoute[]>;
  secretStatus(): Promise<{ configured: boolean }>;
  setSecret(value: string): Promise<void>;
  removeSecret(): Promise<void>;
}

export function exactRecord(value: unknown, allowed: readonly string[], required: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid decision fields.');
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export function decisionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid decision identity.');
}

export const JEV_MODEL = /^jev-(?:latest|[0-9]+(?:\.[0-9]+){0,2})$/u;

function isScore(value: unknown): value is DecisionScore {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function isEffortList(value: unknown): value is ReasoningEffort[] {
  return Array.isArray(value) && value.length <= REASONING_EFFORTS.length && new Set(value).size === value.length
    && value.every(item => (REASONING_EFFORTS as readonly unknown[]).includes(item));
}

export function validateDecisionRoute(route: unknown): asserts route is DecisionRoute {
  exactRecord(route, ['id', 'provider', 'accountId', 'model', 'effort', 'cost', 'quality', 'hostId', 'transport'], ['id', 'provider', 'hostId', 'transport']);
  decisionId(route.id);
  decisionId(route.hostId);
  if (route.provider === 'terminal' || !CANVAS_LAUNCHER_ITEMS.includes(route.provider as AgentProviderId) || !['pty', 'acp'].includes(route.transport as string)) throw new Error('Invalid decision runtime.');
  if (route.accountId !== undefined) decisionId(route.accountId);
  if (route.model !== undefined && (typeof route.model !== 'string' || !route.model.trim() || route.model.length > 100 || /[\x00-\x1f\x7f*]/u.test(route.model))) throw new Error('Routing requires a concrete model.');
  if (route.effort !== undefined && (route.transport !== 'pty' || !reasoningEffortsFor(route.provider as AgentProviderId).includes(route.effort as ReasoningEffort))) throw new Error('This agent does not support the selected reasoning effort.');
  if (route.cost !== undefined && !isScore(route.cost) || route.quality !== undefined && !isScore(route.quality)) throw new Error('Route cost and quality must be 1-5.');
}

export function validateDecisionSettings(value: unknown): DecisionSettings {
  const keys = ['mode', 'routes', 'rules', 'autoRoutes', 'autoEfforts', 'jevModel', 'cloudMetadata', 'taskText', 'minConfidence', 'maxCallsPerMinute'];
  exactRecord(value, keys, keys);
  if (!['off', 'rules', 'jev'].includes(value.mode as string) || typeof value.cloudMetadata !== 'boolean' || typeof value.autoRoutes !== 'boolean'
    || !isEffortList(value.autoEfforts) || !['off', 'D1', 'D2'].includes(value.taskText as string)
    || typeof value.jevModel !== 'string' || !JEV_MODEL.test(value.jevModel)
    || typeof value.minConfidence !== 'number' || !Number.isFinite(value.minConfidence) || value.minConfidence < 0 || value.minConfidence > 1
    || !Number.isInteger(value.maxCallsPerMinute) || (value.maxCallsPerMinute as number) < 1 || (value.maxCallsPerMinute as number) > 60) throw new Error('Invalid decision configuration.');
  if (!Array.isArray(value.routes) || value.routes.length > MAX_DECISION_ROUTES || !Array.isArray(value.rules) || value.rules.length > MAX_DECISION_RULES) throw new Error('Decision route/rule limit exceeded.');
  const ids = new Set<string>();
  for (const route of value.routes) {
    validateDecisionRoute(route);
    if (ids.has(route.id)) throw new Error('Duplicate route identity.');
    ids.add(route.id);
  }
  const rules = new Set<string>();
  for (const rule of value.rules) {
    exactRecord(rule, ['id', 'category', 'taskContains', 'pathPattern', 'maxDataClass', 'prefer'], ['id', 'prefer']);
    decisionId(rule.id);
    if (rules.has(rule.id)) throw new Error('Duplicate rule identity.');
    rules.add(rule.id);
    if (rule.category !== undefined && !DECISION_CATEGORIES.includes(rule.category as DecisionCategory) || rule.maxDataClass !== undefined && !DATA_CLASSES.includes(rule.maxDataClass as DataClass)) throw new Error('Invalid rule classification.');
    for (const key of ['taskContains', 'pathPattern']) {
      const text = rule[key];
      if (text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > 200 || /[\x00-\x1f\x7f]/u.test(text))) throw new Error('Invalid rule text.');
    }
    if (!Array.isArray(rule.prefer) || !rule.prefer.length || rule.prefer.length > 16 || new Set(rule.prefer).size !== rule.prefer.length || rule.prefer.some(id => !ids.has(id))) throw new Error('Rule references an unknown or duplicate route.');
  }
  return structuredClone(value) as unknown as DecisionSettings;
}

/** Settings saved before newer fields existed keep their routes and rules. */
export function normalizeDecisionSettings(value: unknown): DecisionSettings {
  try {
    const legacy = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return validateDecisionSettings({ ...DEFAULT_DECISION_SETTINGS, ...legacy });
  } catch {
    return structuredClone(DEFAULT_DECISION_SETTINGS);
  }
}

const EFFORT_COST: Record<ReasoningEffort, DecisionScore> = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const EFFORT_QUALITY: Record<ReasoningEffort, DecisionScore> = { minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 5 };

/** Declared estimates win; otherwise effort gives a relative ordering; otherwise unknown. */
export function routeEconomics(route: Pick<DecisionRoute, 'effort' | 'cost' | 'quality'>): { cost: DecisionScore | null; quality: DecisionScore | null } {
  return {
    cost: route.cost ?? (route.effort ? EFFORT_COST[route.effort] : null),
    quality: route.quality ?? (route.effort ? EFFORT_QUALITY[route.effort] : null)
  };
}

/** Stable identity of an execution tuple, used to merge configured and automatic routes. */
export function routeTupleKey(route: Pick<DecisionRoute, 'provider' | 'accountId' | 'model' | 'effort' | 'hostId' | 'transport'>): string {
  return JSON.stringify([route.provider, route.accountId ?? null, route.model ?? null, route.effort ?? null, route.hostId, route.transport]);
}
