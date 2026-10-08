import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionTimelineService} from '../src/main/services/SessionTimelineService.ts';
import {registerBacklogIpc} from '../src/main/ipc/registerBacklogIpc.ts';
import {BACKLOG_IPC} from '../src/shared/backlog.ts';
const context={provider:'codex',accountId:'account',model:'model',taskId:'root'};
const prices=[{provider:'codex',model:'model',inputPerMillion:1,outputPerMillion:1}];
const counter=total=>({input:total*0.8,output:total*0.2,total});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'ctty-shared-usage-'));t.after(()=>rm(root,{recursive:true,force:true}));const timeline=new SessionTimelineService(root,x=>x,200*1024*1024,()=>1000);await timeline.load();return {root,timeline};}
function taskUsage(timeline){
 const handlers=new Map(),webContents={mainFrame:{}},rows=[{id:'root'},{id:'child',parentSessionId:'root'}];
 registerBacklogIpc({handle:(name,fn)=>handlers.set(name,fn)},{timeline,board:{subscribe(){}},getMainWindow:()=>({webContents}),
  taskRoot:()=>({id:'root'}),usagePrices:{get:()=>prices},terminals:{getMetadata:id=>rows.find(row=>row.id===id),listMetadata:()=>rows}});
 return id=>handlers.get(BACKLOG_IPC.usage)({sender:webContents,senderFrame:webContents.mainFrame},id);
}
test('shared task usage and all-time breakdown count the latest conversation snapshot once, live and reloaded',async t=>{
 const {root,timeline}=await fixture(t);
 await timeline.recordCumulativeUsage('historical',counter(1200),'cli','conversation',context);
 await timeline.recordCumulativeUsage('child',counter(1500),'cli','conversation',context,{resumed:true});
 await timeline.recordUsage('child',20,30,'additive',0.1,context);
 const verify=async value=>{
  const usage=taskUsage(value)('root');assert.equal(usage.tokens.total,1550);assert.equal(usage.cost,0.1015);
  assert.equal(value.usage(['historical'],prices).tokens.total,1200,'one card keeps its own snapshot');
  assert.equal(value.usage(['child'],prices).tokens.total,1550);
  const rows=await value.breakdown('all','root',prices);assert.equal(rows.reduce((n,row)=>n+row.tokens.total,0),1550);
  assert.equal(rows.find(row=>row.source==='cli').sessionId,'child');
 };
 await verify(timeline);const restored=new SessionTimelineService(root,x=>x);await restored.load();await verify(restored);
});
test('last observation wins after returning to an older card or resetting, regardless of scope order and reload insertion order',async t=>{
 const {root,timeline}=await fixture(t);const changes=[];timeline.subscribeUsage(id=>changes.push(id));
 await timeline.recordCumulativeUsage('a',counter(1200),'cli','conversation',context);
 await timeline.recordCumulativeUsage('b',counter(1500),'cli','conversation',context);
 await timeline.recordCumulativeUsage('a',counter(1200),'cli','conversation',context);
 assert.equal(changes.length,3,'a repeated per-card sample can be the new shared counter reset');
 assert.equal(timeline.usage(['b','a']).tokens.total,1200);
 await timeline.recordCumulativeUsage('a',counter(100),'cli','conversation',context);
 assert.equal(timeline.usage(['a','b']).tokens.total,100,'all-time summary preserves latest snapshot, not max or accumulated budget deltas');
 const restored=new SessionTimelineService(root,x=>x);await restored.load();
 assert.deepEqual(restored.usage(['b','a']),timeline.usage(['a','b']));
 assert.equal((await restored.breakdown('all','root')).reduce((n,row)=>n+row.tokens.total,0),100);
 await restored.recordCumulativeUsage('b',counter(300),'cli','conversation',context);assert.equal(restored.usage().tokens.total,300);
});
test('identities preserve provider, account, source and missing-counter separation; latest unknown cost is not borrowed',async t=>{
 const {root,timeline}=await fixture(t);
 await timeline.recordCumulativeUsage('a',counter(100),'cli','same',context);
 await timeline.recordCumulativeUsage('a',counter(200),'cli','same',{...context,accountId:'other'});
 await timeline.recordCumulativeUsage('b',counter(300),'cli','same',{...context,provider:'claude'});
 await timeline.recordCumulativeUsage('b',counter(400),'other-source','same',context);
 await timeline.recordCumulativeUsage('a',counter(50),'no-id',undefined,context);
 await timeline.recordCumulativeUsage('b',counter(70),'no-id',undefined,context);
 assert.equal(timeline.usage().tokens.total,1120);
 const reloaded=new SessionTimelineService(root,x=>x);await reloaded.load();assert.equal(reloaded.usage().tokens.total,1120);
 assert.equal((await reloaded.breakdown('all','root')).reduce((n,row)=>n+row.tokens.total,0),1120);
 await timeline.recordCumulativeUsage('old',{...counter(500),costUsd:0.5},'unknown','u',context);
 await timeline.recordCumulativeUsage('new',{input:null,output:null,total:600},'unknown','u',context);
 assert.equal(timeline.usage(['old','new'],prices).cost,null);assert.equal(timeline.usage(['old','new'],prices).tokens.input,null);
});
