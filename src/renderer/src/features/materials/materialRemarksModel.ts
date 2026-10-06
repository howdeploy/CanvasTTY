import type {
  HandoffBlock,
  HandoffDelivery,
  HandoffPasteNote,
  LocaleId,
  MaterialFailure,
  MaterialHandoff,
  MaterialRemark,
  Point,
  RemarkAnchor,
  RemarkStatus,
  Size
} from "../../../../shared/contracts.ts";
import { isAreaAnchor } from "../../../../shared/materials.ts";
import { t } from "../../lib/i18n.ts";

export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const POINT_DRAG_THRESHOLD = 6;

export function containedRect(box: Size, natural: Size | null): BoxRect {
  if (!natural || !(natural.width > 0) || !(natural.height > 0) || !(box.width > 0) || !(box.height > 0)) {
    return { left: 0, top: 0, width: box.width, height: box.height };
  }
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

export function dragAnchor(start: Point, end: Point, rect: BoxRect): RemarkAnchor | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const x0 = round(clamp((start.x - rect.left) / rect.width));
  const y0 = round(clamp((start.y - rect.top) / rect.height));
  const x1 = round(clamp((end.x - rect.left) / rect.width));
  const y1 = round(clamp((end.y - rect.top) / rect.height));
  if (Math.abs(end.x - start.x) < POINT_DRAG_THRESHOLD && Math.abs(end.y - start.y) < POINT_DRAG_THRESHOLD) {
    return { kind: "point", x: round(x0), y: round(y0) };
  }
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  if (width <= 0 || height <= 0) {
    const startInside = start.x >= rect.left && start.x <= rect.left + rect.width
      && start.y >= rect.top && start.y <= rect.top + rect.height;
    if (!startInside) return null;
    return { kind: "point", x: round(x0), y: round(y0) };
  }
  return { kind: "region", x, y, width: round(width), height: round(height) };
}

export function anchorPercentages(anchor: RemarkAnchor): { left: string; top: string; width?: string; height?: string } | null {
  if (!isAreaAnchor(anchor)) return null;
  if (anchor.kind === "point") return { left: pct(anchor.x), top: pct(anchor.y) };
  return { left: pct(anchor.x), top: pct(anchor.y), width: pct(anchor.width), height: pct(anchor.height) };
}

