import type { SessionBounds, SessionMetadata } from "./contracts";
import type { DuoSurfaceFrame, DuoSurfaceInput } from "./duoSurface";
import type { DuoDocument, DuoDocumentOp } from './duoDocument';
export const DUO_CURSOR_DESIGNS = ["blob", "circle", "triangle", "square", "diamond", "capsule", "cloud", "star", "hexagon", "heart"] as const;
export type DuoCursorDesign = typeof DUO_CURSOR_DESIGNS[number];

export function normalizeDuoCursorDesign(value: unknown): DuoCursorDesign | undefined {
  return DUO_CURSOR_DESIGNS.find(design => design === value);
}

export const DUO_CURSOR_NICKNAME_MAX_LENGTH = 24;

export function normalizeDuoCursorNickname(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const nickname = value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "").trim();
  return nickname.length <= DUO_CURSOR_NICKNAME_MAX_LENGTH ? nickname || undefined : undefined;
}

export interface DuoCard {
  id: string;
  title: string;
  provider: string;
  running: boolean;
  control: boolean;
  text?: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  revision?: number;
  nativeEditor?: SessionMetadata["nativeEditor"];
  output?: { buffer: string; outputOffset: number; startOffset?: number; restorePrefix?: string; cols: number; rows: number };
}
export interface DuoComment { id: string; cardId: string; author: string; text: string; at: number }
export interface DuoCursor { cardId: string; x: number; y: number; at: number; author: string; design?: DuoCursorDesign; nickname?: string }
export interface DuoSnapshot {
  /** Partial acknowledgements never replace the visible workspace. */
  partial?: boolean;
  /** Complete card metadata, with only changed output/document payloads. */
  incremental?: boolean;
  documentVersion?: string;
  documentPage?: { id: string; length: number };
  documentSync?: boolean;
  document?: DuoDocument;
  result?: unknown;
  surface?: DuoSurfaceFrame; fullCanvas?: boolean; sequence?: number; cards: DuoCard[]; comments: DuoComment[]; cursors: DuoCursor[]; expiresAt: number; workspaceId?: string; manage?: boolean; createdId?: string }
export interface DuoState {
  role: "idle" | "host" | "guest";
  invites: string[];
  expiresAt: number;
  available: DuoCard[];
  selected: string[];
  controlled: string[];
  peer: boolean;
  status?: "idle" | "waiting" | "connected" | "disconnected";
  workspaceId?: string;
  manage?: boolean;
  fullCanvas?: boolean;
  documentSync?: boolean;
  connection?: {mode:"direct";remoteHost:string;remotePort:number};
}
export type DuoCommand =
  | { action: "state" }
  | { action: "invitation" }
  | { action: "host"; selected: string[]; controlled: string[]; manage?: boolean; fullCanvas?: boolean; documentSync?: boolean; transport?: "p2p" | "lan" }
  | { action: "select"; selected: string[]; controlled: string[]; manage?: boolean }
  | { action: "join"; invite: string }
  | { action: "stop" }
  | { action: "snapshot" }
  | { action: "updates"; outputOffsets: Record<string, number>; documentVersion?: string }
  | { action: 'document-edit'; ops: DuoDocumentOp[] }
  | { action: 'resource'; channel: string; args: unknown[] }
  | { action: "surface" }
  | { action: "surface-action"; name:"terminal"|"note"|"home" }
  | { action: "surface-input"; frameId: string; events: DuoSurfaceInput[] }
  | { action: "input"; cardId: string; text: string }
  | { action: 'file-open' | 'file-can-open'; cardId:string; text:string }
  | { action: "comment"; cardId: string; text: string }
  | { action: "create"; x: number; y: number }
  | { action: "bounds"; cardId: string; bounds: SessionBounds }
  | { action: "rename"; cardId: string; text: string }
  | { action: "close"; cardId: string }
  | { action: "resize"; cardId: string; cols: number; rows: number }
  | { action: "cursor"; cardId: string; x: number; y: number; design?: DuoCursorDesign; nickname?: string };
export interface DuoReply { state: DuoState; snapshot?: DuoSnapshot; invitation?: string; error?: string }

/** Merge wire deltas without losing terminal history, documents or deleted cards. */
export function mergeDuoSnapshot(previous: DuoSnapshot | undefined, next: DuoSnapshot): DuoSnapshot {
  if (!previous) return next;
  if (next.partial) return { ...previous, manage: next.manage, expiresAt: next.expiresAt, cards:previous.cards.map(card=>previous.documentSync?{...card,control:next.manage===true}:card) };
  if ((next.sequence ?? 0) < (previous.sequence ?? 0)) return previous;
  if (!next.incremental) return next;
  const cards = next.cards.map(card => {
    const old = previous.cards.find(item => item.id === card.id);
    let output = card.output ?? old?.output;
    if (card.output && old?.output && card.output.startOffset !== undefined) {
      const start = card.output.startOffset;
      const oldStart = old.output.outputOffset - old.output.buffer.length;
      if (start >= oldStart && start <= old.output.outputOffset) {
        output = { ...card.output, buffer: (old.output.buffer.slice(0, start - oldStart) + card.output.buffer).slice(-32768), restorePrefix: card.output.restorePrefix ?? old.output.restorePrefix };
      }
    }
    return { ...card, ...(output ? { output } : {}) };
  });
  return { ...next, cards, document: next.document ?? previous.document, documentVersion: next.documentVersion ?? previous.documentVersion };
}
