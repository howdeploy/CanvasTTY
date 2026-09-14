#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const MAX_RESPONSE_BYTES = 256 * 1024;
const HEX_TOKEN = /^[a-f0-9]{64}$/;

export function defaultConnectionPath(environment = process.env, platform = process.platform) {
  if (environment.CANVASTTY_CONTROL_CONNECTION) return resolve(environment.CANVASTTY_CONTROL_CONNECTION);
  const config = platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : platform === "win32" ? environment.APPDATA || join(homedir(), "AppData", "Roaming")
      : environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "canvastty", "agent-control", "connection.json");
}

async function privateFile(path, maximum = 16 * 1024) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("Invalid control credential file.");
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) {
      throw new Error("Control credential files must be owned by this user and private (mode 0600).");
    }
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

export async function controlRequest({ connectionPath, clientPath, method, params = {}, requestId = randomUUID(), timeoutMs = 8000 }) {
  let connection;
  try { connection = JSON.parse(await privateFile(connectionPath)); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("Agent control is unavailable. Start CanvasTTY with --agent-control and select its connection file.");
    throw error;
  }
  if (connection.v !== 1 || connection.service !== "canvastty-agent-control"
      || typeof connection.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(connection.instanceId)
      || typeof connection.endpoint !== "string"
      || (process.platform === "win32" ? !connection.endpoint.startsWith("\\\\.\\pipe\\") : !isAbsolute(connection.endpoint))
      || connection.tokenFile !== join(dirname(connectionPath), `token-${connection.instanceId}`)) {
    throw new Error("Invalid local control descriptor.");
  }
  const token = (await privateFile(connection.tokenFile, 128)).trim();
  if (!HEX_TOKEN.test(token)) throw new Error("Invalid local control credential.");
  let controller;
  try { controller = JSON.parse(await privateFile(clientPath)); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const candidate = { v: 1, controller: randomBytes(32).toString("hex"), instanceId: connection.instanceId };
    await mkdir(dirname(clientPath), { recursive: true, mode: 0o700 });
    try { await writeFile(clientPath, JSON.stringify(candidate) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; }
    // A concurrent creator may have opened the private file but not finished its first write.
    for (let attempt = 0; ; attempt++) {
      try { controller = JSON.parse(await privateFile(clientPath)); break; }
      catch (readError) {
        if (!(readError instanceof SyntaxError) || attempt >= 20) throw readError;
        await delay(10);
      }
    }
  }
  if (controller.v !== 1 || !HEX_TOKEN.test(controller.controller)) throw new Error("Invalid controller identity.");
  if (controller.instanceId !== connection.instanceId) throw new Error("CanvasTTY restarted. Use a new --client-file; old session grants do not carry across app instances.");
  const payload = JSON.stringify({ v: 1, id: requestId, instanceId: connection.instanceId,
    token, controller: controller.controller, method, params }) + "\n";
  if (Buffer.byteLength(payload) > 128 * 1024) throw new Error("Control request is too large.");
  return await new Promise((resolveResult, reject) => {
    const socket = createConnection(connection.endpoint);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolveResult(result);
    };
    const timer = setTimeout(() => finish(new Error("Control request timed out; inspect status before retrying with the same request ID.")), timeoutMs);
    socket.on("connect", () => socket.write(payload));
    socket.on("error", () => finish(new Error("Cannot connect to the local CanvasTTY control endpoint.")));
    socket.on("close", () => finish(new Error("Control connection closed without a response.")));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_BYTES) return finish(new Error("Control response exceeds its limit."));
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (response.v !== 1 || (response.id !== requestId && response.ok !== false)) throw new Error("Mismatched control response.");
        if (!response.ok) {
          const error = new Error(response.error?.message || "Control request failed.");
          error.code = response.error?.code || "CONTROL_FAILED";
          return finish(error);
        }
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}

export function parseArguments(argv) {
  const options = {};
  const positional = [];
  const flags = new Set(["--connection", "--client-file", "--request-id", "--cwd", "--title", "--provider", "--profile", "--prompt-file", "--text", "--after", "--choice", "--revision"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") continue;
    if (arg === "--yolo") { options.yolo = true; continue; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg.startsWith("--")) {
      if (!flags.has(arg) || i + 1 === argv.length) throw new Error("Unknown option or missing option value.");
      if (Object.hasOwn(options, arg.slice(2))) throw new Error("Duplicate option.");
      options[arg.slice(2)] = argv[++i];
    } else positional.push(arg);
  }
  return { options, positional };
}

const HELP = `CanvasTTY native agent control (JSON output; no GUI automation)

Start CanvasTTY with --agent-control first. Each --client-file owns only the
sessions it creates. Keep the same private client file across related commands.

create --cwd <directory> [--title <name>] [--yolo | --profile normal]
list
status <session-id>
screen <session-id>
send <session-id> --prompt-file <file>  (or --text <text>)
result <session-id> [--after <result-revision>]
interrupt <session-id>
choose <session-id> --choice <number> --revision <observed-menu-revision>
dismiss <session-id> --revision <observed-screen-revision>

Global options: --connection <descriptor> --client-file <private-file>
                --request-id <id> --json

create defaults to the YOLO profile: full access, no sandbox approvals.
No global provider configuration is modified. Scope tasks before sending them.
After a timeout, inspect status; retry identical input with the SAME request ID.
`;

export async function runCli(argv) {
  const { options, positional } = parseArguments(argv);
  if (options.help) return { help: HELP };
  const [method, sessionId] = positional;
  if (!["create", "list", "status", "screen", "send", "result", "interrupt", "choose", "dismiss"].includes(method)) throw new Error("Unknown command; see --help.");
  if (positional.length !== (["create", "list"].includes(method) ? 1 : 2)) throw new Error("Unexpected or missing positional argument.");
  const allowed = new Set(["connection", "client-file", "request-id",
    ...(method === "create" ? ["cwd", "title", "provider", "profile", "yolo"] : []),
    ...(method === "send" ? ["prompt-file", "text"] : []), ...(method === "result" ? ["after"] : []),
    ...(method === "choose" ? ["choice", "revision"] : []), ...(method === "dismiss" ? ["revision"] : [])]);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new Error("Option does not apply to this command.");
  let params = method === "list" ? {} : { sessionId };
  if (method === "create") {
    if (!options.cwd) throw new Error("create requires --cwd.");
    if (options.yolo && options.profile && options.profile !== "yolo") throw new Error("Conflicting launch profiles.");
    params = { provider: options.provider || "codex", cwd: resolve(options.cwd), profile: options.profile || "yolo",
      ...(options.title === undefined ? {} : { title: options.title }) };
  }
  if (method === "send") {
    if ((options["prompt-file"] === undefined) === (options.text === undefined)) throw new Error("send requires exactly one of --prompt-file or --text.");
    params.text = options.text ?? await readFile(resolve(options["prompt-file"]), "utf8");
  }
  if (method === "result" && options.after !== undefined) {
    if (!/^\d+$/.test(options.after) || !Number.isSafeInteger(Number(options.after))) throw new Error("after must be a non-negative integer.");
    params.after = Number(options.after);
  }
  if (method === "choose") {
    if (!/^\d+$/.test(options.choice ?? "") || !options.revision) throw new Error("choose requires --choice and the observed --revision.");
    params.choice = Number(options.choice);
    params.revision = options.revision;
  }
  if (method === "dismiss") {
    if (!options.revision) throw new Error("dismiss requires the observed --revision.");
    params.revision = options.revision;
  }
  const connectionPath = resolve(options.connection || defaultConnectionPath());
  const clientPath = resolve(options["client-file"] || join(dirname(connectionPath), "controller.json"));
  const requestId = options["request-id"] || randomUUID();
  try {
    const result = await controlRequest({ connectionPath, clientPath, method, params, requestId });
    return { requestId, result };
  } catch (error) { error.requestId = requestId; throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCli(process.argv.slice(2));
    console.log(result.help || JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.code || "CLI_ERROR", message: error.message,
      ...(error.requestId ? { requestId: error.requestId } : {}) } }));
    process.exitCode = 1;
  }
}
