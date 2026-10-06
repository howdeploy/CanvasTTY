import { isAbsolute } from "node:path";
import type {
  HandoffDeliveryState,
  HandoffPasteNote,
  MaterialHandoff,
  MaterialKind,
  MaterialOrigin,
  MaterialRemark,
  MaterialVersionReason,
  Point,
  ProviderId,
  RemarkAnchor,
  RemarkStatus,
  RemarkTarget,
  Size
} from "../../../shared/contracts";
import {
  clampSize,
  HANDOFF_NOTE_LIMIT,
  MATERIAL_LIMIT,
  MATERIAL_VERSION_LIMIT,
  REMARK_TEXT_LIMIT
} from "../../../shared/materials.ts";

export const MATERIAL_STATE_VERSION = 1;
export const REMARK_LIMIT = 2_000;
export const HANDOFF_LIMIT = 200;
export const HANDOFF_REMARK_LIMIT = 50;

const KINDS: Record<MaterialKind, true> = { image: true, text: true, video: true, audio: true, pdf: true, file: true };
const VERSION_REASONS: ReadonlySet<MaterialVersionReason> = new Set(["pinned", "remark", "capture", "edit"]);
const REMARK_STATUSES: ReadonlySet<RemarkStatus> = new Set(["open", "sent", "reported", "accepted", "reopened"]);
const DELIVERY_STATES: ReadonlySet<HandoffDeliveryState> = new Set(["sending", "submitted", "pasted", "failed"]);
const PASTE_NOTES: ReadonlySet<HandoffPasteNote> = new Set(["not-seen", "not-observed", "enter-failed"]);
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ID_PATTERN = /^[a-f0-9-]{36}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_ELEMENT_ROLE = 60;
export const MAX_ELEMENT_NAME = 200;
export const MAX_SESSION_ID = 120;
const MAX_NAME = 255;
const MAX_URL = 2_048;
const MAX_TITLE = 300;
const MAX_LINE = 10_000_000;
const MAX_TIME = 7 * 24 * 60 * 60;
const MAX_PAGE = 100_000;
const MAX_COUNT = 1_000_000_000;
const MIME_PATTERN = /^[a-z]+\/[a-z0-9.+-]+$/;

export interface StoredVersion {
  id: string;
  number: number;
  sha256: string;
  byteSize: number;
  mimeType: string;
  createdAt: number;
  reason: MaterialVersionReason;
  signature: string | null;
  natural: Size | null;
}

export interface StoredFileIdentity {
  dev: string;
  ino: string;
}

export interface StoredMaterial {
  id: string;
  kind: MaterialKind;
  name: string;
  mimeType: string;
  position: Point;
  size: Size;
  path: string | null;
  identity: StoredFileIdentity | null;
  origin: MaterialOrigin | null;
  createdAt: number;
  versions: StoredVersion[];
  nextVersion: number;
}

export interface StoredMaterialState {
  version: typeof MATERIAL_STATE_VERSION;
  materials: StoredMaterial[];
  remarks: MaterialRemark[];
  handoffs: MaterialHandoff[];
  counters: { remark: number; handoff: number };
}

export function emptyMaterialState(): StoredMaterialState {
  return { version: MATERIAL_STATE_VERSION, materials: [], remarks: [], handoffs: [], counters: { remark: 0, handoff: 0 } };
}

export function restoreMaterialState(candidate: unknown): StoredMaterialState {
  if (!isRecord(candidate) || candidate.version !== MATERIAL_STATE_VERSION || !Array.isArray(candidate.materials)) {
    throw new Error("Unsupported materials state.");
  }
  const migrated = { ...candidate, materials: migrateLegacyIdentities(candidate.materials) };
  const state = normalizeMaterialState(migrated);
  if (!preservesStoredFields(migrated, state)) throw new Error("Invalid materials state.");
  return state;
}

