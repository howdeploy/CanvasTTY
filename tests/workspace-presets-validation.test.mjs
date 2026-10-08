import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceArchive } from "../src/main/services/WorkspaceArchive.ts";

const descriptor = (cwd, id) => ({
  id,
  provider: "codex",
  profile: "normal",
  role: "orchestrator",
  title: id,
  titleCustomized: true,
  cwd,
  position: { x: 10, y: 20 },
  size: { width: 700, height: 430 },
  lastState: "running",
  restore: true,
});

const snapshot = (cwd, id, extra = {}) => JSON.stringify({
  format: "canvastty-workspace",
  version: 1,
  sessions: [{ ...descriptor(cwd, id), ...extra }],
});

test("one invalid saved workspace preset is isolated from valid presets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-preset-isolation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = new WorkspaceArchive(directory, {
    descriptors: () => [],
    create: (request) => ({ ...request, id: "created", size: request.size }),
    setBounds: () => {},
    available: () => true,
    redact: (text) => text,
  });
  const file = join(directory, "workspace-presets.json");
  const first = { id: "daily", name: "Daily", snapshot: snapshot(directory, "first") };
  const second = { id: "review", name: "Review", snapshot: snapshot(directory, "second") };
  const malformed = { id: "broken", name: "Broken", snapshot: "{not valid JSON" };
  const invalidName = { id: "blank-name", name: "  ", snapshot: snapshot(directory, "third") };
  await writeFile(file, JSON.stringify([first, malformed, second, invalidName]));
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args.join(" ")); });

  assert.deepEqual((await archive.presets()).map(({ id, name }) => ({ id, name })), [
    { id: "daily", name: "Daily" },
    { id: "review", name: "Review" },
  ]);
  assert.equal(warnings.length, 1, "skipped presets are reported once per read");
  assert.match(warnings[0], /2 damaged workspace presets/u);
  assert.doesNotMatch(warnings[0], /Broken|first|second/u, "the warning names no preset contents");

  await archive.savePreset({ id: "new", name: "New", snapshot: snapshot(directory, "new") });
  const afterSave = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(afterSave.map(({ id }) => id), ["daily", "review", "new"]);
  assert.ok(afterSave.every(({ snapshot: value }) => JSON.parse(value).format === "canvastty-workspace"));

  await archive.deletePreset("daily");
  assert.deepEqual((await archive.presets()).map(({ id }) => id), ["review", "new"]);
});


test("portable imports never authorize plugin launcher or account choices, including saved presets", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ctty-portable-choices-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const created = [];
  const archive = new WorkspaceArchive(directory, {
    descriptors: () => [], create: request => { created.push(request); return { ...request, id: `new-${created.length}` }; },
    setBounds() {}, available: () => true, redact: text => text,
  });
  const value = snapshot(directory, "source", {
    environmentChoice: { pluginId: "example.native", kind: "remote", config: { host: "example.test" } },
    options: { "example.native": { account: "private-account" } },
    model: "model-name", effort: "high", threadId: "11111111-1111-4111-8111-111111111111",
  });
  const preview = await archive.preview(value);
  await archive.import(value, false);
  assert.equal(created[0].environment, undefined);
  assert.equal(created[0].launchOptions, undefined);
  assert.match(preview.warnings.join(" "), /reselect.*launcher/);
  assert.equal(created[0].resumeThreadId, "11111111-1111-4111-8111-111111111111");
  assert.equal(created[0].model, "model-name");
  assert.equal(created[0].effort, "high");
  await archive.savePreset({ id: "portable", name: "Portable", snapshot: value });
  await archive.import((await archive.presets())[0].snapshot, false);
  assert.equal(created[1].environment, undefined);
  assert.equal(created[1].launchOptions, undefined);
  assert.equal(created[1].resumeThreadId, undefined);
});


