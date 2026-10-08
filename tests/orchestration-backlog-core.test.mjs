import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { OrchestrationBudgetService } from "../src/main/services/OrchestrationBudgetService.ts";
import { ProcessTreePause } from "../src/main/services/ProcessTreePause.ts";
import { refreshOrchestrationUsage, refreshOrchestrationUsageBatch } from "../src/main/services/OrchestrationUsageSync.ts";
import { SessionTimelineService } from "../src/main/services/SessionTimelineService.ts";
import { OrchestrationTaskBoard } from "../src/main/services/OrchestrationTaskBoard.ts";
import { OrchestrationTemplateService } from "../src/main/services/OrchestrationTemplateService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const at = { x: 0, y: 0 };
async function temp(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function manager(t) {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  return { terminals, calls };
}

test("task board serializes competing claims and preserves person-controlled closure overrides", async (t) => {
  const root = await temp(t, "ctty-board-");
  const project = join(root, "project");
  const storage = join(root, "userdata");
  const board = new OrchestrationTaskBoard(storage);
  const taskRoot = randomUUID();
  const task = await board.addTask(project, taskRoot, taskRoot, { title: "Concurrent task" });
  const claimers = [randomUUID(), randomUUID()];
  const claims = await Promise.allSettled(claimers.map((id, index) => board.claimTask(project, taskRoot, id, `Agent ${index + 1}`, task.id)));
  assert.equal(claims.filter((item) => item.status === "fulfilled").length, 1);
  const loser = claims.find((item) => item.status === "rejected");
  assert.match(loser.reason.message, /already claimed by Agent [12]/u);
  const winnerId = claims.find((item) => item.status === "fulfilled").value.ownerSessionId;
  await board.completeTask(project, taskRoot, winnerId, task.id, "Done");
  await board.closeTask(project, taskRoot, task.id);
  await assert.rejects(board.updateTask(project, taskRoot, taskRoot, task.id, { status: "open" }), /closed/u,
    "the orchestrator cannot undo the person's closed task");
  await assert.rejects(board.updateTask(project, taskRoot, winnerId, task.id, { title: "Override" }), /closed/u);
  await board.assignTask(project, taskRoot, task.id, winnerId, "Agent 1");
  const restored = new OrchestrationTaskBoard(storage);
  const persisted = await restored.listTasks(project, taskRoot);
  assert.deepEqual(persisted.tasks.map(({ title, status }) => [title, status]), [["Concurrent task", "claimed"]]);
});

test("task board tools are visible to subagents without granting spawn tools", async (t) => {
  const root = await temp(t, "ctty-board-tools-");
  const { terminals } = manager(t);
  const orchestrator = terminals.create({ provider: "codex", profile: "normal", cwd: root, position: at, role: "orchestrator" });
  const control = new AgentControlService(terminals);
  const child = await control.spawn({ parentSessionId: orchestrator.id, provider: "opencode", cwd: root });
  const handler = new ScopedOrchestrationHandler(control, null, undefined, { taskBoard: new OrchestrationTaskBoard(join(root, "userdata")) });
  const tools = handler.listTools(child.id).map((tool) => tool.name);
  assert.deepEqual(tools, ["list_tasks", "claim_task", "update_task", "complete_task"]);
  const reviewer = await control.spawn({ parentSessionId: orchestrator.id, provider: "opencode", cwd: root, profile: "plan", readOnlyReview: true });
  assert.deepEqual(handler.listTools(reviewer.id), []);
  await assert.rejects(handler.execute(reviewer.id, { id: "review-call", tool: "list_tasks", arguments: {} }), /Read-only reviewers cannot call/u);
});

test("same-card retries retain their finite allowance and concurrent requests create only one successor", async (t) => {
  const root = await temp(t, "ctty-retry-cleanup-");
  const { terminals, calls } = manager(t);
  const orchestrator = terminals.create({ provider: "codex", profile: "normal", cwd: root, position: at, role: "orchestrator" });
  const turnEpochs = new Map();
  const control = new AgentControlService(terminals, { currentTurnEpoch: id => turnEpochs.get(id) ?? null });
  const original = await control.spawn({ parentSessionId: orchestrator.id, provider: "opencode", cwd: root });
  const originalProcess = calls.at(-1).process;
  originalProcess.kill = () => originalProcess.emitExit(143);
  turnEpochs.set(original.id, 1);
  assert.equal(control.markLoopDetected(original.id), true);
  assert.equal(control.observe(original.id).loopDetected, true, "a current-turn warning remains observable");
  turnEpochs.set(original.id, 2);
  assert.equal(control.observe(original.id).loopDetected, undefined, "a completed turn's warning is no longer observable");
  await assert.rejects(control.retry(original.id), /running agent must finish or be canceled/u, "a prior-turn loop does not permit retry");
  assert.equal(control.markLoopDetected(original.id), true);
  assert.equal(control.observe(original.id).loopDetected, true);
  const firstRetry = await control.retry(original.id);
  assert.equal(firstRetry.id, original.id);
  assert.equal(control.observe(firstRetry.id).loopDetected, undefined, "the old launch warning must not mark the fresh process");
  await assert.rejects(control.retry(firstRetry.id), /running agent must finish or be canceled/u, "a stale loop warning cannot authorize another retry");
  calls.at(-1).process.emitExit(1);
  const secondRetry = await control.retry(firstRetry.id);
  calls.at(-1).process.emitExit(1);
  await assert.rejects(control.retry(secondRetry.id), /limit of 2 retries/u);

  const parallelOriginal = await control.spawn({ parentSessionId: orchestrator.id, provider: "opencode", cwd: root });
  calls.at(-1).process.emitExit(1);
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => control.retry(parallelOriginal.id)));
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  for (const attempt of attempts.filter((attempt) => attempt.status === "rejected")) assert.match(attempt.reason.message, /retry of this agent is already in progress/u);
});

