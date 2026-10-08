import assert from 'node:assert/strict';
import test from 'node:test';
import {importWithFakeReact,findAll,tick} from './helpers/fake-react.mjs';
import {MAX_CONTEXT_PREVIEW_CHARS as MAX} from '../src/renderer/src/features/workspace/workspaceContextDrop.ts';
const mod=await importWithFakeReact('src/renderer/src/features/workspace/WorkspaceContextPreview.tsx','WorkspaceContextPreview');
function fixture(t,text){mod.__reset();t.after(()=>mod.__unmount());const sent=[];const props={preview:{sessionId:'one',text,paths:[],outsideProject:[],truncated:false},locale:'en',onConfirm:async value=>sent.push(value),onCancel(){}};let tree;
 const render=()=>{mod.__flush();tree=mod.__render(mod.WorkspaceContextPreview,props);};render();
 const editor=()=>findAll(tree,n=>n.type==='textarea')[0],confirm=()=>findAll(tree,n=>n.props.className==='workspace-context-preview__send')[0];
 return{sent,render,editor,confirm,tree:()=>tree,edit:value=>{editor().props.onChange({currentTarget:{value}});render();}};
}
test('context editor accepts exact limit but visibly rejects oversized initial/programmatic/IME text until edited back',async t=>{
 const f=fixture(t,'x'.repeat(MAX+1));assert.equal(f.editor().props.maxLength,MAX);assert.equal(f.confirm().props.disabled,true);assert.match(JSON.stringify(f.tree()),/Shorten the text to 16000/);
 f.confirm().props.onClick();await tick();assert.deepEqual(f.sent,[]);assert.equal(f.editor().props.value.length,MAX+1,'no silent truncation');
 f.edit('界'.repeat(MAX));assert.equal(f.confirm().props.disabled,false);f.confirm().props.onClick();await tick();f.render();assert.deepEqual(f.sent,['界'.repeat(MAX)]);
 // IME and programmatic change events may exceed maxLength; the confirm path still refuses them.
 f.edit('界'.repeat(MAX)+'語');f.confirm().props.onClick();await tick();assert.equal(f.sent.length,1);assert.equal(f.editor().props['aria-invalid'],true);
 f.edit('shortened');assert.equal(f.confirm().props.disabled,false);assert.doesNotMatch(JSON.stringify(f.tree()),/Shorten the text/);f.confirm().props.onClick();await tick();assert.deepEqual(f.sent,['界'.repeat(MAX),'shortened']);
});
