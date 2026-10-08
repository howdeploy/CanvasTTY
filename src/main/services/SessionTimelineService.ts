import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { applyTimelineBudgetUsageEvent, budgetCounterIdentity, isTimelineCount, MAX_INDEXED_SEGMENTS, nextTimelineUsage, scanTimelineDirectory, timelineUsageContext, timelineUsageKey,
  indexTimelineTaskSession, type BudgetCounterState, type BudgetUsageContribution, type TimelineDirectoryIndex, type TimelineIndexedUsage, type TimelineTaskSessionIndex,
  type TimelineUsageContext } from "./TimelineIndexScan.ts";
import { forEachTimelineEvent } from "./TimelineJournalReader.ts";
import type { TimelineEvent, UsageSummary, UsageBreakdown, UsagePrice } from "../../shared/backlog.ts";
import { addTimelineSearchEvent, createTimelineSegmentSearchIndex, timelineSegmentMayMatch, type TimelineSegmentSearchIndex } from "./TimelineSearchIndex.ts";

const SEGMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const MAX_EVENT_CHARS = 16_384;
const MAX_REPORT_EVENTS = 10_000;
export interface UsageContext extends TimelineUsageContext {}
export interface CumulativeUsage { input:number|null; output:number|null; total:number; costUsd?:number|null }
export interface TimelineUsageCounter {
  id:string;legacyId?:string;tokens:number|null;costUsd:number|null;inputTokens:number|null;outputTokens:number|null;
  provider?:string;model?:string;accountId?:string;taskId?:string;source:string;counterId?:string;cumulative:boolean;
  reportedCostUsd:number|null;
}
export interface TimelineTaskBudgetUsage {identity:string;sessionId:string;taskId?:string;tokens:number;costUsd:number|null}
export interface TimelineTaskBudgetScope {taskId:string;sessionIds:readonly string[]}
export interface TimelineTaskBudgetData {sessionIds:string[];contributions:TimelineTaskBudgetUsage[]}
type Usage = TimelineIndexedUsage & { timelineOrder?:number };
type TimelinePageCandidate = { event: TimelineEvent; index: number };
type TimelinePageScope={taskId:string;legacySessionIds:string[]};

function createTimelineRing<T>(capacity:number):{push(value:T):void;newestFirst():T[]} {
  const values:Array<T|undefined>=new Array(capacity);
  let size=0,next=0;
  return {
    push(value:T) {
      values[next]=value;
      next=(next+1)%capacity;
      if(size<capacity)size++;
    },
    newestFirst() {
      const rows:T[]=[];
      const oldest=size===capacity ? next : 0;
      for(let offset=0;offset<size;offset++)rows.push(values[(oldest+offset)%capacity]!);
      rows.reverse();
      return rows;
    }
  };
}

function totalTokens(value: Usage): number | null {
  return value.total ?? (value.input !== null && value.output !== null ? value.input + value.output : null);
}

function usageCountersChanged(previous:Usage|undefined,next:Usage):boolean {
  return !previous || previous.input!==next.input || previous.output!==next.output
    || totalTokens(previous)!==totalTokens(next) || previous.cost!==next.cost
    || previous.model!==next.model || previous.accountId!==next.accountId || previous.taskId!==next.taskId;
}
function usageSession(key:string):string {return (JSON.parse(key) as string[])[0];}
function snapshotIdentity(sessionId:string,value:Usage):string {return value.counterId===undefined ? timelineUsageKey(sessionId,value) : budgetCounterIdentity(sessionId,value);}

function usageSummary(values:Usage[],prices:UsagePrice[]):UsageSummary {
    if (!values.length) return { tokens: {input: null, output: null, total: null}, cost: null, currency: "USD", source: null };
    const input = values.every(row=>row.input!==null) ? values.reduce((sum,row)=>sum+row.input!,0) : null;
    const output = values.every(row=>row.output!==null) ? values.reduce((sum,row)=>sum+row.output!,0) : null;
    const totals=values.map(totalTokens);
    const total=totals.every((value):value is number=>value!==null) ? totals.reduce((sum,value)=>sum+value,0) : null;
    const costs=values.map(row=>pricedCost(row,prices));
    return { tokens: {input, output, total},
      cost: costs.every((value):value is number=>value!==null) ? costs.reduce((sum,value)=>sum+value,0) : null,
      currency: "USD", source: [...new Set(values.map((row) => row.source))].join(", ") };
}