test("duration budget trips once and blocks input to the root without killing its PTY", async (t) => {
  const root = await temp(t, "ctty-budget-");
  const { terminals, calls } = manager(t);
  const orchestrator = terminals.create({ provider: "codex", profile: "normal", cwd: root, position: at, role: "orchestrator" });
  const events = [];
  const budget = new OrchestrationBudgetService(join(root, "budgets.json"), {
    onWarning: (snapshot) => events.push(["warning", snapshot.rootSessionId]),
    onPause: (snapshot) => events.push(["pause", snapshot.rootSessionId])
  });
  await budget.load();
  const snapshot = await budget.setLimits(orchestrator.id, { tokens: null, costUsd: null, durationMs: 1 }, orchestrator.startedAt - 10);
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.data.tokens, "none");
  assert.deepEqual(events, [["warning", orchestrator.id], ["pause", orchestrator.id]]);
  const control = new AgentControlService(terminals, { budget });
  assert.throws(() => control.assertInputAllowed(orchestrator.id), /Budget reached: time limit/u);
  assert.throws(() => control.spawn({ parentSessionId: orchestrator.id, provider: "opencode", cwd: root }), /Budget reached: time limit/u);
  assert.equal(terminals.getMetadata(orchestrator.id).exitCode, null);
  assert.ok(calls.length >= 1);
  const restored = new OrchestrationBudgetService(join(root, "budgets.json"));
  await restored.load();
  assert.equal(restored.snapshot(orchestrator.id, orchestrator.startedAt - 10).paused, true);
});

test("cost budgets retain known spending and pause on missing prices; repricing can lower cost", async (t) => {
  const dir=await temp(t,"ctty-money-budget-");
  const budget=new OrchestrationBudgetService(join(dir,"budget.json"));await budget.load();t.after(()=>budget.dispose());
  await budget.setLimits("root",{tokens:null,costUsd:10,durationMs:null},Date.now());
  budget.recordSessionUsage("root","known",{tokens:100,costUsd:4});
  budget.recordSessionUsage("root","unknown",{tokens:100,costUsd:null});
  assert.equal(budget.snapshot("root").usage.costUsd,4);
  assert.equal(budget.snapshot("root").data.costUsd,"partial");
  assert.equal(budget.snapshot("root").paused,true);
  assert.match(budget.snapshot("root").reason,/costs are unavailable/u);
  budget.recordSessionUsage("root","known",{tokens:100,costUsd:2});
  budget.recordSessionUsage("root","unknown",{tokens:100,costUsd:1});
  assert.equal(budget.snapshot("root").usage.costUsd,3);
  await budget.setLimits("root",{tokens:null,costUsd:10,durationMs:null});
  assert.equal(budget.snapshot("root").paused,false);
  const automaticRoot = "automatic-recovery";
  await budget.setLimits(automaticRoot,{tokens:null,costUsd:10,durationMs:null});
  budget.recordSessionUsage(automaticRoot,"counter",{tokens:100,costUsd:12});
  assert.equal(budget.snapshot(automaticRoot).paused,true,"observed spend at the limit creates a hard pause");
  budget.recordSessionUsage(automaticRoot,"counter",{tokens:100,costUsd:2});
  assert.equal(budget.snapshot(automaticRoot).paused,true,"repricing below the limit does not release a hard-limit pause");

  await budget.setLimits(automaticRoot,{tokens:null,costUsd:10,durationMs:null});
  budget.recordSessionUsage(automaticRoot,"counter",{tokens:100,costUsd:null});
  assert.equal(budget.snapshot(automaticRoot).paused,true,"unpriced observed spend pauses for cost data");
  budget.setEnforcementFailure(automaticRoot,"The process tree could not be suspended.");
  budget.recordSessionUsage(automaticRoot,"counter",{tokens:100,costUsd:2});
  assert.equal(budget.snapshot(automaticRoot).paused,true,"an enforcement failure remains latched when data becomes complete");
  budget.setEnforcementFailure(automaticRoot,undefined);
  assert.equal(budget.snapshot(automaticRoot).paused,true,"clearing the enforcement error does not silently reset the pause");
  await budget.flush();
});

