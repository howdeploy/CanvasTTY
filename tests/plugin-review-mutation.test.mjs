import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {normalizeCardActionInput,normalizeCardReview} from '../src/main/services/PluginChangeReviews.ts';
import {PluginCards} from '../src/main/services/PluginCards.ts';
import {importWithFakeReact,findAll,tick} from './helpers/fake-react.mjs';
const dialog=await importWithFakeReact('src/renderer/src/features/terminal/PluginChangesReviewDialog.tsx','PluginChangesReviewDialog');
const file=path=>({path,diff:'+change',page:0});
for(const action of ['Accept selected files','Reject this subtask'])test(`mutation replaces the remaining review scope: ${action}`,async t=>{
 const oldWindow=globalThis.window,oldDocument=globalThis.document;
 globalThis.document={body:{nodeType:1}};
 globalThis.window={setTimeout,clearTimeout,canvasTTY:{terminal:{onSession:()=>()=>{},list:async()=>[]}}};
 t.after(()=>{dialog.__unmount();globalThis.window=oldWindow;globalThis.document=oldDocument;});dialog.__reset();
 const calls=[],remaining={acceptActionId:'accept',rejectActionId:'reject',groups:[{sessionId:'second',title:'Second',files:[file('remaining.txt')]}]};
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',rejectActionId:'reject',groups:[
  {sessionId:'first',title:'First',files:[file('removed.txt')]},{sessionId:'second',title:'Second',files:[file('remaining.txt')]}]},
  invokeAction:async(id,input)=>{calls.push({id,input});return {review:remaining};},onReviewChange:review=>{props.review=review;},onActionResult(){},onClose(){}};
 let tree;const render=()=>{dialog.__flush();tree=dialog.__render(dialog.PluginChangesReviewDialog,props).children;return tree;};
 const button=label=>findAll(tree,node=>node.type==='button'&&node.props.children===label)[0];
 const click=label=>{const target=button(label);assert.ok(target,label);assert.equal(Boolean(target.props.disabled),false,label);target.props.onClick({currentTarget:{}});};
 render();await tick();render();click(action);render();click('Confirm');await tick();render();render();
 assert.equal(props.review,remaining,'mutation payload replaces cached groups');assert.equal(button('Confirm'),undefined);
 assert.ok(!JSON.stringify(tree).includes('removed.txt'));click('Accept selected files');render();click('Confirm');await tick();render();
 assert.deepEqual(calls[1],{id:'accept',input:{agentSessionId:'second',files:['remaining.txt']}});
});

const supervisorSource=await readFile(new URL('../src/main/services/PluginServiceSupervisor.ts',import.meta.url),'utf8');
const serializeFrame=supervisorSource.match(/frame = (JSON\.stringify\(\{ jsonrpc: "2.0", id, method, params: params === undefined \? null : params \}\));/u)?.[1];
assert.ok(serializeFrame,'test uses the actual outbound plugin frame serialization');
const frameLimit=Number(supervisorSource.match(/const PLUGIN_SERVICE_MAX_FRAME_BYTES = (\d+) \* (\d+)/u)?.[1])*Number(supervisorSource.match(/const PLUGIN_SERVICE_MAX_FRAME_BYTES = (\d+) \* (\d+)/u)?.[2]);
for(const [action,style,count,conflicts] of [
 ['Accept selected files','ascii',400,true],
 ['Accept every file in this subtask','escaped',350,true],
 ['Accept the full task result','unicode',400,false]
])test(`large normalized review round-trips the real dialog ${action} with ${count} ${style} paths`,{timeout:10000},async t=>{
 const oldWindow=globalThis.window,oldDocument=globalThis.document;globalThis.document={body:{nodeType:1}};
 globalThis.window={setTimeout,clearTimeout,canvasTTY:{terminal:{onSession:()=>()=>{},list:async()=>[]}}};
 t.after(()=>{dialog.__unmount();globalThis.window=oldWindow;globalThis.document=oldDocument;});dialog.__reset();
 const page={text:'',startLine:0,totalLines:0,hasMore:false};
 const files=Array.from({length:count},(_,i)=>({path:`${i}/`+(style==='ascii'?'a'.repeat(980):style==='escaped'?'"\\'.repeat(240):'界'.repeat(350)),diff:'+x',page:0,...(conflicts?{conflict:{current:page,agent:page}}:{})}));
 const review=normalizeCardReview({title:'Large review',acceptActionId:'accept',groups:[{sessionId:'worker',title:'Worker',files}]},text=>text,new Set(['accept']));
 assert.ok(Buffer.byteLength(JSON.stringify(review))>256*1024);assert.ok(Buffer.byteLength(JSON.stringify(review))<=512*1024);
 const calls=[],trustedSession={id:'root',provider:'codex',profile:'normal',role:'orchestrator',title:'Project review',cwd:'/project',position:{x:0,y:0},size:{width:800,height:600},status:'idle',startedAt:1,exitCode:null};
 const cards=new PluginCards({providers:()=>[{pluginId:'fixture',pluginName:'Fixture',serviceId:'review',actions:[{id:'accept',title:'Accept'}]}],trustedPlugins:()=>new Set(['fixture']),session:()=>trustedSession,redact:text=>text,changed(){},call:async(_plugin,_service,method,params)=>{
  const frame=runInNewContext(serializeFrame,{id:Number.MAX_SAFE_INTEGER,method,params});assert.ok(Buffer.byteLength(frame)<frameLimit,'the complete real invoke envelope fits the unchanged transport bound');calls.push(params);return{tone:'info'};
 }});
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review,invokeAction:(action,input)=>cards.invoke('fixture',action,'root',input),onReviewChange(){},onActionResult(){},onClose(){}};
 let tree;const render=()=>{dialog.__flush();tree=dialog.__render(dialog.PluginChangesReviewDialog,props).children;};
 const click=label=>{const button=findAll(tree,node=>node.type==='button'&&node.props.children===label)[0];assert.ok(button,label);assert.equal(Boolean(button.props.disabled),false,label);button.props.onClick({currentTarget:{}});};
 render();await tick();render();
 if(conflicts)for(let i=0;i<count;i++){
  findAll(tree,node=>node.type==='ol')[0].props.onScroll({currentTarget:{scrollTop:i*56}});render();
  const open=findAll(tree,node=>node.type==='button'&&node.props.title===files[i].path)[0];assert.ok(open);open.props.onClick();render();
  const radio=findAll(tree,node=>node.type==='input'&&node.props.type==='radio'&&node.props.value==='agent')[0];assert.ok(radio);radio.props.onChange();render();
 }
 click(action);render();click('Confirm');await tick();render();assert.equal(calls.length,1);
 const input=calls[0].input;assert.equal(input.files.length,count);assert.deepEqual(normalizeCardActionInput(input),input);assert.ok(Buffer.byteLength(JSON.stringify(input))>256*1024);
 if(conflicts){assert.equal(Object.keys(input.resolutions).length,count);assert.ok(Object.values(input.resolutions).every(value=>value==='agent'));}
 else assert.equal(input.resolutions,undefined);
});