function pricedCost(value:Usage,prices:UsagePrice[]):number|null {
  if(typeof value.cost==="number" && Number.isFinite(value.cost) && value.cost>=0)return value.cost;
  if(value.input===null || value.output===null || !value.provider || !value.model)return null;
  const price=priceForUsage(value,prices);
  return price ? (value.input*price.inputPerMillion+value.output*price.outputPerMillion)/1_000_000 : null;
}
function priceForUsage(value:Usage,prices:UsagePrice[]):UsagePrice|undefined {
  return value.provider && value.model ? prices.find(row=>row.provider===value.provider && row.model===value.model) : undefined;
}
function addKnown(previous:number|null|undefined,current:number|null):number|null {
  return current===null ? previous ?? null : (previous ?? 0)+current;
}
function counterDelta(current:number|null,previous:number|null):number|null {
  return current===null || previous===null ? null : current>=previous ? current-previous : current;
}

/** Hook events only: terminal output is never copied into this journal. */
export class SessionTimelineService {
  private queue: Promise<void> = Promise.resolve();
  private segment = "";
  private segmentBytes = 0;
  private totalBytes = 0;
  private readonly usageBySession = new Map<string, Usage>();
  private readonly usageKeysBySession = new Map<string, Set<string>>();
  private nextUsageOrder=0;
  private nextSampleOrder=0;
  private readonly latestCounterSamples=new Map<string,Usage>();
  private budgetUsageContributions=new Map<string,BudgetUsageContribution>();
  private budgetCounterBaselines=new Map<string,BudgetCounterState>();
  private readonly usageListeners = new Set<(sessionId: string) => void>();
  private segmentIndexes = new Map<string, TimelineSegmentSearchIndex>();
  private taskSessionsByTask = new Map<string,Map<string,TimelineTaskSessionIndex>>();
  private sessionContextResolver?: (sessionId:string)=>{taskId:string;title:string}|undefined;
  readonly directory: string;
  private readonly redact: (text:string)=>string;
  private readonly maxBytes: number;
  private readonly now: ()=>number;
  private lastSegmentAt = 0;
  private pageCache: {name: string; size: number; mtimeMs: number; events: TimelineEvent[]} | null = null;
  private fileListCache: string[] | null = null;
  constructor(userDataPath: string, redact: (text: string) => string,
    maxBytes = DEFAULT_MAX_BYTES, now = Date.now) {
    this.redact=redact;this.maxBytes=maxBytes;this.now=now;
    this.directory = join(userDataPath, "session-timeline");
  }

  configureSessionContext(resolver:(sessionId:string)=>{taskId:string;title:string}|undefined):void {
    this.sessionContextResolver=resolver;
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.fileListCache = null;
    this.pageCache = null;
    this.totalBytes = await this.prune();
    // Scan journals incrementally on a worker. Startup only receives compact usage
    // totals and bounded segment indexes, never hundreds of megabytes of events.
    const index = await scanTimelineIndex(this.directory).catch(async error => {
      console.warn("CanvasTTY timeline index worker unavailable; using the bounded journal scanner.", error instanceof Error ? error.message : "Worker failed.");
      return scanTimelineDirectory(this.directory);
    }).catch((error): TimelineDirectoryIndex => {
      // Startup must not depend on old journals: without an index, usage totals start empty and pages read
      // segments directly, while new events are still recorded.
      console.warn("CanvasTTY timeline is degraded: its journal index is unavailable, so earlier usage totals are not shown.",
        error instanceof Error ? error.message : "Scan failed.");
      return {lastSegmentAt:0,usage:new Map(),budgetUsage:new Map(),budgetCounters:new Map(),segments:new Map(),taskSessions:new Map()};
    });
    this.lastSegmentAt = Math.max(this.lastSegmentAt, index.lastSegmentAt);
    this.usageBySession.clear();
    this.usageKeysBySession.clear();
    this.nextUsageOrder=0;
    this.nextSampleOrder=0;
    this.latestCounterSamples.clear();
    for (const [key, usage] of index.usage) this.storeUsage(key, usageSession(key), usage);
    this.budgetUsageContributions=index.budgetUsage;
    this.budgetCounterBaselines=index.budgetCounters;
    for(const [taskId,sessions] of index.taskSessions) {
      for(const [sessionId,descriptor] of sessions) {
        if(typeof descriptor.id!=="string" || descriptor.id!==sessionId || descriptor.taskId!==taskId
          || typeof descriptor.title!=="string" || typeof descriptor.lastSegment!=="string" || !(descriptor.types instanceof Map)) {
          sessions.delete(sessionId);
          continue;
        }
        descriptor.title=this.redact(descriptor.title).slice(0,200);
      }
      if(!sessions.size)index.taskSessions.delete(taskId);
    }
    this.taskSessionsByTask=index.taskSessions;
    this.segmentIndexes=index.segments;
  }

