import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readOmniRouteCodexLimits } from "../src/main/services/OmniRouteCodexLimits.ts";
import { LimitsService } from "../src/main/services/LimitsService.ts";
import { selectHomeModel, formatResetCountdown } from "../src/renderer/src/features/home/homeModel.ts";

const CONNECTION = "fixture-connection";
const ENV = { CANVASTTY_OMNIROUTE_BIN: process.execPath, CANVASTTY_OMNIROUTE_URL: "http://127.0.0.1:20128",
  CANVASTTY_OMNIROUTE_CODEX_CONNECTION: CONNECTION };
const USAGE = { quotas: { session: { used: 9, total: 100, remaining: 91, windowSeconds: 604800,
  resetAt: "2030-01-10T12:00:00Z", displayName: "Weekly" } } };
const provider = { id: CONNECTION, provider: "codex", isActive: true };

test("quota source is opt-in, read-only and bound to the configured active Codex connection", async () => {
  const calls = [];
  assert.equal(await readOmniRouteCodexLimits({}, () => assert.fail("must not run")), null);
  const windows = await readOmniRouteCodexLimits(ENV, async (target, args) => {
    calls.push(args); assert.equal(target.connectionId, CONNECTION);
    return calls.length === 1 ? { connections: [provider] } : USAGE;
  });
  assert.deepEqual(calls, [["api", "providers", "get-api-providers"],
    ["api", "usage", "get-api-usage-connection-id-", "--connection-id", CONNECTION]]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPercent, 9);
  assert.equal(windows[0].windowMinutes, 10080, "source key session must not invent a 5h window");
  assert.equal(windows[0].resetsAt, Date.parse(USAGE.quotas.session.resetAt));
  assert.equal(formatResetCountdown(windows[0].resetsAt, windows[0].resetsAt - 3_600_000, "en"), "01:00");
  for (const changed of [{ ...provider, provider: "other" }, { ...provider, isActive: false }, { ...provider, isActive: undefined }, { ...provider, id: "other" }]) {
    let count = 0;
    await assert.rejects(readOmniRouteCodexLimits(ENV, async () => { count++; return [changed]; }),
      (e) => e.reason === "not-authenticated");
    assert.equal(count, 1, "never query another connection");
  }
});

test("remote/credentialed URLs, partial config and synthetic or malformed quota data fail closed", async () => {
  for (const change of [{ CANVASTTY_OMNIROUTE_URL: "http://example.com" },
    { CANVASTTY_OMNIROUTE_URL: "http://secret@localhost" }, { CANVASTTY_OMNIROUTE_URL: "http://localhost?key=secret" },
    { CANVASTTY_OMNIROUTE_BIN: "omniroute" }, { CANVASTTY_OMNIROUTE_CODEX_CONNECTION: "" }]) {
    await assert.rejects(readOmniRouteCodexLimits({ ...ENV, ...change }, () => assert.fail("must not run")));
  }
  for (const usage of [{ percentRemaining: 100 }, { quotas: {} }, { quotas: { x: { used: "9", total: 100 } } },
    { quotas: { x: { used: 0, total: 0 } } }, { quotas: { x: { used: 0, total: 100, unlimited: true } } }]) {
    await assert.rejects(readOmniRouteCodexLimits(ENV, async (_target, args) => args[1] === "providers" ? [provider] : usage));
  }
});

test("an API-profile service displays real upstream quota through the installed CLI protocol", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-omni-quota-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "cli.mjs");
  await writeFile(script, `#!${process.platform === "win32" ? process.execPath : "/usr/bin/env node"}
import {createInterface} from "node:readline";
if (process.argv.includes("--base-url")) {
  console.log("\\x1b[2mCLI diagnostics\\x1b[0m".replaceAll("\\x1b", "\x1b"));
  console.log(JSON.stringify(process.argv.includes("providers") ? {connections:${JSON.stringify([provider])}} : ${JSON.stringify(USAGE)}));
} else createInterface({input:process.stdin}).on("line", line => {
  const request=JSON.parse(line); if(request.id===undefined)return;
  const result=request.method==="account/read"?{account:null,requiresOpenaiAuth:false}:{};
  console.log(JSON.stringify({id:request.id,result}));
});
`, { mode: 0o700 });
  let executable = script;
  if (process.platform === "win32") {
    executable = join(root, "cli.cmd");
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  const registry = { get(provider) { return { state:"available", provider, executable,
    launcher:process.platform==="win32"?"batch":"native",commandPrompt:process.env.ComSpec,environment:{ PATH:dirname(process.execPath) },checked:[] }; } };
  const service = new LimitsService(registry, "test", { environment: { ...ENV, CANVASTTY_OMNIROUTE_BIN:executable, CODEX_HOME:root } });
  t.after(() => service.dispose());
  const oldPath = process.env.PATH;
  process.env.PATH = process.platform === "win32" ? process.env.SystemRoot + "\\System32" : "/usr/bin:/bin";
  let snapshot;
  try { snapshot = await service.getProviders(["codex"]); }
  finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
  const [limits] = snapshot.providers;
  assert.equal(limits.state, "available");
  assert.equal(limits.source, "omniroute-usage-api");
  assert.equal(limits.accountScope, null, "gateway quotas must not be attributed to the local ChatGPT account");
  const row = selectHomeModel([], snapshot, "ready", Date.parse("2030-01-09"), ["codex"]).limitRows[0];
  assert.equal(row.state, "available");
  assert.equal(row.window.usedPercent, 9);
  assert.equal(row.window.windowMinutes, 10080);
});

