import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
const source=await readFile(new URL('../src/renderer/src/features/terminal/TerminalCard.tsx',import.meta.url),'utf8');
const handlers=source.slice(source.indexOf('  const runSearch ='),source.indexOf('  const toggleSearch ='));
const results=source.slice(source.indexOf('    const searchResults ='),source.indexOf('\n    return () => {',source.indexOf('    const searchResults =')));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(){
 const requests=[],finds=[],state={history:null,counts:null},epoch={current:0},active={current:false};let effect,cleanup,resultListener;
 const addon={clearDecorations(){resultListener?.({resultIndex:0,resultCount:2});},findNext(query){finds.push(query);resultListener?.({resultIndex:0,resultCount:2});},findPrevious(){},onDidChangeResults(fn){resultListener=fn;}};
 const context={Promise,Error,historicalRequestEpoch:epoch,historicalSearchActive:active,searchQueryRef:{current:''},
  searchAddonRef:{current:addon},searchAddon:addon,terminalRef:{current:{focus(){}}},SEARCH_DECORATIONS:{},renaming:false,summaryMode:false,session:{id:'first'},externalSearchRequest:null,
  setHistoricalOutput:value=>{state.history=value;},setSearchOpen(){},setSearchQuery(){},setSearchMatches:value=>{state.counts=value;},
  useEffect:fn=>{effect=fn;},backlogTerminalApi:()=>({readOutputContext:(id,offset)=>{const work=deferred();requests.push({id,offset,...work});return work.promise;}})};
 runInNewContext(stripTypeScriptTypes(results),context);
 const render=(request,id='first',summaryMode=false)=>{cleanup?.();Object.assign(context,{externalSearchRequest:request,session:{id},summaryMode});
  const api=runInNewContext(stripTypeScriptTypes(`(() => { ${handlers}\nreturn {runSearch,closeSearch}; })()`),context);cleanup=effect();return api;};
 return{state,requests,finds,render,results:()=>resultListener({resultIndex:1,resultCount:2}),unmount:()=>cleanup?.()};
}
const request=(requestId=1,offset=420)=>({requestId,offset,line:73,query:'repeated text'});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('selected historical offset opens directly despite repeated live matches',async()=>{
 const f=fixture();f.render(request());assert.equal(f.requests.length,1);assert.equal(f.requests[0].offset,420);assert.equal(f.requests[0].id,'first');
 assert.deepEqual(f.finds,[],'external search does not choose a different live occurrence');f.results();assert.equal(f.state.history.loading,true);
 f.requests[0].resolve({text:'older repeated text',firstLine:70,targetLine:73});await settle();f.results();
 assert.equal(f.state.history.text,'older repeated text');assert.equal(f.state.history.targetLine,73);
});
for(const stop of ['close','local','new request','new session','summary','unmount'])test(`late historical results cannot reopen after ${stop}`,async()=>{
 const f=fixture();const api=f.render(request());const old=f.requests[0];
 if(stop==='close')api.closeSearch();else if(stop==='local')api.runSearch('local','next',true);
 else if(stop==='new request')f.render(request(2,800));else if(stop==='new session')f.render(null,'second');
 else if(stop==='summary')f.render(request(),'first',true);else f.unmount();
 const before=f.state.history;old.resolve({text:'stale old context',firstLine:1,targetLine:1});await settle();assert.equal(f.state.history,before);
 if(stop==='local'){assert.deepEqual(f.finds,['local']);assert.equal(f.state.counts.total,2);}
 if(stop==='new request'){f.requests[1].resolve({text:'selected new context',firstLine:90,targetLine:91});await settle();assert.equal(f.state.history.text,'selected new context');}
});
test('late history rejection does not replace a later selection',async()=>{
 const f=fixture();f.render(request());f.render(request(2,800));f.requests[0].reject(new Error('old failure'));await settle();assert.equal(f.state.history.error,undefined);
 f.requests[1].reject(new Error('current failure'));await settle();assert.equal(f.state.history.error,'current failure');
});
