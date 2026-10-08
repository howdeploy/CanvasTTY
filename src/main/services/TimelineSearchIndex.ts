export interface TimelineSegmentSearchIndex {
  size: number;
  mtimeMs: number;
  sessionIds: Set<string>;
  types: Set<string>;
  /** False when a malformed oversized line could not be indexed; such a segment must be read. */
  complete: boolean;
  /** Four 32K-bit bloom filters per segment, with no false negatives. */
  bloom: Uint8Array;
}

const BLOOM_BYTES = 16 * 1024;
const BLOOM_BITS = BLOOM_BYTES * 8;
const BLOOM_MASK = BLOOM_BITS - 1;

export function createTimelineSegmentSearchIndex(size = 0, mtimeMs = 0): TimelineSegmentSearchIndex {
  return { size, mtimeMs, sessionIds: new Set(), types: new Set(), complete: true, bloom: new Uint8Array(BLOOM_BYTES) };
}

export function addTimelineSearchEvent(
  index: TimelineSegmentSearchIndex,
  event: { sessionId: string; type: string; summary?: string; detail?: string }
): void {
  index.sessionIds.add(event.sessionId);
  if (event.type) index.types.add(event.type);
  // Match page()'s template interpolation even for legacy rows with malformed optional fields.
  const text = `${String(event.summary)}\n${event.detail === null || event.detail === undefined ? "" : String(event.detail)}`.toLocaleLowerCase();
  for (let offset = 0; offset + 2 < text.length; offset++) {
    const first = text.charCodeAt(offset);
    const second = text.charCodeAt(offset + 1);
    const third = text.charCodeAt(offset + 2);
    const hash = (Math.imul(first, 0x1f1f1f1f) ^ Math.imul(second, 0x45d9f3b) ^ Math.imul(third, 0x119de1f3)) >>> 0;
    setBit(index.bloom, hash & BLOOM_MASK);
    setBit(index.bloom, Math.imul(hash, 0x9e3779b1) >>> 17 & BLOOM_MASK);
    setBit(index.bloom, Math.imul(hash ^ 0x85ebca6b, 0xc2b2ae35) >>> 17 & BLOOM_MASK);
    setBit(index.bloom, Math.imul(hash ^ 0x27d4eb2f, 0x165667b1) >>> 17 & BLOOM_MASK);
  }
}

export function timelineSegmentMayMatch(
  index: Pick<TimelineSegmentSearchIndex, "sessionIds" | "types" | "bloom" | "complete">,
  sessionIds: ReadonlySet<string>,
  types: ReadonlySet<string> | null,
  query: string | undefined
): boolean {
  if (!index.complete) return true;
  if (sessionIds.size === 0 || ![...sessionIds].some(id => index.sessionIds.has(id))) return false;
  if (types && ![...types].some(type => index.types.has(type))) return false;
  if (!query || query.length < 3) return true;
  for (let offset = 0; offset + 2 < query.length; offset++) {
    const first = query.charCodeAt(offset);
    const second = query.charCodeAt(offset + 1);
    const third = query.charCodeAt(offset + 2);
    const hash = (Math.imul(first, 0x1f1f1f1f) ^ Math.imul(second, 0x45d9f3b) ^ Math.imul(third, 0x119de1f3)) >>> 0;
    if (!hasBit(index.bloom, hash & BLOOM_MASK)
      || !hasBit(index.bloom, Math.imul(hash, 0x9e3779b1) >>> 17 & BLOOM_MASK)
      || !hasBit(index.bloom, Math.imul(hash ^ 0x85ebca6b, 0xc2b2ae35) >>> 17 & BLOOM_MASK)
      || !hasBit(index.bloom, Math.imul(hash ^ 0x27d4eb2f, 0x165667b1) >>> 17 & BLOOM_MASK)) return false;
  }
  return true;
}

function setBit(bits: Uint8Array, offset: number): void { bits[offset >>> 3] = bits[offset >>> 3]! | (1 << (offset & 7)); }
function hasBit(bits: Uint8Array, offset: number): boolean { return (bits[offset >>> 3]! & (1 << (offset & 7))) !== 0; }
