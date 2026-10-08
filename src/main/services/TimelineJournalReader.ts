import { createReadStream } from "node:fs";
import type { TimelineEvent } from "../../shared/backlog.ts";

const STREAM_HIGH_WATER_MARK = 64 * 1024;
const EVENT_LOOP_YIELD_CHARS = 256 * 1024;

/**
 * Visits valid journal records without retaining a whole segment or an event array.
 * Malformed records are ignored, as they are by SessionTimelineService.read().
 * A line is kept intact until JSON parsing so valid oversized imported records keep
 * their existing behavior.
 */
export async function forEachTimelineEvent(
  path: string,
  visit: (event: TimelineEvent) => boolean | void
): Promise<number> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: STREAM_HIGH_WATER_MARK });
  let pendingParts: string[] = [];
  let workSinceYield = 0;
  let yieldCount = 0;

  const deliver = (line: string): boolean => {
    let event: TimelineEvent;
    try { event = JSON.parse(line) as TimelineEvent; }
    catch { return false; }
    if (!event || typeof event.id !== "string" || typeof event.sessionId !== "string" || typeof event.at !== "number") return false;
    return visit(event) === true;
  };
  const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  for await (const chunk of stream) {
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf("\n", from);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.slice(from, end);
      if (part) {
        pendingParts.push(part);
        workSinceYield += part.length;
      }
      from = newline < 0 ? chunk.length : newline + 1;
      if (newline >= 0) {
        const line = pendingParts.length === 0 ? ""
          : pendingParts.length === 1 ? pendingParts[0]
          : pendingParts.join("");
        pendingParts.length = 0;
        if (deliver(line)) return yieldCount;
        workSinceYield++;
      }
      if (workSinceYield >= EVENT_LOOP_YIELD_CHARS) {
        workSinceYield = 0;
        await yieldToEventLoop();
        yieldCount++;
      }
    }
  }

  if (pendingParts.length > 0) deliver(pendingParts.length === 1 ? pendingParts[0] : pendingParts.join(""));
  return yieldCount;
}
