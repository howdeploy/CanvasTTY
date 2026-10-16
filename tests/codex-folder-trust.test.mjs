import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canvasTtyPrivateData } from "../src/main/services/safety/baseProtection.ts";
import { privateAppData } from "../src/main/services/isolation/isolationPaths.ts";
import { ensureCodexFolderTrust, usesLocalCodexConfig } from "../src/main/services/CodexFolderTrust.ts";

async function fixture(t, { trusted = false, conflict = false, fresh = false, layerConfig, serialized = false, profileAlias = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvas-folder-trust-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "profile"), cwd = join(root, 'project.with dot " Ю');
  await mkdir(home); await mkdir(cwd);
  const profile = profileAlias ? join(root, "profile-link") : home;
  if (profileAlias) await symlink(home, profile, "dir");
  const projects = {projects: trusted ? {[cwd]: {trust_level:"trusted"}} : {}};
  const userConfig = layerConfig === undefined ? (fresh ? "{}" : serialized ? JSON.stringify(projects) : projects) : layerConfig;
  const config = join(home, "config.toml"), calls = join(root, "calls.jsonl"), cli = join(root, "codex");
  const versionFile = join(root, "version");
  await writeFile(versionFile, "1");
  if (!fresh) await writeFile(config, 'model = "existing-model"\napproval_policy = "never"\n');
  await writeFile(cli, `#!${process.execPath}
const fs = require("node:fs"), readline = require("node:readline");
const file = ${JSON.stringify(config)}, folder = ${JSON.stringify(cwd)}, versionFile = ${JSON.stringify(versionFile)};
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m = JSON.parse(line); if(m.id === undefined) return;
 fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(m)+"\\n");
 let result = {};
 if(m.method === "config/read") result = {layers:[{name:{type:"user",file},version:"version-"+fs.readFileSync(versionFile,"utf8"),config:${JSON.stringify(userConfig)}}]};
 if(m.method === "config/batchWrite") {
  if(${conflict} || m.params.expectedVersion !== "version-"+fs.readFileSync(versionFile,"utf8")) { process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:"version conflict"}})+"\\n"); return; }
  fs.writeFileSync(versionFile,String(Number(fs.readFileSync(versionFile,"utf8"))+1));
  fs.appendFileSync(file, "# TRUST-SAVED\\n");
 }
 process.stdout.write(JSON.stringify({id:m.id,result})+"\\n");
});
`, { mode: 0o700 });
  return { root, cwd, config, calls, options: {
    providerClis:{get:()=>({state:"available",provider:"codex",executable:cli,launcher:"native",environment:{CODEX_HOME:profile},checked:[]})},
    clientVersion:"test",cwd,backupDirectory:join(root,"backups")
  }, messages: async()=> (await readFile(calls,"utf8")).trim().split("\n").map(JSON.parse) };
}
const posix = { skip: process.platform === "win32" ? "native fixture launcher is POSIX" : false };

test("the host saves exactly the person's folder trust, with a version guard and private backup", posix, async t=>{
  const f = await fixture(t); const before = await readFile(f.config);
  let confirmed=0;
  await ensureCodexFolderTrust({...f.options,confirm:async folder=>{assert.equal(folder,f.cwd);confirmed++;return true;}});
  assert.equal(confirmed,1);
  const writes=(await f.messages()).filter(m=>m.method === "config/batchWrite");
  assert.deepEqual(writes.map(m=>m.params),[{filePath:f.config,expectedVersion:"version-1",edits:[{
    keyPath:`projects.${JSON.stringify(f.cwd)}.trust_level`,value:"trusted",mergeStrategy:"upsert"
  }]}]);
  const [backup] = await readdir(f.options.backupDirectory);
  assert.deepEqual(await readFile(join(f.options.backupDirectory,backup)),before);
  assert.equal((await f.messages()).find(m=>m.method === "config/read").params.cwd,undefined,"untrusted project config is not loaded");
});

test("declining trust never writes configuration or creates a backup", posix, async t=>{
  const f=await fixture(t); const before=await readFile(f.config);
  await assert.rejects(ensureCodexFolderTrust({...f.options,confirm:async()=>false}),/not granted/);
  assert.deepEqual(await readFile(f.config),before);
  assert.equal((await f.messages()).some(m=>m.method === "config/batchWrite"),false);
  await assert.rejects(readdir(f.options.backupDirectory),{code:"ENOENT"});
});

test("a persisted trusted folder needs no new approval or write", posix, async t=>{
  const f=await fixture(t,{trusted:true});
  await ensureCodexFolderTrust({...f.options,confirm:async()=>{assert.fail("already trusted");}});
  assert.equal((await f.messages()).some(m=>m.method === "config/batchWrite"),false);
});

