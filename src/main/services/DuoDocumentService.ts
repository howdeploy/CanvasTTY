import { randomUUID } from 'node:crypto';
import { IPC, type AppSettings, type FileRootDescriptor, type FileRootReference } from '../../shared/contracts';
import { applyDuoSettingsOps, pickDuoSettings, type DuoDocument, type DuoDocumentOp, type DuoDocumentPort } from '../../shared/duoDocument';
import { DUO_FILE_READ_CHANNELS, DUO_READ_CHANNELS, DUO_WRITE_CHANNELS } from '../../shared/duoResources';
import type { DuoFileTransferService } from './DuoFileTransferService';

const CHUNK=128_000, MAX_RESULT=32*1024*1024;

function isPluginShared(settings: AppSettings, pluginId: string): boolean {
  return settings.pluginCanvas.some(card => card.pluginId === pluginId)
    || settings.homeLayout.some(widget => widget.widgetId.startsWith(`plugin:${pluginId}:`));
}

export class DuoDocumentService implements DuoDocumentPort {
  private chunks = new Map<string, { text: string; at: number; allowed: () => boolean }>();
  private fileRoots = new Map<string, FileRootReference>();

  private sharedRoot(reference: FileRootReference): boolean {
    const cards = this.settings.get().fileCards;
    if (reference.rootType === 'session' && typeof reference.sessionId === 'string' && reference.sessionId) {
      return cards.some(({ root }) => root.rootType === 'session' && root.sessionId === reference.sessionId);
    }
    if (reference.rootType === 'folder' && typeof reference.folderPath === 'string' && reference.folderPath) {
      return cards.some(({ root, folderPath }) => root.rootType === 'folder' && (folderPath ?? root.folderPath) === reference.folderPath);
    }
    return false;
  }