export function referenceCounts(remarks: readonly MaterialRemark[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const remark of remarks) {
    const id = remark.reference?.materialId;
    if (id && id !== remark.target.materialId) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export function remarksByMaterial(remarks: readonly MaterialRemark[]): Map<string, MaterialRemark[]> {
  const grouped = new Map<string, MaterialRemark[]>();
  for (const remark of [...remarks].sort((left, right) => left.number - right.number)) {
    grouped.set(remark.target.materialId, [...(grouped.get(remark.target.materialId) ?? []), remark]);
  }
  return grouped;
}

export function remarkStatusClass(status: RemarkStatus): string {
  return `material-remark-status material-remark-status--${status}`;
}

export function remarkAnchorLabel(anchor: RemarkAnchor, locale: LocaleId): string {
  switch (anchor.kind) {
    case "lines": return `${t(locale, "remarkAnchorLines")} ${anchor.start === anchor.end ? anchor.start : `${anchor.start}–${anchor.end}`}`;
    case "page": return `${t(locale, "remarkAnchorPage")} ${anchor.page}`;
    case "time": return `${t(locale, "remarkAnchorTime")} ${anchor.end === null ? formatClock(anchor.start) : `${formatClock(anchor.start)}–${formatClock(anchor.end)}`}`;
    case "region": return t(locale, "remarkAnchorRegion");
    case "point": return t(locale, "remarkAnchorPoint");
    case "whole": return t(locale, "remarkAnchorWhole");
  }
}

export function remarkNeedsWork(remark: MaterialRemark): boolean {
  return remark.status === "open" || remark.status === "reopened";
}

export function remarkAnchorKey(anchor: RemarkAnchor): string {
  return JSON.stringify(anchor);
}

export function remarkDraftWithoutLostMaterials<T extends { materialId: string; reference: { materialId: string } | null; picking: boolean }>(
  draft: T,
  present: ReadonlySet<string>
): T | null {
  if (!present.has(draft.materialId)) return null;
  if (draft.reference && !present.has(draft.reference.materialId)) return { ...draft, reference: null, picking: false };
  return draft;
}

export function remarkStatusKey(status: RemarkStatus): "remarkStatusOpen" | "remarkStatusSent" | "remarkStatusReported"
  | "remarkStatusAccepted" | "remarkStatusReopened" {
  switch (status) {
    case "open": return "remarkStatusOpen";
    case "sent": return "remarkStatusSent";
    case "reported": return "remarkStatusReported";
    case "accepted": return "remarkStatusAccepted";
    default: return "remarkStatusReopened";
  }
}

export function latestHandoff(handoffs: readonly MaterialHandoff[], remark: MaterialRemark): MaterialHandoff | null {
  const id = remark.handoffIds.at(-1);
  return id ? handoffs.find((handoff) => handoff.id === id) ?? null : null;
}

export type DeliveryKey = "deliverySending" | "deliverySubmitted" | "deliveryPasted" | "deliveryFailed"
  | "deliveryTurnStarted" | "deliveryTurnEnded";

export type PasteNoteKey = "handoffPastedNotSeen" | "handoffPastedNotObserved" | "handoffPastedEnterFailed" | "handoffPastedSessionGone";

export function pasteNoteKey(note: HandoffPasteNote | null, sessionGone = false): PasteNoteKey {
  if (sessionGone) return "handoffPastedSessionGone";
  if (note === "not-observed") return "handoffPastedNotObserved";
  if (note === "enter-failed") return "handoffPastedEnterFailed";
  return "handoffPastedNotSeen";
}

export function deliveryKey(delivery: HandoffDelivery): DeliveryKey {
  if (delivery.state === "sending") return "deliverySending";
  if (delivery.state === "failed") return "deliveryFailed";
  if (delivery.state === "pasted") return "deliveryPasted";
  if (delivery.turnEndedAt !== null) return "deliveryTurnEnded";
  if (delivery.turnStartedAt !== null) return "deliveryTurnStarted";
  return "deliverySubmitted";
}

export type HandoffReasonKey =
  | "handoffBlockNoSession"
  | "handoffBlockNotAgent"
  | "handoffBlockExited"
  | "handoffBlockStarting"
  | "handoffBlockBusy"
  | "handoffBlockApproval"
  | "handoffBlockRemote"
  | "handoffBlockComposer"
  | "handoffBlockAlreadySent"
  | "handoffBlockNoRemarks"
  | "handoffBlockTooMany"
  | "handoffBlockTooLong"
  | "handoffBlockUnavailable";

export function handoffReasonKey(reason: HandoffBlock | MaterialFailure): HandoffReasonKey {
  switch (reason) {
    case "no-session": return "handoffBlockNoSession";
    case "not-an-agent": return "handoffBlockNotAgent";
    case "exited": return "handoffBlockExited";
    case "starting": return "handoffBlockStarting";
    case "busy": return "handoffBlockBusy";
    case "needs-approval": return "handoffBlockApproval";
    case "remote-environment": return "handoffBlockRemote";
    case "composer-not-ready": return "handoffBlockComposer";
    case "already-sent": return "handoffBlockAlreadySent";
    case "no-remarks": return "handoffBlockNoRemarks";
    case "too-many-remarks": return "handoffBlockTooMany";
    case "too-long": return "handoffBlockTooLong";
    default: return "handoffBlockUnavailable";
  }
}

function formatClock(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const hours = Math.floor(tenths / 36_000);
  const minutes = Math.floor((tenths % 36_000) / 600);
  const whole = Math.floor((tenths % 600) / 10);
  const fraction = tenths % 10;
  const rest = `${String(whole).padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function pct(value: number): string {
  return `${round(value * 100)}%`;
}

export type RemarkMode = "view" | "draw" | "pick";

export interface RemarkDraftState {
  materialId: string;
  anchor: RemarkAnchor | null;
  reference: { materialId: string; anchor: RemarkAnchor } | null;
  picking: boolean;
}

export interface MaterialRemarking {
  remarks: MaterialRemark[];
  referencedBy: number;
  mode: RemarkMode;
  draftAnchor: RemarkAnchor | null;
  referenceAnchor: RemarkAnchor | null;
  selectedRemarkId: string | null;
}

export interface MaterialRemarkActions {
  start(materialId: string, anchor: RemarkAnchor | null): void;
  draw(materialId: string, anchor: RemarkAnchor): void;
  cancel(): void;
  pickReference(): void;
  clearReference(): void;
  save(text: string): Promise<boolean>;
  select(remarkId: string | null): void;
  act(remarkId: string, action: "delete" | "send"): void;
  send(materialId: string): void;
}

export function failureToastKey(reason: MaterialFailure): string | null {
  switch (reason) {
    case "version-limit": return "materialVersionLimit";
    case "remark-limit": return "materialRemarkLimit";
    case "too-large": return "materialTooLarge";
    case "quota": return "materialQuota";
    case "material-limit": return "materialLimit";
    default: return "materialUnavailable";
  }
}
