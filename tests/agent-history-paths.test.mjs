import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/main/services/AgentChatHistoryService.ts"],
  bundle: true, write: false, platform: "node", format: "esm"
});
const { AgentChatHistoryService } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);

const id = "11111111-1111-4111-8111-111111111111";
const pathVariables = ["OPENCODE_HOME", "XDG_DATA_HOME", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "KIMI_CODE_HOME", "KIMI_SHARE_DIR",
  "PI_CODING_AGENT_SESSION_DIR", "OMP_PROFILE", "PI_PROFILE", "QWEN_CODE_HOME", "QWEN_HOME", "QWEN_RUNTIME_DIR"];

async function setup(t, environment) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-history-paths-"));
  const previous = Object.fromEntries(pathVariables.map(key => [key, process.env[key]]));
  for (const key of pathVariables) delete process.env[key];
  Object.assign(process.env, environment(root));
  const service = new AgentChatHistoryService(
    { get: () => ({ agentChatHistoryVisible: true, homeLauncherProviders: [] }) },
    { get: () => ({ state: "available" }) }, {}, root
  );
  t.after(async () => {
    service.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, service };
}

async function transcript(root, provider) {
  await mkdir(root, { recursive: true });
  const header = provider === "qwen" ? { sessionId: id, cwd: root, title: "Selected store" }
    : { type: "session", id, cwd: root, title: "Selected store" };
  await writeFile(join(root, `${id}.jsonl`), JSON.stringify(header) + "\n");
}

test("history service finds OpenCode in XDG_DATA_HOME instead of an unrelated OPENCODE_HOME", async t => {
  const { root, service } = await setup(t, root => ({ XDG_DATA_HOME: root, OPENCODE_HOME: join(root, "wrong") }));
  await mkdir(join(root, "opencode"));
  const db = new DatabaseSync(join(root, "opencode", "opencode.db"));
  db.exec("CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_updated INTEGER)");
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_path123", "Selected store", root, Date.now());
  db.close();
  const page = await service.list("opencode");
  assert.equal(page.error, undefined);
  assert.equal(page.items[0]?.id, "ses_path123");
});

test("history service honors Pi session-directory override", async t => {
  const { root, service } = await setup(t, root => ({ PI_CODING_AGENT_SESSION_DIR: root }));
  await transcript(root, "pi");
  const page = await service.list("pi");
  assert.equal(page.error, undefined);
  assert.equal(page.items[0]?.id, id);
});

test("history service finds Kimi Code in KIMI_CODE_HOME and preserves its native prefixed id", async t => {
  const { root, service } = await setup(t, root => ({ KIMI_CODE_HOME: root, KIMI_SHARE_DIR: join(root, "legacy") }));
  const session = join(root, "sessions", "wd_project", `session_${id}`);
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "state.json"), JSON.stringify({ id: `session_${id}`, version: 2, cwd: root, updatedAt: Date.now(), title: "Current chat", custom: {} }));
  const page = await service.list("kimi");
  assert.equal(page.error, undefined);
  assert.equal(page.items[0]?.id, `session_${id}`);
});

test("history service finds Qwen's current projects and legacy tmp stores without duplicates", async t => {
  const { root, service } = await setup(t, root => ({ QWEN_RUNTIME_DIR: root }));
  await transcript(join(root, "projects", "workspace", "chats"), "qwen");
  await transcript(join(root, "tmp", "workspace", "chats"), "qwen");
  const page = await service.list("qwen");
  assert.equal(page.error, undefined);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.id, id);
});

test("history service reads the active OMP profile rather than the default profile", async t => {
  const { root, service } = await setup(t, root => ({ PI_CONFIG_DIR: relative(homedir(), root), OMP_PROFILE: "work" }));
  await transcript(join(root, "profiles", "work", "agent", "sessions"), "omp");
  const page = await service.list("omp");
  assert.equal(page.error, undefined);
  assert.equal(page.items[0]?.id, id);
});

