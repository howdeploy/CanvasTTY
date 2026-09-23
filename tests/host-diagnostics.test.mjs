import assert from 'node:assert/strict';
import test from 'node:test';
import { SavedHostDiagnostics } from '../src/main/services/SavedHostDiagnostics.ts';
import { RemoteProviderDiscovery } from '../src/main/services/RemoteProviderDiscovery.ts';
import { RemoteProviderAccess } from '../src/main/services/RemoteProviderAccess.ts';
import { RemoteHostMetricsService } from '../src/main/services/RemoteHostMetrics.ts';
const host={id:'server',label:'Server',sshHost:'fake.invalid',providerAccess:{mode:'allowlist',providers:['codex']}};
function fixture(runner){let hosts=[host];const options={now:()=>123};const discovery=new RemoteProviderDiscovery(runner,options),access=new RemoteProviderAccess(runner,options),metrics=new RemoteHostMetricsService(runner,options);return {service:new SavedHostDiagnostics(()=>hosts,discovery,access,metrics),edit:h=>hosts=[h]};}
test('saved-ID diagnostic boundary is inert, rejects descriptors and probes only allowed providers',async()=>{
  const calls=[];const f=fixture(async(h,args)=>{calls.push({h,args});return {code:0,stdout:'codex=/usr/bin/codex\ncodex=1\n',stderr:''};});
  assert.equal(calls.length,0);
  await assert.rejects(f.service.inspect({id:'server'}),/saved host id/i);
  await assert.rejects(f.service.inspect('missing'),/saved/i);
  assert.equal(calls.length,0);
  const result=await f.service.inspect('server');
  assert.equal(calls.length,3);assert.ok(calls.every(call=>call.h.id==='server'));
  assert.deepEqual(result.discovery.providers.map(p=>p.provider),['codex']);
  assert.deepEqual(Object.keys(result.access.providers),['codex']);
  assert.equal(result.metrics.memoryAvailableMb,null);
  assert.equal(result.discovery.collectedAt,123);assert.equal(result.access.collectedAt,123);
  await f.service.inspect('server');assert.equal(calls.length,3);
});
test('destination edits while a diagnostic is pending reject its obsolete result',async()=>{
  const waiting=[];const f=fixture(()=>new Promise(resolve=>waiting.push(resolve)));
  const result=f.service.inspect('server');
  await new Promise(resolve=>setImmediate(resolve));
  f.edit({...host,sshHost:'changed.invalid'});
  waiting.forEach(resolve=>resolve({code:0,stdout:'',stderr:''}));
  await assert.rejects(result,/changed/i);
});
test('cached discovery and endpoint facts retain observation time',async()=>{
  let now=10;const runner=async()=>({code:0,stdout:'',stderr:''});
  for(const [Service,method] of [[RemoteProviderDiscovery,'discover'],[RemoteProviderAccess,'probe']]){
    now=10;const service=new Service(runner,{now:()=>now});
    const first=await service[method](host);now=100;
    assert.equal(first.collectedAt,10);assert.equal((await service[method](host)).collectedAt,10);
  }
});
