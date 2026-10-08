import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {EnvironmentRegistry} from '../src/main/services/EnvironmentRegistry.ts';
import {PluginManager,validatePluginManifest} from '../src/main/services/PluginManager.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';
const sourceUrl='https://github.com/BIackFIame/canvastty-plugin-environments.git';
const provider=(kind,location,extra={})=>({pluginId:'test.plugin',pluginName:'Test',serviceId:'env',secrets:false,kinds:[{kind,label:kind,...(location?{executionLocation:location}:{})}],...extra});
function fixture(p,enabled=()=>false,call=async()=>({})){return new EnvironmentRegistry({providers:()=>[p],experimentalEnabled:enabled,secret:async()=>null,call});}
const ref=p=>({pluginId:p.pluginId,kind:p.kinds[0].kind,label:'Test',ref:{}});
test('manifest execution location is validated and host install provenance is preserved',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../examples/plugins/env-worktree/canvastty.plugin.json',import.meta.url),'utf8'));
 for(const location of ['local','remote']){manifest.services[0].environments[0].executionLocation=location;assert.equal(validatePluginManifest(manifest).services[0].environments[0].executionLocation,location);}
 manifest.services[0].environments[0].executionLocation='unknown';assert.throws(()=>validatePluginManifest(manifest),/executionLocation/);
 const result=PluginManager.prototype.environmentProviders.call({trustedServicesWith:()=>[{plugin:'test.plugin',service:{id:'env',environments:[{kind:'box',label:'Box'}]},name:'Test',secrets:false}],installRecord:()=>({sourceUrl})});
 assert.equal(result[0].sourceUrl,sourceUrl);
});
test('location gates arbitrary remote and unknown kinds, while local ssh and verified legacy tuples work',()=>{
 for(const p of [provider('cloud-vm','remote'),provider('production'),provider('worktree',undefined,{pluginId:'canvastty-environments',serviceId:'worktree',sourceUrl:'https://github.com/attacker/canvastty-plugin-environments.git'}),provider('new-kind',undefined,{pluginId:'canvastty-environments',serviceId:'worktree',sourceUrl})]){
  const r=fixture(p);assert.equal(r.available(ref(p)),false);assert.throws(()=>r.normalizeChoice('codex',{...ref(p),executionLocation:'local',sourceUrl}),/disabled/);
 }
 assert.ok(fixture(provider('ssh','local')).normalizeChoice('codex',ref(provider('ssh','local'))));
 for(const kind of ['worktree','container']){const p=provider(kind,undefined,{pluginId:'canvastty-environments',serviceId:kind,sourceUrl});assert.equal(fixture(p).available(ref(p)),true);p.kinds[0].executionLocation='remote';assert.equal(fixture(p).available(ref(p)),false);}
});
for(const step of ['prepare','resume','wrap'])test(`opt-out during ${step} cleans up and prevents a PTY spawn`,async t=>{
 let enabled=true;const p=provider('cloud-vm','remote');let release,start;const gate=new Promise(r=>release=r),started=new Promise(r=>start=r),events=[],calls=[];
 const r=fixture(p,()=>enabled,async(_p,_s,method)=>{const name=method.split('.').at(-1);events.push(name);if(name===step){start();await gate;}
 return name==='prepare'?{ref:{},label:'Cloud'}:name==='resume'?{ok:true}:name==='wrap'?{command:process.execPath,args:[]}:{};});
 const m=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls));m.configureEnvironments(r);t.after(()=>m.disposeAll());
 let pending;
 if(step==='resume')pending=r.resume(ref(p),'restored');else {const row=m.create({provider:'codex',profile:'normal',cwd:tmpdir(),position:{x:0,y:0},environment:ref(p)});pending=Promise.all([...m.sessions.get(row.id).launchTasks]);}
 await started;enabled=false;release();const result=await pending;assert.equal(calls.length,0);assert.ok(events.includes('release'));if(step==='resume')assert.equal(result.ok,false);
 await r.release(ref(p),'manual-cleanup',{keepData:true,reason:'closed'});assert.equal(events.at(-1),'release');
});
