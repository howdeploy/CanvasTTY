import assert from "node:assert/strict";
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import test from "node:test";
import {SessionTimelineService} from "../src/main/services/SessionTimelineService.ts";
import {GitCheckpoints} from "../src/main/services/GitCheckpoints.ts";
import {OrchestrationBudgetService} from "../src/main/services/OrchestrationBudgetService.ts";
import {createHash} from "node:crypto";
const exec=promisify(execFile);
const temp=()=>mkdtemp(join(tmpdir(),"canvastty-backlog-test-"));

test("timeline masks before persistence and supports bounded stable pages after restart",async()=>{
  const dir=await temp();
  try {
    const lateSecrets=new Set();
    const redact=text=>{
      const masked=text.replaceAll("held-value","<redacted>");
      return lateSecrets.has("later-secret") ? masked.replaceAll("later-secret","<late-redacted>") : masked;
    };
    const timeline=new SessionTimelineService(dir,redact);await timeline.load();
    const contexts=new Map([
      ["agent",{taskId:"stable-root",title:"Root task"}],
      ["closed-child",{taskId:"stable-root",title:"Closed held-value child"}],
      ["late-child",{taskId:"stable-root",title:"Late child later-secret name"}],
      ["moved-card",{taskId:"stable-root",title:"Card before handoff"}],
      ["foreign-root",{taskId:"other-root",title:"Unrelated root"}]
    ]);
    timeline.configureSessionContext(id=>contexts.get(id));
    for(let i=0;i<7;i++) await timeline.append("agent","tool",`step ${i}`,"held-value");
    await timeline.append("closed-child","rare-imported-type","old child event");
    await timeline.append("closed-child","tool","newer child event");
    await timeline.append("late-child","tool","late-redaction row");
    await timeline.append("moved-card","status","before scope change");
    contexts.set("moved-card",{taskId:"other-root",title:"Card after handoff"});
    await timeline.append("moved-card","lifecycle","after scope change");
    await timeline.append("foreign-root","tool","unrelated task event");
    await timeline.append("legacy-live","status","unscoped live legacy event");
    await timeline.append("legacy-closed","status","unscoped closed legacy event");
    const files=await readdir(timeline.directory);
    const savedJournal=(await Promise.all(files.map(name=>readFile(join(timeline.directory,name),"utf8")))).join("");
    assert.doesNotMatch(savedJournal,/held-value/);
    contexts.clear(); // The closed child and its resolver metadata are gone before restart.
    const restored=new SessionTimelineService(dir,redact);await restored.load();
    lateSecrets.add("later-secret");
    const agents=restored.taskSessions("stable-root");
    assert.deepEqual(agents.find(row=>row.id==="closed-child"),{
      id:"closed-child",title:"Closed <redacted> child",types:["rare-imported-type","tool"]
    },"closed agents and rare event types are recovered from the journal after restart");
    assert.ok(agents.some(row=>row.id==="moved-card"));
    assert.ok(restored.taskSessions("other-root").some(row=>row.id==="moved-card"),"one card may retain events under two stable task scopes");
    assert.equal(agents.some(row=>row.id==="foreign-root"),false);
    assert.equal(agents.find(row=>row.id==="late-child")?.title,"Late child <late-redacted> name","facet titles are re-redacted when masking rules change after append and reload");
    const rootScope={taskId:"stable-root",legacySessionIds:["agent","legacy-live"]};
    const scoped=await restored.page("agent",undefined,50,{sessionIds:["agent","closed-child","moved-card","foreign-root","legacy-live","legacy-closed"]},rootScope);
    assert.ok(scoped.items.some(row=>row.summary==="old child event"));
    assert.ok(scoped.items.some(row=>row.summary==="before scope change"));
    assert.ok(scoped.items.some(row=>row.summary==="unscoped live legacy event"));
    assert.equal(scoped.items.some(row=>row.summary==="after scope change"),false,"changed-scope rows on the same card stay separate");
    assert.equal(scoped.items.some(row=>row.summary==="unrelated task event"),false,"another stable scope stays private");
    assert.equal(scoped.items.some(row=>row.summary==="unscoped closed legacy event"),false,"unscoped closed history is never guessed into a task");
    const rare=await restored.page("agent",undefined,10,{types:["rare-imported-type"],sessionIds:["closed-child"]},rootScope);
    assert.deepEqual(rare.items.map(row=>row.summary),["old child event"]);
    const otherScope=await restored.page("foreign-root",undefined,10,{sessionIds:["moved-card","foreign-root"]},{taskId:"other-root",legacySessionIds:["foreign-root"]});
    assert.ok(otherScope.items.some(row=>row.summary==="after scope change"));
    assert.equal(otherScope.items.some(row=>row.summary==="before scope change"),false);
    const first=await restored.page("agent",undefined,3);assert.deepEqual(first.items.map(row=>row.summary),["step 6","step 5","step 4"]);
    const second=await restored.page("agent",first.nextCursor,3);assert.deepEqual(second.items.map(row=>row.summary),["step 3","step 2","step 1"]);
    assert.match(await restored.report("agent"),/Network visibility is incomplete/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test("timeline report scans each journal segment once and append prunes only after crossing the byte cap",async()=>{
  const dir=await temp();try {
    const limited=new SessionTimelineService(dir,text=>text,1_200);await limited.load();
    limited.configureSessionContext(id=>({taskId:"retained-task",title:id}));
    await limited.append("closed-child","rare-only-type","old child row");
    const originalPrune=limited.prune.bind(limited);let prunes=0;
    limited.prune=async()=>{prunes++;return originalPrune();};
    for(let i=0;i<12;i++)await limited.append("agent","tool",`step ${i}`,"x".repeat(300));
    assert.ok(prunes>0 && prunes<12,`expected threshold pruning, saw ${prunes} prunes for 12 appends`);
    const files=await readdir(limited.directory);
    const totalBytes=(await Promise.all(files.map(async name=>(await readFile(join(limited.directory,name))).byteLength))).reduce((sum,size)=>sum+size,0);
    assert.ok(totalBytes<=1_200,`journal retained ${totalBytes} bytes past its configured cap`);
    assert.equal(limited.taskSessions("retained-task").some(row=>row.id==="closed-child"),false,"pruned actors leave the derived facet index");
    assert.equal(limited.taskSessions("retained-task").some(row=>row.types.includes("rare-only-type")),false,"pruned-only types leave the derived facet index");

    const timeline=new SessionTimelineService(dir,text=>text);await timeline.load();
    for(let i=0;i<600;i++)await timeline.append("report-agent","tool",`report step ${i}`);
    const segmentCount=(await readdir(timeline.directory)).length;
    const originalScan=timeline.scan.bind(timeline);let reads=0;
    timeline.scan=async(name,visit)=>{reads++;return originalScan(name,visit);};
    const report=await timeline.report("report-agent");
    assert.equal(reads,segmentCount,"the report loads each segment once instead of rescanning it per page");
    assert.match(report,/report step 0/);assert.match(report,/report step 599/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("timeline cursors preserve filtered ordering across appends and legacy IDs, and reject traversal", async () => {
  const dir = await temp();
  try {
    const timeline = new SessionTimelineService(dir, text => text); await timeline.load();
    for (let index = 0; index < 12; index++) await timeline.append(index % 4 === 0 ? "foreign" : "agent", index % 2 ? "command" : "status", `event ${index}`);
    const filter = { types:["command"] };
    const first = await timeline.page("agent", undefined, 2, filter);
    await timeline.append("agent", "command", "newest after cursor");
    const second = await timeline.page("agent", first.nextCursor, 2, filter);
    assert.deepEqual(second.items.map(event => event.summary), ["event 7", "event 5"]);
    assert.deepEqual((await timeline.page("agent", first.items.at(-1).id, 2, filter)).items, second.items);
    assert.equal((await timeline.page("agent", undefined, 1, filter)).items[0].summary, "newest after cursor");
    await assert.rejects(timeline.page("agent", "v1:../../outside:2"), /Invalid timeline cursor/u);
  } finally { await rm(dir, {recursive:true,force:true}); }
});
test("loaded oversized valid segments stay searchable after worker indexing",async()=>{
  const dir=await temp();try {
    const timeline=new SessionTimelineService(dir,text=>text);await timeline.load();
    const event={id:"oversized-event",sessionId:"oversized-agent",at:Date.now(),type:"note",summary:"oversized note",
      detail:`needle ${"x".repeat(80_000)}`};
    await writeFile(join(timeline.directory,`${String(Date.now()).padStart(16,"0")}-oversized.ndjson`),`${JSON.stringify(event)}\n`);
    const restored=new SessionTimelineService(dir,text=>text);await restored.load();
    const page=await restored.page("oversized-agent",undefined,10,{query:"needle",types:["note"]});
    assert.deepEqual(page.items.map(row=>row.id),["oversized-event"]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("timeline usage never invents numbers, sums task records and replaces CLI cumulative counters after restart",async()=>{
  const dir=await temp();try {
    const timeline=new SessionTimelineService(dir,text=>text);await timeline.load();
    assert.equal(timeline.usage(["missing"]).tokens.total,null);
    await timeline.recordUsage("root",10,5,"provider-hook",0.02);await timeline.recordUsage("child",20,7,"provider-hook",0.03,{taskId:"root"});
    assert.equal(timeline.usage(["root","child"]).tokens.total,42);assert.equal(timeline.usage(["root","child"]).cost,0.05);
    assert.deepEqual(timeline.sessionIds("root"),["root","child"],"closed members remain discoverable for task totals and repricing");
    await assert.rejects(timeline.recordUsage("agent",NaN,1,"provider-hook"),/Invalid/);
    await timeline.recordTokenTotal("agent",120,"codex-cli");await timeline.recordTokenTotal("agent",120,"codex-cli");
    await timeline.recordTokenTotal("agent",180,"codex-cli");
    assert.deepEqual(timeline.usage(["agent"]).tokens,{input:null,output:null,total:180});assert.equal(timeline.usage(["agent"]).cost,null);
    const restored=new SessionTimelineService(dir,text=>text);await restored.load();assert.deepEqual(restored.usage(),timeline.usage());
    assert.equal(restored.usage(["agent"]).tokens.total,180);
    assert.equal((await restored.page("agent")).items.length,2,"identical cumulative CLI samples do not create duplicate events");
  } finally {await rm(dir,{recursive:true,force:true});}
});
test("cumulative usage replaces live counters, preserves attribution, and recalculates human prices",async()=>{
  const dir=await temp();try {
    let now=Date.now()-2*86400_000;
    const timeline=new SessionTimelineService(dir,text=>text,200*1024*1024,()=>now);await timeline.load();
    const usageChanges=[];const unsubscribe=timeline.subscribeUsage(id=>usageChanges.push(id));
    const context={provider:"codex",model:"codex-model-a",accountId:"default-local-store",taskId:"root"};
    await timeline.recordCumulativeUsage("root",{input:1_000,output:100,total:1_100},"codex-cli","thread-1",context);
    now=Date.now();
    await timeline.recordCumulativeUsage("root",{input:2_000,output:250,total:2_250},"codex-cli","thread-1",context);
    assert.deepEqual(usageChanges,["root","root"],"only changed persisted counters notify live usage listeners");
    unsubscribe();
    await timeline.recordCumulativeUsage("root",{input:2_000,output:250,total:2_250},"codex-cli","thread-1",context);
    const firstPrice=[{provider:"codex",model:"codex-model-a",inputPerMillion:2,outputPerMillion:8}];
    const updatedPrice=[{provider:"codex",model:"codex-model-a",inputPerMillion:4,outputPerMillion:12}];
    assert.deepEqual(timeline.usage(["root"]).tokens,{input:2_000,output:250,total:2_250});
    assert.deepEqual(timeline.usage(["root"],firstPrice),{
      tokens:{input:2_000,output:250,total:2_250},cost:0.006,currency:"USD",source:"codex-cli"
    });
    assert.equal(timeline.usage(["root"],updatedPrice).cost,0.011);
    const all=await timeline.breakdown("all","root",updatedPrice);
    assert.deepEqual(all[0].tokens,{input:2_000,output:250,total:2_250});
    assert.equal(all[0].costUsd,0.011);assert.equal(all[0].costSource,"human-price");
    assert.deepEqual({provider:all[0].provider,model:all[0].model,accountId:all[0].accountId,taskId:all[0].taskId},context);
    const day=await timeline.breakdown("day","root",updatedPrice);
    assert.deepEqual(day[0].tokens,{input:1_000,output:150,total:1_150});assert.equal(day[0].costUsd,0.0058);
    await timeline.recordCumulativeUsage("first-sample",{input:90,output:10,total:100},"codex-cli","new-counter",context);
    const firstDay=(await timeline.breakdown("day","root",updatedPrice)).find(row=>row.sessionId==="first-sample");
    const firstAll=(await timeline.breakdown("all","root",updatedPrice)).find(row=>row.sessionId==="first-sample");
    assert.deepEqual(firstDay.tokens,{input:90,output:10,total:100});assert.equal(firstDay.costUsd,0.00048);
    assert.deepEqual(firstAll.tokens,{input:90,output:10,total:100});assert.equal(firstAll.costUsd,0.00048);
    assert.equal((await timeline.page("root")).items.length,2,"identical cumulative samples do not create duplicate events");

    const restored=new SessionTimelineService(dir,text=>text,200*1024*1024,()=>now);await restored.load();
    assert.deepEqual(restored.usage(["root"],updatedPrice),timeline.usage(["root"],updatedPrice));
    assert.deepEqual(await restored.breakdown("all","root",updatedPrice),await timeline.breakdown("all","root",updatedPrice));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("restarting one card with another conversation retains both real counters in cards, tree and reload",async()=>{
  const dir=await temp();try{
    const timeline=new SessionTimelineService(dir,text=>text);await timeline.load();
    const context={provider:"codex",model:"model",taskId:"root",accountId:"alternate"};
    await timeline.recordCumulativeUsage("child",{input:10,output:5,total:15},"codex","thread-one",context);
    await timeline.recordCumulativeUsage("child",{input:20,output:5,total:25},"codex","thread-two",context);
    await timeline.recordCumulativeUsage("child",{input:20,output:5,total:25},"codex","thread-two",context);
    await timeline.recordCumulativeUsage("root",{input:30,output:10,total:40},"codex","thread-root",context);
    const prices=[{provider:"codex",model:"model",inputPerMillion:2,outputPerMillion:3}];
    assert.equal(timeline.usage(["child"]).tokens.total,40);
    assert.equal(timeline.usage(timeline.sessionIds("root")).tokens.total,80);
    assert.equal(timeline.usageCounters("child").length,2);
    const cardSum=timeline.sessionIds("root").reduce((sum,id)=>sum+timeline.usage([id],prices).cost,0);
    assert.equal(timeline.usage(timeline.sessionIds("root"),prices).cost,cardSum);
    const restored=new SessionTimelineService(dir,text=>text);await restored.load();
    assert.deepEqual(restored.usage(undefined,prices),timeline.usage(undefined,prices));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("budget counters keep source identity and replace legacy aliases without double counting",async()=>{
  const dir=await temp();const budget=new OrchestrationBudgetService(join(dir,"budget.json"));try{
    const timeline=new SessionTimelineService(dir,text=>text);await timeline.load();await budget.load();
    await timeline.recordCumulativeUsage("child",{input:10,output:5,total:15,costUsd:2},"source-one","same-thread",{taskId:"root"});
    await timeline.recordCumulativeUsage("child",{input:20,output:5,total:25,costUsd:3},"source-two","same-thread",{taskId:"root"});
    const counters=timeline.usageCounters("child");
    assert.equal(new Set(counters.map(row=>row.id)).size,2,"equal conversation IDs under distinct sources must stay distinct");
    const hash=id=>createHash("sha256").update(`child:${id}`).digest("hex");
    budget.recordSessionUsage("root",hash("same-thread"),{tokens:25,costUsd:3});
    budget.recordSessionUsage("root",hash("child"),{tokens:null,costUsd:null});
    for(const counter of counters)budget.recordSessionUsage("root",hash(counter.id),counter,{replaceCounterIds:[hash("child"),hash(counter.legacyId)]});
    assert.equal(budget.snapshot("root").usage.tokens,timeline.usage(["child"]).tokens.total);
    assert.equal(budget.snapshot("root").usage.costUsd,timeline.usage(["child"]).cost);
    assert.equal(budget.snapshot("root").data.costUsd,"available");
    await budget.flush();
  }finally{budget.dispose();await budget.flush();await rm(dir,{recursive:true,force:true});}
});

const descriptor=(dir,id="root")=>({id,provider:"codex",profile:"normal",role:"orchestrator",title:id,titleCustomized:true,cwd:dir,
  position:{x:10,y:20},size:{width:700,height:430},lastState:"running",restore:true});
test("git checkpoints leave staged and unstaged edits intact, preview and restore both; retention prunes old captures safely",async()=>{
  const dir=await temp();const git=(...args)=>exec("git",["-C",dir,...args]);try {
    await git("init");await git("config","user.name","Test");await git("config","user.email","test@example.invalid");await git("config","core.autocrlf","false");
    await writeFile(join(dir,"file.txt"),"base\n");await git("add","file.txt");await git("commit","-m","base");
    await writeFile(join(dir,"file.txt"),"staged\n");await git("add","file.txt");await writeFile(join(dir,"file.txt"),"unstaged\n");
    const before=(await git("diff","--cached")).stdout;const checkpoints=new GitCheckpoints(text=>text);
    await checkpoints.capture("session",dir);assert.equal((await git("diff","--cached")).stdout,before);assert.equal(await readFile(join(dir,"file.txt"),"utf8"),"unstaged\n");
    const saved=(await checkpoints.list("session",dir))[0];await writeFile(join(dir,"file.txt"),"later\n");
    await git("update-ref",saved.id,"HEAD");
    const forged="refs/canvastty/session/9999999999999-agent-forged";
    await git("update-ref",forged,"HEAD");
    assert.equal((await checkpoints.list("session",dir)).some(entry=>entry.id===forged),false);
    await assert.rejects(checkpoints.preview("session",dir,forged),/does not belong/);
    assert.match((await checkpoints.preview("session",dir,saved.id)).text,/later/);
    await git("update-ref",saved.id,"HEAD");
    await checkpoints.restore("session",dir,saved.id);assert.equal(await readFile(join(dir,"file.txt"),"utf8"),"unstaged\n");assert.equal((await git("diff","--cached")).stdout,before);
    await assert.rejects(checkpoints.preview("foreign",dir,saved.id),/does not belong/);
    const nongit=join(dir,"plain");await mkdir(nongit);assert.equal(await checkpoints.available(nongit),false);
    await checkpoints.capture("other",dir);
    const other=(await checkpoints.list("other",dir))[0];
    const first=(await checkpoints.list("session",dir))[0];
    for(let index=0;index<51;index++)await checkpoints.capture("session",dir);
    const retained=await checkpoints.list("session",dir);
    assert.equal(retained.length,50);assert.equal(retained.some(row=>row.id===first.id),false);
    await assert.rejects(git("rev-parse","--verify",first.id));
    assert.equal((await checkpoints.list("other",dir))[0].id,other.id);
    assert.equal(await readFile(join(dir,"file.txt"),"utf8"),"unstaged\n");
    assert.equal((await git("diff","--cached")).stdout,before);
  } finally {await rm(dir,{recursive:true,force:true});}
});
