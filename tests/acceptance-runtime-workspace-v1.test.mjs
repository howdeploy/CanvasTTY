import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKLOG_IPC } from "../src/shared/backlog.ts";
import { registerBacklogIpc } from "../src/main/ipc/registerBacklogIpc.ts";
import { OrchestrationTaskBoard } from "../src/main/services/OrchestrationTaskBoard.ts";
import { SessionTimelineService } from "../src/main/services/SessionTimelineService.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { WorkspaceArchive } from "../src/main/services/WorkspaceArchive.ts";

const ROOT_THREAD = "11111111-1111-4111-8111-111111111111";
const CHILD_THREAD = "22222222-2222-4222-8222-222222222222";

function providerClis() {
  return {
    get(provider) {
      return { state: "available", provider, executable: `/fixture/${provider}`, launcher: "native", environment: {}, checked: [] };
    },
    snapshot() { return {}; }
  };
}

test("host import opens a v1 workspace with absent newer card fields, remaps tasks, preserves canvas data, and resumes exact threads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-acceptance-workspace-v1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const userData = join(directory, "user-data");
  const project = join(directory, "project");
  await Promise.all([mkdir(userData), mkdir(project)]);

  const launches = [];
  const terminals = new TerminalManager(() => undefined, providerClis(), undefined, undefined, true,
    (command, args, options) => {
      launches.push({ command, args, options });
      return {
        pid: 40_000 + launches.length,
        process: command,
        write() {}, resize() {}, kill() {}, pause() {}, resume() {},
        onData() { return { dispose() {} }; },
        onExit() { return { dispose() {} }; }
      };
    });
  t.after(() => terminals.shutdown());

  const workspace = new WorkspaceArchive(userData, {
    descriptors: () => [],
    create: request => terminals.create(request),
    setBounds: (id, bounds) => terminals.setBounds(id, bounds),
    available: provider => provider === "codex",
    redact: text => text
  });
  const board = new OrchestrationTaskBoard(join(userData, "boards"));
  const original = await board.addTask(project, "legacy-root", "legacy-root", { title: "Implement the import" });
  await board.addTask(project, "legacy-root", "legacy-root", {
    title: "Review the import", ownerSessionId: "legacy-child", ownerName: "Worker", dependencies: [original.id]
  });
  const oldTasks = (await board.listTasks(project, "legacy-root")).tasks;

  // Fixed v1 wire shape from before optional taskScope/model/effort/options fields existed.
  // Extra top-level task/canvas data models the host and settings parts of current import.
  const snapshot = JSON.stringify({
    format: "canvastty-workspace",
    version: 1,
    exportedAt: 1_728_000_000_000,
    sessions: [
      { id: "legacy-root", provider: "codex", profile: "normal", role: "orchestrator", title: "Older root",
        titleCustomized: true, cwd: project, position: { x: 120, y: 240 }, size: { width: 720, height: 440 },
        lastState: "exited", exitCode: 0, restore: true, threadId: ROOT_THREAD },
      { id: "legacy-child", provider: "codex", profile: "normal", role: "subagent", title: "Older child",
        titleCustomized: true, cwd: project, position: { x: 910, y: 260 }, size: { width: 610, height: 390 },
        parentSessionId: "legacy-root", lastState: "exited", exitCode: 0, restore: true, threadId: CHILD_THREAD }
    ],
    tasks: [{ rootSessionId: "legacy-root", tasks: oldTasks }],
    canvas: {
      version: 1,
      canvasRegions: [{ id: "archive-region", title: "Review lane", color: "#336699",
        position: { x: 40, y: 880 }, size: { width: 780, height: 500 } }],
      stickyNotes: [{ id: "archive-note", text: "Resume the review thread", position: { x: 1800, y: 120 },
        size: { width: 320, height: 220 } }],
      browserCanvas: { position: { x: 2800, y: 100 }, size: { width: 900, height: 620 } }
    }
  });

  const windowWebContents = { mainFrame: {}, isDestroyed: () => false, send() {} };
  const mainWindow = { webContents: windowWebContents, isDestroyed: () => false };
  const handlers = new Map();
  const taskRoot = id => terminals.taskScopeFor(id);
  const timeline = new SessionTimelineService(userData, text => text);
  await timeline.load();
  timeline.configureSessionContext(id => {
    const row = terminals.getMetadata(id);
    return row ? {taskId: taskRoot(id).id, title: row.title} : undefined;
  });
  registerBacklogIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    usagePrices: { get: () => [], set: () => [] },
    board,
    budgets: { snapshot: () => ({}), setLimits: async () => ({}), clearLimits: async () => ({}) },
    flows: { list: async () => ({ templates: [] }), instructions: () => "", save: async () => "" },
    taskRoot,
    attention: { get: () => ({}), set: value => value, list: () => [] },
    outputHistory: { search: async () => ({ matches: [], prunedSessionIds: [] }), readContext: async () => ({ text: "" }) },
    terminals,
    timeline,
    checkpoints: { available: async () => false, list: async () => [], preview: async () => ({}), restore: async () => ({}) },
    workspace,
    getMainWindow: () => mainWindow
  });

  const event = { sender: windowWebContents, senderFrame: windowWebContents.mainFrame };
  const unmappedGroups=JSON.stringify({format:"canvastty-workspace",version:1,sessions:[],
    tasks:[{rootSessionId:"constructor",tasks:oldTasks},{rootSessionId:"toString",tasks:oldTasks}]});
  const skippedGroups=await handlers.get(BACKLOG_IPC.importWorkspace)(event,unmappedGroups,{confirmBypass:false});
  assert.deepEqual(skippedGroups,{warnings:[],sessions:[]},"inherited map entries are not restored roots");
  const imported = await handlers.get(BACKLOG_IPC.importWorkspace)(event, snapshot, { confirmBypass: false });
  assert.equal(imported.sessions.length, 2);
  const [root, child] = imported.sessions;
  const restoredIds = imported.sessions.reduce((ids, session, index) => {
    ids[index === 0 ? "legacy-root" : "legacy-child"] = session.id;
    return ids;
  }, {});
  assert.equal(child.parentSessionId, root.id, "the imported task tree keeps its parent link");
  assert.deepEqual(root.position, { x: 120, y: 240 });
  assert.deepEqual(root.size, { width: 720, height: 440 });
  assert.deepEqual(child.position, { x: 910, y: 260 });
  assert.deepEqual(child.size, { width: 610, height: 390 });
  for (const session of imported.sessions) {
    assert.equal(session.model, undefined);
    assert.equal(session.effort, undefined);
  }
  assert.equal(launches.length, 2);
  assert.deepEqual(launches.map(({ args }) => args.slice(-2)), [
    ["resume", ROOT_THREAD], ["resume", CHILD_THREAD]
  ], "both imported cards launch with their original exact conversation IDs");

  const importedTasks = (await board.listTasks(project, root.id)).tasks;
  assert.equal(importedTasks.length, 2);
  assert.equal(importedTasks[0].rootSessionId, root.id);
  assert.equal(importedTasks[1].ownerSessionId, restoredIds["legacy-child"]);
  assert.equal(importedTasks[1].dependencies[0], importedTasks[0].id);
  assert.notEqual(importedTasks[0].id, oldTasks[0].id, "task IDs are remapped on import");

  const settings = new SettingsStore(userData, "en", "linux");
  await settings.load();
  const importedSettings = await settings.update(JSON.parse(snapshot).canvas);
  assert.deepEqual(importedSettings.canvasRegions.map(({ id, title, position }) => ({ id, title, position })), [
    { id: "archive-region", title: "Review lane", position: { x: 40, y: 880 } }
  ]);
  assert.deepEqual(importedSettings.stickyNotes.map(({ id, text, position }) => ({ id, text, position })), [
    { id: "archive-note", text: "Resume the review thread", position: { x: 1800, y: 120 } }
  ]);
  assert.deepEqual(importedSettings.browserCanvas, { position: { x: 2800, y: 100 }, size: { width: 900, height: 620 } });

  await workspace.savePreset({id: "fresh", name: "Fresh", snapshot});
  const reloaded = new WorkspaceArchive(userData, {descriptors: () => [], create: request => terminals.create(request),
    setBounds: (id, bounds) => terminals.setBounds(id, bounds), available: () => true, redact: text => text});
  const presetSnapshot = (await reloaded.presets())[0].snapshot;
  assert.deepEqual(JSON.parse(presetSnapshot).canvas, JSON.parse(snapshot).canvas);
  assert.equal(JSON.parse(presetSnapshot).tasks[0].tasks.length, 2);
  const fresh = await handlers.get(BACKLOG_IPC.importWorkspace)(event, presetSnapshot, {confirmBypass: false});
  const freshTasks = (await board.listTasks(project, fresh.sessions[0].id)).tasks;
  assert.equal(freshTasks.length, 2);
  assert.equal(freshTasks[1].ownerSessionId, fresh.sessions[1].id);
  assert.equal(freshTasks[1].dependencies[0], freshTasks[0].id);
  assert.notEqual(freshTasks[0].id, importedTasks[0].id);
  assert.ok(launches.slice(2).every(({args}) => !args.includes("resume")), "presets start fresh conversations");
  const freshSettings = await settings.update(JSON.parse(presetSnapshot).canvas);
  assert.deepEqual(freshSettings.stickyNotes, importedSettings.stickyNotes);
  for (const row of fresh.sessions.toReversed()) terminals.dispose(row.id);

  await timeline.append(child.id, "checkpoint", "Closed child rollback point");
  await timeline.append(root.id, "command", "Parent command");
  await timeline.append("unknown-closed", "file", "Legacy child with no proven task");
  const foreign = terminals.create({provider: "codex", profile: "normal", cwd: project, position: {x: 0, y: 0}});
  await timeline.append(foreign.id, "loop", "Unrelated task warning");
  const continuation = root;
  terminals.dispose(child.id); terminals.dispose(foreign.id);
  await timeline.load();
  const page = await handlers.get(BACKLOG_IPC.timeline)(event, continuation.id, undefined, 1);
  assert.equal(page.items[0].summary, "Parent command");
  assert.ok(page.facets.agents.some(row => row.id === child.id && row.title === child.title));
  assert.ok(page.facets.types.includes("checkpoint"), "older types are selectable before paging");
  assert.ok(!page.facets.agents.some(row => row.id === foreign.id || row.id === "unknown-closed"));
  const closed = await handlers.get(BACKLOG_IPC.timeline)(event, continuation.id, undefined, 50,
    {sessionIds: [child.id], types: ["checkpoint"]});
  assert.deepEqual(closed.items.map(row => row.summary), ["Closed child rollback point"]);
  await assert.rejects(handlers.get(BACKLOG_IPC.timeline)(event, continuation.id, undefined, 50, {sessionIds: [foreign.id]}), /Invalid timeline filter/u);
  await assert.rejects(handlers.get(BACKLOG_IPC.timeline)(event, continuation.id, undefined, 50, {sessionIds: ["unknown-closed"]}), /Invalid timeline filter/u);

  const usageRoot = terminals.create({provider: "codex", profile: "normal", role: "orchestrator", cwd: project,
    position: {x: 0, y: 0}, title: "Usage root"});
  const usageChild = terminals.create({provider: "codex", profile: "normal", role: "subagent", parentSessionId: usageRoot.id,
    cwd: project, position: {x: 0, y: 0}, title: "Usage child"});
  const usageGrandchild = terminals.create({provider: "codex", profile: "normal", role: "subagent", parentSessionId: usageChild.id,
    cwd: project, position: {x: 0, y: 0}, title: "Usage grandchild"});
  const historicalChild = terminals.create({provider: "codex", profile: "normal", role: "subagent", parentSessionId: usageRoot.id,
    cwd: project, position: {x: 0, y: 0}, title: "Historical child"});
  const unrelated = terminals.create({provider: "codex", profile: "normal", role: "orchestrator", cwd: project,
    position: {x: 0, y: 0}, title: "Unrelated usage"});
  await timeline.recordUsage(usageChild.id, 1, 2, "child-first", undefined, {taskId: usageRoot.id});
  await timeline.recordUsage(usageRoot.id, 1, 2, "root-second", undefined, {taskId: usageRoot.id});
  await timeline.recordUsage(usageGrandchild.id, 1, 2, "grandchild-third", undefined, {taskId: usageRoot.id});
  await timeline.recordUsage(historicalChild.id, 1, 2, "historical-fourth", undefined, {taskId: usageRoot.id});
  await timeline.recordUsage(unrelated.id, 10, 20, "unrelated");
  terminals.dispose(historicalChild.id);
  const listMetadata = terminals.listMetadata.bind(terminals);
  terminals.listMetadata = () => listMetadata().reverse();
  let usage;
  try { usage = await handlers.get(BACKLOG_IPC.usage)(event, usageRoot.id); }
  finally { terminals.listMetadata = listMetadata; }
  assert.deepEqual(usage.tokens, {input: 4, output: 8, total: 12}, "root, nested descendants, and historical task counters are included");
  assert.equal(usage.source, "child-first, root-second, grandchild-third, historical-fourth",
    "usage source order follows observed timeline order, regardless of metadata discovery order");
  assert.throws(() => handlers.get(BACKLOG_IPC.usage)(event, "missing-session"), /Session no longer exists/u);
  terminals.dispose(usageGrandchild.id); terminals.dispose(usageChild.id); terminals.dispose(usageRoot.id); terminals.dispose(unrelated.id);
});
