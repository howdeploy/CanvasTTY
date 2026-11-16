import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import {CanvasDuoService,parseDuoInvite} from '../src/main/services/CanvasDuoService.ts';
function fixture(options){const writes=[];return{writes,service:new CanvasDuoService({listMetadata:()=>['shared','private'].map(id=>({id,title:id,provider:'terminal',exitCode:null,position:{x:0,y:0},size:{width:700,height:400}})),geometry:()=>({cols:80,rows:24}),readBuffer:id=>({buffer:id==='shared'?'visible output':'PRIVATE_CANARY',outputOffset:14}),inputChecked:(id,text)=>{writes.push({id,text});return true;}},{peerOptions:options})};}
test('direct P2P socket shares selected cards, enforces/revokes input and reconnects without a relay',async t=>{
 const net=await createTestnet(3);t.after(()=>net.destroy());const options={bootstrap:net.bootstrap,host:'127.0.0.1',firewalled:false};
 const {service:host,writes}=fixture(options),{service:guest}=fixture(options);t.after(()=>Promise.all([host.stop(),guest.stop()]));
 const started=await host.command({action:'host',selected:['shared'],controlled:[]});const invite=started.state.invites[0];assert.equal(parseDuoInvite(invite).version,3);
 const joined=await guest.command({action:'join',invite});assert.equal(joined.snapshot.cards.length,1);assert(!JSON.stringify(joined).includes('PRIVATE_CANARY'));assert.equal(joined.state.connection.mode,'direct');assert.equal(joined.state.connection.remoteHost,'127.0.0.1');
 await assert.rejects(guest.command({action:'input',cardId:'shared',text:'blocked'}),/not granted/);assert.equal(writes.length,0);
 await guest.command({action:'comment',cardId:'shared',text:'HELLO'});assert.equal((await host.command({action:'snapshot'})).snapshot.comments[0].text,'HELLO');
 await guest.command({action:'cursor',cardId:'shared',x:.2,y:.4});assert.equal((await host.command({action:'snapshot'})).snapshot.cursors[0].author,'guest');
 await host.command({action:'select',selected:['shared'],controlled:['shared']});await guest.command({action:'input',cardId:'shared',text:'one command\r'});assert.deepEqual(writes,[{id:'shared',text:'one command\r'}]);
 await host.command({action:'select',selected:['shared'],controlled:[]});await assert.rejects(guest.command({action:'input',cardId:'shared',text:'revoked'}),/not granted/);
 await guest.command({action:'stop'});await new Promise(ok=>setTimeout(ok,100));await guest.command({action:'join',invite});assert.deepEqual(host.state().controlled,[]);
 await host.command({action:'stop'});await assert.rejects(guest.command({action:'snapshot'}));
});
test('P2P invitations contain only cryptographic rendezvous data and reject older relay configuration',()=>{
 const value={version:3,hostKey:randomBytes(32).toString('hex'),guestSeed:randomBytes(32).toString('base64url'),key:randomBytes(32).toString('base64url')};const code=v=>'canvasduo://'+Buffer.from(JSON.stringify(v)).toString('base64url');
 assert.deepEqual(parseDuoInvite(code(value)),value);assert(!('host'in value));assert(!('relay'in value));
 for(const patch of[{hostKey:'x'},{guestSeed:'x'},{key:'x'},{version:2,relay:'https://example.org'}])assert.throws(()=>parseDuoInvite(code({...value,...patch})));
});

