#!/usr/bin/env node
import { MAX_HOOK_INPUT_BYTES, RUNTIME_STATES } from "./runtime-protocol.mjs";
import { reportLifecycle } from "./runtime-client.mjs";

const [state, event] = process.argv.slice(2);
if (!RUNTIME_STATES.includes(state) || typeof event !== "string" || event.length === 0) {
  process.exit(0);
}

let raw = "";
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
const lastAssistantMessage = event === 'Stop' && typeof input?.last_assistant_message === 'string'
  ? boundedText(input.last_assistant_message, 4000) : undefined;
await reportLifecycle({ state, event, turnId, lastAssistantMessage });

/** Cuts at the limit without leaving a dangling high surrogate. */
function boundedText(value, limit) {
  const text = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/u.test(text) ? text.slice(0, -1) : text;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
