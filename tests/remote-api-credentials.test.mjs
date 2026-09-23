import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { SettingsStore, normalizeApiProfiles } from '../src/main/services/SettingsStore.ts';
import { accountRouteBinding, accountApiProfile, assertAccountAliases } from '../src/shared/providerAccountPolicy.ts';
import { ProviderAccountLaunchService } from '../src/main/services/ProviderAccountLaunchService.ts';
const host={id:'remote',label:'Remote fixture',sshHost:'fixture.invalid'};
const profile={id:'api',name:'API fixture',hostId:'remote',protocol:'openai-compatible',baseUrl:'https://fixture.invalid/v1',defaultModel:'fixture-model',remoteCredential:{kind:'environment',name:'FIXTURE_API_KEY'}};
const account={id:'bound',label:'Bound account',provider:'opencode',hostId:'remote',binding:{kind:'api-profile',profileId:'api'}};
test('remote profiles round-trip independent references without a local key',async t=>{
 const root=await mkdtemp('/tmp/canvastty-remote-ref-');t.after(()=>rm(root,{recursive:true,force:true}));const store=new SettingsStore(root,'en');await store.load();
 await store.update({remoteHosts:[host],apiProfiles:[profile],providerAccounts:[account]});
 const loaded=await new SettingsStore(root,'en').load();assert.deepEqual(loaded.apiProfiles[0].remoteCredential,profile.remoteCredential);assert.equal(loaded.apiProfiles[0].secretRef,undefined);
 assert.equal(accountApiProfile(loaded.providerAccounts[0],loaded.apiProfiles).hostId,'remote');
});
test('remote reference shapes reject ambiguous, unsafe or local credential fallbacks',()=>{
 for(const bad of [{...profile,secretRef:'OPENAI_API_KEY'},{...profile,hostId:'local'},{...profile,hostId:undefined},{...profile,remoteCredential:undefined},...['PATH','LD_PRELOAD','PYTHONPATH','DOCKER_HOST','BAD NAME'].map(name=>({...profile,remoteCredential:{kind:'environment',name}})),...['relative','/srv/../key','/srv//key','/srv/key/','/srv/./key','/srv/key\n'].map(path=>({...profile,remoteCredential:{kind:'key-file',path}})),{...profile,remoteCredential:{kind:'environment',name:'FIXTURE_API_KEY',value:'must-not-persist'}}]){
  assert.deepEqual(normalizeApiProfiles([bad],[]),[],JSON.stringify(bad.remoteCredential));
 }
 const valid={...profile,remoteCredential:{kind:'key-file',path:'/srv/private/key'}};assert.deepEqual(normalizeApiProfiles([valid],[])[0].remoteCredential,valid.remoteCredential);
});
test('local route binding bytes remain v1; remote references get distinct scoped v2 identities',()=>{
 const local={...profile,hostId:'local',secretRef:'OPENAI_API_KEY'};delete local.remoteCredential;const localAccount={...account,hostId:'local'};
 assert.equal(accountRouteBinding(localAccount,[local]),JSON.stringify({version:1,account:'bound',host:'local',service:'api:https://fixture.invalid',binding:account.binding,profile:'api',endpoint:'https://fixture.invalid/v1',protocol:'openai-compatible',secretRef:'OPENAI_API_KEY'}));
 const remote=JSON.parse(accountRouteBinding(account,[profile]));assert.equal(remote.version,2);assert.deepEqual(remote.remoteCredential,profile.remoteCredential);assert.equal(remote.secretRef,undefined);
 const other={...profile,id:'api-2'};const otherAccount={...account,id:'other',binding:{kind:'api-profile',profileId:'api-2'}};
 assert.throws(()=>assertAccountAliases([account,otherAccount],[profile,other]),/Duplicate/);
 assert.doesNotThrow(()=>assertAccountAliases([account,{...otherAccount,hostId:'remote-2'}],[profile,{...other,hostId:'remote-2'}]));
});
test('remote API container preparation builds a nonsecret recipe without any local vault access',async()=>{
 let vault=0,discovery=0;const service=new ProviderAccountLaunchService(()=>({remoteHosts:[host],providerAccounts:[account],apiProfiles:[profile]}),{get generation(){vault++;throw Error('local vault touched');},get(){vault++;throw Error('local vault touched');}},{discovery:{discover(){discovery++;throw Error('host CLI discovery touched');}}});
 const metadata={id:'session',provider:'opencode',accountId:'bound',hostId:'remote',profile:'normal',cwd:'/tmp/project',dataClass:'D0',model:'fixture-model',isolation:{mode:'container',profileId:'container'}};
 const prepared=await service.prepare(metadata,false,{target:'container'});
 assert.equal(vault,0);assert.equal(discovery,0);assert.equal(prepared.environment.CANVASTTY_PROFILE_API_KEY,undefined);assert.deepEqual(prepared.remoteCredential.reference,profile.remoteCredential);
 assert.ok(prepared.environment.OPENCODE_CONFIG_CONTENT.includes('{env:CANVASTTY_PROFILE_API_KEY}'));prepared.assertCurrent(metadata);await prepared.cleanup();
 await assert.rejects(service.prepare(metadata,false),/remote.*container/i);
 assert.equal(vault,0);
});

test('remote adapter protocol/model matrix stays scoped and never creates local config', async t => {
 const root=await mkdtemp('/tmp/canvastty-remote-adapters-');t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [runtime,protocol] of [['opencode','openai-compatible'],['opencode','anthropic-compatible'],['opencode','google'],['minimax','openai-compatible'],['minimax','anthropic-compatible'],['omp','openai-compatible']]){
  const selected={...profile,protocol};const bound={...account,provider:runtime};const settings={remoteHosts:[host],providerAccounts:[bound],apiProfiles:[selected]};
  const service=new ProviderAccountLaunchService(()=>settings,{get generation(){throw Error('local vault touched');},get(){throw Error('local vault touched');}},{temporaryRoot:root,discovery:{discover(){throw Error('host discovery touched');}}});
  const metadata={id:'matrix',provider:runtime,hostId:'remote',accountId:'bound',profile:'normal',cwd:'/tmp/project',dataClass:'D0',model:'fixture-model'};
  const prepared=await service.prepare(metadata,false,{target:'container'});assert.equal(prepared.environment.CANVASTTY_PROFILE_API_KEY,undefined);assert.equal(prepared.remoteCredential.hostId,'remote');
  if(runtime==='opencode') assert.ok(prepared.environment.OPENCODE_CONFIG_CONTENT.includes('{env:CANVASTTY_PROFILE_API_KEY}'));
  else assert.equal(prepared.containerRecipe.runtime,runtime);
  selected.remoteCredential={kind:'environment',name:'REPLACEMENT_KEY'};assert.throws(()=>prepared.assertCurrent(metadata),/changed/);await prepared.cleanup();
 }
 const {readdir}=await import('node:fs/promises');assert.deepEqual(await readdir(root),[]);
 for(const [runtime,protocol] of [['omp','anthropic-compatible'],['minimax','google'],['omp','google']]){
  const service=new ProviderAccountLaunchService(()=>({remoteHosts:[host],providerAccounts:[{...account,provider:runtime}],apiProfiles:[{...profile,protocol}]}),{get(){throw Error('vault touched');}});
  await assert.rejects(service.prepare({id:'bad',provider:runtime,hostId:'remote',accountId:'bound',profile:'normal',cwd:'/tmp/project',dataClass:'D0'},false,{target:'container'}),/incompatible|support/i);
 }
});
