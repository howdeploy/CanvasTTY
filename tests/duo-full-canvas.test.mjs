import assert from 'node:assert/strict';
import test from 'node:test';
import {CanvasDuoService,parseDuoInvite} from '../src/main/services/CanvasDuoService.ts';
import {validSurfaceInputs,validSurfaceFrame} from '../src/shared/duoSurface.ts';
import {buildSync} from 'esbuild';
// The real port uses Electron types and TS parameter properties. Bundle it with
// the installed project compiler, then exercise it with fake Electron handles.
const surfaceModule=buildSync({entryPoints:[new URL('../src/main/services/DuoCanvasSurface.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'}).outputFiles[0].text;
const {DuoCanvasSurface}=await import('data:text/javascript;base64,'+Buffer.from(surfaceModule).toString('base64'));
function pair(t){
  const cards=[],actions=[];let controls=0,releases=0,gate=()=>true,pause;
  const surface={action:async(name,allowed)=>{assert.ok(allowed());actions.push(name);},capture:async()=>({id:'frame',at:Date.now(),viewport:{x:0,y:32,width:1280,height:720},image:'data:image/jpeg;base64,AA',layers:[]}),input:async(id,events,authorized)=>{gate=authorized;if(pause)await pause;assert.ok(authorized());controls+=events.length;},release:()=>{releases++;}};
  const terminals={listMetadata:()=>cards,create:r=>{const c={...r,id:'created-'+cards.length,title:'real host',size:{width:700,height:400},exitCode:null};cards.push(c);return c;},readBuffer:()=>{throw Error('Full canvas does not poll hidden terminal buffers');},geometry:()=>({cols:80,rows:24}),inputChecked:()=>true};
  const host=new CanvasDuoService(terminals,{surface});const guest=new CanvasDuoService({...terminals,listMetadata:()=>[],create:()=>{throw Error('must not create locally');}});
  t.after(()=>Promise.all([host.stop(),guest.stop()]));
  return {host,guest,cards,surface,actions,controls:()=>controls,releases:()=>releases,gate:()=>gate(),pause:p=>pause=p};
}
async function connect(p,manage=false){
  const started=await p.host.command({action:'host',transport:'lan',selected:[],controlled:[],fullCanvas:true,manage});
  const invite=parseDuoInvite(started.state.invites[0]);invite.host='127.0.0.1';
  return p.guest.command({action:'join',invite:'canvasduo://'+Buffer.from(JSON.stringify(invite)).toString('base64url')});
}
test('full Canvas starts without a terminal; all existing and newly created host terminals stay in that same workspace',async t=>{
 const p=pair(t);const joined=await connect(p,true);assert.equal(joined.state.fullCanvas,true);assert.equal(joined.snapshot.cards.length,0);
 p.cards.push({id:'host-created',title:'Host agent',provider:'codex',position:{x:10,y:20},size:{width:700,height:400},exitCode:null});
 const next=await p.guest.command({action:'snapshot'});assert.equal(next.snapshot.cards[0].id,'host-created');
 const created=await p.guest.command({action:'create',x:90,y:50});assert.equal(p.cards.length,2);assert.equal(created.snapshot.cards.length,2);
 await p.guest.command({action:'comment',cardId:'canvas',text:'Board note from guest'});
 assert.equal((await p.host.command({action:'snapshot'})).snapshot.comments[0].text,'Board note from guest');
});
test('read-only can see the live complete surface but cannot inject input; host grant and revoke are enforced at delivery',async t=>{
 const p=pair(t);await connect(p);
 assert.equal((await p.guest.command({action:'surface'})).snapshot.surface.id,'frame');
 const input={action:'surface-input',frameId:'frame',events:[{type:'text',text:'shared'}]};
 await assert.rejects(p.guest.command(input),/not granted/);assert.equal(p.controls(),0);
 await p.host.command({action:'select',selected:[],controlled:[],manage:true});await p.guest.command(input);assert.equal(p.controls(),1);assert.equal(p.gate(),true);
 await p.host.command({action:'select',selected:[],controlled:[],manage:false});assert.equal(p.gate(),false);assert.ok(p.releases()>0);
 await assert.rejects(p.guest.command(input),/not granted/);
});
test('revocation while input awaits delivery invalidates the authorization closure',async t=>{
 const p=pair(t);await connect(p,true);let resolve;p.pause(new Promise(r=>resolve=r));
 const sending=p.guest.command({action:'surface-input',frameId:'frame',events:[{type:'text',text:'must not arrive'}]});
 await new Promise(r=>setTimeout(r,30));await p.host.command({action:'select',selected:[],controlled:[],manage:false});resolve();
 await assert.rejects(sending);assert.equal(p.controls(),0);
});
test('whole input batch is validated before any event reaches a widget',async t=>{
 const p=pair(t);await connect(p,true);
 for(const events of [[{type:'mouseDown',x:NaN,y:.2}],[{type:'text',text:'valid'},{type:'shell',command:'bad'}],[{type:'keyDown',key:'x',modifiers:['command']}],Array(33).fill({type:'release'}),[{type:'text',text:'x'.repeat(4097)}]]){
  assert.equal(validSurfaceInputs(events),false);await assert.rejects(p.guest.command({action:'surface-input',frameId:'frame',events}),/Invalid/);
 }
 assert.equal(p.controls(),0);
 assert.equal(validSurfaceInputs([{type:'mouseDown',x:.2,y:.3,button:'left',buttons:1},{type:'mouseMove',x:.6,y:.7,buttons:1},{type:'mouseUp',x:.6,y:.7,buttons:0},{type:'text',text:'Заметка 🌍'},{type:'release'}]),true);
});
test('stop during capture prevents an old frame from reactivating a disconnected guest',async t=>{
 const p=pair(t);await connect(p,true);let resolve;p.surface.capture=()=>new Promise(r=>resolve=r);
 const pending=p.guest.command({action:'surface'});await new Promise(r=>setTimeout(r,30));await p.guest.command({action:'stop'});
 resolve({id:'old',image:'old',layers:[],at:Date.now(),viewport:{x:0,y:0,width:1,height:1}});await assert.rejects(pending,/changed|closed|disconnected/);assert.equal(p.guest.state().role,'idle');
});

test('shared frames cannot load remote URLs, local files, SVG or unbounded native layers',()=>{
 const f={id:'frame',at:1,viewport:{x:0,y:32,width:1280,height:720},image:'data:image/jpeg;base64,AA==',layers:[]};
 assert.ok(validSurfaceFrame(f));
 for(const bad of [{...f,image:'https://tracker.invalid/pixel'},{...f,image:'file:///secret'},{...f,image:'data:image/svg+xml,bad'},{...f,layers:[{x:0,y:0,width:2,height:1,image:f.image}]}])assert.equal(validSurfaceFrame(bad),false);
});

test('shared dock actions use the host UI and cannot name arbitrary operations',async t=>{
 const p=pair(t);await connect(p);
 await assert.rejects(p.guest.command({action:'surface-action',name:'note'}),/not granted/);
 await p.host.command({action:'select',selected:[],controlled:[],manage:true});
 for(const name of ['note','terminal','home'])await p.guest.command({action:'surface-action',name});
 assert.deepEqual(p.actions,['note','terminal','home']);
 await assert.rejects(p.guest.command({action:'surface-action',name:'settings-secret'}),/Invalid/);
});

function electronSurface(){
 const events=[],text=[];let minimized=false;
 const contents=name=>({isDestroyed:()=>false,focus:()=>{},sendInputEvent:e=>events.push({target:name,...e}),insertText:async value=>text.push({target:name,value})});
 const main=contents('canvas'),page=contents('browser');
 Object.assign(main,{getZoomFactor:()=>1,executeJavaScript:async script=>script.includes('getBoundingClientRect')?{x:0,y:32,width:1000,height:700}:false,capturePage:async()=>({isEmpty:()=>false,getSize:()=>({width:1000,height:700}),toJPEG:()=>Buffer.from('JPEG')})});
 const owner={webContents:main,isDestroyed:()=>false,isMinimized:()=>minimized,focus:()=>{}};
 const browser={duoCapture:async()=>[],duoInputTarget:(x,y)=>x>=500?{contents:page,offsetX:500,offsetY:100}:null};
 return {surface:new DuoCanvasSurface(()=>owner,browser),events,text,minimize:()=>{minimized=true;}};
}
test('new native browser target receives enter before press, owns its drag outside bounds and receives real text and Return',async()=>{
 const p=electronSurface(),frame=await p.surface.capture();
 await p.surface.input(frame.id,[{type:'mouseDown',x:.6,y:.5,button:'left',buttons:1},{type:'mouseMove',x:.2,y:.5,buttons:1},{type:'mouseUp',x:.2,y:.5,buttons:0},{type:'text',text:'Общий ввод'},{type:'keyDown',key:'Enter'},{type:'keyUp',key:'Enter'}]);
 assert.deepEqual(p.events.slice(0,2).map(e=>[e.target,e.type]),[['browser','mouseMove'],['browser','mouseDown']]);
 assert.ok(p.events.slice(0,4).every(e=>e.target==='browser'));
 assert.equal(p.events[2].x,-300);assert.deepEqual(p.text,[{target:'browser',value:'Общий ввод'}]);
 assert.deepEqual(p.events.slice(-3).map(e=>[e.type,e.keyCode]),[['keyDown','Return'],['char','\r'],['keyUp','Return']]);
});
test('minimized host rejects old-frame input; releasing a held drag and modifier sends the matching releases',async()=>{
 const p=electronSurface(),frame=await p.surface.capture();
 await p.surface.input(frame.id,[{type:'mouseDown',x:.2,y:.2,button:'left',buttons:1},{type:'keyDown',key:'Shift'}]);
 p.surface.release();assert.deepEqual(p.events.slice(-2).map(e=>[e.type,e.keyCode??e.button]),[['mouseUp','left'],['keyUp','Shift']]);
 p.minimize();const before=p.events.length;
 await assert.rejects(p.surface.input(frame.id,[{type:'mouseDown',x:.2,y:.2}]),/hidden|geometry/);assert.equal(p.events.length,before);
});
