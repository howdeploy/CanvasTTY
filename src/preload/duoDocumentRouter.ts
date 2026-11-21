import { IPC, type AppSettings, type PixelSkinPackSummary } from '../shared/contracts';
import type { DuoReply } from '../shared/canvasDuo';
import { DUO_SETTINGS_KEYS, duoSettingsOps, type DuoDocument, type DuoDocumentOp } from '../shared/duoDocument';
import { DUO_RESOURCE_TRANSFER_LIMIT, DUO_READ_CHANNELS, DUO_WRITE_CHANNELS, DUO_LOCAL_BROWSER_SENDS } from '../shared/duoResources';

/** Routes only explicit Canvas capabilities. The global API and the local profile are never replaced. */
export function createDuoDocumentRouter(raw:(channel:string,...args:any[])=>Promise<any>,emit:(channel:string,payload:any)=>void){
  let document:DuoDocument|null=null,localSettings:AppSettings|null=null,workspace='',sequence=0;
  let matchingPacks: Promise<Set<string>> | undefined;
  let confirmed:DuoDocument|null=null;
  const pending:Array<{ops:DuoDocumentOp[]}> = [];
  const project=():DuoDocument|null=>{
    if(!confirmed)return null;
    const settings={...confirmed.settings} as Record<string,any>;
    for(const edit of pending)for(const op of edit.ops){
      if(!op.id){settings[op.key]=op.after;continue;}
      const items=[...(settings[op.key]??[])],at=items.findIndex((item:any)=>item.id===op.id);
      if(op.after===null){if(at>=0)items.splice(at,1);}
      else if(at<0)items.push(op.after);
      else if(op.fields){const next={...items[at]};for(const field of op.fields)next[field]=(op.after as any)[field];items[at]=next;}
      else items[at]=op.after;
      settings[op.key]=items;
    }
    return {...confirmed,settings:settings as DuoDocument['settings']};
  };
  let settingsQueue:Promise<unknown>=Promise.resolve();
  const notify=(next:DuoDocument,previous:DuoDocument|null):void=>{
    const differs=(key:keyof DuoDocument)=>JSON.stringify(next[key])!==JSON.stringify(previous?.[key]);
    if(differs('settings')&&localSettings)emit(IPC.settingsChanged,{...localSettings,...next.settings});
    if(differs('materials'))emit(IPC.materialsChanged,next.materials);
    if(differs('browser'))emit(IPC.browserState,{snapshot:next.browser});
    for(const event of next.storageEvents??[])if(!previous?.storageEvents?.some(old=>old.pluginId===event.pluginId&&old.key===event.key&&old.version===event.version))emit(IPC.pluginsStorageChanged,event);
  };
  const acceptNow=async(reply:DuoReply):Promise<DuoReply>=>{
    if(reply.state.role==='guest'&&reply.state.documentSync){
      if(workspace!==reply.state.workspaceId){matchingPacks=undefined;workspace=reply.state.workspaceId??'';sequence=0;document=null;confirmed=null;pending.length=0;localSettings=await raw(IPC.settingsGet);}
      if(reply.snapshot?.document&&(reply.snapshot.sequence??0)>=sequence){
        sequence=reply.snapshot.sequence??0;const previous=document;confirmed=reply.snapshot.document;document=project();if(document)notify(document,previous);
      }
    }else if(workspace){
      matchingPacks=undefined;workspace='';document=null;confirmed=null;pending.length=0;sequence=0;
      const [settings,materials,browser]=await Promise.all([raw(IPC.settingsGet),raw(IPC.materialsSnapshot),raw(IPC.browserGetState)]);
      localSettings=settings;emit(IPC.settingsChanged,settings);emit(IPC.materialsChanged,materials);emit(IPC.browserState,{snapshot:browser});
    }
    return reply;
  };
  let acceptance:Promise<unknown>=Promise.resolve();
  const accept=(reply:DuoReply):Promise<DuoReply>=>{
    const task=acceptance.catch(()=>undefined).then(()=>acceptNow(reply));acceptance=task;return task;
  };
  const command=async(command:unknown):Promise<DuoReply>=>accept(await raw(IPC.duoCommand,command));
  const readResource=async(channel:string,args:unknown[]):Promise<any>=>{
    const active=workspace;
    let reply=await command({action:'resource',channel,args});let part=reply.snapshot?.result as any;
    if(part?.chunk){
      let text=part.data;const total=part.total,id=part.chunk;
      if(!Number.isSafeInteger(total)||total>32*1024*1024)throw Error('Invalid shared resource size.');
      while(text.length<total){
        if(workspace!==active)throw Error('Duo workspace changed.');
        reply=await command({action:'resource',channel:'chunk',args:[id,text.length]});part=reply.snapshot?.result;
        if(!part||part.chunk!==id||part.offset!==text.length||typeof part.data!=='string'||!part.data.length)throw Error('Invalid shared resource chunk.');
        text+=part.data;
      }
      part = { value: JSON.parse(text) };
    }
    if (workspace !== active) throw Error("Duo workspace changed.");
    const value = part?.value;
    if (value && typeof value.base64 === 'string' &&
        [IPC.wallpapersRead, IPC.pixelSkinsReadAsset, IPC.authorThemesPreview].some(key => key === channel)) {
      const bytes = Uint8Array.from(atob(value.base64), char => char.charCodeAt(0));
      return channel === IPC.wallpapersRead ? { summary: value.summary, bytes } : bytes;
    }
    return value;
  };
  // Hold a slot until the final chunk, including the gaps between requests.
  const waiting: Array<() => void> = [];
  let activeTransfers = 0;
  const resource = async (channel: string, args: unknown[]): Promise<any> => {
    const room = workspace;
    if (activeTransfers < DUO_RESOURCE_TRANSFER_LIMIT) activeTransfers++;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      if (workspace !== room) throw Error("Duo workspace changed.");
      return await readResource(channel, args);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else activeTransfers--;
    }
  };
  const invoke=async(channel:string,...args:any[]):Promise<any>=>{
    if(channel===IPC.duoCommand)return command(args[0]);
    if(!document)return raw(channel,...args);
    if(channel===IPC.authorThemesApply)throw new Error("Only the host can apply a theme in a shared Canvas.");
    if(channel===IPC.settingsGet)return {...localSettings,...document.settings};
    if(channel===IPC.settingsUpdate){
      const active=workspace,patch=args[0] as Partial<AppSettings>,base=document.settings;
      // Build the diff at invocation time, before later snapshots can change the base.
      const ops=duoSettingsOps(base,patch);
      const edit={ops};if(ops.length){pending.push(edit);const previous=document;document=project();if(document)notify(document,previous);}
      const privatePatch=Object.fromEntries(Object.entries(patch).filter(([key])=>!DUO_SETTINGS_KEYS.includes(key as any)));
      const task=settingsQueue.catch(()=>undefined).then(async()=>{
        if(workspace!==active)throw Error('Duo workspace changed.');
        if(Object.keys(privatePatch).length)localSettings=await raw(IPC.settingsUpdate,privatePatch);
        if(ops.length)try{
          const reply=await raw(IPC.duoCommand,{action:'document-edit',ops});
          pending.splice(pending.indexOf(edit),1);await accept(reply);
        }catch(error){
          const index=pending.indexOf(edit);if(index>=0)pending.splice(index,1);
          document=project();if(document&&localSettings)emit(IPC.settingsChanged,{...localSettings,...document.settings});throw error;
        }
        return {...localSettings,...document!.settings};
      });settingsQueue=task;return task;
    }
    if(channel===IPC.materialsSnapshot)return document.materials;
    if(channel===IPC.browserGetState)return document.browser;
    if(channel===IPC.pluginsList)return document.plugins;
    if (channel === IPC.pixelSkinsReadAsset) {
      const active = workspace;
      matchingPacks ??= Promise.all([raw(IPC.pixelSkinsList), resource(IPC.pixelSkinsList, [])]).then(([local, host]) => {
        const localDigests = new Map((local as PixelSkinPackSummary[]).map(pack => [pack.id, pack.bundledSha256]));
        return new Set((host as PixelSkinPackSummary[]).filter(pack => pack.bundledSha256 && localDigests.get(pack.id) === pack.bundledSha256).map(pack => String(pack.id)));
      }).catch(() => new Set<string>());
      const matches = await matchingPacks;
      if (active !== workspace) throw Error('Duo workspace changed.');
      if (matches.has(args[0])) {
        const bytes = await raw(channel, ...args).catch(() => null);
        if (bytes) return bytes;
      }
    }
    if(DUO_READ_CHANNELS.has(channel)||DUO_WRITE_CHANNELS.has(channel))return resource(channel,args);
    if(channel.startsWith('plugins:')||channel===IPC.filesOpenFolder||channel===IPC.dialogPickDirectory||channel===IPC.materialsPick||channel===IPC.materialsPaste)throw Error('Это действие выполняется хозяином общего Canvas.');
    return raw(channel,...args);
  };
  return {invoke,resource,accept,localEvent:(channel:string,payload:any):any=>{
    if(!document)return payload;
    if(channel===IPC.settingsChanged){localSettings=payload;return {...payload,...document.settings};}
    if(channel===IPC.materialsChanged)return document.materials;
    if(channel===IPC.browserState)return {snapshot:document.browser};
    return payload;
  },active:()=>Boolean(document),ignoreSend:(channel:string)=>Boolean(document&&DUO_LOCAL_BROWSER_SENDS.has(channel)),
    send:(channel:string,args:unknown[]):boolean=>{if(!document||!DUO_WRITE_CHANNELS.has(channel))return false;void resource(channel,args).catch(error=>emit('duo-document-error',String(error)));return true;}};
}