  private rootReadable(id: unknown, authorized: () => boolean): boolean {
    const reference = typeof id === 'string' ? this.fileRoots.get(id) : undefined;
    return reference !== undefined && (this.sharedRoot(reference) || authorized());
  }
  private storage=new Map<string,{pluginId:string;key:string;value:unknown;version:number}>();
  private storageVersion=0;
  storageChanged(pluginId:string,key:string,value:unknown):void{
    if(JSON.stringify(value??null).length>64*1024)return;
    const id=pluginId+'\0'+key;this.storage.delete(id);this.storage.set(id,{pluginId,key,value,version:++this.storageVersion});
    let size=0;for(const item of this.storage.values())size+=JSON.stringify(item).length;
    while(this.storage.size>128||size>512_000){const first=this.storage.keys().next().value!;size-=JSON.stringify(this.storage.get(first)).length;this.storage.delete(first);}
  }
  private edits:Promise<unknown>=Promise.resolve();
  constructor(private settings:{get():AppSettings;update(patch:Partial<AppSettings>):Promise<AppSettings>},
    private invoke:(channel:string,args:unknown[])=>Promise<any>,
    private protocol:(request:Request)=>Promise<Response>,
    private changed:(settings:AppSettings)=>void,
    private browserResource:(channel:string,args:unknown[],authorized:()=>boolean)=>Promise<unknown>,private transfers?:DuoFileTransferService){}
  async snapshot():Promise<DuoDocument>{
    const [materials,plugins,browser]=await Promise.all([
      this.invoke(IPC.materialsSnapshot,[]),this.invoke(IPC.pluginsList,[]),this.invoke(IPC.browserGetState,[])
    ]);
    const settings = this.settings.get();
    return {settings:pickDuoSettings(settings),materials,plugins,browser,storageEvents:[...this.storage.values()].filter(e=>isPluginShared(settings,e.pluginId))};
  }
  edit(ops:DuoDocumentOp[],authorized:()=>boolean):Promise<void>{
    const task=this.edits.catch(()=>undefined).then(async()=>{
      if(!authorized())throw Error('Shared workspace control was revoked.');
      const patch=applyDuoSettingsOps(this.settings.get(),ops);
      if(!authorized())throw Error('Shared workspace control was revoked.');
      const next=await this.settings.update(patch);this.changed(next);
    });this.edits=task;return task;
  }
  async resource(channel:string,args:unknown[],authorized:()=>boolean,manage:boolean, connected:()=>boolean=()=>true):Promise<unknown>{
    if (!connected()) throw Error('Duo session changed.');
    if(typeof channel!=='string'||!Array.isArray(args)||args.length>6||JSON.stringify(args).length>48_000)throw Error('Invalid Canvas resource request.');
    for(const [id,c] of this.chunks)if(Date.now()-c.at>60_000)this.chunks.delete(id);
    if(channel==='chunk'){
      const [id,offset]=args as [string,number],c=this.chunks.get(id);
      if(!c||!Number.isSafeInteger(offset)||offset<0||offset>=c.text.length)throw Error('Canvas resource expired.');
      if(!c.allowed())throw Error('Shared resource access was revoked.');
      return {chunk:id,total:c.text.length,offset,data:c.text.slice(offset,offset+CHUNK)};
    }
    const reference = args[0] as FileRootReference | null;
    const register = channel === IPC.filesRegisterRoot;
    const scopedRegister = register && reference && this.sharedRoot(reference);
    const closingRoot = channel === IPC.filesCloseRoot && typeof args[0] === 'string' && this.fileRoots.has(args[0]);
    const fileRead = DUO_FILE_READ_CHANNELS.has(channel);
    const read = DUO_READ_CHANNELS.has(channel) || channel === 'protocol' || channel === 'browser-frame' || scopedRegister || closingRoot;
    let allowed = () => connected() && (Boolean(read) || authorized());
    if (fileRead || channel === IPC.filesResolvePath) {
      allowed = () => connected()
        && this.rootReadable(args[0], authorized)
        && (fileRead || authorized());
    }
    if ((channel === IPC.filesCloseRoot && !closingRoot)
        || ((fileRead || channel === IPC.filesResolvePath) && !allowed())) {
      throw Error('This Files folder is not shared.');
    }
    if(!read&&!DUO_WRITE_CHANNELS.has(channel)&&channel!=='browser-input'&&channel!=='file-upload')throw Error('This Canvas capability is not shared.');
    if(!read&&(!manage||!authorized()))throw Error('The host has not granted shared workspace control.');
    let result:unknown;
    if(channel==='file-upload'){
      if(!this.transfers)throw Error('Duo file transfer is unavailable.');
      result=await this.transfers.receive(args,authorized);
    }else if(channel==='protocol'){
      const [value,range]=args;
      const url=new URL(String(value));
      if(!['canvastty-preview:','canvastty-material:','canvastty-plugin:','canvastty-files:','canvastty-media:'].includes(url.protocol))throw Error('Unsupported shared asset.');
      if (url.protocol === 'canvastty-preview:') {
        allowed = () => connected() && this.rootReadable(url.hostname, authorized);
        if (!allowed()) throw Error('This Files folder is not shared.');
      }
      if (url.protocol === 'canvastty-plugin:' && url.hostname !== 'host' && !isPluginShared(this.settings.get(), url.hostname)) {
        throw Error('This plugin is not on the shared canvas.');
      }
      const headers=new Headers();
      if(range!==null&&range!==undefined){
        const match=/^bytes=(\d+)-(\d*)$/.exec(String(range));if(!match)throw Error('Invalid media range.');
        const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),start+128_000-1):start+128_000-1;
        headers.set('range',`bytes=${start}-${end}`);
      }
      const response=await this.protocol(new Request(url,{headers}));
      const length=Number(response.headers.get('content-length')||0);if(length>MAX_RESULT)throw Error('Shared asset is too large.');
      const reader=response.body?.getReader(),parts:Uint8Array[]=[];let size=0;
      if(reader)try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>MAX_RESULT)throw Error('Shared asset is too large.');parts.push(p.value);}}finally{await reader.cancel().catch(()=>undefined);}
      result={status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.concat(parts).toString('base64')};
    }else if(channel==='browser-frame'||channel==='browser-input'){
      result=await this.browserResource(channel,args,authorized);
    }else{
      if(channel.startsWith('plugins:')){
        const pluginId = args[0];
        if (typeof pluginId !== 'string' || !isPluginShared(this.settings.get(), pluginId)) {
          throw Error('This plugin is not on the shared canvas.');
        }
      }
      if(channel===IPC.mediaRead&&args[0]!==this.settings.get().mediaPath)throw Error('Only the shared background media is readable.');
      if (register && this.fileRoots.size >= 256) throw Error('Too many shared Files folders.');
      result=await this.invoke(channel,args);
      if (register && result) {
        const { rootId } = result as FileRootDescriptor;
        if (!connected() || !reference || (!authorized() && !this.sharedRoot(reference))) {
          await this.invoke(IPC.filesCloseRoot, [rootId]);
          throw Error('Shared Files access was revoked.');
        }
        this.fileRoots.set(rootId, reference);
      }
      if (closingRoot) this.fileRoots.delete(args[0] as string);
    }
    if(!allowed())throw Error('Shared resource access was revoked.');
    const text=JSON.stringify(result??null);if(text.length>MAX_RESULT)throw Error('Canvas resource is too large.');
    if(text.length<=CHUNK)return {value:result??null};
    if(this.chunks.size>=8)this.chunks.delete(this.chunks.keys().next().value!);
    const id=randomUUID();this.chunks.set(id,{text,at:Date.now(),allowed});
    return {chunk:id,total:text.length,offset:0,data:text.slice(0,CHUNK)};
  }
  revokeControl(): void {
    this.transfers?.clear();
    void this.browserResource('browser-release', [], () => true).catch(() => undefined);
    for (const [id, chunk] of this.chunks) if (!chunk.allowed()) this.chunks.delete(id);
  }

  clear(): void {
    this.chunks.clear();
    this.revokeControl();
    for (const id of this.fileRoots.keys()) void this.invoke(IPC.filesCloseRoot, [id]).catch(() => undefined);
    this.fileRoots.clear();
  }
}

let storageReceiver:((pluginId:string,key:string,value:unknown)=>void)|null=null;
export function setDuoStorageReceiver(handler:typeof storageReceiver):void{storageReceiver=handler;}
export function notifyDuoStorage(pluginId:string,key:string,value:unknown):void{storageReceiver?.(pluginId,key,value);}
let proxy:((request:Request)=>Promise<Response|null>)|null=null;
export function setDuoAssetProxy(handler:typeof proxy):void{proxy=handler;}
export async function proxyDuoAsset(request:Request,local:()=>Promise<Response>):Promise<Response>{
  return (await proxy?.(request))??local();
}