function migrateLegacyIdentities(materials: unknown[]): unknown[] {
  return materials.map((material) => {
    if (!isRecord(material) || !isRecord(material.identity)) return material;
    const identity = material.identity;
    const keys = Object.keys(identity);
    if (keys.length !== 2 || keys.some((key) => key !== "dev" && key !== "ino")
      || ![identity.dev, identity.ino].every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0)) {
      return material;
    }
    return {
      ...material,
      identity: Number.isSafeInteger(identity.dev) && Number.isSafeInteger(identity.ino)
        ? { dev: String(identity.dev), ino: String(identity.ino) }
        : null
    };
  });
}

function preservesStoredFields(stored: unknown, normalized: unknown): boolean {
  if (Array.isArray(stored)) {
    if (!Array.isArray(normalized) || stored.length !== normalized.length) return false;
    const byId = new Map(normalized.filter(isRecord).map((entry) => [entry.id, entry]));
    return stored.every((entry, index) => preservesStoredFields(entry,
      isRecord(entry) && typeof entry.id === "string" ? byId.get(entry.id) : normalized[index]));
  }
  if (isRecord(stored)) {
    return isRecord(normalized) && Object.keys(stored).every((key) =>
      Object.hasOwn(normalized, key) && preservesStoredFields(stored[key], normalized[key]));
  }
  return normalized !== undefined && (stored === null || normalized !== null);
}

export function normalizeMaterialState(candidate: unknown): StoredMaterialState {
  const state = emptyMaterialState();
  if (!isRecord(candidate) || candidate.version !== MATERIAL_STATE_VERSION || !Array.isArray(candidate.materials)) {
    return state;
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const value of candidate.materials) {
    if (state.materials.length >= MATERIAL_LIMIT) break;
    const material = normalizeMaterial(value);
    if (!material || ids.has(material.id) || (material.path !== null && paths.has(material.path))) continue;
    ids.add(material.id);
    if (material.path !== null) paths.add(material.path);
    state.materials.push(material);
  }
  const remarkIds = new Set<string>();
  if (Array.isArray(candidate.remarks)) {
    for (const value of candidate.remarks) {
      if (state.remarks.length >= REMARK_LIMIT) break;
      const remark = normalizeRemark(value);
      if (!remark || remarkIds.has(remark.id) || !ids.has(remark.target.materialId)) continue;
      remarkIds.add(remark.id);
      state.remarks.push(remark);
    }
  }
  if (Array.isArray(candidate.handoffs)) {
    const handoffIds = new Set<string>();
    for (const value of candidate.handoffs.slice(-HANDOFF_LIMIT)) {
      const handoff = normalizeHandoff(value);
      if (!handoff || handoffIds.has(handoff.id)) continue;
      handoffIds.add(handoff.id);
      state.handoffs.push(handoff);
    }
  }
  const counters = isRecord(candidate.counters) ? candidate.counters : {};
  state.counters = {
    remark: Math.max(counterValue(counters.remark), ...state.remarks.map((remark) => remark.number)),
    handoff: Math.max(counterValue(counters.handoff), ...state.handoffs.map((handoff) => handoff.number))
  };
  return state;
}

export function normalizeAnchor(value: unknown): RemarkAnchor | null {
  if (!isRecord(value)) return null;
  if (value.kind === "whole") return { kind: "whole" };
  if (value.kind === "point" && isUnit(value.x) && isUnit(value.y)) return { kind: "point", x: value.x, y: value.y };
  if (value.kind === "region" && isUnit(value.x) && isUnit(value.y) && isUnit(value.width) && isUnit(value.height)
    && value.width > 0 && value.height > 0 && value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001) {
    return { kind: "region", x: value.x, y: value.y, width: value.width, height: value.height };
  }
  if (value.kind === "page" && isPageNumber(value.page)) return { kind: "page", page: value.page };
  if (value.kind === "time" && isMediaTime(value.start) && (value.end === null || (isMediaTime(value.end) && value.end > value.start))) {
    return { kind: "time", start: value.start, end: value.end };
  }
  if (value.kind === "lines" && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
    && (value.start as number) >= 1 && (value.end as number) >= (value.start as number) && (value.end as number) <= MAX_LINE) {
    return { kind: "lines", start: value.start as number, end: value.end as number };
  }
  return null;
}

