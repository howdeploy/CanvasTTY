import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';
const source=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8');
const start=source.indexOf('      onSignal: (terminalSessionId, signal)');
const callback=source.slice(start,source.indexOf('      onAnswerCaptureRevoked:',start));
const code=(await transform('result={'+callback+'};',{loader:'ts',format:'cjs'})).code;
test('production signal handler gates observability and correlated answers on host acceptance',async()=>{
 const calls=[];let accept=false;
 const sandbox={result:null,console,secretGrants:{turnEnded:()=>calls.push(["secret-turn-end"]),revalidateTurn:()=>calls.push(["secret-revalidate"])},
  terminalManager:{
   applyProviderSignal:(id,signal)=>{calls.push(['apply',signal]);return accept;},
   getMetadata:()=>({provider:'codex',model:'model'}),pluginContext:()=>null,
   usageAccount:()=>({id:'account',home:'/fixture'}),resumedConversation:()=>false,
   recordAnswer:(_id,result,correlation)=>calls.push(['answer',result,correlation])
  },
  usageSourceFor:()=>({codexUsage:async()=>{calls.push(['usage-read']);return{input:1,output:2,total:3};}}),
  agentControlService:{taskRoot:()=>({id:'task'})},
  timeline:{append:async(...args)=>calls.push(['timeline',...args]),recordCumulativeUsage:async(...args)=>calls.push(['usage-record',...args])},
  redaction:{redact:s=>s},checkpointTurns:new Map([['worker',{pending:Promise.resolve()}]]),
  pluginSessions:{activity:event=>calls.push(['activity',event])},
  agentControl:{onSignal:()=>calls.push(['control'])},evenG2:{answer:()=>calls.push(['glasses'])}
 };
 runInNewContext(code,sandbox);
 const signal={state:'idle',event:'Stop',turnId:'turn',turnEpoch:3,threadId:'conversation',result:{text:'answer',truncated:false},lastAssistantMessage:'answer',answerCaptureGrantExpiresAt:Date.now()+1000,toolOutcome:{toolName:'Read',resultClass:'success',changedPathHashes:[]}};
 sandbox.result.onSignal('worker',signal);await Promise.resolve();
 assert.deepEqual(calls.map(c=>c[0]),['apply']);assert.ok(sandbox.checkpointTurns.has('worker'),'stale completion must not clear the live checkpoint attempt');
 calls.length=0;accept=true;sandbox.result.onSignal('worker',signal);await Promise.resolve();
 assert.equal(calls[0][0],'apply');
 for(const kind of ['timeline','usage-read','usage-record','answer','activity','control','glasses'])assert.ok(calls.some(c=>c[0]===kind),kind);
 assert.equal(calls.find(c=>c[0]==='answer')[2].turnId,'turn');
 assert.equal(calls.find(c=>c[0]==='activity')[1].turnEpoch,3);
 assert.equal(sandbox.checkpointTurns.has('worker'),false);
 sandbox.checkpointTurns.set('worker',{});sandbox.result.onSignal('worker',{state:'needs_approval',event:'PermissionRequest'});
 assert.ok(sandbox.checkpointTurns.has('worker'),'permission continuation retains the pre-turn checkpoint');
});
