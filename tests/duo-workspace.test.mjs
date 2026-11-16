import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { CanvasDuoService, parseDuoInvite } from '../src/main/services/CanvasDuoService.ts';
import { duoWorkspace, duoTerminalTransport } from '../src/renderer/src/features/duo/duoWorkspaceRuntime.ts';

function fixture() {
  const cards = new Map(); const writes = []; const output = new Map();
  const port = {
    listMetadata: () => [...cards.values()],
    create(request) {
      const id = randomUUID();
      cards.set(id, { id, title: request.title || 'Shell', provider: request.provider, exitCode: null, revision: 1,
        position: request.position, size: { width: 700, height: 400 } });
      output.set(id, '\x1b[32mREADY\x1b[0m\r\n'); return { id };
    },
    setBounds(id, bounds) { Object.assign(cards.get(id), bounds); cards.get(id).revision++; },
    rename(id, title) { cards.get(id).title = title; cards.get(id).revision++; },
    dispose(id) { cards.delete(id); output.delete(id); },
    resize() {}, geometry: () => ({ cols: 80, rows: 24 }),
    readBuffer(id) { const buffer = output.get(id); if (buffer === undefined) throw Error('not found'); return { buffer, outputOffset: buffer.length }; },
    inputChecked(id, text) { writes.push({ id, text }); output.set(id, output.get(id) + text); return true; }
  };
  const shared = port.create({provider:'terminal',position:{x:20,y:30}}).id;
  const privateId = port.create({provider:'terminal',position:{x:2000,y:30}}).id;
  output.set(privateId,'PRIVATE DO NOT TRANSMIT');
  return { service: new CanvasDuoService(port), port, cards, writes, output, shared, privateId };
}
const loopback = code => { const invite = parseDuoInvite(code); invite.host='127.0.0.1'; return 'canvasduo://'+Buffer.from(JSON.stringify(invite)).toString('base64url'); };
async function connect(host, guest, manage=false) {
  const result=await host.service.command({action:'host',transport:'lan',selected:[host.shared],controlled:[],manage});
  return guest.service.command({action:'join',invite:loopback(result.state.invites[0])});
}

