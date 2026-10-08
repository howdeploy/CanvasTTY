import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { addTimelineSearchEvent, createTimelineSegmentSearchIndex, type TimelineSegmentSearchIndex } from "./TimelineSearchIndex.ts";
import type { TimelineEvent } from "../../shared/backlog.ts";

export interface TimelineUsageContext { provider?: string; model?: string; accountId?: string; taskId?: string }
export type TimelineIndexedUsage = TimelineUsageContext & {
  input: number | null;
  output: number | null;
  total?: number;
  cost: number | null;
  source: string;
  cumulative?: boolean;
  counterId?: string;
  /** A resumed conversation's first sample: its counter already held usage from earlier runs. */
  baseline?: boolean;
  /** Host index sequence of the last observation; rebuilt from journal order on load. */
  sampleOrder?: number;
};
type Usage=TimelineIndexedUsage;
export interface BudgetUsageContribution {
  sessionId:string;
  identity:string;
  taskId?:string;
  provider?:string;
  model?:string;
  mode:"reported"|"priced"|"covered"|"reported-base";
  tokens:number;
  input:number|null;
  output:number|null;
  reportedCostUsd:number|null;
}
export interface BudgetCounterState {current:TimelineIndexedUsage;taskOwner:string|null;mixedOwners:boolean;reportedCostSeen:boolean;
  /** Started from a resumed conversation's baseline: its total so far, cost included, predates this run. */
  fromBaseline?:boolean}
export interface TimelineTaskSessionIndex {
  id:string;
  taskId:string;
  title:string;
  types:Map<string,string>;
  lastSegment:string;
}

export interface TimelineDirectoryIndex {
  lastSegmentAt:number;
  usage:Map<string,TimelineIndexedUsage>;
  budgetUsage:Map<string,BudgetUsageContribution>;
  budgetCounters:Map<string,BudgetCounterState>;
  segments:Map<string,TimelineSegmentSearchIndex>;
  taskSessions:Map<string,Map<string,TimelineTaskSessionIndex>>;
}

const MAX_EVENT_LINE_CHARS = 64 * 1024;
export const MAX_INDEXED_SEGMENTS = 256;
const NAME_PATTERN = /^\d{16}-[\w-]+\.ndjson$/u;
export async function scanTimelineDirectory(directory: string): Promise<TimelineDirectoryIndex> {
  const names = (await readdir(directory)).filter((name: string) => NAME_PATTERN.test(name)).sort();
  const usage = new Map<string, Usage>();
  const budgetUsage=new Map<string,BudgetUsageContribution>();
  const budgetCounters=new Map<string,BudgetCounterState>();
  const taskSessions=new Map<string,Map<string,TimelineTaskSessionIndex>>();
  const segments=new Map<string,TimelineSegmentSearchIndex>();
  let lastSegmentAt = 0, sampleOrder = 0;
  for (const name of names) {
    lastSegmentAt = Math.max(lastSegmentAt, Number(name.slice(0, 16)) || 0);
    const metadata = await stat(join(directory, name));
    const index = createTimelineSegmentSearchIndex(metadata.size, metadata.mtimeMs);
    for await (const line of boundedLines(join(directory, name))) {
      if (line === null) { index.complete = false; continue; }
      if (!line) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event.id !== "string" || typeof event.sessionId !== "string" || typeof event.at !== "number") continue;
      addTimelineSearchEvent(index, event);
      indexTimelineTaskSession(taskSessions,event,name);
      const usageUpdate = nextTimelineUsage(usage, event);
      if (usageUpdate) usage.set(usageUpdate.key, {...usageUpdate.value,sampleOrder:sampleOrder++});
      applyTimelineBudgetUsageEvent(budgetUsage,budgetCounters,event);
    }
    segments.set(name,index);
    if (segments.size > MAX_INDEXED_SEGMENTS) segments.delete(segments.keys().next().value!);
  }
  return {lastSegmentAt,usage,budgetUsage,budgetCounters,segments,taskSessions};
}

async function* boundedLines(path: string): AsyncGenerator<string | null> {
  let pending = "";
  let oversized = false;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf("\n", from);
      const end = newline < 0 ? chunk.length : newline;
      if (!oversized) {
        const part = chunk.slice(from, end);
        if (pending.length + part.length > MAX_EVENT_LINE_CHARS) { pending = ""; oversized = true; }
        else pending += part;
      }
      if (newline < 0) break;
      yield oversized ? null : pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      pending = "";
      oversized = false;
      from = newline + 1;
    }
  }
  if (oversized) yield null;
  else if (pending) yield pending;
}

