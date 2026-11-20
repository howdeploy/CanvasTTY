import test from 'node:test';
import assert from 'node:assert/strict';
import createTestnet from 'hyperdht/testnet.js';
import { DuoDiagnostics, duoFailureCode } from '../src/main/services/DuoDiagnostics.ts';
import { CanvasDuoService, parseDuoInvite } from '../src/main/services/CanvasDuoService.ts';
import { DuoPeerTransport } from '../src/main/services/DuoPeerTransport.ts';
const terminals={listMetadata:()=>[],inputChecked:()=>false};

test('diagnostics never serialize untrusted errors or connection secrets; history is bounded and detached',()=>{
 const sink=[];const log=new DuoDiagnostics(event=>sink.push(event));
 const trace=log.begin('guest','p2p');
 const secret='canvasduo://PRIVATE 192.168.42.99 /fixture/private/file guestSeed=SECRET';
 trace.record('join-failed',Object.assign(new Error(secret),{code:'CANNOT_HOLEPUNCH',hostKey:secret}));
 trace.record('join-failed',new Error(secret));trace.record('join-failed',new Error(secret));
 const json=JSON.stringify(log.report());assert(!json.includes(secret));assert(!json.includes('192.168'));assert(!json.includes('guestSeed'));
 assert.equal(sink.length,3);assert.equal(sink[1].code,'CANNOT_HOLEPUNCH');assert.equal(sink[2].code,'UNKNOWN');
 const copy=log.report();copy.events[0].stage='corrupt';assert.equal(log.report().events[0].stage,'attempt-start');
 for(let i=0;i<250;i++)log.begin('host','lan');assert.equal(log.report().events.length,200);
 assert.equal(duoFailureCode(Object.assign(new Error(secret),{code:secret})),'UNKNOWN');
 assert.equal(duoFailureCode(new Error('Duo request timed out; delivery is uncertain.')),'RPC_TIMEOUT');
 assert.doesNotThrow(()=>new DuoDiagnostics(()=>{throw Error('storage unavailable');}).begin('guest','p2p'));
});

test('real direct P2P traces distinguish listen, encrypted open, snapshot, disconnect and reconnect without payloads', {timeout:15000},async t=>{
 const net=await createTestnet(3);t.after(()=>net.destroy());
 const peerOptions={bootstrap:net.bootstrap,host:'127.0.0.1',firewalled:false};
 const persisted=[];
 const host=new CanvasDuoService(terminals,{peerOptions,onDiagnostic:e=>persisted.push(e)});
 const guest=new CanvasDuoService(terminals,{peerOptions});
 t.after(()=>Promise.all([host.stop(),guest.stop()]));
 const hosted=await host.command({action:'host',selected:[],controlled:[]});const invite=hosted.state.invites[0];
 await guest.command({action:'join',invite});
 const stages=()=>guest.diagnosticReport().events.map(e=>e.stage);
 assert.deepEqual(stages().slice(0,5),['attempt-start','connect-start','encrypted-open','snapshot-start','connected']);
 assert(persisted.some(e=>e.stage==='listening'));assert(persisted.some(e=>e.stage==='peer-authenticated'));
 // Drop the socket while retaining the invitation. Reconnect only transport;
 // no user command gets replayed.
 await guest.peerClient.stop();await new Promise(r=>setTimeout(r,50));
 await guest.reconnect(guest.generation);
 assert(stages().includes('reconnected'));
 const reconnect=guest.diagnosticReport().events.find(e=>e.stage==='reconnected');
 assert.notEqual(reconnect.attempt,guest.diagnosticReport().events[0].attempt);
 await guest.command({action:'stop'});
 assert(stages().includes('stopped'));assert(stages().includes('socket-closed'));
 const json=JSON.stringify([...persisted,...guest.diagnosticReport().events]);
 for(const value of [invite,...Object.values(parseDuoInvite(invite)).filter(v=>typeof v==='string'),'127.0.0.1'])assert(!json.includes(value));
 for(const event of guest.diagnosticReport().events)assert(Number.isInteger(event.elapsedMs)&&event.elapsedMs>=0);
});

test('failed join keeps stage and safe NAT code after cleanup; invalid invite cannot leak parser text',async t=>{
 const original=DuoPeerTransport.join;
 DuoPeerTransport.join=async()=>{throw Object.assign(new Error('private endpoint and key'),{code:'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS'});};
 t.after(()=>{DuoPeerTransport.join=original;});
 const guest=new CanvasDuoService(terminals);t.after(()=>guest.stop());
 const invite='canvasduo://'+Buffer.from(JSON.stringify({version:3,hostKey:'a'.repeat(64),guestSeed:'b'.repeat(43),key:'c'.repeat(43)})).toString('base64url');
 await assert.rejects(guest.command({action:'join',invite}));
 assert.equal(guest.state().role,'idle');
 assert(guest.diagnosticReport().events.some(e=>e.stage==='join-failed'&&e.code==='HOLEPUNCH_DOUBLE_RANDOMIZED_NATS'));
 await assert.rejects(guest.command({action:'join',invite:'canvasduo://'+Buffer.from('PRIVATE_INVALID_JSON').toString('base64url')}),/Invalid Canvas Duo invitation/);
 assert(!JSON.stringify(guest.diagnosticReport()).includes('PRIVATE'));
 assert(guest.diagnosticReport().events.some(e=>e.code==='INVALID_INVITATION'));
});

test('network cause codes survive HTTP fetch wrappers without leaking their cause message',()=>{
 const error=new Error('fetch failed',{cause:Object.assign(new Error('private endpoint'),{code:'ECONNREFUSED'})});
 assert.equal(duoFailureCode(error),'ECONNREFUSED');
 const log=new DuoDiagnostics();log.begin('guest','lan').record('join-failed',error);
 assert(!JSON.stringify(log.report()).includes('endpoint'));
});