  append(sessionId: string, type: string, summary: string, detail?: string, source?: string): Promise<void> {
    let context:{taskId:string;title:string}|undefined;
    try { context=this.sessionContextResolver?.(sessionId); } catch { /* A closed or transient card keeps its ordinary session-only event. */ }
    const taskId=context && typeof context.taskId==="string" && context.taskId.length>0 && context.taskId.length<=200
      ? context.taskId : undefined;
    const sessionTitle=context && typeof context.title==="string" && context.title.length>0
      ? this.redact(context.title).slice(0,200) : undefined;
    const event: TimelineEvent = {
      id: randomUUID(), sessionId, at: this.now(), type,
      summary: this.redact(summary).slice(0, 1000),
      ...(detail !== undefined ? { detail: this.redact(detail).slice(0, MAX_EVENT_CHARS) } : {}),
      ...(source ? { source: this.redact(source).slice(0, 100) } : {}),
      ...(taskId ? {taskId} : {}),
      ...(taskId && sessionTitle ? {sessionTitle} : {})
    };
    this.applyUsageEvent(event);
    applyTimelineBudgetUsageEvent(this.budgetUsageContributions,this.budgetCounterBaselines,event);
    const work = this.queue.then(async () => {
      const line = JSON.stringify(event) + "\n";
      const bytes = Buffer.byteLength(line);
      if (!this.segment || this.segmentBytes + bytes > Math.min(SEGMENT_BYTES, this.maxBytes)) {
        this.lastSegmentAt=Math.max(this.now(),this.lastSegmentAt+1);
        this.segment = `${String(this.lastSegmentAt).padStart(16, "0")}-${randomUUID()}.ndjson`;
        this.segmentBytes = 0;
        this.fileListCache = null;
      }
      await appendFile(join(this.directory, this.segment), line, { mode: 0o600 });
      this.pageCache = null;
      this.segmentBytes += bytes;
      this.totalBytes += bytes;
      let index = this.segmentIndexes.get(this.segment);
      if (!index) {
        index = createTimelineSegmentSearchIndex();
        this.segmentIndexes.set(this.segment, index);
        while (this.segmentIndexes.size > MAX_INDEXED_SEGMENTS) this.segmentIndexes.delete(this.segmentIndexes.keys().next().value!);
      }
      addTimelineSearchEvent(index, event);
      index.size += bytes;
      indexTimelineTaskSession(this.taskSessionsByTask,event,this.segment);
      if (this.totalBytes > this.maxBytes) this.totalBytes = await this.prune();
    });
    this.queue = work.catch(() => undefined);
    return work;
  }

  /** Usage is accepted only from an identified real provider source, never synthesized from limits. */
  recordUsage(sessionId: string, input: number, output: number, source: string, cost?: number, context:UsageContext={}): Promise<void> {
    if (!isTimelineCount(input) || !isTimelineCount(output)
      || !source || cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
      return Promise.reject(new Error("Invalid provider usage record."));
    }
    return this.append(sessionId, "usage", "Provider usage", JSON.stringify({ input, output, cost: cost ?? null, source,...timelineUsageContext(context) }), source);
  }

  recordTokenTotal(sessionId:string,total:number,source:string,counterId?:string,context:UsageContext={}):Promise<void> {
    return this.recordCumulativeUsage(sessionId,{input:null,output:null,total},source,counterId,context);
  }

  /**
   * Replace a provider's cumulative counter; repeated lifecycle signals never add the same tokens twice. `resumed`
   * says the card resumed this conversation: when the journal holds no earlier sample of its counter, this one is
   * stored as a baseline, so usage from before the resume is not counted as this period's or this task's.
   */
  recordCumulativeUsage(sessionId:string,usage:CumulativeUsage,source:string,counterId?:string,context:UsageContext={},options:{resumed?:boolean}={}):Promise<void> {
    const {input,output,total,costUsd}=usage;
    if(!isTimelineCount(total) || input!==null && !isTimelineCount(input) || output!==null && !isTimelineCount(output)
      || !source || costUsd!==undefined && costUsd!==null && (!Number.isFinite(costUsd) || costUsd<0)
      || counterId!==undefined && (typeof counterId!=="string" || counterId.length>200))return Promise.reject(new Error("Invalid provider token counter."));
    const cost=costUsd ?? null,normalizedContext=timelineUsageContext(context);
    const previous=this.usageBySession.get(timelineUsageKey(sessionId,{source,counterId,...normalizedContext}));
    const latest=this.latestCounterSamples.get(snapshotIdentity(sessionId,{input,output,total,cost,source,counterId,...normalizedContext}));
    if(previous?.cumulative && previous.sampleOrder===latest?.sampleOrder && previous.input===input && previous.output===output && previous.total===total
      && previous.cost===cost && previous.source===source && previous.counterId===counterId
      && Object.keys(normalizedContext).every(key=>previous[key as keyof UsageContext]===normalizedContext[key as keyof UsageContext]))return Promise.resolve();
    const baseline=options.resumed===true
      && !this.budgetCounterBaselines.has(budgetCounterIdentity(sessionId,{input,output,total,cost,source,...(counterId!==undefined ? {counterId} : {}),...normalizedContext}));
    return this.append(sessionId,"usage","CLI cumulative token counter",JSON.stringify({input,output,total,cost,source,cumulative:true,...(counterId ? {counterId} : {}),...normalizedContext,...(baseline ? {baseline:true} : {})}),source);
  }

