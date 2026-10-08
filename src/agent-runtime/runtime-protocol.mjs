import { createHash } from "node:crypto";

export const RUNTIME_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_MESSAGE_BYTES = 64 * 1024;
export const CAPTURE_RESULT_ENV = "CANVASTTY_RUNTIME_CAPTURE_RESULT";
export const MAX_RESULT_CHARS = 4096;
// Final-answer capture requires an explicit, expiring grant for one Codex session.
export const CAPTURE_ANSWER_ENV = "CANVASTTY_RUNTIME_CAPTURE_ANSWER";
export const CAPTURE_ANSWER_EXPIRES_AT_ENV = "CANVASTTY_RUNTIME_CAPTURE_ANSWER_EXPIRES_AT";
export const MAX_ANSWER_CHARS = 4000;
// Hook stdin is read whole before the message is built, so its cap is independent
// of the wire cap: a large Stop payload must still yield its turn id and the
// truncated answer instead of being dropped.
export const MAX_HOOK_INPUT_BYTES = 512 * 1024;
export const MAX_TOOL_OUTCOME_NAME_CHARS = 80;
export const MAX_TOOL_OUTCOME_ERROR_CHARS = 8 * 1024;
export const MAX_TOOL_OUTCOME_PATHS = 16;
export const MAX_TOOL_OUTCOME_OUTPUT_CHARS = 16 * 1024;
const TOOL_RESULT_CLASSES = new Set(["success", "error", "denied", "unknown"]);

export const AGENT_RUNTIME_ENV = Object.freeze({
  address: "CANVASTTY_RUNTIME_ADDRESS",
  terminalSessionId: "CANVASTTY_RUNTIME_TERMINAL_SESSION_ID",
  provider: "CANVASTTY_RUNTIME_PROVIDER",
  capabilityToken: "CANVASTTY_RUNTIME_CAPABILITY"
});

export const RUNTIME_STATES = Object.freeze(["idle", "working", "needs_approval"]);

// A provider's own conversation id, as its lifecycle hook reports it, lets a restored
// card resume exactly that conversation. It ends up in the provider's argv, so only
// UUID conversation ids are lower-cased, OpenCode uses `ses_` tokens, Hermes
// uses timestamp-like ids, and MiniMax uses opaque safe session tokens.
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]{1,120}$/;
const HERMES_SESSION_RE = /^\d{8}_\d{6}_[0-9a-f]{6,32}$/i;
const MINIMAX_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function normalizeThreadId(provider, value) {
  if (typeof value !== "string") return undefined;
  if (provider === "kimi") {
    const uuid = value.startsWith("session_") ? value.slice(8) : value.startsWith("ses_") ? value.slice(4) : value;
    return CANONICAL_UUID_RE.test(uuid) ? value.toLowerCase() : undefined;
  }
  if (["codex", "claude", "grok", "qwen", "pi", "omp", "cursor"].includes(provider)) {
    return CANONICAL_UUID_RE.test(value) ? value.toLowerCase() : undefined;
  }
  if (provider === "opencode") return OPENCODE_SESSION_RE.test(value) ? value : undefined;
  if (provider === "hermes") return HERMES_SESSION_RE.test(value) ? value : undefined;
  if (provider === "minimax") return MINIMAX_SESSION_RE.test(value) ? value : undefined;
  return undefined;
}

