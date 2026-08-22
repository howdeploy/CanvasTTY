import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AgentBrowserBridge,
  PreparedAgentBrowserPtyLaunch
} from "../agent-browser/AgentBrowserBridge.ts";
import { AGENT_BROWSER_ENV } from "../agent-browser/AgentBrowserBridge.ts";
import type { StdioHelperLaunch } from "../agent-browser/ProviderLaunch.ts";
import type { AgentProvider } from "../agent-browser/protocol.ts";
import {
  providerChildProcessLaunch,
  type ProviderCliRegistry
} from "../providerCliRegistry.ts";
import {
  APPROVED_BROWSER_TOOL_NAMES,
  MCP_SERVER_NAME,
  canonicalStringify
} from "../../../agent-browser/tool-catalog.mjs";

const EXPECTED_TOOL = `mcp__${MCP_SERVER_NAME}__browser_list_tabs`;
const OPENCODE_EXPECTED_TOOL = `${MCP_SERVER_NAME}_browser_list_tabs`;
const SMOKE_OK = "CANVASTTY_PROVIDER_SMOKE_OK";
const MAX_OUTPUT_BYTES = 256 * 1024;
const DIRECT_TIMEOUT_MS = 15_000;
const DETERMINISTIC_TIMEOUT_MS = 45_000;
const LIVE_TIMEOUT_MS = 120_000;

export type ProviderSmokeTarget = "direct" | AgentProvider;

export interface ProviderElectronSmokeOptions {
  bridge: AgentBrowserBridge;
  helper: StdioHelperLaunch;
  cwd: string;
  targets: ProviderSmokeTarget[];
  providerClis: ProviderCliRegistry;
}

export async function runProviderElectronSmoke(options: ProviderElectronSmokeOptions): Promise<void> {
  const targets = [...new Set(options.targets)];
  if (targets.length === 0) throw new Error("Provider smoke requires at least one target.");

  if (targets.includes("direct")) {
    await runDirectHelperPreflight(options, "codex");
    console.log("CANVASTTY_PROVIDER_SMOKE_STEP direct");
  }

  for (const provider of targets) {
    if (provider === "direct") continue;
    // The CLI gets a different one-time capability from this preflight. A
    // provider failure can therefore never be mistaken for a gateway failure.
    await runDirectHelperPreflight(options, provider);
    await runProviderCli(options, provider);
    console.log(`CANVASTTY_PROVIDER_SMOKE_STEP ${provider}`);
  }
}

