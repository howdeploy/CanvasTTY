import { canonicalStringify } from "./tool-catalog.mjs";

export const ORCHESTRATION_MCP_SERVER_NAME = "canvastty_agents";
export const MAX_ORCHESTRATION_PAYLOAD_BYTES = 128 * 1024;

const string = (options = {}) => ({ type: "string", ...options });
const boolean = () => ({ type: "boolean" });
const integer = (options = {}) => ({ type: "integer", ...options });
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

const sessionId = string({ minLength: 1, maxLength: 128 });
// Plugin launch options, `{ "<pluginId>": { "<field>": value } }`, as a plugin tool hands them out; the launch
// checks them against each plugin's declared fields exactly like the launcher's.
const MAX_LAUNCH_OPTIONS_BYTES = 16 * 1024;
const launchOptions = {
  type: "object",
  maxProperties: 16,
  additionalProperties: { type: "object" }
};
const prompt = string({ minLength: 1, maxLength: 65_536 });
/** Every provider id spawn_agent accepts, in launcher order: src/shared/providerCatalog.ts without "terminal"
 *  (a test keeps the two equal; this file ships as is and cannot import TypeScript). */
export const AGENT_PROVIDER_IDS = Object.freeze([
  "codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi", "cursor", "minimax", "devin", "antigravity"
]);
/** wait_for_agent: the longest wait one call may ask for, and the wait without timeoutSeconds (some MCP clients
 *  end a tool call after 60 seconds). */
export const MAX_AGENT_WAIT_SECONDS = 600;
export const DEFAULT_AGENT_WAIT_SECONDS = 55;
/** spawn_agent.effort: every level some CLI takes (src/shared/launchModel.ts REASONING_EFFORTS; a test keeps them equal). */
export const REASONING_EFFORT_IDS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]);
const provider = string({ minLength: 1, maxLength: 32, enum: [...AGENT_PROVIDER_IDS] });

/** The refusal for a provider id CanvasTTY does not know; names list_providers. */
export function unknownProviderMessage(value) {
  const shown = typeof value === "string" ? JSON.stringify(value.slice(0, 32)) : "that value";
  return `Unknown provider ${shown}. Call list_providers to see which providers this CanvasTTY can launch; provider must be one of: ${AGENT_PROVIDER_IDS.join(", ")}.`;
}
const title = string({ minLength: 1, maxLength: 80 });

function tool(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: object(properties, required)
  };
}