// Decision hooks (permission-gate.mjs): before a matched tool call runs, the agent's PreToolUse hook (Claude Code,
// Codex, Qwen Code) or OpenCode's CanvasTTY plugin asks CanvasTTY over this socket. The answer is base protection's
// deny or the plugins' merged verdict. The helper waits at most `helperMs`; the gateway answers within `gatewayMs`.
export const PERMISSION_GATE = Object.freeze({
  helperMs: 12_000,
  gatewayMs: 10_000,
  hookSeconds: 15,
  // The tool input travels whole up to this many bytes of JSON; beyond that only a preview and its sha256.
  toolInputBytes: 40 * 1024,
  toolInputPreviewChars: 8 * 1024,
  toolNameChars: 200,
  messageChars: 1_000
});
// Set to "1" for an OpenCode session launched with decision hooks: its plugin then checks each shell and file call.
export const OPENCODE_DECISIONS_ENV = "CANVASTTY_RUNTIME_DECISIONS";
// A decision service may ask for more time than the default 3 s (`decide.timeoutMs`, 1-60 s), for example to ask a
// local model. The session's hook, helper and gateway deadlines are set at launch from the longest such budget and
// passed to the helper in this variable; without it the defaults above hold.
export const DECISION_BUDGET_ENV = "CANVASTTY_RUNTIME_DECISION_MS";
// Set to "1" in the decision hook's own command when the session was launched with it (base protection on, or a
// decision plugin applies). The gate then fails closed: a call it could not check is denied instead of left to run.
export const DECISION_FAIL_CLOSED_ENV = "CANVASTTY_RUNTIME_FAIL_CLOSED";
export const DEFAULT_DECIDE_TIMEOUT_MS = 3_000;
export const MIN_DECIDE_TIMEOUT_MS = 1_000;
export const MAX_DECIDE_TIMEOUT_MS = 60_000;

/** The gate's deadlines for a decision budget: never below PERMISSION_GATE, each a little longer than the one inside it. */
export function permissionGateTimings(budgetMs) {
  const budget = Number.isInteger(budgetMs)
    ? Math.min(MAX_DECIDE_TIMEOUT_MS, Math.max(DEFAULT_DECIDE_TIMEOUT_MS, budgetMs))
    : DEFAULT_DECIDE_TIMEOUT_MS;
  const gatewayMs = Math.max(PERMISSION_GATE.gatewayMs, budget + 2_000);
  const helperMs = gatewayMs + (PERMISSION_GATE.helperMs - PERMISSION_GATE.gatewayMs);
  return { budgetMs: budget, gatewayMs, helperMs, hookSeconds: Math.ceil(helperMs / 1_000) + 3 };
}

/** The helper's wait from its environment: the launch's budget, or the default. */
export function helperDeadlineMs(env) {
  const raw = env?.[DECISION_BUDGET_ENV];
  return permissionGateTimings(typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : undefined).helperMs;
}

/**
 * Derives the small, non-text summary CanvasTTY may share with trusted plugin services after a real tool
 * completion hook. Permission requests and denials are deliberately outside this path. Tool inputs, errors and
 * paths are used only as hash inputs and are never returned or persisted.
 */
export function toolOutcomeFromHook(provider, event, input) {
  if (!isCompletedToolEvent(provider, event)) return undefined;
  const record = isRecord(input) ? input : {};
  const rawToolName = typeof record.tool_name === "string" ? record.tool_name.trim() : "";
  const toolName = boundedOutcomeText(rawToolName.replace(/[\u0000-\u001f\u007f]/gu, ""), MAX_TOOL_OUTCOME_NAME_CHARS) || "unknown";
  const extra = provider === "hermes" && isRecord(record.extra) ? record.extra : {};
  // Provider shell-hook envelopes differ; keep legacy tool_response authoritative when present.
  const response = record.tool_response !== undefined ? record.tool_response
    : provider === "kimi" && typeof record.tool_output === "string" ? record.tool_output
      : provider === "hermes" ? extra.result : undefined;
  const error = firstHookString(record.error, record.tool_error, record.toolError,
    isRecord(response) ? response.error : undefined,
    isRecord(response) ? response.tool_error : undefined, extra.error_message);
  let resultClass = "unknown";
  if (provider === "claude" && event === "PostToolUse") resultClass = "success";
  else if (provider === "claude" && event === "PostToolUseFailure") {
    resultClass = record.is_interrupt === true ? "unknown" : "error";
  } else if (provider === "kimi" && event === "PostToolUseFailure") resultClass = "error";
  else if (provider === "hermes" && record.tool_response === undefined && typeof extra.status === "string") {
    // These are authoritative observer statuses, not words parsed from arbitrary result text.
    resultClass = extra.status === "ok" ? "success" : extra.status === "blocked" ? "denied"
      : extra.status === "error" || extra.status === "timeout" ? "error" : "unknown";
  } else {
    resultClass = explicitToolResultClass(response);
  }

  const normalizedActionHash = normalizedActionHashFromHook(rawToolName, record.tool_input);
  const errorHash = resultClass === "error" && error !== null
    ? sha256(normalizeHashText(error.slice(0, MAX_TOOL_OUTCOME_ERROR_CHARS)))
    : undefined;

  // A hash of what the tool printed lets a loop detector tell a shell loop that keeps producing the same output from
  // one that is still learning something. The response text is never returned or stored.
  const outputHash = resultClass !== "error" ? outputHashFromResponse(response) : undefined;

  const changedPathHashes = [];
  if (resultClass === "success" && isFileWriteTool(rawToolName) && isRecord(response)) {
    const path = typeof response.filePath === "string" ? normalizePathForHash(response.filePath) : "";
    if (path) changedPathHashes.push(sha256(path));
  }
  return {
    toolName,
    resultClass,
    ...(normalizedActionHash ? { normalizedActionHash } : {}),
    ...(errorHash ? { errorHash } : {}),
    ...(outputHash ? { outputHash } : {}),
    changedPathHashes
  };
}

