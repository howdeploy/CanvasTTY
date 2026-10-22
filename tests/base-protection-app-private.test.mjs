/**
 * Base protection of CanvasTTY's own private data: its control token and descriptor, the gateways' connection
 * records and sockets, the secret stores and account homes. Everything lives in temporary folders: HOME and the
 * userData folder are fakes, nothing real is read, and no socket is opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAction } from "../src/main/services/safety/commandFacts.ts";
import { canvasTtyPrivateData, checkBaseProtection, denyRule } from "../src/main/services/safety/baseProtection.ts";
import { DecisionHooks } from "../src/main/services/DecisionHooks.ts";
import { guardedCall } from "../src/agent-runtime/opencode-decisions.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "canvastty-app-private-")));
const home = join(base, "home");
const project = join(base, "project");
const userData = join(home, "Library", "Application Support", "canvastty");
const control = join(userData, "agent-control");
for (const dir of [project, join(project, "src"), join(project, "agent-control"), control, join(userData, "plugin-secrets"), join(userData, "account-homes", "acct-1", ".claude"), join(userData, "lifecycle", "runtime")]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(control, "token-0123abcd"), "fake-token\n", { mode: 0o600 });
writeFileSync(join(control, "connection.json"), "{}\n", { mode: 0o600 });
writeFileSync(join(userData, "settings.json"), "{}\n");
writeFileSync(join(project, "agent-control", "token-1"), "fixture\n");
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

const privateData = canvasTtyPrivateData(userData);
const token = join(control, "token-0123abcd");
const shell = (command) => ({ kind: "shell", command, commandCwd: null, paths: [] });
const rule = (command, extra = {}) => denyRule(analyzeAction(shell(command), project, { home, privateData, ...extra }));
const q = (path) => `'${path}'`;
const sock = "$TMPDIR/ctty-control-Ab12Cd/c.sock";

const DENY = [
  // Reading the token and the descriptor, whatever the program.
  `cat ${q(token)}`,
  `cat "$HOME/Library/Application Support/canvastty/agent-control/token-0123abcd"`,
  "cat ~/Library/Application\\ Support/canvastty/agent-control/token-*",
  `head -c 64 ${q(join(control, "connection.json"))}`,
  `grep -a . ${q(token)}`,
  `cp ${q(token)} ./copy.txt`,
  `base64 < ${q(token)}`,
  `xxd ${q(join(userData, "provider-secrets.bin"))}`,
  `strings ${q(join(userData, "provider-secrets.bin"))}`,
  `sqlite3 ${q(join(userData, "account-homes", "acct-1", "state.db"))} .dump`,
  `cat ${q(join(userData, "github-oauth.json"))}`,
  `cat ${q(join(userData, "lifecycle", "runtime", "connection.json"))}`,
  `ls ${q(control)}`,
  `cd ${q(control)} && cat token-0123abcd`,
  `cd ${q(userData)} && cat agent-control/token-0123abcd`,
  `echo "$(cat ${q(token)})"`,
  `bash -c "cat ${q(token)}"`,
  `find ${q(userData)} -name 'token-*'`,
  `grep -r token ${q(userData)}`,
  `rg secret ${q(userData)}`,
  `tar -czf out.tgz ${q(userData)}`,
  `cat ${q(userData)}/*/token-*`,
  "cat \"$CANVASTTY_CONTROL_CONNECTION\"",
  "echo $CANVASTTY_RUNTIME_CAPABILITY",
  // Interpreter one-liners and heredocs.
  `python3 -c "print(open('${token}').read())"`,
  "python3 -c \"import os;p=os.path.join(os.path.expanduser('~'),'Library','Application Support','canvastty','agent-control');print(os.listdir(p))\"",
  "node -e \"console.log(require('fs').readFileSync(process.env.HOME + '/Library/Application Support/canvastty/plugin-secrets/x', 'utf8'))\"",
  `python3 - <<'EOF'\nprint(open("${token}").read())\nEOF`,
  // The control and runtime sockets.
  `curl --unix-socket ${sock} http://localhost/`,
  `curl -s --unix-socket=${sock} http://x/`,
  `nc -U ${sock}`,
  "echo '{\"v\":1}' | nc -U $TMPDIR/ctty-orch-501-abcd1234/o.sock",
  `socat - UNIX-CONNECT:${sock}`,
  "ls $TMPDIR/ctty-control-*",
  "cat $TMPDIR/ctty-*/c.sock",
  "python3 -c \"import socket,os;s=socket.socket(socket.AF_UNIX);s.connect(os.environ['TMPDIR']+'/ctty-control-x/c.sock')\"",
  `nc -U ${q(join(userData, "lifecycle", "runtime", "r-ab12.sock"))}`,
  // A controlled-looking word that is not the CLI does not excuse the rest.
  `cat ${q(token)} canvastty-control.mjs`
];

