import assert from 'node:assert/strict';
import test from 'node:test';
import {buildSync} from 'esbuild';
import {CanvasDuoService,parseDuoInvite} from '../src/main/services/CanvasDuoService.ts';
import {duoWorkspace,duoTerminalTransport} from '../src/renderer/src/features/duo/duoWorkspaceRuntime.ts';
import {mergeDuoSnapshot} from '../src/shared/canvasDuo.ts';
const code=buildSync({stdin:{contents:`export * from './src/shared/duoDocument.ts';export * from './src/main/services/DuoDocumentService.ts';export * from './src/preload/duoDocumentRouter.ts';export {IPC} from './src/shared/contracts.ts';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'}).outputFiles[0].text;
const {pickDuoSettings,duoSettingsOps,applyDuoSettingsOps,DuoDocumentService,createDuoDocumentRouter,IPC}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const note=(id,text='')=>({id,text,position:{x:50,y:70},size:{width:300,height:220}});
const initial=()=>({locale:'ru',lastDirectory:'/private-guest',stickyNotes:[note('a','first'),note('b','second')],canvasRegions:[],fileCards:[],pluginCanvas:[],homeLayout:[],browserCanvas:null,terminalBackgroundOverrides:{},canvasColor:'#17191c'});
const materials={materials:[],remarks:[],handoffs:[]},browser={tabs:[],activeTabId:null};
function pair(t,options={}){
 let settings=initial(),buffer='\x1b[32mHOST\x1b[0m';const cards=[],writes=[],calls=[];
 const doc=new DuoDocumentService({get:()=>settings,update:async p=>(settings={...settings,...p})},async(channel,args)=>{calls.push({channel,args});if(channel===IPC.materialsSnapshot)return materials;if(channel===IPC.pluginsList)return [];if(channel===IPC.browserGetState)return browser;if(channel===IPC.filesRegisterRoot)return {rootId:'registered-root',available:true};if(channel===IPC.filesList)return [];return null;},async request=>new Response('host-only-asset',{headers:{'content-type':'text/plain'}}),()=>{},async()=>null);
 const terminals={listMetadata:()=>cards,create:r=>{const c={...r,id:'terminal-'+cards.length,title:'Shared terminal',exitCode:null,size:{width:700,height:400}};cards.push(c);return c;},geometry:()=>({cols:80,rows:24}),readBuffer:()=>({buffer:'\x1b[32mHOST\x1b[0m',outputOffset:18}),inputChecked:(id,text)=>{writes.push({id,text});return true;},setBounds:(id,b)=>Object.assign(cards.find(c=>c.id===id),b),resize:()=>{throw Error('local fit must not resize host PTY');}};
 terminals.readBuffer=()=>({buffer,outputOffset:buffer.length});
 const host=new CanvasDuoService(terminals,{document:doc,files:options.files,onChanged:options.hostChanged}),guest=new CanvasDuoService({...terminals,listMetadata:()=>[],create:()=>{throw Error('Guest must not create local PTY');}},{onChanged:options.guestChanged});
 t.after(()=>Promise.all([host.stop(),guest.stop()]));
 return {host,guest,doc,cards,writes,calls,get:()=>settings,set:p=>{settings={...settings,...p};},append:text=>{buffer+=text;}};
}
async function connect(p,manage=true){const h=await p.host.command({action:'host',transport:'lan',selected:[],controlled:[],fullCanvas:true,documentSync:true,manage});const i=parseDuoInvite(h.state.invites[0]);i.host='127.0.0.1';return p.guest.command({action:'join',invite:'canvasduo://'+Buffer.from(JSON.stringify(i)).toString('base64url')});}

test('shared document has no camera, focus, accounts, shortcuts or private profile settings',()=>{
 const doc=pickDuoSettings({...initial(),camera:{x:1,zoom:9},activeSessionId:'private',apiKey:'secret',uiScale:2});
 for(const k of ['camera','activeSessionId','apiKey','uiScale','locale','lastDirectory'])assert.equal(k in doc,false);
 assert.throws(()=>applyDuoSettingsOps(initial(),[{key:'camera',before:null,after:{zoom:2}}]),/private/);
});
test('concurrent edits merge different objects and different fields; same-field conflict is explicit',()=>{
 const base=initial(),a=duoSettingsOps(pickDuoSettings(base),{stickyNotes:[note('a','guest'),note('b','second')]}),b=duoSettingsOps(pickDuoSettings(base),{stickyNotes:[note('a','first'),note('b','host')]});
 const merged={...base,...applyDuoSettingsOps(base,b)};Object.assign(merged,applyDuoSettingsOps(merged,a));
 assert.deepEqual(merged.stickyNotes.map(n=>n.text),['guest','host']);
 const moved={...base,stickyNotes:[{...note('a','first'),position:{x:400,y:500}},note('b','second')]};
 assert.deepEqual(applyDuoSettingsOps(moved,a).stickyNotes[0],{...note('a','guest'),position:{x:400,y:500}});
 assert.throws(()=>applyDuoSettingsOps({...base,stickyNotes:[note('a','other'),note('b','second')]},a),/Поле изменено/);
});
test('removed object cannot be resurrected by a stale edit; edit validation is atomic',()=>{
 const base=initial(),ops=duoSettingsOps(pickDuoSettings(base),{stickyNotes:[note('a','new'),note('b','second')]});
 assert.throws(()=>applyDuoSettingsOps({...base,stickyNotes:[note('b')]},ops),/removed/);assert.equal(base.stickyNotes[0].text,'first');
 assert.throws(()=>applyDuoSettingsOps(base,[{key:'stickyNotes',id:'a',before:note('a'),after:note('a'),fields:['__proto__']}]),/Invalid/);
});
test('real encrypted transport shares all objects and host terminals, rejects desktop control and world-camera commands',async t=>{
 const p=pair(t),joined=await connect(p);assert.equal(joined.state.documentSync,true);assert.equal(joined.snapshot.document.settings.stickyNotes.length,2);
 const c=await p.guest.command({action:'create',x:2000,y:100});assert.equal(p.cards.length,1);assert.match(c.snapshot.cards[0].output.buffer,/HOST/);
 await p.guest.command({action:'document-edit',ops:duoSettingsOps(pickDuoSettings(p.get()),{stickyNotes:[note('a','Windows note'),note('b','second')]})});
 assert.equal(p.get().stickyNotes[0].text,'Windows note');
 await p.guest.command({action:'input',cardId:p.cards[0].id,text:'echo shared\r'});assert.equal(p.writes[0].text,'echo shared\r');
 await p.guest.command({action:'cursor',cardId:'canvas',x:-3400,y:2400});assert.equal((await p.host.command({action:'snapshot'})).snapshot.cursors[0].x,-3400);
 await assert.rejects(p.guest.command({action:'surface-action',name:'home'}),/not enabled/);
 await assert.rejects(p.guest.command({action:'document-edit',ops:[{key:'camera',before:null,after:{x:7}}]}),/private/);
});
test('guest local terminal fit never resizes the shared host PTY',async t=>{
 const p=pair(t);await connect(p);const created=await p.guest.command({action:'create',x:1,y:2});
 globalThis.window={canvasTTY:{duo:{command:c=>p.guest.command(c)}}};duoWorkspace.publish(created);
 t.after(()=>{delete globalThis.window;duoWorkspace.publish({state:{role:'idle',invites:[],expiresAt:0,available:[],selected:[],controlled:[],peer:false}});});
 const transport=duoTerminalTransport({resize:()=>{throw Error('No local resize');}});transport.resize(p.cards[0].id,40,10);await new Promise(r=>setTimeout(r,210));assert.equal(duoWorkspace.get().error,'');
});
test('input acknowledgement does not read documents or render a headless terminal',async t=>{
 const p=pair(t);await connect(p);const created=await p.guest.command({action:'create',x:1,y:2});
 const original=p.doc.snapshot;p.doc.snapshot=()=>{throw Error('Slow document must not delay input');};
 const ack=await p.guest.command({action:'input',cardId:p.cards[0].id,text:'exactly once\r'});
 assert.equal(ack.snapshot.partial,true);assert.deepEqual(p.writes,[{id:p.cards[0].id,text:'exactly once\r'}]);
 const merged=mergeDuoSnapshot(created.snapshot,ack.snapshot);assert.equal(merged.cards.length,1);assert.equal(merged.document.settings.stickyNotes.length,2);
 assert.equal(p.host.screens.size,0,'Document mode must not allocate or await the legacy headless screen');
 p.doc.snapshot=original;
});
test('incremental updates omit unchanged document and send only new terminal bytes; deletion is authoritative',async t=>{
 const p=pair(t);await connect(p);const created=await p.guest.command({action:'create',x:1,y:2}),id=p.cards[0].id;
 const base=created.snapshot,offset=base.cards[0].output.outputOffset;
 const request={action:'updates',outputOffsets:{[id]:offset},documentVersion:base.documentVersion};
 const idle=(await p.guest.command(request)).snapshot;assert.equal(idle.document,undefined);assert.equal(idle.cards[0].output,undefined);
 p.append('NEXT\r\n');const delta=(await p.guest.command(request)).snapshot;
 assert.equal(delta.cards[0].output.buffer,'NEXT\r\n');assert.equal(delta.cards[0].output.startOffset,offset);
 const merged=mergeDuoSnapshot(base,delta);assert.equal(merged.cards[0].output.buffer,base.cards[0].output.buffer+'NEXT\r\n');assert.equal(merged.document,base.document);
 assert.equal(mergeDuoSnapshot(merged,delta).cards[0].output.buffer,merged.cards[0].output.buffer,'Duplicate delivery must not replay output');
 p.set({canvasColor:'#changed'});const changed=(await p.guest.command({...request,outputOffsets:{[id]:merged.cards[0].output.outputOffset}})).snapshot;
 assert.equal(changed.document.settings.canvasColor,'#changed');assert.notEqual(changed.documentVersion,base.documentVersion);
 p.cards.length=0;const removed=(await p.guest.command(request)).snapshot;assert.equal(mergeDuoSnapshot(merged,removed).cards.length,0);
 await assert.rejects(p.guest.command({...request,outputOffsets:{[id]:-1}}),/cursor/);
 await assert.rejects(p.guest.command({...request,documentVersion:'invalid'}),/cursor/);
});
test('main-process updates deliver host edits without any renderer polling and stop cleanly',async t=>{
 const events=[],p=pair(t,{guestChanged:r=>events.push(r)});await connect(p);
 p.set({canvasColor:'#main-process'});
 const end=Date.now()+3000;while(Date.now()<end&&!events.some(r=>r.snapshot?.document?.settings.canvasColor==='#main-process'))await new Promise(r=>setTimeout(r,10));
 assert(events.some(r=>r.snapshot?.document?.settings.canvasColor==='#main-process'));
 const before=events.length;await new Promise(r=>setTimeout(r,400));assert.equal(events.length,before,'Unchanged workspace must not trigger UI renders');
 const restored=await p.guest.command({action:'state'});assert.equal(restored.snapshot.document.settings.canvasColor,'#main-process','Reloaded UI must receive unchanged shared state');
 await p.guest.command({action:'stop'});const count=events.length;await new Promise(r=>setTimeout(r,250));assert.equal(events.length,count);assert.equal(events.at(-1).state.role,'idle');
});
test('read-only and revoked guest cannot modify shared document or invoke private IPC',async t=>{
 const p=pair(t);await connect(p,false);const ops=duoSettingsOps(pickDuoSettings(p.get()),{canvasColor:'#abcdef'});
 await assert.rejects(p.guest.command({action:'document-edit',ops}),/not granted/);
 await assert.rejects(p.guest.command({action:'resource',channel:IPC.settingsGet,args:[]}),/not shared/);
 await p.host.command({action:'select',selected:[],controlled:[],manage:true});await p.guest.command({action:'document-edit',ops});
 await p.host.command({action:'select',selected:[],controlled:[],manage:false});await assert.rejects(p.guest.command({action:'resource',channel:IPC.browserNewTab,args:[]}),/not granted/);
});
test('terminal file links are explicit host capabilities, require control and recheck revocation after resolution',async t=>{
 const opened=[],p=pair(t,{files:{canOpen:async()=>true,open:async(id,reference,authorized)=>{assert.equal(authorized(),true);opened.push({id,reference});}}});
 await connect(p);await p.guest.command({action:'create',x:1,y:2});const id=p.cards[0].id;
 assert.equal((await p.guest.command({action:'file-can-open',cardId:id,text:'./host.png'})).snapshot.result,true);
 await p.guest.command({action:'file-open',cardId:id,text:'./host.png'});assert.deepEqual(opened,[{id,reference:'./host.png'}]);
 await p.host.command({action:'select',selected:[],controlled:[],manage:false});
 await assert.rejects(p.guest.command({action:'file-open',cardId:id,text:'./host.png'}),/not granted/);
 await assert.rejects(p.guest.command({action:'file-open',cardId:'private',text:'./host.png'}),/not shared/);
 assert.equal(opened.length,1);
});
test('idle guest keeps its lease without renderer polling; heartbeat never restores revoked control', {timeout:25000}, async t=>{
 const p=pair(t);await connect(p);const reads=p.calls.length;
 // Renderer timers may be suspended for much longer than the 15s peer lease.
 await new Promise(resolve=>setTimeout(resolve,16200));
 assert.equal(p.host.state().manage,true,'A live but backgrounded guest lost control');
 assert.equal(p.guest.state().status,'connected');
 assert.equal(p.calls.length,reads,'Keepalive must not capture documents, pages or terminal output');
 await p.host.command({action:'select',selected:[],controlled:[],manage:false});
 await new Promise(resolve=>setTimeout(resolve,2200));
 assert.equal(p.host.state().manage,false);assert.equal(p.guest.state().manage,false);
 const ops=duoSettingsOps(pickDuoSettings(p.get()),{canvasColor:'#abcdef'});
 await assert.rejects(p.guest.command({action:'document-edit',ops}),/not granted/);
});
test('asset capability rejects arbitrary URLs, private media, non-shared plugins and invalid ranges',async t=>{
 const p=pair(t);
 for(const args of [['file:///etc/passwd',null],['https://invalid.test',null],['canvastty-plugin://private/index.html',null],['canvastty-preview://root/path','bytes=0-1,4-5']])await assert.rejects(p.doc.resource('protocol',args,()=>true,true));
 await assert.rejects(p.doc.resource(IPC.mediaRead,['/private/image.png'],()=>true,true),/background/);
 await assert.rejects(p.doc.resource('protocol',['canvastty-preview://root/file',null],()=>false,false),/not shared/);
});
test('large resource chunks are bounded, revocable and removed on disconnect',async()=>{
 const doc=new DuoDocumentService({get:()=>({...initial(),pluginCanvas:[{pluginId:'shared'}]}),update:async()=>initial()},async()=>({data:'x'.repeat(160000)}),async()=>new Response(''),()=>{},async()=>null);
 let allowed = true;
 const authorized = () => allowed;
 const first=await doc.resource(IPC.pluginsPlaylistsWrite,['shared'],authorized,true);assert.equal(first.data.length,128000);
 allowed = false;
 await assert.rejects(doc.resource('chunk',[first.chunk,128000],authorized,false),/revoked/);
 doc.clear();await assert.rejects(doc.resource('chunk',[first.chunk,128000],()=>true,true),/expired/);
});

test('preload keeps rapid note edits pending across old polls, preserves guest profile and restores it on disconnect',async t=>{
 const p=pair(t),joined=await connect(p),events=[],local={...initial(),locale:'en',canvasColor:'#local',stickyNotes:[]};let release;
 const barrier=new Promise(r=>release=r);let delayed=true;
 const router=createDuoDocumentRouter(async(channel,...args)=>{
   if(channel===IPC.settingsGet)return local;
   if(channel===IPC.materialsSnapshot)return materials;if(channel===IPC.browserGetState)return browser;
   if(channel===IPC.settingsUpdate){Object.assign(local,args[0]);return local;}
   if(channel===IPC.duoCommand){if(args[0].action==='document-edit'&&delayed){delayed=false;await barrier;}return p.guest.command(args[0]);}
   throw Error('Unexpected local capability '+channel);
 },(channel,value)=>events.push({channel,value}));
 await router.invoke(IPC.duoCommand,{action:'snapshot'});
 const first=router.invoke(IPC.settingsUpdate,{stickyNotes:[note('a','W'),note('b','second')]}),second=router.invoke(IPC.settingsUpdate,{stickyNotes:[note('a','Wi'),note('b','second')]});
 await router.invoke(IPC.duoCommand,{action:'snapshot'});assert.equal((await router.invoke(IPC.settingsGet)).stickyNotes[0].text,'Wi');
 release();await Promise.all([first,second]);assert.equal(p.get().stickyNotes[0].text,'Wi');assert.equal(local.stickyNotes.length,0);assert.equal(local.canvasColor,'#local');
 assert.equal(router.localEvent(IPC.settingsChanged,local).stickyNotes[0].text,'Wi');
 await router.invoke(IPC.duoCommand,{action:'stop'});assert.equal((await router.invoke(IPC.settingsGet)).canvasColor,'#local');assert.equal(router.active(),false);
});


test('view-only guest opens an existing Files card, cannot register a new folder, and loses access after removal', async t => {
  const p = pair(t);
  const root = { rootType: 'folder', folderPath: '/shared' };
  p.set({ fileCards: [{ id: 'files', root, folderPath: '/shared' }] });
  await connect(p, false);
  const request = async (channel, args) => (await p.guest.command({ action: 'resource', channel, args })).snapshot.result.value;
  const { rootId } = await request(IPC.filesRegisterRoot, [root]);
  assert.deepEqual(await request(IPC.filesList, [rootId, '']), []);
  const response = await request('protocol', [`canvastty-preview://${rootId}/preview.mp4`, null]);
  assert.equal(Buffer.from(response.body, 'base64').toString(), 'host-only-asset');
  await assert.rejects(request(IPC.filesRegisterRoot, [{...root, folderPath: '/private'}]), /not granted/);
  await assert.rejects(request(IPC.filesRead, ['host-local-root', 'preview.mp4']), /not shared/);
  p.set({ fileCards: [] });
  await assert.rejects(request(IPC.filesList, [rootId, '']), /not shared/);
  await assert.rejects(request('protocol', [`canvastty-preview://${rootId}/preview.mp4`, null]), /not shared/);
  await request(IPC.filesCloseRoot, [rootId]);
});
