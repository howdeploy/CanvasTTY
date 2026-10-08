import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { BACKLOG_IPC, BACKLOG_TERMINAL_IPC, BACKLOG_EVENTS, type WorkspacePreset, type NotificationPreferences, type UsagePrice, type SecretGrantDuration } from "../../shared/backlog.ts";
import { terminalFileDropText } from "../../shared/terminalFileDrop.ts";
import type { IpcRegistrar } from "./IpcReadinessGate.ts";
import type { TerminalManager } from "../services/TerminalManager.ts";
import type { SessionTimelineService } from "../services/SessionTimelineService.ts";
import type { GitCheckpoints } from "../services/GitCheckpoints.ts";
import type { WorkspaceArchive } from "../services/WorkspaceArchive.ts";
import type { TerminalOutputHistory } from "../services/TerminalOutputHistory.ts";

import type { AttentionService } from "../services/AttentionService.ts";

import type { OrchestrationTaskBoard, NewOrchestrationTask } from "../services/OrchestrationTaskBoard.ts";
import type { OrchestrationBudgetService, OrchestrationBudgetLimits } from "../services/OrchestrationBudgetService.ts";
import type { OrchestrationTemplateService } from "../services/OrchestrationTemplateService.ts";
import type { SecretGrantService } from "../services/SecretGrantService.ts";

