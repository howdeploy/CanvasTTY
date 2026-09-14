export const RUNTIME_PROTOCOL_VERSION: 1;
export const MAX_RUNTIME_MESSAGE_BYTES: number;
export const CAPTURE_RESULT_ENV: string;
export const MAX_RESULT_CHARS: number;
export const AGENT_RUNTIME_ENV: Readonly<{
  address: "CANVASTTY_RUNTIME_ADDRESS";
  terminalSessionId: "CANVASTTY_RUNTIME_TERMINAL_SESSION_ID";
  provider: "CANVASTTY_RUNTIME_PROVIDER";
  capabilityToken: "CANVASTTY_RUNTIME_CAPABILITY";
}>;
export const RUNTIME_STATES: readonly ["idle", "working", "needs_approval"];
