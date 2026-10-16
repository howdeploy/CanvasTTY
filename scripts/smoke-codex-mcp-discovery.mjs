/** Real Codex with temporary profiles and synthetic loopback MCP/Responses only; no account or model API. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { codexMcpArgs } from "../src/main/services/agent-browser/ProviderLaunch.ts";
import { ORCHESTRATION_TOOL_DEFINITIONS, ORCHESTRATION_TOOL_NAMES } from "../src/agent-browser/orchestration-catalog.mjs";

const binary = process.argv[2];
if (!binary || !isAbsolute(binary)) throw new Error("Pass the absolute native Codex executable path (codex.exe on Windows).");
const root = await mkdtemp(join(tmpdir(), "canvas-mcp-exposure-"));
await mkdir(join(root, "work"));
const helper = join(root, "mcp.mjs");
await writeFile(helper, `
import readline from "node:readline";
const tools = ${JSON.stringify(ORCHESTRATION_TOOL_DEFINITIONS)};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list" ? { tools } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`);

let requests = [];
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  const item = {
    id: "msg_fixture", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "FIXTURE_OK", annotations: [] }]
  };
  const response = {
    id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "fixture-model",
    output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id,
      part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "FIXTURE_OK" },
    { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: "FIXTURE_OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response }
  ];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(events.map((event, index) =>
    `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(""));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

try {
  const model = {
    slug: "fixture-model", display_name: "Fixture", description: "Synthetic MCP exposure fixture",
    default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low", description: "Fixture" }],
    shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
    base_instructions: "Use the provided test tools only when requested.", supports_reasoning_summaries: false,
    support_verbosity: false, truncation_policy: { mode: "tokens", limit: 10000 }, input_modalities: ["text"],
    supports_search_tool: true, supports_parallel_tool_calls: true, experimental_supported_tools: []
  };
  const results = [];
  for (const { direct, allowed } of [
    { direct: false, allowed: ORCHESTRATION_TOOL_NAMES },
    { direct: true, allowed: ORCHESTRATION_TOOL_NAMES },
    { direct: true, allowed: ["list_agents"] },
    { direct: true, allowed: [] }
  ]) {
    const home = join(root, `case-${results.length}`);
    await mkdir(home, { mode: 0o700 });
    await writeFile(join(home, "models.json"), JSON.stringify({ models: [model] }));
    await writeFile(join(home, "config.toml"), `model="fixture-model"
model_provider="fixture"
model_catalog_json=${JSON.stringify(join(home, "models.json"))}
[model_providers.fixture]
name="fixture"
base_url="http://127.0.0.1:${server.address().port}/v1"
wire_api="responses"
requires_openai_auth=false
env_key="FIXTURE_KEY"
`);
    const args = codexMcpArgs(null, { command: process.execPath, args: [helper] }, allowed);
    // Negative control: remove only the exposure override from the actual launch table.
    if (!direct) args[1] = args[1].replace('omit_tools_from=["deferred"],', "");
    requests = [];
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR"].includes(key.toUpperCase()))
      .map(([key, value]) => [key.toUpperCase(), value]));
    Object.assign(environment, {
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      CODEX_HOME: home, CODEX_SQLITE_HOME: home, FIXTURE_KEY: "fixture"
    });
    const child = spawn(binary, [
      "exec", "--ephemeral", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
      "-C", join(root, "work"), ...args, "Reply FIXTURE_OK."
    ], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-16384); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16384); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    if (code !== 0) throw new Error("Fixture client failed: " + stderr.slice(-1200));
    assert.match(stdout, /FIXTURE_OK/);
    const tools = (requests[0]?.tools ?? []).flatMap(tool => tool.type === "namespace"
      ? tool.tools.map(entry => ({ namespace: tool.name, ...entry })) : tool);
    const exposed = tools.filter(tool => tool.namespace === "mcp__canvastty_agents"
      || tool.name?.includes("canvastty_agents")).map(tool => tool.name);
    assert.deepEqual(exposed.sort(), direct ? [...allowed].sort() : []);
    results.push({ direct, allowed, clientExitCode: code, requestCount: requests.length,
      orchestrationTools: exposed, searchAdvertised: tools.some(tool => tool.type === "tool_search") });
  }
  console.log(JSON.stringify({ ok: true, liveProviderProof: false, cases: results }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