  async page(sessionId: string, cursor?: string, limit = 100,filter?:{query?:string;types?:string[];sessionIds?:string[]},scope?:TimelinePageScope): Promise<{items: TimelineEvent[]; nextCursor: string | null}> {
    await this.queue;
    const take = Math.min(500, Math.max(1, Math.floor(limit) || 100));
    const result: TimelineEvent[] = [];
    const ids=new Set(filter?.sessionIds ?? [sessionId]),types=filter?.types?.length ? new Set(filter.types) : null,needle=filter?.query?.toLocaleLowerCase();
    const legacySessionIds=scope ? new Set(scope.legacySessionIds) : null;
    const matches=(event:TimelineEvent):boolean=>ids.has(event.sessionId)
      && (!types || types.has(event.type))
      && (!needle || `${event.summary}\n${event.detail ?? ""}`.toLocaleLowerCase().includes(needle))
      && (!scope || event.taskId===scope.taskId || event.taskId===undefined && legacySessionIds!.has(event.sessionId));
    const position = cursor?.startsWith("v1:") ? /^v1:(\d{16}-[\w-]+\.ndjson):(\d+)$/u.exec(cursor) : null;
    if (cursor?.startsWith("v1:") && (!position || !Number.isSafeInteger(Number(position[2])))) throw new Error("Invalid timeline cursor.");
    let passed = !cursor || Boolean(position);
    let lastPosition = "";
    for (const name of [...(await this.files())].reverse()) {
      if (position && name > position[1]) continue;
      if (position && name === position[1] && Number(position[2]) === 0) continue;
      const cachedPageSegment=this.pageCache?.name===name ? this.pageCache : null;
      const recordedSegmentIndex=this.segmentIndexes.get(name);
      const metadata=await stat(join(this.directory,name));
      if(cachedPageSegment
        && (cachedPageSegment.size!==metadata.size || cachedPageSegment.mtimeMs!==metadata.mtimeMs))this.pageCache=null;
      if(recordedSegmentIndex
        && (recordedSegmentIndex.size!==metadata.size
          || recordedSegmentIndex.mtimeMs!==0 && recordedSegmentIndex.mtimeMs!==metadata.mtimeMs)) {
        this.segmentIndexes.delete(name);
        if(this.segment===name){this.segment="";this.segmentBytes=0;}
      }
      const segmentIndex = this.segmentIndexes.get(name);
      if (passed && segmentIndex && !timelineSegmentMayMatch(segmentIndex, ids, types, needle)) continue;
      const segmentSize=metadata.size;
      if(segmentSize>SEGMENT_BYTES) {
        const capacity=take-result.length+1;
        if(!passed) {
          // Legacy ID cursors resolve to the newest matching ID in the newest segment
          // that contains it, as the old reverse array walk did. Find that valid-row
          // ordinal first so duplicate IDs need no page-sized snapshots while scanning.
          let validIndex=0,latestCursorIndex:number|null=null;
          await this.scan(name,event=>{
            if(event.id===cursor)latestCursorIndex=validIndex;
            validIndex++;
          });
          if(latestCursorIndex===null)continue;
          passed=true;
          const window=await this.scanPageWindow(name,capacity,latestCursorIndex,matches);
          for(const candidate of window.candidates) {
            if(result.length===take)return {items:result,nextCursor:lastPosition};
            result.push(candidate.event);
            lastPosition=`v1:${name}:${candidate.index}`;
          }
          continue;
        }
        const cursorIndex=position && name===position[1] ? Number(position[2]) : undefined;
        const window=await this.scanPageWindow(name,capacity,cursorIndex,matches);
        if(cursorIndex!==undefined && cursorIndex>=window.validCount)throw new Error("Invalid timeline cursor.");
        for(const candidate of window.candidates) {
          if(result.length===take)return {items:result,nextCursor:lastPosition};
          result.push(candidate.event);
          lastPosition=`v1:${name}:${candidate.index}`;
        }
        continue;
      }
      const events = await this.readPageSegment(name);
      if (position && name === position[1] && Number(position[2]) >= events.length) throw new Error("Invalid timeline cursor.");
      const start = position && name === position[1] ? Number(position[2]) - 1 : events.length - 1;
      for (let index = start; index >= 0; index--) {
        const event = events[index];
        if (!passed) { if (event.id === cursor) passed = true; continue; }
        if (!matches(event)) continue;
        if (result.length === take) return { items: result, nextCursor: lastPosition };
        result.push(event);
        lastPosition = `v1:${name}:${index}`;
      }
    }
    return { items: result, nextCursor: null };
  }

