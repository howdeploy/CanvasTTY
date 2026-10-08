import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface OrchestrationBudgetLimits {
  tokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface OrchestrationBudgetUsage {
  /** Null means the provider or timeline source does not report token usage. */
  tokens: number | null;
  /** Null means no cost data is available. It is never estimated from token counts. */
  costUsd: number | null;
  /** Time is measured from the root orchestrator's start and includes every descendant. */
  durationMs: number | null;
  reportedAt?: number;
}

export interface OrchestrationBudgetSnapshot {
  rootSessionId: string;
  limits: OrchestrationBudgetLimits;
  usage: OrchestrationBudgetUsage;
  remaining: OrchestrationBudgetUsage;
  warning: boolean;
  paused: boolean;
  reason?: string;
  data: { tokens: "available" | "none"; costUsd: "available" | "partial" | "none"; duration: "available" | "none" };
}

interface StoredBudget {
  startedAt?: number;
  sessions?:Record<string,{tokens:number|null;costUsd:number|null;provisional?:boolean}>;
  limits: OrchestrationBudgetLimits;
  tokens: number | null;
  costUsd: number | null;
  reportedAt: number | null;
  usageSource?:"direct"|"session-ledger";
  warned: boolean;
  paused: boolean;
  pauseCause?:"limit"|"cost-data";
  enforcementFailure?:string;
}

interface StoreState { version: 1; budgets: Record<string, StoredBudget> }
interface BudgetCostStatus { incomplete: boolean; provisional: boolean }
interface BudgetCallbacks {
  onWarning?(snapshot: OrchestrationBudgetSnapshot): void;
  onPause?(snapshot: OrchestrationBudgetSnapshot): void;
  onChange?(snapshot: OrchestrationBudgetSnapshot): void;
}

const EMPTY_LIMITS: OrchestrationBudgetLimits = { tokens: null, costUsd: null, durationMs: null };
const EMPTY_STATE: StoreState = { version: 1, budgets: {} };
const MAX_ROOTS = 1_024;

/**
 * Persistent task-wide budgets. Token and cost usage must be supplied by a real provider/timeline source; unknown
 * values remain null and never masquerade as zero. Budget controls are intentionally absent from the agent tools.
 */
export class OrchestrationBudgetService {
  private readonly path: string;
  private readonly callbacks: BudgetCallbacks;
  private state: StoreState = structuredClone(EMPTY_STATE);
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: OrchestrationBudgetSnapshot) => void>();
  private readonly deadlines = new Map<string,ReturnType<typeof setTimeout>>();

  constructor(storagePath: string, callbacks: BudgetCallbacks = {}) {
    this.path = resolve(storagePath);
    this.callbacks = callbacks;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, "utf8");
      if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("Budget store exceeds 1 MB.");
      const candidate: unknown = JSON.parse(text);
      if (!isStore(candidate)) throw new Error("Budget store has an invalid format.");
      this.state = candidate;
    } catch (error) {
      if (!isMissing(error)) throw new Error(`Could not load orchestration budgets: ${errorText(error)}`);
      this.state = structuredClone(EMPTY_STATE);
    }
    this.loaded = true;
    for(const [id,record] of Object.entries(this.state.budgets))if(record.startedAt!==undefined)this.snapshot(id,record.startedAt);
  }

  async flush():Promise<void>{await this.writeQueue;}
  dispose():void {for(const timer of this.deadlines.values())clearTimeout(timer);this.deadlines.clear();}
  snapshots():OrchestrationBudgetSnapshot[] {this.assertLoaded();return Object.keys(this.state.budgets).map(id=>this.snapshot(id));}
  hasLimits(rootSessionId:string):boolean {
    this.assertLoaded();requireId(rootSessionId);
    const limits=this.state.budgets[rootSessionId]?.limits ?? EMPTY_LIMITS;
    return limits.tokens!==null || limits.costUsd!==null || limits.durationMs!==null;
  }
  setEnforcementFailure(rootSessionId:string,failure?:string):void {
    const record=this.record(rootSessionId);
    if(record.enforcementFailure===failure)return;
    if(failure){record.enforcementFailure=failure.slice(0,500);record.paused=true;delete record.pauseCause;}
    else delete record.enforcementFailure;
    this.persistQuietly();
  }

  subscribe(listener: (snapshot: OrchestrationBudgetSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called only by the host UI/controller after the person changes limits. */
  async setLimits(rootSessionId: string, limits: OrchestrationBudgetLimits, rootStartedAt?: number): Promise<OrchestrationBudgetSnapshot> {
    this.assertLoaded();
    requireId(rootSessionId);
    const normalized = normalizeLimits(limits);
    const record = this.record(rootSessionId);
    delete record.enforcementFailure;
    record.limits = normalized;
    const current = this.snapshot(rootSessionId, rootStartedAt);
    const overLimit=isOver(current),unknownCost=record.limits.costUsd!==null && budgetCostStatus(record).incomplete;
    if (!overLimit && !unknownCost) {
      record.paused = false;
      delete record.pauseCause;
      record.warned = false;
    } else {
      record.paused = true;
      record.pauseCause=overLimit ? "limit" : "cost-data";
    }
    await this.persist();
    const updated = this.snapshot(rootSessionId, rootStartedAt);
    this.emit(updated);
    return updated;
  }

  /** A single action that removes every limit and releases the task from a budget pause. */
  async clearLimits(rootSessionId: string, rootStartedAt?: number): Promise<OrchestrationBudgetSnapshot> {
    return this.setLimits(rootSessionId, { ...EMPTY_LIMITS }, rootStartedAt);
  }

  /** Host-only callback for real CLI usage. Values are cumulative for the whole orchestration tree. */
  recordUsage(rootSessionId: string, usage: Pick<OrchestrationBudgetUsage, "tokens" | "costUsd">, rootStartedAt?: number): OrchestrationBudgetSnapshot {
    return this.writeUsage(rootSessionId,usage,rootStartedAt,"direct");
  }

  private writeUsage(rootSessionId:string,usage:Pick<OrchestrationBudgetUsage,"tokens"|"costUsd">,rootStartedAt:number|undefined,source:"direct"|"session-ledger"):OrchestrationBudgetSnapshot {
    this.assertLoaded();
    requireId(rootSessionId);
    const record = this.record(rootSessionId);
    record.tokens = normalizeUsage(usage.tokens, "tokens");
    record.costUsd = normalizeUsage(usage.costUsd, "costUsd");
    record.reportedAt = Date.now();
    record.usageSource=source;
    const updated = this.snapshot(rootSessionId, rootStartedAt);
    this.persistQuietly();
    this.emit(updated);
    return updated;
  }

  /** Individual source counters remain in the task ledger even after a card closes or an account hands off. */
  recordSessionUsage(rootSessionId:string,sessionId:string,usage:{tokens:number|null;costUsd:number|null},options:{rootStartedAt?:number;replaceCounterIds?:readonly string[];provisional?:boolean}={}):OrchestrationBudgetSnapshot {
    this.assertLoaded();requireId(rootSessionId);requireId(sessionId);
    const {rootStartedAt}=options;
    const record=this.record(rootSessionId),sessions=record.sessions ?? (record.sessions={});
    // Replace only the host's pre-report placeholder; real conversation counters,
    // including unknown prices from earlier conversations, remain in the ledger.
    let removedPending=false;
    for(const id of options.replaceCounterIds ?? []){
      requireId(id);
      if(id!==sessionId && Object.hasOwn(sessions,id)){delete sessions[id];removedPending=true;}
    }
    const tokens=normalizeUsage(usage.tokens,"tokens"),costUsd=normalizeUsage(usage.costUsd,"costUsd"),previous=sessions[sessionId],provisional=options.provisional===true;
    if(provisional && (tokens!==null || costUsd!==null))throw new Error("Provisional task usage cannot include observed tokens or cost.");
    const legacyPending=provisional && previous!==undefined && !previous.provisional && previous.tokens===null && previous.costUsd===null;
    if(provisional && previous && !previous.provisional && !legacyPending)return this.snapshot(rootSessionId,rootStartedAt);
    if(legacyPending && record.usageSource===undefined)record.usageSource="session-ledger";
    const next={tokens:tokens===null ? previous?.tokens ?? null : Math.max(previous?.tokens ?? 0,tokens),
      costUsd,...(provisional ? {provisional:true} : {})};
    if(!removedPending && previous && previous.tokens===next.tokens && previous.costUsd===next.costUsd && (previous.provisional===true)===provisional)return this.snapshot(rootSessionId,rootStartedAt);
    if(!previous && Object.keys(sessions).length>=2048)throw new Error("Task usage ledger holds at most 2048 agents.");
    sessions[sessionId]=next;
    let hasObserved=false,knownTokens=0,tokenSum=0,hasCost=false,costSum=0;
    for(const row of Object.values(sessions))if(row.provisional!==true) {
      hasObserved=true;
      if(row.tokens!==null){knownTokens++;tokenSum+=row.tokens;}
      if(row.costUsd!==null)hasCost=true;
      costSum+=row.costUsd ?? 0;
    }
    if(!hasObserved){this.persistQuietly();const updated=this.snapshot(rootSessionId,rootStartedAt);this.emit(updated);return updated;}
    return this.writeUsage(rootSessionId,{tokens:knownTokens ? tokenSum : null,costUsd:hasCost ? costSum : null},rootStartedAt,"session-ledger");
  }

  /** Called before each spawn/send; also trips a time limit even if the CLI has emitted no further usage. */
  snapshot(rootSessionId: string, rootStartedAt?: number): OrchestrationBudgetSnapshot {
    this.assertLoaded();
    requireId(rootSessionId);
    const record = this.state.budgets[rootSessionId] ?? emptyBudget();
    if(record.startedAt===undefined && Number.isFinite(rootStartedAt)) {
      record.startedAt=Number(rootStartedAt);
      if(this.state.budgets[rootSessionId])this.persistQuietly();
    }
    const start=record.startedAt ?? rootStartedAt;
    const durationMs = Number.isFinite(start) ? Math.max(0, Date.now() - Number(start)) : null;
    const usage: OrchestrationBudgetUsage = {
      tokens: record.tokens,
      costUsd: record.costUsd,
      durationMs,
      ...(record.reportedAt !== null ? { reportedAt: record.reportedAt } : {})
    };
    const remaining: OrchestrationBudgetUsage = {
      tokens: difference(record.limits.tokens, usage.tokens),
      costUsd: difference(record.limits.costUsd, usage.costUsd),
      durationMs: difference(record.limits.durationMs, usage.durationMs)
    };
    const thresholdView = { limits: record.limits, usage } as OrchestrationBudgetSnapshot;
    const costStatus=budgetCostStatus(record);
    const costIncomplete=costStatus.incomplete;
    const unknownCostLimit=record.limits.costUsd!==null && costIncomplete;
    const provisionalCost=costStatus.provisional;
    if(costIncomplete || provisionalCost)remaining.costUsd=null;
    const overLimit=isOver(thresholdView);
    const over = overLimit || unknownCostLimit;
    const atWarning = isAtWarning(thresholdView);
    let pauseStateChanged=false;
    if(record.paused && record.pauseCause==="cost-data" && overLimit){record.pauseCause="limit";pauseStateChanged=true;}
    if(record.paused && record.pauseCause==="cost-data" && !overLimit && !unknownCostLimit && !record.enforcementFailure){
      record.paused=false;delete record.pauseCause;pauseStateChanged=true;
    }
    const pauseNow = !record.paused && over;
    const warnNow = !record.warned && atWarning;
    if (pauseNow) {record.paused = true;record.pauseCause=overLimit ? "limit" : "cost-data";pauseStateChanged=true;}
    if (warnNow) record.warned = true;
    const paused = record.paused || over;
    const warning = record.warned || atWarning;
    const reason = overReasons(record.limits, usage);
    const snapshot: OrchestrationBudgetSnapshot = {
      rootSessionId,
      limits: { ...record.limits },
      usage,
      remaining,
      warning,
      paused,
      ...(paused ? { reason: unknownCostLimit
        ? "Cost budget cannot be enforced because some agent costs are unavailable. Task paused; configure prices or remove the cost limit."
        : reason ? `Budget reached: ${reason}. New subagents and agent input are paused.`
          : "This budget pause remains active. Change or clear the task limits to resume." } : {}),
      data: {
        tokens: usage.tokens === null ? "none" : "available",
        costUsd: usage.costUsd === null ? "none" : costIncomplete || provisionalCost ? "partial" : "available",
        duration: usage.durationMs === null ? "none" : "available"
      }
    };
    if (pauseStateChanged || warnNow) {
      this.persistQuietly();
      if (warnNow) try { this.callbacks.onWarning?.(snapshot); } catch { /* an app notification cannot affect the budget */ }
      if (pauseNow) try { this.callbacks.onPause?.(snapshot); } catch { /* a UI callback cannot undo a hard limit */ }
    }
    if(record.enforcementFailure && !snapshot.reason?.includes(record.enforcementFailure))snapshot.reason=`${snapshot.reason ?? "Task budget is paused."} ${record.enforcementFailure}`;
    this.scheduleDeadline(rootSessionId,record);
    return snapshot;
  }

  private scheduleDeadline(id:string,record:StoredBudget):void {
    const existing=this.deadlines.get(id);
    if(existing)clearTimeout(existing);
    this.deadlines.delete(id);
    if(record.paused || record.limits.durationMs===null || record.startedAt===undefined)return;
    const due=record.startedAt+record.limits.durationMs*(record.warned ? 1 : 0.8);
    const timer=setTimeout(()=>{this.deadlines.delete(id);this.emit(this.snapshot(id,record.startedAt));},Math.max(1,Math.min(2_147_483_647,due-Date.now())));
    timer.unref();this.deadlines.set(id,timer);
  }

  isPaused(rootSessionId: string, rootStartedAt?: number): boolean {
    return this.snapshot(rootSessionId, rootStartedAt).paused;
  }

  private record(rootSessionId: string): StoredBudget {
    if (!this.state.budgets[rootSessionId]) {
      if (Object.keys(this.state.budgets).length >= MAX_ROOTS) throw new Error("Too many orchestration budget records.");
      this.state.budgets[rootSessionId] = emptyBudget();
    }
    return this.state.budgets[rootSessionId]!;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    if(Buffer.byteLength(snapshot)>1024*1024)throw new Error("Task budget store exceeds 1 MB.");
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { await rename(temporary, this.path); }
      catch (error) {
        const { unlink } = await import("node:fs/promises");
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = operation;
    await operation;
  }

  private persistQuietly(): void {
    void this.persist().catch(() => undefined);
  }

  private emit(snapshot: OrchestrationBudgetSnapshot): void {
    try { this.callbacks.onChange?.(snapshot); } catch { /* events do not affect accounting */ }
    for (const listener of this.listeners) try { listener(snapshot); } catch { /* one UI listener cannot affect another */ }
  }

  private assertLoaded(): void { if (!this.loaded) throw new Error("Orchestration budget service must be loaded before use."); }
}

function emptyBudget(): StoredBudget { return { limits: { ...EMPTY_LIMITS }, tokens: null, costUsd: null, reportedAt: null, warned: false, paused: false }; }
function normalizeLimits(value: OrchestrationBudgetLimits): OrchestrationBudgetLimits {
  if (!value || typeof value !== "object") throw new Error("Budget limits are invalid.");
  return { tokens: normalizeLimit(value.tokens, "tokens"), costUsd: normalizeLimit(value.costUsd, "costUsd"), durationMs: normalizeLimit(value.durationMs, "durationMs") };
}
function normalizeLimit(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} limit must be a positive finite number or null.`);
  return value;
}
function normalizeUsage(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} usage must be a nonnegative finite number or null.`);
  return value;
}
function difference(limit: number | null, usage: number | null): number | null { return limit === null || usage === null ? null : Math.max(0, limit - usage); }
function reached(limit:number|null,usage:number|null,threshold=1):boolean {
  return limit!==null && usage!==null && usage>=limit*threshold;
}
function isOver(value: Pick<OrchestrationBudgetSnapshot, "limits" | "usage">): boolean {
  const {limits,usage}=value;
  return reached(limits.tokens,usage.tokens) || reached(limits.costUsd,usage.costUsd) || reached(limits.durationMs,usage.durationMs);
}
function isAtWarning(value: Pick<OrchestrationBudgetSnapshot, "limits" | "usage">): boolean {
  const {limits,usage}=value;
  return reached(limits.tokens,usage.tokens,0.8) || reached(limits.costUsd,usage.costUsd,0.8) || reached(limits.durationMs,usage.durationMs,0.8);
}
function overReasons(limits: OrchestrationBudgetLimits, usage: OrchestrationBudgetUsage): string {
  const reasons:string[]=[];
  if(reached(limits.tokens,usage.tokens))reasons.push("token limit");
  if(reached(limits.costUsd,usage.costUsd))reasons.push("cost limit");
  if(reached(limits.durationMs,usage.durationMs))reasons.push("time limit");
  return reasons.join(", ");
}
function requireId(value: unknown): asserts value is string { if (typeof value !== "string" || value.length < 1 || value.length > 160) throw new Error("Orchestration root session id is invalid."); }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function errorText(error: unknown): string { return error instanceof Error ? error.message.slice(0, 200) : "file is unavailable"; }
function budgetCostStatus(record:StoredBudget):BudgetCostStatus {
  let count=0,allProvisional=true,provisional=false,unknownObservedCost=false;
  for(const session of Object.values(record.sessions ?? {})) {
    count++;
    if(session.provisional===true)provisional=true;
    else {allProvisional=false;if(session.costUsd===null)unknownObservedCost=true;}
  }
  const onlyProvisionalLedger=record.usageSource==="session-ledger" && count>0 && allProvisional;
  return {
    incomplete:!onlyProvisionalLedger && record.reportedAt!==null && (record.costUsd===null || unknownObservedCost),
    provisional
  };
}
function isStore(value: unknown): value is StoreState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.budgets || typeof record.budgets !== "object" || Array.isArray(record.budgets)) return false;
  const budgets = record.budgets as Record<string, unknown>;
  return Object.keys(budgets).length <= MAX_ROOTS && Object.values(budgets).every(isBudgetRecord);
}
function nonnegativeOrNull(value:unknown):boolean {
  return value===null || typeof value==="number" && Number.isFinite(value) && value>=0;
}
function positiveOrNull(value:unknown):boolean {
  return value===null || typeof value==="number" && Number.isFinite(value) && value>0;
}
function isUsageLedger(value:unknown):boolean {
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length>2048)return false;
  return Object.values(value).every(row=>row && typeof row==="object" && nonnegativeOrNull(row.tokens) && nonnegativeOrNull(row.costUsd)
    && (row.provisional===undefined || typeof row.provisional==="boolean"));
}
function isBudgetRecord(candidate:unknown):boolean {
  if(!candidate || typeof candidate!=="object" || Array.isArray(candidate))return false;
  const item=candidate as Record<string,unknown>;
  if(!item.limits || typeof item.limits!=="object" || Array.isArray(item.limits))return false;
  if(item.sessions!==undefined && !isUsageLedger(item.sessions))return false;
  if(item.startedAt!==undefined && !(typeof item.startedAt==="number" && Number.isFinite(item.startedAt) && item.startedAt>0))return false;
  const limits=item.limits as Record<string,unknown>;
  return positiveOrNull(limits.tokens) && positiveOrNull(limits.costUsd) && positiveOrNull(limits.durationMs)
    && nonnegativeOrNull(item.tokens) && nonnegativeOrNull(item.costUsd)
    && (item.reportedAt===null || typeof item.reportedAt==="number" && Number.isFinite(item.reportedAt))
    && (item.usageSource===undefined || item.usageSource==="direct" || item.usageSource==="session-ledger")
    && (item.pauseCause===undefined || item.pauseCause==="limit" || item.pauseCause==="cost-data")
    && (item.enforcementFailure===undefined || typeof item.enforcementFailure==="string" && item.enforcementFailure.length<=500)
    && typeof item.warned==="boolean" && typeof item.paused==="boolean";
}
