import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { BACKLOG_IPC, type AgentNetworkPolicy } from "../../shared/backlog.ts";
import type { IpcRegistrar } from "./IpcReadinessGate.ts";
import type { NetworkPolicyManager } from "../services/isolation/networkPolicy.ts";

export function registerNetworkPolicyIpc(ipc:IpcRegistrar,deps:{
  manager:NetworkPolicyManager;
  getMainWindow():BrowserWindow|null;
  taskRoot(id:string):{cwd:string};
  revokeBrowserCapabilities(projectRoot?:string):void;
  audit(sessionId:string|undefined,policy:AgentNetworkPolicy):void;
}):void {
  const trust=(event:IpcMainInvokeEvent)=>{
    const window=deps.getMainWindow();
    if(!window || event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame)throw new Error("Untrusted network policy caller.");
  };
  const project=(id:unknown)=>{
    if(id===undefined)return undefined;
    if(typeof id!=="string" || !id)throw new Error("Session id is required.");
    return deps.taskRoot(id).cwd;
  };
  ipc.handle(BACKLOG_IPC.networkPolicy,(event,id)=>{
    trust(event);const cwd=project(id),available=deps.manager.availability();
    return {policy:deps.manager.getPolicy(cwd),...available,...(cwd ? {projectRoot:cwd} : {})};
  });
  ipc.handle(BACKLOG_IPC.setNetworkPolicy,(event,id,policy:AgentNetworkPolicy)=>{
    trust(event);const cwd=project(id),next=deps.manager.setPolicy(policy,cwd);
    deps.revokeBrowserCapabilities(cwd);
    deps.audit(id,next);return next;
  });
}
