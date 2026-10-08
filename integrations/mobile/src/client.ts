import { connectionFromCode, localFetcher, readLocalConnection } from "../../even-g2/src/local-fetch.mjs";
import { localOrigin, randomLocalHex, type LocalConnection } from "../../../src/shared/localLink.ts";
import type { CompanionAction, CompanionOverview, CompanionOverviewSession } from "../../../src/shared/companion.ts";

export type Session = CompanionOverviewSession;
export type Overview = CompanionOverview;
export type Action = Extract<CompanionAction, { type: "sessions.overview" | "session.read" | "session.reply" | "session.interrupt" | "session.rename" | "session.close" }>;
type Stored = { state: "pending" | "approved"; token: string; connection: LocalConnection };
type EncryptedTransport = ((input: string, options?: RequestInit) => Promise<Response>) & {
  connection(): LocalConnection;
};
const STORAGE_KEY = "canvastty.mobile.pairing.v1";

// The web companion may only talk to the host that served this secure page.
export function exactOrigin(value: string): string {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle)
    throw new Error("This browser requires a secure origin and Web Crypto. Use trusted private-network HTTPS, Tailscale Serve HTTPS, or USB reverse loopback.");
  const origin = localOrigin(value.trim(), true);
  const url = new URL(origin);
  const host = url.hostname.toLowerCase();
  const octets = host.split(".");
  const privateIpv4 = octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    (Number(octets[0]) === 10 ||
      (Number(octets[0]) === 192 && Number(octets[1]) === 168) ||
      (Number(octets[0]) === 172 && Number(octets[1]) >= 16 && Number(octets[1]) <= 31));
  const localHttp = url.protocol === "http:" && !!url.port &&
    (["127.0.0.1", "[::1]"].includes(host) || privateIpv4 || /^\[f[cd][0-9a-f:]+\]$/.test(host));
  const tailscaleHttps = url.protocol === "https:" &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(host);
  const privateHttps = url.protocol === "https:" &&
    (privateIpv4 || /^\[f[cd][0-9a-f:]+\]$/.test(host));
  if (value.trim() !== origin || origin !== location.origin ||
    !(tailscaleHttps || privateHttps || localHttp))
    throw new Error("Use this page's exact Tailscale HTTPS, trusted private-network HTTPS, or USB loopback origin.");
  return origin;
}

export function loadSaved(): Stored | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Stored;
    if (parsed.state !== "pending" && parsed.state !== "approved") throw new Error("invalid-state");
    const origin = exactOrigin(location.origin);
    const saved = readLocalConnection(JSON.stringify(parsed), origin.startsWith("http:"));
    if (!saved.connection.origins.includes(origin)) throw new Error("different-host");
    return { ...saved, connection: { ...saved.connection, origins: [origin] }, state: parsed.state };
  } catch {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
    return null;
  }
}
export function savePairing(value: Stored): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}
export function forgetPairing(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export class CompanionClient {
  private readonly stored: Stored;
  private send: EncryptedTransport;
  constructor(stored: Stored) {
    this.stored = stored;
    this.send = localFetcher(stored.connection, { allowLoopback: exactOrigin(location.origin).startsWith("http:") });
  }
  get state(): Stored["state"] {
    return this.stored.state;
  }
  snapshot(): Stored {
    return { ...this.stored, connection: this.send.connection() };
  }
  async raw(path: string, options: RequestInit = {}): Promise<unknown> {
    const response = await this.send(path, {
      ...options,
      headers: { ...(options.headers as Record<string, string> || {}), Authorization: "Bearer " + this.stored.token },
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = typeof body === "object" && body && "error" in body ? String(body.error) : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body;
  }
  async action<T>(action: Action, signal?: AbortSignal): Promise<T> {
    const response = await this.raw("/g2/api/mobile", {
      method: "POST",
      body: JSON.stringify({ version: 1, id: randomLocalHex(16), sentAt: Date.now(), action }),
      headers: { "Content-Type": "application/json" },
      signal,
    });
    return response as T;
  }
  async approval(signal?: AbortSignal): Promise<"pending" | "approved" | "rejected"> {
    const response = await this.raw("/g2/api/pair-status", { signal }) as { state: "pending" | "approved" | "rejected" };
    return response.state;
  }
}

export async function startPairing(originInput: string, code: string, signal: AbortSignal): Promise<CompanionClient> {
  const origin = exactOrigin(originInput);
  if (!/^\d{6}$/.test(code)) throw new Error("Enter the six-digit code shown by CanvasTTY.");
  let connection: LocalConnection;
  try {
    ({ connection } = await connectionFromCode(code, { origins: [origin], signal, allowLoopback: origin.startsWith("http:") }));
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Cannot reach CanvasTTY to pair. Check the desktop pairing code and confirm this trusted HTTPS, Tailscale Serve, or USB address is reachable.");
  }
  if (!connection.origins.includes(origin)) throw new Error("Pairing host changed.");
  const send = localFetcher({ ...connection, origins: [origin] }, { allowLoopback: origin.startsWith("http:") });
  const response = await send("/g2/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    signal,
  });
  if (response.status !== 202) throw new Error("Pairing was not accepted. Request a new code on the desktop.");
  const pending = await response.json() as { token: string; state: string };
  if (pending.state !== "pending" || !/^[a-f0-9]{64}$/.test(pending.token))
    throw new Error("Invalid pairing response.");
  const stored: Stored = { state: "pending", token: pending.token, connection: { ...send.connection(), origins: [origin] } };
  savePairing(stored); // A refresh while desktop approval is pending must not start another pairing attempt.
  return new CompanionClient(stored);
}

export function markApproved(client: CompanionClient): CompanionClient {
  const stored: Stored = { ...client.snapshot(), state: "approved" };
  savePairing(stored);
  return new CompanionClient(stored);
}