test("provisional launch usage does not pause a cost budget; first usage replaces its placeholder and observed pricing recovers automatically",async(t)=>{
  const dir=await temp(t,"ctty-provisional-budget-");
  const timeline=new SessionTimelineService(dir,text=>text);await timeline.load();
  const budget=new OrchestrationBudgetService(join(dir,"budget.json"));await budget.load();t.after(()=>budget.dispose());
  await budget.setLimits("root",{tokens:null,costUsd:10,durationMs:null});
  let snapshot=refreshOrchestrationUsage(budget,timeline,"root",Date.now(),["root","new-agent"],[]);
  assert.equal(snapshot.paused,false,"the real refresh path treats newly launched agents as provisional before usage");
  assert.equal(snapshot.remaining.costUsd,null,"the UI does not present an exact remaining cost before first usage");
  assert.equal(snapshot.data.costUsd,"none");
  await budget.flush();
  let persisted=JSON.parse(await readFile(join(dir,"budget.json"),"utf8"));
  assert.equal(Object.values(persisted.budgets.root.sessions).filter(row=>row.provisional===true).length,2,
    "the host-generated provisional markers are serialized for both active sessions");
  const restored=new OrchestrationBudgetService(join(dir,"budget.json"));await restored.load();t.after(()=>restored.dispose());
  assert.equal(restored.snapshot("root").paused,false,"persisted provisional launch state remains distinct after reload");
  await timeline.recordCumulativeUsage("history-agent",{input:50,output:0,total:50},"provider-hook","history-thread",{taskId:"root"});
  await timeline.recordCumulativeUsage("new-agent",{input:100,output:0,total:100},"provider-hook","thread-1",{taskId:"root"});
  snapshot=refreshOrchestrationUsage(budget,timeline,"root",Date.now(),["root","new-agent"],[]);
  assert.equal(snapshot.paused,true,"an observed counter without a usable price still fails closed");
  assert.match(snapshot.reason,/costs are unavailable/u);
  await budget.flush();
  persisted=JSON.parse(await readFile(join(dir,"budget.json"),"utf8"));
  assert.equal(Object.values(persisted.budgets.root.sessions).filter(row=>row.provisional===true).length,1,
    "the first observed counter replaces that agent's provisional placeholder");
  await timeline.recordCumulativeUsage("new-agent",{input:100,output:0,total:100,costUsd:2},"provider-hook","thread-1",{taskId:"root"});
  snapshot=refreshOrchestrationUsage(budget,timeline,"root",Date.now(),["root","new-agent"],[]);
  assert.equal(snapshot.usage.costUsd,2,"a known new counter contributes even while older observed history is unpriced");
  assert.equal(snapshot.paused,true,"a known new counter cannot hide unpriced observed history");
  assert.equal(snapshot.data.costUsd,"partial");
  await timeline.recordCumulativeUsage("history-agent",{input:50,output:0,total:50,costUsd:1},"provider-hook","history-thread",{taskId:"root"});
  snapshot=refreshOrchestrationUsage(budget,timeline,"root",Date.now(),["root","new-agent"],[]);
  assert.equal(snapshot.paused,false,"pricing both observed counters clears a data-only pause without changing the limit");
  assert.equal(snapshot.usage.costUsd,3,"both the historical and new counter costs remain in the total");
  assert.equal(budget.snapshot("root").limits.costUsd,10);
  assert.equal(snapshot.data.costUsd,"partial","the still-unobserved root remains visible as provisional data");
  await budget.flush();
});

test("a legacy pending launch row can be identified without auto-clearing its unclassified pause",async(t)=>{
  const dir=await temp(t,"ctty-budget-legacy-pending-");
  const startedAt=Date.now();
  await writeFile(join(dir,"budget.json"),JSON.stringify({version:1,budgets:{root:{startedAt,
    sessions:{pending:{tokens:null,costUsd:null}},limits:{tokens:null,costUsd:10,durationMs:null},tokens:null,costUsd:null,
    reportedAt:startedAt,warned:false,paused:true}}}));
  const budget=new OrchestrationBudgetService(join(dir,"budget.json"));await budget.load();t.after(()=>budget.dispose());
  budget.recordSessionUsage("root","pending",{tokens:null,costUsd:null},{rootStartedAt:startedAt,provisional:true});
  assert.equal(budget.snapshot("root").paused,true,"an old pause without a recorded cause remains latched");
  assert.match(budget.snapshot("root").reason,/pause remains active/u);
  await budget.flush();
  const restored=new OrchestrationBudgetService(join(dir,"budget.json"));await restored.load();t.after(()=>restored.dispose());
  await restored.setLimits("root",{tokens:null,costUsd:10,durationMs:null},startedAt);
  assert.equal(restored.snapshot("root").paused,false,"the person can explicitly recalculate a legacy pause without changing the limit");
  assert.equal(restored.snapshot("root").limits.costUsd,10);
});

test("task budget deltas reprice from the indexed journal after restart",async(t)=>{
  const dir=await temp(t,"ctty-budget-delta-reprice-");
  let now=Date.now()-2*86400_000;
  const timeline=new SessionTimelineService(dir,text=>text,200*1024*1024,()=>now);await timeline.load();
  const context={provider:"codex",model:"priced-model",accountId:"account-a",taskId:"root"};
  await timeline.recordCumulativeUsage("old-card",{input:800,output:200,total:1_000},"codex-cli","continued-thread",context);
  now+=1;
  await timeline.recordCumulativeUsage("resumed-card",{input:1_120,output:280,total:1_400},"codex-cli","continued-thread",context);
  const budget=new OrchestrationBudgetService(join(dir,"budget.json"));await budget.load();t.after(()=>budget.dispose());
  await budget.setLimits("root",{tokens:null,costUsd:10,durationMs:null});
  const missing=refreshOrchestrationUsage(budget,timeline,"root",Date.now(),["old-card","resumed-card"],[]);
  assert.equal(missing.paused,true,"observed usage with no usable price remains fail-closed");
  assert.equal(missing.usage.costUsd,null);
  const restoredTimeline=new SessionTimelineService(dir,text=>text);await restoredTimeline.load();
  const firstPrices=[{provider:"codex",model:"priced-model",inputPerMillion:10,outputPerMillion:20}];
  const repriced=refreshOrchestrationUsage(budget,restoredTimeline,"root",Date.now(),["old-card","resumed-card"],firstPrices);
  assert.equal(repriced.paused,false,"adding usable prices resolves only the recoverable cost-data pause");
  assert.equal(repriced.usage.tokens,1_400);
  assert.ok(Math.abs((repriced.usage.costUsd ?? -1)-0.0168)<1e-12);
  const lower=refreshOrchestrationUsage(budget,restoredTimeline,"root",Date.now(),["old-card","resumed-card"],
    [{provider:"codex",model:"priced-model",inputPerMillion:5,outputPerMillion:10}]);
  assert.ok(Math.abs((lower.usage.costUsd ?? -1)-0.0084)<1e-12,"a price change recalculates compact per-event deltas");
  assert.equal(budget.snapshot("root").limits.costUsd,10);
  await budget.flush();
});

