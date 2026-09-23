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
const capsuleId = string({ minLength: 36, maxLength: 36 });
const reviewId = string({ minLength: 36, maxLength: 36 });

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
    "Launch another provider's agent as a CanvasTTY subagent and optionally deliver a first prompt. Returns session id and selected host/account/isolation. Native host placement uses host:\"auto\" (may fall back to local) or an exact host id. For containers, isolation:\"container\" plus containerRoute:\"auto\" selects an eligible saved profile, its fixed host and an API account; no eligible route fails without a host fallback. Optional containerProfileIds restrict that selection. Auto container routes cannot include host, containerProfileId or worktreeRef. A concrete provider always runs as requested with no evaluator call. provider:auto uses opt-in configured decision routes and never changes account/host constraints. Automatic agent and automatic container selection cannot be combined.",
    {
      provider: string({ minLength: 1, maxLength: 32 }),
      category: string({ enum: ["general", "code", "review", "research", "writing"] }),
      cwd: string({ minLength: 1, maxLength: 4_096 }),
      prompt,
      title,
      host: string({ minLength: 1, maxLength: 128 }),
      model: string({ minLength: 1, maxLength: 100 }),
      effort: string({ enum: ["minimal", "low", "medium", "high", "xhigh", "max"] }),
      accountId: string({ minLength: 1, maxLength: 64 }),
      dataClass: string({ enum: ["D0", "D1", "D2", "D3"] }),
      transport: string({ enum: ["pty", "acp"] }),
      profile: string({ enum: ["normal", "yolo"] }),
      isolation: string({ enum: ["direct", "worktree", "container"] }),
      worktreeRef: string({ maxLength: 256 }),
      containerProfileId: string({ maxLength: 64 }),
      containerRoute: string({ enum: ['auto'] }),
      containerProfileIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: string({ minLength: 1, maxLength: 64 }) },
      allowSubagents: boolean()
    },
    ["provider", "cwd"]
  ),
  tool('recommend_agent', 'Explicitly review an eligible exact agent/account/model/host tuple without launching. Requires opt-in decision settings. No raw task/path is sent to the optional metadata evaluator. Use launch_recommended_agent to consume its short-lived, caller-owned handle.', {
    cwd: string({ minLength: 1, maxLength: 4096 }), provider: string({ minLength: 1, maxLength: 32 }), prompt, title,
    category: string({ enum: ['general', 'code', 'review', 'research', 'writing'] }), host: string({ minLength: 1, maxLength: 64 }), accountId: string({ minLength: 1, maxLength: 64 }), model: string({ minLength: 1, maxLength: 100 }), effort: string({ enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }),
    difficulty: string({ enum: ['simple', 'normal', 'hard'] }),
    dataClass: string({ enum: ['D0', 'D1', 'D2', 'D3'] }), profile: string({ enum: ['normal', 'yolo'] }), transport: string({ enum: ['pty', 'acp'] }), allowSubagents: boolean(),
    isolation: string({ enum: ['direct', 'worktree', 'container'] }), worktreeRef: string({ maxLength: 256 }), containerProfileId: string({ maxLength: 64 })
  }, ['cwd']),
  tool('launch_recommended_agent', 'Launch the exact reviewed recommendation. Expired, revoked or retargeted recommendations fail; request a fresh recommendation. Cannot change the original task or route.', { recommendationId: string({ minLength: 1, maxLength: 64 }) }, ['recommendationId']),
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
    "Get a subagent result: ACP turn completion with stopReason, or PTY process exit and terminal tail.",
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
  ),
  tool('spawn_capsule_agent', 'Capture selected existing files from this local host parent’s current project and launch a direct child in a configured API container. Task text inherits the parent’s data class. No full checkout, raw follow-up prompt or child delegation. Returns session and capsule IDs; retained output is reviewed separately.', {
    provider: string({ enum: ['opencode', 'minimax', 'omp'] }),
    files: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: string({ minLength: 1, maxLength: 1024 }) },
    task: prompt, containerProfileId: string({ minLength: 1, maxLength: 64 }),
    accountId: string({ minLength: 1, maxLength: 64 }), model: string({ minLength: 1, maxLength: 100 }), title
  }, ['provider', 'files', 'task', 'containerProfileId']),
  tool('preview_capsule_review_agent', 'Explicitly preview a paid advisory child for this owned immutable diff. Requires an exact local API account/model/container and current parent budgets. Returns a single-use preview token; no model or engine call. Preference text is withheld from this tool response.', { capsuleId, reviewId, accountId: string({ minLength: 1, maxLength: 64 }), model: string({ minLength: 1, maxLength: 100 }), containerProfileId: string({ minLength: 1, maxLength: 64 }) }, ['capsuleId', 'reviewId', 'accountId', 'model', 'containerProfileId']),
  tool('launch_capsule_review_agent', 'Explicitly launch the previously previewed advisory child. Consumes provider quota. Receives only a read-only immutable diff/task and route-filtered context; cannot apply or delegate. Result is ordinary untrusted child output.', { previewId: capsuleId }, ['previewId']),
  tool('list_capsules', 'List output owned by this parent’s current launch, including closed child sessions. Returns at most 16 entries.', { offset: integer({ minimum: 0, maximum: 512 }) }),
  tool('review_capsule', 'Freeze and review owned, confirmed-stopped capsule output. Returns a bounded patch page. Inspect all pages before applying.', { capsuleId }, ['capsuleId']),
  tool('read_capsule_patch', 'Read the next 8192-character page of the same current immutable capsule review. Use the returned nextOffset; stale output or authority rejects.', { capsuleId, reviewId, offset: integer({ minimum: 0, maximum: 2097152 }) }, ['capsuleId', 'reviewId', 'offset']),
  tool('apply_capsule', 'Apply the exact reviewed output to unchanged original selected files. Requires this parent’s current source and delegation authority. No arbitrary patch input.', { capsuleId, reviewId }, ['capsuleId', 'reviewId']),
  tool('recover_capsule_apply', 'Explicitly recover an interrupted owned apply without overwriting new user edits.', { capsuleId, reviewId }, ['capsuleId', 'reviewId']),
  tool('list_capsule_test_profiles', 'List saved test commands available in preexisting local images. Commands cannot be supplied or changed by an agent.'),
  tool('validate_capsule_conventions', 'Explicit deterministic checks for this owned immutable review using enabled source-project rules. Returns bounded advisory warnings and coverage at this parent’s current data-class ceiling. No model, formatter execution or automatic fix. The project setting starts off.', { capsuleId, reviewId }, ['capsuleId', 'reviewId']),
  tool('test_capsule', 'Run a saved test profile in a fresh copy of the exact reviewed files, with no provider credentials, network, source checkout or terminal. Returns a run id; fetch the result separately. Missing dependencies never trigger installation or host fallback.', { capsuleId, reviewId, testProfileId: string({ minLength: 1, maxLength: 64 }) }, ['capsuleId', 'reviewId', 'testProfileId']),
  tool('list_capsule_tests', 'List at most16 retained test runs belonging to this owned capsule.', { capsuleId, offset: integer({ minimum: 0, maximum: 64 }) }, ['capsuleId']),
  tool('get_capsule_test_result', 'Get owned test state and up to8192 characters of its bounded log. Results apply only to the returned review/profile/image identity.', { runId: capsuleId, offset: integer({ minimum: 0, maximum: 1048576 }) }, ['runId']),
  tool('cancel_capsule_test', 'Request cancellation of an owned active test and exact container cleanup. Unconfirmed stops retain the snapshot.', { runId: capsuleId }, ['runId']),
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
    } else if (property.type === 'array') {
      if (!Array.isArray(candidate) || candidate.length < property.minItems || candidate.length > property.maxItems || candidate.some(item => typeof item !== 'string' || item.length < property.items.minLength || item.length > property.items.maxLength)) errors.push(`${key} must be a bounded array of strings.`);
      else if (new Set(candidate.map(item => item.toLowerCase())).size !== candidate.length) errors.push(`${key} must contain unique values.`);
      else value[key] = [...candidate];
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
