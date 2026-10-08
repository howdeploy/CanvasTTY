import assert from 'node:assert/strict';
import test from 'node:test';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {registerBacklogIpc} from '../src/main/ipc/registerBacklogIpc.ts';
import {BACKLOG_IPC,BACKLOG_TERMINAL_IPC} from '../src/shared/backlog.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';
function fixture(t){const calls=[],writes=[];const manager=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls,{onWrite:(data,options)=>writes.push({data,options})}));t.after(()=>manager.disposeAll());
 const create=()=>manager.create({provider:'codex',profile:'normal',cwd:process.cwd(),position:{x:0,y:0}});const first=create(),second=create(),blocked=create();
 for(const row of [first,second,blocked])manager.applyProviderSignal(row.id,{kind:'lifecycle',state:'idle'});
 const handlers=new Map(),webContents={mainFrame:{}};registerBacklogIpc({handle:(k,v)=>handlers.set(k,v)},{terminals:manager,board:{subscribe:()=>()=>{}},getMainWindow:()=>({webContents})});
 const event={sender:webContents,senderFrame:webContents.mainFrame};return{manager,calls,writes,first,second,blocked,invoke:(key,...args)=>handlers.get(key)(event,...args)};
}
test('broadcast formats each negotiated mode, submits once, and preserves partial delivery/gates/redaction',t=>{
 const f=fixture(t);f.calls[0].process.emitData('\x1b[?2004h');f.manager.configureInputGate(id=>{if(id===f.blocked.id)throw Error('paused');});
 const original=f.manager.redactSecrets.bind(f.manager);f.manager.redactSecrets=text=>original(text).replaceAll('fixture-secret','[redacted]');
 const result=f.invoke(BACKLOG_IPC.broadcast,[f.first.id,f.second.id,f.blocked.id,'missing',f.first.id],'line\nfixture-secret\x1b[201~\n');
 assert.deepEqual(result,{delivered:[f.first.id,f.second.id],skipped:[f.blocked.id,'missing']});
 assert.deepEqual(f.writes.map(x=>x.data),['\x1b[200~line\r[redacted][201~\r\x1b[201~\r','line\r[redacted][201~\r\r']);
 assert.throws(()=>f.invoke(BACKLOG_IPC.broadcast,[f.first.id],'x'.repeat(16001)),/Invalid/);
});
test('context paste does not submit and refuses stale launch identity or a blocked destination',t=>{
 const f=fixture(t);f.calls[0].process.emitData('\x1b[?2004h');f.invoke(BACKLOG_TERMINAL_IPC.paste,f.first.id,'first\nlast');f.invoke(BACKLOG_TERMINAL_IPC.paste,f.second.id,'first\nlast');
 assert.deepEqual(f.writes.map(x=>x.data),['\x1b[200~first\rlast\x1b[201~','first\rlast']);
 f.manager.configureInputGate(id=>{if(id===f.second.id)throw Error('blocked');});assert.throws(()=>f.invoke(BACKLOG_TERMINAL_IPC.paste,f.second.id,'denied'));assert.equal(f.writes.length,2);
 let restarted=false;f.manager.configureInputGate(id=>{if(!restarted&&id===f.first.id){restarted=true;f.calls[0].process.emitExit(0);f.manager.restart(id);}});
 assert.throws(()=>f.invoke(BACKLOG_TERMINAL_IPC.paste,f.first.id,'must not reach replacement'));assert.equal(f.writes.length,2);
 assert.throws(()=>f.invoke(BACKLOG_TERMINAL_IPC.paste,f.first.id,'x'.repeat(16001)),/16,000/);
});
