import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const READY_MARKER = "CANVASTTY_PROVIDER_SMOKE_READY";
const EXPECTED_TOOL = "mcp__canvastty_browser__browser_list_tabs";
const MAX_OUTPUT_BYTES = 128 * 1024;
const targets = parseTargets(process.argv.slice(2));
const TIMEOUT_MS = targets.includes("claude") || targets.includes("codex") || targets.includes("opencode") || targets.includes("hermes")
  ? 360_000
  : 120_000;
const smokeRoot = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "ct-provider-"));
const userDataPath = join(smokeRoot, "electron");
const kimiHome = join(smokeRoot, "kimi-home");
const workDirectory = join(smokeRoot, "work");
// The direct smoke validates only the helper and its one-time capability; it
// must not depend on a provider CLI being installed on the CI runner.
const directPreflightCommand = targets.includes("direct") && !targets.includes("codex")
  ? process.env.CANVASTTY_PROVIDER_SMOKE_CODEX_COMMAND ?? process.execPath
  : undefined;
let child;
let output = "";
let fakeApi = null;

try {
  await Promise.all([
    mkdir(userDataPath, { recursive: true, mode: 0o700 }),
    mkdir(kimiHome, { recursive: true, mode: 0o700 }),
    mkdir(workDirectory, { recursive: true, mode: 0o700 })
  ]);

  if (targets.includes("kimi")) {
    const kimiCommand = await resolveCommand(process.env.CANVASTTY_KIMI_COMMAND ?? "kimi");
    fakeApi = await startFakeOpenAiServer();
    await writeKimiConfiguration(kimiHome, fakeApi.baseUrl);
    process.env.CANVASTTY_PROVIDER_SMOKE_KIMI_COMMAND = kimiCommand;
  } else {
    await writeKimiConfiguration(kimiHome, "http://127.0.0.1:1/v1");
  }

  const electronArgs = [PROJECT_ROOT, `--user-data-dir=${userDataPath}`, "--disable-gpu"];
  // GitHub hosted Linux runners cannot install Electron's chrome-sandbox with
  // root ownership and mode 4755. Product WebContents security is asserted by
  // unit tests; only this isolated CI process disables the outer Chromium sandbox.
  if (process.platform === "linux" && process.env.CI === "true") electronArgs.push("--no-sandbox");
  child = spawn(electronPath, electronArgs, {
    env: {
      ...process.env,
      KIMI_CODE_HOME: kimiHome,
      KIMI_DISABLE_TELEMETRY: "1",
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_DISABLE_CRON: "1",
      CANVASTTY_PROVIDER_SMOKE: targets.join(","),
      CANVASTTY_PROVIDER_SMOKE_CWD: workDirectory,
      ...(directPreflightCommand
        ? { CANVASTTY_PROVIDER_SMOKE_CODEX_COMMAND: directPreflightCommand }
        : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  await waitForReady(child);
  const exit = await waitForExit(child, 8_000);
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`Provider smoke exited unsuccessfully (code=${exit.code}, signal=${exit.signal}).`);
  }
  if (fakeApi) fakeApi.assertComplete();
  process.stdout.write(output);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child, 2_000).catch(() => child.kill("SIGKILL"));
  }
  if (fakeApi) await fakeApi.close();
  await rm(smokeRoot, { recursive: true, force: true });
}

function parseTargets(args) {
  const mode = args[0] ?? "--deterministic";
  if (mode === "--direct") return ["direct"];
  if (mode === "--kimi") return ["kimi"];
  if (mode === "--claude") return ["claude"];
  if (mode === "--codex") return ["codex"];
  if (mode === "--opencode") return ["opencode"];
  if (mode === "--hermes") return ["hermes"];
  if (mode === "--deterministic") return ["direct", "kimi"];
  if (mode === "--all") return ["direct", "kimi", "claude", "codex", "opencode", "hermes"];
  throw new Error("Usage: smoke-browser-providers.mjs [--direct|--kimi|--claude|--codex|--opencode|--hermes|--deterministic|--all]");
}

async function waitForReady(process) {
  await new Promise((resolveReady, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.kill("SIGTERM");
      reject(new Error(`Provider smoke timed out. Output:\n${safeOutput(output)}`));
    }, TIMEOUT_MS);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.kill("SIGTERM");
      reject(error);
    };
    const consume = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT_BYTES);
      if (!settled && output.includes("CanvasTTY startup failed.")) {
        fail(new Error(`Provider smoke reported a startup failure. Output:\n${safeOutput(output)}`));
      } else if (!settled && output.includes(READY_MARKER)) {
        settled = true;
        clearTimeout(timer);
        resolveReady();
      }
    };
    process.stdout.on("data", consume);
    process.stderr.on("data", consume);
    process.once("error", fail);
    process.once("exit", (code, signal) => {
      if (!settled) fail(new Error(`Provider smoke exited early (code=${code}, signal=${signal}). Output:\n${safeOutput(output)}`));
    });
  });
}