test("preset metadata is canonically normalized, whitelisted and redacted across reload", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ctty-preset-metadata-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const deps = {descriptors: () => [], create() {}, setBounds() {}, available: () => true,
    redact: text => text.replaceAll("fixture-private", "<redacted>")};
  const archive = new WorkspaceArchive(directory, deps);
  const value = JSON.parse(snapshot(directory, "root"));
  value.tasks = [{rootSessionId: "root", tasks: [{id: "task", rootSessionId: "root", title: "fixture-private task",
    description: "fixture-private", progress: "", ownerSessionId: "root", ownerName: "Root", status: "claimed",
    dependencies: [], result: null, createdBySessionId: "root", createdAt: 1, updatedAt: 2,
    arbitraryExecutable: "must not persist"}]}];
  value.canvas = {version: 1,
    canvasRegions: [{id: "region", title: "fixture-private lane", color: "#abcdef", position: {x: 1, y: 2}, size: {width: 1, height: 1}, dangerous: true}],
    stickyNotes: [{id: "note", text: "fixture-private note", position: {x: 3, y: 4}, size: {width: 320, height: 220}}, {id: "bad"}],
    browserCanvas: {position: {x: 5, y: 6}, size: {width: 900, height: 620}, url: "must not persist"},
    plugins: {trust: true}};
  value.nativeTrust = true;
  await archive.savePreset({id: "metadata", name: "Metadata", snapshot: JSON.stringify(value)});
  const saved = (await new WorkspaceArchive(directory, deps).presets())[0].snapshot;
  assert.doesNotMatch(saved, /fixture-private|must not persist|dangerous|nativeTrust|plugins/);
  const result = JSON.parse(saved);
  assert.ok(Array.isArray(result.tasks), "saved preset retains its task board");
  assert.ok(result.canvas, "saved preset retains its canvas");
  assert.equal(result.tasks[0].tasks[0].title, "<redacted> task");
  assert.equal(result.canvas.canvasRegions[0].color, "#ABCDEF");
  assert.deepEqual(result.canvas.canvasRegions[0].size, {width: 360, height: 240});
  assert.equal(result.canvas.stickyNotes.length, 1);
  assert.equal(result.canvas.stickyNotes[0].text, "<redacted> note");
  for (const malformed of [
    {...value, tasks: [{rootSessionId: "missing", tasks: []}]},
    {...value, tasks: [{rootSessionId: "root", tasks: [{...value.tasks[0].tasks[0], dependencies: ["missing"]}]}]},
    {...value, canvas: {...value.canvas, version: 99}},
  ]) assert.throws(() => archive.savePreset({id: "bad", name: "Bad", snapshot: JSON.stringify(malformed)}));
  assert.equal((await archive.presets()).length, 1);
});

