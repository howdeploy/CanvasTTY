import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_RUNTIME_ENV, CAPTURE_RESULT_ENV, MAX_RESULT_CHARS, normalizedActionHashFromHook } from "../src/agent-runtime/runtime-protocol.mjs";
import { finalAnswer } from "../src/agent-runtime/opencode-final-answer.mjs";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const POSIX = { skip: process.platform === "win32" ? "Unix socket test; the Windows pipe transport has its own suite." : false };

// Built at run time so the repository holds no key-shaped literal.
const FAKE_KEY = ["sk", "ant", "api03", "Zq7".repeat(14)].join("-");
const reply = (role, ...parts) => ({ info: { role }, parts });
const text = (value, extra = {}) => ({ type: "text", text: value, ...extra });

test("the plugin reads the session's last assistant reply, not a tool call or a synthetic part", async () => {
  const messages = [
    reply("user", text("fix the parser")),
    reply("assistant", text("Looking."), { type: "tool", tool: "bash" }),
    reply("assistant", { type: "reasoning", text: "hidden" }, text("Fixed the parser; tests pass."), text("<system>", { synthetic: true })),
    reply("user", text("thanks"))
  ];
  const v2 = { session: { messages: async (input) => (input.sessionID === "ses_1" ? { data: messages } : { data: [] }) } };
  assert.deepEqual(await finalAnswer(v2, "ses_1"), { text: "Fixed the parser; tests pass.", truncated: false });
  // The v1 SDK takes { path: { id } } and answers without the v2 shape first.
  const v1 = { session: { messages: async (input) => (input.path?.id === "ses_1" ? { data: messages } : { error: "bad request" }) } };
  assert.deepEqual(await finalAnswer(v1, "ses_1"), { text: "Fixed the parser; tests pass.", truncated: false });
  const long = `${"a".repeat(MAX_RESULT_CHARS)}THE END`;
  const cut = await finalAnswer({ session: { messages: async () => ({ data: [reply("assistant", text(long))] }) } }, "ses_1");
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, MAX_RESULT_CHARS);
  assert.ok(cut.text.endsWith("THE END"), "the end of a long answer is kept");
  assert.equal(await finalAnswer({ session: { messages: () => new Promise(() => {}) } }, "ses_1", 20), undefined, "a hung read gives up");
  assert.equal(await finalAnswer({ session: { messages: async () => { throw new Error("down"); } } }, "ses_1"), undefined);
  assert.equal(await finalAnswer(undefined, "ses_1"), undefined);
});

// A stand-in OpenCode process: CanvasTTY's plugin loaded the way OpenCode loads it, with a fake SDK client, fed
// the events OpenCode emits for one turn.
const FAKE_OPENCODE = `
const { CanvasTTYLifecycle } = await import(process.env.PLUGIN_URL);
const answer = JSON.parse(process.env.FAKE_ANSWER);
const client = { session: { messages: async ({ sessionID }) => ({ data: sessionID === "ses_root"
  ? [{ info: { role: "user" }, parts: [{ type: "text", text: "task" }] }, { info: { role: "assistant" }, parts: [{ type: "text", text: answer }] }]
  : [] }) } };
const hooks = await CanvasTTYLifecycle({ client });
await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_root" } } } });
await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_root", status: { type: "busy" } } } });
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } });
`;

function runFakeOpenCode(capability, answer, captureResult, script = FAKE_OPENCODE, extraEnv = {}, onCapture = null) {
  const env = {
    ...process.env, ...extraEnv,
    PLUGIN_URL: new URL("../src/agent-runtime/opencode-plugin.mjs", import.meta.url).href,
    FAKE_ANSWER: JSON.stringify(answer),
    [AGENT_RUNTIME_ENV.address]: capability.address,
    [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
    [AGENT_RUNTIME_ENV.provider]: capability.provider,
    [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
  };
  if (captureResult) env[CAPTURE_RESULT_ENV] = "1";
  else delete env[CAPTURE_RESULT_ENV];
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["pipe", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill(), 5_000);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    if (onCapture) child.stdout.once("data", () => {
      Promise.resolve().then(onCapture).then(() => child.stdin.end("continue"), error => { child.kill(); reject(error); });
    });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stderr }); });
  });
}

