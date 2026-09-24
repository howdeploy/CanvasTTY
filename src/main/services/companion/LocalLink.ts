import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import {
  randomLocalHex,
  sealLocal,
  unsealLocal,
  validateLocalRequest,
  validLocalPacket,
  type LocalConnection,
  type LocalPacket,
  type LocalRequest,
  type LocalResponse,
} from "../../../shared/localLink.ts";

export class LocalLink {
  private identity: { computer: string; key: string } | null = null;
  private bootstraps = new Map<string, { key: string; until: number }>();
  private readonly file: string;
  private active = 0;
  private receipts = new Map<
    string,
    { hash: string; until: number; result: Promise<LocalPacket> }
  >();
  constructor(userDataPath: string) {
    this.file = join(userDataPath, "even-g2-local.json");
  }
  async load(): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.identity = { computer: randomLocalHex(), key: randomLocalHex() };
      await this.writeIdentity();
      return;
    }
    const stored = value as { version?: number; computer?: string; key?: string };
    if (stored?.version !== undefined && ![1, 2].includes(stored.version))
      throw new Error("invalid-local-identity");
    if (!/^[a-f0-9]{64}$/.test(stored?.computer || "") || !/^[a-f0-9]{64}$/.test(stored?.key || ""))
      throw new Error("invalid-local-identity");
    if (stored.version === 2) {
      this.identity = { computer: stored.computer!, key: stored.key! };
    } else {
      this.identity = { computer: stored.computer!, key: randomLocalHex() };
      await this.writeIdentity();
    }
  }
  private async writeIdentity(): Promise<void> {
    if (!this.identity) throw new Error("local-identity-unavailable");
    await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomLocalHex(8) + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify({ version: 2, ...this.identity }), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  computerId(): string {
    if (!this.identity) throw new Error("local-identity-unavailable");
    return this.identity.computer;
  }
  deviceConnection(deviceId: string, origins: string[]): LocalConnection {
    if (!this.identity || !/^[a-f0-9]{32}$/.test(deviceId))
      throw new Error("local-identity-unavailable");
    const key = createHmac("sha256", this.identity.key)
      .update(`CanvasTTY/local/device/2/${deviceId}`)
      .digest("hex");
    return { version: 1, computer: this.identity.computer, key, deviceId, origins };
  }
  registerBootstrap(id: string, key: string, until: number): void {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(key))
      throw new Error("invalid-local-bootstrap");
    for (const [oldId, bootstrap] of this.bootstraps)
      if (bootstrap.until <= Date.now()) this.bootstraps.delete(oldId);
    if (this.bootstraps.size >= 16) throw new Error("local-link-busy");
    this.bootstraps.set(id, { key, until });
  }
  clearBootstraps(): void {
    this.bootstraps.clear();
  }
  bootstrapConnection(id: string, key: string, origins: string[]): LocalConnection {
    if (!this.identity || !/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(key))
      throw new Error("invalid-local-bootstrap");
    return { version: 1, computer: this.identity.computer, key, bootstrapId: id, origins };
  }
  async receive(
    packet: LocalPacket,
    forward: (request: LocalRequest) => Promise<LocalResponse>,
    activeDevice: (id: string) => boolean,
  ): Promise<LocalPacket> {
    if (!validLocalPacket(packet)) throw new Error("invalid-local-packet");
    const now = Date.now();
    for (const [id, bootstrap] of this.bootstraps)
      if (bootstrap.until <= now) this.bootstraps.delete(id);
    const route = packet.deviceId
      ? `device:${packet.deviceId}`
      : packet.bootstrapId
        ? `bootstrap:${packet.bootstrapId}`
        : "";
    const connection = packet.deviceId
      ? activeDevice(packet.deviceId)
        ? this.deviceConnection(packet.deviceId, [])
        : null
      : packet.bootstrapId && this.bootstraps.has(packet.bootstrapId)
        ? this.bootstrapConnection(
            packet.bootstrapId,
            this.bootstraps.get(packet.bootstrapId)!.key,
            [],
          )
        : null;
    if (!route || !connection) throw new Error("local-device-unavailable");
    const hash = createHash("sha256")
      .update(JSON.stringify(packet))
      .digest("hex");
    for (const [id, receipt] of this.receipts)
      if (receipt.until < now) this.receipts.delete(id);
    const receiptId = `${route}:${packet.id}`;
    const old = this.receipts.get(receiptId);
    if (old) {
      if (old.hash !== hash) throw new Error("packet-id-conflict");
      return old.result;
    }
    if (this.active >= 8 || this.receipts.size >= 2048)
      throw new Error("local-link-busy");
    this.active++;
    const result = (async () => {
      const request = await unsealLocal<LocalRequest>(
        connection,
        packet,
        "request",
      );
      let response: LocalResponse;
      try {
        if (
          packet.bootstrapId &&
          request.path !== "/g2/api/home" &&
          request.path !== "/g2/api/pair"
        )
          throw new Error("bootstrap-route-forbidden");
        validateLocalRequest(request);
        response = await forward(request);
      } catch {
        response = { status: 409, body: { error: "request-failed" } };
      }
      return sealLocal(connection, response, "response", packet.id);
    })()
      .catch((error) => {
        this.receipts.delete(receiptId);
        throw error;
      })
      .finally(() => {
        this.active--;
      });
    this.receipts.set(receiptId, { hash, until: now + 120_000, result });
    return result;
  }
}