test("many task budgets share timeline passes and retain legacy, resumed, and repriced usage after reload",async(t)=>{
  const dir=await temp(t,"ctty-budget-refresh-batch-");
  const timeline=new SessionTimelineService(dir,text=>text);await timeline.load();
  const roots=Array.from({length:24},(_,index)=>({
    rootSessionId:`root-${index}`,
    // This fixture has no duration limit; null snapshot duration keeps serial/batch snapshots deterministic.
    rootStartedAt:Number.NaN,
    memberSessionIds:[`legacy-${index}`,`old-${index}`,`resumed-${index}`,`priced-old-${index}`,`priced-resumed-${index}`,
      ...(index===0?["reset-0"]:[]),`idle-${index}`]
  }));
  const refreshScopes=[...roots.slice(0,12),{rootSessionId:"unlimited-between-roots",rootStartedAt:Number.NaN,memberSessionIds:["idle-unlimited"],budgetEnabled:false},...roots.slice(12)];
  const firstPrices=[
    {provider:"codex",model:"priced-model",inputPerMillion:10,outputPerMillion:20},
    {provider:"codex",model:"unused-model",inputPerMillion:1,outputPerMillion:1}
  ];
  const budget=new OrchestrationBudgetService(join(dir,"batch-budget.json"));await budget.load();t.after(()=>budget.dispose());
  const serialBudget=new OrchestrationBudgetService(join(dir,"serial-budget.json"));await serialBudget.load();t.after(()=>serialBudget.dispose());
  for(const scope of roots) {
    await budget.setLimits(scope.rootSessionId,{tokens:null,costUsd:10,durationMs:null});
    await serialBudget.setLimits(scope.rootSessionId,{tokens:null,costUsd:10,durationMs:null});
  }
  assert.equal(budget.hasLimits("root-0"),true);
  assert.equal(budget.hasLimits("unlimited-between-roots"),false);
  refreshOrchestrationUsageBatch(budget,timeline,roots,firstPrices); // Persist launch placeholders before any provider usage.
  for(const scope of roots)refreshOrchestrationUsage(serialBudget,timeline,scope.rootSessionId,scope.rootStartedAt,scope.memberSessionIds,firstPrices);

  const resetContext={provider:"codex",model:"reported-model",accountId:"account-a",taskId:"root-0"};
  await timeline.recordCumulativeUsage("reset-0",{input:800,output:200,total:1_000,costUsd:0.1},"codex-cli","reset-thread",resetContext);
  let reset=refreshOrchestrationUsage(budget,timeline,"root-0",Number.NaN,["reset-0"],[]);
  assert.equal(reset.usage.tokens,1_000);
  assert.ok(Math.abs(reset.usage.costUsd-0.1)<1e-12);
  await timeline.recordCumulativeUsage("reset-0",{input:80,output:20,total:100,costUsd:0.01},"codex-cli","reset-thread",resetContext);
  reset=refreshOrchestrationUsage(budget,timeline,"root-0",Number.NaN,["reset-0"],[]);
  assert.equal(reset.usage.tokens,1_100,"the reset epoch adds to the first cumulative sample");
  await timeline.recordCumulativeUsage("reset-0",{input:400,output:100,total:500,costUsd:0.05},"codex-cli","reset-thread",resetContext);
  reset=refreshOrchestrationUsage(budget,timeline,"root-0",Number.NaN,["reset-0"],[]);
  assert.equal(reset.usage.tokens,1_500,"post-reset increases remain in budget usage");
  assert.ok(Math.abs(reset.usage.costUsd-0.15)<1e-12,"reported spend from every reset epoch is retained");
  const resetReload=new SessionTimelineService(dir,text=>text);await resetReload.load();
  const rebuiltReset=refreshOrchestrationUsage(serialBudget,resetReload,"root-0",Number.NaN,["reset-0"],[]);
  assert.equal(rebuiltReset.usage.tokens,1_500,"the startup scan rebuilds reset epochs from the journal");
  assert.ok(Math.abs(rebuiltReset.usage.costUsd-0.15)<1e-12);

  for(let index=0;index<roots.length;index++) {
    const {rootSessionId}=roots[index];
    await timeline.recordUsage(`legacy-${index}`,7,3,"legacy-cli",0.001);
    await timeline.recordCumulativeUsage(`old-${index}`,{input:80,output:20,total:100,costUsd:0.01},"codex-cli",`thread-${index}`,
      {provider:"codex",model:"reported-model",accountId:"account-a",taskId:rootSessionId});
    await timeline.recordCumulativeUsage(`resumed-${index}`,{input:120,output:30,total:150,costUsd:0.015},"codex-cli",`thread-${index}`,
      {provider:"codex",model:"reported-model",accountId:"account-a",taskId:rootSessionId});
    await timeline.recordCumulativeUsage(`priced-old-${index}`,{input:50,output:20,total:70,costUsd:null},"codex-cli",`priced-${index}`,
      {provider:"codex",model:"priced-model",accountId:"account-a",taskId:rootSessionId});
    await timeline.recordCumulativeUsage(`priced-resumed-${index}`,{input:70,output:30,total:100,costUsd:null},"codex-cli",`priced-${index}`,
      {provider:"codex",model:"priced-model",accountId:"account-a",taskId:rootSessionId});
    // A closed member is recoverable from task metadata even when it is absent from the live member list.
    await timeline.recordCumulativeUsage(`closed-${index}`,{input:10,output:5,total:15,costUsd:0.002},"opencode-cli",`closed-${index}`,
      {provider:"opencode",model:"reported-model",accountId:"account-b",taskId:rootSessionId});
  }
  // A handoff to a new task owns only the increase since the prior task's baseline.
  await timeline.recordCumulativeUsage("shared-old",{input:800,output:200,total:1_000,costUsd:0.02},"codex-cli","shared-thread",
    {provider:"codex",model:"reported-model",accountId:"account-a",taskId:"root-0"});
  await timeline.recordCumulativeUsage("shared-resumed",{input:1_120,output:280,total:1_400,costUsd:0.03},"codex-cli","shared-thread",
    {provider:"codex",model:"reported-model",accountId:"account-a",taskId:"root-1"});
  await timeline.recordCumulativeUsage("shared-old",{input:1_440,output:360,total:1_800,costUsd:0.04},"codex-cli","shared-thread",
    {provider:"codex",model:"reported-model",accountId:"account-a",taskId:"root-0"});
  await timeline.recordUsage("unclaimed-legacy",900,100,"legacy-cli",9);

  const resumedDay=(await timeline.breakdown("day","root-0")).find(row=>row.sessionId==="resumed-0");
  assert.deepEqual(resumedDay?.tokens,{input:40,output:10,total:50},"daily usage retains only the resumed card's cumulative delta");
  assert.ok(Math.abs((resumedDay?.costUsd ?? -1)-0.005)<1e-12);

  const usageMap=timeline.usageBySession,usageIterator=usageMap[Symbol.iterator];let usageVisits=0;
  usageMap[Symbol.iterator]=function*(){for(const row of usageIterator.call(this)){usageVisits++;yield row;}};
  const contributionMap=timeline.budgetUsageContributions,contributionValues=contributionMap.values;let contributionVisits=0;
  contributionMap.values=function*(){for(const row of contributionValues.call(this)){contributionVisits++;yield row;}};
  const callbackOrder=[],refreshOrder=[],watched=new Set(["root-0","unlimited-between-roots","root-12"]),ledgerRecorded=new Set();
  const originalRecordSessionUsage=budget.recordSessionUsage;
  budget.recordSessionUsage=function(rootSessionId,...args) {
    if(watched.has(rootSessionId)&&!ledgerRecorded.has(rootSessionId)) {ledgerRecorded.add(rootSessionId);refreshOrder.push(`ledger:${rootSessionId}`);}
    return originalRecordSessionUsage.call(this,rootSessionId,...args);
  };
  const snapshots=refreshOrchestrationUsageBatch(budget,timeline,refreshScopes,firstPrices,(scope,snapshot)=>{
    callbackOrder.push([scope.rootSessionId,snapshot!==undefined]);
    if(watched.has(scope.rootSessionId))refreshOrder.push(`ui:${scope.rootSessionId}`);
  },scope=>{
    if(watched.has(scope.rootSessionId))refreshOrder.push(`before:${scope.rootSessionId}`);
    budget.snapshot(scope.rootSessionId,scope.rootStartedAt);
  });
  budget.recordSessionUsage=originalRecordSessionUsage;
  assert.deepEqual(callbackOrder,refreshScopes.map(scope=>[scope.rootSessionId,scope.budgetEnabled!==false]),
    "active snapshots and no-limit terminal clears keep the original root notification order");
  assert.deepEqual(refreshOrder,["before:root-0","ledger:root-0","ui:root-0","before:unlimited-between-roots",
    "ui:unlimited-between-roots","before:root-12","ledger:root-12","ui:root-12"],
    "initial snapshots stay interleaved with each root ledger and terminal update");
  assert.equal(usageVisits,usageMap.size,"all usage counters are visited once for the active roots as a batch");
  assert.equal(contributionVisits,contributionMap.size,"all budget contributions are visited once for the active roots as a batch");
  usageMap[Symbol.iterator]=usageIterator;
  contributionMap.values=contributionValues;
  for(const scope of roots) {
    const index=Number(scope.rootSessionId.slice("root-".length));
    const snapshot=snapshots.get(scope.rootSessionId);
    assert.ok(snapshot);
    assert.equal(snapshot.usage.tokens,index===0?3_175:index===1?675:275,"resumed counters and legacy members are attributed to their owning task only");
    const expectedCost=index===0?0.1993:index===1?0.0293:0.0193;
    assert.ok(Math.abs(snapshot.usage.costUsd-expectedCost)<1e-12,`reported and first-price costs for ${scope.rootSessionId}`);
    assert.deepEqual(refreshOrchestrationUsage(budget,timeline,scope.rootSessionId,scope.rootStartedAt,scope.memberSessionIds,firstPrices),snapshot,
      "the existing single-root entry point returns the exact batch snapshot");
    const serial=refreshOrchestrationUsage(serialBudget,timeline,scope.rootSessionId,scope.rootStartedAt,scope.memberSessionIds,firstPrices);
    assert.equal(serial.usage.tokens,snapshot.usage.tokens,`serial snapshot tokens for ${scope.rootSessionId}`);
    assert.equal(serial.usage.costUsd,snapshot.usage.costUsd,`serial snapshot cost for ${scope.rootSessionId}`);
  }
  await budget.flush();await serialBudget.flush();
  const persisted=JSON.parse(await readFile(join(dir,"batch-budget.json"),"utf8"));
  const serialPersisted=JSON.parse(await readFile(join(dir,"serial-budget.json"),"utf8"));
  for(const scope of roots) {
    const batchRows=persisted.budgets[scope.rootSessionId].sessions,serialRows=serialPersisted.budgets[scope.rootSessionId].sessions;
    assert.deepEqual(Object.keys(batchRows),Object.keys(serialRows),"batch and serial refresh retain identical ledger key insertion order");
    assert.deepEqual(batchRows,serialRows,"batch and serial refresh persist identical counter values and placeholders");
    const pending=Object.values(batchRows).filter(row=>row.provisional===true);
    assert.equal(pending.length,2,"observed aliases replace launch placeholders while the root and idle member stay provisional");
  }

  const restored=new SessionTimelineService(dir,text=>text);await restored.load();
  const repricedBudget=new OrchestrationBudgetService(join(dir,"repriced-budget.json"));await repricedBudget.load();t.after(()=>repricedBudget.dispose());
  for(const scope of roots)await repricedBudget.setLimits(scope.rootSessionId,{tokens:null,costUsd:10,durationMs:null});
  const reorderedPrices=[
    {provider:"codex",model:"unused-model",inputPerMillion:1,outputPerMillion:1},
    {provider:"codex",model:"priced-model",inputPerMillion:20,outputPerMillion:40}
  ];
  const repriced=refreshOrchestrationUsageBatch(repricedBudget,restored,roots,reorderedPrices);
  for(const scope of roots) {
    const index=Number(scope.rootSessionId.slice("root-".length));
    const snapshot=repriced.get(scope.rootSessionId);
    assert.ok(snapshot);
    assert.equal(snapshot.usage.tokens,index===0?3_175:index===1?675:275,"restored task and closed-member attribution is stable");
    const expectedCost=index===0?0.2006:index===1?0.0306:0.0206;
    assert.ok(Math.abs(snapshot.usage.costUsd-expectedCost)<1e-12,`restored rows use reordered current prices for ${scope.rootSessionId}`);
    assert.deepEqual(refreshOrchestrationUsage(repricedBudget,restored,scope.rootSessionId,scope.rootStartedAt,scope.memberSessionIds,reorderedPrices),snapshot,
      "reloading and repricing preserves exact single-root snapshots");
  }
  await budget.flush();await repricedBudget.flush();
});

