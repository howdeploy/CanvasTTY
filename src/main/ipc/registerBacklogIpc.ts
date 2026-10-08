import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { BACKLOG_IPC, BACKLOG_EVENTS, type NotificationPreferences, type UsagePrice } from "../../shared/backlog.ts";
import type { IpcRegistrar } from "./IpcReadinessGate.ts";
import type { TerminalManager } from "../services/TerminalManager.ts";
import type { SessionTimelineService } from "../services/SessionTimelineService.ts";
import type { GitCheckpoints } from "../services/GitCheckpoints.ts";

import type { AttentionService } from "../services/AttentionService.ts";

import type { OrchestrationTaskBoard, NewOrchestrationTask } from "../services/OrchestrationTaskBoard.ts";
import type { OrchestrationBudgetService, OrchestrationBudgetLimits } from "../services/OrchestrationBudgetService.ts";
import type { OrchestrationTemplateService } from "../services/OrchestrationTemplateService.ts";

import type { UsagePrices } from "../services/UsagePrices.ts";
import type {SessionReports} from "../services/SessionReports.ts";
interface Dependencies {
  reports?:SessionReports;
  usagePrices:UsagePrices;
  board:OrchestrationTaskBoard; budgets:OrchestrationBudgetService; flows:OrchestrationTemplateService;
  taskRoot(id:string):{id:string;cwd:string;startedAt:number};
  attention: AttentionService;
  terminals: TerminalManager; timeline: SessionTimelineService; checkpoints: GitCheckpoints;
  getMainWindow(): BrowserWindow | null;
}
export function registerBacklogIpc(ipc: IpcRegistrar, deps: Dependencies): void {
  const {terminals,timeline,checkpoints} = deps;
  deps.board.subscribe(change=>{
    const window=deps.getMainWindow();
    if(!window || window.isDestroyed() || window.webContents.isDestroyed())return;
    window.webContents.send(BACKLOG_EVENTS.taskBoardChanged,{rootSessionId:change.rootSessionId,revision:change.revision});
  });
  const trust = (event: IpcMainInvokeEvent) => {
    const window = deps.getMainWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Untrusted backlog caller.");
  };
  const session = (id: unknown) => {
    if (typeof id !== "string") throw new Error("Session id is required.");
    const row = terminals.getMetadata(id); if (!row) throw new Error("Session no longer exists."); return row;
  };
  const handle = (channel: string, fn: (...args: any[]) => unknown) => ipc.handle(channel, (event, ...args) => {trust(event);return fn(...args);});
  const root=(id:string)=>{session(id);return deps.taskRoot(id);};
  const masked=(value:unknown):unknown=>typeof value==="string" ? terminals.redactSecrets(value) : Array.isArray(value) ? value.map(masked) : value && typeof value==="object" ? Object.fromEntries(Object.entries(value).map(([key,row])=>[key,masked(row)])) : value;
  handle(BACKLOG_IPC.tasks,(id:string)=>{const task=root(id);return deps.board.listTasks(task.cwd,task.id);});
  handle(BACKLOG_IPC.addTask,async(id:string,input:NewOrchestrationTask)=>{
    const task=root(id);
    if(input?.ownerSessionId && root(input.ownerSessionId).id!==task.id)throw new Error("Task owner must belong to this orchestration tree.");
    const row=await deps.board.addTask(task.cwd,task.id,task.id,masked(input) as NewOrchestrationTask);
    await timeline.append(task.id,"task","Person added a board task",row.title);return row;
  });
  handle(BACKLOG_IPC.assignTask,async(id:string,taskId:string,ownerId:string|null)=>{
    const task=root(id);if(ownerId!==null && root(ownerId).id!==task.id)throw new Error("Task owner must belong to this orchestration tree.");
    const row=await deps.board.assignTask(task.cwd,task.id,taskId,ownerId,ownerId ? terminals.redactSecrets(session(ownerId).title) : null);
    await timeline.append(task.id,"task","Person assigned a board task",row.title);return row;
  });
  handle(BACKLOG_IPC.closeTask,async(id:string,taskId:string)=>{
    const task=root(id),row=await deps.board.closeTask(task.cwd,task.id,taskId);await timeline.append(task.id,"task","Person closed a board task",row.title);return row;
  });
  handle(BACKLOG_IPC.budget,(id:string)=>{const task=root(id);return deps.budgets.snapshot(task.id,task.startedAt);});
  handle(BACKLOG_IPC.setBudget,async(id:string,limits:OrchestrationBudgetLimits)=>{
    const task=root(id),row=await deps.budgets.setLimits(task.id,limits,task.startedAt);await timeline.append(task.id,"budget","Person changed task limits",JSON.stringify(row.limits));return row;
  });
  handle(BACKLOG_IPC.clearBudget,async(id:string)=>{
    const task=root(id),row=await deps.budgets.clearLimits(task.id,task.startedAt);await timeline.append(task.id,"budget","Person removed task limits");return row;
  });
  handle(BACKLOG_IPC.saveTaskFlow,async(id:string,name:string)=>{
    const parent=session(id);if(parent.role!=="orchestrator")throw new Error("Choose an orchestrator to save its layout as a flow.");
    if(typeof name!=="string" || !name.trim() || name.length>120)throw new Error("Flow name must contain 1–120 characters.");
    const children=terminals.listMetadata().filter(row=>row.parentSessionId===id);
    if(!children.length || children.length>16)throw new Error("A flow needs 1–16 direct subagents.");
    const file=await deps.flows.save(root(id).cwd,{
      id:`task-${Date.now()}`,name:terminals.redactSecrets(name.trim()),description:"Saved from an orchestrator's card layout.",
      roles:children.map((child,index)=>({id:`worker-${index+1}`,title:terminals.redactSecrets(child.title),count:1,
        instruction:terminals.redactSecrets(`Work on the subtask ${child.title}. Report your result to the orchestrator.`),
        ...(child.model ? {model:child.model} : {}),...(child.effort ? {effort:child.effort} : {})})),
      finalStep:"Gather every worker's result, resolve disagreements, and deliver one final answer."
    });
    await timeline.append(id,"flow","Person saved this layout as a project flow",file);return {file};
  });
  handle(BACKLOG_IPC.flows,async(projectRoot:string)=>masked(await deps.flows.list(projectRoot)));
  handle(BACKLOG_IPC.previewFlow,async(projectRoot:string,flowId:string)=>masked(await deps.flows.preview(projectRoot,flowId)));
  handle(BACKLOG_IPC.approveFlow,async(projectRoot:string,flowId:string,digest:string)=>deps.flows.approve(projectRoot,flowId,digest));
  handle(BACKLOG_IPC.flowInstructions,async(projectRoot:string,flowId:string)=>{
    const listing=await deps.flows.list(projectRoot),flow=listing.templates.find(row=>row.id===flowId);if(!flow)throw new Error("Flow no longer exists.");
    return terminals.redactSecrets(deps.flows.instructions(flow));
  });
  handle(BACKLOG_IPC.notificationPreferences, () => deps.attention.get());
  handle(BACKLOG_IPC.setNotificationPreferences, (value:NotificationPreferences) => deps.attention.set(value));
  handle(BACKLOG_IPC.notifications, () => deps.attention.list("desktop"));
  handle(BACKLOG_IPC.sendInstructions, async (id:string,text:unknown) => {
    session(id);if(typeof text!=="string" || text.length>32_000)throw new Error("Invalid instructions.");
    const result=await terminals.deliverInput(id,`${terminals.redactSecrets(text)}\r`);if(!result.delivered)throw new Error(`Agent did not accept the instructions: ${result.reason}`);
  });
  handle(BACKLOG_IPC.redactText, (text: unknown) => {
    if (typeof text !== "string" || text.length > 1_000_000) throw new Error("Text is invalid or too large."); return terminals.redactSecrets(text);
  });
  handle(BACKLOG_IPC.timeline, async (id: string, cursor?: string, limit?: number,filter?:{query?:string;types?:string[];sessionIds?:string[]}) => {
    const task=root(id);
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 100)) throw new Error("Invalid timeline cursor.");
    await timeline.flush();
    const live=terminals.listMetadata().filter(row=>terminals.taskScopeFor(row.id).id===task.id);
    const retained=timeline.taskSessions(task.id);
    const agents=new Map(retained.map(row=>[row.id,{id:row.id,title:row.title}]));
    for(const row of live)agents.set(row.id,{id:row.id,title:terminals.redactSecrets(row.title || row.provider)});
    // A continued root keeps the original task identity, including its older root/budget journal.
    const allowed=new Set([task.id,...agents.keys()]);
    if(filter) {
      if(typeof filter!=="object" || filter.query!==undefined && (typeof filter.query!=="string" || filter.query.length>200)
        || filter.types!==undefined && (!Array.isArray(filter.types) || filter.types.length>30 || filter.types.some(type=>typeof type!=="string" || type.length>80))
        || filter.sessionIds!==undefined && (!Array.isArray(filter.sessionIds) || filter.sessionIds.length>100 || filter.sessionIds.some(other=>typeof other!=="string" || !allowed.has(other))))throw new Error("Invalid timeline filter.");
    }
    const page=await timeline.page(id,cursor,limit,{...filter,sessionIds:filter?.sessionIds ?? [...allowed]},
      {taskId:task.id,legacySessionIds:[task.id,...live.map(row=>row.id)]});
    return {...page,facets:{agents:[...agents.values()],types:[...new Set(retained.flatMap(row=>row.types))].sort()}};
  });
  const subtree = (id?: string) => {
    if (!id) return undefined;
    const selected = session(id), ids = new Set([id]), rows = terminals.listMetadata();
    const childrenByParent = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parentSessionId) continue;
      const children = childrenByParent.get(row.parentSessionId) ?? [];
      children.push(row.id);
      childrenByParent.set(row.parentSessionId, children);
    }
    const queue = [id];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const childId of childrenByParent.get(queue[cursor]!) ?? []) {
        if (ids.has(childId)) continue;
        ids.add(childId);
        queue.push(childId);
      }
    }
    if(!selected.parentSessionId)for(const historicalId of timeline.sessionIds(root(id).id))ids.add(historicalId);
    return [...ids];
  };
  handle(BACKLOG_IPC.usagePrices,()=>deps.usagePrices.get());
  handle(BACKLOG_IPC.setUsagePrices,(rows:UsagePrice[])=>deps.usagePrices.set(rows));
  handle(BACKLOG_IPC.usageBreakdown,(id:string|undefined,period:"all"|"day"|"week")=>{
    if(!["all","day","week"].includes(period))throw new Error("Invalid usage period.");
    return timeline.breakdown(period,id ? root(id).id : undefined,deps.usagePrices.get());
  });
  handle(BACKLOG_IPC.usage, (id?: string) => timeline.usage(subtree(id),deps.usagePrices.get()));
  handle(BACKLOG_IPC.report, (id: string) => {session(id);return deps.reports?.report(id) ?? timeline.report(id);});
  handle(BACKLOG_IPC.checkpoints, async (id: string) => {
    const row=session(id); if (!await checkpoints.available(row.cwd)) throw new Error("Rollback points are unavailable: the card folder must be a Git project root.");
    return checkpoints.list(id,row.cwd);
  });
  handle(BACKLOG_IPC.previewCheckpoint, (id: string, ref: string) => checkpoints.preview(id,session(id).cwd,ref));
  handle(BACKLOG_IPC.restoreCheckpoint, async (id: string, ref: string) => {
    session(id);
    const result=await terminals.withCheckpointRestore(id,cwd=>checkpoints.restore(id,cwd,ref));
    await timeline.append(id,"checkpoint","Person restored a checkpoint",ref);return result;
  });
}
