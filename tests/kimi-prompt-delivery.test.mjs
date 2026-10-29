import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { agentPromptInput } from "../src/main/services/codexInput.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const READY="\x1b[2J\x1b[HKimi Code 2.4.0\r\n╭────────────────────────────╮\r\n│ >                          │\r\n╰────────────────────────────╯\r\nfooter\x1b[2A\x1b[6G\x1b[?25l";
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
function fixture(t){const writes=[],calls=[];
  const manager=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls,{onWrite:data=>writes.push(data)}));
  t.after(()=>manager.disposeAll());
  const child=manager.create({provider:"kimi",cwd:process.cwd(),profile:"normal",position:{x:0,y:0}});
  return{manager,child,writes,calls,ready:()=>calls.at(-1).process.emitData(READY)};}
const send=(f,text="TASK",wait=200,signal)=>f.manager.deliverInput(f.child.id,agentPromptInput("kimi",text),wait,signal);

test("Kimi waits for its active composer even when PTY exists and hooks are unavailable",async t=>{
  const f=fixture(t),pending=send(f);
  await tick();assert.deepEqual(f.writes,[]);
  f.ready();assert.equal((await pending).delivered,true);
  assert.deepEqual(f.writes,["\x1b[200~TASK\x1b[201~\r"]);
});

test("human drafts, multiline continuations and approval prompts receive no automated input",async t=>{
  for(const output of [READY.replace("│ >                          │","│ > human draft              │"),
    READY.replace("╰────────────────────────────╯","│ human continuation         │\r\n╰────────────────────────────╯")]){
    const f=fixture(t);f.calls.at(-1).process.emitData(output);
    assert.equal((await send(f,"DO_NOT_APPEND",25)).delivered,false);assert.deepEqual(f.writes,[]);
  }
  const f=fixture(t);f.ready();
  f.manager.applyProviderSignal(f.child.id,{kind:"lifecycle",state:"needs_approval",event:"PermissionRequest"});
  const result=await send(f);assert.equal(result.delivered,false);assert.match(result.reason,/approval/);assert.deepEqual(f.writes,[]);
});

test("concurrent sends cannot consume one unchanged empty composer",async t=>{
  const f=fixture(t);f.ready();
  const first=send(f,"FIRST"),second=send(f,"SECOND");
  assert.equal((await first).delivered,true);
  await tick();assert.deepEqual(f.writes,["\x1b[200~FIRST\x1b[201~\r"]);
  // A fresh provider redraw is transport readiness evidence, never an acceptance ack.
  f.ready();assert.equal((await second).delivered,true);
  assert.deepEqual(f.writes,["\x1b[200~FIRST\x1b[201~\r","\x1b[200~SECOND\x1b[201~\r"]);
});

test("an automation-owned paste-only draft can be extended and submitted in order",async t=>{
  const f=fixture(t);f.ready();
  const first=f.manager.deliverInput(f.child.id,agentPromptInput("kimi","FIRST",false),200);
  const second=send(f," SECOND");
  assert.equal((await first).delivered,true);assert.equal((await second).delivered,true);
  assert.deepEqual(f.writes,["\x1b[200~FIRST\x1b[201~","\x1b[200~ SECOND\x1b[201~\r"]);
});

test("queued requests preserve their original timeout, cancellation and launch generation",async t=>{
  const f=fixture(t);const abort=new AbortController();
  const first=send(f,"FIRST",200),timed=send(f,"TIMED",20),cancelled=send(f,"CANCELLED",200,abort.signal);
  abort.abort();assert.equal((await cancelled).delivered,false);
  assert.equal((await timed).delivered,false);
  f.ready();assert.equal((await first).delivered,true);
  await tick();assert.deepEqual(f.writes,["\x1b[200~FIRST\x1b[201~\r"]);
  const pending=send(f,"OBSOLETE",200);
  f.calls.at(-1).process.emitExit(0);f.manager.restart(f.child.id);f.ready();
  assert.equal((await pending).delivered,false);assert.deepEqual(f.writes,["\x1b[200~FIRST\x1b[201~\r"]);
});

test("person input revokes ownership of an automation draft in Kimi too",async t=>{
  const f=fixture(t);f.ready();
  assert.equal((await f.manager.deliverInput(f.child.id,agentPromptInput("kimi","draft",false),200)).delivered,true);
  f.manager.inputChecked(f.child.id,"human edit");
  f.calls.at(-1).process.emitData(READY.replace("│ >                          │","│ > draft human edit         │"));
  const count=f.writes.length;
  assert.equal((await send(f,"DO_NOT_APPEND",25)).delivered,false);
  assert.equal(f.writes.length,count);
});

test("zero-wait handoff can paste then submit an owned Kimi draft, but cannot wait or write late",async t=>{
  const f=fixture(t);f.ready();
  assert.equal((await f.manager.deliverInput(f.child.id,agentPromptInput("kimi","HANDOFF",false),0)).delivered,true);
  assert.equal((await f.manager.deliverInput(f.child.id,"\r",0)).delivered,true);
  assert.deepEqual(f.writes,["\x1b[200~HANDOFF\x1b[201~","\r"]);
  const fresh=fixture(t);
  assert.equal((await fresh.manager.deliverInput(fresh.child.id,"DO_NOT_QUEUE",0)).delivered,false);
  const blocked=send(fresh,"PENDING");
  assert.equal((await fresh.manager.deliverInput(fresh.child.id,"DO_NOT_QUEUE",0)).delivered,false);
  fresh.ready();assert.equal((await blocked).delivered,true);
  await tick();assert.deepEqual(fresh.writes,["\x1b[200~PENDING\x1b[201~\r"]);
});
