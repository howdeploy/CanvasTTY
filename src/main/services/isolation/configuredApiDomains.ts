import {openCodeConfigPaths,parseJsonc,readInspectedFile} from "../inspectedConfig.ts";
import type {ApiProfile,ProviderId} from "../../../shared/contracts.ts";
import {canonicalDomain} from "./networkPolicy.ts";

/** Snapshot human-owned global CLI configuration at startup. Project files cannot extend the sandbox allowlist. */
export function configuredApiDomains(environment:Readonly<Record<string,string|undefined>>):Partial<Record<ProviderId,string[]>>{
  const domains=new Set<string>();
  for(const file of openCodeConfigPaths(environment).jsonFiles){
    const text=readInspectedFile(file);if(text.kind!=="text")continue;
    const parsed=parseJsonc(text.text);if(!parsed.ok || !parsed.value || typeof parsed.value!=="object")continue;
    const providers=(parsed.value as {provider?:unknown}).provider;
    if(!providers || typeof providers!=="object" || Array.isArray(providers))continue;
    for(const row of Object.values(providers)){
      if(!row || typeof row!=="object")continue;
      const options=(row as {options?:{baseURL?:unknown}}).options;
      const host=apiHostname(options?.baseURL);if(host)domains.add(host);
    }
  }
  const inherited:Partial<Record<ProviderId,string[]>>={opencode:[...domains]};
  for(const [provider,names] of Object.entries({codex:["OPENAI_BASE_URL"],claude:["ANTHROPIC_BASE_URL"],grok:["XAI_BASE_URL"],kimi:["MOONSHOT_BASE_URL"],minimax:["MINIMAX_BASE_URL"]})){
    inherited[provider as ProviderId]=names.flatMap(name=>{const host=apiHostname(environment[name]);return host ? [host] : [];});
  }
  return inherited;
}
export function apiProfileDomains(profiles:readonly ApiProfile[]):string[]{return [...new Set(profiles.flatMap(profile=>{const host=apiHostname(profile.baseUrl);return host ? [host] : [];}))];}
/**
 * The model API hosts of the selected model account's launch contribution: its *_BASE_URL variables, the base URLs in
 * its run files (OpenCode `provider.*.options.baseURL`, Kimi `providers.*.base_url`) and Codex `-c …base_url=` overrides.
 * The account is the person's own setting, so in allowed-domains mode the chosen model's API stays reachable (F-26).
 */
export function accountContributionDomains(contribution:{env:Record<string,string>;args:readonly string[];files:ReadonlyArray<{relPath:string;content:string}>}):string[]{
  const hosts=new Set<string>();
  const add=(value:unknown):void=>{const host=apiHostname(value);if(host)hosts.add(host);};
  for(const [name,value] of Object.entries(contribution.env))if(/_BASE_URL$/u.test(name))add(value);
  for(const arg of contribution.args){const match=/base_url\s*=\s*"?([^"\s]+)"?/u.exec(arg);if(match)add(match[1]);}
  for(const file of contribution.files){
    if(!/\.json$/u.test(file.relPath))continue;
    let value:unknown;try{value=JSON.parse(file.content);}catch{continue;}
    const record=(item:unknown):Record<string,unknown>|null=>item && typeof item==="object" && !Array.isArray(item) ? item as Record<string,unknown> : null;
    const root=record(value);if(!root)continue;
    for(const provider of Object.values(record(root.provider) ?? {}))add(record(record(provider)?.options)?.baseURL);
    for(const provider of Object.values(record(root.providers) ?? {}))add(record(provider)?.base_url);
  }
  return [...hosts];
}
function apiHostname(value:unknown):string|null{
  if(typeof value!=="string" || value.length>2000)return null;
  try{const url=new URL(value);return url.protocol==="https:" && !url.username && !url.password ? canonicalDomain(url.hostname) : null;}catch{return null;}
}
