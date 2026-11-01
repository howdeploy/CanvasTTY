export const MAX_BRIDGE_PAYLOAD_BYTES = 512 * 1024;
export const MCP_SERVER_NAME = "canvastty_browser";

const string = (options = {}) => ({ type: "string", ...options });
const number = (options = {}) => ({ type: "number", ...options });
const integer = (options = {}) => ({ type: "integer", ...options });
const boolean = () => ({ type: "boolean" });
const array = (items, options = {}) => ({ type: "array", items, ...options });
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

const id = string({ minLength: 1, maxLength: 128 });
const tabId = string({ minLength: 1, maxLength: 128 });
const url = string({ minLength: 1, maxLength: 2_048 });
const text = string({ maxLength: 65_536 });
const refObject = object({
  ref: string({ minLength: 1, maxLength: 256 }),
  tabId,
  frameId: string({ minLength: 1, maxLength: 256 }),
  documentRevision: integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  backendNodeId: integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
}, ["ref", "tabId", "frameId", "documentRevision", "backendNodeId"]);
const ref = {
  oneOf: [string({ minLength: 1, maxLength: 256 }), refObject]
};
const timeoutMs = integer({ minimum: 50, maximum: 120_000 });
const cursor = string({ minLength: 1, maxLength: 512 });
const limit = integer({ minimum: 1, maximum: 500 });

function tool(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: object(properties, required)
  };
}

export const TOOL_DEFINITIONS = Object.freeze([
  tool("browser_list_tabs", "List visible browser tabs and their stable tab IDs."),
  tool("browser_new_tab", "Open a new tab; use the returned tabId for later commands. engine: auto (default) opens it in the background in a lighter engine when the person installed one (reading, observing, clicking by element), otherwise as a visible Chromium tab; chromium always opens a visible Chromium tab. A background tab moves to Chromium by itself when needed (screenshots, bot checks, unreadable pages, or when shown): same tabId, stale refs, and the result says so.", {
    url,
    engine: string({ minLength: 1, maxLength: 64 })
  }),
  tool("browser_close_tab", "Close a visible tab by stable tab ID.", { tabId }, ["tabId"]),
  tool("browser_activate_tab", "Make a tab active and visible.", { tabId }, ["tabId"]),
  tool("browser_navigate", "Navigate a tab, or the active tab when tabId is omitted, to an HTTP(S) URL.", {
    tabId,
    url,
    expectedRevision: integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  }, ["url"]),
  tool("browser_back", "Go back in a tab's navigation history.", { tabId }, ["tabId"]),
  tool("browser_forward", "Go forward in a tab's navigation history.", { tabId }, ["tabId"]),
  tool("browser_reload", "Reload a tab and invalidate element refs from the previous document.", { tabId }, ["tabId"]),
  tool("browser_observe", "Observe the active document as accessibility elements with revision-bound refs.", {
    tabId,
    cursor,
    limit
  }),
  tool("browser_read_page", "Read bounded page text without exposing cookies, saved passwords, or raw browser internals.", {
    tabId,
    cursor,
    limit
  }),
  tool("browser_screenshot", "Capture a screenshot of a visible tab. This does not expose CDP.", { tabId }),
  tool("browser_click", "Click a revision-bound element ref. On STALE_REF, observe again before retrying.", {
    tabId,
    ref,
    expectedRevision: integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  }, ["ref"]),
  tool("browser_hover", "Hover a revision-bound element ref.", { tabId, ref }, ["ref"]),
  tool("browser_type", "Type into an observed editable element. mode: replace replaces its full contents (including contenteditable editors); insert types at its selection. Omitted preserves legacy behavior: replace input/textarea, insert in contenteditable. Password values are never returned.", {
    tabId,
    ref,
    text,
    mode: { type: "string", enum: ["insert", "replace"] }
  }, ["ref", "text"]),
  tool("browser_select", "Select one or more option values in a form control.", {
    tabId,
    ref,
    values: array(string({ maxLength: 2_048 }), { minItems: 1, maxItems: 64 })
  }, ["ref", "values"]),
  tool("browser_press", "Press a key or chord in a tab or observed element. Prefix a named key or letter/digit with Ctrl (or Control), Shift, Alt or Meta separated by +; e.g. Ctrl+A, Ctrl+Enter, Meta+A, Ctrl+Shift+ArrowLeft. Modifiers do not remain held between calls.", {
    tabId,
    ref,
    key: string({ minLength: 1, maxLength: 40 })
  }, ["key"]),
  tool("browser_scroll", "Scroll a tab or an observed scrollable element.", {
    tabId,
    ref,
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    deltaX: number({ minimum: -5_000, maximum: 5_000 }),
    deltaY: number({ minimum: -5_000, maximum: 5_000 })
  }),
  tool("browser_drag", "Drag one revision-bound element ref to another.", {
    tabId,
    ref,
    targetRef: ref
  }, ["ref", "targetRef"]),
  tool("browser_wait_for", "Wait for a bounded browser condition; never use unbounded sleeps.", {
    tabId,
    condition: { type: "string", enum: ["load", "network-idle", "text", "element", "url", "download"] },
    value: string({ maxLength: 8_192 }),
    timeoutMs
  }, ["condition"]),
  tool("browser_handle_dialog", "Accept or dismiss the currently visible JavaScript dialog.", {
    tabId,
    accept: boolean(),
    promptText: string({ maxLength: 8_192 })
  }, ["accept"]),
  tool("browser_download_wait", "Wait for a browser download to complete within a bounded timeout.", {
    tabId,
    timeoutMs
  }),
  tool("browser_upload", "Choose explicit local paths for a file input without exposing unrelated filesystem data.", {
    tabId,
    ref,
    paths: array(string({ minLength: 1, maxLength: 4_096 }), { minItems: 1, maxItems: 20 })
  }, ["ref", "paths"]),
  tool("browser_get_activity", "Read the bounded audit stream for this browser connection.", {
    cursor,
    limit
  })
]);

