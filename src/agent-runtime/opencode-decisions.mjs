import { FAIL_CLOSED_MESSAGE, buildRequest, exchange, identityFrom } from "./permission-gate.mjs";
import { OPENCODE_DECISIONS_ENV, helperDeadlineMs } from "./runtime-protocol.mjs";

/**
 * Decision hooks for OpenCode, used by opencode-plugin.mjs while `CANVASTTY_RUNTIME_DECISIONS` is "1".
 *
 * `guard` runs in `tool.execute.before` (before OpenCode's own permission check, in every mode, YOLO included)
 * and sends each shell and file-writing call (bash, write, edit, multiedit, apply_patch/patch) to CanvasTTY the way
 * the Claude/Codex/Qwen PreToolUse hook does. A deny throws, which fails that tool call with the reason as its error
 * text for the model. An allow (only from plugins the person let allow) is remembered by call id: when OpenCode then
 * asks for that call (`permission.asked`), `permissionAsked` answers `once` through OpenCode's own API
 * (POST /permission/{requestID}/reply), never `always`. Anything else (ask, no verdict, an error) leaves OpenCode's
 * own flow as it is.
 *
 * `CANVASTTY_RUNTIME_DECISIONS` is set only when the launch wanted decisions (base protection on, or a decision plugin
 * applies), so the guard fails closed like the PreToolUse gate: a checked call it could not send, or that got no
 * readable answer, or the gateway's own failure, throws FAIL_CLOSED_MESSAGE and does not run.
 */

const MAX_ALLOWED = 64;

/** @param {{ client?: any, env?: Record<string, string | undefined>, send?: typeof exchange }} [options] */
export function createOpenCodeDecisions({ client, env = process.env, send = exchange } = {}) {
  const identity = identityFrom(env);
  const enabled = env[OPENCODE_DECISIONS_ENV] === "1" && identity?.provider === "opencode";
  /** callIDs a plugin allowed; their permission request is answered `once`. */
  const allowed = new Set();

  async function guard(input, output) {
    if (!enabled) return;
    let decision = null;
    try {
      const call = guardedCall(stringOf(input?.tool), output && typeof output === "object" ? output.args : null);
      if (!call) return;
      const message = buildRequest({ tool_name: call.toolName, tool_input: call.toolInput }, identity);
      if (message) decision = await send(identity.address, message, helperDeadlineMs(env));
    } catch {
      decision = null;
    }
    // OpenCode cannot take an ask from here, so the gateway's own failure is a deny too.
    if (!decision || (decision.unavailable && decision.behavior === "ask")) throw new Error(FAIL_CLOSED_MESSAGE);
    if (decision.behavior === "deny") {
      throw new Error(decision.message || "CanvasTTY blocked this tool call. Ask the person how to proceed.");
    }
    const callID = stringOf(input?.callID);
    if (decision.behavior === "allow" && callID) {
      allowed.add(callID);
      while (allowed.size > MAX_ALLOWED) allowed.delete(allowed.values().next().value);
    }
  }

  /** `permission.asked`: answers `once` for a call a plugin allowed; false when it left the request alone. */
  async function permissionAsked(properties) {
    if (!enabled || !properties || typeof properties !== "object") return false;
    const requestID = stringOf(properties.id);
    const callID = stringOf(properties.tool?.callID);
    if (!requestID || !callID || !allowed.delete(callID)) return false;
    return reply(client, requestID, "once");
  }

  return { enabled, guard, permissionAsked };
}

/**
 * An OpenCode tool call in the shape the decision hook reads (Claude Code's hook tool names and input shapes), or null
 * for a tool that neither runs commands nor writes files. OpenCode's own names: bash {command, workdir}, write
 * {filePath, content}, edit {filePath, oldString, newString, replaceAll}, multiedit {filePath, edits: [{filePath,
 * oldString, newString, replaceAll}]}, apply_patch {patchText}. They go out as bash {command, workdir}, Write {file_path,
 * content} (the whole new file), Edit {file_path, old_string, new_string, replace_all} (one replacement in the file),
 * MultiEdit {file_path, edits: [{old_string, new_string, replace_all}]} and apply_patch {patch}, so a decision service
 * can tell a whole-file write from a partial edit and sees the text an edit replaces.
 */
export function guardedCall(tool, args) {
  if (!tool || !args || typeof args !== "object") return null;
  if (tool === "bash") {
    if (typeof args.command !== "string" || args.command.length === 0) return null;
    const workdir = typeof args.workdir === "string" && args.workdir.length > 0 ? args.workdir : null;
    return { toolName: "bash", toolInput: { command: args.command, ...(workdir ? { workdir } : {}) } };
  }
  if (tool === "write" || tool === "edit" || tool === "multiedit") {
    const filePath = pathOf(args);
    if (!filePath) return null;
    if (tool === "write") {
      return { toolName: "Write", toolInput: { file_path: filePath, ...(typeof args.content === "string" ? { content: args.content } : {}) } };
    }
    if (tool === "edit") return { toolName: "Edit", toolInput: { file_path: filePath, ...replacement(args) } };
    const edits = Array.isArray(args.edits) ? args.edits.filter((edit) => edit && typeof edit === "object").map(replacement)
      .filter((edit) => Object.keys(edit).length > 0) : [];
    return { toolName: "MultiEdit", toolInput: { file_path: filePath, edits } };
  }
  if (tool === "apply_patch" || tool === "patch") {
    const patch = typeof args.patchText === "string" ? args.patchText : typeof args.patch === "string" ? args.patch : null;
    return patch ? { toolName: "apply_patch", toolInput: { patch } } : null;
  }
  return null;
}

function pathOf(args) {
  return typeof args.filePath === "string" && args.filePath.length > 0 ? args.filePath
    : typeof args.file_path === "string" && args.file_path.length > 0 ? args.file_path : null;
}

/** One OpenCode replacement {oldString, newString, replaceAll} as Claude's Edit input (fields that are not text are left out). */
function replacement(edit) {
  const text = (camel, snake) => typeof edit[camel] === "string" ? edit[camel] : typeof edit[snake] === "string" ? edit[snake] : null;
  const oldString = text("oldString", "old_string");
  const newString = text("newString", "new_string");
  const replaceAll = typeof edit.replaceAll === "boolean" ? edit.replaceAll : typeof edit.replace_all === "boolean" ? edit.replace_all : null;
  return {
    ...(oldString !== null ? { old_string: oldString } : {}),
    ...(newString !== null ? { new_string: newString } : {}),
    ...(replaceAll !== null ? { replace_all: replaceAll } : {})
  };
}

/** POST /permission/{requestID}/reply with `once`. False on any failure (OpenCode's prompt stays for the person). */
async function reply(client, requestID, value) {
  try {
    if (typeof client?.permission?.reply === "function") {
      return accepted(await client.permission.reply({ requestID, reply: value }));
    }
    const raw = client?._client;
    if (typeof raw?.post === "function") {
      return accepted(await raw.post({
        url: "/permission/{requestID}/reply",
        path: { requestID },
        body: { reply: value },
        headers: { "Content-Type": "application/json" }
      }));
    }
  } catch { /* the person answers */ }
  return false;
}

function accepted(result) {
  if (!result || typeof result !== "object") return result === true;
  if (result.error) return false;
  if (result.response && typeof result.response.ok === "boolean") return result.response.ok;
  return true;
}

function stringOf(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 400 ? value : null;
}