  usage(sessionIds?: string[],prices:UsagePrice[]=[]): UsageSummary {
    const scope=sessionIds ? new Set(sessionIds) : null;
    const entries:Array<[string,Usage]>=scope ? [] : [...this.usageBySession];
    if (scope) {
      for(const sessionId of scope)for(const key of this.usageKeysBySession.get(sessionId) ?? []) {
        const value=this.usageBySession.get(key);if(value)entries.push([key,value]);
      }
      if(scope.size>1)entries.sort((left,right)=>(left[1].timelineOrder ?? 0)-(right[1].timelineOrder ?? 0));
    }
    const values=new Map<string,Usage>();
    for(const [key,value] of entries) {
      // Cumulative snapshots follow a conversation across cards. Keep its latest observation, including a
      // lower reset value, not the largest value or a resumed budget baseline. Additive rows remain per-card.
      const identity=value.cumulative ? `counter:${snapshotIdentity(usageSession(key),value)}` : `additive:${key}`;
      const previous=values.get(identity);
      if(!previous || (value.sampleOrder ?? 0)>(previous.sampleOrder ?? 0))values.set(identity,value);
    }
    return usageSummary([...values.values()],prices);
  }

  usageCounters(sessionId:string,prices:UsagePrice[]=[]):TimelineUsageCounter[] {
    return [...(this.usageKeysBySession.get(sessionId) ?? [])].map(key=>{
      const value=this.usageBySession.get(key)!;
      return {id:key,legacyId:value.counterId ?? sessionId,tokens:totalTokens(value),costUsd:pricedCost(value,prices),
        inputTokens:value.input,outputTokens:value.output,provider:value.provider,model:value.model,accountId:value.accountId,taskId:value.taskId,
        source:value.source,counterId:value.counterId,cumulative:value.cumulative===true,reportedCostUsd:value.cost};
    });
  }

  /** One traversal supplies all active task roots while preserving legacy session-only rows. */
  taskBudgetUsageByTask(scopes:readonly TimelineTaskBudgetScope[],prices:UsagePrice[]=[]):Map<string,TimelineTaskBudgetData> {
    const sessionsByTask=new Map<string,Set<string>>(),rowsByTask=new Map<string,Map<string,{identity:string;sessionId:string;taskId?:string;tokens:number;costUsd:number;costKnown:boolean}>>();
    for(const scope of scopes) {
      let sessions=sessionsByTask.get(scope.taskId);
      if(!sessions){sessions=new Set();sessionsByTask.set(scope.taskId,sessions);rowsByTask.set(scope.taskId,new Map());}
      for(const sessionId of scope.sessionIds)sessions.add(sessionId);
    }
    const taskIds=new Set(sessionsByTask.keys());
    // Match sessionIds(taskId)'s historical ordering: explicit current members first,
    // then usage-bearing sessions in usage map insertion order.
    for(const [key,value] of this.usageBySession) {
      const sessionId=usageSession(key);
      if(taskIds.has(sessionId))sessionsByTask.get(sessionId)!.add(sessionId);
      if(value.taskId!==undefined && taskIds.has(value.taskId))sessionsByTask.get(value.taskId)!.add(sessionId);
    }
    const legacyTasksBySession=new Map<string,string[]>();
    for(const [taskId,sessions] of sessionsByTask)for(const sessionId of sessions) {
      let tasks=legacyTasksBySession.get(sessionId);
      if(!tasks){tasks=[];legacyTasksBySession.set(sessionId,tasks);}
      tasks.push(taskId);
    }
    const add=(taskId:string,contribution:BudgetUsageContribution):void=>{
      const rows=rowsByTask.get(taskId)!;
      const key=JSON.stringify([contribution.sessionId,contribution.identity,contribution.taskId ?? ""]);
      let row=rows.get(key);
      if(!row){row={identity:contribution.identity,sessionId:contribution.sessionId,...(contribution.taskId ? {taskId:contribution.taskId} : {}),tokens:0,costUsd:0,costKnown:true};rows.set(key,row);}
      row.tokens+=contribution.tokens;
      const cost=contribution.mode==="covered" ? 0
        : contribution.mode==="reported" || contribution.mode==="reported-base" ? contribution.reportedCostUsd
        : contribution.input!==null && contribution.output!==null && contribution.provider && contribution.model
          ? (()=>{const price=prices.find(item=>item.provider===contribution.provider && item.model===contribution.model);return price ? (contribution.input!*price.inputPerMillion+contribution.output!*price.outputPerMillion)/1_000_000 : null;})()
          : null;
      if(cost===null)row.costKnown=false;else row.costUsd+=cost;
    };
    for(const contribution of this.budgetUsageContributions.values()) {
      if(contribution.taskId!==undefined) {
        if(taskIds.has(contribution.taskId))add(contribution.taskId,contribution);
      } else for(const taskId of legacyTasksBySession.get(contribution.sessionId) ?? [])add(taskId,contribution);
    }
    const result=new Map<string,TimelineTaskBudgetData>();
    for(const [taskId,sessions] of sessionsByTask) {
      const rows=rowsByTask.get(taskId)!;
      result.set(taskId,{sessionIds:[...sessions],contributions:[...rows.values()].map(row=>({identity:row.identity,sessionId:row.sessionId,
        ...(row.taskId ? {taskId:row.taskId} : {}),tokens:row.tokens,costUsd:row.costKnown ? row.costUsd : null}))});
    }
    return result;
  }

