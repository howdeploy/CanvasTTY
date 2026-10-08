import {readFileSync,statSync} from "node:fs";
import {join} from "node:path";
import type {AgentProviderId} from "../../shared/contracts.ts";

/** Reads a CLI's explicit default only. An absent/default alias is not guessed to be a catalog model. */
export function configuredModel(provider:AgentProviderId,homes:{codex:string;claude:string;opencode:string}):string|null{
  try{
    let file:string;
    switch(provider){
      case "codex":file=join(homes.codex,"config.toml");break;
      case "claude":file=join(homes.claude,"settings.json");break;
      case "opencode":file=join(homes.opencode,"opencode.json");break;
      default:return null;
    }
    if(statSync(file).size>256_000)return null;
    const text=readFileSync(file,"utf8");
    const model=provider==="codex" ? /^\s*model\s*=\s*["']([^"'\n]+)["']/mu.exec(text.split(/^\s*\[/mu)[0])?.[1] : JSON.parse(text).model;
    return typeof model==="string" && /^[\w./:@+-]{1,200}$/u.test(model) ? model : null;
  }catch{return null;}
}
