import { createConnection } from "node:net";
import { NdjsonLineReader } from "./ndjson.mjs";
import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV,
  MAX_ANSWER_CHARS,
  MAX_RUNTIME_MESSAGE_BYTES,
  normalizeThreadId,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_STATES,
  sanitizeToolOutcome
} from "./runtime-protocol.mjs";

const CONNECT_TIMEOUT_MS = 1_000;

export async function reportLifecycle({ state, event, turnId = null, threadId, result, lastAssistantMessage, toolOutcome }) {
  if (!RUNTIME_STATES.includes(state)) return false;
  if (typeof event !== "string" || event.length === 0 || event.length > 80) return false;
  const address = process.env[AGENT_RUNTIME_ENV.address];
  const terminalSessionId = process.env[AGENT_RUNTIME_ENV.terminalSessionId];
  const provider = process.env[AGENT_RUNTIME_ENV.provider];
  const capabilityToken = process.env[AGENT_RUNTIME_ENV.capabilityToken];
  if (!address || !terminalSessionId || !provider || !capabilityToken) return false;

  const validThreadId = normalizeThreadId(provider, threadId);
  const safeToolOutcome = sanitizeToolOutcome(toolOutcome);

  const message = {
    v: RUNTIME_PROTOCOL_VERSION,
    type: "lifecycle",
    terminalSessionId,
    provider,
    capabilityToken,
    state,
    event,
    turnId: normalizedId(turnId),
    ...(validThreadId !== undefined ? { threadId: validThreadId } : {}),
    ...(result === undefined ? {} : { result }),
    ...(safeToolOutcome === undefined ? {} : { toolOutcome: safeToolOutcome })
  };
  const answerCaptureExpiresAt = Number(process.env[CAPTURE_ANSWER_EXPIRES_AT_ENV]);
  const shouldCheckAnswerGrant = process.env[CAPTURE_ANSWER_ENV] === "1"
    && Number.isFinite(answerCaptureExpiresAt) && answerCaptureExpiresAt > Date.now()
    && provider === "codex" && event === "Stop"
    && state === "idle" && typeof lastAssistantMessage === "string";
  if (shouldCheckAnswerGrant && await answerCaptureIsActive({
    address,
    terminalSessionId,
    provider,
    capabilityToken
  })) {
    message.lastAssistantMessage = lastAssistantMessage.slice(0, MAX_ANSWER_CHARS);
  }
  const payload = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  if (payload.length > MAX_RUNTIME_MESSAGE_BYTES) return false;

  return sendMessage(address, payload, (parsed) => parsed?.type === "ack");
}

async function answerCaptureIsActive({ address, terminalSessionId, provider, capabilityToken }) {
  const request = {
    v: RUNTIME_PROTOCOL_VERSION,
    type: "answer-capture-check",
    terminalSessionId,
    provider,
    capabilityToken
  };
  return sendMessage(address, Buffer.from(`${JSON.stringify(request)}\n`, "utf8"),
    (parsed) => parsed?.type === "ack" && parsed?.answerCapture === true);
}

function sendMessage(address, payload, accepted) {
  if (payload.length > MAX_RUNTIME_MESSAGE_BYTES) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection(address);
    let settled = false;
    const lines = new NdjsonLineReader({ maxLineBytes: MAX_RUNTIME_MESSAGE_BYTES });
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
      try {
        const [line] = lines.push(chunk);
        if (!line) return;
        const parsed = JSON.parse(line.toString("utf8"));
        finish(parsed?.v === RUNTIME_PROTOCOL_VERSION && accepted(parsed));
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
