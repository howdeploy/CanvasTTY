import {renameSync,mkdirSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AttentionService} from '../src/main/services/AttentionService.ts';
import {OrchestrationTaskBoard} from '../src/main/services/OrchestrationTaskBoard.ts';
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

function world(failDelivery=false, ...options){
  const experimentalEnabled=options.length ? options[0] : ()=>true;
  const installRecord=options[1] ?? (()=>null);
  const calls=[],notices=[];
  const metadata={id:'source',provider:'codex',title:'Original',role:'agent',profile:'auto',cwd:'/project',position:{x:0,y:0},status:'working',startedAt:1,exitCode:null};
  const contexts=new Map([['source',{metadata,workingDirectory:'/project/worktree',environment:{kind:'worktree',pluginId:'environments',label:'branch',ref:{}},owner:'different-plugin',restored:false}]]);
  const terminals={pluginContext:id=>contexts.get(id)??null,listMetadata:()=>[...contexts.values()].map(row=>row.metadata),
    create(request,control){calls.push({type:'create',request,control});const next={...metadata,...request,id:'replacement'};contexts.set(next.id,{metadata:next,workingDirectory:request.cwd,environment:null,owner:control.ownerPluginId,restored:false});return next;},
    async deliverInput(id,text){calls.push({type:'input',id,text});return {delivered:!failDelivery};},
    dispose(id,options){calls.push({type:'dispose',id,options});contexts.delete(id);},redactSecrets:text=>text.replaceAll('SECRET','[masked]'),
    redactSecretsTail:text=>text,readBuffer:()=>({buffer:'PRIVATE OUTPUT'}),setPluginOwner(){}};
  const sessions=new PluginSessions({experimentalEnabled,terminals,installRecord,handoffTaskOwner:options[2],notify:(...args)=>{notices.push(args);return true;}});
  return {sessions,calls,contexts,notices};
}

test('handoff requires one-use human card consent, masks summary and waits before disposing original',async()=>{
  const {sessions,calls,contexts}=world();
  const handoff=()=>sessions.handle('canvastty-accounts','service','sessions.handoff',{sessionId:'source',summary:'Context SECRET'},['sessions:launch']);
  await assert.rejects(handoff(),/person/);
  await sessions.withCardConsent('canvastty-accounts','handoff','source',async()=>{
    const replacement=await handoff();assert.equal(replacement.id,'replacement');
    await assert.rejects(handoff(),/person/);
  });
  assert.equal(calls[0].request.cwd,'/project/worktree');
  assert.equal(calls[0].request.profile,'auto');
  assert.equal(calls[0].control.continueTaskFrom,'source','host continuation context is supplied before launch');
  assert.equal(calls[1].text,'Context [masked]\r');assert.equal(calls[2].id,'source');
  assert.equal(contexts.has('replacement'),true);assert.equal(contexts.has('source'),false);
});

test('failed handoff preserves original and closes failed replacement; foreign card actions give no consent',async()=>{
  const {sessions,contexts}=world(true);
  const handoff=()=>sessions.handle('canvastty-accounts','service','sessions.handoff',{sessionId:'source',summary:'Context'},['sessions:launch']);
  await assert.rejects(sessions.withCardConsent('canvastty-accounts','other','source',handoff),/person/);
  await assert.rejects(sessions.withCardConsent('canvastty-accounts','handoff','source',handoff),/original agent/);
  assert.equal(contexts.has('source'),true);assert.equal(contexts.has('replacement'),false);
});

test('an untrusted plugin cannot mint Accounts handoff consent for another card',async()=>{
  const {sessions,calls,contexts}=world();
  await assert.rejects(sessions.withCardConsent('untrusted-plugin','handoff','source',()=>
    sessions.handle('untrusted-plugin','service','sessions.handoff',{sessionId:'source',summary:'Context'},['sessions:launch'])),
  /trusted Accounts plugin/u);
  assert.equal(calls.length,0);
  assert.equal(contexts.has('source'),true);
});