function normalizeTarget(value: unknown): RemarkTarget | null {
  if (!isRecord(value) || !isId(value.materialId) || !isId(value.versionId)) return null;
  const anchor = normalizeAnchor(value.anchor);
  return anchor ? { materialId: value.materialId, versionId: value.versionId, anchor } : null;
}

function normalizeRemark(value: unknown): MaterialRemark | null {
  if (!isRecord(value) || !isId(value.id) || !isCount(value.number)) return null;
  const target = normalizeTarget(value.target);
  const reference = value.reference === null ? null : normalizeTarget(value.reference);
  if (!target || (value.reference !== null && !reference)) return null;
  if (typeof value.text !== "string" || value.text.length > REMARK_TEXT_LIMIT) return null;
  if (typeof value.status !== "string" || !REMARK_STATUSES.has(value.status as RemarkStatus)) return null;
  if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt)) return null;
  const handoffIds = Array.isArray(value.handoffIds) ? value.handoffIds.filter(isId).slice(-HANDOFF_LIMIT) : [];
  const report = isRecord(value.report) && isId(value.report.handoffId) && isFiniteNumber(value.report.at)
    ? {
        handoffId: value.report.handoffId,
        at: value.report.at,
        note: typeof value.report.note === "string" ? value.report.note.slice(0, REMARK_TEXT_LIMIT) : null
      }
    : null;
  return {
    id: value.id,
    number: value.number,
    target,
    reference,
    text: value.text,
    status: value.status as RemarkStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    handoffIds,
    report
  };
}

function normalizeHandoff(value: unknown): MaterialHandoff | null {
  if (!isRecord(value) || !isId(value.id) || !isCount(value.number)) return null;
  if (!isFiniteNumber(value.createdAt) || typeof value.sessionId !== "string" || value.sessionId.length > MAX_SESSION_ID) return null;
  if (typeof value.sessionTitle !== "string" || typeof value.provider !== "string" || !PROVIDER_PATTERN.test(value.provider)) return null;
  if (!Array.isArray(value.remarkIds) || typeof value.note !== "string" || typeof value.folder !== "string" || !isAbsolute(value.folder)) return null;
  if (value.resultsFolder !== null && (typeof value.resultsFolder !== "string" || !isAbsolute(value.resultsFolder))) return null;
  const delivery = isRecord(value.delivery) ? value.delivery : null;
  if (!delivery || typeof delivery.state !== "string" || !DELIVERY_STATES.has(delivery.state as HandoffDeliveryState)) return null;
  const items = Array.isArray(value.items) ? value.items.flatMap((item) => (
    isRecord(item) && isId(item.materialId) && (item.versionId === null || isId(item.versionId)) && typeof item.editable === "boolean"
      ? [{ materialId: item.materialId, versionId: item.versionId as string | null, editable: item.editable }]
      : []
  )).slice(0, HANDOFF_REMARK_LIMIT * 2) : [];
  const state = delivery.state === "sending" ? "failed" : delivery.state as HandoffDeliveryState;
  return {
    id: value.id,
    number: value.number,
    createdAt: value.createdAt,
    sessionId: value.sessionId,
    sessionTitle: value.sessionTitle.slice(0, MAX_TITLE),
    provider: value.provider as ProviderId,
    remarkIds: value.remarkIds.filter(isId).slice(0, HANDOFF_REMARK_LIMIT),
    items,
    note: value.note.slice(0, HANDOFF_NOTE_LIMIT),
    folder: value.folder,
    resultsFolder: value.resultsFolder as string | null,
    sessionStartedAt: isFiniteNumber(value.sessionStartedAt) ? value.sessionStartedAt : null,
    delivery: {
      state,
      imagesExpected: counterValue(delivery.imagesExpected),
      imagesAttached: counterValue(delivery.imagesAttached),
      sentAt: isFiniteNumber(delivery.sentAt) ? delivery.sentAt : null,
      turnStartedAt: isFiniteNumber(delivery.turnStartedAt) ? delivery.turnStartedAt : null,
      turnEndedAt: isFiniteNumber(delivery.turnEndedAt) ? delivery.turnEndedAt : null,
      note: state === "pasted" && typeof delivery.note === "string" && PASTE_NOTES.has(delivery.note as HandoffPasteNote)
        ? delivery.note as HandoffPasteNote
        : null,
      error: delivery.state === "sending"
        ? "CanvasTTY closed while sending."
        : typeof delivery.error === "string" ? delivery.error.slice(0, 500) : null,
      stateSaved: delivery.stateSaved !== false
    }
  };
}

