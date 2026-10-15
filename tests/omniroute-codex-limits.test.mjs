import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readOmniRouteCodexLimits } from "../src/main/services/OmniRouteCodexLimits.ts";
import { LimitsService } from "../src/main/services/LimitsService.ts";
import { selectHomeModel } from "../src/renderer/src/features/home/homeModel.ts";

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
  assert.equal(windows[0].resetsAt, Date.parse(USAGE.quotas.session.resetAt) / 1000);
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
