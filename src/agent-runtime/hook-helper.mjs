#!/usr/bin/env node
import { CAPTURE_RESULT_ENV, MAX_RESULT_CHARS, MAX_RUNTIME_MESSAGE_BYTES, RUNTIME_STATES } from "./runtime-protocol.mjs";
import { reportLifecycle } from "./runtime-client.mjs";

const [state, event] = process.argv.slice(2);
if (!RUNTIME_STATES.includes(state) || typeof event !== "string" || event.length === 0) {
  process.exit(0);
}

let raw = "";
const captureResult = process.env[CAPTURE_RESULT_ENV] === "1";
for await (const chunk of process.stdin) {
  raw += chunk.toString("utf8");
  if (Buffer.byteLength(raw, "utf8") > (captureResult ? 512 * 1024 : MAX_RUNTIME_MESSAGE_BYTES)) {
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
let result;
if (captureResult && state === "idle" && event === "Stop" && typeof input?.last_assistant_message === "string") {
  let text = input.last_assistant_message.slice(0, MAX_RESULT_CHARS);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  result = { text, truncated: text.length < input.last_assistant_message.length };
}
await reportLifecycle({ state, event, turnId, ...(result === undefined ? {} : { result }) });

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