function counterValue(value: unknown): number {
  return isCount(value) ? value : 0;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_COUNT;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isUnit(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function normalizeMaterial(value: unknown): StoredMaterial | null {
  if (!isRecord(value)) return null;
  const { id, kind, name, mimeType, position, size, path, identity, origin, createdAt, versions, nextVersion } = value;
  if (!isId(id)) return null;
  if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind)) return null;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME) return null;
  if (typeof mimeType !== "string" || !MIME_PATTERN.test(mimeType)) return null;
  if (!isPoint(position) || !isSize(size)) return null;
  if (path !== null && (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))) return null;
  if (!isFiniteNumber(createdAt)) return null;
  const storedVersions = normalizeVersions(versions);
  if (path === null && storedVersions.length === 0) return null;
  const highest = storedVersions.reduce((max, version) => Math.max(max, version.number), 0);
  return {
    id,
    kind: kind as MaterialKind,
    name,
    mimeType,
    position: { x: position.x, y: position.y },
    size: clampSize(size),
    path,
    identity: normalizeIdentity(identity),
    origin: normalizeOrigin(origin),
    createdAt,
    versions: storedVersions,
    nextVersion: Math.max(highest + 1, isCount(nextVersion) ? nextVersion : 1)
  };
}

function normalizeVersions(value: unknown): StoredVersion[] {
  if (!Array.isArray(value)) return [];
  const versions: StoredVersion[] = [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const candidate of value) {
    if (versions.length >= MATERIAL_VERSION_LIMIT) break;
    if (!isRecord(candidate)) continue;
    const { id, number, sha256, byteSize, mimeType, createdAt, reason, signature, natural } = candidate;
    if (!isId(id) || ids.has(id)) continue;
    if (!isCount(number) || numbers.has(number)) continue;
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) continue;
    if (!Number.isSafeInteger(byteSize) || (byteSize as number) < 0) continue;
    if (typeof mimeType !== "string" || !MIME_PATTERN.test(mimeType)) continue;
    if (!isFiniteNumber(createdAt)) continue;
    if (typeof reason !== "string" || !VERSION_REASONS.has(reason as MaterialVersionReason)) continue;
    ids.add(id);
    numbers.add(number);
    versions.push({
      id,
      number,
      sha256,
      byteSize: byteSize as number,
      mimeType,
      createdAt,
      reason: reason as MaterialVersionReason,
      signature: typeof signature === "string" && signature.length <= 200 ? signature : null,
      natural: isSize(natural) ? { width: natural.width, height: natural.height } : null
    });
  }
  return versions.sort((left, right) => left.number - right.number);
}

function normalizeIdentity(value: unknown): StoredFileIdentity | null {
  if (!isRecord(value) || !isFileNumber(value.dev) || !isFileNumber(value.ino)) return null;
  return { dev: value.dev, ino: value.ino };
}

function isFileNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

export function normalizeOrigin(value: unknown): MaterialOrigin | null {
  if (!isRecord(value)) return null;
  if (value.kind === "clipboard") return { kind: "clipboard" };
  if (value.kind === "watch" && typeof value.folderName === "string" && value.folderName.length <= MAX_NAME) {
    return { kind: "watch", folderName: value.folderName };
  }
  if (value.kind === "browser" && typeof value.url === "string" && value.url.length <= MAX_URL
    && typeof value.title === "string" && isSize(value.viewport)) {
    return {
      kind: "browser",
      url: value.url,
      title: value.title.slice(0, MAX_TITLE),
      viewport: { width: value.viewport.width, height: value.viewport.height }
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isMediaTime(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_TIME;
}

export function isPageNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PAGE;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is Point {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isSize(value: unknown): value is Size {
  return isRecord(value) && isFiniteNumber(value.width) && isFiniteNumber(value.height)
    && value.width > 0 && value.height > 0;
}