  /** Latest sessions with real usage, including closed members whose counters still belong to a task. */
  sessionIds(taskId?:string):string[] {
    return [...new Set([...this.usageBySession].filter(([key,value])=>taskId===undefined || usageSession(key)===taskId || value.taskId===taskId).map(([key])=>usageSession(key)))];
  }

  /** Session and event-type facets derived only from retained, host-stamped journal rows. */
  taskSessions(taskId:string):Array<{id:string;title:string;types:string[]}> {
    return [...(this.taskSessionsByTask.get(taskId)?.values() ?? [])]
      .map(row=>({id:row.id,title:this.redact(row.title).slice(0,200),types:[...row.types.keys()].sort()}))
      .sort((left,right)=>left.id.localeCompare(right.id));
  }

  /** Periods measure observed increases; when no baseline was ever persisted, the first sample is the available real counter. */
  async breakdown(period:"all"|"day"|"week",taskId?:string,prices:UsagePrice[]=[]):Promise<UsageBreakdown[]> {
    await this.queue;
    const cutoff=period==="all" ? 0 : this.now()-(period==="day" ? 86400_000 : 7*86400_000);
    const counters=new Map<string,{input:number|null;output:number|null;total:number|null;cost:number|null}>();
    const rows=new Map<string,UsageBreakdown>();
    for(const file of await this.files())await this.scan(file,event=>{
      if(event.type!=="usage" || !event.detail)return;
      let value:Usage;try{value=JSON.parse(event.detail);}catch{return;}
      if(typeof value.source!=="string")return;
      // A resumed provider conversation can move to a new CanvasTTY card: share its baseline by counter identity,
      // while keeping the displayed delta attributed to the card that produced it.
      const counterKey=snapshotIdentity(event.sessionId,value);
      // All-time rows are snapshots too: attribute a shared counter to its latest in-scope card once.
      const rowKey=period==="all" && value.cumulative===true
        ? JSON.stringify(["cumulative",counterKey]) : JSON.stringify([event.sessionId,counterKey]);
      const base:UsageBreakdown={sessionId:event.sessionId,provider:value.provider ?? null,model:value.model ?? null,accountId:value.accountId ?? null,taskId:value.taskId ?? null,
        tokens:{input:null,output:null,total:null},costUsd:null,costSource:null,source:value.source,period};
      if(value.cumulative===true) {
        if(!isTimelineCount(value.total))return;
        const current={input:isTimelineCount(value.input)?value.input:null,output:isTimelineCount(value.output)?value.output:null,total:value.total,
          cost:typeof value.cost==="number" && Number.isFinite(value.cost) && value.cost>=0 ? value.cost : null};
        const previous=counters.get(counterKey);counters.set(counterKey,current);
        if(event.at<cutoff || taskId && value.taskId!==taskId && event.sessionId!==taskId)return;
        // A resumed conversation's first sample holds earlier runs' usage: it starts the period, it is not in it.
        if(period!=="all" && !previous && value.baseline===true)return;
        if(period==="all" || !previous) {
          // "all" uses cumulative totals; a period without a retained baseline counts its first available sample.
          const cost=pricedCost({...value,...current},prices),price=priceForUsage(value,prices);
          rows.set(rowKey,{...base,tokens:{input:current.input,output:current.output,total:current.total},costUsd:cost,
            costSource:cost===null?null:current.cost!==null?"reported":price?"human-price":null});
          return;
        }
        const counterReset=previous.total!==null && current.total<previous.total;
        const input=counterDelta(current.input,previous.input),output=counterDelta(current.output,previous.output),total=counterDelta(current.total,previous.total);
        if(input===null && output===null && total===null)return;
        let cost:number|null=null,costSource:UsageBreakdown["costSource"]=null;
        if(current.cost!==null && previous.cost!==null) {
          cost=counterReset ? current.cost : Math.max(0,current.cost-previous.cost);costSource="reported";
        } else {
          const price=priceForUsage(value,prices);
          if(price && input!==null && output!==null) {
            cost=(input*price.inputPerMillion+output*price.outputPerMillion)/1_000_000;costSource="human-price";
          }
        }
        const old=rows.get(rowKey),combinedCost=old && old.costUsd!==null && cost!==null ? old.costUsd+cost : !old ? cost : null;
        rows.set(rowKey,{...base,tokens:{input:addKnown(old?.tokens.input ?? null,input),output:addKnown(old?.tokens.output ?? null,output),total:addKnown(old?.tokens.total ?? null,total)},
          costUsd:combinedCost,costSource:combinedCost===null?null:costSource ?? old?.costSource ?? null});
        return;
      }
      if(event.at<cutoff || taskId && value.taskId!==taskId && event.sessionId!==taskId)return;
      if(!isTimelineCount(value.input) || !isTimelineCount(value.output))return;
      const previousRow=rows.get(rowKey),input=(previousRow?.tokens.input ?? 0)+value.input!,output=(previousRow?.tokens.output ?? 0)+value.output!;
      const price=priceForUsage(value,prices);
      const reported=typeof value.cost==="number" && Number.isFinite(value.cost) && value.cost>=0;
      const cost=pricedCost(value,prices);
      rows.set(rowKey,{...base,tokens:{input,output,total:input+output},costUsd:cost!==null && (!previousRow || previousRow.costUsd!==null) ? (previousRow?.costUsd ?? 0)+cost : null,
        costSource:reported ? "reported" : price ? "human-price" : null});
    });
    return [...rows.values()];
  }

