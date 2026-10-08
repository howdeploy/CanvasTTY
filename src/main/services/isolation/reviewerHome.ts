import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderId } from "../../../shared/contracts.ts";
import { LaunchRefusal } from "../launchRefusal.ts";

/** A reviewer gets fresh CLI state, never a shared agent-writable home or conversation history. */
/**
 * `keepOpenCodeConfig`: the host-verified run file of the worker's model account (CanvasTTY's own launch-runs
 * folder). It holds only the account's provider and model (the key travels in the environment), so a reviewer on
 * that account can reach its model; every other OpenCode config source is still dropped.
 */
export function prepareReviewerHome(env:Record<string,string>,provider:ProviderId,temp:string,runtimeReadable:readonly string[]=[],keepOpenCodeConfig?:string):void {
  const openCodeOverlay = env.OPENCODE_CONFIG_CONTENT;
  if (provider === "opencode" && openCodeOverlay) {
    const plugins = [...new Set(runtimeReadable.filter(path => basename(path) === "opencode-plugin.mjs"))];
    if (plugins.length !== 1 || !isAbsolute(plugins[0]) || !existsSync(plugins[0])) {
      throw new LaunchRefusal("The diff-only OpenCode reviewer requires a verified CanvasTTY lifecycle plugin runtime file. The agent was not started.");
    }
    const pluginPath = realpathSync(plugins[0]);
    const pluginStat = statSync(pluginPath);
    if (!pluginStat.isFile() || pluginStat.nlink !== 1) {
      throw new LaunchRefusal("The diff-only OpenCode lifecycle plugin is not a single-link regular file. The agent was not started.");
    }
    // The original merged inline config can contain arbitrary plugins, MCP servers, credentials and permissions.
    // Keep only the host-verified lifecycle plugin required for CanvasTTY's reviewer hooks.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({plugin: [pathToFileURL(pluginPath).href]});
  }
  const original=env.HOME,home=join(temp,"reviewer-home"),state=join(home,`.${provider}`);
  mkdirSync(state,{recursive:true,mode:0o700});
  const authentication=provider==="codex" ? {source:join(env.CODEX_HOME||join(original,".codex"),"auth.json"),name:"auth.json",keys:["OPENAI_API_KEY","tokens","auth_mode","last_refresh"]}
    : provider==="claude" ? {source:join(env.CLAUDE_CONFIG_DIR||join(original,".claude"),".credentials.json"),name:".credentials.json",keys:["claudeAiOauth"]} : null;
  if(authentication) {
    let file:number|undefined;
    try {
      file=openSync(authentication.source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_NOCTTY);
      const before=fstatSync(file);
      if(!before.isFile() || before.nlink!==1 || before.size>1024*1024)throw new Error("Reviewer authentication must be a bounded file without links.");
      const buffer=Buffer.alloc(1024*1024+1);let length=0;
      while(length<buffer.length){const count=readSync(file,buffer,length,buffer.length-length,length);if(!count)break;length+=count;}
      const after=fstatSync(file);
      if(length>1024*1024 || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs)
        throw new Error("Reviewer authentication changed during preparation.");
      const value=JSON.parse(buffer.subarray(0,length).toString("utf8"));
      if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("Invalid reviewer authentication.");
      const selected=Object.fromEntries(authentication.keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
      writeFileSync(join(state,authentication.name),JSON.stringify(selected),{mode:0o600,flag:"wx"});
    } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    finally {if(file!==undefined)closeSync(file);}
  }
  env.HOME=home;
  for(const name of ["CODEX_HOME","CLAUDE_CONFIG_DIR","GROK_HOME","HERMES_HOME","KIMI_HOME","OPENCODE_CONFIG_DIR","QWEN_HOME"])
    delete env[name];
  if (provider === "opencode" && keepOpenCodeConfig) env.OPENCODE_CONFIG = keepOpenCodeConfig;
  else delete env.OPENCODE_CONFIG;
  if (provider !== "opencode" || !openCodeOverlay) delete env.OPENCODE_CONFIG_CONTENT;
  env.XDG_CONFIG_HOME=join(home,".config");env.XDG_DATA_HOME=join(home,".local","share");
  env.XDG_STATE_HOME=join(home,".local","state");env.XDG_CACHE_HOME=join(home,".cache");
  if(provider==="codex")env.CODEX_HOME=state;
  if(provider==="claude")env.CLAUDE_CONFIG_DIR=state;
}
