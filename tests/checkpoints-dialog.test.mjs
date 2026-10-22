// The Rollback points dialog: lists and previews, restores only after its inline confirmation, localizes refusals.
import assert from 'node:assert/strict';
import test from 'node:test';
import {importWithFakeReact,findAll,tick} from './helpers/fake-react.mjs';

const dialog=await importWithFakeReact('src/renderer/src/features/terminal/CheckpointsDialog.tsx','CheckpointsDialog, diffLineKinds');
const entry=(id,at,kind='before-turn')=>({id:`refs/canvastty/card/${at}-${id.padStart(36,'0')}`,at,kind});

function harness(t,api,props={}){
 const oldWindow=globalThis.window;
 globalThis.window={canvasTTY:{terminal:api}};
 t.after(()=>{dialog.__unmount();globalThis.window=oldWindow;});dialog.__reset();
 let closed=0,tree;
 const all={sessionId:'card',cardTitle:'/project',locale:'en',onClose(){closed++;},...props};
 const render=()=>{dialog.__flush();tree=dialog.__render(dialog.CheckpointsDialog,all);return tree;};
 const settle=async()=>{for(let i=0;i<4;i++){render();await tick();}render();};
 const byLabel=label=>findAll(tree,node=>node.props?.children===label&&typeof node.props.onClick==='function')[0];
 const click=label=>{const target=byLabel(label);assert.ok(target,label);assert.equal(Boolean(target.props.disabled),false,label);target.props.onClick();render();};
 return{render,settle,click,byLabel,tree:()=>tree,closed:()=>closed};
}

test('lists rollback points, previews the selected one and restores only after the confirmation',async t=>{
 const calls=[];const points=[entry('2',2_000),entry('1',1_000,'before-restore')];
 const api={checkpoints:async id=>{calls.push(['list',id]);return{ok:true,checkpoints:points};},
  previewCheckpoint:async(id,point)=>{calls.push(['preview',point]);return{ok:true,text:'-old\n+new',changedFiles:['file.txt'],truncated:false};},
  restoreCheckpoint:async(id,point)=>{calls.push(['restore',point]);return{ok:true};}};
 const ui=harness(t,api);await ui.settle();
 const json=JSON.stringify(ui.tree());
 assert.match(json,/Before an agent turn/u);assert.match(json,/Before a restore/u);assert.match(json,/file\.txt/u);assert.match(json,/\/project/u);
 assert.deepEqual(calls.slice(0,2),[['list','card'],['preview',points[0].id]]);
 const lineClass=line=>findAll(ui.tree(),node=>Array.isArray(node.props?.children)&&node.props.children[0]===line)[0]?.props.className;
 assert.equal(lineClass('-old'),'checkpoints-dialog__line--del');assert.equal(lineClass('+new'),'checkpoints-dialog__line--add');
 const message=()=>findAll(ui.tree(),node=>String(node.props?.className??'').startsWith('checkpoints-dialog__message'));
 assert.equal(message().length,1,'the outcome line is reserved in the footer before anything happens');
 ui.click('Restore');
 assert.equal(calls.filter(([kind])=>kind==='restore').length,0,'nothing is restored before the confirmation');
 const confirm=findAll(ui.tree(),node=>node.props?.className==='card-dialog__danger')[0];assert.ok(confirm,'a danger confirmation');
 confirm.props.onClick();await ui.settle();
 assert.deepEqual(calls.find(([kind])=>kind==='restore'),['restore',points[0].id]);
 assert.match(JSON.stringify(ui.tree()),/Files restored/u);
 assert.equal(message().length,1);assert.match(message()[0].props.className,/checkpoints-dialog__success/u);
});

test('Escape steps back from the confirmation before it closes the dialog',async t=>{
 const api={checkpoints:async()=>({ok:true,checkpoints:[entry('1',1_000)]}),previewCheckpoint:async()=>({ok:true,text:'',changedFiles:[],truncated:false}),restoreCheckpoint:async()=>({ok:true})};
 const ui=harness(t,api);await ui.settle();
 const cancel=()=>{ui.tree().props.onCancel({preventDefault(){}});ui.render();};
 ui.click('Restore');cancel();assert.equal(ui.closed(),0);assert.equal(findAll(ui.tree(),node=>node.props?.role==='alertdialog').length,0);
 cancel();assert.equal(ui.closed(),1);
});

test('a native close (Chromium\'s second Escape) during a restore shows the dialog again; otherwise it closes it',async t=>{
 let release;
 const api={checkpoints:async()=>({ok:true,checkpoints:[entry('1',1_000)]}),previewCheckpoint:async()=>({ok:true,text:'',changedFiles:[],truncated:false}),
  restoreCheckpoint:()=>new Promise(resolve=>{release=resolve;})};
 const ui=harness(t,api);await ui.settle();
 let shown=0;const nativeClose=()=>{ui.tree().props.onClose({currentTarget:{showModal(){shown++;}}});ui.render();};
 ui.click('Restore');findAll(ui.tree(),node=>node.props?.className==='card-dialog__danger')[0].props.onClick();ui.render();
 ui.tree().props.onCancel({preventDefault(){}});ui.render();assert.equal(ui.closed(),0);
 nativeClose();assert.equal(shown,1,'shown again while files are restored');assert.equal(ui.closed(),0);
 release({ok:true});await ui.settle();
 nativeClose();assert.equal(ui.closed(),1,'App learns that the dialog is gone');assert.equal(shown,1);
});

