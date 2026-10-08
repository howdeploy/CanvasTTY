import { reportLifecycle } from "./runtime-client.mjs";
import { CAPTURE_RESULT_ENV } from "./runtime-protocol.mjs";
import { finalAnswer } from "./opencode-final-answer.mjs";
import { createOpenCodeDecisions } from "./opencode-decisions.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HOOK_TIMEOUT_MS, preparePluginHook } from "./plugin-hook-dispatch.mjs";

let rootSessionId = null;
let rootWorking = false;
let rootTurnId = null;
const lifecycleEnabled = process.env.CANVASTTY_LIFECYCLE_HOOKS_ENABLED !== "0";
const pluginHookRegistry = process.env.CANVASTTY_PLUGIN_HOOK_REGISTRY ?? "";
const pluginHookRunnerCommand = process.env.CANVASTTY_PLUGIN_HOOK_RUNNER_COMMAND ?? "";
const pluginHookRunner = process.env.CANVASTTY_PLUGIN_HOOK_RUNNER ?? "";
const pluginHookTerminalSessionId = process.env.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID ?? "";
const pluginHooks = parsePluginHooks(process.env.CANVASTTY_PLUGIN_HOOK_SESSION);
// Set only for a session whose orchestrator reads its final answer (a subagent): the last reply is then sent with
// the turn's end, at most MAX_RESULT_CHARS.
const captureResult = process.env[CAPTURE_RESULT_ENV] === "1";

// OpenCode (1.18+) runs EVERY exported function of a plugin module as a plugin and reads its hooks; a helper exported
// here broke the whole OpenCode start ("plugin config hook failed", then "n.provider"). Export nothing but the plugin.
export const CanvasTTYLifecycle = async (input) => {
  // Decision hooks: only for a session launched with them; otherwise nothing below changes. A deny throws, which
  // fails the tool call before OpenCode asks anyone.
  const decisions = createOpenCodeDecisions({ client: input && typeof input === "object" ? input.client : undefined });
  return {
    ...(decisions.enabled ? { "tool.execute.before": (hookInput, output) => decisions.guard(hookInput, output) } : {}),
    event: async ({ event }) => lifecycleEvent(event, decisions, input && typeof input === "object" ? input.client : undefined)
  };
};

