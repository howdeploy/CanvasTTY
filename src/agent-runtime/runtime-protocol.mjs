export const RUNTIME_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_MESSAGE_BYTES = 64 * 1024;
export const CAPTURE_RESULT_ENV = "CANVASTTY_RUNTIME_CAPTURE_RESULT";
export const MAX_RESULT_CHARS = 4096;

export const AGENT_RUNTIME_ENV = Object.freeze({
  address: "CANVASTTY_RUNTIME_ADDRESS",
  terminalSessionId: "CANVASTTY_RUNTIME_TERMINAL_SESSION_ID",
  provider: "CANVASTTY_RUNTIME_PROVIDER",
  capabilityToken: "CANVASTTY_RUNTIME_CAPABILITY"
});

export const RUNTIME_STATES = Object.freeze(["idle", "working", "needs_approval"]);
