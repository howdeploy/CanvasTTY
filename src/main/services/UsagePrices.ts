import {mkdir,readFile,rename,writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";
import type {UsagePrice} from "../../shared/backlog.ts";

/** Human-entered prices. Empty by default; missing model/breakdown never produces a guessed cost. */
export class UsagePrices {
  private readonly path:string;
  private rows:UsagePrice[]=[];
  private writes:Promise<void>=Promise.resolve();
  private listeners=new Set<()=>void>();
  constructor(path:string){this.path=path;}
  async load():Promise<void>{
    try{const text=await readFile(this.path,"utf8");if(text.length>256_000)throw new Error("Price table is too large.");this.rows=validate(JSON.parse(text));}
    catch(error){if(!(error && typeof error==='object' && 'code' in error && error.code==='ENOENT'))throw error;}
  }
  get():UsagePrice[]{return structuredClone(this.rows);}
  subscribe(listener:()=>void):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  async set(rows:UsagePrice[]):Promise<UsagePrice[]>{
    const next=validate(rows),payload=JSON.stringify(next);
    const operation=this.writes.catch(()=>undefined).then(async()=>{
      await mkdir(dirname(this.path),{recursive:true,mode:0o700});const temporary=`${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary,payload,{mode:0o600,flag:'wx'});await rename(temporary,this.path);this.rows=next;
    });this.writes=operation;await operation;for(const listener of this.listeners)listener();return this.get();
  }
}
function validate(value:unknown):UsagePrice[]{
  if(!Array.isArray(value) || value.length>200)throw new Error("Price table accepts at most 200 models.");
  const keys=new Set<string>();
  return value.map(row=>{
    if(!row || typeof row!=='object' || typeof row.provider!=='string' || !/^[a-z][a-z0-9-]{0,39}$/.test(row.provider)
      || typeof row.model!=='string' || !row.model.trim() || row.model.length>200
      || ![row.inputPerMillion,row.outputPerMillion].every(n=>typeof n==='number' && Number.isFinite(n) && n>=0 && n<=1_000_000))throw new Error("Invalid model price.");
    const key=`${row.provider}:${row.model}`;if(keys.has(key))throw new Error("Duplicate model price.");keys.add(key);
    return {provider:row.provider,model:row.model.trim(),inputPerMillion:row.inputPerMillion,outputPerMillion:row.outputPerMillion};
  });
}