/** OpenCode's direct after hook and terminal ToolPart states, never the generic event wrapper. */
export function toolOutcomeFromOpenCode(tool, args, value, status = "completed") {
  if (!isRecord(value)) return undefined; // Some failed task calls invoke after(undefined) before their error part.
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  let resultClass = status === "error" || value.isError === true ? "error" : "unknown";
  if (resultClass !== "error") {
    if (Object.hasOwn(metadata, "exit")) {
      resultClass = Number.isInteger(metadata.exit) ? (metadata.exit === 0 ? "success" : "error") : "unknown";
    } else if (!/^(?:bash|shell)$/iu.test(String(tool))
      && (typeof value.output === "string" || Array.isArray(value.content))) resultClass = "success";
  }
  let output = typeof value.output === "string" ? value.output.slice(0, MAX_TOOL_OUTCOME_OUTPUT_CHARS) : undefined;
  if (output === undefined && Array.isArray(value.content)) {
    // MCP after hooks carry content instead of native output. Ignore non-text blocks, and bound work as well as bytes.
    output = value.content.slice(0, 16).filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map(part => part.text.slice(0, MAX_TOOL_OUTCOME_OUTPUT_CHARS)).join("\n").slice(0, MAX_TOOL_OUTCOME_OUTPUT_CHARS);
  }
  // Native write/edit metadata is authoritative; input paths alone do not prove a file was changed.
  const filePath = typeof metadata.filepath === "string" ? metadata.filepath
    : isRecord(metadata.filediff) && typeof metadata.filediff.file === "string" ? metadata.filediff.file : undefined;
  return toolOutcomeFromHook("opencode", "tool.execute.after", {
    tool_name: tool, tool_input: args,
    error: typeof value.error === "string" ? value.error : resultClass === "error" ? output : undefined,
    tool_response: { resultClass, ...(output !== undefined ? { output: output.slice(0, MAX_TOOL_OUTCOME_OUTPUT_CHARS) } : {}),
      ...(filePath ? { filePath } : {}) }
  });
}

function outputHashFromResponse(response) {
  if (response === undefined || response === null) return undefined;
  let text;
  if (typeof response === "string") text = response;
  else { try { text = JSON.stringify(response); } catch { return undefined; } }
  if (typeof text !== "string") return undefined;
  let bounded = text.slice(0, MAX_TOOL_OUTCOME_OUTPUT_CHARS);
  // Never hash half of a surrogate pair (the native helper's boundedText drops it the same way).
  if (/[\uD800-\uDBFF]$/u.test(bounded)) bounded = bounded.slice(0, -1);
  return sha256(normalizeHashText(bounded));
}

/** Hashes the same hook action shape for both the pretool activity and its completed-tool outcome. */
export function normalizedActionHashFromHook(rawToolName, toolInput) {
  if (toolInput === undefined) return undefined;
  const toolName = typeof rawToolName === "string"
    ? boundedOutcomeText(rawToolName.trim().replace(/[\u0000-\u001f\u007f]/gu, ""), MAX_TOOL_OUTCOME_NAME_CHARS) || "unknown"
    : "unknown";
  let serialized;
  try { serialized = JSON.stringify(toolInput); } catch { return undefined; }
  if (serialized === undefined) return undefined;
  return sha256(`${toolName.toLowerCase()}\n${serialized}`);
}

