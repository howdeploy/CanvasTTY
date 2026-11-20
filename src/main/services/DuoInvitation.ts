import {parseDuoInvite} from './CanvasDuoService';
let pending: string | undefined;
export function acceptDuoInvitation(raw: unknown): boolean {
  try { parseDuoInvite(raw); pending=raw as string; return true; } catch { return false; }
}
export function takeDuoInvitation(): string | undefined { const value=pending;pending=undefined;return value; }