async function setupTerminals(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-ocr-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({ provider: "codex", cwd: root, profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  const control = new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 300, quietMs: 2_000 } });
  const handler = new ScopedOrchestrationHandler(control);
  const child = await handler.execute(orchestrator.id, { id: "1", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root } });
  return { root, calls, terminals, control, handler, orchestrator, childId: child.sessionId };
}

async function setup(t) {
  const fixture = await setupTerminals(t);
  const { terminals } = fixture;
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "ctty-rt-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const runtimeSignals=[];
  // What main/index.ts does with each runtime signal.
  const gateway = new RuntimeGateway({
    runtimeDirectory,
    onSignal: (id, signal) => {
      runtimeSignals.push(signal);
      const accepted = terminals.applyProviderSignal(id, { kind: "lifecycle", state: signal.state, event: signal.event, requestId: signal.turnId, threadId: signal.threadId });
      if (accepted && signal.result) terminals.recordAnswer(id, signal.result, {turnId: signal.turnId});
    }
  });
  await gateway.start();
  t.after(() => gateway.close());
  return {...fixture, gateway, runtimeSignals};
}

test("an OpenCode subagent's final reply reaches wait_for_agent and get_agent_result, masked", POSIX, async (t) => {
  const { calls, terminals, gateway, handler, orchestrator, childId } = await setup(t);
  assert.equal(calls.at(-1).options.env[CAPTURE_RESULT_ENV], undefined, "no runtime here: the fake process gets it below");
  // The spawn asked the launch to capture this subagent's answer.
  const capability = gateway.registerSession(childId, "opencode", true);
  // The screen of a full-screen TUI is redraw noise; the answer is not in it.
  calls.at(-1).process.emitData("\u001b[2J\u001b[H\u001b[38;5;245m┃ working…\u001b[0m");
  terminals.applyProviderSignal(childId, { kind: "lifecycle", state: "working" });
  const waiting = handler.execute(orchestrator.id, { id: "w", tool: "wait_for_agent", arguments: { sessionId: childId, timeoutSeconds: 10 } });
  const run = await runFakeOpenCode(capability, `Parser fixed in src/parse.ts; npm test passes. Key ${FAKE_KEY}`, true);
  assert.equal(run.code, 0, run.stderr);
  const waited = await waiting;
  assert.equal(waited.reason, "idle");
  assert.match(waited.answer.text, /^Parser fixed in src\/parse\.ts; npm test passes\./u);
  assert.ok(!waited.answer.text.includes(FAKE_KEY), "the answer is masked");
  const result = await handler.execute(orchestrator.id, { id: "r", tool: "get_agent_result", arguments: { sessionId: childId } });
  assert.deepEqual([result.state, result.status], ["running", "idle"]);
  assert.equal(result.answer.text, waited.answer.text);
  assert.equal(result.answer.truncated, false);
  // A new turn clears the previous answer until that turn reports its own.
  terminals.applyProviderSignal(childId, { kind: "lifecycle", state: "working" });
  const next = await handler.execute(orchestrator.id, { id: "r2", tool: "get_agent_result", arguments: { sessionId: childId } });
  assert.equal(next.answer, undefined);
});

test("without result capture the plugin sends no answer and the gateway accepts none", POSIX, async (t) => {
  const { gateway, handler, orchestrator, childId } = await setup(t);
  const capability = gateway.registerSession(childId, "opencode", false);
  const run = await runFakeOpenCode(capability, "private reply", false);
  assert.equal(run.code, 0, run.stderr);
  const result = await handler.execute(orchestrator.id, { id: "r", tool: "get_agent_result", arguments: { sessionId: childId } });
  assert.equal(result.answer, undefined);
});