test("review quotas do not replace the Codex model quota on HOME", async () => {
  const now=Date.parse("2030-01-09");
  const windows=await readOmniRouteCodexLimits(ENV, async (_target,args)=> args[1]==="providers"?[provider]:{
    quotas:{...USAGE.quotas,code_review:{used:100,total:100,windowSeconds:31536000,resetAt:"2030-02-10T12:00:00Z"}}
  });
  const snapshot={fetchedAt:now,providers:[{provider:"codex",state:"available",source:"omniroute-usage-api",fetchedAt:now,windows}]};
  const row=selectHomeModel([],snapshot,"ready",now,["codex"]).limitRows[0];
  assert.equal(row.window.usedPercent,9);
});


async function quotaService(t) {
  const root=await mkdtemp(join(tmpdir(),"canvas-quota-cache-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const state=join(root,"state.json"), config=join(root,"config.toml"), script=join(root,"cli.mjs");
  const setState=(value)=>writeFile(state,JSON.stringify(value));
  await setState({});await writeFile(config,'model_provider = "api"\n');
  await writeFile(script,`#!${process.execPath}
import {readFileSync} from "node:fs";
import {createInterface} from "node:readline";
const state=()=>JSON.parse(readFileSync(${JSON.stringify(state)},"utf8"));
if(process.argv.includes("--base-url")) {
 const s=state();
 if(process.argv.includes("providers")) console.log(JSON.stringify(s.providers === "malformed" ? {} : s.inactive ? [] : [${JSON.stringify(provider)}]));
 else if(s.quota === "timeout") setTimeout(()=>{},30000);
 else console.log(JSON.stringify(s.quota === "malformed" ? {} : ${JSON.stringify(USAGE)}));
} else {
 const api=readFileSync(${JSON.stringify(config)},"utf8").includes('"api"');
 createInterface({input:process.stdin}).on("line",line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;
  if(m.method === "account/rateLimits/read" && state().nativeError) return console.log(JSON.stringify({id:m.id,error:{code:-32603}}));
  const result=m.method === "account/read" ? {account:api ? null : {type:"chatgpt"},requiresOpenaiAuth:!api}
   : m.method === "account/rateLimits/read" ? {rateLimits:{limitId:"codex",primary:{usedPercent:35,windowDurationMins:300,resetsAt:1790000000}}} : {};
  console.log(JSON.stringify({id:m.id,result}));
 });
}
`,{mode:0o700});
  let executable=script;
  if(process.platform === "win32") {
    executable=join(root,"cli.cmd");
    await writeFile(executable,`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  const registry={get:provider=>({state:"available",provider,executable,
    launcher:process.platform === "win32" ? "batch" : "native",commandPrompt:process.env.ComSpec,environment:{},checked:[]})};
  const service=new LimitsService(registry,"test",{cacheTtlMs:0,environment:{...ENV,CODEX_HOME:root,CANVASTTY_OMNIROUTE_BIN:executable}});
  t.after(()=>service.dispose());
  return {config,setState,read:async()=>(await service.getProviders(["codex"])).providers[0]};
}

for(const [failure,reason] of [["malformed","protocol-error"],["timeout","timeout"],["malformed provider listing","protocol-error"]]) {
  test(`gateway quota remains stale after a ${failure} reply and recovers`,async t=>{
    const f=await quotaService(t), first=await f.read();
    assert.equal(first.state,"available");
    await f.setState(failure === "malformed provider listing" ? {providers:"malformed"} : {quota:failure});
    const stale=await f.read();
    assert.equal(stale.state,"stale");assert.equal(stale.reason,reason);
    assert.equal(stale.source,"omniroute-usage-api");assert.equal(stale.accountScope,null);
    assert.equal(stale.fetchedAt,first.fetchedAt);assert.deepEqual(stale.windows,first.windows);
    assert.ok(stale.failedAt >= first.fetchedAt);
    await f.setState({});assert.equal((await f.read()).state,"available");
  });
}

test("changing between native and API profiles never reuses the other source's quota",async t=>{
  const f=await quotaService(t);
  await writeFile(f.config,'model_provider = "native"\n');
  assert.equal((await f.read()).source,"codex-app-server");
  await writeFile(f.config,'model_provider = "api"\n');await f.setState({quota:"malformed"});
  const missing=await f.read();assert.equal(missing.state,"unavailable");assert.equal(missing.source,"omniroute-usage-api");
  await f.setState({});assert.equal((await f.read()).state,"available");
  await writeFile(f.config,'model_provider = "native"\n');await f.setState({nativeError:true});
  const native=await f.read();assert.equal(native.state,"unavailable");assert.equal(native.source,"codex-app-server");
  await f.setState({});assert.equal((await f.read()).source,"codex-app-server");
});

test("revoking the bound connection discards its cached quota",async t=>{
  const f=await quotaService(t);assert.equal((await f.read()).state,"available");
  await f.setState({inactive:true});
  const revoked=await f.read();assert.equal(revoked.state,"unavailable");assert.equal(revoked.reason,"not-authenticated");
  await f.setState({quota:"malformed"});assert.equal((await f.read()).state,"unavailable");
});


test("invalid provider listings are protocol failures; valid missing bindings are authentication failures",async()=>{
  for(const [listing,reason] of [[{},"protocol-error"],[null,"protocol-error"],
    [{connections:{}},"protocol-error"],[{providers:"invalid"},"protocol-error"],
    [[],"not-authenticated"],[{connections:[]},"not-authenticated"]]) {
    let calls=0;
    await assert.rejects(readOmniRouteCodexLimits(ENV,async()=>{calls++;return listing;}),e=>e.reason === reason);
    assert.equal(calls,1,"invalid or unauthenticated listings never query account usage");
  }
});
