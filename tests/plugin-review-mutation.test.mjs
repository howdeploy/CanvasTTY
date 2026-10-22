import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {normalizeCardActionInput,normalizeCardReview} from '../src/main/services/PluginChangeReviews.ts';
import {PluginCards} from '../src/main/services/PluginCards.ts';
import {importWithFakeReact,findAll,tick} from './helpers/fake-react.mjs';

const dialog=await importWithFakeReact('src/renderer/src/features/terminal/PluginChangesReviewDialog.tsx','PluginChangesReviewDialog');
const file=path=>({path,diff:'+change',page:0});
const ROW_HEIGHT=42;

/** Renders the dialog with fake React; `click(label)` presses a button or overflow menu row by its visible text. */
function harness(t,props){
 const oldWindow=globalThis.window;
 globalThis.window={setTimeout,clearTimeout,requestAnimationFrame:()=>0,canvasTTY:{terminal:{onSession:()=>()=>{},list:async()=>[]}}};
 t.after(()=>{dialog.__unmount();globalThis.window=oldWindow;});dialog.__reset();
 let tree;
 const render=()=>{dialog.__flush();tree=dialog.__render(dialog.PluginChangesReviewDialog,props);return tree;};
 const byLabel=label=>findAll(tree,node=>node.props?.children===label&&typeof node.props.onClick==='function')[0];
 const click=label=>{const target=byLabel(label);assert.ok(target,label);assert.equal(Boolean(target.props.disabled),false,label);target.props.onClick({currentTarget:{}});render();};
 const openMenu=()=>{const more=findAll(tree,node=>node.type==='button'&&node.props['aria-haspopup']==='menu')[0];assert.ok(more,'overflow menu');more.props.onClick();render();};
 return {render,click,openMenu,byLabel,tree:()=>tree};
}

for(const [action,viaMenu] of [['Accept selected',false],['Reject subtask',false],['Accept every file of this subtask',true]])test(`mutation replaces the remaining review scope: ${action}`,async t=>{
 const calls=[],remaining={acceptActionId:'accept',rejectActionId:'reject',groups:[{sessionId:'second',title:'Second',files:[file('remaining.txt')]}]};
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',rejectActionId:'reject',groups:[
  {sessionId:'first',title:'First',files:[file('removed.txt')]},{sessionId:'second',title:'Second',files:[file('remaining.txt')]}]},
  invokeAction:async(id,input)=>{calls.push({id,input});return {review:remaining};},onReviewChange:review=>{props.review=review;},onActionResult(){},onClose(){}};
 const ui=harness(t,props);
 ui.render();await tick();ui.render();
 if(viaMenu)ui.openMenu();
 ui.click(action);
 assert.equal(calls.length,0,'nothing is sent before the explicit confirmation');
 ui.click('Confirm');await tick();ui.render();ui.render();
 assert.equal(props.review,remaining,'mutation payload replaces cached groups');assert.equal(ui.byLabel('Confirm'),undefined);
 assert.ok(!JSON.stringify(ui.tree()).includes('removed.txt'));
 ui.click('Accept selected');ui.click('Confirm');await tick();ui.render();
 assert.deepEqual(calls[1],{id:'accept',input:{agentSessionId:'second',files:['remaining.txt']}});
});

test('Escape steps back: the overflow menu, then the confirmation, then the dialog; a running mutation keeps it open',async t=>{
 let closed=0,release;
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',rejectActionId:'reject',groups:[{sessionId:'w',title:'W',files:[file('a.txt')]}]},
  invokeAction:(id)=>id==='review'?Promise.resolve({tone:'info'}):new Promise(resolve=>{release=resolve;}),onReviewChange(){},onActionResult(){},onClose(){closed++;}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 const cancel=()=>{ui.tree().props.onCancel({preventDefault(){}});ui.render();};
 ui.openMenu();assert.ok(findAll(ui.tree(),node=>node.props?.role==='menu').length);
 cancel();assert.equal(findAll(ui.tree(),node=>node.props?.role==='menu').length,0);assert.equal(closed,0);
 ui.click('Reject subtask');cancel();assert.equal(ui.byLabel('Confirm'),undefined);assert.equal(closed,0);
 ui.click('Reject subtask');ui.click('Confirm');cancel();assert.equal(closed,0,'a running accept/reject cannot be dismissed');
 release({tone:'info'});await tick();ui.render();cancel();assert.equal(closed,1);
});