test("an ordinary OpenCode card (not a subagent) never keeps an answer", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-opencode-plain-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([]));
  t.after(() => terminals.disposeAll());
  const card = terminals.create({ provider: "opencode", cwd: root, profile: "normal", position: { x: 0, y: 0 } });
  terminals.recordAnswer(card.id, { text: "reply", truncated: false });
  assert.equal(terminals.answer(card.id), null);
  assert.throws(() => terminals.create({ provider: "claude", cwd: root, profile: "normal", position: { x: 0, y: 0 } }, { captureResult: true }),
    /Codex or OpenCode/u);
});

test("wait_for_agent ignores an idle before the prompt's turn and returns that turn's answer", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-ocr-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([]));
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({ provider: "codex", cwd: root, profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 10, quietMs: 60_000 } }));
  const child = await handler.execute(orchestrator.id, { id: "1", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, prompt: "do part A" } });
  const wait = (timeoutSeconds) => handler.execute(orchestrator.id, { id: "w", tool: "wait_for_agent", arguments: { sessionId: child.sessionId, timeoutSeconds } });
  // OpenCode's session.created reports idle before the prompt's turn starts.
  terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "idle", event: "session.created" });
  const early = await wait(1);
  assert.deepEqual([early.reason, early.answer], ["timeout", undefined]);
  const waiting = wait(10);
  setTimeout(() => terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "working", event: "session.status:busy" }), 20);
  setTimeout(() => {
    terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "idle", event: "session.idle" });
    terminals.recordAnswer(child.sessionId, { text: "part A done", truncated: false });
  }, 40);
  const done = await waiting;
  assert.equal(done.reason, "idle");
  assert.deepEqual(done.answer, { text: "part A done", truncated: false });
});


test("OpenCode turn correlation rejects preceding answers and continuations across host submissions", async t => {
  const { terminals, childId } = await setupTerminals(t);
  const apply = (state, event, turnId, answer) => {
    const accepted = terminals.applyProviderSignal(childId, {state, event, requestId: turnId});
    if(accepted && answer) terminals.recordAnswer(childId, {text:answer,truncated:false}, {turnId});
    return accepted;
  };
  assert.equal(apply('working','session.status:busy','turn1'),true);
  assert.equal(apply('idle','session.idle','turn1','old answer'),true);
  const oldCapture = terminals.answerCaptureGeneration(childId);
  terminals.input(childId,'new task\r');
  assert.equal(apply('idle','session.idle','turn1','delayed old answer'),false);
  assert.equal(apply('working','permission.replied','turn1'),false,'old continuation cannot acknowledge new submit');
  terminals.recordAnswer(childId,{text:'uncorrelated old answer',truncated:false});
  terminals.recordAnswer(childId,{text:'delayed capture',truncated:false},{generation:oldCapture});
  assert.equal(terminals.answer(childId),null);
  assert.equal(apply('working','session.status:busy','turn2'),true);
  assert.equal(apply('idle','session.idle','turn1','late old after new start'),false);
  assert.equal(terminals.getMetadata(childId).status,'working');
  assert.equal(apply('needs_approval','permission.asked','turn2'),true);
  const permissionGeneration = terminals.answerCaptureGeneration(childId);
  terminals.input(childId,'y\r');
  assert.equal(terminals.answerCaptureGeneration(childId),permissionGeneration,'permission continuation is not a new task');
  assert.equal(apply('working','permission.replied','turn2'),true);
  assert.equal(apply('working','session.status:retry','turn2'),true);
  assert.equal(apply('idle','session.idle','turn2','new answer'),true);
  assert.equal(terminals.answer(childId).text,'new answer');
  apply('working','session.status:busy','turn3');
  terminals.input(childId,'interrupt current work\r');
  const starts = terminals.sessions.get(childId).turnStarts;
  assert.equal(apply('working','session.status:busy','turn4'),true);
  assert.equal(terminals.sessions.get(childId).turnStarts,starts+1,'new ID acknowledges a turn even while previous UI was working');
  assert.equal(terminals.turnProgress(childId).turnStartedSincePrompt,true);
  assert.equal(apply('idle','session.idle','turn3','interrupted answer'),false);
});