const ALLOW = [
  "cat src/agent-control.ts",
  "cat agent-control/token-1",
  "grep -rn \"plugin-secrets\" src",
  "git commit -m \"fix agent-control token file mode\"",
  `cat ${q(join(userData, "settings.json"))}`,
  `ls ${q(userData)}`,
  "node \"$CANVASTTY_CONTROL_CLI\" list",
  `node /Applications/CanvasTTY.app/Contents/Resources/agent-control/canvastty-control.mjs --connection ${q(join(control, "connection.json"))} list`,
  "curl --unix-socket /var/run/docker.sock http://localhost/version",
  "nc -U /tmp/other.sock",
  "ls $TMPDIR",
  "ls /tmp/ctty-notes",
  "python3 -c \"print('canvastty')\"",
  "cat ~/.config/other/token",
  "node -e \"console.log(1)\"",
  "curl https://example.com/agent-control/token-1",
  "echo hi > out.txt"
];

test("CanvasTTY's own tokens, secret stores and sockets are refused for every reader and client", () => {
  for (const command of DENY) assert.equal(rule(command), "app-private", command);
});

test("the per-card Claude Code draft folders are private data too", () => {
  const draft = join(userData, "claude-draft", "card-2", "draft.1");
  assert.equal(rule(`cat ${q(draft)}`), "app-private");
  assert.equal(rule(`touch ${q(join(userData, "claude-draft", "card-2", "req.1"))}`), "app-private");
  assert.equal(rule("cat \"$HOME/Library/Application Support/canvastty/claude-draft/card-2/draft.1\""), "app-private");
  assert.equal(rule("cat notes/claude-drafting.md"), null, "a project file with a similar name stays allowed");
});

test("look-alikes in the project, the app's other files and other sockets stay allowed", () => {
  for (const command of ALLOW) assert.equal(rule(command), null, command);
});

