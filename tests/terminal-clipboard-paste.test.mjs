import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { TerminalPasteMode } from '../src/main/services/TerminalPasteMode.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
const { Terminal } = createRequire(import.meta.url)('@xterm/xterm');

async function parity(chunks) {
 const mode=new TerminalPasteMode(),terminal=new Terminal({allowProposedApi:true});
 // Clipboard's browser textarea is its only DOM dependency; the real parser and paste API run unchanged.
 terminal._core.textarea={value:''};let actual='';terminal.onData(data=>{actual=data;});
 try {for(const chunk of chunks){mode.accept(chunk);await new Promise(resolve=>terminal.write(chunk,resolve));}
  terminal.paste('one\ntwo\r\nthree\rfour');assert.equal(mode.paste('one\ntwo\r\nthree\rfour'),actual,JSON.stringify(chunks));
 } finally {terminal.dispose();}
}
test('clipboard mode matches actual xterm for fragmented negotiation, resets and ignored control strings',async()=>{
 for(const sequence of [
  '', '\x1b[?2004h', '\x1b[?2004h\x1b[?2004l','\x9b?2004h','\x1b[?1;2004;25h',
  '\x1b[?2004:1h','\x1b[?2004h\x1b[!p','\x1b[?2004h\x1bc',
  '\x1b[?2004h\x1b c','\x1b[?2004\x18h','\x1b[?2004\x00h',
  '\x1b]title [ ?2004h\x07','\x1bP1;2qpayload [?2004h\x1b\\',
  '\x1b_bad [?2004h\x1b\\','\x1b]title\x1b[?2004h',
  '\x1b[?2004h\x1bPq[?2004l\x1b\\','\x1b[?2004$h',
  '\x1b[2004?h','\x1b[??2004h','\x1b[?'+('0;'.repeat(32))+'2004h',
  '\x1b[?'+('0;'.repeat(31))+'2004h','\x1b[?'+('0'.repeat(10000))+'2004h',
  '\x1b[?2004h'+('ordinary output'.repeat(20000))
 ]) {await parity([sequence]);if(sequence.length<100)await parity([...sequence]);}
});
function fixture(t,provider='codex') {
 const processes=[];const manager=new TerminalManager(()=>{}, {get:provider=>({state:'available',provider,executable:'/fixture/codex',launcher:'native',environment:{},checked:[]})},undefined,undefined,true,()=>{
  const p={pid:49000+processes.length,process:'codex',writes:[],write(data){this.writes.push(data);},kill(){},resize(){},onData(fn){this.data=fn;return{dispose(){}};},onExit(fn){this.exit=fn;return{dispose(){}};}};processes.push(p);return p;
 });t.after(()=>manager.disposeAll());const row=manager.create({provider,profile:'normal',cwd:process.cwd(),position:{x:0,y:0}});
 return{manager,row,processes};
}
test('real PTY output controls clipboard mode even after retained scrollback trims negotiation',t=>{
 const {manager,row,processes:[pty]}=fixture(t);pty.data('\x1b[?20');pty.data('04h');pty.data('x'.repeat(250000));
 manager.pasteClipboard(row.id,'first\nsecond\r\nthird\rlast',row.startedAt);
 assert.deepEqual(pty.writes,['\x1b[200~first\rsecond\rthird\rlast\x1b[201~']);
 pty.data('\x1b[?2004l');manager.pasteClipboard(row.id,'first\nsecond',row.startedAt);assert.equal(pty.writes.at(-1),'first\rsecond');
 manager.configureInputGate(()=>{throw Error('blocked');});assert.throws(()=>manager.pasteClipboard(row.id,'blocked',row.startedAt));assert.equal(pty.writes.length,2);
});
test('clipboard IPC authenticates and stale or absent launch identity never reaches a restarted PTY',t=>{
 t.mock.method(Date,'now',()=>1000);const {manager,row,processes}=fixture(t);const source=readFileSync(new URL('../src/main/ipc/registerIpc.ts',import.meta.url),'utf8');
 const start=source.indexOf('  ipcMain.handle(IPC.terminalPasteClipboard,');const end=source.indexOf('  ipcMain.on(IPC.terminalInput,',start);
 // Execute the actual handler registration, with only TypeScript parameter annotations removed.
 let handler;vm.runInNewContext(source.slice(start,end).replace(/: string|: number/g,''),{IPC:{terminalPasteClipboard:'paste'},ipcMain:{handle:(_,fn)=>{handler=fn;}},terminals:manager,getMainWindow:()=>{},assertMainRenderer:event=>{if(event!=='trusted')throw Error('foreign sender');}});
 assert.throws(()=>handler('foreign',row.id,'bad',row.startedAt),/foreign/);
 assert.throws(()=>handler('trusted',row.id,'bad',undefined));assert.throws(()=>handler('trusted',row.id,'bad',String(row.startedAt)));
 processes[0].data('\x1b[?2004h');processes[0].exit({exitCode:0});const next=manager.restart(row.id);assert.ok(next.startedAt>row.startedAt);
 assert.throws(()=>handler('trusted',row.id,'old\npaste',row.startedAt));processes[0].data('\x1b[?2004h');
 handler('trusted',row.id,'new\npaste',next.startedAt);assert.deepEqual(processes[1].writes,['new\rpaste']);
 processes[1].data('\x1b[?2004h');handler('trusted',row.id,'new\npaste',next.startedAt);assert.equal(processes[1].writes.at(-1),'\x1b[200~new\rpaste\x1b[201~');
 manager.dispose(row.id);assert.throws(()=>handler('trusted',row.id,'closed',next.startedAt));
});
test('deferred Grok launch refuses paste until measured-grid PTY binding and resets negotiation before delayed restart',t=>{
 t.mock.method(Date,'now',()=>2000);const {manager,row,processes}=fixture(t,'grok');assert.equal(processes.length,0);
 assert.equal(manager.inputChecked(row.id,'old raw path'),false,'ordinary input also refuses before a PTY exists');
 assert.throws(()=>manager.pasteClipboard(row.id,'before\nlaunch',row.startedAt));manager.resize(row.id,80,24);
 processes[0].data('\x1b[?2004h');manager.pasteClipboard(row.id,'first\npaste',row.startedAt);assert.equal(processes[0].writes[0],'\x1b[200~first\rpaste\x1b[201~');
 processes[0].exit({exitCode:0});const next=manager.restart(row.id);assert.ok(next.startedAt>row.startedAt);
 assert.throws(()=>manager.pasteClipboard(row.id,'during\nrestart',next.startedAt));manager.resize(row.id,80,24);
 assert.throws(()=>manager.pasteClipboard(row.id,'stale',row.startedAt));manager.pasteClipboard(row.id,'new\npaste',next.startedAt);assert.deepEqual(processes[1].writes,['new\rpaste']);
});
