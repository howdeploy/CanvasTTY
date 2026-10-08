export type ExecutionGoal = "auto" | "balanced" | "fast" | "economical" | "deep";
export type ResolvedExecutionGoal = Exclude<ExecutionGoal, "auto">;
export interface ExecutionStrategy {
  requested: ExecutionGoal;
  resolved: ResolvedExecutionGoal;
  source: "person" | "jev" | "fallback";
  maxConcurrent: number;
  review: "normal" | "required";
  reason: string;
  category?: "code" | "review" | "research" | "writing" | "general";
  difficulty?: "simple" | "normal" | "hard";
  confident?: boolean;
}
export const EXECUTION_CAPS: Record<ResolvedExecutionGoal, number> = { balanced: 2, fast: 4, economical: 1, deep: 3 };
export function isExecutionGoal(value: unknown): value is ExecutionGoal {
  return typeof value === "string" && ["auto", "balanced", "fast", "economical", "deep"].includes(value);
}
/** Only the host sets concurrency and review policy; persisted/plugin-supplied values never raise them. */
export function executionStrategy(requested: ExecutionGoal, resolved: ResolvedExecutionGoal, source: ExecutionStrategy["source"], reason: string): ExecutionStrategy {
  return { requested, resolved, source, maxConcurrent: EXECUTION_CAPS[resolved], review: resolved === "deep" ? "required" : "normal", reason: reason.slice(0, 500) };
}
export function normalizeExecutionStrategy(value: unknown): ExecutionStrategy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<ExecutionStrategy>;
  if (!isExecutionGoal(row.requested) || !isExecutionGoal(row.resolved) || String(row.resolved) === "auto"
    || !["person", "jev", "fallback"].includes(String(row.source)) || typeof row.reason !== "string") return undefined;
  if (row.requested === "auto" && row.source === "person") return undefined;
  if (row.requested !== "auto" && (row.resolved !== row.requested || row.source !== "person")) return undefined;
  return { ...executionStrategy(row.requested, row.resolved, row.source!, row.reason),
    ...(["code", "review", "research", "writing", "general"].includes(String(row.category)) ? { category: row.category } : {}),
    ...(["simple", "normal", "hard"].includes(String(row.difficulty)) ? { difficulty: row.difficulty } : {}),
    ...(typeof row.confident === "boolean" ? { confident: row.confident } : {}) };
}
export function executionGuidance(strategy: ExecutionStrategy): string {
  const work = strategy.resolved === "fast" ? "Split only independent work, run those parts concurrently, then synthesize and verify the result. More agents can increase total tokens."
    : strategy.resolved === "economical" ? "Use the minimum number of workers; reuse findings and keep prompts focused. Verify the final result."
    : strategy.resolved === "deep" ? "Use independent perspectives on difficult questions, reconcile disagreements, and verify the result. Every worker requires a separate read-only review; an unavailable review is not acceptance."
    : "Split independent work when useful and verify the final result.";
  return `Execution goal: ${strategy.resolved}. ${work} At most ${strategy.maxConcurrent} live subagents including reviewers, further restricted by the person's limits and shared budget. Cancel finished idle cards to free capacity. No strategy grants additional permissions.`;
}