test("a broad project (HOME, or a folder holding the app's data) cannot reopen the private data below it", () => {
  const secrets = join(userData, "provider-secrets.bin");
  const otherAccount = join(userData, "account-homes", "acct-2", "auth.json");
  for (const root of [home, join(home, "Library"), userData]) {
    const broad = (command, extra = {}) => denyRule(analyzeAction(shell(command), root, { home, privateData, ...extra }));
    const tool = (toolName, toolInput, extra = {}) => checkBaseProtection({ toolName, toolInput, root, home, privateData, ...extra })?.rule ?? null;
    for (const command of [
      `cat ${q(secrets)}`,
      "cat ~/Library/Application\\ Support/canvastty/provider-secrets.bin",
      `cat ${q(token)}`,
      `cat ${q(join(userData, "github-oauth.json"))}`,
      `cat ${q(otherAccount)}`,
      `ls ${q(join(userData, "plugin-secrets"))}`,
      `cat ${q(join(userData, "lifecycle", "runtime", "connection.json"))}`,
      `cd ${q(userData)} && cat provider-secrets.bin`,
      `python3 -c "print(open('${secrets}','rb').read())"`,
      `echo x > ${q(secrets)}`,
      `cp ./x ${q(token)}`,
      `grep -r token ${q(userData)}`
    ]) assert.equal(broad(command), "app-private", `${root}: ${command}`);
    assert.equal(tool("Write", { file_path: secrets, content: "x" }), "app-private", `${root}: Write`);
    assert.equal(tool("Edit", { file_path: join(userData, "github-oauth.json"), old_string: "a", new_string: "b" }), "app-private", `${root}: Edit`);
    assert.equal(tool("apply_patch", { input: `*** Begin Patch\n*** Update File: ${token}\n*** End Patch` }), "app-private", `${root}: apply_patch`);
    assert.equal(tool("Bash", { command: `cat ${q(secrets)}` }), "app-private", `${root}: Bash`);
    // The app's other files, and the project's own ordinary files, stay usable.
    assert.equal(broad(`cat ${q(join(userData, "settings.json"))}`), null, root);
    assert.equal(broad(`ls ${q(userData)}`), null, root);
    // The agent's own account home (strictly inside account-homes) stays its own; its neighbours do not.
    const accountHome = join(userData, "account-homes", "acct-1", ".claude");
    assert.equal(broad(`cat ${q(join(accountHome, "projects", "p", "memory", "MEMORY.md"))}`, { agentRoots: [accountHome] }), null, root);
    assert.equal(tool("Write", { file_path: join(accountHome, "plans", "p.md"), content: "x" }, { agentRoots: [accountHome] }), null, root);
    assert.equal(broad(`cat ${q(otherAccount)}`, { agentRoots: [accountHome] }), "app-private", root);
    assert.equal(broad(`cat ${q(secrets)}`, { agentRoots: [accountHome] }), "app-private", root);
  }
  const atHome = (command) => denyRule(analyzeAction(shell(command), home, { home, privateData }));
  assert.equal(atHome(`cat ${q(join(home, "notes.txt"))}`), null);
  assert.equal(atHome("grep -rn todo ."), null, "a recursive search of the project itself is not a read of the app's folder");
});

test("a broad agent config folder does not reopen the private data below it either", () => {
  assert.equal(rule(`cat ${q(token)}`, { agentRoots: [home] }), "app-private");
  assert.equal(rule(`cat ${q(join(home, "notes.txt"))}`, { agentRoots: [home] }), null);
});

test("a project in a temporary folder does not make the gateways' socket folders its own", () => {
  const temp = realpathSync(tmpdir());
  const atTemp = (command) => denyRule(analyzeAction(shell(command), temp, { home, privateData }));
  assert.equal(atTemp(`nc -U ${q(join(temp, "ctty-control-Ab12Cd", "c.sock"))}`), "app-private");
  assert.equal(atTemp(`cat ${q(join(temp, "ctty-runtime-501-ab12", "connection.json"))}`), "app-private");
  assert.equal(atTemp(`cat ${q(join(temp, "notes.txt"))}`), null);
});

test("a project inside the app's private data keeps its own files, not its neighbours", () => {
  const accountProject = join(userData, "account-homes", "acct-1");
  const inside = (command) => denyRule(analyzeAction(shell(command), accountProject, { home, privateData }));
  assert.equal(inside("cat .claude/settings.json"), null);
  assert.equal(inside(`cat ${q(join(userData, "account-homes", "acct-2", "auth.json"))}`), "app-private");
  assert.equal(inside(`cat ${q(join(userData, "provider-secrets.bin"))}`), "app-private");
});

