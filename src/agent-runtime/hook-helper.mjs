#!/usr/bin/env node
import {
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV,
  CAPTURE_RESULT_ENV,
  MAX_ANSWER_CHARS,
  MAX_HOOK_INPUT_BYTES,
  MAX_RESULT_CHARS,
  RUNTIME_STATES
} from "./runtime-protocol.mjs";
import { reportLifecycle } from "./runtime-client.mjs";

const [state, event] = process.argv.slice(2);
if (!RUNTIME_STATES.includes(state) || typeof event !== "string" || event.length === 0) {
  process.exit(0);
}

let raw = "";
const captureResult = process.env[CAPTURE_RESULT_ENV] === "1";
const answerCaptureExpiresAt = Number(process.env[CAPTURE_ANSWER_EXPIRES_AT_ENV]);
const captureAnswer = process.env[CAPTURE_ANSWER_ENV] === "1"
  && Number.isFinite(answerCaptureExpiresAt) && answerCaptureExpiresAt > Date.now();
for await (const chunk of process.stdin) {
  raw += chunk.toString("utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_HOOK_INPUT_BYTES) {
    raw = "";
    break;
  }
}

let input = null;
try {
  input = raw.trim().length > 0 ? JSON.parse(raw) : null;
} catch {
  input = null;
}
const turnId = firstString(
  input?.turn_id,
  input?.turnId,
  input?.prompt_id,
  input?.promptId
);
const finalAnswer = state === "idle" && event === "Stop" && typeof input?.last_assistant_message === "string"
  ? input.last_assistant_message
  : null;
let result;
if (captureResult && finalAnswer !== null) {
  const text = boundedText(finalAnswer, MAX_RESULT_CHARS);
  result = { text, truncated: text.length < finalAnswer.length };
}
const lastAssistantMessage = captureAnswer && finalAnswer !== null
  ? boundedText(finalAnswer, MAX_ANSWER_CHARS)
  : undefined;
await reportLifecycle({
  state,
  event,
  turnId,
  ...(result === undefined ? {} : { result }),
  ...(lastAssistantMessage === undefined ? {} : { lastAssistantMessage })
});

/** Cuts at the limit without leaving a dangling high surrogate. */
function boundedText(value, limit) {
  const text = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}
function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
