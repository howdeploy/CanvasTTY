import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverySignal, discoveryTargets, discoveryDismissalKey } from '../src/shared/modelDiscovery.ts';
import { discoveryCandidates, acceptDiscoverySignal, ModelDiscoveryObserver } from '../src/main/services/ModelDiscoveryObserver.ts';
import { DiscoveryNoticeController } from '../src/renderer/src/lib/modelDiscoveryNotice.ts';
import { ProviderModelCatalog } from '../src/main/services/providerModels.ts';
const plugin = { enabled:true, nativeCodeTrusted:true, manifest:{ id:'assistant', name:'Assistant', permissions:['model:route'], settingsContribution:'settings', contributions:[{id:'settings',kind:'canvas-app'}], services:[{id:'router',modelRouter:true}] } };
const target = {pluginId:'assistant',serviceId:'router',contributionId:'settings'};
const signal = {pendingCount:2,revision:'4'};
const row = {id:'codex',installed:true,available:true,signIn:'unknown',model:{supported:true,known:['preview','preview','stable']}};

test('only bounded metadata from a trusted running opted-in router reaches the host notice', () => {
  assert.deepEqual(discoverySignal({...signal,task:'private',url:'evil'}),signal);
  for (const bad of [{...signal,pendingCount:-1},{...signal,pendingCount:513},{...signal,pendingCount:1.2},{...signal,revision:'x'.repeat(81)}]) assert.equal(discoverySignal(bad),null);
  const deps={enabled:()=>true,providers:()=>[target],running:()=>true};
  assert.deepEqual(acceptDiscoverySignal(deps,'assistant','router',signal),signal);
  assert.equal(acceptDiscoverySignal({...deps,enabled:()=>false},'assistant','router',signal),null);
  assert.equal(acceptDiscoverySignal({...deps,running:()=>false},'assistant','router',signal),null);
  assert.equal(acceptDiscoverySignal(deps,'forged','router',signal),null);
});

test('notice targets require trust, permission and the exact declared settings canvas', () => {
  assert.deepEqual(discoveryTargets([plugin],true),[target]);
  for (const changed of [{enabled:false},{nativeCodeTrusted:false},{manifest:{...plugin.manifest,permissions:[]}},{manifest:{...plugin.manifest,settingsContribution:'other'}}]) assert.deepEqual(discoveryTargets([{...plugin,...changed}],true),[]);
  assert.deepEqual(discoveryTargets([plugin],false),[]);
  assert.equal(discoveryDismissalKey({...target,...signal}),discoveryDismissalKey({...target,...signal,revision:'5'}));
  assert.notEqual(discoveryDismissalKey(target),discoveryDismissalKey({...target,serviceId:'other'}));
});

test('inventory is bounded, exact, deduplicated and does not imply unsupported launch access', () => {
  const candidates=discoveryCandidates({providers:[row,{...row,id:'minimax',model:{supported:false,known:['M3.1-Preview']}},{...row,id:'claude',signIn:'signed_out'}]});
  assert.equal(candidates.length,5);
  assert.equal(candidates.find(c=>c.provider==='minimax').available,false);
  assert.equal(candidates.find(c=>c.provider==='claude').available,false);
  assert.equal(candidates[0].reasoningEffort,undefined);
  assert.equal(candidates[0].observed,undefined);
  assert.equal(discoveryCandidates({providers:[{...row,model:{supported:true,known:Array.from({length:1000},(_,i)=>`model-${i}`)}}]}).length,512);
});

test('cached inventory reads cannot start a CLI or refresh stale listings', async () => {
  let calls=0;
  const catalog=new ProviderModelCatalog({get(){throw Error('must not resolve CLI');}},{run:async()=>{calls++;return '';}});
  assert.equal(catalog.cached('opencode'),null);
  assert.equal(calls,0);
});

test('observer skips disabled and overlapping ticks and sends host metadata only', async () => {
  let enabled=false,release,calls=0,reads=0;
  const observer=new ModelDiscoveryObserver({enabled:()=>enabled,providers:()=>[target],running:()=>true,directory:()=>{reads++;return {providers:[row]};},call:async(p,s,m,args)=>{calls++;assert.equal(m,'canvastty.model.observe');assert.deepEqual(Object.keys(args),['candidates']);await new Promise(r=>release=r);}});
  await observer.refresh();assert.equal(reads,0);
  enabled=true;const pending=observer.refresh();await observer.refresh();assert.equal(calls,1);release();await pending;
  observer.dispose();await observer.refresh();assert.equal(calls,1);
});

test('notice recovers on reconnect and clears when the service stops or plugin disables discovery', async () => {
  let running=true,enabled=true;const states=[];
  const controller=new DiscoveryNoticeController([target],{report:async()=>({services:[{serviceId:'router',state:running?'running':'stopped'}]}),request:async()=>({...signal,enabled}),changed:value=>states.push(value)});
  await controller.refresh();assert.equal(states.at(-1)[0].pendingCount,2);
  const count=states.length;await controller.refresh();assert.equal(states.length,count);
  running=false;await controller.refresh();assert.deepEqual(states.at(-1),[]);
  running=true;await controller.refresh();assert.equal(states.at(-1).length,1);
  enabled=false;await controller.refresh();assert.deepEqual(states.at(-1),[]);
});

test('late replies cannot restore notices after opt-out or a stopped service', async () => {
  let release;const states=[];
  const controller=new DiscoveryNoticeController([target],{report:async()=>({services:[{serviceId:'router',state:'running'}]}),request:()=>new Promise(r=>release=r),changed:value=>states.push(value)});
  const pending=controller.refresh();await new Promise(r=>setImmediate(r));controller.dispose();release({...signal,enabled:true});await pending;
  assert.deepEqual(states,[]);
  let reports=0;
  const stopped=new DiscoveryNoticeController([target],{report:async()=>({services:[{serviceId:'router',state:++reports===1?'running':'stopped'}]}),request:async()=>({...signal,enabled:true}),changed:value=>states.push(value)});
  await stopped.refresh();assert.deepEqual(states,[]);
});