test("daily usage baselines respect provider and account context and count counter resets",async(t)=>{
  const dir=await temp(t,"ctty-usage-context-");
  let now=Date.now()-2*86400_000;
  const timeline=new SessionTimelineService(dir,text=>text,200*1024*1024,()=>now);await timeline.load();
  await timeline.recordCumulativeUsage("old-card",{input:800,output:200,total:1_000,costUsd:0.1},"cli","same-counter",
    {provider:"codex",accountId:"account-a",taskId:"root"});
  now=Date.now();
  await timeline.recordCumulativeUsage("other-account",{input:16,output:4,total:20,costUsd:0.002},"cli","same-counter",
    {provider:"codex",accountId:"account-b",taskId:"root"});
  await timeline.recordCumulativeUsage("other-provider",{input:4,output:1,total:5,costUsd:0.001},"cli","same-counter",
    {provider:"opencode",accountId:"account-a",taskId:"root"});
  await timeline.recordCumulativeUsage("reset-card",{input:20,output:5,total:25,costUsd:0.005},"cli","same-counter",
    {provider:"codex",accountId:"account-a",taskId:"root"});
  await timeline.recordCumulativeUsage("reset-followup",{input:28,output:7,total:35,costUsd:0.007},"cli","same-counter",
    {provider:"codex",accountId:"account-a",taskId:"root"});
  const today=await timeline.breakdown("day","root");
  const bySession=new Map(today.map(row=>[row.sessionId,row]));
  assert.equal(bySession.get("other-account")?.tokens.total,20,"a different account starts its own baseline");
  assert.equal(bySession.get("other-provider")?.tokens.total,5,"a different provider starts its own baseline");
  assert.equal(bySession.get("reset-card")?.tokens.total,25,"a lower cumulative value starts a new counter epoch");
  assert.equal(bySession.get("reset-followup")?.tokens.total,10,"later samples delta from the reset counter");
  assert.ok(Math.abs((bySession.get("reset-card")?.costUsd ?? -1)-0.005)<1e-12);
  assert.ok(Math.abs((bySession.get("reset-followup")?.costUsd ?? -1)-0.002)<1e-12);
  const budget=new OrchestrationBudgetService(join(dir,"budget.json"));await budget.load();t.after(()=>budget.dispose());
  await budget.setLimits("root",{tokens:2_000,costUsd:1,durationMs:null});
  const task=refreshOrchestrationUsage(budget,timeline,"root",Date.now(),["old-card","other-account","other-provider","reset-card","reset-followup"],[]);
  assert.equal(task.usage.tokens,1_060,"budget totals keep provider/account identities separate and add reset epochs only once");
  assert.ok(Math.abs((task.usage.costUsd ?? -1)-0.11)<1e-12,"reported cost deltas across resumed cards are deduplicated");
  await budget.flush();
});