const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

export const APPROVED_BROWSER_TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map(({ name }) => name));

export function isApprovedBrowserTool(value) {
  return typeof value === "string" && TOOL_BY_NAME.has(value);
}

export function validateToolArguments(toolName, value) {
  const definition = TOOL_BY_NAME.get(toolName);
  if (!definition) return { ok: false, error: `Unsupported browser tool: ${String(toolName).slice(0, 80)}.` };
  const error = validateSchema(definition.inputSchema, value, "arguments");
  return error ? { ok: false, error } : { ok: true, value };
}

function validateSchema(schema, value, path) {
  if (schema.oneOf) {
    const failures = schema.oneOf.map((candidate) => validateSchema(candidate, value, path));
    return failures.some((failure) => failure === null)
      ? null
      : `${path} does not match an accepted shape.`;
  }
  if (schema.type === "object") {
    if (!isPlainObject(value)) return `${path} must be an object.`;
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) return `${path}.${key} is not allowed.`;
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) return `${path}.${key} is required.`;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!(key in value)) continue;
      const failure = validateSchema(child, value[key], `${path}.${key}`);
      if (failure) return failure;
    }
    return null;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} is too short.`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} is too long.`;
    for (let index = 0; index < value.length; index += 1) {
      const failure = validateSchema(schema.items, value[index], `${path}[${index}]`);
      if (failure) return failure;
    }
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string.`;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short.`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long.`;
    if (schema.enum && !schema.enum.includes(value)) return `${path} is not an accepted value.`;
    return null;
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number.`;
    if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer.`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below the minimum.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} is above the maximum.`;
    return null;
  }
  if (schema.type === "boolean") return typeof value === "boolean" ? null : `${path} must be a boolean.`;
  return `${path} uses an unsupported schema.`;
}

const byCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The app's one canonical JSON: object keys sorted by UTF-16 code unit (never
 * by locale), no whitespace, undefined properties left out as JSON.stringify
 * does. Bridge messages, their digests, provider config hashes and the browser
 * audit chain all use it.
 *
 * Strict by default: a cycle, a non-finite number, a non-plain object or an
 * undefined array entry throws. `lenient` answers those as JSON.stringify
 * would (null, the object's own keys, null) for records that must hash
 * exactly as they were written. `compareKeys` exists only to verify records
 * hashed under an older key order.
 */
export function canonicalStringify(value, options = {}) {
  const lenient = options.lenient === true;
  const compare = options.compareKeys ?? byCodeUnit;
  const seen = new Set();
  const encode = (item, inArray) => {
    switch (typeof item) {
      case "string":
      case "boolean":
        return JSON.stringify(item);
      case "number":
        if (!Number.isFinite(item) && !lenient) throw new TypeError("Canonical JSON cannot contain a non-finite number.");
        return JSON.stringify(item);
      case "object": {
        if (item === null) return "null";
        const array = Array.isArray(item);
        if (!array && !lenient && !isPlainObject(item)) throw new TypeError("Canonical JSON cannot contain object.");
        if (seen.has(item)) throw new TypeError("Canonical JSON cannot contain a cycle.");
        seen.add(item);
        try {
          if (array) return `[${item.map((entry) => encode(entry, true)).join(",")}]`;
          const fields = [];
          for (const key of Object.keys(item).sort(compare)) {
            const text = encode(item[key], false);
            if (text !== undefined) fields.push(`${JSON.stringify(key)}:${text}`);
          }
          return `{${fields.join(",")}}`;
        } finally {
          seen.delete(item);
        }
      }
      default:
        if (item === undefined && !inArray) return undefined;
        if (lenient && typeof item !== "bigint") return inArray ? "null" : undefined;
        throw new TypeError(`Canonical JSON cannot contain ${typeof item}.`);
    }
  };
  const text = encode(value, false);
  if (text === undefined) throw new TypeError("Canonical JSON cannot contain undefined.");
  return text;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