test("history service reads migrated OMP sessions from the existing XDG app directory", { skip: process.platform === "win32" }, async t => {
  const { root } = await setup(t, root => {
    // The CLI decides whether XDG is adopted from the app directory's existence.
    return { XDG_DATA_HOME: root };
  });
  await transcript(join(root, "omp", "sessions"), "omp");
  // Construct after the migration directory has been created, as at app startup.
  const migrated = new AgentChatHistoryService(
    { get: () => ({ agentChatHistoryVisible: true, homeLauncherProviders: [] }) },
    { get: () => ({ state: "available" }) }, {}, root
  );
  t.after(() => migrated.dispose());
  const page = await migrated.list("omp");
  assert.equal(page.error, undefined);
  assert.equal(page.items[0]?.id, id);
});

test("Qwen can have only one version's history directory and still report missing stores", async t => {
  const { root, service } = await setup(t, root => ({ QWEN_HOME: root }));
  assert.match((await service.list("qwen")).error, /not found/);
  for (const layout of ["projects", "tmp"]) {
    await transcript(join(root, layout, "workspace", "chats"), "qwen");
    const page = await service.list("qwen");
    assert.equal(page.error, undefined);
    assert.equal(page.items[0]?.id, id);
    await rm(join(root, layout), { recursive: true });
  }
});

const { resolveAgentHistoryPaths } = await import("../src/main/services/agent-history/historyPaths.ts");
for (const [platform, home, expected] of [
  ["darwin", "/Users/Alice Smith", {
    codex: "/Users/Alice Smith/.codex", grok: "/Users/Alice Smith/.grok",
    opencode: "/Users/Alice Smith/.local/share/opencode", claude: "/Users/Alice Smith/.claude/projects",
    qwen: ["/Users/Alice Smith/.qwen/projects", "/Users/Alice Smith/.qwen/tmp"], kimi: "/Users/Alice Smith/.kimi", kimiCode: "/Users/Alice Smith/.kimi-code",
    omp: "/Users/Alice Smith/.omp/agent/sessions", pi: "/Users/Alice Smith/.pi/agent/sessions",
    cursor: "/Users/Alice Smith/.cursor", minimax: "/Users/Alice Smith/.minimax"
  }],
  ["linux", "/home/runner", {
    codex: "/home/runner/.codex", grok: "/home/runner/.grok",
    opencode: "/home/runner/.local/share/opencode", claude: "/home/runner/.claude/projects",
    qwen: ["/home/runner/.qwen/projects", "/home/runner/.qwen/tmp"], kimi: "/home/runner/.kimi", kimiCode: "/home/runner/.kimi-code",
    omp: "/home/runner/.omp/agent/sessions", pi: "/home/runner/.pi/agent/sessions",
    cursor: "/home/runner/.cursor", minimax: "/home/runner/.minimax"
  }],
  ["win32", "C:\\Users\\Alice Smith", {
    codex: "C:\\Users\\Alice Smith\\.codex", grok: "C:\\Users\\Alice Smith\\.grok",
    opencode: "C:\\Users\\Alice Smith\\.local\\share\\opencode", claude: "C:\\Users\\Alice Smith\\.claude\\projects",
    qwen: ["C:\\Users\\Alice Smith\\.qwen\\projects", "C:\\Users\\Alice Smith\\.qwen\\tmp"], kimi: "C:\\Users\\Alice Smith\\.kimi", kimiCode: "C:\\Users\\Alice Smith\\.kimi-code",
    omp: "C:\\Users\\Alice Smith\\.omp\\agent\\sessions", pi: "C:\\Users\\Alice Smith\\.pi\\agent\\sessions",
    cursor: "C:\\Users\\Alice Smith\\.cursor", minimax: "C:\\Users\\Alice Smith\\.minimax"
  }]
]) {
  test(`default ${platform} history paths use that user's home and native separators`, () => {
    assert.deepEqual(resolveAgentHistoryPaths({ platform, homeDirectory: home, startupDirectory: home,
      environment: {}, pathExists: () => false }), expected);
  });
}

