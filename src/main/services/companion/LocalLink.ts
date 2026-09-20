import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
    try {
      const v = JSON.parse(await readFile(this.file, "utf8"));
      if (!/^[a-f0-9]{64}$/.test(v?.computer) || !/^[a-f0-9]{64}$/.test(v?.key))
        throw new Error("invalid-local-identity");
      this.identity = { computer: v.computer, key: v.key };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const value = { computer: randomLocalHex(), key: randomLocalHex() };
      await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
      const temporary = this.file + "." + randomLocalHex(8) + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(value), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.identity = value;
    }
  }
  connection(origins: string[]): LocalConnection {
    if (!this.identity) throw new Error("local-identity-unavailable");
    return { version: 1, ...this.identity, origins };
  }
  async receive(
    packet: LocalPacket,
    forward: (request: LocalRequest) => Promise<LocalResponse>,
  ): Promise<LocalPacket> {
    if (!validLocalPacket(packet)) throw new Error("invalid-local-packet");
    const connection = this.connection([]),
      now = Date.now();
    const hash = createHash("sha256")
      .update(JSON.stringify(packet))
      .digest("hex");
    for (const [id, receipt] of this.receipts)
      if (receipt.until < now) this.receipts.delete(id);
    const old = this.receipts.get(packet.id);
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
        validateLocalRequest(request);
        response = await forward(request);
      } catch {
        response = { status: 409, body: { error: "request-failed" } };
      }
      return sealLocal(connection, response, "response", packet.id);
    })()
      .catch((error) => {
        this.receipts.delete(packet.id);
        throw error;
      })
      .finally(() => {
        this.active--;
      });
    this.receipts.set(packet.id, { hash, until: now + 120_000, result });
    return result;
  }
}