export const ORCHESTRATION_TOOL_DEFINITIONS = Object.freeze([
  tool(
    "list_providers",
    "List the agent providers CanvasTTY can launch as subagents of this session: id (the exact spawn_agent.provider value), name, installed and available (its CLI was found), signIn (ok, signed_out, expired or unknown, from CanvasTTY's last usage check; unknown is not an error), subagent and orchestrator support, and plugin launch options when plugins offer them. Call it first, before spawn_agent. Never search the filesystem, PATH or config folders for agent CLIs or their settings: this list is what CanvasTTY can launch."
  ),
  tool(
    "spawn_agent",
    `Launch another provider's agent as a CanvasTTY subagent of this session and optionally deliver a first prompt. Returns the new session id. provider must be an id from list_providers (known ids: ${AGENT_PROVIDER_IDS.join(", ")}); call list_providers first to see which are installed and signed in. Give each subagent one self-contained part of the task and an absolute cwd. If the person names a model, pass it as model in the format list_providers gives for that provider (OpenCode: provider/model); effort sets the reasoning effort where that CLI has one (list_providers shows its efforts). An unsupported model or effort is refused with the reason. profile: without it the subagent gets this session's launch profile, or the next lower one its CLI has; a subagent never gets more than this session (plan < normal < acceptEdits < auto) and never YOLO. "auto" lets it work without asking the person for each edit or command inside the project; CanvasTTY's outer layers (agent isolation, base protection) still stop writes outside the project, secrets and system changes. The answer says the profile it got. cwd must be this project's folder or a folder inside it. launchOptions passes plugin launch options exactly as a plugin tool gives them (for example the account a plugin picked), for plugins that allow an orchestrator to choose them. Refusals say why (a limit the person set, a folder outside the project, a profile above this session's): change the request instead of retrying it. Then call wait_for_agent and get_agent_result.`,
    {
      provider,
      cwd: string({ minLength: 1, maxLength: 4_096 }),
      prompt,
      title,
      profile: string({ enum: ["auto", "normal", "acceptEdits", "plan"] }),
      model: string({ minLength: 1, maxLength: 200 }),
      effort: string({ enum: [...REASONING_EFFORT_IDS] }),
      launchOptions
    },
    ["provider", "cwd"]
  ),
  tool(
    "send_to_agent",
    "Write a prompt into one of this session's subagents. Plain terminal sessions are not agents.",
    { sessionId, prompt, submit: boolean() },
    ["sessionId", "prompt"]
  ),
  tool(
    "observe_agent",
    "Read the capped terminal tail and status of one of this session's subagents.",
    { sessionId, maxChars: integer({ minimum: 256, maximum: 8_192 }) },
    ["sessionId"]
  ),
  tool(
    "wait_for_agent",
    `Wait until one of this session's subagents stops working, instead of polling observe_agent or get_agent_result; nothing is sent to it while it waits. Returns reason "idle" (the turn that answers your latest prompt ended and it waits for input; an idle before that turn started does not count), "needs_approval" (its card shows a prompt only the person may answer; never answer it yourself), "done" or "failed" (its process exited), "quiet" (it reports no status or no turn start and its screen stopped changing, so judge from output), "closed" (its card was closed) or "timeout" after timeoutSeconds (default ${DEFAULT_AGENT_WAIT_SECONDS}, at most ${MAX_AGENT_WAIT_SECONDS}), with status, exitCode, waitedMs, the masked terminal tail as output, and answer (the final reply of the turn that ended, for Codex and OpenCode subagents); when the subagent's process exited (for example at once, on a model its CLI does not know), exitLines holds the last lines of its screen as plain text, which say why. A timeout means only that this wait ended: inspect its output for a terminal error and stop on a reported failure; wait again only while the task is still progressing. Then read get_agent_result before cancel_agent, even for a short answer. If answer.nextOffset is non-null, read every page with get_agent_result(answerOffset=answer.nextOffset) before cancel_agent; pages contain consecutive UTF-16 text. A captured answer replaces the raw terminal tail (output is empty). After cancel_agent succeeds, do not wait again. A late wait for a recently closed child of this orchestrator returns closed immediately, with resultReadBeforeClose indicating whether its captured answer was read before cleanup; this does not invalidate earlier successful waits.`,
    { sessionId, timeoutSeconds: integer({ minimum: 1, maximum: MAX_AGENT_WAIT_SECONDS }) },
    ["sessionId"]
  ),
  tool(
    "get_agent_result",
    "Get a subagent's final reply as answer, status and exit state. Captured replies up to 65,536 UTF-16 code units are retained in memory and returned in bounded pages. Start without answerOffset; if answer.nextOffset is non-null, pass it as answerOffset until nextOffset is null. Concatenate page text in order before closing the child. sourceTruncated:true means the capture itself exceeded its limit: ask the worker to save its full deliverable in a project file and read it. Prefer answer; output is empty when a captured reply is present, otherwise it is a raw terminal tail.",
    { sessionId, answerOffset: integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) },
    ["sessionId"]
  ),
  tool(
    "cancel_agent",
    "Dispose one of this session's subagents, terminating its process. Call get_agent_result and read all final-answer pages first, even for a short reply returned by wait_for_agent; closing with an unread result is refused. To stop a working agent, call this directly. After success, use the results already received and do not call wait_for_agent again for this child.",
    { sessionId }
  ),
  tool(
    "list_agents",
    "List this session's subagents with provider, status, and title."
  )
]);