test('preview and import reject malformed or unsupported canvas envelopes before creating cards', async t => {
  const directory=await mkdtemp(join(tmpdir(),'ctty-import-canvas-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const created=[];
  const archive=new WorkspaceArchive(directory,{descriptors:()=>[],create:request=>{created.push(request);return{...request,id:`new-${created.length}`};},setBounds(){},available:()=>true,redact:text=>text});
  for(const canvas of [null,[],[{}],'canvas',1,{}, {version:0},{version:2},{version:'1'},{version:[]},{version:null}]) {
    const text=JSON.stringify({...JSON.parse(snapshot(directory,'root')),canvas});
    await assert.rejects(archive.preview(text),/workspace canvas/);
    await assert.rejects(archive.import(text,false),/workspace canvas/);
    assert.equal(created.length,0,'invalid envelope cannot launch cards');
  }
  for(const extra of [{},{canvas:{version:1,stickyNotes:[],canvasRegions:[],browserCanvas:null}}]) {
    const text=JSON.stringify({...JSON.parse(snapshot(directory,'root')),...extra});
    assert.equal((await archive.preview(text)).count,1);
    assert.equal((await archive.import(text,false)).sessions.length,1);
  }
});

test('export supports a complete 100-card round trip and refuses 101 without truncation', async t => {
  const directory=await mkdtemp(join(tmpdir(),'ctty-export-cap-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let records=Array.from({length:100},(_,i)=>descriptor(directory,`card-${i}`));let launches=0;
  const archive=new WorkspaceArchive(directory,{descriptors:()=>records,create:request=>({...request,id:`new-${++launches}`}),setBounds(){},available:()=>true,redact:text=>text});
  const exported=archive.export();assert.equal(JSON.parse(exported).sessions.length,100);
  assert.equal((await archive.preview(exported)).count,100);assert.equal((await archive.import(exported,false)).sessions.length,100);
  records=[...records,descriptor(directory,'card-100')];
  assert.throws(()=>archive.export(),/at most 100 cards/);assert.equal(records.length,101);
});

test('portable exports and fresh presets omit opaque host/plugin state but retain inert reconnect markers',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ctty-portable-boundary-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const privateState={options:{'fixture.plugin':{accountId:'private-account-marker',config:{opaque:'private-options-marker'}}},
    environmentChoice:{pluginId:'fixture.plugin',kind:'remote',options:{account:'private-choice-marker'}},
    isolatedEnvironmentScopes:{roots:[join(directory,'private-scope-marker')],ambiguous:true},
    taskScope:{id:'private-task-id-marker',cwd:join(directory,'private-task-cwd-marker'),startedAt:123},
    ownerPluginId:'private.owner.marker',gitAuditSince:98234123,reviewRequested:true,arbitraryRuntime:'private-runtime-marker'};
  const thread='11111111-1111-4111-8111-111111111111';
  const local={...descriptor(directory,'local'),...privateState,threadId:thread,model:'fixture-model',effort:'high',lastState:'failed',exitCode:42,restore:false};
  const remote={...descriptor(directory,'remote'),...privateState,environment:{pluginId:'fixture.plugin',kind:'remote',label:'private-label-marker',ref:{opaque:'private-ref-marker'}}};
  const created=[],deps={descriptors:()=>[local,remote],create:request=>{created.push(request);return{...request,id:`new-${created.length}`};},setBounds(){},available:()=>true,redact:text=>text};
  const archive=new WorkspaceArchive(directory,deps);
  const exported=archive.export(),wire=JSON.parse(exported);
  assert.doesNotMatch(exported,/private-|98234123|gitAuditSince|taskScope|reviewRequested|ownerPluginId|environmentChoice|"options"|exitCode/);
  assert.deepEqual(wire.sessions[1].environment,{pluginId:'fixture.plugin',kind:'remote',ref:null,label:'Reconnect environment'});
  assert.equal(wire.sessions[0].threadId,thread);assert.equal(wire.sessions[0].lastState,'running');assert.equal(wire.sessions[0].restore,true);
  const imported=await archive.import(exported,false);assert.equal(imported.sessions.length,1);assert.equal(created[0].resumeThreadId,thread);
  assert.match(imported.warnings.join(' '),/environment needs to be reconnected.*skipped/);
  assert.equal(created.some(row=>row.title==='remote'),false,'connected card must not silently become a local launch');
  const raw=JSON.stringify({format:'canvastty-workspace',version:1,sessions:[local,remote]});
  await archive.savePreset({id:'portable',name:'Portable',snapshot:raw,internalAccount:'private-preset-extra-marker'});
  const reloaded=new WorkspaceArchive(directory,deps),preset=(await reloaded.presets())[0];
  assert.doesNotMatch(preset.snapshot,/private-|98234123|threadId|gitAuditSince|taskScope|reviewRequested|ownerPluginId|environmentChoice|"options"|exitCode/);
  assert.doesNotMatch(await readFile(join(directory,'workspace-presets.json'),'utf8'),/private-/);
  await reloaded.savePreset({...preset,id:'resaved'});const resaved=(await reloaded.presets()).find(row=>row.id==='resaved');
  const fresh=await reloaded.import(resaved.snapshot,false);assert.equal(fresh.sessions.length,1);assert.equal(created[1].resumeThreadId,undefined);
  assert.deepEqual(JSON.parse(resaved.snapshot).sessions[1].environment,wire.sessions[1].environment);
});