async function runDirectHelperPreflight(
  options: ProviderElectronSmokeOptions,
  provider: AgentProvider
): Promise<void> {
  const launch = freshLaunch(options.bridge, provider, options.cwd, "preflight");
  const child = spawn(options.helper.command, options.helper.args, {
    cwd: options.cwd,
    env: freshEnvironment(launch, options.helper.env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true
  });
  try {
    const rpc = new JsonLineRpc(child, DIRECT_TIMEOUT_MS);
    const initialized = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "canvastty-provider-smoke", version: "1.0.0" }
    });
    if (initialized?.serverInfo?.name !== MCP_SERVER_NAME) {
      throw new Error("Direct helper initialized an unexpected MCP server.");
    }
    rpc.notify("notifications/initialized", {});
    const listed = await rpc.request("tools/list", {});
    const names = Array.isArray(listed?.tools)
      ? listed.tools.map((tool: unknown) => asRecord(tool)?.name).filter((name: unknown): name is string => typeof name === "string")
      : [];
    assertExactToolCatalog(names);
    const called = await rpc.request("tools/call", { name: "browser_list_tabs", arguments: {} });
    if (!containsSuccessfulBrowserResult(called)) {
      throw new Error("Direct helper did not return a successful BrowserResult.");
    }
    child.stdin.end();
    const exit = await waitForExit(child, 5_000);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Direct helper exited unsuccessfully (code=${exit.code}, signal=${exit.signal}).`);
    }
  } finally {
    terminate(child);
    launch.cleanup();
  }
}

async function runProviderCli(
  options: ProviderElectronSmokeOptions,
  provider: AgentProvider
): Promise<void> {
  const resolution = options.providerClis.get(provider);
  if (resolution.state === "unavailable") throw new Error(resolution.diagnostic);
  const launch = freshLaunch(options.bridge, provider, options.cwd, "cli");
  const args = providerSmokeArguments(provider, launch.args, options.cwd);
  const providerLaunch = providerChildProcessLaunch(resolution, args);
  try {
    const transcript = await runBounded(providerLaunch.command, providerLaunch.args, {
      cwd: options.cwd,
      environment: {
        ...freshEnvironment(launch),
        ...providerLaunch.environment
      },
      timeoutMs: provider === "kimi" ? DETERMINISTIC_TIMEOUT_MS : LIVE_TIMEOUT_MS,
      redactions: Object.values(launch.environment),
      windowsVerbatimArguments: providerLaunch.windowsVerbatimArguments ?? false
    });
    assertProviderTranscript(provider, transcript.stdout);
  } finally {
    launch.cleanup();
  }
}

export function providerSmokeArguments(provider: AgentProvider, launchArgs: string[], cwd: string): string[] {
  const expectedTool = provider === "opencode" ? OPENCODE_EXPECTED_TOOL : EXPECTED_TOOL;
  const prompt = [
    "This is a deterministic integration smoke test.",
    `Call exactly one tool: ${expectedTool} with {}.`,
    "Do not call any other tool.",
    `After the tool result, reply exactly ${SMOKE_OK}.`
  ].join(" ");

  if (provider === "kimi") {
    return [...launchArgs, "-p", prompt, "--output-format", "stream-json", "--skills-dir", cwd];
  }
  if (provider === "claude") {
    return [
      ...launchArgs,
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--tools",
      "",
      "--prompt-suggestions",
      "false",
      "--no-session-persistence",
      "--max-budget-usd",
      "0.10",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose"
    ];
  }
  if (provider === "opencode") {
    return ["run", ...launchArgs, "--format", "json", "--dir", cwd, prompt];
  }
  if (provider === "hermes") {
    return [...launchArgs, "-z", prompt];
  }
  return [
    "exec",
    ...launchArgs,
    "-c",
    'approval_policy="on-request"',
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--json",
    "-C",
    cwd,
    prompt
  ];
}

function freshLaunch(
  bridge: AgentBrowserBridge,
  provider: AgentProvider,
  cwd: string,
  phase: string
): PreparedAgentBrowserPtyLaunch {
  const launch = bridge.prepareLaunch({
    terminalSessionId: `provider-smoke-${phase}-${provider}-${randomUUID()}`,
    provider,
    cwd
  });
  if (!launch) throw new Error("Agent browser access is disabled during provider smoke.");
  return launch;
}

function freshEnvironment(
  launch: PreparedAgentBrowserPtyLaunch,
  extra: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const reserved = new Set<string>(Object.values(AGENT_BROWSER_ENV));
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => !reserved.has(key) && typeof value === "string")
  );
  return { ...inherited, ...extra, ...launch.environment };
}

function assertExactToolCatalog(names: string[]): void {
  const actual = [...names].sort();
  const expected = [...APPROVED_BROWSER_TOOL_NAMES].sort();
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new Error("Direct helper exposed a missing or unexpected MCP tool.");
  }
}

export function assertProviderTranscript(provider: AgentProvider, stdout: string): void {
  if (provider === "hermes") {
    if (stdout.trim() !== SMOKE_OK) {
      throw new Error("Provider hermes did not finish the smoke turn with the exact marker.");
    }
    return;
  }
  const events = parseJsonLines(stdout);
  const calls = collectToolCalls(provider, events);
  const expectedTool = provider === "opencode" ? OPENCODE_EXPECTED_TOOL : EXPECTED_TOOL;
  if (calls.length !== 1 || calls[0].name !== expectedTool) {
    throw new Error(
      `Provider ${provider} invoked an unexpected tool sequence: ${canonicalStringify(calls.map((call) => call.name))}.`
    );
  }
  if (!hasSuccessfulToolResult(provider, events, calls[0])) {
    throw new Error(`Provider ${provider} did not emit a successful BrowserResult for its expected tool call.`);
  }
  if (!stdout.includes(SMOKE_OK)) {
    throw new Error(`Provider ${provider} did not finish the smoke turn.`);
  }
}

function parseJsonLines(stdout: string): unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error("Provider emitted non-JSON stdout in stream mode.");
    }
  }
  return events;
}

interface ProviderToolCall {
  id: string;
  name: string;
}

function collectToolCalls(provider: AgentProvider, events: unknown[]): ProviderToolCall[] {
  const calls = new Map<string, ProviderToolCall>();
  const record = (id: string, name: string): void => {
    // Started/completed provider events repeat the same logical call. Include
    // the name in the key so an invalid reused id cannot hide an extra tool.
    calls.set(`${id}\u0000${name}`, { id, name });
  };
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}.${index}`));
      return;
    }
    const object = asRecord(value);
    if (!object) return;

    if (provider === "kimi" && Array.isArray(object.tool_calls)) {
      object.tool_calls.forEach((candidate, index) => {
        const call = asRecord(candidate);
        const fn = asRecord(call?.function);
        if (typeof fn?.name !== "string") return;
        const id = typeof call?.id === "string" ? call.id : `${path}.tool_calls.${index}`;
        record(id, fn.name);
      });
    } else if (provider === "claude" && object.type === "tool_use" && typeof object.name === "string") {
      const id = typeof object.id === "string" ? object.id : path;
      record(id, object.name);
    } else if (provider === "codex" && object.type === "mcp_tool_call") {
      const server = typeof object.server === "string" ? object.server : "";
      const tool = typeof object.tool === "string" ? object.tool : typeof object.name === "string" ? object.name : "";
      if (server && tool) {
        const id = typeof object.id === "string" ? object.id : path;
        record(id, `mcp__${server}__${tool}`);
      }
    } else if (provider === "codex" && isCodexActionItem(object.type)) {
      const id = typeof object.id === "string" ? object.id : path;
      record(id, `codex__${String(object.type)}`);
    } else if (provider === "opencode" && object.type === "tool" && typeof object.tool === "string") {
      const id = typeof object.callID === "string" ? object.callID : path;
      record(id, object.tool);
    }
    for (const [key, child] of Object.entries(object)) walk(child, `${path}.${key}`);
  };
  events.forEach((event, index) => walk(event, `$${index}`));
  return [...calls.values()];
}

