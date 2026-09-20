import { createConnection } from "node:net";
import {
  AGENT_RUNTIME_ENV,
  MAX_RUNTIME_MESSAGE_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_STATES
} from "./runtime-protocol.mjs";

const CONNECT_TIMEOUT_MS = 1_000;

export async function reportLifecycle({ state, event, turnId = null, result, lastAssistantMessage = undefined }) {
  if (!RUNTIME_STATES.includes(state)) return false;
  if (typeof event !== "string" || event.length === 0 || event.length > 80) return false;
  const address = process.env[AGENT_RUNTIME_ENV.address];
  const terminalSessionId = process.env[AGENT_RUNTIME_ENV.terminalSessionId];
  const provider = process.env[AGENT_RUNTIME_ENV.provider];
  const capabilityToken = process.env[AGENT_RUNTIME_ENV.capabilityToken];
  if (!address || !terminalSessionId || !provider || !capabilityToken) return false;

  const message = {
    v: RUNTIME_PROTOCOL_VERSION,
    type: "lifecycle",
    terminalSessionId,
    provider,
    capabilityToken,
    state,
    event,
    turnId: normalizedId(turnId),
    ...(result === undefined ? {} : { result })
  };
  if(provider==='codex'&&event==='Stop'&&typeof lastAssistantMessage==='string') message.lastAssistantMessage=lastAssistantMessage.slice(0,4000);
  const payload = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  if (payload.length > MAX_RUNTIME_MESSAGE_BYTES) return false;

  return new Promise((resolve) => {
    const socket = createConnection(address);
    let settled = false;
    let response = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    timeout.unref?.();
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response, "utf8") > MAX_RUNTIME_MESSAGE_BYTES) return finish(false);
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline));
        finish(parsed?.v === RUNTIME_PROTOCOL_VERSION && parsed?.type === "ack");
      } catch {
        finish(false);
      }
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

function normalizedId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 160 ? value : null;
}