async function writeKimiConfiguration(home, baseUrl) {
  const config = [
    'default_model = "smoke/model"',
    "telemetry = false",
    "",
    "[providers.smoke]",
    'type = "openai"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'api_key = "test-key"',
    "",
    '[models."smoke/model"]',
    'provider = "smoke"',
    'model = "canvastty-smoke"',
    "max_context_size = 32768",
    'capabilities = ["tool_use"]',
    "",
    "[loop_control]",
    "max_steps_per_turn = 4",
    "max_attempts_per_step = 2",
    "reserved_context_size = 4096",
    "",
    "[mcp]",
    "startup_timeout_ms = 15000",
    "tool_timeout_ms = 15000",
    ""
  ].join("\n");
  await Promise.all([
    writeFile(join(home, "config.toml"), config, { mode: 0o600 }),
    writeFile(join(home, "mcp.json"), '{"mcpServers":{}}\n', { mode: 0o600 })
  ]);
}

async function startFakeOpenAiServer() {
  let completionCalls = 0;
  let failure = null;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        json(response, 200, { object: "list", data: [{ id: "canvastty-smoke", object: "model" }] });
        return;
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        json(response, 404, { error: { message: "Not found" } });
        return;
      }
      const body = JSON.parse(await readBoundedBody(request));
      completionCalls += 1;
      if (completionCalls === 1) {
        const matching = Array.isArray(body.tools)
          ? body.tools.filter((tool) => tool?.function?.name === EXPECTED_TOOL)
          : [];
        if (matching.length !== 1) throw new Error("Kimi did not expose the exact CanvasTTY list-tabs tool to the model.");
        stream(response, [
          chunk({ role: "assistant", tool_calls: [{
            index: 0,
            id: "call_canvastty_smoke",
            type: "function",
            function: { name: EXPECTED_TOOL, arguments: "{}" }
          }] }, null),
          chunk({}, "tool_calls")
        ]);
        return;
      }
      if (completionCalls === 2) {
        const toolMessages = Array.isArray(body.messages)
          ? body.messages.filter((message) => message?.role === "tool")
          : [];
        if (toolMessages.length !== 1 || !containsOk(toolMessages[0])) {
          throw new Error("Kimi did not return the successful CanvasTTY BrowserResult to the model.");
        }
        stream(response, [
          chunk({ role: "assistant", content: "CANVASTTY_PROVIDER_SMOKE_OK" }, null),
          chunk({}, "stop")
        ]);
        return;
      }
      throw new Error("Kimi made an unexpected extra model request.");
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Fake OpenAI server failed.");
      json(response, 400, { error: { message: failure.message } });
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake OpenAI server did not bind.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    assertComplete() {
      if (failure) throw failure;
      if (completionCalls !== 2) throw new Error(`Kimi made ${completionCalls} model requests instead of 2.`);
    },
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  };
}

function chunk(delta, finishReason) {
  return {
    id: "chatcmpl-canvastty-smoke",
    object: "chat.completion.chunk",
    created: 1,
    model: "canvastty-smoke",
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

function stream(response, chunks) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "close"
  });
  for (const item of chunks) response.write(`data: ${JSON.stringify(item)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBoundedBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error("Fake OpenAI request exceeded 2MB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function containsOk(value, depth = 0) {
  if (depth > 10) return false;
  if (typeof value === "string") {
    try {
      return containsOk(JSON.parse(value), depth + 1);
    } catch {
      return value.includes('"ok":true');
    }
  }
  if (Array.isArray(value)) return value.some((item) => containsOk(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  if (value.ok === true && typeof value.requestId === "string") return true;
  return Object.values(value).some((item) => containsOk(item, depth + 1));
}

async function resolveCommand(command) {
  if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) {
    await access(command, constants.X_OK);
    return command;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? `${command}.exe` : command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`${command} is not installed; deterministic Kimi smoke requires Kimi Code 0.33+.`);
}

function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve({ code: process.exitCode, signal: process.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      process.removeListener("exit", onExit);
      reject(new Error(`Electron did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    };
    process.once("exit", onExit);
  });
}

function safeOutput(value) {
  return value
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/gu, "<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer <redacted>");
}