test("duration enforcement fires its deadline without session polling", async(t)=>{
  const dir=await temp(t,"ctty-budget-deadline-");
  let resolvePause;const paused=new Promise(resolve=>{resolvePause=resolve;});
  const budget=new OrchestrationBudgetService(join(dir,"budget.json"),{onPause:resolvePause});await budget.load();t.after(()=>budget.dispose());
  await budget.setLimits("root",{tokens:null,costUsd:null,durationMs:50},Date.now());
  const keepAlive=setTimeout(()=>{},1000);t.after(()=>clearTimeout(keepAlive));
  assert.equal((await paused).paused,true);
  await budget.flush();
});

test("forgetting a review worker aborts its active watcher", async (t) => {
  const root = await temp(t, "ctty-review-cleanup-");
  const { terminals } = manager(t);
  const orchestrator = terminals.create({ provider: "codex", profile: "normal", cwd: root, position: at, role: "orchestrator" });
  const control = new AgentControlService(terminals, {
    waitTiming: { checkMs: 60_000, settleMs: 60_000, quietMs: 60_000 }
  });
  const worker = await control.spawn({ parentSessionId: orchestrator.id, provider: "opencode", cwd: root, review: true });
  const signals = [];
  const waitFor = control.waitFor.bind(control);
  control.waitFor = (sessionId, request) => {
    if (sessionId === worker.id) signals.push(request.signal);
    return waitFor(sessionId, request);
  };

  await control.send(worker.id, "Continue the task.");
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  control.forgetSession(worker.id);
  assert.equal(signals[0].aborted, true);
});