test("plugin data is private: another account's home is refused; the card's own selected home and a project placed there stay its own", () => {
  const pluginData = join(userData, "plugin-data");
  const own = join(pluginData, "com.example.accounts", "homes", "acct-1");
  const other = join(pluginData, "com.example.accounts", "homes", "acct-2");
  const check = (toolName, toolInput, extra = {}) => checkBaseProtection({ toolName, toolInput, root: project, home, privateData, ...extra })?.rule ?? null;
  const ownRoots = { agentRoots: [join(home, ".claude"), own] };
  for (const extra of [{}, ownRoots]) {
    assert.equal(check("Bash", { command: `cat ${q(join(other, "auth.json"))}` }, extra), "app-private");
    assert.equal(check("Read", { file_path: join(other, "auth.json") }, extra), "app-private");
    assert.equal(check("Bash", { command: `cat ${q(join(pluginData, "com.example.accounts", "state.json"))}` }, extra), "app-private");
    assert.equal(check("LS", { path: pluginData }, extra), "app-private");
    assert.equal(check("Grep", { pattern: "token", path: join(pluginData, "com.example.accounts") }, extra), "app-private");
    assert.equal(check("Bash", { command: "cat ~/Library/Application\\ Support/canvastty/plugin-data/*/homes/*/auth.json" }, extra), "app-private");
    assert.equal(check("Bash", { command: `cat ${q(join(pluginData, "com.example.other", "data.json"))}` }, extra), "app-private");
  }
  // Without the launch's record the selected home is plugin data like any other.
  assert.equal(check("Read", { file_path: join(own, "auth.json") }), "app-private");
  assert.equal(check("Read", { file_path: join(own, "auth.json") }, ownRoots), null);
  assert.equal(check("Bash", { command: `cat ${q(join(own, "auth.json"))} && echo x > ${q(join(own, "plans", "p.md"))}` }, ownRoots), null);
  assert.equal(check("Grep", { pattern: "x", path: own }, ownRoots), null);
  // A whole plugin's data folder is never one card's own.
  assert.equal(check("Read", { file_path: join(other, "auth.json") }, { agentRoots: [pluginData] }), "app-private");
  // A project CanvasTTY placed inside plugin data (an environment's worktree) keeps its own files, code naming them too.
  const worktree = join(pluginData, "com.example.environments", "worktrees", "w1");
  const inWorktree = (command) => denyRule(analyzeAction(shell(command), worktree, { home, privateData }));
  assert.equal(inWorktree("cat src/a.ts && git status"), null);
  assert.equal(inWorktree(`python3 -c "open(${JSON.stringify(join(worktree, "src", "a.ts"))}).read()"`), null);
  assert.equal(inWorktree(`cat ${q(join(pluginData, "com.example.environments", "worktrees", "w2", "a.ts"))}`), "app-private");
  // A normal project is unaffected.
  for (const command of ["cat src/a.ts", "grep -r todo .", `ls ${q(userData)}`, `cat ${q(join(project, "plugin-data", "x.json"))}`]) {
    assert.equal(check("Bash", { command }), null, command);
  }
  assert.equal(check("Read", { file_path: join(project, "src", "a.ts") }), null);
});

test("file tools that name private data are refused; the agent's own account home is its own", () => {
  const check = (toolName, toolInput, extra = {}) => checkBaseProtection({ toolName, toolInput, root: project, home, privateData, ...extra });
  assert.equal(check("Write", { file_path: join(control, "token-x"), content: "x" })?.rule, "app-private");
  assert.equal(check("edit", { file_path: "~/Library/Application Support/canvastty/plugin-secrets/p.json" })?.rule, "app-private");
  const accountHome = join(userData, "account-homes", "acct-1", ".claude");
  assert.equal(check("Write", { file_path: join(accountHome, "plans", "p.md") }, { agentRoots: [accountHome] }), null);
  assert.equal(check("Bash", { command: `cat ${q(join(accountHome, "projects", "p", "memory", "MEMORY.md"))}` }, { agentRoots: [accountHome] }), null);
  assert.equal(check("Bash", { command: `cat ${q(token)}` }, { agentRoots: [accountHome] })?.rule, "app-private");
});