import type { UsagePrices } from "../services/UsagePrices.ts";
import type {SessionReports} from "../services/SessionReports.ts";
interface Dependencies {
  reports?:SessionReports;
  usagePrices:UsagePrices;
  board:OrchestrationTaskBoard; budgets:OrchestrationBudgetService; flows:OrchestrationTemplateService;
  taskRoot(id:string):{id:string;cwd:string;startedAt:number};
  attention: AttentionService;
  secretGrants?: SecretGrantService;
  outputHistory: TerminalOutputHistory;
  terminals: TerminalManager; timeline: SessionTimelineService; checkpoints: GitCheckpoints; workspace: WorkspaceArchive;
  getMainWindow(): BrowserWindow | null;
}
export function registerBacklogIpc(ipc: IpcRegistrar, deps: Dependencies): void {
  const {terminals,timeline,checkpoints,workspace,outputHistory} = deps;
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
  handle(BACKLOG_IPC.broadcast,(ids:unknown,text:unknown)=>{
    if(!Array.isArray(ids) || ids.length>100 || ids.some(id=>typeof id!=="string") || typeof text!=="string" || !text.trim() || text.length>16_000)throw new Error("Invalid broadcast input.");
    const data=terminals.redactSecrets(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,"");
    const delivered:string[]=[],skipped:string[]=[];
    for(const id of new Set<string>(ids)){
      const row=terminals.getMetadata(id);
      if(!row || row.exitCode!==null || row.status!=="idle" && row.status!=="working"){skipped.push(id);continue;}
      try{terminals.pasteClipboard(id,data,row.startedAt,{submit:true});delivered.push(id);}catch{skipped.push(id);}
    }
    return {delivered,skipped};
  });
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
  const secretScope = (id: string): { task: {id:string;cwd:string;startedAt:number}; sessionIds: string[] } => {
    const task = root(id);
    const sessionIds = terminals.listMetadata().flatMap((row) => {
      try { return deps.taskRoot(row.id).id === task.id ? [row.id] : []; }
      catch { return []; }
    });
    return { task, sessionIds: sessionIds.length ? sessionIds : [id] };
  };
  const grants = (): SecretGrantService => {
    if (!deps.secretGrants) throw new Error("Secret-grant controls are unavailable.");
    return deps.secretGrants;
  };
  handle(BACKLOG_IPC.secretRequests, (id: string) => {
    const scope = secretScope(id);
    return grants().pending(scope.sessionIds).map((request) => ({ ...request, reason: terminals.redactSecrets(request.reason) }));
  });
  handle(BACKLOG_IPC.secretGrants, (id: string) => grants().listGrants(secretScope(id).sessionIds));
  handle(BACKLOG_IPC.approveSecretRequest, (id: string, requestId: string, duration: SecretGrantDuration) => {
    if (typeof requestId !== "string" || requestId.length > 64 || !["10m", "turn", "session"].includes(duration)) throw new Error("Invalid secret approval request.");
    const service = grants(), scope = secretScope(id);
    if (!service.pending(scope.sessionIds).some((request) => request.id === requestId)) throw new Error("Secret request is outside this task or has expired.");
    return service.approve(requestId, duration);
  });
  handle(BACKLOG_IPC.denySecretRequest, (id: string, requestId: string) => {
    if (typeof requestId !== "string" || requestId.length > 64) throw new Error("Invalid secret request.");
    const service = grants(), scope = secretScope(id);
    if (!service.pending(scope.sessionIds).some((request) => request.id === requestId)) throw new Error("Secret request is outside this task or has expired.");
    service.deny(requestId);
  });
  handle(BACKLOG_IPC.revokeSecretGrant, (id: string, grantSessionId: string, secretId: string) => {
    const service = grants(), scope = secretScope(id);
    if (typeof grantSessionId !== "string" || !scope.sessionIds.includes(grantSessionId)) throw new Error("Secret grant is outside this task.");
    return service.revoke(grantSessionId, secretId);
  });
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
  handle(BACKLOG_IPC.exportWorkspace, async () => {
    const value=JSON.parse(workspace.export()),roots=new Map<string,{id:string;cwd:string;startedAt:number}>();
    const exportedIds=new Set<string>(value.sessions.map((row:{id:string})=>row.id));
    const rows=terminals.listMetadata().filter(row=>exportedIds.has(row.id)),rootCards=new Map(rows.filter(row=>!row.parentSessionId).map(row=>[row.taskScope?.id ?? row.id,row.id]));
    for(const row of rows){const task=root(row.id);roots.set(task.id,task);if(!rootCards.has(task.id))rootCards.set(task.id,row.id);}
    value.tasks=await Promise.all([...roots.values()].map(async task=>({rootSessionId:rootCards.get(task.id) ?? task.id,tasks:(await deps.board.listTasks(task.cwd,task.id)).tasks})));
    return JSON.stringify(masked(value),null,2);
  });
  handle(BACKLOG_IPC.previewImport, (text: string) => workspace.preview(text));
  handle(BACKLOG_IPC.importWorkspace, async (text: string, options: {confirmBypass?:unknown}) => {
    // Version/size/session validation runs before any JSON extras are considered.
    await workspace.preview(text);
    const value=JSON.parse(text),groups=value.tasks;
    if(groups!==undefined && (!Array.isArray(groups) || groups.length>100))throw new Error("Invalid workspace task groups.");
    const result=await workspace.import(text,options?.confirmBypass === true);
    for(const group of groups ?? []) {
      if(!group || typeof group.rootSessionId!=="string") {result.warnings.push("An invalid task group was skipped.");continue;}
      const restored=Object.hasOwn(result.restoredIds,group.rootSessionId) ? result.restoredIds[group.rootSessionId] : undefined;
      if(typeof restored!=="string" || !restored)continue;
      try{await deps.board.importGroup(session(restored).cwd,restored,masked(group.tasks),result.restoredIds);}
      catch(error){result.warnings.push(`Task board: ${error instanceof Error ? error.message : "could not be restored"}`);}
    }
    return {warnings:result.warnings,sessions:result.sessions};
  });
  handle(BACKLOG_IPC.workspacePresets, () => workspace.presets());
  handle(BACKLOG_IPC.saveWorkspacePreset, (preset: WorkspacePreset) => workspace.savePreset(preset));
  handle(BACKLOG_IPC.deleteWorkspacePreset, (id: string) => workspace.deletePreset(id));
  handle(BACKLOG_TERMINAL_IPC.describeFileDrop, async (paths: unknown, id: string) => {
    if (!Array.isArray(paths) || paths.length > 100 || !paths.every((entry) => typeof entry === "string" && entry.length < 4096)) throw new Error("Invalid dropped files.");
    const row=session(id), root=await realpath(terminals.pluginContext(row.id)?.workingDirectory ?? row.cwd);
    const canonical=await Promise.all(paths.map((path: string) => realpath(path)));
    const outsideProject=canonical.filter((path) => {const rel=relative(root,path);return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);});
    return {text:terminals.redactSecrets(terminalFileDropText(canonical,process.platform)),paths:canonical,outsideProject};
  });
  handle(BACKLOG_TERMINAL_IPC.paste, (id: string, text: unknown) => {
    const startedAt=session(id).startedAt; if (typeof text !== "string" || text.length > 16_000) throw new Error("Context paste is limited to 16,000 characters.");
    const clean=terminals.redactSecrets(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,"");
    terminals.pasteClipboard(id,clean,startedAt);
  });
  handle(BACKLOG_TERMINAL_IPC.searchOutput, async (query: unknown, requested?: unknown) => {
    if (typeof query !== "string" || query.length > 200 || !query.trim()) return {matches:[],prunedSessionIds:[]};
    if (requested !== undefined && (!Array.isArray(requested) || requested.length>256 || requested.some((id) => typeof id !== "string"))) throw new Error("Invalid session list.");
    return outputHistory.search(query,Array.isArray(requested) ? requested as string[] : undefined);
  });
  handle(BACKLOG_TERMINAL_IPC.readOutputContext, async (id: string, offset: unknown) => {
    session(id);
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid output offset.");
    return outputHistory.readContext(id,offset);
  });
}
