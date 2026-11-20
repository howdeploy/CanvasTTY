import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DuoFileTransferService, sendDuoFiles} from '../src/main/services/DuoFileTransferService.ts';
import {mergeDuoSnapshot} from '../src/shared/canvasDuo.ts';
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


test('populated canvas joins over P2P and fetches omitted terminal output and document pages', { timeout: 15000 }, async t => {
  const net = await createTestnet(3);
  const options = { bootstrap: net.bootstrap, host: '127.0.0.1', firewalled: false };
  const { service: host } = fixture(options);
  const { service: guest } = fixture(options);
  t.after(async () => { await Promise.all([host.stop(), guest.stop()]); await net.destroy(); });
  const entry = host.terminals.listMetadata()[0];
  host.terminals.listMetadata = () => Array.from({ length: 96 }, (_, i) => ({ ...entry, id: `term-${i}` }));
  const buffer = '\x1b[32m界'.repeat(5000).slice(-32768);
  host.terminals.readBuffer = () => ({ buffer, outputOffset: buffer.length, restorePrefix: '\x1b[0m' });
  const document = { settings: { stickyNotes: Array.from({ length: 180 }, (_, i) => ({ id: String(i), text: '界'.repeat(4000) })) } };
  host.options.document = { snapshot: async () => document, clear() {} };
  const h = await host.command({ action: 'host', selected: [], controlled: [], fullCanvas: true, documentSync: true });
  let snapshot = (await guest.command({ action: 'join', invite: h.state.invites[0] })).snapshot;
  assert.deepEqual(snapshot.document, document);
  assert.equal(snapshot.cards.length, 96);
  assert.ok(snapshot.cards.some(card => !card.output));
  for (let round = 0; round < 25 && snapshot.cards.some(card => !card.output); round++) {
    const outputOffsets = Object.fromEntries(snapshot.cards.flatMap(card => card.output ? [[card.id, card.output.outputOffset]] : []));
    const next = await guest.command({ action: 'updates', outputOffsets, documentVersion: snapshot.documentVersion });
    snapshot = mergeDuoSnapshot(snapshot, next.snapshot);
  }
  assert.ok(snapshot.cards.every(card => card.output?.buffer === buffer));
  assert.equal(guest.state().status, 'connected');
});

test('large file upload over real P2P leaves heartbeat and terminal input available', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'duo-transfer-p2p-'));
  const net = await createTestnet(3);
  const options = { bootstrap: net.bootstrap, host: '127.0.0.1', firewalled: false };
  const { service: host, writes } = fixture(options);
  const { service: guest } = fixture(options);
  t.after(async () => {
    await Promise.all([host.stop(), guest.stop()]);
    await net.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const imports = join(root, 'imports');
  const transfers = new DuoFileTransferService(imports);
  const source = join(root, 'transfer.bin');
  const data = randomBytes(2 * 1024 * 1024);
  await writeFile(source, data);
  host.options.document = {
    snapshot: async () => ({}), clear: () => transfers.clear(),
    resource: async (_channel, args, authorized) => ({ value: await transfers.receive(args, authorized) })
  };
  const h = await host.command({ action: 'host', selected: [], controlled: [], fullCanvas: true, documentSync: true, manage: true });
  await guest.command({ action: 'join', invite: h.state.invites[0] });
  let heartbeats = 0;
  const perform = host.perform.bind(host);
  host.perform = async (command, author) => {
    if (command.action === 'heartbeat' && author === 'guest') heartbeats++;
    return perform(command, author);
  };
  let chunks = 0;
  await sendDuoFiles([source], async args => {
    const reply = await guest.command({ action: 'resource', channel: 'file-upload', args });
    if (args[0] === 'chunk' && ++chunks === 34) {
      await guest.command({ action: 'input', cardId: 'shared', text: 'during upload' });
    }
    return reply.snapshot.result.value;
  }, () => guest.state().status === 'connected' && guest.state().manage);
  assert.ok(chunks > 60);
  assert.ok(heartbeats >= 2);
  assert.deepEqual(writes, [{ id: 'shared', text: 'during upload' }]);
  const directory = join(imports, (await readdir(imports))[0]);
  assert.deepEqual(await readFile(join(directory, (await readdir(directory))[0])), data);
});