test("project orchestration flows hot reload and reject permission-bearing or malformed files", async (t) => {
  const root = await temp(t, "ctty-flows-");
  const service = new OrchestrationTemplateService();
  const builtins = await service.list(root);
  assert.equal(builtins.templates.length, 4);
  const applied = service.instructions(builtins.templates.find((flow) => flow.id === "executor-reviewer"));
  assert.match(applied, /Expected subagents: 2/u);
  assert.match(applied, /Preserve the orchestration permissions/u);
  const directory = join(root, ".canvastty", "flows");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "bad.yaml"), "id: [broken\nname: Invalid\n", "utf8");
  const refreshed = await service.list(root);
  assert.equal(refreshed.templates.length, 4, "new files are discovered without restarting the service");
  assert.equal(refreshed.errors.length, 1);
  assert.ok(refreshed.errors[0].line >= 1);
  await writeFile(join(directory,"bad.yaml"),"id: test-flow\nname: Test\ndescription: Test\nfinalStep: Done\nroles:\n  - id: worker\n    title: Work\n    instruction: Implement\n    count: 0\n");
  assert.equal((await service.list(root)).errors[0].line,9,"semantic validation points at the invalid role field");
  await writeFile(join(directory,"bad.yaml"),"id: test-flow\nname: Test\nroles: [broken\n");
  assert.ok((await service.list(root)).errors[0].line>1,"YAML syntax error reports its actual line");
  await assert.rejects(service.save(root, {
    id: "too-powerful", name: "Unsafe", description: "No", roles: [{ id: "worker", title: "Write", instruction: "x", count: 1 }],
    finalStep: "Done", profile: "auto"
  }), /Unknown flow field "profile"/u);
});

test("project orchestration flows reject symlinked directories outside the project", async (t) => {
  const root = await temp(t, "ctty-flow-symlinks-");
  const service = new OrchestrationTemplateService();
  const outside = join(root, "outside");
  await mkdir(join(outside, "flows"), { recursive: true });
  await writeFile(join(outside, "flows", "external.yaml"), [
    "id: external-flow", "name: External", "description: Outside project", "roles:",
    "  - id: worker", "    title: Worker", "    instruction: Read files", "    count: 1", "finalStep: Done", ""
  ].join("\n"), "utf8");
  const flow = {
    id: "new-flow", name: "New flow", description: "A test flow",
    roles: [{ id: "worker", title: "Worker", instruction: "Work", count: 1 }], finalStep: "Finish"
  };

  const configLinkProject = join(root, "config-link-project");
  await mkdir(configLinkProject);
  await symlink(outside, join(configLinkProject, ".canvastty"), "dir");
  const configLinkList = await service.list(configLinkProject);
  assert.equal(configLinkList.templates.some((item) => item.id === "external-flow"), false);
  assert.match(configLinkList.errors[0]?.message ?? "", /inside the project/u);
  await assert.rejects(service.save(configLinkProject, flow), /inside the project/u);
  assert.deepEqual(await readdir(join(outside, "flows")), ["external.yaml"]);

  const flowLinkProject = join(root, "flow-link-project");
  await mkdir(join(flowLinkProject, ".canvastty"), { recursive: true });
  await symlink(join(outside, "flows"), join(flowLinkProject, ".canvastty", "flows"), "dir");
  const flowLinkList = await service.list(flowLinkProject);
  assert.equal(flowLinkList.templates.some((item) => item.id === "external-flow"), false);
  assert.match(flowLinkList.errors[0]?.message ?? "", /inside the project/u);
  await assert.rejects(service.save(flowLinkProject, flow), /inside the project/u);
  assert.deepEqual(await readdir(join(outside, "flows")), ["external.yaml"]);
});