test("OpenCode result capture stays correlated with lifecycle UI disabled", POSIX, async t => {
  const {terminals,gateway,childId} = await setup(t);
  terminals.setLifecycleHooksEnabled(false);
  const capability=gateway.registerSession(childId,'opencode',true);
  const run=await runFakeOpenCode(capability,'captured without lifecycle UI',true,FAKE_OPENCODE,{CANVASTTY_LIFECYCLE_HOOKS_ENABLED:'0'});
  assert.equal(run.code,0,run.stderr);
  assert.equal(terminals.getMetadata(childId).status,'unavailable');
  assert.equal(terminals.answer(childId)?.text,'captured without lifecycle UI');
});

test("OpenCode async final answer keeps its ending turn and drops capture superseded by a new turn", POSIX, async t => {
  const {terminals,gateway,childId}=await setup(t);
  const capability=gateway.registerSession(childId,'opencode',true);
  const signals=[];
  const original=terminals.applyProviderSignal.bind(terminals);
  terminals.applyProviderSignal=(id,signal,...args)=>{signals.push(signal);return original(id,signal,...args);};
  const script=`
    const {CanvasTTYLifecycle}=await import(process.env.PLUGIN_URL);
    let resolveOld, started; const capturing=new Promise(done=>started=done);
    let reads=0;
    const client={session:{messages:async()=>{
      if(reads++===0){started();return new Promise(done=>resolveOld=done);}
      return {data:[{info:{role:'assistant'},parts:[{type:'text',text:'second answer'}]}]};
    }}};
    const hooks=await CanvasTTYLifecycle({client});
    const event=(type,rest={})=>hooks.event({event:{type,properties:{sessionID:'root',...rest}}});
    await event('session.created',{info:{id:'root'}});
    await event('session.status',{status:{type:'busy'}});
    await event('session.status',{status:{type:'idle'}});
    const old=event('session.idle');await capturing;
    await event('session.status',{status:{type:'busy'}});
    resolveOld({data:[{info:{role:'assistant'},parts:[{type:'text',text:'old delayed answer'}]}]});
    await old;
    await event('permission.asked');await event('permission.replied');
    await event('session.status',{status:{type:'retry'}});
    await event('session.status',{status:{type:'idle'}});
    await event('session.idle');
  `;
  const run=await runFakeOpenCode(capability,'unused',true,script);
  assert.equal(run.code,0,run.stderr);
  const starts=signals.filter(s=>s.event==='session.status:busy');
  assert.equal(starts.length,2);assert.notEqual(starts[0].requestId,starts[1].requestId);
  const ends=signals.filter(s=>s.event==='session.idle');
  assert.equal(ends.length,1,'superseded async answer must not emit idle or stop');
  assert.equal(ends[0].requestId,starts[1].requestId,'status:idle preserves ending turn ID');
  assert.equal(signals.find(s=>s.event==='permission.replied').requestId,starts[1].requestId);
  assert.equal(signals.find(s=>s.event==='session.status:retry').requestId,starts[1].requestId);
  assert.equal(terminals.answer(childId).text,'second answer');
});


test("a delayed plugin capture before the next busy event cannot restore the preceding answer", POSIX, async t => {
  const {terminals,gateway,childId,handler,orchestrator}=await setup(t);
  const capability=gateway.registerSession(childId,'opencode',true);
  const script=`
    const {CanvasTTYLifecycle}=await import(process.env.PLUGIN_URL);
    const client={session:{messages:async()=>{
      process.stdout.write('capturing');
      await new Promise(done=>process.stdin.once('data',done));
      return {data:[{info:{role:'assistant'},parts:[{type:'text',text:'late preceding answer'}]}]};
    }}};
    const hooks=await CanvasTTYLifecycle({client});
    const event=(type,rest={})=>hooks.event({event:{type,properties:{sessionID:'root',...rest}}});
    await event('session.created',{info:{id:'root'}});
    await event('session.status',{status:{type:'busy'}});
    await event('session.idle');
  `;
  const run=await runFakeOpenCode(capability,'unused',true,script,{},()=>terminals.input(childId,'next task\r'));
  assert.equal(run.code,0,run.stderr);
  const result=await handler.execute(orchestrator.id,{id:'poll',tool:'get_agent_result',arguments:{sessionId:childId}});
  assert.equal(result.answer,undefined);
  assert.equal(terminals.turnProgress(childId).turnStartedSincePrompt,false,'late old idle does not acknowledge the next prompt');
});