test('a refused restore shows the localized reason for its code (ru), and an empty list explains when points are made',async t=>{
 const api={checkpoints:async()=>({ok:true,checkpoints:[entry('1',1_000)]}),previewCheckpoint:async()=>({ok:true,text:'',changedFiles:[],truncated:true}),
  restoreCheckpoint:async()=>({ok:false,code:'agent-running'})};
 const ui=harness(t,api,{locale:'ru'});await ui.settle();
 assert.match(JSON.stringify(ui.tree()),/Показ сокращён/u);
 ui.click('Восстановить');findAll(ui.tree(),node=>node.props?.className==='card-dialog__danger')[0].props.onClick();await ui.settle();
 const json=JSON.stringify(ui.tree());assert.match(json,/завершите все агенты/u);assert.doesNotMatch(json,/agent-running|Close or exit/u);
 const empty=harness(t,{checkpoints:async()=>({ok:true,checkpoints:[]}),previewCheckpoint:async()=>assert.fail(),restoreCheckpoint:async()=>assert.fail()});await empty.settle();
 assert.match(JSON.stringify(empty.tree()),/No rollback points yet/u);
 const notGit=harness(t,{checkpoints:async()=>({ok:false,code:'not-git-root'}),previewCheckpoint:async()=>assert.fail(),restoreCheckpoint:async()=>assert.fail()});await notGit.settle();
 assert.match(JSON.stringify(notGit.tree()),/top of a Git project/u);
});

test('after a restore the preview is read again, and a failed call shows the localized refusal with details only in the log',async t=>{
 const logged=[];const oldError=console.error;console.error=(...args)=>logged.push(args);t.after(()=>{console.error=oldError;});
 let previews=0,listed=0;const points=[entry('1',1_000)];
 const api={checkpoints:async()=>{listed++;return{ok:true,checkpoints:listed>1?[entry('2',2_000,'before-restore'),...points]:points};},
  previewCheckpoint:async()=>{previews++;return{ok:true,text:previews>1?'after':'before',changedFiles:[],truncated:false};},
  restoreCheckpoint:async()=>({ok:true})};
 const ui=harness(t,api);await ui.settle();
 assert.equal(previews,1);assert.match(JSON.stringify(ui.tree()),/"before"/u);
 ui.click('Restore');findAll(ui.tree(),node=>node.props?.className==='card-dialog__danger')[0].props.onClick();await ui.settle();
 assert.equal(previews,2,'the preview of the selected point is read again after the restore');
 assert.match(JSON.stringify(ui.tree()),/"after"/u);assert.match(JSON.stringify(ui.tree()),/Files restored/u);

 const broken=harness(t,{checkpoints:async()=>{throw new Error("Error invoking remote method 'terminal:checkpoints': internal detail");},
  previewCheckpoint:async()=>assert.fail(),restoreCheckpoint:async()=>assert.fail()},{locale:'ru'});await broken.settle();
 const json=JSON.stringify(broken.tree());assert.doesNotMatch(json,/internal detail|terminal:checkpoints/u);
 assert.ok(logged.some(args=>String(args[1]).includes('internal detail')),'the details are logged');
});

test('diff lines are colored by position (a removed "--" line is removed, the header block is meta) and a long preview renders in steps',async t=>{
 assert.deepEqual(dialog.diffLineKinds(['diff --git a/x b/x','index 1..2 100644','--- a/x','+++ b/x','@@ -1,2 +1,2 @@','--x','++y',' same','\\ No newline at end of file']),
  ['meta','meta','meta','meta','hunk','del','add',null,'meta']);
 const long=['diff --git a/x b/x','--- a/x','+++ b/x','@@ -1 +1 @@',...Array.from({length:2600},(_,index)=>`+line ${index}`)].join('\n');
 const api={checkpoints:async()=>({ok:true,checkpoints:[entry('1',1_000)]}),
  previewCheckpoint:async()=>({ok:true,text:`${long}\n+evil‮⁦name`,changedFiles:['a‮b.txt'],truncated:false}),restoreCheckpoint:async()=>({ok:true})};
 const ui=harness(t,api);await ui.settle();
 const lines=()=>findAll(ui.tree(),node=>node.type==='span'&&String(node.props?.className??'').startsWith('checkpoints-dialog__line')).length;
 assert.equal(lines(),2000,'the first 2000 lines are rendered');
 const json=JSON.stringify(ui.tree());assert.match(json,/What the restore does/u);assert.doesNotMatch(json,/\\u202e|‮/u);assert.match(json,/ab\.txt/u);
 ui.click('Show more (605 lines left)');assert.equal(lines(),2605);
 assert.doesNotMatch(JSON.stringify(ui.tree()),/[‮⁦]/u,'bidirectional controls are removed');
 assert.equal(findAll(ui.tree(),node=>String(node.props?.children).startsWith('Show more')).length,0);
});
