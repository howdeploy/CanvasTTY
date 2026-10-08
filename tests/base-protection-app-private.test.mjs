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
  `cat ${q(join(userData,"checkpoints.json"))}`,
  `cat ${q(join(userData,"checkpoint-objects","project","pack-fixture.pack"))}`,
  `cat ${q(join(userData,"flow-approvals.json"))}`,
  `echo '[]' > ${q(join(userData,"flow-approvals.json"))}`,
  `cat ${q(join(userData,"task-budgets.json"))}`,
  `cat ${q(join(userData,"usage-prices.json"))}`,
  `cat ${q(join(userData,"session-timeline","index.json"))}`,
  `cat ${q(join(userData, "lifecycle", "runtime", "connection.json"))}`,
  `ls ${q(join(userData, "plugin-data"))}`,
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
  "node -e \"const p=process.env.HOME+'/Library/Application Support/canvastty'+'/plugin-data';require('fs').readdirSync(p)\"",
  "node -e \"console.log(require('fs').readFileSync(process.env.HOME + '/Library/Application Support/canvastty/plugin-secrets/x', 'utf8'))\"",
  "node -e \"console.log(require('fs').readFileSync(process.env.HOME + '/Library/Application Support/canvastty' + '/session-timeline/index.json', 'utf8'))\"",
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
  `cat ${q(join(userData, "settings.json"))}`,
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

test("look-alikes in the project, the app's other files and other sockets stay allowed", () => {
  for (const command of ALLOW) assert.equal(rule(command), null, command);
});

test("choosing a parent folder as the project cannot grant its nested private app stores", () => {
  for (const path of [join(userData,"flow-approvals.json"), join(userData,"checkpoint-objects","pack.pack"),token]) {
    assert.equal(denyRule(analyzeAction(shell(`cat ${q(path)}`), home, {home,privateData})),"app-private",path);
  }
  assert.equal(denyRule(analyzeAction(shell(`cat ${q(join(home,"ordinary.txt"))}`), home, {home,privateData})),null);
});

test("project globs remain usable inside a granted plugin worktree but cannot enumerate its sibling", () => {
  const worktrees = join(userData, "plugin-data", "canvastty-environments", "worktrees");
  const actor = join(worktrees, "actor");
  const sibling = join(worktrees, "sibling");
  for (const root of [actor, sibling]) mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(actor, "src", "own.ts"), "export const own = true;\n");
  writeFileSync(join(sibling, "src", "sibling.ts"), "export const sibling = true;\n");
  const ownRule = command => denyRule(analyzeAction(shell(command), actor, { home, privateData }));
  assert.equal(ownRule("cat src/*.ts"), null, "ordinary source globs within the exact granted worktree remain usable");
  assert.equal(ownRule("rg own src/*.ts"), null, "recursive source search within the worktree remains usable");
  assert.equal(ownRule("cat ../sibling/src/*.ts"), "app-private", "a glob rooted at a sibling worktree stays private");
});

test("a worktree glob cannot bypass a private path nested below the granted project", () => {
  const actor = join(userData, "plugin-data", "canvastty-environments", "worktrees", "actor");
  const privateFolder = join(actor, ".canvas-private");
  mkdirSync(privateFolder, { recursive: true });
  writeFileSync(join(privateFolder, "token-hidden"), "fixture\n");
  const privateWithDescendant = { ...privateData, paths: [...privateData.paths, privateFolder] };
  const ownRule = command => denyRule(analyzeAction(shell(command), actor, { home, privateData: privateWithDescendant }));
  assert.equal(ownRule("cat src/*.ts"), null, "ordinary worktree globs stay usable");
  assert.equal(ownRule("cat .canvas-private/token-*"), "app-private", "the private descendant still blocks matching globs");
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