test("disabled lifecycle UI keeps permission continuations and duplicate working events in the same turn", async t => {
  const {terminals,childId}=await setupTerminals(t);
  terminals.setLifecycleHooksEnabled(false);
  const apply=(state,event,turnId)=>terminals.applyProviderSignal(childId,{state,event,requestId:turnId});
  assert.equal(apply('working','session.status:busy','turn1'),true);
  const starts=terminals.sessions.get(childId).turnStarts;
  assert.equal(apply('working','session.status:busy','turn1'),true);
  assert.equal(apply('working','session.status:retry','turn1'),true);
  assert.equal(terminals.sessions.get(childId).turnStarts,starts,'duplicate working/retry is not another start while UI remains unavailable');
  assert.equal(apply('needs_approval','permission.asked','turn1'),true);
  assert.equal(terminals.getMetadata(childId).status,'unavailable');
  const generation=terminals.answerCaptureGeneration(childId);
  terminals.input(childId,'y\r');
  assert.equal(terminals.answerCaptureGeneration(childId),generation,'permission input preserves the accepted provider turn with UI disabled');
  assert.equal(apply('working','permission.replied','turn1'),true);
  assert.equal(terminals.turnProgress(childId).turnStartedSincePrompt,true,'accepted continuation acknowledges permission input');
  const continuedStarts=terminals.sessions.get(childId).turnStarts;
  assert.equal(apply('working','session.status:retry','turn1'),true);
  assert.equal(terminals.sessions.get(childId).turnStarts,continuedStarts);
  assert.equal(apply('idle','session.idle','turn1'),true);
  terminals.recordAnswer(childId,{text:'answer after approval',truncated:false},{turnId:'turn1'});
  assert.equal(terminals.answer(childId).text,'answer after approval');
  assert.equal(terminals.getMetadata(childId).status,'unavailable');
  terminals.input(childId,'next task\r');
  assert.equal(terminals.answerCaptureGeneration(childId),generation+1);
  assert.equal(apply('working','permission.replied','turn1'),false);
});


test("captured status idle waits for the SDK answer before actual result polling can start review", POSIX, async t=>{
  const {terminals,gateway,control,childId}=await setup(t);
  control.reviewRequested.add(childId);
  let reviews=0;
  control.performReview=async()=>{reviews++;assert.equal(terminals.answer(childId)?.text,'captured after delay');return {status:'accepted',costUsd:null};};
  const capability=gateway.registerSession(childId,'opencode',true);
  const script=`
    const {CanvasTTYLifecycle}=await import(process.env.PLUGIN_URL);
    const client={session:{messages:async()=>{
      process.stdout.write('capturing');await new Promise(done=>process.stdin.once('data',done));
      return {data:[{info:{role:'assistant'},parts:[{type:'text',text:'captured after delay'}]}]};
    }}};
    const hooks=await CanvasTTYLifecycle({client});
    const event=(type,rest={})=>hooks.event({event:{type,properties:{sessionID:'root',...rest}}});
    await event('session.created',{info:{id:'root'}});
    await event('session.status',{status:{type:'busy'}});
    await event('session.status',{status:{type:'idle'}});
    await event('session.idle');
  `;
  const run=await runFakeOpenCode(capability,'unused',true,script,{},async()=>{
    const result=await control.resultWithReview(childId,{deferReview:true});
    assert.equal(result.status,'working');assert.equal(result.review.status,'pending');assert.equal(reviews,0);
  });
  assert.equal(run.code,0,run.stderr);
  const result=await control.resultWithReview(childId);
  assert.equal(result.review.status,'accepted');assert.equal(reviews,1);assert.equal(result.answer.text,'captured after delay');
});

