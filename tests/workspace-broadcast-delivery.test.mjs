import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {importWithFakeReact,findAll,tick} from './helpers/fake-react.mjs';
const source=await readFile(new URL('../src/renderer/src/features/workspace/WorkspaceCanvas.tsx',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('  const sendBroadcast = useCallback'),source.indexOf('  const animateLayout ='));
const tools=await importWithFakeReact('src/renderer/src/features/workspace/WorkspaceBacklogTools.tsx','WorkspaceBacklogTools');
const targets=[{id:'one',title:'First worker'},{id:'two',title:'Second worker'}];
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function canvas(send){const sending=[];const callback=runInNewContext(stripTypeScriptTypes(`${handler}\nsendBroadcast;`),{
 useCallback:fn=>fn,broadcastEnabled:true,broadcastTargets:targets,settings:{locale:'en'},backlogText:()=> 'Delivery failed',
 setBroadcastSending:value=>sending.push(value),window:{canvasTTY:{backlog:{broadcast:send}}},Set,Error});return{callback,sending};}
async function fixture(t,send){
 const oldWindow=globalThis.window,oldDocument=globalThis.document;
 globalThis.window={setTimeout,clearTimeout,canvasTTY:{backlog:{workspacePresets:async()=>[]}}};globalThis.document={body:{nodeType:1}};
 tools.__reset();t.after(()=>{tools.__unmount();globalThis.window=oldWindow;globalThis.document=oldDocument;});
 const upstream=canvas(send),props={api:{workspacePresets:async()=>[]},settings:{locale:'en'},locale:'en',sessions:targets,onClose(){},broadcastEnabled:true,
 broadcastTargetCount:2,broadcastSending:false,onSetBroadcastEnabled(){},onSendBroadcast:upstream.callback};
 let tree;const render=()=>{tools.__flush();tree=tools.__render(tools.WorkspaceBacklogTools,props);};
 const textarea=()=>findAll(tree,node=>node.type==='textarea')[0];
 render();await tick();render();
 return{render,tree:()=>tree,textarea,draft:text=>{textarea().props.onChange({currentTarget:{value:text}});render();},
 send:()=>{const button=findAll(tree,node=>node.type==='button'&&node.props.children==='Send to all')[0];
  assert.ok(button,'broadcast button');button.props.onClick();},...upstream};
}
for(const scenario of ['partial','all skipped','rejected'])test(`broadcast ${scenario} retains draft and reports failed recipients without resending`,async t=>{
 const calls=[],work=deferred();const f=await fixture(t,(ids,text)=>{calls.push({ids:Array.from(ids),text});return work.promise;});
 f.draft('review this');f.send();
 if(scenario==='rejected')work.reject(new Error('IPC disconnected'));else work.resolve({delivered:scenario==='partial'?['one']:[],skipped:scenario==='partial'?['two']:['one','two']});
 await tick();f.render();assert.equal(f.textarea().props.value,'review this');assert.equal(calls.length,1);
 const rendered=JSON.stringify(f.tree());assert.match(rendered,scenario==='rejected'?/IPC disconnected/:/Second worker/);
 if(scenario==='all skipped')assert.match(rendered,/First worker/);assert.deepEqual(f.sending,[true,false]);
});
for(const edit of [false,true])test(`successful broadcast clears only unchanged draft (edited=${edit})`,async t=>{
 const work=deferred();let calls=0;const f=await fixture(t,()=>{calls++;return work.promise;});f.draft('submitted');f.send();if(edit)f.draft('new draft');
 work.resolve({delivered:['one','two'],skipped:[]});await tick();f.render();assert.equal(f.textarea().props.value,edit?'new draft':'');assert.equal(calls,1);assert.deepEqual(f.sending,[true,false]);
});
