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
const prompt = string({ minLength: 1, maxLength: 65_536 });
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
    "spawn_agent",
    "Launch another provider's agent as a CanvasTTY subagent of this session and optionally deliver a first prompt. Returns the new session id. host is optional placement only: \"auto\" lets CanvasTTY pick a configured remote host (failing open to local), or pass a host id; the provider always runs exactly as requested.",
    {
      provider: string({ minLength: 1, maxLength: 32 }),
      cwd: string({ minLength: 1, maxLength: 4_096 }),
      prompt,
      title,
      host: string({ minLength: 1, maxLength: 128 }),
      model: string({ minLength: 1, maxLength: 100 }),
      accountId: string({ minLength: 1, maxLength: 64 }),
      dataClass: string({ enum: ["D0", "D1", "D2", "D3"] }),
      profile: string({ enum: ["normal", "yolo"] }),
      isolation: string({ enum: ["direct", "worktree", "container"] }),
      worktreeRef: string({ maxLength: 256 }),
      containerProfileId: string({ maxLength: 64 }),
      allowSubagents: boolean()
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
    "get_agent_result",
    "Get the exit state (running | done | failed) and terminal tail of one of this session's subagents.",
    { sessionId },
    ["sessionId"]
  ),
  tool(
    "cancel_agent",
    "Dispose one of this session's subagents, terminating its process.",
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

// Mirrors the browser catalog's canonical serializer so bridge digests and
// payload checks behave identically.
export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

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
      if (candidate.length < (property.minLength ?? 0)) errors.push(`${key} is too short.`);
      if (property.maxLength !== undefined && candidate.length > property.maxLength) errors.push(`${key} is too long.`);
      if (property.enum && !property.enum.includes(candidate)) errors.push(`${key} has an unsupported value.`);
      value[key] = candidate;
    } else if (property.type === "boolean") {
      if (typeof candidate !== "boolean") errors.push(`${key} must be a boolean.`);
      else value[key] = candidate;
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