test('a native close (Chromium\'s second Escape) while an accept or reject runs shows the dialog again; otherwise it closes it',async t=>{
 let closed=0,release;
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',rejectActionId:'reject',groups:[{sessionId:'w',title:'W',files:[file('a.txt')]}]},
  invokeAction:(id)=>id==='review'?Promise.resolve({tone:'info'}):new Promise(resolve=>{release=resolve;}),onReviewChange(){},onActionResult(){},onClose(){closed++;}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 let shown=0;const nativeClose=()=>{ui.tree().props.onClose({currentTarget:{showModal(){shown++;}}});ui.render();};
 ui.click('Reject subtask');ui.click('Confirm');
 nativeClose();assert.equal(shown,1,'shown again while the reject runs');assert.equal(closed,0);
 release({tone:'info'});await tick();ui.render();
 nativeClose();assert.equal(closed,1,'App learns that the dialog is gone');assert.equal(shown,1);
});

test('a reject confirmation is a danger action; the dialog localizes its texts (ru)',async t=>{
 const props={cardSessionId:'root',cardTitle:'/project',reviewActionId:'review',locale:'ru',review:{title:'',rejectActionId:'reject',groups:[{sessionId:'w',title:'W',files:[file('a.txt')]}]},
  invokeAction:async()=>({tone:'info'}),onReviewChange(){},onActionResult(){},onClose(){}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 const json=JSON.stringify(ui.tree());
 assert.match(json,/Изменения задачи/u);assert.match(json,/\/project/u);assert.doesNotMatch(json,/Task changes|Reject subtask/u);
 ui.click('Отклонить подзадачу');
 const confirm=ui.byLabel('Подтвердить');assert.equal(confirm.props.className,'card-dialog__danger');
});

const supervisorSource=await readFile(new URL('../src/main/services/PluginServiceSupervisor.ts',import.meta.url),'utf8');
const serializeFrame=supervisorSource.match(/frame = (JSON\.stringify\(\{ jsonrpc: "2.0", id, method, params: params === undefined \? null : params \}\));/u)?.[1];
assert.ok(serializeFrame,'test uses the actual outbound plugin frame serialization');
const frameLimit=Number(supervisorSource.match(/const PLUGIN_SERVICE_MAX_FRAME_BYTES = (\d+) \* (\d+)/u)?.[1])*Number(supervisorSource.match(/const PLUGIN_SERVICE_MAX_FRAME_BYTES = (\d+) \* (\d+)/u)?.[2]);
for(const [action,viaMenu,style,count,conflicts] of [
 ['Accept selected',false,'ascii',400,true],
 ['Accept every file of this subtask',true,'escaped',350,true],
 ['Accept the whole task result',true,'unicode',400,false]
])test(`large normalized review round-trips the real dialog ${action} with ${count} ${style} paths`,{timeout:20000},async t=>{
 const page={text:'',startLine:0,totalLines:0,hasMore:false};
 const files=Array.from({length:count},(_,i)=>({path:`${i}/`+(style==='ascii'?'a'.repeat(980):style==='escaped'?'"\\'.repeat(240):'界'.repeat(350)),diff:'+x',page:0,...(conflicts?{conflict:{current:page,agent:page}}:{})}));
 const review=normalizeCardReview({title:'Large review',acceptActionId:'accept',groups:[{sessionId:'worker',title:'Worker',files}]},text=>text,new Set(['accept']));
 assert.ok(Buffer.byteLength(JSON.stringify(review))>256*1024);assert.ok(Buffer.byteLength(JSON.stringify(review))<=512*1024);
 const calls=[],trustedSession={id:'root',provider:'codex',profile:'normal',role:'orchestrator',title:'Project review',cwd:'/project',position:{x:0,y:0},size:{width:800,height:600},status:'idle',startedAt:1,exitCode:null};
 const cards=new PluginCards({locale:()=>'en',providers:()=>[{pluginId:'fixture',pluginName:'Fixture',serviceId:'review',actions:[{id:'accept',title:'Accept'}]}],trustedPlugins:()=>new Set(['fixture']),session:()=>trustedSession,redact:text=>text,changed(){},call:async(_plugin,_service,method,params)=>{
  const frame=runInNewContext(serializeFrame,{id:Number.MAX_SAFE_INTEGER,method,params});assert.ok(Buffer.byteLength(frame)<frameLimit,'the complete real invoke envelope fits the unchanged transport bound');calls.push(params);return{tone:'info'};
 }});
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review,invokeAction:(action,input)=>cards.invoke('fixture',action,'root',input),onReviewChange(){},onActionResult(){},onClose(){}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 if(conflicts)for(let i=0;i<count;i++){
  findAll(ui.tree(),node=>node.type==='ol')[0].props.onScroll({currentTarget:{scrollTop:i*ROW_HEIGHT}});ui.render();
  const open=findAll(ui.tree(),node=>node.type==='button'&&node.props.title===files[i].path)[0];assert.ok(open);open.props.onClick();ui.render();
  const agent=findAll(ui.tree(),node=>node.type==='button'&&node.props.children==='Agent version')[0];assert.ok(agent);agent.props.onClick();ui.render();
 }
 if(viaMenu)ui.openMenu();
 ui.click(action);ui.click('Confirm');await tick();ui.render();assert.equal(calls.length,1);
 const input=calls[0].input;assert.equal(input.files.length,count);assert.deepEqual(normalizeCardActionInput(input),input);assert.ok(Buffer.byteLength(JSON.stringify(input))>256*1024);
 if(conflicts){assert.equal(Object.keys(input.resolutions).length,count);assert.ok(Object.values(input.resolutions).every(value=>value==='agent'));}
 else assert.equal(input.resolutions,undefined);
});

// F8: a confirmation is for the files and versions of the moment it opened.
const conflictPage={text:'x',startLine:1,totalLines:1,hasMore:false};
const conflicted=path=>({...file(path),conflict:{current:conflictPage,agent:conflictPage}});
const checkboxFor=(tree,path)=>findAll(tree,node=>node.type==='input'&&node.props['aria-label']===path)[0];
const groupButton=(tree,title)=>findAll(tree,node=>node.type==='button'&&node.props['aria-pressed']!==undefined&&String(node.props.children?.[0]??node.props.children)===title)[0];

test('while a confirmation is open the group, the selection and the versions are locked, and confirm sends what was confirmed',async t=>{
 const calls=[];
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',rejectActionId:'reject',groups:[
  {sessionId:'first',title:'First',files:[file('one.txt'),file('two.txt')]},{sessionId:'second',title:'Second',files:[file('other.txt')]}]},
  invokeAction:async(id,input)=>{calls.push({id,input});return{tone:'info'};},onReviewChange(){},onActionResult(){},onClose(){}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 checkboxFor(ui.tree(),'two.txt').props.onChange({currentTarget:{checked:false}});ui.render();
 ui.click('Accept selected');
 assert.equal(groupButton(ui.tree(),'Second').props.disabled,true,'switching the group is locked');
 assert.equal(checkboxFor(ui.tree(),'two.txt').props.disabled,true,'the selection is locked');
 // Even a change that slips through (a stale handler) does not alter what is sent.
 checkboxFor(ui.tree(),'two.txt').props.onChange({currentTarget:{checked:true}});ui.render();
 ui.click('Confirm');await tick();ui.render();
 assert.deepEqual(calls.filter(call=>call.id==='accept'),[{id:'accept',input:{agentSessionId:'first',files:['one.txt']}}]);
});