test("read-only file tools are refused only for CanvasTTY's private data", () => {
  const secrets = join(userData, "provider-secrets.bin");
  const accountHome = join(userData, "account-homes", "acct-1", ".claude");
  for (const root of [project, home]) {
    const read = (toolName, toolInput, extra = {}) => checkBaseProtection({ toolName, toolInput, root, home, privateData, ...extra })?.rule ?? null;
    for (const [toolName, toolInput, extra] of [
      ["Read", { file_path: secrets }],
      ["Read", { file_path: "~/Library/Application Support/canvastty/agent-control/token-0123abcd" }],
      ["NotebookRead", { notebook_path: join(userData, "github-oauth.json") }],
      ["Grep", { pattern: "token", path: userData }],
      ["Grep", { pattern: "x", path: join(userData, "plugin-secrets") }],
      ["Glob", { pattern: "*", path: control }],
      ["Glob", { pattern: join(userData, "provider-*") }],
      ["LS", { path: join(userData, "account-homes") }],
      ["read_file", { absolute_path: secrets }],
      ["read_many_files", { paths: [join(userData, "plugin-secrets")] }],
      ["grep_search", { pattern: "x", path: userData }],
      ["list_directory", { path: control }],
      ["Read", { file_path: join(userData, "account-homes", "acct-2", "auth.json") }, { agentRoots: [accountHome] }]
    ]) assert.equal(read(toolName, toolInput, extra), "app-private", `${root}: ${toolName} ${JSON.stringify(toolInput)}`);
    // Everything else stays as it was: reads outside the project are not "outside", and nothing new is refused.
    for (const [toolName, toolInput] of [
      ["Read", { file_path: join(project, "src", "a.ts") }],
      ["Read", { file_path: "src/a.ts" }],
      ["Read", { file_path: "/etc/hosts" }],
      ["Read", { file_path: join(userData, "settings.json") }],
      ["Grep", { pattern: "todo", path: "src" }],
      ["Grep", { pattern: "todo" }],
      ["Grep", { pattern: "todo", path: home }],
      ["Glob", { pattern: "**/*.ts" }],
      ["LS", { path: userData }],
      ["read_file", { absolute_path: join(project, "src", "a.ts") }]
    ]) assert.equal(read(toolName, toolInput), null, `${root}: ${toolName} ${JSON.stringify(toolInput)}`);
    // The agent's own account home stays its own.
    assert.equal(read("Read", { file_path: join(accountHome, "settings.json") }, { agentRoots: [accountHome] }), null, root);
    assert.equal(read("Grep", { pattern: "x", path: accountHome }, { agentRoots: [accountHome] }), null, root);
  }
});

test("decision hooks refuse a private read without asking decision plugins about reads", async () => {
  let asked = 0;
  const hooks = new DecisionHooks({
    baseProtection: () => true, services: () => [{ pluginId: "p", pluginName: "P", serviceId: "s", mayAllow: false }],
    call: async () => { asked++; return { behavior: "deny", message: "plugin" }; }, home, privateData,
    session: () => ({ provider: "claude", role: "agent", cwd: home, configDirs: [] })
  });
  const request = (toolInput) => ({ toolName: "Read", toolInput, toolInputPreview: null, cwd: null, truncated: false });
  const denied = await hooks.decide("s1", request({ file_path: join(userData, "provider-secrets.bin") }), new AbortController().signal);
  assert.equal(denied.behavior, "deny");
  assert.match(denied.message, /Orchestrator role/u);
  assert.equal((await hooks.decide("s1", request({ file_path: join(home, "notes.txt") }), new AbortController().signal)).behavior, "none");
  assert.equal(asked, 0, "plugins are not asked about read-only tools");
});

test("without the app's folder the socket folders are still known; the userData paths are not guessed", () => {
  assert.equal(denyRule(analyzeAction(shell(`nc -U ${sock}`), project, { home })), "app-private");
  assert.equal(denyRule(analyzeAction(shell(`cat ${q(token)}`), project, { home })), null);
});

