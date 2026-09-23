import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { SettingsStore } from '../src/main/services/SettingsStore.ts';
const host={id:'server',label:'Saved server',sshHost:'server.example',workspaces:[{localPath:'/tmp/source',remotePath:'/srv/source'}]};
async function fixture(t){const root=await mkdtemp('/tmp/canvastty-host-settings-');t.after(()=>rm(root,{recursive:true,force:true}));const store=new SettingsStore(root,'en');await store.load();await store.update({remoteHosts:[host]});return store;}
test('reject a malformed edited saved host instead of deleting it',async t=>{const store=await fixture(t);const before=store.get();await assert.rejects(store.update({remoteHosts:[{...host,sshHost:'invalid address with spaces'}]}));assert.deepEqual(store.get(),before);});
test('reject malformed workspace mapping instead of silently deleting host',async t=>{const store=await fixture(t);await assert.rejects(store.update({remoteHosts:[{...host,workspaces:[{localPath:'relative',remotePath:'/srv/project'}]}]}));});
test('reject unsupported agent limit instead of reporting a successful fallback',async t=>{const store=await fixture(t);await assert.rejects(store.update({agentBudgets:{...store.get().agentBudgets,maxDepth:99}}));});
test('reject invalid path policy instead of silently weakening the table',async t=>{const store=await fixture(t);await store.update({pathPolicies:[{pattern:'private/**',dataClass:'D3'}]});await assert.rejects(store.update({pathPolicies:[{pattern:'private/**/',dataClass:'D3'}]}));});

import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';
test('SSH destination edits stale account and profile evidence without rewriting saved binding bytes',async t=>{
  const store=await fixture(t);
  const profile={id:'api',name:'Remote API',hostId:'server',protocol:'openai-compatible',baseUrl:'https://fake.example',remoteCredential:{kind:'environment',name:'FIXTURE_REMOTE_KEY'}};
  const account={id:'remote',label:'Remote',provider:'opencode',hostId:'server',binding:{kind:'api-profile',profileId:'api'}};
  const evidence={profile:{training:'none',retention:'bounded',thirdPartyProcessing:'no',contractualMode:'api'},evidence:{kind:'user-attested',reviewedAt:'2026-01-01',sources:[],note:'Reviewed fake route',models:'*',binding:accountRouteBinding(account,[profile])}};
  await store.update({apiProfiles:[{...profile,assessment:evidence}],providerAccounts:[{...account,assessment:evidence}]});
  const original=store.get();
  await store.update({remoteHosts:[{...host,label:'Renamed'}]});
  assert.equal(store.get().providerAccounts[0].assessmentInvalid,undefined);
  await store.update({remoteHosts:[{...host,sshHost:'other.example'}]});
  const changed=store.get();
  assert.equal(changed.providerAccounts[0].hostId,'server');
  assert.equal(changed.providerAccounts[0].assessmentInvalid,true);
  assert.equal(changed.apiProfiles[0].assessmentInvalid,true);
  assert.deepEqual(changed.providerAccounts[0].assessment,original.providerAccounts[0].assessment);
  assert.equal(accountRouteBinding(changed.providerAccounts[0],changed.apiProfiles),evidence.evidence.binding);
});
test('complete rows reject duplicate paths, malformed provider access and invalid class without changing confirmed settings',async t=>{
  const store=await fixture(t), before=store.get();
  for(const patch of [
    {remoteHosts:[{...host,providerAccess:{mode:'allowlist',providers:['codex','codex']}}]},
    {pathPolicies:[{pattern:'private/**',dataClass:'D3'},{pattern:'private/**',dataClass:'D0'}]},
    {agentBudgets:{maxLocalAgents:4}}, {defaultDataClass:'D9'}
  ]) {await assert.rejects(store.update(patch));assert.deepEqual(store.get(),before);}
});
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
test('saved host used by a live fake PTY cannot be deleted until its exit',async t=>{
  const store=await fixture(t); let exit;
  const manager=new TerminalManager(()=>{},undefined,undefined,undefined,true,()=>({pid:1,write(){},kill(){},resize(){},pause(){},resume(){},onData(){return {dispose(){}}},onExit(fn){exit=fn;return {dispose(){}}}}));
  t.after(()=>manager.disposeAll());
  manager.configureRemoteHosts(id=>store.get().remoteHosts.find(host=>host.id===id)??null);
  manager.create({provider:'terminal',profile:'normal',cwd:process.cwd(),hostId:'server',position:{x:0,y:0}});
  store.configureHostSessions(()=>manager.listMetadata());
  await assert.rejects(store.update({remoteHosts:[]}),/active sessions/i);
  exit({exitCode:0});
  await store.update({remoteHosts:[]});
  assert.equal(store.get().remoteHosts.length,0);
});