test("Windows history overrides use case-insensitive environment names and UNC directories", () => {
  const paths = resolveAgentHistoryPaths({ platform: "win32", homeDirectory: "C:\\Users\\Alice", startupDirectory: "C:\\workspace",
    environment: { Xdg_Data_Home: "\\\\server\\chat data", XDG_CONFIG_HOME: "D:\\config", CodeX_Home: "D:\\codex",
      CLAUDE_CONFIG_DIR: "D:\\claude", GROK_HOME: "D:\\grok", KIMI_SHARE_DIR: "D:\\kimi", MINIMAX_DATA_DIR: " D:\\minimax " },
    pathExists: () => false });
  assert.equal(paths.opencode, "\\\\server\\chat data\\opencode");
  assert.equal(paths.cursor, "D:\\config\\cursor");
  assert.equal(paths.codex, "D:\\codex");
  assert.equal(paths.claude, "D:\\claude\\projects");
  assert.equal(paths.grok, "D:\\grok");
  assert.equal(paths.kimi, "D:\\kimi");
  assert.equal(paths.minimax, "D:\\minimax");
});

test("Qwen runtime override wins over QWEN_HOME and expands home-relative paths", () => {
  const options = { platform: "linux", homeDirectory: "/home/runner", startupDirectory: "/workspace", pathExists: () => false };
  assert.deepEqual(resolveAgentHistoryPaths({ ...options, environment: { QWEN_RUNTIME_DIR: "~/history", QWEN_HOME: "/config", QWEN_CODE_HOME: "/wrong" } }).qwen,
    ["/home/runner/history/projects", "/home/runner/history/tmp"]);
  assert.deepEqual(resolveAgentHistoryPaths({ ...options, environment: { QWEN_HOME: "./config" } }).qwen,
    ["/workspace/config/projects", "/workspace/config/tmp"]);
});