test('quota activity honors trusted assistant ownership and never includes terminal screen',()=>{
  const trusted={sourceUrl:'https://github.com/BIackFIame/canvastty-plugin-assistant.git',enabled:true,nativeCodeTrusted:true};
  const {sessions,notices}=world(false,()=>true,()=>trusted);
  sessions.handle('canvastty-assistant','assistant','sessions.subscribe',{},['sessions:events']);
  sessions.activity({type:'limit.exhausted',sessionId:'source',at:1,provider:'codex'});
  assert.equal(notices.length,1);assert.equal(notices[0][2],'canvastty.activity');
  sessions.handle('canvastty-assistant','assistant','sessions.subscribe',{ownedOnly:true},['sessions:events']);
  sessions.activity({type:'limit.exhausted',sessionId:'source',at:2,provider:'codex'});
  assert.equal(notices.length,1);
  assert.equal(JSON.stringify(notices).includes('PRIVATE OUTPUT'),false);
});

test('handoff and quota events are off by default and follow the runtime setting', async()=>{
  for (const enabled of [undefined,()=>false]) {
    const {sessions,calls,notices}=world(false,enabled,()=>({sourceUrl:'https://github.com/BIackFIame/canvastty-plugin-assistant.git',enabled:true,nativeCodeTrusted:true}));
    sessions.handle('canvastty-assistant','assistant','sessions.subscribe',{},['sessions:events']);
    sessions.activity({type:'limit.exhausted',sessionId:'source',at:1,provider:'codex'});
    sessions.activity({type:'route.outcome',sessionId:'source',at:1,provider:'codex'});
    await assert.rejects(sessions.handle('canvastty-accounts','service','sessions.handoff',{sessionId:'source',summary:'Context'},['sessions:launch']),/disabled/);
    await assert.rejects(sessions.withCardConsent('canvastty-accounts','handoff','source',async()=>{}),/disabled/);
    assert.equal(calls.length,0);assert.equal(notices.length,0);
  }
  let enabled=true;
  const {sessions,calls}=world(false,()=>enabled);
  await assert.rejects(sessions.withCardConsent('canvastty-accounts','handoff','source',async()=>{
    enabled=false;
    return sessions.handle('canvastty-accounts','service','sessions.handoff',{sessionId:'source',summary:'Context'},['sessions:launch']);
  }),/disabled/);
  assert.equal(calls.length,0);
});

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
 let installed=trusted;const f=world(false,()=>true,()=>installed);
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
 const otherHost=world(false,()=>true,()=>trusted);otherHost.sessions.handle('canvastty-assistant','assistant','sessions.subscribe',{},['sessions:events']);otherHost.sessions.activity(outcome);
 assert.notEqual(otherHost.notices[0][3].normalizedActionHash,b.normalizedActionHash);
 const count=f.notices.length;
 for(const record of [null,{...trusted,sourceUrl:'https://github.com/attacker/canvastty-plugin-assistant.git'},{...trusted,enabled:false},{...trusted,nativeCodeTrusted:false}]){installed=record;f.sessions.activity(outcome);assert.equal(f.notices.length,count);}
 installed=trusted;f.sessions.activity(outcome);assert.equal(f.notices.length,count+1,'live trust restored without changing metadata subscription');
});
test('handoff board failure leaves every original owner intact and disposes only the replacement',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ctty-handoff-atomic-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const board=new OrchestrationTaskBoard(directory);for(const title of ['First','Second'])await board.addTask(directory,'root','root',{title,ownerSessionId:'source'});
 const location=board.boardLocation(directory).path,original=await readFile(location,'utf8'),backup=location+'.backup';let blocked=false;const mutate=board.mutate.bind(board);
 // Fail the commit that would finish transferring both tasks. A per-task implementation has already persisted one.
 t.mock.method(board,'mutate',(project,root,mutation)=>mutate(project,root,state=>{const result=mutation(state);if(!blocked&&state.tasks.filter(task=>task.ownerSessionId==='replacement').length===2){blocked=true;renameSync(location,backup);mkdirSync(location);}return result;}));
 const source=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8');const start=source.indexOf('handoffTaskOwner:')+'handoffTaskOwner:'.length;
 const callback=source.slice(start,source.indexOf('    installRecord:',start)).trim().replace(/,$/,'');
 const handoff=runInNewContext(stripTypeScriptTypes(`(${callback})`),{agentControlService:{taskRoot:()=>({cwd:directory,id:'root'})},taskBoard:board,managedTerminals:{getMetadata:()=>({title:'Replacement'})}});
 const f=world(false,()=>true,()=>null,handoff);
 await assert.rejects(f.sessions.withCardConsent('canvastty-accounts','handoff','source',()=>f.sessions.handle('canvastty-accounts','service','sessions.handoff',{sessionId:'source',summary:'Continue'},['sessions:launch'])));
 assert.equal(await readFile(backup,'utf8'),original,'failed atomic rename cannot persist a subset');
 await rm(location,{recursive:true});await rename(backup,location);assert.ok((await board.listTasks(directory,'root')).tasks.every(task=>task.ownerSessionId==='source'));
 assert.equal(f.contexts.has('source'),true);assert.equal(f.contexts.has('replacement'),false);assert.deepEqual(f.calls.filter(c=>c.type==='dispose').map(c=>c.id),['replacement']);
});
test('atomic handoff revalidates queued completion and ownership changes under the board lock',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ctty-handoff-lock-'));t.after(()=>rm(directory,{recursive:true,force:true}));const board=new OrchestrationTaskBoard(directory);
 const add=title=>board.addTask(directory,'root','root',{title,ownerSessionId:'source'});const done=await add('Completing'),other=await add('Reassigned'),keep=await add('Transfer');
 const foreign=await board.addTask(directory,'foreign','foreign',{title:'Other root',ownerSessionId:'source'});
 const completing=board.completeTask(directory,'root','source',done.id,'Finished');const reassigned=board.assignTask(directory,'root',other.id,'another');
 const transfer=board.transferOwner(directory,'root','source','replacement','Replacement');await Promise.all([completing,reassigned]);assert.equal(await transfer,1);
 const rows=(await board.listTasks(directory,'root')).tasks;assert.equal(rows.find(x=>x.id===done.id).status,'done');assert.equal(rows.find(x=>x.id===done.id).ownerSessionId,'source');assert.equal(rows.find(x=>x.id===other.id).ownerSessionId,'another');assert.equal(rows.find(x=>x.id===keep.id).ownerSessionId,'replacement');
 assert.equal((await board.listTasks(directory,'foreign')).tasks.find(x=>x.id===foreign.id).ownerSessionId,'source');assert.equal((await board.listTasks(directory,'root')).revision,7,'one revision for the whole handoff');
});
test('quota-only Accounts delivery uses its own live provenance, service, opt-in and ownership gates',()=>{
 const trusted={sourceUrl:'https://github.com/BIackFIame/canvastty-plugin-accounts.git',enabled:true,nativeCodeTrusted:true};let record=trusted,enabled=true;
 const f=world(false,()=>enabled,id=>id==='canvastty-accounts'?record:null);
 for(const [plugin,service] of [['canvastty-accounts','accounts'],['canvastty-accounts','other'],['foreign','accounts'],['canvastty-assistant','assistant']])f.sessions.handle(plugin,service,'sessions.subscribe',{},['sessions:events']);
 for(const type of ['limit.exhausted','route.outcome'])f.sessions.activity({type,sessionId:'source',at:1,provider:'codex',accountId:'default',toolName:'must not leak',normalizedActionHash:'a'.repeat(64)});
 assert.equal(f.notices.length,2);assert.ok(f.notices.every(row=>row[0]==='canvastty-accounts'&&row[1]==='accounts'));assert.doesNotMatch(JSON.stringify(f.notices),/toolName|normalizedActionHash|must not leak/);
 for(const type of ['pretool','activity','tool-outcome'])f.sessions.activity({type,sessionId:'source',at:2,toolName:'Bash',normalizedAction:'a'.repeat(64),normalizedActionHash:'a'.repeat(64)});
 assert.equal(f.notices.length,2,'Accounts never receives tool metadata, even without an Assistant');
 for(const changed of [null,{...trusted,sourceUrl:'https://github.com/spoof/canvastty-plugin-accounts.git'},{...trusted,enabled:false},{...trusted,nativeCodeTrusted:false}]){record=changed;f.sessions.activity({type:'limit.exhausted',sessionId:'source',at:3});assert.equal(f.notices.length,2);}
 record=trusted;enabled=false;f.sessions.activity({type:'limit.exhausted',sessionId:'source',at:4});assert.equal(f.notices.length,2);
 enabled=true;f.sessions.handle('canvastty-accounts','accounts','sessions.subscribe',{ownedOnly:true},['sessions:events']);f.sessions.activity({type:'limit.exhausted',sessionId:'source',at:5});assert.equal(f.notices.length,2);
 f.contexts.get('source').owner='canvastty-accounts';f.sessions.activity({type:'limit.exhausted',sessionId:'source',at:6});assert.equal(f.notices.length,3);assert.doesNotMatch(JSON.stringify(f.notices),/PRIVATE OUTPUT/);
});