test('an unresolved conflict cannot join a pending confirmation, and a review that changed underneath is confirmed again',async t=>{
 const calls=[];
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',groups:[
  {sessionId:'w',title:'W',files:[file('plain.txt'),conflicted('clash.txt')]}]},
  invokeAction:async(id,input)=>{calls.push({id,input});return{tone:'info'};},onReviewChange(){},onActionResult(){},onClose(){}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 checkboxFor(ui.tree(),'clash.txt').props.onChange({currentTarget:{checked:false}});ui.render();
 ui.click('Accept selected');
 assert.equal(checkboxFor(ui.tree(),'clash.txt').props.disabled,true,'the unresolved conflict cannot be checked now');
 checkboxFor(ui.tree(),'clash.txt').props.onChange({currentTarget:{checked:true}});ui.render();
 ui.click('Confirm');await tick();ui.render();
 assert.deepEqual(calls.filter(call=>call.id==='accept').map(call=>call.input),[{agentSessionId:'w',files:['plain.txt']}],'the conflict is not sent unresolved');

 // The plugin's review changes while a confirmation is open: the confirmed file is gone, nothing is sent.
 props.review={acceptActionId:'accept',groups:[{sessionId:'w',title:'W',files:[file('plain.txt'),file('new.txt')]}]};ui.render();await tick();ui.render();
 ui.click('Accept selected');
 props.review={acceptActionId:'accept',groups:[{sessionId:'w',title:'W',files:[file('new.txt')]}]};ui.render();
 ui.click('Confirm');await tick();ui.render();
 assert.equal(calls.filter(call=>call.id==='accept').length,1,'a confirmation for files that are gone is not sent');
 assert.match(JSON.stringify(ui.tree()),/check the selection and confirm again/u);
});