for(const failure of ['error','timeout'])test(`captured OpenCode idle completes without an answer after SDK ${failure}`,POSIX,async t=>{
  const {terminals,gateway,childId}=await setup(t);
  terminals.setLifecycleHooksEnabled(false);
  const accepted=[];const apply=terminals.applyProviderSignal.bind(terminals);
  terminals.applyProviderSignal=(id,signal,...args)=>{accepted.push(signal);return apply(id,signal,...args);};
  const capability=gateway.registerSession(childId,'opencode',true);
  const script=`
    const {CanvasTTYLifecycle}=await import(process.env.PLUGIN_URL);
    const client={session:{messages:async()=>{${failure==='error'?'throw new Error("fixture failed");':'return new Promise(()=>{});'}}}};
    const hooks=await CanvasTTYLifecycle({client});
    const event=(type,rest={})=>hooks.event({event:{type,properties:{sessionID:'root',...rest}}});
    await event('session.created',{info:{id:'root'}});await event('session.status',{status:{type:'busy'}});
    await event('session.status',{status:{type:'idle'}});await event('session.idle');
  `;
  const run=await runFakeOpenCode(capability,'unused',true,script,{CANVASTTY_LIFECYCLE_HOOKS_ENABLED:'0'});
  assert.equal(run.code,0,run.stderr);
  assert.equal(accepted.filter(s=>s.event==='session.status:idle').length,0);
  assert.equal(accepted.filter(s=>s.event==='session.idle').length,1,'bounded empty completion remains observable with UI disabled');
  assert.equal(terminals.answer(childId),null);
});


test("OpenCode completed turns get distinct IDs and advance the host epoch without reopening stale IDs", POSIX, async t => {
 const {terminals,gateway,childId,runtimeSignals}=await setup(t),capability=gateway.registerSession(childId,'opencode',true);
 const starts=[],apply=terminals.applyProviderSignal.bind(terminals);
 terminals.applyProviderSignal=(id,signal,...args)=>{if(signal.event==='session.status:busy')starts.push(signal.requestId);return apply(id,signal,...args);};
 const script=`
  const {CanvasTTYLifecycle}=await import(process.env.PLUGIN_URL);
  let turn=0;
  const hooks=await CanvasTTYLifecycle({client:{session:{messages:async()=>({data:[{info:{role:'assistant'},parts:[{type:'text',text:'answer '+turn}]}]})}}});
  const event=(type,rest={})=>hooks.event({event:{type,properties:{sessionID:'root',...rest}}});
  await event('session.created',{info:{id:'root'}});
  for(turn=1;turn<=2;turn++) {
   await event('session.status',{status:{type:'busy'}});
   await event('session.status',{status:{type:'idle'}});
   await event('session.idle');
  }
 `;
 const run=await runFakeOpenCode(capability,'unused',true,script);
 assert.equal(run.code,0,run.stderr);assert.equal(starts.length,2);assert.notEqual(starts[0],starts[1]);
 assert.deepEqual(runtimeSignals.filter(s=>s.event==='session.status:busy').map(s=>s.turnEpoch),[1,2]);
 assert.equal(gateway.currentTurnEpoch(childId),null,'completed turn has no active epoch');assert.equal(terminals.answer(childId).text,'answer 2');
 assert.equal(terminals.getMetadata(childId).status,'idle');
});