  async report(sessionId: string): Promise<string> {
    await this.queue;
    const events: TimelineEvent[] = [];
    let truncated = false;
    for (const name of [...(await this.files())].reverse()) {
      const capacity=MAX_REPORT_EVENTS-events.length;
      const recent=createTimelineRing<TimelineEvent>(capacity);
      let seen=0,overflow=false;
      await this.scan(name,event=>{
        if(event.sessionId!==sessionId)return;
        if(capacity===0){truncated=true;return true;}
        if(seen++===capacity)overflow=true;
        recent.push(event);
      });
      events.push(...recent.newestFirst());
      if(overflow)truncated=true;
      if(truncated)break;
    }
    const sections: Array<[string, string[]]> = [
      ["Turns", ["lifecycle", "status"]], ["Tools, commands and files", ["tool", "command", "file"]],
      ["Protection and isolation", ["decision", "isolation", "git-risk", "budget", "network-policy"]],
      ["Human decisions", ["human", "secret-request", "secret-decision", "secret-revoked", "checkpoint"]]
    ];
    const lines = ["# CanvasTTY session report", "", `Session: ${sessionId}`, "",
      "Network visibility is incomplete: only addresses explicitly reported by hooks are known.", ""];
    for (const [title, types] of sections) {
      lines.push(`## ${title}`, "");
      const matching = events.filter((event) => types.includes(event.type)).reverse();
      lines.push(...(matching.length ? matching.map((event) => `- ${new Date(event.at).toISOString()} ${event.summary}${event.detail ? ` — ${event.detail}` : ""}`) : ["No events were reported by this provider."]), "");
    }
    if (truncated) lines.push("Report limited to the latest 10,000 events.");
    return this.redact(lines.join("\n"));
  }