test('plugin call failures are localized (details only in the log) and Git statuses get labels',async t=>{
 const logged=[];const oldError=console.error;console.error=(...args)=>logged.push(args);t.after(()=>{console.error=oldError;});
 const props={cardSessionId:'root',reviewActionId:'review',locale:'ru',review:{acceptActionId:'accept',groups:[{sessionId:'w',title:'W',files:[
  {...file('a.txt'),status:'A'},{...file('m.txt'),status:'modified'},{...file('x.txt'),status:'copied'}]}]},
  invokeAction:async()=>{throw new Error("Error invoking remote method 'plugins:invoke-card-action': secret detail");},onReviewChange(){},onActionResult(){},onClose(){}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 findAll(ui.tree(),node=>node.props?.className==='card-dialog__secondary'&&node.props.children==='Обновить')[0]?.props.onClick();
 ui.click('Принять выбранные');ui.click('Подтвердить');await tick();ui.render();
 const json=JSON.stringify(ui.tree());
 assert.match(json,/Не удалось связаться с плагином/u);assert.doesNotMatch(json,/secret detail|invoke-card-action/u);
 assert.ok(logged.some(args=>String(args[1]).includes('secret detail')),'the details are logged');
 const labels=findAll(ui.tree(),node=>node.type==='small').map(node=>node.props.children);
 assert.deepEqual(labels,['добавлен','изменён','copied']);
});

test('the overflow menu moves focus between enabled rows with Arrow Up/Down',async t=>{
 const rows=['a','b','c'].map(id=>{const row={id};row.focus=()=>{globalThis.document.activeElement=row;};return row;});
 const oldDocument=globalThis.document;globalThis.document={activeElement:null};t.after(()=>{globalThis.document=oldDocument;});
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',rejectActionId:'reject',groups:[{sessionId:'w',title:'W',files:[file('a.txt')]}]},
  invokeAction:async()=>({tone:'info'}),onReviewChange(){},onActionResult(){},onClose(){}};
 const ui=harness(t,props);ui.render();await tick();ui.render();ui.openMenu();
 const menu=findAll(ui.tree(),node=>node.props?.role==='menu')[0];
 const element={querySelectorAll:selector=>{assert.match(selector,/:not\(:disabled\)/u);return rows;},contains:node=>rows.includes(node)};
 menu.props.ref(element);assert.equal(globalThis.document.activeElement,rows[0],'the first enabled row takes focus');
 const key=k=>menu.props.onKeyDown({key:k,currentTarget:element,preventDefault(){}});
 key('ArrowDown');assert.equal(globalThis.document.activeElement,rows[1]);
 key('ArrowUp');key('ArrowUp');assert.equal(globalThis.document.activeElement,rows[2],'wraps around');
});

test('Accept selected is disabled while no file is selected and enabled once one is',async t=>{
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',rejectActionId:'reject',groups:[
  {sessionId:'w',title:'W',files:[file('a.txt'),file('b.txt')]}]},
  invokeAction:async()=>({tone:'info'}),onReviewChange(){},onActionResult(){},onClose(){}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 for(const path of ['a.txt','b.txt'])if(checkboxFor(ui.tree(),path).props.checked)checkboxFor(ui.tree(),path).props.onChange({currentTarget:{checked:false}});
 ui.render();
 assert.match(JSON.stringify(findAll(ui.tree(),node=>node.props?.className==='card-dialog__muted').map(node=>node.props.children)),/0/u);
 assert.equal(ui.byLabel('Accept selected').props.disabled,true,'0 files selected');
 checkboxFor(ui.tree(),'a.txt').props.onChange({currentTarget:{checked:true}});ui.render();
 assert.equal(ui.byLabel('Accept selected').props.disabled,false,'one file selected');
});

