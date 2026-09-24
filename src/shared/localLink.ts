/** Local-only encrypted connection. No remote service or account. */
export const LOCAL_LINK_LIMIT = 1_900_000;
const KEY = /^[a-f0-9]{64}$/;
export interface LocalConnection {
  version: 1;
  computer: string;
  key: string;
  deviceId?: string;
  bootstrapId?: string;
  origins: string[];
}
export interface LocalPacket {
  version: 1;
  id: string;
  deviceId?: string;
  bootstrapId?: string;
  iv: string;
  data: string;
}
export interface LocalRequest {
  path: string;
  method: "GET" | "POST";
  token: string;
  body?: Record<string, unknown>;
  sentAt: number;
}
export interface LocalResponse {
  status: number;
  body: unknown;
}
export function randomLocalHex(length = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function localOrigin(value: unknown, allowLoopback = false): string {
  if (typeof value !== "string" || value.length > 256)
    throw new Error("invalid-local-origin");
  const url = new URL(value),
    host = url.hostname.toLowerCase();
  const parts = host.split(".");
  const ipv4 =
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && +p <= 255) &&
    (+parts[0] === 10 ||
      (+parts[0] === 192 && +parts[1] === 168) ||
      (+parts[0] === 172 && +parts[1] >= 16 && +parts[1] <= 31));
  const ipv6 = /^\[f[cd][0-9a-f:]+\]$/.test(host); // URL already validates IPv6 syntax.
  const mdns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(host);
  const loopback =
    allowLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(host);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.port ||
    !(ipv4 || ipv6 || mdns || loopback)
  )
    throw new Error("Only a local computer address is allowed");
  return url.origin;
}
export function validateLocalConnection(
  value: unknown,
  allowLoopback = false,
): LocalConnection {
  const v = value as LocalConnection;
  if (
    !v ||
    v.version !== 1 ||
    !KEY.test(v.computer) ||
    !KEY.test(v.key) ||
    (v.deviceId !== undefined && !/^[a-f0-9]{32}$/.test(v.deviceId)) ||
    (v.bootstrapId !== undefined && !/^[a-f0-9]{64}$/.test(v.bootstrapId)) ||
    (v.deviceId !== undefined) === (v.bootstrapId !== undefined) ||
    !Array.isArray(v.origins) ||
    !v.origins.length ||
    v.origins.length > 8
  )
    throw new Error("invalid-local-connection");
  return {
    version: 1,
    computer: v.computer,
    key: v.key,
    ...(v.deviceId ? { deviceId: v.deviceId } : {}),
    ...(v.bootstrapId ? { bootstrapId: v.bootstrapId } : {}),
    origins: [
      ...new Set(v.origins.map((origin) => localOrigin(origin, allowLoopback))),
    ],
  };
}
function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16));
}
function base64(value: Uint8Array): string {
  let result = "";
  for (let i = 0; i < value.length; i += 8192)
    result += String.fromCharCode(...value.subarray(i, i + 8192));
  return btoa(result);
}
export function validLocalPacket(value: unknown): value is LocalPacket {
  const p = value as LocalPacket;
  return (
    !!p &&
    p.version === 1 &&
    /^[a-f0-9]{32}$/.test(p.id) &&
    (p.deviceId === undefined || /^[a-f0-9]{32}$/.test(p.deviceId)) &&
    (p.bootstrapId === undefined || /^[a-f0-9]{64}$/.test(p.bootstrapId)) &&
    !(p.deviceId && p.bootstrapId) &&
    /^[a-f0-9]{24}$/.test(p.iv) &&
    typeof p.data === "string" &&
    p.data.length >= 24 &&
    p.data.length <= LOCAL_LINK_LIMIT &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(p.data)
  );
}
async function cipherKey(value: string) {
  if (!KEY.test(value)) throw new Error("invalid-local-key");
  return crypto.subtle.importKey("raw", bytes(value), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
function aad(
  computer: string,
  id: string,
  direction: "request" | "response",
  deviceId?: string,
  bootstrapId?: string,
) {
  return new TextEncoder().encode(
    `CanvasTTY/local/1/${computer}/${
      deviceId
        ? `device/${deviceId}`
        : bootstrapId
          ? `bootstrap/${bootstrapId}`
          : "legacy"
    }/${id}/${direction}`,
  );
}
export async function sealLocal(
  connection: LocalConnection,
  value: unknown,
  direction: "request" | "response",
  id = randomLocalHex(16),
): Promise<LocalPacket> {
  if (!KEY.test(connection.computer) || !/^[a-f0-9]{32}$/.test(id))
    throw new Error("invalid-local-packet-id");
  const plain = new TextEncoder().encode(JSON.stringify(value));
  if (plain.length > 1_400_000) throw new Error("local-payload-too-large");
  const iv = randomLocalHex(12);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bytes(iv),
      additionalData: aad(
        connection.computer,
        id,
        direction,
        connection.deviceId,
        connection.bootstrapId,
      ),
    },
    await cipherKey(connection.key),
    plain,
  );
  return {
    version: 1,
    id,
    ...(connection.deviceId ? { deviceId: connection.deviceId } : {}),
    ...(connection.bootstrapId ? { bootstrapId: connection.bootstrapId } : {}),
    iv,
    data: base64(new Uint8Array(encrypted)),
  };
}
export async function unsealLocal<T>(
  connection: LocalConnection,
  packet: LocalPacket,
  direction: "request" | "response",
): Promise<T> {
  if (!validLocalPacket(packet)) throw new Error("invalid-local-packet");
  if (
    packet.deviceId !== connection.deviceId ||
    packet.bootstrapId !== connection.bootstrapId
  )
    throw new Error("local-route-mismatch");
  const encrypted = Uint8Array.from(atob(packet.data), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes(packet.iv),
      additionalData: aad(
        connection.computer,
        packet.id,
        direction,
        packet.deviceId,
        packet.bootstrapId,
      ),
    },
    await cipherKey(connection.key),
    encrypted,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
export function validateLocalRequest(value: LocalRequest): void {
  const gets = new Set([
    "/g2/api/home",
    "/g2/api/terminal",
    "/g2/api/pair-status",
  ]);
  const posts = new Set([
    "/g2/api/pair",
    "/g2/api/create",
    "/g2/api/session-close",
    "/g2/api/session-rename",
    "/g2/api/browser",
    "/g2/api/control",
    "/g2/api/voice",
    "/g2/api/cancel",
    "/g2/api/device-state",
  ]);
  if (
    !value ||
    typeof value.path !== "string" ||
    value.path.length > 512 ||
    !value.path.startsWith("/g2/api/") ||
    typeof value.token !== "string" ||
    (value.token !== "" && !KEY.test(value.token)) ||
    !Number.isFinite(value.sentAt) ||
    Math.abs(Date.now() - value.sentAt) > 90_000
  )
    throw new Error("invalid-local-request");
  const url = new URL(value.path, "http://127.0.0.1");
  if (
    url.origin !== "http://127.0.0.1" ||
    url.hash ||
    !(value.method === "GET"
      ? gets.has(url.pathname)
      : value.method === "POST" && posts.has(url.pathname))
  )
    throw new Error("invalid-local-route");
  if (
    value.method === "POST" &&
    (!value.body || typeof value.body !== "object" || Array.isArray(value.body))
  )
    throw new Error("invalid-local-body");
}