export const ORCHESTRATION_TOOL_NAMES = Object.freeze(ORCHESTRATION_TOOL_DEFINITIONS.map((definition) => definition.name));
const ORCHESTRATION_TOOL_SET = new Set(ORCHESTRATION_TOOL_NAMES);

export function isApprovedOrchestrationTool(value) {
  return typeof value === "string" && ORCHESTRATION_TOOL_SET.has(value);
}

// Plugin tools (EP-6) are listed by the host per session as `<pluginId>__<name>`, with the plugin id's dots
// written as `_` (Anthropic and OpenAI tool names allow only [a-zA-Z0-9_-], at most 64 characters). Plugin ids
// never contain `_`, so the first `__` separates the two parts. The host checks the arguments against the schema.
export const MAX_PLUGIN_TOOL_NAME_LENGTH = 64;
const PLUGIN_TOOL_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?__[a-z][a-z0-9_]*$/;

export function isPluginOrchestrationTool(value) {
  return typeof value === "string" && value.length <= MAX_PLUGIN_TOOL_NAME_LENGTH
    && !ORCHESTRATION_TOOL_SET.has(value) && PLUGIN_TOOL_NAME.test(value);
}

// The browser catalog's canonical serializer, so bridge digests and payload
// checks behave identically on both bridges.
export { canonicalStringify };

export function validateOrchestrationArguments(toolName, args) {
  const definition = ORCHESTRATION_TOOL_DEFINITIONS.find((entry) => entry.name === toolName);
  if (!definition) return { ok: false, error: `Unsupported orchestration tool: ${toolName}.` };
  if (args === undefined || args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "Tool arguments must be an object." };
  }
  const schema = definition.inputSchema;
  const errors = [];
  const value = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const present = Object.prototype.hasOwnProperty.call(args, key);
    if (!present) {
      if (schema.required.includes(key)) errors.push(`Missing required argument: ${key}.`);
      continue;
    }
    const candidate = args[key];
    if (property.type === "string") {
      if (typeof candidate !== "string") {
        errors.push(`${key} must be a string.`);
        continue;
      }
      if (property.enum && !property.enum.includes(candidate)) {
        errors.push(key === "provider" ? unknownProviderMessage(candidate) : `${key} is not an accepted value.`);
        continue;
      }
      if (candidate.length < (property.minLength ?? 0)) errors.push(`${key} is too short.`);
      if (property.maxLength !== undefined && candidate.length > property.maxLength) errors.push(`${key} is too long.`);
      value[key] = candidate;
    } else if (property.type === "boolean") {
      if (typeof candidate !== "boolean") errors.push(`${key} must be a boolean.`);
      else value[key] = candidate;
    } else if (property === launchOptions) {
      const plain = (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry);
      if (!plain(candidate) || Object.keys(candidate).length > property.maxProperties
        || !Object.values(candidate).every((values) => plain(values)
          && Object.values(values).every((item) => typeof item === "string" || typeof item === "boolean"))) {
        errors.push(`${key} must map plugin ids to objects of text or true/false values.`);
      } else if (Buffer.byteLength(canonicalStringify(candidate), "utf8") > MAX_LAUNCH_OPTIONS_BYTES) {
        errors.push(`${key} is too large.`);
      } else value[key] = candidate;
    } else if (property.type === "integer") {
      if (!Number.isInteger(candidate)) errors.push(`${key} must be an integer.`);
      else if (property.minimum !== undefined && candidate < property.minimum) errors.push(`${key} is below the minimum.`);
      else if (property.maximum !== undefined && candidate > property.maximum) errors.push(`${key} is above the maximum.`);
      else value[key] = candidate;
    }
  }
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      errors.push(`Unexpected argument: ${key}.`);
    }
  }
  if (errors.length > 0) return { ok: false, error: errors.join(" ") };
  return { ok: true, value };
}
