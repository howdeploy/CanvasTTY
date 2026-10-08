import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AttentionEvent, NotificationPreferences, NotificationChannel } from "../../shared/backlog.ts";

const defaults = (): NotificationPreferences => ({version:1,channels:{desktop:true,phone:true,glasses:true},quietUntil:null,importantOnly:false,sessionIds:null});
const important = new Set(["approval","failed","budget","loop"]);
const kinds = new Set(["response","approval","done","failed","budget","loop"]);

/** Metadata-only attention events. Channel filtering never affects session control or safety decisions. */
export class AttentionService {
  private readonly path: string;
  private readonly mask: (text:string)=>string;
  private preferences = defaults();
  private readonly events: AttentionEvent[] = [];
  private readonly last = new Map<string,number>();
  private writes: Promise<void> = Promise.resolve();
  constructor(path:string, mask:(text:string)=>string) {this.path=path;this.mask=mask;}
  async load(): Promise<void> {
    try {const text=await readFile(this.path,"utf8");if(text.length>64_000)throw new Error("Notification preferences are too large.");this.preferences=validate(JSON.parse(text));}
    catch(error) {if(!(error && typeof error==="object" && "code" in error && error.code==="ENOENT"))throw error;}
  }
  get(): NotificationPreferences {return structuredClone(this.preferences);}
  async set(value:NotificationPreferences): Promise<NotificationPreferences> {
    const next=validate(value), serialized=JSON.stringify(next);
    const operation=this.writes.catch(()=>undefined).then(async()=>{
      await mkdir(dirname(this.path),{recursive:true,mode:0o700});
      const temporary=`${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary,serialized,{mode:0o600,flag:"wx"});
      await rename(temporary,this.path);this.preferences=next;
    });
    this.writes=operation;await operation;return this.get();
  }
  publish(sessionId:string,title:string,kind:string,at=Date.now()): AttentionEvent|null {
    if(!kinds.has(kind))throw new Error("Unknown attention event.");
    const key=`${sessionId}:${kind}`, previous=this.last.get(key);
    // Distinct requests for permission must each remain visible to the person.
    if(kind!=="approval" && previous!==undefined && at-previous<10_000)return null;
    this.last.set(key,at);
    if(this.last.size>2000)this.last.delete(this.last.keys().next().value!);
    const event:AttentionEvent={id:randomUUID(),sessionId,title:this.mask(title).replace(/[\u0000-\u001f\u007f]/g,"").slice(0,120),kind:kind as AttentionEvent["kind"],at};
    this.events.push(event);if(this.events.length>500)this.events.shift();return event;
  }
  allows(channel:NotificationChannel,event:AttentionEvent,now=Date.now()):boolean {
    const p=this.preferences;
    return p.channels[channel] && !(p.quietUntil!==null && p.quietUntil>now)
      && (!p.importantOnly || important.has(event.kind)) && (!p.sessionIds || p.sessionIds.includes(event.sessionId));
  }
  list(channel:NotificationChannel,sessionId?:string):AttentionEvent[] {
    return this.events.filter(event=>(!sessionId || event.sessionId===sessionId) && this.allows(channel,event)).slice(-100).map(event=>({...event}));
  }
}
function validate(value:unknown):NotificationPreferences {
  if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("Invalid notification preferences.");
  const p=value as NotificationPreferences;
  if(p.version!==1 || !p.channels || ["desktop","phone","glasses"].some(channel=>typeof p.channels[channel as NotificationChannel]!=="boolean")
    || typeof p.importantOnly!=="boolean" || !(p.quietUntil===null || Number.isSafeInteger(p.quietUntil) && p.quietUntil>=0)
    || !(p.sessionIds===null || Array.isArray(p.sessionIds) && p.sessionIds.length<=100 && p.sessionIds.every(id=>typeof id==="string" && id.length>0 && id.length<=160)))throw new Error("Invalid notification preferences.");
  return {version:1,channels:{desktop:p.channels.desktop,phone:p.channels.phone,glasses:p.channels.glasses},quietUntil:p.quietUntil,importantOnly:p.importantOnly,sessionIds:p.sessionIds ? [...new Set(p.sessionIds)] : null};
}