async function lifecycleEvent(event, decisions, client) {
  if (!event || typeof event !== "object") return;
  const properties = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  const info = properties.info && typeof properties.info === "object" ? properties.info : null;
  const sessionId = stringField(properties.sessionID, properties.sessionId, properties.id, info?.id);
  // A call a plugin allowed is answered for every session of this OpenCode (subagents included).
  if (event.type === "permission.asked" && await decisions.permissionAsked(properties)) return;

  // A resumed root session emits updates, not a second creation event.
  if (event.type === "session.created" || (!rootSessionId && event.type === "session.updated")) {
    const session = info ?? properties;
    if (session.parentID || session.parentId) return;
    rootSessionId = stringField(session.id, sessionId);
    rootWorking = false;
    rootTurnId = null;
    if (!rootSessionId) return;
    if (lifecycleEnabled || captureResult) {
      await reportLifecycle({ state: "idle", event: event.type, threadId: rootSessionId });
    }
    runPluginHooks("session-start", event.type, event);
    return;
  }
  if (rootSessionId && sessionId && sessionId !== rootSessionId) return;
  if (!rootSessionId) return;

  if (event.type === "session.status") {
    const statusValue = properties.status;
    const status = typeof statusValue === "string"
      ? statusValue
      : statusValue && typeof statusValue === "object"
        ? statusValue.type
        : null;
    if (status === "busy" || status === "retry") {
      const startsTurn = status === "busy" && !rootWorking;
      if (startsTurn || !rootTurnId) rootTurnId = randomUUID();
      rootWorking = true;
      if (lifecycleEnabled || captureResult) {
        await reportLifecycle({ state: "working", event: `session.status:${status}`, turnId: rootTurnId });
      }
      if (startsTurn) {
        runPluginHooks("prompt-submit", `session.status:${status}`, event);
      }
    } else if (status === "idle") {
      rootWorking = false;
      // A result-capturing turn is not complete until its bounded session.idle SDK read settles. Publishing idle
      // here lets an orchestrator review before the final answer has reached the host.
      if (lifecycleEnabled && !captureResult) await reportLifecycle({ state: "idle", event: "session.status:idle", turnId: rootTurnId });
    }
    return;
  }
  if (event.type === "session.idle") {
    rootWorking = false;
    const endingSessionId = rootSessionId, endingTurnId = rootTurnId;
    const result = captureResult && endingTurnId ? await finalAnswer(client, endingSessionId) : undefined;
    // SDK reads are asynchronous: the next turn may already have started while the old answer was being read.
    if (endingSessionId !== rootSessionId || endingTurnId !== rootTurnId || rootWorking) return;
    if (lifecycleEnabled || captureResult) {
      await reportLifecycle({ state: "idle", event: event.type, turnId: rootTurnId, ...(result ? { result } : {}) });
    }
    runPluginHooks("stop", event.type, event);
  } else if (event.type === "permission.asked") {
    if (lifecycleEnabled || captureResult) await reportLifecycle({ state: "needs_approval", event: event.type, turnId: rootTurnId });
    runPluginHooks("permission-request", event.type, event);
  } else if (event.type === "permission.replied") {
    rootWorking = true;
    if (lifecycleEnabled || captureResult) await reportLifecycle({ state: "working", event: event.type, turnId: rootTurnId });
    runPluginHooks("permission-result", event.type, event);
  } else if (event.type === "question.asked") {
    if (lifecycleEnabled || captureResult) await reportLifecycle({ state: "needs_approval", event: event.type, turnId: rootTurnId });
  } else if (event.type === "question.replied" || event.type === "question.rejected") {
    rootWorking = true;
    if (lifecycleEnabled || captureResult) await reportLifecycle({ state: "working", event: event.type, turnId: rootTurnId });
  } else if (event.type === "session.error") {
    rootWorking = false;
    if (lifecycleEnabled || captureResult) await reportLifecycle({ state: "idle", event: event.type, turnId: rootTurnId });
    runPluginHooks("stop", event.type, event);
  } else if (event.type === "session.deleted") {
    runPluginHooks("session-end", event.type, event);
    rootWorking = false;
    rootSessionId = null;
    rootTurnId = null;
  } else if (event.type === "tool.execute.after") {
    runPluginHooks("after-tool", event.type, event);
  }
}


function stringField(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function parsePluginHooks(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((hook) => (
      hook
      && typeof hook === "object"
      && typeof hook.key === "string"
      && Array.isArray(hook.events)
      && hook.events.every((event) => typeof event === "string")
    ));
  } catch {
    return [];
  }
}

function runPluginHooks(event, providerEvent, payload) {
  if (!pluginHookRegistry || !pluginHookRunnerCommand || !pluginHookRunner || !pluginHookTerminalSessionId) return;
  let input = "{}";
  try {
    input = JSON.stringify(payload);
  } catch {
    // The runner accepts an empty event when an OpenCode payload is not serializable.
  }
  if (Buffer.byteLength(input, "utf8") > 1024 * 1024) return;
  for (const hook of pluginHooks) {
    if (!hook.events.includes(event)) continue;
    launchPluginHook(hook.key, event, providerEvent, input);
  }
}

/**
 * One process per hook: the hook's own entry, started from here (under the runner command, Electron as Node), not a
 * runner process that reads the registry and then starts it; after-tool fires on every tool call.
 */
function launchPluginHook(key, event, providerEvent, input) {
  void preparePluginHook({
    registryPath: pluginHookRegistry,
    key,
    provider: "opencode",
    event,
    providerEvent,
    terminalSessionId: pluginHookTerminalSessionId,
    raw: input,
    environment: process.env
  }).then((hook) => {
    if (!hook) return;
    const child = spawn(pluginHookRunnerCommand, [hook.entry], {
      cwd: hook.root,
      env: hook.env,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true
    });
    const timeout = setTimeout(() => child.kill(), HOOK_TIMEOUT_MS);
    timeout.unref();
    const clear = () => clearTimeout(timeout);
    child.once("exit", clear);
    child.once("error", clear);
    child.stdin?.once("error", () => undefined);
    child.stdin?.end(hook.input);
  }).catch(() => {
    // Optional plugin hooks never interrupt OpenCode's own event handling.
  });
}