test('an active group: nothing is preselected, accepting all of its files and rejecting it are disabled, a part of its files can be accepted',async t=>{
 const calls=[];
 const props={cardSessionId:'root',reviewActionId:'review',locale:'en',review:{acceptActionId:'accept',rejectActionId:'reject',groups:[
  {sessionId:'w',title:'W',active:true,error:'This terminal is still running',files:[file('a.txt'),file('b.txt')]}]},
  invokeAction:async(id,input)=>{calls.push({id,input});return {tone:'info'};},onReviewChange(){},onActionResult(){},onClose(){}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 assert.equal(checkboxFor(ui.tree(),'a.txt').props.checked,false,'nothing is preselected in an active group');
 assert.equal(checkboxFor(ui.tree(),'b.txt').props.checked,false);
 assert.equal(ui.byLabel('Accept selected').props.disabled,true,'nothing selected yet');
 const notice=findAll(ui.tree(),node=>node.type==='p'&&node.props?.children==='This terminal is still running')[0];
 assert.equal(notice.props.role,'status','an informational notice, not an error alert');
 assert.ok(!notice.props.className.includes('card-dialog__error'));
 const selectAll=findAll(ui.tree(),node=>node.type==='input'&&node.props?.type==='checkbox'&&node.props['aria-label']===undefined)[0];
 selectAll.props.onChange();ui.render();
 const accept=ui.byLabel('Accept selected');assert.equal(accept.props.disabled,true,'every file selected is a full accept');
 assert.match(accept.props.title,/Clear some files/u);
 const reject=ui.byLabel('Reject subtask');assert.equal(reject.props.disabled,true);assert.match(reject.props.title,/once it finishes/u);
 ui.openMenu();
 for(const row of findAll(ui.tree(),node=>node.props?.role==='menuitem'))assert.equal(Boolean(row.props.disabled),true,'no whole-group or task-wide action');
 checkboxFor(ui.tree(),'b.txt').props.onChange({currentTarget:{checked:false}});ui.render();
 ui.click('Accept selected');ui.click('Confirm');await tick();ui.render();
 assert.deepEqual(calls.at(-1),{id:'accept',input:{agentSessionId:'w',files:['a.txt']}});
});

test('an active group: the overflow menu rows it disables say why (en and ru)',async t=>{
 for(const [locale,reason] of [['en',/still working/u],['ru',/ещё работает/u]]){
  const props={cardSessionId:'root',reviewActionId:'review',locale,review:{acceptActionId:'accept',rejectActionId:'reject',groups:[
   {sessionId:'w',title:'W',active:true,files:[file('a.txt')]},{sessionId:'x',title:'X',files:[file('b.txt')]}]},
   invokeAction:async()=>({tone:'info'}),onReviewChange(){},onActionResult(){},onClose(){}};
  const ui=harness(t,props);ui.render();await tick();ui.render();
  ui.openMenu();
  const rows=findAll(ui.tree(),node=>node.props?.role==='menuitem');
  assert.equal(rows.length,3);
  for(const row of rows){assert.equal(Boolean(row.props.disabled),true);assert.match(String(row.props.title),reason,`${locale}: ${JSON.stringify(row.props.children)}`);}
 }
});

test('the subtitle is left out when the review title already names the card',async t=>{
 const props={cardSessionId:'root',cardTitle:'Terminal · project',reviewActionId:'review',locale:'en',review:{title:'Changes from Terminal · project',groups:[{sessionId:'w',title:'W',files:[file('a.txt')]}]},
  invokeAction:async()=>({tone:'info'}),onReviewChange(){},onActionResult(){},onClose(){}};
 const ui=harness(t,props);ui.render();await tick();ui.render();
 assert.equal(JSON.stringify(ui.tree()).split('Terminal · project').length-1,1,'the card name shows once');
 // A plugin that names the card kind in the app's language: the English default title is not repeated either.
 const ru=harness(t,{...props,locale:'ru',review:{...props.review,title:'Изменения: Терминал · project'}});ru.render();await tick();ru.render();
 assert.equal(JSON.stringify(ru.tree()).includes('Terminal · project'),false,'no English duplicate under a localized title');
 const other=harness(t,{...props,cardTitle:'my notes',review:{...props.review,title:'Changes from Terminal · project'}});other.render();await tick();other.render();
 assert.equal(JSON.stringify(other.tree()).includes('my notes'),true,'a title that names another card keeps the subtitle');
});
