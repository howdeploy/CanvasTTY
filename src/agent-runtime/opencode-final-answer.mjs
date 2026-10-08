import { MAX_RESULT_CHARS } from "./runtime-protocol.mjs";

// Kept out of opencode-plugin.mjs: OpenCode treats every function that module exports as a plugin.
const ANSWER_READ_TIMEOUT_MS = 2_000;

/**
 * The text of the session's last assistant message ({ text, truncated }), or undefined when it cannot be read in
 * time. OpenCode's SDK: v2 `session.messages({ sessionID })`, v1 `session.messages({ path: { id } })`; each item is
 * { info: { role }, parts: [{ type: "text", text, synthetic? }] }.
 */
export async function finalAnswer(client, sessionID, timeoutMs = ANSWER_READ_TIMEOUT_MS) {
  if (!client?.session || typeof client.session.messages !== "function" || !sessionID) return undefined;
  let timer;
  try {
    const read = (async () => {
      let answer = await client.session.messages({ sessionID });
      if (!Array.isArray(answer?.data ?? answer)) answer = await client.session.messages({ path: { id: sessionID } });
      return answer?.data ?? answer;
    })();
    const messages = await Promise.race([read, new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]);
    if (!Array.isArray(messages)) return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.info?.role !== "assistant" || !Array.isArray(message.parts)) continue;
      const text = message.parts
        .filter((part) => part?.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) continue;
      // The end of a long answer is where its conclusion is.
      return text.length > MAX_RESULT_CHARS
        ? { text: text.slice(text.length - MAX_RESULT_CHARS), truncated: true }
        : { text, truncated: false };
    }
  } catch {
    // The answer stays unknown; the lifecycle still reports the turn's end.
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}
