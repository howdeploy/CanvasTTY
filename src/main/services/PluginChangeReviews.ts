import type { PluginChangeReview, PluginChangeReviewFile, PluginReviewTextPage } from "../../shared/contracts.ts";

const MAX_REVIEW_BYTES = 512 * 1024;
// A normalized review may repeat selected paths as conflict-resolution keys in its action.
// Conflict metadata consumes review space, keeping generated actions below the 1 MiB transport frame.
const MAX_ACTION_BYTES = 2 * MAX_REVIEW_BYTES;
const MAX_TEXT = 16_384;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin review data is invalid.");
  return value as Record<string, unknown>;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Plugin review page is invalid.");
  return value as number;
}

function boundedJson(value: unknown, limit: number): string {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new Error("Card action data must be JSON."); }
  if (!json || Buffer.byteLength(json) > limit) throw new Error("Card action data is too large.");
  return json;
}

/** Only the app window can supply this payload. Keep it separate from the host's session identity. */
export function normalizeCardActionInput(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  record(value);
  return record(JSON.parse(boundedJson(value, MAX_ACTION_BYTES)));
}

/** Plugins provide text and declared action ids, never HTML or instructions to execute. */
export function normalizeCardReview(value: unknown, redact: (text: string) => string, actions: ReadonlySet<string>): PluginChangeReview {
  boundedJson(value, MAX_REVIEW_BYTES);
  const review = record(value);
  const text = (value: unknown, limit = MAX_TEXT): string => {
    if (typeof value !== "string") throw new Error("Plugin review text is invalid.");
    return redact(value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, "")).slice(0, limit);
  };
  const page = (value: unknown): PluginReviewTextPage => {
    const source = record(value);
    if (typeof source.hasMore !== "boolean") throw new Error("Plugin review page is invalid.");
    return { ...(source.label === undefined ? {} : { label: text(source.label, 160) }), text: text(source.text),
      startLine: integer(source.startLine), totalLines: integer(source.totalLines), hasMore: source.hasMore };
  };
  const action = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !actions.has(value)) throw new Error("Plugin review action is not declared by this plugin.");
    return value;
  };
  if (!Array.isArray(review.groups) || review.groups.length > 24) throw new Error("Plugin review groups are invalid.");
  let fileCount = 0;
  const groups = review.groups.map(value => {
    const group = record(value);
    if (typeof group.sessionId !== "string" || !/^[\w-]{1,160}$/u.test(group.sessionId)) throw new Error("Plugin review session is invalid.");
    if (!Array.isArray(group.files) || (fileCount += group.files.length) > 400) throw new Error("Plugin review files are invalid.");
    const files = group.files.map(value => {
      const file = record(value);
      if (typeof file.path !== "string" || !file.path || file.path.length > 1000 || /[\u0000-\u001F\u007F]/u.test(file.path)) throw new Error("Plugin review file path is invalid.");
      if (redact(file.path) !== file.path) throw new Error("Plugin review file names contain protected data.");
      const result: PluginChangeReviewFile = { path: file.path, diff: text(file.diff) };
      if (file.status !== undefined) result.status = text(file.status, 80);
      if (file.page !== undefined) result.page = integer(file.page);
      if (file.hasMore !== undefined) {
        if (typeof file.hasMore !== "boolean") throw new Error("Plugin review page is invalid.");
        result.hasMore = file.hasMore;
      }
      result.truncated = file.truncated === true || (typeof file.diff === "string" && file.diff.length > MAX_TEXT);
      if (file.conflict !== undefined) {
        const conflict = record(file.conflict);
        result.conflict = { current: page(conflict.current), agent: page(conflict.agent) };
        if (result.conflict.current.text.length === MAX_TEXT || result.conflict.agent.text.length === MAX_TEXT) result.truncated = true;
      }
      return result;
    });
    return { sessionId: group.sessionId, title: text(group.title, 200), files,
      ...(group.error !== undefined ? { error: text(group.error, 2000) } : {}) };
  });
  const acceptActionId = action(review.acceptActionId), rejectActionId = action(review.rejectActionId);
  const result: PluginChangeReview = {
    title: text(review.title, 200), groups,
    ...(acceptActionId ? { acceptActionId } : {}), ...(rejectActionId ? { rejectActionId } : {}),
    ...(review.nextOffset !== undefined ? { nextOffset: integer(review.nextOffset) } : {})
  };
  boundedJson(result, MAX_REVIEW_BYTES);
  return result;
}
