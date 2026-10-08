export const RUNTIME_PROTOCOL_VERSION: 1;
export const MAX_RUNTIME_MESSAGE_BYTES: number;
export const CAPTURE_RESULT_ENV: string;
export const MAX_RESULT_CHARS: number;
export const CAPTURE_ANSWER_ENV: string;
export const CAPTURE_ANSWER_EXPIRES_AT_ENV: string;
export const MAX_ANSWER_CHARS: number;
export const MAX_HOOK_INPUT_BYTES: number;
export const MAX_TOOL_OUTCOME_NAME_CHARS: number;
export const MAX_TOOL_OUTCOME_ERROR_CHARS: number;
export const MAX_TOOL_OUTCOME_PATHS: number;
export const AGENT_RUNTIME_ENV: Readonly<{
  address: "CANVASTTY_RUNTIME_ADDRESS";
  terminalSessionId: "CANVASTTY_RUNTIME_TERMINAL_SESSION_ID";
  provider: "CANVASTTY_RUNTIME_PROVIDER";
  capabilityToken: "CANVASTTY_RUNTIME_CAPABILITY";
}>;
export const RUNTIME_STATES: readonly ["idle", "working", "needs_approval"];
/** The provider's conversation id in the one form it may be stored or passed to its CLI, or undefined. */
export function normalizeThreadId(provider: string, value: unknown): string | undefined;
export const PERMISSION_GATE: Readonly<{
  helperMs: number;
  gatewayMs: number;
  hookSeconds: number;
  toolInputBytes: number;
  toolInputPreviewChars: number;
  toolNameChars: number;
  messageChars: number;
}>;
export const OPENCODE_DECISIONS_ENV: "CANVASTTY_RUNTIME_DECISIONS";
export const DECISION_BUDGET_ENV: "CANVASTTY_RUNTIME_DECISION_MS";
export const DECISION_FAIL_CLOSED_ENV: "CANVASTTY_RUNTIME_FAIL_CLOSED";
export const DEFAULT_DECIDE_TIMEOUT_MS: number;
export const MIN_DECIDE_TIMEOUT_MS: number;
export const MAX_DECIDE_TIMEOUT_MS: number;
export function permissionGateTimings(budgetMs?: number): { budgetMs: number; gatewayMs: number; helperMs: number; hookSeconds: number };
export function helperDeadlineMs(env: Record<string, string | undefined> | undefined): number;
export function toolOutcomeFromHook(provider: string, event: string, input: unknown): {
  toolName: string;
  resultClass: "success" | "error" | "denied" | "unknown";
  normalizedActionHash?: string;
  errorHash?: string;
  outputHash?: string;
  changedPathHashes: string[];
} | undefined;
export function normalizedActionHashFromHook(toolName: unknown, toolInput: unknown): string | undefined;
export function sanitizeToolOutcome(value: unknown): ReturnType<typeof toolOutcomeFromHook>;
export const CLAUDE_HTTP_HOOK: Readonly<{
  pathPrefix: string;
  sessionHeader: string;
  capabilityHeader: string;
  minimumVersion: string;
}>;