test("the message tells the model calmly why and what to do instead, without paths or protocol details", () => {
  const verdict = checkBaseProtection({ toolName: "Bash", toolInput: { command: `cat ${q(token)}` }, root: project, home, privateData });
  assert.equal(verdict.rule, "app-private");
  assert.match(verdict.message, /^CanvasTTY blocked this: it reads CanvasTTY's own access tokens/u);
  assert.match(verdict.message, /Orchestrator role/u);
  assert.match(verdict.message, /canvastty_agents tools: list_providers shows which agents CanvasTTY can launch, then spawn_agent, wait_for_agent/u);
  assert.doesNotMatch(verdict.message, /token-|\.sock|agent-control|Application Support|ctty-/u);
});

test("decision hooks pass the app's private data to base protection", async () => {
  const hooks = new DecisionHooks({
    baseProtection: () => true, services: () => [], call: async () => null, home, privateData,
    session: () => ({ provider: "opencode", role: "agent", cwd: project, configDirs: [] })
  });
  const decision = await hooks.decide("s1", { toolName: "bash", toolInput: { command: `cat ${q(token)}` }, toolInputPreview: null, cwd: null, truncated: false }, new AbortController().signal);
  assert.equal(decision.behavior, "deny");
  assert.match(decision.message, /Orchestrator role/u);
  const ordinary = await hooks.decide("s1", { toolName: "bash", toolInput: { command: "cat src/a.ts" }, toolInputPreview: null, cwd: null, truncated: false }, new AbortController().signal);
  assert.equal(ordinary.behavior, "none");
});

test("Qwen read_many_files: more than 32 paths is refused, and its include globs are checked", () => {
  const secrets = join(userData, "provider-secrets.bin");
  const read = (toolInput) => checkBaseProtection({ toolName: "read_many_files", toolInput, root: project, home, privateData }) ?? null;
  const benign = Array.from({ length: 32 }, (_, i) => `src/f${i}.ts`);
  assert.equal(read({ paths: benign }), null, "32 project paths are checked and allowed");
  const many = read({ paths: [...benign, secrets] });
  assert.equal(many?.rule, "uncheckable", "the 33rd path is not skipped");
  assert.match(many.message, /at most 32/u);
  assert.equal(read({ paths: [...benign, "src/g.ts"] })?.rule, "uncheckable");
  assert.equal(read({ paths: benign.slice(0, 20), include: benign.slice(0, 13) })?.rule, "uncheckable", "include counts toward the limit");
  assert.equal(read({ paths: ["src/a.ts"], include: [secrets] })?.rule, "app-private");
  assert.equal(read({ paths: ["src/a.ts"], include: [join(userData, "account-homes", "**", "*.json")] })?.rule, "app-private");
  assert.equal(read({ paths: ["src/a.ts"], include: ["**/*.ts"] }), null);
});

test("OpenCode's read-only tools reach base protection: a grep without a path searches the current folder, a glob's pattern is checked", () => {
  const check = (tool, args, root) => {
    const call = guardedCall(tool, args, true);
    assert.ok(call, `${tool} is forwarded`);
    return checkBaseProtection({ toolName: call.toolName, toolInput: call.toolInput, root, home, privateData })?.rule ?? null;
  };
  assert.equal(check("grep", { pattern: "token" }, userData), "app-private", "grep with no path, run in the app's folder");
  assert.equal(check("grep", { pattern: "token", include: "*.json" }, control), "app-private");
  assert.equal(check("grep", { pattern: "token" }, project), null);
  assert.equal(check("glob", { pattern: join(userData, "provider-*") }, project), "app-private");
  assert.equal(check("glob", { pattern: "agent-control/token-*", path: userData }, project), "app-private");
  assert.equal(check("glob", { pattern: "**/*.ts" }, project), null);
});

test("globs: ** matches any number of folders and braces are expanded before matching the private data", () => {
  const secrets = q(join(userData, "provider-secrets.bin")).slice(1, -1);
  for (const command of [
    "cat ~/Library/**/provider-secrets.bin",
    "cat ~/**/provider-secrets.bin",
    "cat ~/Library/Application\\ Support/canvastty/**",
    "cat ~/Library/**/account-homes/*/auth.json",
    `cat '${userData}'/provider-secrets.{bin,}`,
    `cat '${userData}'/{settings.json,provider-secrets.bin}`,
    `cat '${userData}'/agent-control/{connection.json,token-*}`,
    `cp '${userData}'/{provider-secrets,x}.bin ./copy`,
    // Sequences are brace expansions too: bash and zsh make `provider-secrets.bin` of these.
    `cat '${userData}'/provider-secrets.bi{n..n}`,
    `cat '${userData}'/provider-secret{r..t}.bin`,
    `cat '${userData}'/agent-control/token-{0..1}123abcd`,
    `cat '${userData}'/agent-control/token-{00..01..1}123abcd`,
    `cat '${userData}'/agent-control/token-{0..999}123abcd`
  ]) assert.equal(rule(command), "app-private", command);
  // Read-only tools: a Glob pattern with braces or ** is matched the same way.
  const glob = (toolInput, root = project) => checkBaseProtection({ toolName: "Glob", toolInput, root, home, privateData })?.rule ?? null;
  assert.equal(glob({ pattern: "provider-secrets.{bin,json}", path: userData }), "app-private");
  assert.equal(glob({ pattern: join(home, "Library", "**", "provider-secrets.bin") }), "app-private");
  // Ordinary globs stay allowed: in a normal project, and ones that only pass by the app's folder on the way.
  for (const command of [
    "ls **/*.ts",
    "rg todo **/*.ts",
    "cat src/{a,b}.ts",
    "cat ~/**/*.ts",
    "ls ~/Library/**/*.plist",
    `cat '${secrets}x'.{md,txt}`,
    "echo {a,b}"
  ]) assert.equal(rule(command), null, command);
  assert.equal(glob({ pattern: "**/*.ts" }), null);
  assert.equal(glob({ pattern: "**/*.ts" }, home), null, "a ** glob that only passes through the app's folder");
  assert.equal(glob({ pattern: "src/**/*.{ts,tsx}" }), null);
});

test("macOS and Windows: a glob matches the private data in any letter case", { skip: process.platform !== "darwin" && process.platform !== "win32" }, () => {
  assert.equal(rule("cat ~/library/application\\ support/CANVASTTY/Provider-Secrets.*"), "app-private");
  assert.equal(rule("cat ~/LIBRARY/**/PROVIDER-SECRETS.BIN"), "app-private");
});

test("what base protection cannot check is refused, not skipped: long or odd path fields, too many paths, expansions or nested shells", () => {
  const secrets = join(userData, "provider-secrets.bin");
  const check = (toolName, toolInput, root = project) => checkBaseProtection({ toolName, toolInput, root, home, privateData })?.rule ?? null;
  // Padding that folds away is checked as the path it names.
  assert.equal(check("Read", { file_path: userData + "/.".repeat(3000) + "/provider-secrets.bin" }), "app-private");
  assert.equal(check("Read", { file_path: userData + "/x/..".repeat(1500) + "/provider-secrets.bin" }), "app-private");
  assert.equal(check("Write", { file_path: userData + "/./".repeat(2000) + "provider-secrets.bin", content: "x" }), "app-private");
  // A path field that cannot be checked: too long after folding, or not a string.
  const long = "/" + "a".repeat(5000);
  for (const [toolName, toolInput] of [
    ["Read", { file_path: long }],
    ["Read", { file_path: 42 }],
    ["Grep", { pattern: "x", path: long }],
    ["Glob", { pattern: { glob: "*" } }],
    ["read_many_files", { paths: ["src/a.ts", 7] }],
    ["read_many_files", { paths: ["src/a.ts"], include: long }],
    ["Write", { file_path: long, content: "x" }],
    ["Bash", { command: "ls", cwd: long }],
    ["apply_patch", { command: `*** Begin Patch\n*** Add File: ${"b".repeat(5000)}\n+x\n*** End Patch` }],
    ["apply_patch", { command: `*** Begin Patch\n${Array.from({ length: 257 }, (_, i) => `*** Add File: f${i}.txt\n+x`).join("\n")}\n*** End Patch` }]
  ]) assert.equal(check(toolName, toolInput), "uncheckable", `${toolName} ${JSON.stringify(toolInput).slice(0, 80)}`);
  // A patch longer than one path is still read in full.
  assert.equal(check("apply_patch", { command: `*** Begin Patch\n*** Add File: notes.md\n+${"x".repeat(5000)}\n*** Add File: ${secrets}\n+x\n*** End Patch` }), "app-private");
  // More paths, brace expansions or nested shells than are checked.
  assert.equal(rule(`echo ${"a ".repeat(1100)}; cat ${q(secrets)}`) !== null, true, "the private path after the budget is not let through");
  assert.equal(rule(`echo ${"a ".repeat(1100)}`), "uncheckable");
  assert.equal(rule(`cat ${q(userData)}/{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}`), "uncheckable");
  assert.equal(check("Glob", { pattern: "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}", path: project }), "uncheckable");
  const sq = (text) => `'${text.replace(/'/gu, "'\\''")}'`;
  let nested = "ls";
  for (let i = 0; i < 6; i++) nested = `bash -c ${sq(nested)}`;
  assert.equal(rule(nested), "uncheckable", "shells nested deeper than are followed");
  assert.equal(rule("bash -c 'bash -c ls'"), null);
  // Ordinary large calls stay allowed.
  assert.equal(rule(`git add ${Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`).join(" ")}`), null);
  assert.equal(rule("cat src/{a,b,c}/{x,y}.ts"), null);
  assert.equal(rule("cat src/f{1..9}.ts"), null);
  assert.equal(rule(`cat ${q(userData)}/x{1..100}`), null, "a long sequence stands for any name there");
  assert.equal(rule("for i in {1..1000}; do echo $i; done"), null);
  assert.equal(check("apply_patch", { command: `*** Begin Patch\n${Array.from({ length: 40 }, (_, i) => `*** Add File: f${i}.txt\n+x`).join("\n")}\n*** End Patch` }), null);
});

test("an analyzer failure refuses a shell, edit or read call as uncheckable; other tools keep no opinion", () => {
  const throwing = (field) => Object.defineProperty({}, field, { enumerable: true, get() { throw new Error("fixture analyzer failure"); } });
  const brokenPrivateData = { appRoots: [userData], get paths() { throw new Error("fixture analyzer failure"); }, markers: [] };
  const check = (toolName, toolInput, data = privateData) => checkBaseProtection({ toolName, toolInput, root: project, home, privateData: data });
  for (const [toolName, toolInput] of [
    ["Bash", throwing("command")],
    ["Read", throwing("file_path")],
    ["Write", throwing("file_path")],
    ["apply_patch", throwing("command")]
  ]) {
    const verdict = check(toolName, toolInput);
    assert.equal(verdict?.rule, "uncheckable", toolName);
    assert.match(verdict.message, /failed while checking it/u);
    assert.doesNotMatch(verdict.message, /fixture analyzer failure/u, "the error itself stays out of the message");
  }
  for (const [toolName, toolInput] of [["Bash", { command: "ls" }], ["Read", { file_path: "src/a.ts" }], ["Edit", { file_path: "src/a.ts" }]]) {
    assert.equal(check(toolName, toolInput, brokenPrivateData)?.rule, "uncheckable", `${toolName}: a failure inside the analysis`);
  }
  assert.equal(check("WebFetch", throwing("url")), null, "a tool base protection does not check stays without an opinion");
});