/** A card may use the same provider counter name under different accounts. */
export function timelineUsageKey(sessionId:string,row:Pick<Usage,"source"|"counterId"|"provider"|"accountId">):string {
  return JSON.stringify([sessionId,row.source,row.counterId ?? "",row.provider ?? "",row.accountId ?? ""]);
}

export function nextTimelineUsage(
  usage: ReadonlyMap<string, Usage>,
  event: TimelineEvent
): { key: string; value: Usage } | null {
  if (event.type !== "usage" || typeof event.detail !== "string" || !event.detail) return null;
  try {
    const row = JSON.parse(event.detail) as Usage;
    const key=timelineUsageKey(event.sessionId,row);
    if (row.cumulative === true) {
      if (isTimelineCount(row.total) && typeof row.source === "string") {
        const input = row.input === null || isTimelineCount(row.input) ? row.input : null;
        const output = row.output === null || isTimelineCount(row.output) ? row.output : null;
        const cost = typeof row.cost === "number" && Number.isFinite(row.cost) && row.cost >= 0 ? row.cost : null;
        return { key, value: { input, output, total: row.total, cost, source: row.source,
          cumulative: true,
          ...(typeof row.counterId === "string" && row.counterId.length <= 200 ? { counterId: row.counterId } : {}),
          ...timelineUsageContext(row) } };
      }
      return null;
    }
    if (!isTimelineCount(row.input) || !isTimelineCount(row.output) || typeof row.source !== "string") return null;
    const previous = usage.get(key);
    return { key, value: { input: (previous?.input ?? 0) + row.input!, output: (previous?.output ?? 0) + row.output!,
      cost: row.cost !== null && typeof row.cost === "number" && Number.isFinite(row.cost) && (!previous || previous.cost !== null)
        ? (previous?.cost ?? 0) + row.cost : null,
      source: row.source,...timelineUsageContext(row) } };
  } catch { /* An invalid or truncated journal line has no usage effect. */ return null; }
}

export function timelineUsageContext(value: { provider?: unknown; model?: unknown; accountId?: unknown; taskId?: unknown }): TimelineUsageContext {
  const context: TimelineUsageContext = {};
  for (const key of ["provider", "model", "accountId", "taskId"] as const) {
    const entry = value[key];
    if (typeof entry === "string" && entry.length > 0 && entry.length <= 200) context[key] = entry;
  }
  return context;
}

export function isTimelineCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

export function indexTimelineTaskSession(
  taskSessions:Map<string,Map<string,TimelineTaskSessionIndex>>,
  event:TimelineEvent,
  segment:string
):void {
  if(typeof event.taskId!=="string" || !event.taskId || event.taskId.length>200)return;
  let sessions=taskSessions.get(event.taskId);
  if(!sessions){sessions=new Map();taskSessions.set(event.taskId,sessions);}
  let descriptor=sessions.get(event.sessionId);
  if(!descriptor) {
    descriptor={id:event.sessionId,taskId:event.taskId,
      title:typeof event.sessionTitle==="string" && event.sessionTitle.length<=200 && event.sessionTitle ? event.sessionTitle : event.sessionId.slice(0,200),
      types:new Map(),lastSegment:segment};
    sessions.set(event.sessionId,descriptor);
  }
  if(typeof event.type==="string" && event.type)descriptor.types.set(event.type,segment);
  if(typeof event.sessionTitle==="string" && event.sessionTitle.length<=200 && event.sessionTitle)descriptor.title=event.sessionTitle;
  descriptor.lastSegment=segment;
}