test('one shared workspace: guest creates a host PTY, both edit same IDs and comments; private cards stay local',async t=>{
  const host=fixture(), guest=fixture(); t.after(()=>Promise.all([host.service.stop(),guest.service.stop()]));
  const joined=await connect(host,guest);
  assert.equal(joined.state.status,'connected');
  await assert.rejects(guest.service.command({action:'create',x:900,y:60}),/not granted/);
  await host.service.command({action:'select',selected:[host.shared],controlled:[],manage:true});
  const created=await guest.service.command({action:'create',x:900,y:60});
  const id=created.snapshot.createdId;
  assert.ok(host.cards.has(id)); assert.equal(guest.cards.has(id),false);
  assert.deepEqual(created.snapshot.cards.map(c=>c.id),[host.shared,id]);
  assert.ok(created.snapshot.cards.find(c=>c.id===id).control);
  assert.equal(created.snapshot.workspaceId,host.service.state().workspaceId);
  assert.equal(JSON.stringify(created).includes('PRIVATE DO NOT TRANSMIT'),false);
  assert.match(created.snapshot.cards[0].output.buffer,/\x1b\[32m/);
  const bounds={position:{x:1100,y:240},size:{width:850,height:460}};
  await guest.service.command({action:'bounds',cardId:id,bounds});
  assert.deepEqual(host.cards.get(id).position,bounds.position);
  const hostView=await host.service.command({action:'snapshot'});
  assert.deepEqual(hostView.snapshot.cards.find(c=>c.id===id).size,bounds.size);
  host.port.setBounds(id,{...bounds,position:{x:1400,y:450}});
  assert.deepEqual((await guest.service.command({action:'snapshot'})).snapshot.cards.find(c=>c.id===id).position,{x:1400,y:450});
  await guest.service.command({action:'rename',cardId:id,text:'Shared from Windows'});
  assert.equal(host.cards.get(id).title,'Shared from Windows');
  await guest.service.command({action:'comment',cardId:id,text:'Windows comment'});
  await host.service.command({action:'comment',cardId:id,text:'Mac answer'});
  assert.deepEqual((await guest.service.command({action:'snapshot'})).snapshot.comments.map(c=>c.text),['Windows comment','Mac answer']);
  await assert.rejects(guest.service.command({action:'bounds',cardId:id,bounds:{position:{x:0,y:0},size:{width:NaN,height:1}}}),/Invalid/);
  await guest.service.command({action:'close',cardId:id});
  assert.equal(host.cards.has(id),false);
  assert.deepEqual((await host.service.command({action:'snapshot'})).snapshot.cards.map(c=>c.id),[host.shared]);
  assert.equal(host.cards.has(host.privateId),true);
});

test('revocation blocks workspace mutations and input; expired invite keeps an active peer but refuses rejoin',async t=>{
  const host=fixture(),guest=fixture(),other=fixture(); t.after(()=>Promise.all([host.service.stop(),guest.service.stop(),other.service.stop()]));
  const started=await host.service.command({action:'host',transport:'lan',selected:[host.shared],controlled:[host.shared],manage:true});
  const invite=loopback(started.state.invites[0]);
  await guest.service.command({action:'join',invite});
  const now=Date.now; let at=now(); t.mock.method(Date,'now',()=>at);
  // Advance with heartbeats; an accepted collaboration outlives the invitation.
  for(let i=0;i<242;i++){at+=14900; await guest.service.command({action:'snapshot'});}
  assert.ok(at>started.state.expiresAt);
  await guest.service.command({action:'comment',cardId:host.shared,text:'still connected'});
  await assert.rejects(other.service.command({action:'join',invite}));
  await host.service.command({action:'select',selected:[host.shared],controlled:[],manage:false});
  for(const command of [{action:'create',x:1,y:1},{action:'close',cardId:host.shared},{action:'rename',cardId:host.shared,text:'no'},{action:'input',cardId:host.shared,text:'no'}]) {
    await assert.rejects(guest.service.command(command),/not granted/);
  }
  await guest.service.command({action:'stop'});
  await assert.rejects(other.service.command({action:'join',invite}));
  assert.equal(host.cards.has(host.shared),true);
});

test('renderer uses real remote buffers and host creation, batches typing without replay, never falls back to local',async t=>{
  const host=fixture(),guest=fixture(); t.after(()=>Promise.all([host.service.stop(),guest.service.stop()]));
  const joined=await connect(host,guest,true);
  globalThis.window={canvasTTY:{duo:{command:c=>guest.service.command(c)}}};
  t.after(()=>{delete globalThis.window;duoWorkspace.publish({state:{role:'idle',invites:[],expiresAt:0,available:[],selected:[],controlled:[],peer:false}});});
  duoWorkspace.publish(joined);
  let localCreates=0;
  const transport=duoTerminalTransport({create:()=>{localCreates++;throw Error('unexpected local create');}});
  const created=await transport.create({provider:'terminal',profile:'normal',position:{x:850,y:20}});
  assert.equal(localCreates,0);assert.ok(host.cards.has(created.id));
  transport.setBounds(created.id,{position:{x:1110,y:222},size:{width:750,height:430}});
  for(let i=0;i<30&&host.cards.get(created.id).position.y!==222;i++)await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(host.cards.get(created.id).position,{x:1110,y:222});
  const events=[]; const off=transport.onData(e=>events.push(e),created.id);t.after(off);
  transport.input(created.id,'one');transport.input(created.id,'two');transport.input(created.id,'\r');
  transport.input(created.id,'TERMINAL QUERY RESPONSE',true);
  await new Promise(r=>setTimeout(r,160));
  assert.deepEqual(host.writes,[{id:created.id,text:'onetwo\r'}]);
  assert.ok(events.some(e=>e.data.includes('onetwo\r')));
  const count=events.length;
  await duoWorkspace.command({action:'snapshot'});
  assert.equal(events.length,count,'same output offset must not replay ANSI data');
  const newest=duoWorkspace.get().reply;
  duoWorkspace.publish({...newest,snapshot:{...newest.snapshot,sequence:0,cards:[]}});
  assert.equal(duoWorkspace.get().reply.snapshot.cards.length,2,'late response must not erase current shared cards');
  duoWorkspace.fail(Error('connection lost'));
  await assert.rejects(transport.create({provider:'terminal',position:{x:1,y:1}}),/connection lost/);
  assert.equal(localCreates,0);
  await host.service.stop();
  await assert.rejects(guest.service.command({action:'snapshot'}));
  assert.equal(guest.service.state().status,'disconnected');
});

test('emergency stop cancels queued lifecycle operations instead of starting a listener afterwards',async t=>{
  const host=fixture();t.after(()=>host.service.stop());
  const starting=host.service.command({action:'host',transport:'lan',selected:[host.shared],controlled:[]});
  const stopped=await host.service.command({action:'stop'});
  await assert.rejects(starting,/cancelled/);
  assert.equal(stopped.state.role,'idle');assert.equal(host.service.state().role,'idle');
});

test('fast repeated typing across shared terminals is coalesced below the host flood limit without losing input',async t=>{
  const host=fixture(),guest=fixture();t.after(()=>Promise.all([host.service.stop(),guest.service.stop()]));
  const joined=await connect(host,guest,true), sent=[];
  globalThis.window={canvasTTY:{duo:{command:c=>{if(c.action==='input')sent.push(performance.now());return guest.service.command(c);}}}};
  t.after(()=>{delete globalThis.window;duoWorkspace.publish({state:{role:'idle',invites:[],expiresAt:0,available:[],selected:[],controlled:[],peer:false}});});
  duoWorkspace.publish(joined);const transport=duoTerminalTransport({});
  const second=await transport.create({provider:'terminal',position:{x:1,y:1}});
  await host.service.command({action:'select',selected:[host.shared,second.id],controlled:[host.shared,second.id],manage:true});
  duoWorkspace.publish(await guest.service.command({action:'snapshot'}));
  for(let i=0;i<60;i++){
    transport.input(i%2?second.id:host.shared,String(i%10));
    await new Promise(r=>setTimeout(r,5));
  }
  for(let i=0;i<200&&host.writes.reduce((n,w)=>n+w.text.length,0)<60;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(host.writes.filter(w=>w.id===host.shared).map(w=>w.text).join(''),'02468'.repeat(6));
  assert.equal(host.writes.filter(w=>w.id===second.id).map(w=>w.text).join(''),'13579'.repeat(6));
  assert.ok(sent.every((at,i)=>i===0||at-sent[i-1]>=45),'all terminal queues share one input cadence');
  assert.equal(duoWorkspace.get().error,'');
});
