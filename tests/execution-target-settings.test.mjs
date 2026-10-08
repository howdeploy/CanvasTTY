import assert from 'node:assert/strict';
import test from 'node:test';
import {importWithFakeReact,findAll,tick} from './helpers/fake-react.mjs';
const mod=await importWithFakeReact('src/renderer/src/features/settings/ExecutionTargetSettings.tsx','ExecutionTargetSettings');
const deferred=()=>Promise.withResolvers();
function fixture(t){mod.__reset();const requests=[],saved=[];const previous=globalThis.window;
 globalThis.window={canvasTTY:{plugins:{executionAccountRoutes:()=>{const d=deferred();requests.push(d);return d.promise;}}}};t.after(()=>{mod.__unmount();globalThis.window=previous;});
 const props={settings:{},locale:'en',onChange:async patch=>saved.push(patch)};let tree;const render=()=>{mod.__flush();tree=mod.__render(mod.ExecutionTargetSettings,props);};render();render();
 const input=id=>findAll(tree,n=>n.props.id===id)[0];const select=value=>{findAll(tree,n=>typeof n.type==='function'&&n.type.name==='LaunchOptionsSection')[0].props.onChange({'canvastty-accounts':{account:value}});render();render();};
 const add=()=>findAll(tree,n=>n.type==='button'&&n.props.children==='Add destination')[0].props.onClick();
 input('execution-target-label').props.onChange({target:{value:'Destination'}});render();return{input,select,add,render,requests,saved,locale:value=>{props.locale=value;render();render();}};
}
for(const late of [false,true])test(`account to default clears derived fields and ignores obsolete route (late=${late})`,async t=>{
 const f=fixture(t);f.select('account');const response=[{accountId:'account',state:'ready',model:'account-model',endpoint:'host.example',kind:'ollama'}];
 if(!late){f.requests[0].resolve(response);await tick();f.render();assert.equal(f.input('execution-target-model').props.value,'account-model');}
 f.select('none');assert.equal(f.input('execution-target-model').props.value,'');
 if(late){f.requests[0].resolve(response);await tick();f.render();assert.equal(f.input('execution-target-model').props.value,'');}
 f.add();await tick();f.render();const target=f.saved[0].executionPolicy.targets[0];assert.equal(target.accountId,'default');for(const key of ['model','endpoint','accountKind','inferenceModel'])assert.equal(target[key],undefined);
 f.input('execution-target-model').props.onChange({target:{value:'manual-model'}});f.render();f.locale('ru');assert.equal(f.input('execution-target-model').props.value,'manual-model');f.locale('en');f.add();await tick();assert.equal(f.saved.at(-1).executionPolicy.targets[0].model,'manual-model');
});
