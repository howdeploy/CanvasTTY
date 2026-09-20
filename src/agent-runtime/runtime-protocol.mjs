export const RUNTIME_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_MESSAGE_BYTES = 64 * 1024;
export const CAPTURE_RESULT_ENV = "CANVASTTY_RUNTIME_CAPTURE_RESULT";
export const MAX_RESULT_CHARS = 4096;
// Opt-in final-answer capture for a companion display (Even G2): set per spawned
// Codex session, never inherited from the user's environment.
export const CAPTURE_ANSWER_ENV = "CANVASTTY_RUNTIME_CAPTURE_ANSWER";
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