test("OpenCode direct tool hooks and real ToolPart errors produce one correlated hash-only outcome", {...POSIX,timeout:15000}, async t => {
  const {gateway,childId,runtimeSignals}=await setup(t);
  const capability=gateway.registerSession(childId,"opencode",true);
  const script=`
    const {CanvasTTYLifecycle}=await import(process.env.PLUGIN_URL);
    const hooks=await CanvasTTYLifecycle({});
    const event=(type,properties)=>hooks.event({event:{type,properties}});
    await event("session.created",{info:{id:"ses_root"}});
    await event("session.status",{sessionID:"ses_root",status:{type:"busy"}});
    const input=(callID,tool="bash",sessionID="ses_root")=>({callID,tool,sessionID});
    const args={command:"private command with credentials"};
    const before=async(callID,tool="bash",sessionID="ses_root")=>hooks["tool.execute.before"](input(callID,tool,sessionID),{args});
    const after=(callID,output,tool="bash",sessionID="ses_root")=>hooks["tool.execute.after"]({...input(callID,tool,sessionID),args},output);
    const part=(callID,state,sessionID="ses_root")=>event("message.part.updated",{sessionID,part:{id:"part-"+callID,messageID:"message",sessionID,type:"tool",callID,tool:"bash",state:{input:args,...state}},time:Date.now()});
    await before("ok");
    await Promise.all([after("ok",{title:"private title",output:"private output",metadata:{exit:0}}),
      part("ok",{status:"completed",title:"private title",output:"private output",metadata:{exit:0}})]);
    await before("nonzero"); await after("nonzero",{output:"private shell error",metadata:{exit:2}});
    await before("timeout"); await after("timeout",{output:"private partial output",metadata:{exit:null}});
    await before("throw"); await after("throw",undefined);
    await part("throw",{status:"error",error:"private thrown error",time:{start:1,end:2}});
    await part("throw",{status:"error",error:"private thrown error"});
    await before("child","bash","child"); await after("child",{output:"child output",metadata:{exit:0}},"bash","child");
    await part("child",{status:"error",error:"child error"},"child");
    await after("unseen",{output:"unseen output",metadata:{exit:0}});
    await before("old");
    await event("session.status",{sessionID:"ses_root",status:{type:"idle"}});
    await event("session.status",{sessionID:"ses_root",status:{type:"busy"}});
    await after("old",{output:"late old output",metadata:{exit:0}});
    await part("old",{status:"error",error:"late old error"});
    await before("fresh"); await after("fresh",{output:"private output",metadata:{exit:0}});
    await before("file","write"); await after("file",{output:"written",metadata:{filepath:"/private/hidden-file"}},"write");
    await event("session.idle",{sessionID:"ses_root"});
  `;
  const run=await runFakeOpenCode(capability,"",false,script);
  assert.equal(run.code,0,run.stderr);
  const outcomes=runtimeSignals.filter(signal=>signal.toolOutcome);
  assert.deepEqual(outcomes.map(signal=>signal.toolOutcome.resultClass),["success","error","unknown","error","success","success"]);
  assert.deepEqual(outcomes.map(signal=>signal.event),["tool.execute.after","tool.execute.after","tool.execute.after","message.part.updated","tool.execute.after","tool.execute.after"]);
  assert.equal(new Set(outcomes.slice(0,4).map(signal=>signal.turnEpoch)).size,1);
  assert.ok(outcomes[4].turnEpoch>outcomes[0].turnEpoch,"completion does not fabricate a new turn, next real busy does");
  for(const {toolOutcome:outcome} of outcomes) {
    assert.match(outcome.normalizedActionHash,/^[a-f0-9]{64}$/u);
    assert.ok(JSON.stringify(outcome).length<1000);
  }
  assert.equal(outcomes[0].toolOutcome.normalizedActionHash,outcomes[4].toolOutcome.normalizedActionHash);
  assert.equal(outcomes[0].toolOutcome.normalizedActionHash,normalizedActionHashFromHook("bash",{command:"private command with credentials"}),"same action identity as permission pretool");
  assert.equal(outcomes[0].toolOutcome.outputHash,outcomes[4].toolOutcome.outputHash);
  assert.match(outcomes[1].toolOutcome.errorHash,/^[a-f0-9]{64}$/u);
  assert.match(outcomes[3].toolOutcome.errorHash,/^[a-f0-9]{64}$/u);
  assert.equal(outcomes[5].toolOutcome.changedPathHashes.length,1);
  for(const secret of ["private command","private title","private output","private shell error","private thrown error","hidden-file","late old"])
    assert.ok(!JSON.stringify(runtimeSignals).includes(secret),secret+" never crosses runtime wire");
});
