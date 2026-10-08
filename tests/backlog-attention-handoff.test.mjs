import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AttentionService} from '../src/main/services/AttentionService.ts';
import {PluginSessions} from '../src/main/services/PluginSessions.ts';

test('attention masks names, coalesces events and persists independent channel/quiet/agent policies',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'attention-'));
  try{
    const path=join(dir,'preferences.json'), service=new AttentionService(path,text=>text.replaceAll('SECRET','[masked]'));
    await service.load();
    const event=service.publish('agent','SECRET agent','done',1000);
    assert.equal(event.title,'[masked] agent');assert.equal(service.publish('agent','agent','done',2000),null);
    assert.ok(service.publish('agent','agent','approval',2100));
    assert.ok(service.publish('agent','agent','approval',2200),'a second permission request is not dropped');
    assert.equal(service.list('phone').filter(item=>item.kind==='approval').length,2);
    await service.set({...service.get(),importantOnly:true,channels:{desktop:false,phone:true,glasses:false},sessionIds:['agent']});
    assert.equal(service.allows('phone',event),false);
    const failure=service.publish('agent','agent','failed',3000);
    assert.equal(service.allows('phone',failure),true);assert.equal(service.allows('desktop',failure),false);
    assert.equal(service.allows('phone',{...failure,sessionId:'other'}),false);
    await service.set({...service.get(),quietUntil:5000});assert.equal(service.allows('phone',failure,4000),false);
    assert.equal(service.allows('phone',failure,6000),true);
    const restored=new AttentionService(path,text=>text);await restored.load();assert.deepEqual(restored.get(),service.get());
    assert.equal((await readFile(path,'utf8')).includes('SECRET'),false);
    await assert.rejects(service.set({...service.get(),quietUntil:NaN}),/Invalid/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

function world(failDelivery=false,installRecord=()=>null){
  const calls=[],notices=[];
  const metadata={id:'source',provider:'codex',title:'Original',role:'agent',profile:'auto',cwd:'/project',position:{x:0,y:0},status:'working',startedAt:1,exitCode:null};
  const contexts=new Map([['source',{metadata,workingDirectory:'/project/worktree',environment:{kind:'worktree',pluginId:'environments',label:'branch',ref:{}},owner:'different-plugin',restored:false}]]);
  const terminals={pluginContext:id=>contexts.get(id)??null,listMetadata:()=>[...contexts.values()].map(row=>row.metadata),
    create(request,control){calls.push({type:'create',request,control});const next={...metadata,...request,id:'replacement'};contexts.set(next.id,{metadata:next,workingDirectory:request.cwd,environment:null,owner:control.ownerPluginId,restored:false});return next;},
    async deliverInput(id,text){calls.push({type:'input',id,text});return {delivered:!failDelivery};},
    dispose(id,options){calls.push({type:'dispose',id,options});contexts.delete(id);},redactSecrets:text=>text.replaceAll('SECRET','[masked]'),
    redactSecretsTail:text=>text,readBuffer:()=>({buffer:'PRIVATE OUTPUT'}),setPluginOwner(){}};
  const sessions=new PluginSessions({terminals,installRecord,notify:(...args)=>{notices.push(args);return true;}});
  return {sessions,calls,contexts,notices};
}

test('metadata permission does not grant tool activity',()=>{
  const {sessions,notices}=world();
  sessions.handle('accounts','one','sessions.subscribe',{},['sessions:events']);
  sessions.handle('accounts','two','sessions.subscribe',{ownedOnly:true},['sessions:events']);
  sessions.activity({type:'pretool',sessionId:'source',at:1,provider:'codex',toolName:'Read',normalizedActionHash:'a'.repeat(64)});
  assert.equal(notices.length,0);
  assert.equal(JSON.stringify(notices).includes('PRIVATE OUTPUT'),false);
});


test('tool activity requires the exact live trusted assistant and exposes only scoped opaque fingerprints',()=>{
 const trusted={sourceUrl:'https://github.com/BIackFIame/canvastty-plugin-assistant.git',enabled:true,nativeCodeTrusted:true};
 let installed=trusted;const f=world(false,()=>installed);
 for(const [plugin,service] of [['canvastty-assistant','assistant'],['canvastty-assistant','other'],['other','assistant']])f.sessions.handle(plugin,service,'sessions.subscribe',{},['sessions:events']);
 const hash='a'.repeat(64),pre={type:'pretool',sessionId:'source',at:1,turnEpoch:1,toolName:'Bash',normalizedAction:hash,normalizedActionHash:hash};
 const outcome={type:'tool-outcome',sessionId:'source',at:2,turnEpoch:1,toolName:'Bash',resultClass:'success',normalizedActionHash:hash,outputHash:hash,changedPathHashes:[hash]};
 f.sessions.activity(pre);f.sessions.activity(outcome);f.sessions.activity(outcome);
 assert.equal(f.notices.length,3);assert.ok(f.notices.every(n=>n[0]==='canvastty-assistant'&&n[1]==='assistant'));
 const a=f.notices[0][3],b=f.notices[1][3],c=f.notices[2][3];
 assert.equal(a.normalizedAction,a.normalizedActionHash);assert.equal(a.normalizedActionHash,b.normalizedActionHash);
 assert.equal(b.outputHash,c.outputHash);assert.equal(b.changedPathHashes[0],c.changedPathHashes[0]);
 assert.notEqual(b.outputHash,b.normalizedActionHash);assert.notEqual(b.outputHash,b.changedPathHashes[0]);
 for(const value of [a.normalizedAction,b.normalizedActionHash,b.outputHash,...b.changedPathHashes]){assert.match(value,/^[a-f0-9]{64}$/);assert.notEqual(value,hash);}
 const context=f.contexts.get('source');f.contexts.set('other-card',{...context,metadata:{...context.metadata,id:'other-card'}});
 f.sessions.activity({...outcome,sessionId:'other-card'});assert.notEqual(f.notices.at(-1)[3].normalizedActionHash,b.normalizedActionHash);
 const otherHost=world(false,()=>trusted);otherHost.sessions.handle('canvastty-assistant','assistant','sessions.subscribe',{},['sessions:events']);otherHost.sessions.activity(outcome);
 assert.notEqual(otherHost.notices[0][3].normalizedActionHash,b.normalizedActionHash);
 const count=f.notices.length;
 for(const record of [null,{...trusted,sourceUrl:'https://github.com/attacker/canvastty-plugin-assistant.git'},{...trusted,enabled:false},{...trusted,nativeCodeTrusted:false}]){installed=record;f.sessions.activity(outcome);assert.equal(f.notices.length,count);}
 installed=trusted;f.sessions.activity(outcome);assert.equal(f.notices.length,count+1,'live trust restored without changing metadata subscription');
});
