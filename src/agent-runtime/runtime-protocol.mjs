export const RUNTIME_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_MESSAGE_BYTES = 16 * 1024;
/** Hook stdin can carry a long final answer; the forwarded message stays within MAX_RUNTIME_MESSAGE_BYTES. */
export const MAX_HOOK_INPUT_BYTES = 512 * 1024;

export const AGENT_RUNTIME_ENV = Object.freeze({
  address: "CANVASTTY_RUNTIME_ADDRESS",
  terminalSessionId: "CANVASTTY_RUNTIME_TERMINAL_SESSION_ID",
  provider: "CANVASTTY_RUNTIME_PROVIDER",
  capabilityToken: "CANVASTTY_RUNTIME_CAPABILITY"
});

export const RUNTIME_STATES = Object.freeze(["idle", "working", "needs_approval"]);
