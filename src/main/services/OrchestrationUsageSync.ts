import { createHash } from "node:crypto";
import type { UsagePrice } from "../../shared/backlog.ts";
import type { OrchestrationBudgetService, OrchestrationBudgetSnapshot } from "./OrchestrationBudgetService.ts";
import type { SessionTimelineService, TimelineTaskBudgetData, TimelineUsageCounter } from "./SessionTimelineService.ts";

interface CounterTotal {tokens:number;costUsd:number;costKnown:boolean;replaceCounterIds:Set<string>}
export interface OrchestrationUsageScope {rootSessionId:string;rootStartedAt:number;memberSessionIds:readonly string[];budgetEnabled?:boolean}

/** Synchronize the timeline's indexed task deltas plus host-owned launch placeholders into the budget ledger. */
export function refreshOrchestrationUsage(
  budget: OrchestrationBudgetService,
  timeline: SessionTimelineService,
  rootSessionId: string,
  rootStartedAt: number,
  memberSessionIds: readonly string[],
  prices: UsagePrice[]
): OrchestrationBudgetSnapshot {
  return refreshOrchestrationUsageBatch(budget,timeline,[{rootSessionId,rootStartedAt,memberSessionIds}],prices).get(rootSessionId)!;
}

/** Gather every active root's compact usage rows in shared timeline passes before updating its ledger. */
export function refreshOrchestrationUsageBatch(
  budget:OrchestrationBudgetService,
  timeline:SessionTimelineService,
  scopes:readonly OrchestrationUsageScope[],
  prices:UsagePrice[],
  onSnapshot?:(scope:OrchestrationUsageScope,snapshot:OrchestrationBudgetSnapshot|undefined)=>void,
  beforeRefresh?:(scope:OrchestrationUsageScope)=>void
):Map<string,OrchestrationBudgetSnapshot> {
  if(scopes.length===0)return new Map();
  const budgetScopes=scopes.filter(scope=>scope.budgetEnabled!==false);
  if(budgetScopes.length===0) {
    for(const scope of scopes) {beforeRefresh?.(scope);onSnapshot?.(scope,undefined);}
    return new Map();
  }
  const dataByTask=timeline.taskBudgetUsageByTask(budgetScopes.map(scope=>({taskId:scope.rootSessionId,
    sessionIds:[scope.rootSessionId,...scope.memberSessionIds]})),prices);
  const snapshots=new Map<string,OrchestrationBudgetSnapshot>();
  for(const scope of scopes) {
    beforeRefresh?.(scope);
    const snapshot=scope.budgetEnabled===false ? undefined : refreshOneTask(budget,timeline,scope,dataByTask.get(scope.rootSessionId)!);
    if(snapshot)snapshots.set(scope.rootSessionId,snapshot);
    onSnapshot?.(scope,snapshot);
  }
  return snapshots;
}

function refreshOneTask(
  budget:OrchestrationBudgetService,
  timeline:SessionTimelineService,
  scope:OrchestrationUsageScope,
  data:TimelineTaskBudgetData
):OrchestrationBudgetSnapshot {
  const {rootSessionId,rootStartedAt}=scope;
  const scopeSessions=data.sessionIds;
  const totals=new Map<string,CounterTotal>();
  for(const contribution of data.contributions) {
    let total=totals.get(contribution.identity);
    if(!total){total={tokens:0,costUsd:0,costKnown:true,replaceCounterIds:new Set()};totals.set(contribution.identity,total);}
    total.tokens+=contribution.tokens;
    if(contribution.costUsd===null)total.costKnown=false;else total.costUsd+=contribution.costUsd;
  }

  const sessionsWithUsage=new Set<string>();
  const aliasesByIdentity=new Map<string,Set<string>>();
  for(const sessionId of scopeSessions)for(const usage of timeline.usageCounters(sessionId)) {
    sessionsWithUsage.add(sessionId);
    const identity=counterIdentity(sessionId,usage),aliases=aliasesByIdentity.get(identity) ?? new Set<string>();
    aliases.add(hashCounter(sessionId,usage.id));
    aliases.add(hashCounter(sessionId,usage.legacyId ?? sessionId));
    aliasesByIdentity.set(identity,aliases);
  }
  for(const [identity,total] of totals)for(const alias of aliasesByIdentity.get(identity) ?? [])total.replaceCounterIds.add(alias);

  const pendingIds=[...sessionsWithUsage].map(sessionId=>hashCounter(sessionId,sessionId));
  let first=true;
  for(const [identity,total] of totals) {
    const replaceCounterIds=[...total.replaceCounterIds,...(first ? pendingIds : [])];first=false;
    budget.recordSessionUsage(rootSessionId,hashIdentity(identity),{
      tokens:total.tokens,
      costUsd:total.costKnown ? total.costUsd : null
    },{rootStartedAt,replaceCounterIds});
  }
  for(const sessionId of scopeSessions)if(!sessionsWithUsage.has(sessionId)) {
    budget.recordSessionUsage(rootSessionId,hashCounter(sessionId,sessionId),{tokens:null,costUsd:null},{rootStartedAt,provisional:true});
  }
  return budget.snapshot(rootSessionId,rootStartedAt);
}

function counterIdentity(sessionId:string,usage:TimelineUsageCounter):string {
  return usage.cumulative && usage.counterId!==undefined
    ? JSON.stringify([usage.provider ?? "",usage.accountId ?? "",usage.source,usage.counterId])
    : JSON.stringify([sessionId,usage.source,usage.counterId ?? ""]);
}
function hashCounter(sessionId:string,counterId:string):string {
  return createHash("sha256").update(`${sessionId}:${counterId}`).digest("hex");
}
function hashIdentity(identity:string):string {
  return createHash("sha256").update(`task-usage:${identity}`).digest("hex");
}