test("concurrent config changes fail closed without replacing settings", posix, async t=>{
  const f=await fixture(t,{conflict:true}); const before=await readFile(f.config);
  await assert.rejects(ensureCodexFolderTrust({...f.options,confirm:async()=>true}),/protocol-error/);
  assert.deepEqual(await readFile(f.config),before);
});

test("a fresh profile can persist trust without an existing config to back up", posix, async t=>{
  const f=await fixture(t,{fresh:true});
  await ensureCodexFolderTrust({...f.options,confirm:async()=>true});
  assert.match(await readFile(f.config,"utf8"),/TRUST-SAVED/);
  await assert.rejects(readdir(f.options.backupDirectory),{code:"ENOENT"});
});

test("the trust writer is reachable only from authenticated person IPC, never an agent gateway", async()=>{
  const source=await readFile(new URL("../src/main/ipc/registerIpc.ts",import.meta.url),"utf8");
  for(const channel of ["terminalCreate","terminalRestart","agentChatHistoryResume"]) {
    const start=source.indexOf(`IPC.${channel},`),end=source.indexOf("ipcMain.",start);
    const handler=source.slice(start,end);
    assert.match(handler,/assertMainRenderer\(event, getMainWindow\)/);
    assert.match(handler,channel === "agentChatHistoryResume" ? /agentChatHistory\.resume\(provider, id, position, trustCodexFolder\)/ : /await trustCodexFolder/);
    if (channel === "terminalCreate") {
      assert.match(handler,/!.*parentSessionId/);
      assert.match(handler,/terminals\.create\(request, \{ beforeLocalCodexLaunch: trustCodexFolder \}\)/);
    }
    else if (channel === "terminalRestart") {
      assert.match(handler,/localCodexFolderForTrust/);
      assert.match(handler,/terminals\.restart\(id, \{[^\n]*beforeLocalCodexLaunch: trustCodexFolder/);
    }
  }
  for(const name of ["services/AgentControlService.ts","services/agent-control/AgentControlGateway.ts","services/PluginSessions.ts"]) {
    assert.doesNotMatch(await readFile(new URL(`../src/main/${name}`,import.meta.url),"utf8"),/ensureCodexFolderTrust|trustCodexFolder/);
  }
});

test("configuration backups are private to the host in both protection layers",()=>{
  const root=join(tmpdir(),"canvas-private-data");
  assert.ok(privateAppData(root).includes(join(root,"codex-config-backups")));
  assert.ok(canvasTtyPrivateData(root).paths.includes(join(root,"codex-config-backups")));
});


test("serialized user configuration preserves an existing exact-folder trust decision", posix, async t=>{
  const f=await fixture(t,{trusted:true,serialized:true});
  await ensureCodexFolderTrust({...f.options,confirm:async()=>assert.fail("already trusted")});
  assert.equal((await f.messages()).some(m=>m.method === "config/batchWrite"),false);
});

for (const layerConfig of ["not-json", "null", "[]", "42", null, []]) {
  test(`invalid user layer ${JSON.stringify(layerConfig)} cannot authorize a trust write`, posix, async t=>{
    const f=await fixture(t,{layerConfig});
    await assert.rejects(ensureCodexFolderTrust({...f.options,confirm:async()=>assert.fail("unsafe layer")}),/identified safely/);
    assert.equal((await f.messages()).some(m=>m.method === "config/batchWrite"),false);
  });
}

for (const state of [{fresh:true},{trusted:true},{trusted:false}]) {
  test(`a symlinked profile supports folder trust (${JSON.stringify(state)})`, posix, async t=>{
    const f=await fixture(t,{...state,profileAlias:true});
    await ensureCodexFolderTrust({...f.options,confirm:async()=>{assert.notEqual(state.trusted,true);return true;}});
    const writes=(await f.messages()).filter(m=>m.method === "config/batchWrite");
    assert.equal(writes.length,state.trusted ? 0 : 1);
    if(writes.length) assert.equal(writes[0].params.filePath,f.config);
  });
}

test("a symlinked config file is matched, backed up and written through its canonical path", posix, async t=>{
  const f=await fixture(t), target=join(f.root,"actual-config.toml");
  const before=await readFile(f.config);
  await rename(f.config,target);await symlink(target,f.config);
  await ensureCodexFolderTrust({...f.options,confirm:async()=>true});
  const write=(await f.messages()).find(m=>m.method === "config/batchWrite");
  assert.equal(write.params.filePath,target);
  const [backup]=await readdir(f.options.backupDirectory);
  assert.deepEqual(await readFile(join(f.options.backupDirectory,backup)),before);
});


test("an existing serialized empty config can save trust with a backup",posix,async t=>{
  const f=await fixture(t,{layerConfig:"{}"});
  await ensureCodexFolderTrust({...f.options,confirm:async()=>true});
  assert.equal((await f.messages()).filter(m=>m.method === "config/batchWrite").length,1);
  assert.equal((await readdir(f.options.backupDirectory)).length,1);
});

test("a profile alias changed during confirmation cannot redirect a trust write",posix,async t=>{
  const f=await fixture(t,{profileAlias:true}), other=join(f.root,"other-profile");
  await mkdir(other);
  await assert.rejects(ensureCodexFolderTrust({...f.options,confirm:async()=>{
    const alias=f.options.providerClis.get("codex").environment.CODEX_HOME;
    await rm(alias);await symlink(other,alias,"dir");return true;
  }}),/profile changed/);
  assert.equal((await f.messages()).some(m=>m.method === "config/batchWrite"),false);
});


test("concurrent person-approved launches reread the profile after each host trust write", posix, async t => {
  const f = await fixture(t);
  const other = join(f.root, "another-project");
  await mkdir(other);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let entered;
  const confirming = new Promise(resolve => { entered = resolve; });
  const first = ensureCodexFolderTrust({ ...f.options, confirm: async () => { entered(); await waiting; return true; } });
  await confirming;
  const alias = join(f.root, "profile-alias");
  await symlink(join(f.root, "profile"), alias, "dir");
  const cli = f.options.providerClis.get();
  const second = ensureCodexFolderTrust({ ...f.options, cwd: other,
    providerClis: { get: () => ({ ...cli, environment: { CODEX_HOME: alias } }) }, confirm: async () => true });
  release();
  await Promise.all([first, second]);
  const writes = (await f.messages()).filter(m => m.method === "config/batchWrite");
  assert.deepEqual(writes.map(m => m.params.expectedVersion), ["version-1", "version-2"]);
  assert.deepEqual(writes.map(m => m.params.edits[0].keyPath), [f.cwd, other].map(folder => `projects.${JSON.stringify(folder)}.trust_level`));
});

test("a declined launch does not poison the next queued profile trust operation", posix, async t => {
  const f = await fixture(t);
  const first = ensureCodexFolderTrust({ ...f.options, confirm: async () => false });
  const rejected = assert.rejects(first, /not granted/);
  const second = ensureCodexFolderTrust({ ...f.options, confirm: async () => true });
  await Promise.all([rejected, second]);
  assert.equal((await f.messages()).filter(m => m.method === "config/batchWrite").length, 1);
});


test("resolved Codex config identity follows the user home unless CODEX_HOME selects it", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvas-profile-identity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), other = join(root, "other");
  await mkdir(home); await mkdir(other);
  const configHome = join(home, ".codex");
  assert.equal(await usesLocalCodexConfig({ CODEX_HOME: configHome }, { CODEX_HOME: configHome, EXTRA: "yes" }), true);
  assert.equal(await usesLocalCodexConfig({ CODEX_HOME: configHome }, { CODEX_HOME: configHome, HOME: other, USERPROFILE: other }), true);
  assert.equal(await usesLocalCodexConfig({ CODEX_HOME: configHome }, { CODEX_HOME: join(other, "new", "profile") }), false);
  await assert.rejects(usesLocalCodexConfig({ CODEX_HOME: configHome }, { CODEX_HOME: "relative-profile" }), /absolute/);
  if (process.platform === "win32") {
    assert.equal(await usesLocalCodexConfig({}, { HOME: home, USERPROFILE: other }), true, "Windows uses the OS account profile");
    assert.equal(await usesLocalCodexConfig({}, { codex_home: join(userInfo().homedir, ".codex") }), true);
  } else {
    assert.equal(await usesLocalCodexConfig({ HOME: home }, { HOME: home, EXTRA: "yes" }), true);
    assert.equal(await usesLocalCodexConfig({ HOME: home }, { HOME: other }), false);
    assert.equal(await usesLocalCodexConfig({ HOME: home }, { HOME: other, CODEX_HOME: configHome }), true);
    assert.equal(await usesLocalCodexConfig({ HOME: userInfo().homedir }, { HOME: "" }), true);
  }
});

test("profile aliases and config-file aliases still identify the local Codex configuration", posix, async t => {
  const f = await fixture(t);
  const alias = join(f.root, "alias");
  await symlink(join(f.root, "profile"), alias, "dir");
  assert.equal(await usesLocalCodexConfig({ CODEX_HOME: join(f.root, "profile") }, { CODEX_HOME: alias }), true);
  const other = join(f.root, "other-profile");
  await mkdir(other);
  await symlink(f.config, join(other, "config.toml"));
  assert.equal(await usesLocalCodexConfig({ CODEX_HOME: alias }, { CODEX_HOME: other }), true);
});