test('a pending document read cannot block P2P terminal input or heartbeat', {timeout:5000}, async t=>{
 const net=await createTestnet(3);t.after(()=>net.destroy());
 const options={bootstrap:net.bootstrap,host:'127.0.0.1',firewalled:false};
 const p=fixture(options),g=fixture(options);
 t.after(()=>Promise.all([p.service.stop(),g.service.stop()]));
 let release,entered;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 t.after(()=>release());
 let blocked=false;
 p.service.options.document={snapshot:async()=>{if(blocked){entered();await gate;}return {settings:{},materials:{materials:[],remarks:[],handoffs:[]},plugins:[],browser:{tabs:[],activeTabId:null}};},clear(){},edit:async()=>{},resource:async()=>null};
 const h=await p.service.command({action:'host',fullCanvas:true,documentSync:true,manage:true,selected:[],controlled:[]});
 await g.service.command({action:'join',invite:h.state.invites[0]});
 blocked=true;
 const slow=g.service.command({action:'snapshot'});slow.catch(()=>undefined);
 await started;
 try{
  await Promise.race([
   Promise.all([g.service.command({action:'input',cardId:'shared',text:'once\r'}),g.service.command({action:'heartbeat'})]),
   new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Read blocked control lane')),600);timer.unref();})
  ]);
  assert.deepEqual(p.writes,[{id:'shared',text:'once\r'}]);
 }finally{release();await slow;}
});
test('queued P2P mutations preserve order and recheck revoked control after a slow edit', {timeout:10000}, async t=>{
 const net=await createTestnet(3);t.after(()=>net.destroy());
 const options={bootstrap:net.bootstrap,host:'127.0.0.1',firewalled:false};
 const p=fixture(options),g=fixture(options);
 t.after(()=>Promise.all([p.service.stop(),g.service.stop()]));
 let release,entered;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 t.after(()=>release());
 p.service.options.document={snapshot:async()=>({settings:{},materials:{materials:[],remarks:[],handoffs:[]},plugins:[],browser:{tabs:[],activeTabId:null}}),clear(){},resource:async()=>null,
  edit:async(_ops,authorized)=>{entered();await gate;if(!authorized())throw Error('Control revoked during edit');}};
 const h=await p.service.command({action:'host',fullCanvas:true,documentSync:true,manage:true,selected:[],controlled:[]});
 await g.service.command({action:'join',invite:h.state.invites[0]});
 const edit=g.service.command({action:'document-edit',ops:[]});
 const editDenied=assert.rejects(edit,/revoked/);
 await started;
 const input=g.service.command({action:'input',cardId:'shared',text:'must not execute\r'});
 const inputDenied=assert.rejects(input,/not granted/);
 await g.service.command({action:'heartbeat'});
 assert.deepEqual(p.writes,[],'Keyboard must not overtake an earlier mutation');
 await p.service.command({action:'select',selected:[],controlled:[],manage:false});
 release();
 await Promise.all([editDenied,inputDenied]);
 assert.deepEqual(p.writes,[],'Revoked queued input must never reach the PTY');
});
test('broken P2P transport reconnects automatically, revokes input and never replays commands', {timeout:15000}, async t=>{
 const net=await createTestnet(3);t.after(()=>net.destroy());const options={bootstrap:net.bootstrap,host:'127.0.0.1',firewalled:false};
 const {service:host,writes}=fixture(options),{service:guest}=fixture(options);t.after(()=>Promise.all([host.stop(),guest.stop()]));
 const started=await host.command({action:'host',selected:['shared'],controlled:['shared']});await guest.command({action:'join',invite:started.state.invites[0]});
 await guest.command({action:'input',cardId:'shared',text:'before break\r'});
 await guest.peerClient.stop();
 const end=Date.now()+9000;while(Date.now()<end&&(!guest.peerClient?.connected||host.state().controlled.length))await new Promise(r=>setTimeout(r,50));
 assert.equal(guest.peerClient?.connected,true);assert.deepEqual(host.state().controlled,[]);
 await assert.rejects(guest.command({action:'input',cardId:'shared',text:'still revoked\r'}),/not granted/);
 assert.deepEqual(writes,[{id:'shared',text:'before break\r'}]);
 await host.command({action:'select',selected:['shared'],controlled:['shared']});await guest.command({action:'input',cardId:'shared',text:'after grant\r'});
 await guest.stop();await new Promise(r=>setTimeout(r,2100));assert.equal(guest.state().role,'idle');assert.equal(guest.peerClient,null);
 assert.deepEqual(writes.map(w=>w.text),['before break\r','after grant\r']);
});
