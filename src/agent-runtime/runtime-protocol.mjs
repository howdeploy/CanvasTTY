export const RUNTIME_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_MESSAGE_BYTES = 64 * 1024;
// Only captured final replies use the larger frame; decision/status limits stay unchanged.
export const MAX_RESULT_MESSAGE_BYTES = 512 * 1024;
export const CAPTURE_RESULT_ENV = "CANVASTTY_RUNTIME_CAPTURE_RESULT";
export const MAX_RESULT_CHARS = 65_536;
// Final-answer capture requires an explicit, expiring grant for one Codex session.
export const CAPTURE_ANSWER_ENV = "CANVASTTY_RUNTIME_CAPTURE_ANSWER";
export const CAPTURE_ANSWER_EXPIRES_AT_ENV = "CANVASTTY_RUNTIME_CAPTURE_ANSWER_EXPIRES_AT";
export const MAX_ANSWER_CHARS = 4000;
// Hook stdin is read whole before the message is built, so its cap is independent
// of the wire cap: a large Stop payload must still yield its turn id and the
// truncated answer instead of being dropped.
export const MAX_HOOK_INPUT_BYTES = 512 * 1024;

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
