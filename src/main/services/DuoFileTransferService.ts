import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { terminalFileDropText } from '../../shared/terminalFileDrop.ts';

const MAX_FILE = 32 * 1024 * 1024;
const MAX_SESSION = 128 * 1024 * 1024;
const CHUNK = 30_000;
type Upload = { directory:string; path:string; name:string; size:number; offset:number; hash:string };

/** Uploaded files can only land in a private, unique import directory. */
export class DuoFileTransferService {
  private uploads = new Map<string,Upload>();
  private reserved = 0;
  private queue:Promise<unknown> = Promise.resolve();
  private root:string;
  constructor(root:string) {this.root=root;}
  receive(args:unknown[], authorized:()=>boolean):Promise<unknown> {
    const task = this.queue.catch(()=>undefined).then(()=>this.perform(args,authorized));
    this.queue = task;
    return task;
  }
  private async perform(args:unknown[], authorized:()=>boolean):Promise<unknown> {
    if (!authorized()) throw Error('Shared workspace control was revoked.');
    const [action,id,value] = args;
    if (action === 'begin') {
      const info = id as {name:string;size:number;hash:string};
      if (!info || typeof info.name !== 'string' || !info.name.trim() || info.name.length > 180 || /[/\\\x00-\x1f\x7f]/u.test(info.name) || /^\.+$/.test(info.name) || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(info.hash)) throw Error('Invalid Duo upload (maximum 32 MiB per file).');
      if (this.uploads.size >= 4 || this.reserved + info.size > MAX_SESSION) throw Error('Duo import limit reached (128 MiB per session).');
      const token = randomUUID(), directory = join(this.root,token), path = join(directory,'upload.part');
      await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(path,'',{flag:'wx',mode:0o600});
      if (!authorized()) { await rm(directory,{recursive:true,force:true}); throw Error('Shared workspace control was revoked.'); }
      // Prefix also prevents Windows device names such as CON or NUL.
      this.uploads.set(token,{directory,path,name:'file-'+info.name.trim().replace(/[<>:"|?*]/g,'_').replace(/[. ]+$/g,''),size:info.size,offset:0,hash:info.hash});
      this.reserved += info.size;
      return {id:token};
    }
    const upload = typeof id === 'string' ? this.uploads.get(id) : undefined;
    if (!upload) throw Error('Duo upload expired.');
    if (action === 'cancel') { this.uploads.delete(id as string);this.reserved-=upload.size;await rm(upload.directory,{recursive:true,force:true});return null; }
    if (action === 'chunk') {
      const part = value as {offset:number;data:string};
      if (!part || part.offset !== upload.offset || typeof part.data !== 'string' || part.data.length > CHUNK*4/3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data)) throw Error('Invalid Duo upload chunk.');
      const data = Buffer.from(part.data,'base64');
      if (!data.length || upload.offset+data.length > upload.size) throw Error('Invalid Duo upload size.');
      await appendFile(upload.path,data);upload.offset += data.length;
      if (!authorized()) throw Error('Shared workspace control was revoked.');
      return {offset:upload.offset};
    }
    if (action !== 'commit' || upload.offset !== upload.size) throw Error('Incomplete Duo upload.');
    const hash = createHash('sha256').update(await readFile(upload.path)).digest('hex');
    if (hash !== upload.hash) throw Error('Duo upload checksum mismatch.');
    if (!authorized()) throw Error('Shared workspace control was revoked.');
    const target = join(upload.directory,upload.name);
    await rename(upload.path,target);
    if (!authorized()) { await rm(upload.directory,{recursive:true,force:true});throw Error('Shared workspace control was revoked.'); }
    this.uploads.delete(id as string);
    // Committed files remain available to existing host terminals after disconnect.
    return {text:terminalFileDropText([target],process.platform),bytes:upload.size,hash};
  }
  clear():void {
    const abandoned = [...this.uploads.values()];this.uploads.clear();this.reserved = 0;
    this.queue = this.queue.catch(()=>undefined).then(async()=>{for(const upload of abandoned)await rm(upload.directory,{recursive:true,force:true});}).catch(()=>undefined);
  }
}

/** Only explicit dropped paths are sent. Input itself is never submitted. */
export async function sendDuoFiles(paths:unknown, request:(args:unknown[])=>Promise<any>, authorized:()=>boolean):Promise<string> {
  if (!Array.isArray(paths) || !paths.length || paths.length>8 || !paths.every(p=>typeof p==='string'&&p.length<=8192)) throw Error('Drop one to eight files.');
  const result:string[]=[];
  for (const path of paths) {
    if (!authorized()) throw Error('Duo: connection or permission changed.');
    const canonical=await realpath(path), info=await stat(canonical);
    if (!info.isFile() || info.size>MAX_FILE) throw Error('Duo supports files up to 32 MiB; folders are not supported.');
    const data=await readFile(canonical);if(data.length>MAX_FILE)throw Error('Duo file grew beyond the upload limit.');
    const hash=createHash('sha256').update(data).digest('hex');
    const {id}=await request(['begin',{name:basename(canonical),size:data.length,hash}]);
    try {
      for(let offset=0;offset<data.length;offset+=CHUNK){
        if (!authorized()) throw Error('Duo: connection or permission changed.');
        const part=data.subarray(offset,offset+CHUNK),ack=await request(['chunk',id,{offset,data:part.toString('base64')}]);
        if(ack.offset!==offset+part.length)throw Error('Duo upload acknowledgement mismatch.');
      }
      if (!authorized()) throw Error('Duo: connection or permission changed.');
      const committed=await request(['commit',id]);
      if(committed.hash!==hash||committed.bytes!==data.length||typeof committed.text!=='string')throw Error('Duo upload checksum mismatch.');
      result.push(committed.text);
    } catch(error) {await request(['cancel',id]).catch(()=>undefined);throw error;}
  }
  return result.join('');
}
