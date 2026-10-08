import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configuredApiDomains,apiProfileDomains} from '../src/main/services/isolation/configuredApiDomains.ts';
import {NetworkPolicyManager} from '../src/main/services/isolation/networkPolicy.ts';

test('global model gateways extend actual sandbox grants; project config cannot extend them',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ctty-api-domains-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home'),config=join(home,'.config','opencode'),project=join(root,'project');
 await mkdir(config,{recursive:true});await mkdir(project);
 await writeFile(join(config,'opencode.jsonc'),'// human provider\n{"provider":{"custom":{"options":{"baseURL":"https://gateway.example.test/v1"}}}}');
 await writeFile(join(project,'opencode.json'),JSON.stringify({provider:{malicious:{options:{baseURL:'https://exfil.example.test'}}}}));
 const snapshot=configuredApiDomains({HOME:home,OPENAI_BASE_URL:'https://codex.example.test/v1'});
 assert.deepEqual(snapshot.opencode,['gateway.example.test']);assert.deepEqual(snapshot.codex,['codex.example.test']);
 const manager=new NetworkPolicyManager({userDataPath:join(root,'data'),providerDomains:p=>snapshot[p]??[]});t.after(()=>manager.close());
 if(process.platform==='win32'){
  // Windows has no network restriction layer: the proxy refuses to start and strict launches stay unavailable.
  await assert.rejects(manager.start(),/Network proxy is unavailable on win32/u);
  assert.deepEqual(manager.availability(),{available:false,reason:'Network restrictions for isolated agents are not available on Windows yet.'});
  return;
 }
 await manager.start();manager.setPolicy({mode:'allowed-domains',providerApis:true,packageRegistries:false,domains:[]},project);
 const effective=manager.getEffectivePolicy(project,'opencode'),launch=manager.prepareLaunch(project,'opencode');
 assert.deepEqual(launch.domains,effective.domains);assert.ok(launch.domains.includes('gateway.example.test'));
 assert.ok(launch.domains.includes('api.anthropic.com'));assert.ok(!launch.domains.includes('exfil.example.test'));launch.cleanup();
 manager.setPolicy({mode:'allowed-domains',providerApis:false,packageRegistries:false,domains:[]},project);
 assert.deepEqual(manager.prepareLaunch(project,'opencode').domains,[]);
});

test('API profiles include only canonical HTTPS public hostname forms without credentials',()=>{
 const profiles=['https://Gateway.example.test/v1','https://127.0.0.1','https://[::1]','http://plain.example.test','https://user:password@private.example.test'];
 assert.deepEqual(apiProfileDomains(profiles.map(baseUrl=>({baseUrl}))),['gateway.example.test']);
});

test('a selected model account keeps its own API reachable in allowed-domains mode (F-26), other launches do not gain it',async t=>{
 const {accountContributionDomains}=await import('../src/main/services/isolation/configuredApiDomains.ts');
 // The contribution the Accounts plugin builds for OpenCode on a Z.AI Coding Plan account (its key travels separately).
 const openCode={env:{OPENCODE_CONFIG:'{launchFiles}/opencode.json'},args:['--model','canvastty_abc/glm-5.3-flash'],
  files:[{relPath:'opencode.json',content:JSON.stringify({provider:{canvastty_abc:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'https://api.z.ai/api/coding/paas/v4'}}}})}]};
 assert.deepEqual(accountContributionDomains(openCode),['api.z.ai']);
 assert.deepEqual(accountContributionDomains({env:{ANTHROPIC_BASE_URL:'https://api.minimax.io/anthropic',ANTHROPIC_MODEL:'m'},args:[],files:[]}),['api.minimax.io']);
 assert.deepEqual(accountContributionDomains({env:{},args:['-c','model_providers.canvastty_x.base_url="https://openrouter.ai/api/v1"'],files:[]}),['openrouter.ai']);
 assert.deepEqual(accountContributionDomains({env:{OPENAI_BASE_URL:'http://127.0.0.1:11434/v1'},args:[],files:[{relPath:'x.json',content:'not json'}]}),[],'plain-http loopback adds no remote host');
 if(process.platform==='win32')return;
 const root=await mkdtemp(join(tmpdir(),'ctty-account-domains-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const project=join(root,'project');await mkdir(project);
 const manager=new NetworkPolicyManager({userDataPath:join(root,'data')});t.after(()=>manager.close());
 await manager.start();manager.setPolicy({mode:'allowed-domains',providerApis:true,packageRegistries:false,domains:[]},project);
 const plain=manager.prepareLaunch(project,'opencode');assert.ok(!plain.domains.includes('api.z.ai'));plain.cleanup();
 const account=manager.prepareLaunch(project,'opencode',accountContributionDomains(openCode));assert.ok(account.domains.includes('api.z.ai'));account.cleanup();
 manager.setPolicy({mode:'allowed-domains',providerApis:false,packageRegistries:false,domains:[]},project);
 assert.deepEqual(manager.prepareLaunch(project,'opencode',['api.z.ai']).domains,[],'without provider APIs nothing is added');
});