test("OMP XDG adoption is profile-specific and explicit agent directories stay authoritative", () => {
  const options = { platform: "linux", homeDirectory: "/home/runner", startupDirectory: "/workspace" };
  const environment = { XDG_DATA_HOME: "/data", OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/unrelated/pi" };
  assert.equal(resolveAgentHistoryPaths({ ...options, environment, pathExists: path => path === "/data/omp" }).omp,
    "/home/runner/.omp/profiles/work/agent/sessions");
  assert.equal(resolveAgentHistoryPaths({ ...options, environment, pathExists: path => path === "/data/omp/profiles/work" }).omp,
    "/data/omp/profiles/work/sessions");
  assert.equal(resolveAgentHistoryPaths({ ...options, environment: { ...environment, OMP_PROFILE: "", PI_PROFILE: "work" }, pathExists: () => true }).omp,
    "/unrelated/pi/sessions");
  assert.equal(resolveAgentHistoryPaths({ ...options, environment: { XDG_DATA_HOME: "/data" }, pathExists: () => false }).omp,
    "/home/runner/.omp/agent/sessions");
});

test("OMP default profile discards an inherited agent-dir derived from PI_PROFILE", () => {
  const paths = resolveAgentHistoryPaths({ platform: "linux", homeDirectory: "/home/runner", startupDirectory: "/workspace",
    environment: { OMP_PROFILE: "", PI_PROFILE: "work", PI_CODING_AGENT_DIR: "/home/runner/.omp/profiles/work/agent" }, pathExists: () => false });
  assert.equal(paths.omp, "/home/runner/.omp/agent/sessions");
});

test("OMP follows migrated XDG paths on macOS but not Windows", () => {
  assert.equal(resolveAgentHistoryPaths({ platform: "darwin", homeDirectory: "/Users/runner", startupDirectory: "/workspace",
    environment: { XDG_DATA_HOME: "/data" }, pathExists: () => true }).omp, "/data/omp/sessions");
  assert.equal(resolveAgentHistoryPaths({ platform: "win32", homeDirectory: "C:\\Users\\Alice", startupDirectory: "C:\\workspace",
    environment: { XDG_DATA_HOME: "D:\\data" }, pathExists: () => true }).omp, "C:\\Users\\Alice\\.omp\\agent\\sessions");
});

test("Pi and OMP share an absolute session-directory override, independently of profile and agent roots", () => {
  const paths = resolveAgentHistoryPaths({ platform: "win32", homeDirectory: "C:\\Users\\Alice", startupDirectory: "C:\\workspace",
    environment: { PI_CODING_AGENT_SESSION_DIR: "D:\\saved chats", PI_CODING_AGENT_DIR: "D:\\agent", OMP_PROFILE: "work" }, pathExists: () => false });
  assert.equal(paths.pi, "D:\\saved chats");
  assert.equal(paths.omp, paths.pi);
});

test("Pi expands its home-relative agent directory", () => {
  const paths = resolveAgentHistoryPaths({ platform: "win32", homeDirectory: "C:\\Users\\Alice", startupDirectory: "C:\\workspace",
    environment: { PI_CODING_AGENT_DIR: "~\\pi work" }, pathExists: () => false });
  assert.equal(paths.pi, "C:\\Users\\Alice\\pi work\\sessions");
});

test("Cursor explicit config directory wins over XDG and MiniMax accepts its legacy override", () => {
  const paths = resolveAgentHistoryPaths({ platform: "linux", homeDirectory: "/home/runner", startupDirectory: "/workspace",
    environment: { CURSOR_CONFIG_DIR: "/cursor", XDG_CONFIG_HOME: "/config", MINIMAX_DATA_DIR: " ", MAVIS_DATA_DIR: "/mavis" }, pathExists: () => false });
  assert.equal(paths.cursor, "/cursor");
  assert.equal(paths.minimax, "/mavis");
});


test("person history resumes await Codex trust for fresh and exited local sessions only",async t=>{
  const {root,service}=await setup(t,()=>({}));const calls=[];
  service.adapters.codex={read:async()=>({items:[{id,cwd:root,title:"History",lastActivityAt:0}]})};
  const active={id:"card",provider:"codex",cwd:root,exitCode:null,status:"idle"};let existing=null;
  service.terminals={findLocalConversation:()=>existing,create:request=>{calls.push("create");return {...active,...request};},
    restart:()=>{calls.push("restart");return active;},list:()=>[existing],localCodexFolderForTrust:()=>root};
  const guard=async folder=>{assert.equal(folder,root);calls.push("trust");};
  assert.equal((await service.resume("codex",id,{x:0,y:0},guard)).error,undefined);
  assert.deepEqual(calls,["trust","create"]);calls.length=0;
  existing={...active,exitCode:0};
  assert.equal((await service.resume("codex",id,{x:0,y:0},guard)).reused,true);
  assert.deepEqual(calls,["trust","restart"]);calls.length=0;
  existing=active;
  await service.resume("codex",id,{x:0,y:0},guard);assert.deepEqual(calls,[]);
  existing={...active,exitCode:0};service.terminals.localCodexFolderForTrust=()=>null;
  service.terminals.restart = (_id, options) => {
    assert.equal(options.beforeLocalCodexLaunch, guard, "contributed history cards retain the authenticated guard until their profile resolves");
    calls.push("restart"); return active;
  };
  await service.resume("codex",id,{x:0,y:0},guard);assert.deepEqual(calls,["restart"]);
});

test("history trust refusal or a concurrently closed card cannot launch a session",async t=>{
  const {root,service}=await setup(t,()=>({}));let existing=null;let launches=0;
  service.adapters.codex={read:async()=>({items:[{id,cwd:root,title:"History",lastActivityAt:0}]})};
  service.terminals={findLocalConversation:()=>existing,create:()=>{launches++;},restart:()=>{launches++;},
    list:()=>[],localCodexFolderForTrust:()=>root};
  for(const card of [null,{id:"card",provider:"codex",cwd:root,exitCode:0}]){
    existing=card;
    const result=await service.resume("codex",id,{x:0,y:0},async()=>{throw new Error("Folder trust was not granted");});
    assert.match(result.error.message,/not granted/);
  }
  const closed=await service.resume("codex",id,{x:0,y:0},async()=>{});
  assert.match(closed.error.message,/closed during confirmation/);assert.equal(launches,0);
});