test('an overlapping saved-host deletion cannot orphan a newly registered session',async t=>{
 const root=await mkdtemp('/tmp/canvastty-host-race-');t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new SettingsStore(root,'en');await store.load();await store.update({remoteHosts:[{id:'race',label:'Race fixture',sshHost:'fake.invalid'}]});
 const manager=new TerminalManager(()=>{},undefined,undefined,undefined,true,()=>({pid:1,write(){},kill(){},resize(){},pause(){},resume(){},onData(){return {dispose(){}}},onExit(){return {dispose(){}}}}));
 t.after(()=>manager.disposeAll());
 manager.configureRemoteHosts(id=>store.hostForLaunch(id));store.configureHostSessions(()=>manager.listMetadata());
 const original=store.persist.bind(store);let release,entered;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 store.persist=async(...args)=>{entered();await gate;return original(...args);};
 const deletion=store.update({remoteHosts:[]});await ready;
 let launched=false;try{manager.create({provider:'terminal',profile:'normal',cwd:root,hostId:'race',position:{x:0,y:0}});launched=true;}catch{}
 release();let removed=false;try{await deletion;removed=true;}catch{}
 assert.ok(!(launched&&removed),'delete and launch both succeeded, leaving a live session whose saved host no longer exists');
});
test('failed host removal releases its launch fence and keeps confirmed settings',async t=>{
 const store=await fixture(t),before=store.get();const original=store.persist.bind(store);let release,entered;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 store.persist=async()=>{entered();await gate;throw new Error('disk rejected');};
 const deleting=store.update({remoteHosts:[]});await ready;
 assert.deepEqual(store.get(),before);assert.throws(()=>store.hostForLaunch('server'),/being removed/);
 release();await assert.rejects(deleting,/disk rejected/);
 assert.deepEqual(store.get(),before);assert.equal(store.hostForLaunch('server').id,'server');
 store.persist=original;
});

import { SessionLaunchPolicy } from "../src/main/services/SessionLaunchPolicy.ts";
test('SSH retargeting must not bypass an active account fixed-host boundary',async t=>{
 const root=await mkdtemp('/tmp/canvastty-host-retarget-');t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new SettingsStore(root,'en');await store.load();
 const host={id:'fixed',label:'Fixed fixture',sshHost:'first.invalid',workspaces:[{localPath:root,remotePath:'/srv/project'}]};
 const account={id:'claude-fixed',label:'Fixed account',provider:'claude',hostId:'fixed',binding:{kind:'cli-home',directory:'/srv/claude'}};
 await store.update({remoteHosts:[host],providerAccounts:[account],defaultDataClass:'D0'});
 const calls=[];
 const registry={get:provider=>({state:'available',provider,executable:'/fixture/claude',launcher:'native',environment:{PATH:'/usr/bin'},checked:[]})};
 const manager=new TerminalManager(()=>{},registry,undefined,undefined,true,(command,args)=>{calls.push(args);return {pid:1,write(){},kill(){},resize(){},pause(){},resume(){},onData(){return {dispose(){}}},onExit(){return {dispose(){}}}};});
 t.after(()=>manager.disposeAll());
 manager.configureRemoteHosts(id=>store.hostForLaunch(id));store.configureHostSessions(()=>manager.listMetadata());manager.configureLaunchPolicy(new SessionLaunchPolicy(()=>store.get()));
 const request={provider:'claude',accountId:'claude-fixed',profile:'normal',cwd:root,hostId:'fixed',position:{x:0,y:0}};
 manager.create(request);
 let editSucceeded=false;try{await store.update({remoteHosts:[{...host,sshHost:'second.invalid'}]});editSucceeded=true;}catch{}
 let secondSucceeded=false;if(editSucceeded)try{manager.create(request);secondSucceeded=true;}catch{}
 assert.ok(!secondSucceeded,'same active account was admitted to both first.invalid and second.invalid through editing one saved host id');
});
test('pending SSH retarget blocks new session registration and a failed write restores launch access',async t=>{
 const store=await fixture(t);const manager=new TerminalManager(()=>{},undefined,undefined,undefined,true,()=>({pid:1,write(){},kill(){},resize(){},pause(){},resume(){},onData(){return {dispose(){}}},onExit(){return {dispose(){}}}}));t.after(()=>manager.disposeAll());
 manager.configureRemoteHosts(id=>store.hostForLaunch(id));store.configureHostSessions(()=>manager.listMetadata());
 const before=store.get();let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 store.persist=async()=>{entered();await gate;throw new Error('write failed');};
 const change=store.update({remoteHosts:[{...host,sshUser:'other',sshPort:2222}]});await ready;
 const request={provider:'terminal',profile:'normal',cwd:process.cwd(),hostId:'server',position:{x:0,y:0}};
 assert.throws(()=>manager.create(request),/retargeted/);assert.deepEqual(store.get(),before);
 release();await assert.rejects(change,/write failed/);
 assert.doesNotThrow(()=>manager.create(request));
});
test('blank and malformed host numeric drafts cannot be normalized into a successful save',async t=>{
 const {hostDraft,draftHost}=await import('../src/renderer/src/features/settings/hostSettingsDraft.ts');
 const store=await fixture(t),draft=hostDraft(host);
 assert.equal(draftHost(draft).sshPort,undefined);
 await assert.rejects(store.update({remoteHosts:[draftHost({...draft,numbers:{...draft.numbers,sshPort:'0'}})]}),/sshPort/);
 await assert.rejects(store.update({remoteHosts:[draftHost({...draft,numbers:{...draft.numbers,maxSessions:'oops'}})]}),/maxSessions/);
});
