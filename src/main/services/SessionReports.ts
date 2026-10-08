import {createHash,randomUUID} from "node:crypto";
import {mkdir,rename,unlink,writeFile} from "node:fs/promises";
import {join} from "node:path";

/** Completion snapshots use only the existing timeline. A later turn invalidates an older report. */
export class SessionReports {
  private readonly generations=new Map<string,number>();
  private readonly ready=new Set<string>();
  private readonly pending=new Map<string,Promise<void>>();
  private readonly directory:string;
  private readonly generate:(id:string)=>Promise<string>;
  private readonly changed:(id:string,readyAt:number|null)=>void;
  private readonly now:()=>number;
  private writes:Promise<void>=Promise.resolve();
  constructor(userDataPath:string,generate:(id:string)=>Promise<string>,
    changed:(id:string,readyAt:number|null)=>void,now=Date.now){
    this.directory=join(userDataPath,"session-reports");
    this.generate=generate;this.changed=changed;this.now=now;
  }
  complete(id:string):Promise<void>{
    const current=this.pending.get(id);if(current)return current;
    const generation=(this.generations.get(id) ?? 0)+1;this.generations.set(id,generation);
    const operation=this.save(id,generation).finally(()=>{if(this.pending.get(id)===operation)this.pending.delete(id);});
    this.pending.set(id,operation);return operation;
  }
  invalidate(id:string):void {
    this.generations.set(id,(this.generations.get(id) ?? 0)+1);this.pending.delete(id);
    if(this.ready.delete(id))this.changed(id,null);
  }
  forget(id:string):void{
    this.invalidate(id);
    this.writes=this.writes.catch(()=>undefined).then(()=>unlink(this.path(id)).catch(()=>undefined));
  }
  async report(id:string):Promise<string>{
    await this.pending.get(id);
    const generation=this.generations.get(id);
    const report=await this.generate(id);
    // Git audits and usage hooks can finish after the terminal reports completion.
    if(this.ready.has(id) && generation!==undefined){
      const write=this.writes.catch(()=>undefined).then(()=>this.write(id,generation,report));
      this.writes=write;await write;
    }
    return report;
  }
  async flush():Promise<void>{await Promise.allSettled(this.pending.values());await this.writes;}
  private path(id:string):string{return join(this.directory,createHash("sha256").update(id).digest("hex")+".md");}
  private async save(id:string,generation:number):Promise<void>{
    const report=await this.generate(id);
    if(this.generations.get(id)!==generation)return;
    const write=this.writes.catch(()=>undefined).then(()=>this.write(id,generation,report));
    this.writes=write;await write;
  }
  private async write(id:string,generation:number,report:string):Promise<void>{
    if(this.generations.get(id)!==generation)return;
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const file=this.path(id),temporary=`${file}.${randomUUID()}.tmp`;
    try{
      await writeFile(temporary,report,{mode:0o600,flag:"wx"});
      if(this.generations.get(id)!==generation)return;
      await rename(temporary,file);
      if(this.generations.get(id)!==generation)return;
      this.ready.add(id);this.changed(id,this.now());
    }finally{await unlink(temporary).catch(()=>undefined);}
  }
}