/** Strips unexpected fields before the compact summary is allowed onto the authenticated lifecycle wire. */
export function sanitizeToolOutcome(value) {
  if (!isRecord(value)) return undefined;
  const resultClass = value.resultClass;
  if (!TOOL_RESULT_CLASSES.has(resultClass)) return undefined;
  const toolName = typeof value.toolName === "string"
    ? boundedOutcomeText(value.toolName.replace(/[\u0000-\u001f\u007f]/gu, ""), MAX_TOOL_OUTCOME_NAME_CHARS)
    : "unknown";
  const normalizedActionHash = typeof value.normalizedActionHash === "string" && /^[a-f0-9]{64}$/u.test(value.normalizedActionHash)
    ? value.normalizedActionHash : undefined;
  const errorHash = resultClass === "error" && typeof value.errorHash === "string" && /^[a-f0-9]{64}$/u.test(value.errorHash)
    ? value.errorHash : undefined;
  const outputHash = resultClass !== "error" && typeof value.outputHash === "string" && /^[a-f0-9]{64}$/u.test(value.outputHash)
    ? value.outputHash : undefined;
  const changedPathHashes = Array.isArray(value.changedPathHashes)
    ? [...new Set(value.changedPathHashes.filter((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)))].slice(0, MAX_TOOL_OUTCOME_PATHS)
    : [];
  return {
    toolName: toolName || "unknown",
    resultClass,
    ...(normalizedActionHash ? { normalizedActionHash } : {}),
    ...(errorHash ? { errorHash } : {}),
    ...(outputHash ? { outputHash } : {}),
    changedPathHashes
  };
}

function isCompletedToolEvent(provider, event) {
  if (event === "PostToolUse") return true;
  if ((provider === "claude" || provider === "kimi") && event === "PostToolUseFailure") return true;
  if (provider === "opencode" && (event === "tool.execute.after" || event === "message.part.updated")) return true;
  return provider === "hermes" && event === "post_tool_call";
}

function explicitToolResultClass(response) {
  if (!isRecord(response)) return "unknown";
  if (response.denied === true || response.status === "denied" || response.resultClass === "denied") return "denied";
  if (response.isError === true || response.is_error === true || response.success === false
    || response.status === "error" || response.status === "failed" || response.resultClass === "error") return "error";
  if (response.success === true || response.status === "success" || response.status === "completed"
    || response.resultClass === "success") return "success";
  const exitCode = typeof response.exit_code === "number" ? response.exit_code
    : typeof response.exitCode === "number" ? response.exitCode : undefined;
  if (exitCode !== undefined && Number.isInteger(exitCode)) return exitCode === 0 ? "success" : "error";
  return "unknown";
}

function isFileWriteTool(value) {
  return typeof value === "string" && /^(?:Edit|Write)$/iu.test(value.trim());
}

function normalizePathForHash(value) {
  return value.trim().replace(/\\/gu, "/");
}

function normalizeHashText(value) {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function firstHookString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function boundedOutcomeText(value, limit) {
  const text = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/u.test(text) ? text.slice(0, -1) : text;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Claude Code's own HTTP hooks (`type: "http"`, measured with 2.1.281) carry the lifecycle events straight to the
// gateway's loopback listener: no process per event. Claude fills both headers from the session's environment
// (`allowedEnvVars`), so the capability never appears in its argv or in a file. Decision hooks (PreToolUse) stay on
// permission-gate.mjs and the 0600 socket: every failure of an HTTP hook lets the tool run (fail open).
export const CLAUDE_HTTP_HOOK = Object.freeze({
  pathPrefix: "/claude/v1/",
  sessionHeader: "x-canvastty-session",
  capabilityHeader: "x-canvastty-capability",
  // The oldest Claude Code whose HTTP hooks, header interpolation and loopback rule were checked end to end.
  minimumVersion: "2.1.281"
});