function hasSuccessfulToolResult(
  provider: AgentProvider,
  events: unknown[],
  call: ProviderToolCall
): boolean {
  if (provider === "codex") {
    return events.some((event) => {
      const envelope = asRecord(event);
      if (envelope?.type !== "item.completed") return false;
      const item = asRecord(envelope.item);
      if (item?.type !== "mcp_tool_call" || item.id !== call.id) return false;
      const server = typeof item.server === "string" ? item.server : "";
      const tool = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : "";
      if (`mcp__${server}__${tool}` !== call.name) return false;
      return containsSuccessfulBrowserResult(item.result);
    });
  }

  let matched = false;
  const walk = (value: unknown): void => {
    if (matched) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const object = asRecord(value);
    if (!object) return;
    if (provider === "claude"
      && object.type === "tool_result"
      && object.tool_use_id === call.id
      && object.is_error !== true
      && containsSuccessfulBrowserResult(object.content)) {
      matched = true;
      return;
    }
    if (provider === "kimi"
      && object.role === "tool"
      && object.tool_call_id === call.id
      && containsSuccessfulBrowserResult(object.content)) {
      matched = true;
      return;
    }
    if (provider === "opencode"
      && object.type === "tool"
      && object.callID === call.id
      && object.tool === call.name) {
      const state = asRecord(object.state);
      if (state?.status === "completed" && containsSuccessfulBrowserResult(state.output)) {
        matched = true;
        return;
      }
    }
    Object.values(object).forEach(walk);
  };
  events.forEach(walk);
  return matched;
}

function containsSuccessfulBrowserResult(value: unknown, depth = 0): boolean {
  if (depth > 10) return false;
  if (typeof value === "string") {
    if (value.length > MAX_OUTPUT_BYTES) return false;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
    try {
      return containsSuccessfulBrowserResult(JSON.parse(trimmed), depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((item) => containsSuccessfulBrowserResult(item, depth + 1));
  const object = asRecord(value);
  if (!object) return false;
  if (object.ok === true && typeof object.requestId === "string") return true;
  return Object.values(object).some((item) => containsSuccessfulBrowserResult(item, depth + 1));
}

interface BoundedRunOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  redactions: string[];
  windowsVerbatimArguments: boolean;
}

async function runBounded(
  command: string,
  args: string[],
  options: BoundedRunOptions
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const consume = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      terminate(child);
      return;
    }
    if (stream === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));
  const timeout = setTimeout(() => terminate(child), options.timeoutMs);
  timeout.unref();
  const result = await exited;
  clearTimeout(timeout);
  if (outputBytes > MAX_OUTPUT_BYTES) throw new Error("Provider output exceeded 256KB.");
  if (result.code !== 0 || result.signal !== null) {
    const detail = redact(`${stderr}\n${stdout}`, options.redactions).slice(-8_192);
    throw new Error(
      `Provider process failed (code=${result.code}, signal=${result.signal}).${detail ? `\n${detail}` : ""}`
    );
  }
  return { stdout, stderr };
}

class JsonLineRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private nextId = 1;
  private bytes = 0;

  constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.bytes += chunk.byteLength;
      if (this.bytes > MAX_OUTPUT_BYTES) this.failAll(new Error("Direct helper output exceeded 256KB."));
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      if (this.pending.size > 0) this.failAll(new Error(`Direct helper exited early (code=${code}, signal=${signal}).`));
    });
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Direct helper ${method} timed out.`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${canonicalStringify(message)}\n`);
  }

  private consume(chunk: Buffer): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > MAX_OUTPUT_BYTES) {
      this.failAll(new Error("Direct helper output exceeded 256KB."));
      terminate(this.child);
      return;
    }
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.message(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private message(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.failAll(new Error("Direct helper emitted invalid JSON-RPC."));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error("Direct helper returned a JSON-RPC error."));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Direct helper did not exit.")), timeoutMs);
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", exited);
  });
}

function terminate(child: {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessGroup(child, "SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalProcessGroup(child, "SIGKILL");
  }, 2_000);
  force.unref();
}

function signalProcessGroup(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  signal: NodeJS.Signals
): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The leader may have exited between the status check and the signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Shutdown races are expected after a bounded provider exits.
  }
}

function isCodexActionItem(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value === "command_execution"
    || value === "file_change"
    || value === "web_search"
    || value === "computer_tool_call"
    || value === "dynamic_tool_call"
    || value === "collab_tool_call"
    || (value.endsWith("_tool_call") && value !== "mcp_tool_call");
}

function redact(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length >= 8) redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/gu, "<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer <redacted>");
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}
