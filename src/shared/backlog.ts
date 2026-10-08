
export interface TimelineEvent {
  id: string; sessionId: string; at: number; type: string; summary: string;
  detail?: string; source?: string; taskId?: string; sessionTitle?: string;
}
export interface TimelineFacets { agents: Array<{id:string;title:string}>; types: string[] }
export interface UsageSummary {
  tokens: { input: number | null; output: number | null; total: number | null };
  cost: number | null; currency: string; source: string | null;
}
export interface UsagePrice {provider:string;model:string;inputPerMillion:number;outputPerMillion:number}
export interface UsageBreakdown {sessionId:string;provider:string|null;model:string|null;accountId:string|null;taskId:string|null;tokens:{input:number|null;output:number|null;total:number|null};costUsd:number|null;costSource:"reported"|"human-price"|null;source:string;period:"all"|"day"|"week"}
export type NotificationChannel = "desktop"|"phone"|"glasses";
export interface NotificationPreferences {version:1;channels:Record<NotificationChannel,boolean>;quietUntil:number|null;importantOnly:boolean;sessionIds:string[]|null}
export interface AttentionEvent {id:string;sessionId:string;title:string;kind:"response"|"approval"|"done"|"failed"|"budget"|"loop";at:number}
export interface BacklogApi {
  notificationPreferences():Promise<NotificationPreferences>;
  setNotificationPreferences(value:NotificationPreferences):Promise<NotificationPreferences>;
  notifications():Promise<AttentionEvent[]>;
  timeline(sessionId: string, cursor?: string, limit?: number, filter?:{query?:string;types?:string[];sessionIds?:string[]}): Promise<{items: TimelineEvent[]; nextCursor: string | null; facets?: TimelineFacets}>;
  usagePrices():Promise<UsagePrice[]>;
  setUsagePrices(rows:UsagePrice[]):Promise<UsagePrice[]>;
  usageBreakdown(sessionId:string|undefined,period:"all"|"day"|"week"):Promise<UsageBreakdown[]>;
  usage(sessionId?: string): Promise<UsageSummary>;
  report(sessionId: string): Promise<string>;

  onTaskBoardChanged(listener:(change:{rootSessionId:string;revision:number})=>void):()=>void;
  sendInstructions(sessionId:string,text:string):Promise<void>;
  tasks(sessionId: string): Promise<{revision:number;tasks: Array<{id:string;rootSessionId:string;title:string;description:string;progress:string;ownerSessionId:string|null;ownerName:string|null;status:"open"|"claimed"|"done"|"closed";dependencies:string[];result:string|null;createdBySessionId:string;createdAt:number;updatedAt:number}>}>;
  addTask(sessionId: string, input: {title:string;description?:string;dependencies?:string[];ownerSessionId?:string|null;ownerName?:string|null}): Promise<unknown>;
  assignTask(sessionId: string, taskId: string, ownerId: string|null): Promise<unknown>;
  closeTask(sessionId: string, taskId: string): Promise<unknown>;
  budget(sessionId: string): Promise<TaskBudgetSnapshot>;
  setBudget(sessionId: string, limits: {tokens:number|null;costUsd:number|null;durationMs:number|null}): Promise<TaskBudgetSnapshot>;
  clearBudget(sessionId: string): Promise<TaskBudgetSnapshot>;
  saveTaskFlow(sessionId:string,name:string):Promise<{file:string}>;
  flows(projectRoot: string): Promise<{templates:FlowTemplate[];errors:Array<{file:string;line:number;message:string}>}>;
  flowInstructions(projectRoot:string, flowId:string): Promise<string>;
  previewFlow(projectRoot:string, flowId:string): Promise<{instructions:string;digest:string|null}>;
  approveFlow(projectRoot:string, flowId:string, digest:string): Promise<void>;
  redactText(text: string): Promise<string>;
  checkpoints(sessionId: string): Promise<Array<{id: string; at: number; label?: string}>>;
  previewCheckpoint(sessionId: string, id: string): Promise<{text: string; changedFiles: string[]}>;
  restoreCheckpoint(sessionId: string, id: string): Promise<{ok: boolean; message?: string}>;
}
export interface TaskBudgetSnapshot {
  rootSessionId:string;limits:{tokens:number|null;costUsd:number|null;durationMs:number|null};
  usage:{tokens:number|null;costUsd:number|null;durationMs:number|null};remaining:{tokens:number|null;costUsd:number|null;durationMs:number|null};
  warning:boolean;paused:boolean;reason?:string;data:{tokens:"available"|"none";costUsd:"available"|"partial"|"none";duration:"available"|"none"};
}
export interface FlowTemplate {
  id:string;name:string;description:string;roles:Array<{id:string;title:string;instruction:string;count:number;model?:string;effort?:string}>;
  finalStep:string;expectedSubagents:number;builtIn:boolean;source?:string;trusted?:boolean;digest?:string;
}
export const BACKLOG_IPC = {
  notificationPreferences:"backlog:notifications-preferences",
  setNotificationPreferences:"backlog:notifications-set",
  notifications:"backlog:notifications",
  timeline: "backlog:timeline",
  usagePrices:"backlog:usage-prices",
  setUsagePrices:"backlog:usage-prices-set",
  usageBreakdown:"backlog:usage-breakdown",
  usage: "backlog:usage",
  report: "backlog:report",
  checkpoints: "backlog:checkpoints", previewCheckpoint: "backlog:checkpoint-preview", restoreCheckpoint: "backlog:checkpoint-restore",
  sendInstructions:"backlog:instructions",
  tasks:"backlog:tasks",
  addTask:"backlog:task-add",
  assignTask:"backlog:task-assign",
  closeTask:"backlog:task-close",
  budget:"backlog:budget",
  setBudget:"backlog:budget-set",
  clearBudget:"backlog:budget-clear",
  saveTaskFlow:"backlog:flow-save-task",
  flows:"backlog:flows",
  flowInstructions:"backlog:flow-instructions",
  previewFlow:"backlog:flow-preview",
  approveFlow:"backlog:flow-approve",
  redactText:"backlog:redact",
} as const;
export const BACKLOG_EVENTS={taskBoardChanged:"backlog:task-board-changed"} as const;

export const BACKLOG_TERMINAL_IPC = {focusRequested: "terminal:focus-requested"} as const;
