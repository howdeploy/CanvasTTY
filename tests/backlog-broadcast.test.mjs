import test from 'node:test';
import assert from 'node:assert/strict';
import {registerBacklogIpc} from '../src/main/ipc/registerBacklogIpc.ts';
import {BACKLOG_IPC,BACKLOG_EVENTS} from '../src/shared/backlog.ts';

test('broadcast rechecks live status in the host and submits one ordered write per selected card',()=>{
  const handlers=new Map(),writes=[];
  const rows=new Map([['one',{id:'one',status:'working',exitCode:null}],['approval',{id:'approval',status:'needs_approval',exitCode:null}],['paused',{id:'paused',status:'idle',exitCode:null}],['closed',{id:'closed',status:'done',exitCode:0}]]);
  const webContents={mainFrame:{}};
  registerBacklogIpc({handle:(name,fn)=>handlers.set(name,fn)},{board:{subscribe:()=>()=>{}},getMainWindow:()=>({webContents}),terminals:{
    getMetadata:id=>rows.get(id),redactSecrets:text=>text.replaceAll('sensitive-example','[redacted]'),
    pasteClipboard:(id,text,startedAt,options)=>{if(id==='paused')throw Error('budget');assert.equal(options.submit,true);writes.push({id,data:`\x1b[200~${text}\x1b[201~\r`});}
  }});
  const invoke=handlers.get(BACKLOG_IPC.broadcast),event={sender:webContents,senderFrame:webContents.mainFrame};
  const result=invoke(event,['one','approval','paused','closed','one'],'literal sensitive-example\x1b[201~');
  assert.deepEqual(result,{delivered:['one'],skipped:['approval','paused','closed']});
  assert.deepEqual(writes,[{id:'one',data:'\x1b[200~literal [redacted][201~\x1b[201~\r'}]);
  assert.throws(()=>invoke({...event,senderFrame:{}},['one'],'text'),/Untrusted/);
  assert.throws(()=>invoke(event,['one'],'x'.repeat(16001)),/Invalid/);
});

test('task mutations publish only a root/revision invalidation to the live trusted renderer',()=>{
  let listener,destroyed=false;
  const delivered=[];
  const webContents={isDestroyed:()=>destroyed,send:(channel,value)=>delivered.push({channel,value})};
  registerBacklogIpc({handle:()=>{}},{board:{subscribe:callback=>{listener=callback;return ()=>{};}},
    getMainWindow:()=>({isDestroyed:()=>false,webContents}),terminals:{}});
  listener({rootSessionId:'root',revision:9,projectRoot:'/private/project',tasks:[{title:'private task'}]});
  assert.deepEqual(delivered,[{channel:BACKLOG_EVENTS.taskBoardChanged,value:{rootSessionId:'root',revision:9}}]);
  destroyed=true;
  listener({rootSessionId:'root',revision:10});
  assert.equal(delivered.length,1);
});