export function applyTimelineBudgetUsageEvent(
  contributions:Map<string,BudgetUsageContribution>,
  baselines:Map<string,BudgetCounterState>,
  event:any
):void {
  if(event.type!=="usage" || typeof event.detail!=="string" || !event.detail)return;
  try {
    const row=JSON.parse(event.detail) as Usage;
    if(typeof row.source!=="string")return;
    const context=timelineUsageContext(row),identity=budgetCounterIdentity(event.sessionId,{...row,...context});
    if(row.cumulative===true) {
      if(!isTimelineCount(row.total))return;
      const current:Usage={input:row.input===null || isTimelineCount(row.input) ? row.input : null,
        output:row.output===null || isTimelineCount(row.output) ? row.output : null,total:row.total,
        cost:typeof row.cost==="number" && Number.isFinite(row.cost) && row.cost>=0 ? row.cost : null,
        source:row.source,cumulative:true,
        ...(typeof row.counterId==="string" && row.counterId.length<=200 ? {counterId:row.counterId} : {}),...context};
      const previousState=baselines.get(identity),previous=previousState?.current;
      if(previous===undefined && row.baseline===true) {
        // Usage before the resume belongs to earlier runs; later samples count from here.
        baselines.set(identity,{current,taskOwner:taskOwner(event.sessionId,current),mixedOwners:false,reportedCostSeen:current.cost!==null,fromBaseline:true});
        return;
      }
      const reset=previous!==undefined && current.total!<previous.total!;
      const tokens=previous===undefined || reset ? current.total! : current.total!-previous.total!;
      const input=budgetCounterDelta(current.input,previous?.input ?? null,reset);
      const output=budgetCounterDelta(current.output,previous?.output ?? null,reset);
      let mode:BudgetUsageContribution["mode"]="priced",reportedCostUsd:number|null=null;
      const owner=taskOwner(event.sessionId,current),resolvesMissingCost=current.cost!==null && previous!==undefined && !reset
        && previousState?.reportedCostSeen===false && previousState.mixedOwners===false && previousState.taskOwner===owner
        && previousState.fromBaseline!==true;
      if(resolvesMissingCost) {
        coverEarlierPricedCost(contributions,identity,current.taskId,event.sessionId);
        setReportedCostBase(contributions,event.sessionId,identity,current,current.cost!);
        mode="covered";
      }
      else if(current.cost!==null && (previous===undefined || reset)) {mode="reported";reportedCostUsd=current.cost;}
      else if(current.cost!==null && previous!==undefined && previous.cost!==null) {
        mode="reported";reportedCostUsd=Math.max(0,current.cost-previous.cost);
      }
      addBudgetContribution(contributions,{sessionId:event.sessionId,identity,...context,mode,tokens,input,output,reportedCostUsd});
      const mixedOwners=previousState!==undefined && (previousState.mixedOwners || previousState.taskOwner!==owner);
      baselines.set(identity,{current,taskOwner:mixedOwners ? null : owner,mixedOwners,
        reportedCostSeen:Boolean(previousState?.reportedCostSeen || current.cost!==null),
        ...(previousState?.fromBaseline ? {fromBaseline:true} : {})});
      return;
    }
    if(!isTimelineCount(row.input) || !isTimelineCount(row.output))return;
    const reported=typeof row.cost==="number" && Number.isFinite(row.cost) && row.cost>=0;
    addBudgetContribution(contributions,{sessionId:event.sessionId,identity,...context,
      mode:reported ? "reported" : "priced",tokens:row.input+row.output,input:row.input,output:row.output,
      reportedCostUsd:reported ? row.cost! : null});
  } catch { /* An invalid or truncated journal line has no budget effect. */ }
}

export function budgetCounterIdentity(sessionId:string,row:Usage):string {
  return row.counterId===undefined
    ? JSON.stringify([sessionId,row.source,""])
    : JSON.stringify([row.provider ?? "",row.accountId ?? "",row.source,row.counterId]);
}
function budgetCounterDelta(current:number|null,previous:number|null,reset:boolean):number|null {
  if(current===null)return null;
  if(previous===null || reset)return current;
  return current>=previous ? current-previous : current;
}
function addBudgetContribution(map:Map<string,BudgetUsageContribution>,row:BudgetUsageContribution):void {
  const key=budgetContributionKey(row);
  const previous=map.get(key);
  if(!previous){map.set(key,{...row});return;}
  previous.tokens+=row.tokens;
  previous.input=previous.input===null || row.input===null ? null : previous.input+row.input;
  previous.output=previous.output===null || row.output===null ? null : previous.output+row.output;
  if(row.mode==="reported")previous.reportedCostUsd=(previous.reportedCostUsd ?? 0)+(row.reportedCostUsd ?? 0);
}
function budgetContributionKey(row:BudgetUsageContribution):string {
  return JSON.stringify([row.sessionId,row.identity,row.taskId ?? "",row.provider ?? "",row.model ?? "",row.mode]);
}
function taskOwner(sessionId:string,row:Usage):string {return row.taskId===undefined ? `session:${sessionId}` : `task:${row.taskId}`;}
function coverEarlierPricedCost(contributions:Map<string,BudgetUsageContribution>,identity:string,taskId:string|undefined,sessionId:string):void {
  for(const [key,row] of [...contributions]) {
    if(row.identity!==identity || row.mode!=="priced")continue;
    if(taskId!==undefined ? row.taskId!==taskId : row.sessionId!==sessionId || row.taskId!==undefined)continue;
    contributions.delete(key);row.mode="covered";contributions.set(budgetContributionKey(row),row);
  }
}
function setReportedCostBase(contributions:Map<string,BudgetUsageContribution>,sessionId:string,identity:string,row:Usage,cost:number):void {
  const base:BudgetUsageContribution={sessionId,identity,...timelineUsageContext(row),mode:"reported-base",tokens:0,input:null,output:null,reportedCostUsd:cost};
  const owner=row.taskId ?? `session:${sessionId}`;
  contributions.set(JSON.stringify(["reported-base",identity,owner]),base);
}
