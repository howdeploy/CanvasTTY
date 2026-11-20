import { randomUUID } from 'node:crypto';
import type { DuoDiagnosticEvent, DuoDiagnosticReport } from '../../shared/duoDiagnostics.ts';

// Never copy arbitrary errors: DHT/HTTP errors can contain endpoints, while a
// remote peer can supply arbitrary error text. Only fixed local codes leave here.
export function duoFailureCode(error: unknown): string {
  const value = error as {code?:unknown;cause?:{code?:unknown}} | null;
  const code = value?.code ?? value?.cause?.code;
  if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EADDRINUSE', 'EACCES', 'EPERM', 'ENOTFOUND', 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'ERR_DHT_BOOTSTRAP', 'PEER_NOT_FOUND', 'HOLEPUNCH_FAILED', 'BAD_HANDSHAKE_REPLY', 'BAD_HOLEPUNCH_REPLY', 'HOLEPUNCH_ABORTED', 'HOLEPUNCH_INVALID', 'HOLEPUNCH_PROBE_TIMEOUT', 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS', 'CANNOT_HOLEPUNCH', 'REMOTE_NOT_HOLEPUNCHING', 'REMOTE_NOT_HOLEPUNCHABLE', 'REMOTE_ABORTED', 'HANDSHAKE_UNFINISHED', 'HANDSHAKE_INVALID', 'NODE_DESTROYED', 'PEER_CONNECTION_FAILED', 'STREAM_NOT_CONNECTED', 'SERVER_INCOMPATIBLE', 'SERVER_ERROR', 'DUPLICATE_CONNECTION', 'SUSPENDED'].includes(code)) return code;
  const message = error instanceof Error ? error.message : '';
  return new Map([
    ['Cannot establish a direct Duo connection on this network.', 'DIRECT_CONNECT_TIMEOUT'],
    ['Duo request timed out; delivery is uncertain.', 'RPC_TIMEOUT'],
    ['Duo invitation rejected or expired.', 'INVITATION_REJECTED'],
    ['Duo peer disconnected.', 'PEER_DISCONNECTED'],
    ['Duo is disconnected.', 'DISCONNECTED'],
    ['Duo connection closed.', 'DISCONNECTED'],
    ['Duo connection cancelled.', 'CANCELLED'],
    ['Duo session changed.', 'SESSION_CHANGED'],
    ['Duo request queue is full.', 'QUEUE_FULL'],
    ['Duo connection busy.', 'BUSY'],
    ['Invalid Canvas Duo invitation.', 'INVALID_INVITATION'],
    ['Invalid Duo snapshot.', 'INVALID_RESPONSE'],
    ['Unsupported state or unable to authenticate data', 'AUTHENTICATION_FAILED']
  ]).get(message) ?? 'UNKNOWN';
}

export type DuoTrace = (stage: 'dht-error' | 'listen-start' | 'listening' | 'connect-start' | 'encrypted-open' | 'socket-error' | 'socket-closed' | 'transport-failed' | 'rpc-timeout', error?: unknown) => void;

/** Bounded local flight recorder. Contains metadata only; no payload or endpoint. */
export class DuoDiagnostics {
  private events: DuoDiagnosticEvent[] = [];
  private readonly sink?: (event: DuoDiagnosticEvent) => void;
  constructor(sink?: (event: DuoDiagnosticEvent) => void) { this.sink=sink; }

  begin(role: DuoDiagnosticEvent['role'], transport: DuoDiagnosticEvent['transport']): DuoTrace & { record(stage: string, error?: unknown): void } {
    const attempt = randomUUID();
    const started = performance.now();
    let previous = '', previousAt = 0;
    const record = (stage: string, error?: unknown): void => {
      const code = error === undefined ? undefined : duoFailureCode(error);
      const signature = `${stage}:${code ?? ''}`, now = performance.now();
      if (previous === signature && now - previousAt < 5000) return;
      previous = signature; previousAt = now;
      const event: DuoDiagnosticEvent = { at: new Date().toISOString(), attempt, role, transport, stage, elapsedMs: Math.round(now - started), ...(code ? { code } : {}) };
      this.events.push(event);
      if (this.events.length > 200) this.events.shift();
      // Logging must never prevent connecting, stopping, or releasing controls.
      try { this.sink?.({ ...event }); } catch { /* optional storage unavailable */ }
    };
    record('attempt-start');
    return Object.assign(record, { record });
  }

  report(): DuoDiagnosticReport { return { formatVersion: 1, events: this.events.map(event => ({ ...event })) }; }
}