  async flush(): Promise<void> { await this.queue; }
  subscribeUsage(listener: (sessionId: string) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }
  private applyUsageEvent(event: TimelineEvent): void {
    const update = nextTimelineUsage(this.usageBySession, event);
    if (!update) return;
    const previous = this.usageBySession.get(update.key);
    const latest=this.latestCounterSamples.get(snapshotIdentity(event.sessionId,update.value));
    this.storeUsage(update.key, event.sessionId, {...update.value,sampleOrder:this.nextSampleOrder++});
    if (usageCountersChanged(previous, update.value) || update.value.cumulative && previous?.sampleOrder!==latest?.sampleOrder) this.notifyUsageChanged(event.sessionId);
  }
  private storeUsage(key:string,sessionId:string,value:Usage):void {
    const previous=this.usageBySession.get(key);
    this.nextSampleOrder=Math.max(this.nextSampleOrder,(value.sampleOrder ?? -1)+1);
    if(value.cumulative) {
      const identity=snapshotIdentity(sessionId,value),latest=this.latestCounterSamples.get(identity);
      if(!latest || (value.sampleOrder ?? 0)>(latest.sampleOrder ?? 0))this.latestCounterSamples.set(identity,value);
    }
    this.usageBySession.set(key,{...value,timelineOrder:previous?.timelineOrder ?? this.nextUsageOrder++});
    let keys=this.usageKeysBySession.get(sessionId);
    if(!keys){keys=new Set();this.usageKeysBySession.set(sessionId,keys);}
    keys.add(key);
  }
  private notifyUsageChanged(sessionId:string):void {
    for(const listener of this.usageListeners)try{listener(sessionId);}catch{ /* A refresh listener cannot break timeline persistence. */ }
  }
  private async files(): Promise<string[]> {
    if (this.fileListCache) return this.fileListCache;
    this.fileListCache = (await readdir(this.directory)).filter((name) => /^\d{16}-[\w-]+\.ndjson$/.test(name)).sort();
    return this.fileListCache;
  }
  private async read(name: string): Promise<TimelineEvent[]> {
    const events: TimelineEvent[] = [];
    await this.scan(name, event => { events.push(event); });
    return events;
  }
  private scan(name:string,visit:(event:TimelineEvent)=>boolean|void):Promise<number> {
    return forEachTimelineEvent(join(this.directory,name),visit);
  }
  private async scanPageWindow(name:string,capacity:number,beforeIndex:number|undefined,
    matches:(event:TimelineEvent)=>boolean):Promise<{validCount:number;candidates:TimelinePageCandidate[]}> {
    const ring=createTimelineRing<TimelinePageCandidate>(capacity);
    let validCount=0;
    await this.scan(name,event=>{
      const index=validCount++;
      if((beforeIndex===undefined || index<beforeIndex) && matches(event))ring.push({event,index});
    });
    return {validCount,candidates:ring.newestFirst()};
  }
  private async readPageSegment(name: string): Promise<TimelineEvent[]> {
    const cached = this.pageCache;
    if (cached?.name === name) return cached.events;
    const metadata = await stat(join(this.directory, name));
    const events = await this.read(name);
    // Keep only one bounded segment. Large imported journals still page without retaining a large cache.
    this.pageCache = metadata.size <= SEGMENT_BYTES ? {name, size:metadata.size, mtimeMs:metadata.mtimeMs, events} : null;
    return events;
  }
  private async prune(): Promise<number> {
    const files = await this.files();
    const sizes = await Promise.all(files.map((name) => stat(join(this.directory, name)).then((s) => s.size)));
    let total = sizes.reduce((sum, size) => sum + size, 0);
    for (let i = 0; i < files.length && total > this.maxBytes; i++) {
      await unlink(join(this.directory, files[i])); total -= sizes[i];
      this.fileListCache = null;
      if (this.pageCache?.name === files[i]) this.pageCache = null;
      this.segmentIndexes.delete(files[i]);
      this.removeTaskSessionSegment(files[i]);
      if (files[i] === this.segment) { this.segment = ""; this.segmentBytes = 0; }
    }
    return total;
  }

  private removeTaskSessionSegment(segment:string):void {
    for(const [taskId,sessions] of this.taskSessionsByTask) {
      for(const [sessionId,descriptor] of sessions) {
        for(const [type,lastSegment] of descriptor.types)if(lastSegment===segment)descriptor.types.delete(type);
        // Pruning removes segments oldest-first, so no retained row exists for this actor when its latest segment is removed.
        if(descriptor.lastSegment===segment)sessions.delete(sessionId);
      }
      if(!sessions.size)this.taskSessionsByTask.delete(taskId);
    }
  }
}

function scanTimelineIndex(directory: string): Promise<TimelineDirectoryIndex> {
  const built = fileURLToPath(new URL("./SessionTimelineIndexWorker.js", import.meta.url));
  const source = fileURLToPath(new URL("./SessionTimelineIndexWorker.ts", import.meta.url));
  const path = existsSync(built) ? built : existsSync(source) ? source : null;
  if (!path) return Promise.reject(new Error("Session timeline index worker entry is missing."));
  const options: WorkerOptions = path.endsWith(".ts") ? { execArgv: ["--experimental-strip-types"] } : {};
  return new Promise((resolveResult, rejectResult) => {
    const worker = new Worker(path, { ...options, workerData: { directory } });
    let finished = false;
    const finish = (error: Error | null, value?: unknown): void => {
      if (finished) return;
      finished = true;
      void worker.terminate();
      if (error) rejectResult(error);
      else if (!isTimelineDirectoryIndex(value)) {
        rejectResult(new Error("Session timeline index worker returned invalid data."));
      } else resolveResult(value);
    };
    worker.once("message", (value: unknown) => {
      if (!value || typeof value !== "object" || "error" in value) {
        const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Session timeline index worker failed.";
        finish(new Error(message));
        return;
      }
      finish(null, value);
    });
    worker.once("error", error => finish(error instanceof Error ? error : new Error("Session timeline index worker failed.")));
    worker.once("exit", code => {
      if (!finished && code !== 0) finish(new Error(`Session timeline index worker exited (${code}).`));
      else if (!finished) finish(new Error("Session timeline index worker stopped before returning its index."));
    });
  });
}

function isTimelineDirectoryIndex(value: unknown): value is TimelineDirectoryIndex {
  if (!value || typeof value !== "object") return false;
  const index=value as Partial<TimelineDirectoryIndex>;
  return Number.isSafeInteger(index.lastSegmentAt) && index.usage instanceof Map && index.budgetUsage instanceof Map
    && index.budgetCounters instanceof Map && index.segments instanceof Map && index.taskSessions instanceof Map;
}