test('duration budgets retain original task start across reload and task imports remap dependency graphs atomically',async(t)=>{
  const dir=await temp(t,'ctty-import-budget-'),path=join(dir,'budgets.json');
  const budget=new OrchestrationBudgetService(path);await budget.load();
  const startedAt=Date.now()-10_000;
  await budget.setLimits('root',{tokens:null,costUsd:null,durationMs:1000},startedAt);
  const restored=new OrchestrationBudgetService(path);await restored.load();
  assert.equal(restored.snapshot('root',Date.now()).paused,true);
  assert.ok(restored.snapshot('root',Date.now()).usage.durationMs>=10_000);
  const board=new OrchestrationTaskBoard(join(dir,'boards'));
  const first=await board.addTask(dir,'root','root',{title:'First',ownerSessionId:'old-child'});
  const second=await board.addTask(dir,'root','root',{title:'Second',dependencies:[first.id]});
  await board.importGroup(dir,'new-root',[first,second],{'root':'new-root','old-child':'new-child'});
  const rows=(await board.listTasks(dir,'new-root')).tasks;
  assert.equal(rows[0].ownerSessionId,'new-child');assert.equal(rows[1].dependencies[0],rows[0].id);assert.notEqual(rows[0].id,first.id);
  await assert.rejects(board.importGroup(dir,'broken',[{...first,dependencies:['missing']}],{}),/missing dependency/);
  assert.deepEqual((await board.listTasks(dir,'broken')).tasks,[]);
  const cyclic=[{...first,id:'cycle-one',dependencies:['cycle-two']},{...second,id:'cycle-two',dependencies:['cycle-one']}];
  await assert.rejects(board.importGroup(dir,'cyclic',cyclic,{}),/cycle/u);
  assert.deepEqual((await board.listTasks(dir,'cyclic')).tasks,[]);
});

test("a cost limit does not freeze a task that spawns new agents; real overspend pauses; unpriced usage pauses and resumes when cost data arrives",async(t)=>{
  const dir=await temp(t,"ctty-budget-spawn-");
  const signals=[];
  const calls=[];
  const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner(calls),
    new ProcessTreePause("linux",(group,signal)=>signals.push([group,signal]),null));
  t.after(()=>terminals.disposeAll());
  const timeline=new SessionTimelineService(dir,text=>text);await timeline.load();
  const pauses=[];
  // The same wiring as the app: every snapshot change drives process suspension for the task.
  const budget=new OrchestrationBudgetService(join(dir,"budget.json"),{
    onPause:row=>{pauses.push(row.reason);terminals.setBudgetPaused(row.rootSessionId,row.paused);},
    onChange:row=>terminals.setBudgetPaused(row.rootSessionId,row.paused)
  });
  await budget.load();t.after(()=>budget.dispose());
  const orchestrator=terminals.create({provider:"claude",profile:"normal",cwd:dir,position:at,role:"orchestrator"});
  const control=new AgentControlService(terminals,{budget});
  const refresh=()=>refreshOrchestrationUsage(budget,timeline,orchestrator.id,orchestrator.startedAt,
    terminals.listMetadata().filter(row=>row.id!==orchestrator.id).map(row=>row.id),[]);
  await timeline.recordCumulativeUsage(orchestrator.id,{input:100,output:0,total:100,costUsd:1},"claude-hook","root-thread",{taskId:orchestrator.id});
  await budget.setLimits(orchestrator.id,{tokens:null,costUsd:10,durationMs:null},orchestrator.startedAt);
  assert.equal(refresh().paused,false);

  const first=await control.spawn({parentSessionId:orchestrator.id,provider:"opencode",cwd:dir});
  assert.equal(refresh().paused,false,"a launched agent without usage yet is provisional");
  const second=await control.spawn({parentSessionId:orchestrator.id,provider:"opencode",cwd:dir});
  let snapshot=refresh();
  assert.equal(snapshot.paused,false,"two brand-new agents with unknown cost do not freeze the task");
  assert.deepEqual(pauses,[]);
  assert.deepEqual(signals,[],"no process was stopped");
  assert.doesNotThrow(()=>control.assertInputAllowed(orchestrator.id));

  // Unpriced usage from an agent that has started working is a session that should report cost but cannot.
  await timeline.recordCumulativeUsage(first.id,{input:100,output:0,total:100},"opencode-cli","first-thread",{taskId:orchestrator.id});
  snapshot=refresh();
  assert.equal(snapshot.paused,true);
  assert.match(snapshot.reason,/costs are unavailable/u);
  assert.ok(signals.some(([,signal])=>signal==="SIGSTOP"),"the task's processes were suspended");
  await timeline.recordCumulativeUsage(first.id,{input:100,output:0,total:100,costUsd:2},"opencode-cli","first-thread",{taskId:orchestrator.id});
  snapshot=refresh();
  assert.equal(snapshot.paused,false,"cost data arriving resumes the task automatically");
  assert.ok(signals.at(-1)[1]==="SIGCONT","the suspended processes were resumed");
  assert.doesNotThrow(()=>control.assertInputAllowed(orchestrator.id));
  assert.equal(snapshot.usage.costUsd,3);

  await timeline.recordCumulativeUsage(second.id,{input:100,output:0,total:100,costUsd:8},"opencode-cli","second-thread",{taskId:orchestrator.id});
  snapshot=refresh();
  assert.equal(snapshot.paused,true,"real spending at the limit pauses");
  assert.match(snapshot.reason,/Budget reached: cost limit/u);
  assert.throws(()=>control.assertInputAllowed(orchestrator.id),/cost limit/u);
  assert.equal(refresh().paused,true,"a hard limit does not resume by itself");
  await budget.flush();
});

