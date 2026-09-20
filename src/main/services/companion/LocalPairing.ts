import srpClient from "secure-remote-password/client.js";
import srpServer from "secure-remote-password/server.js";
import { randomBytes } from "node:crypto";
import { PAIRING_IDENTITY, sixDigitCode } from "../../../shared/localDiscovery.ts";

/** Ephemeral PAKE: a short PIN is never sent or used directly as an AES key. */
export class LocalPairing {
  private readonly salt = srpClient.generateSalt();
  private readonly verifier: string;
  private attempts = 0;
  private sessions = new Map<string, { secret: string; public: string }>();
  readonly expiresAt: number;
  constructor(code: string, expiresAt: number) {
    this.expiresAt = expiresAt;
    this.verifier = srpClient.deriveVerifier(srpClient.derivePrivateKey(
      this.salt, PAIRING_IDENTITY, sixDigitCode(code),
    ));
  }
  start(value: unknown) {
    if (Date.now() >= this.expiresAt || ++this.attempts > 10 ||
      typeof value !== "string" || !/^[a-f0-9]{512}$/.test(value) ||
      /^0+$/.test(value)) throw new Error("pairing-unavailable");
    const ephemeral = srpServer.generateEphemeral(this.verifier);
    const id = randomBytes(32).toString("hex");
    this.sessions.set(id, { secret: ephemeral.secret, public: value });
    return { id, salt: this.salt, public: ephemeral.public };
  }
  finish(id: unknown, proof: unknown) {
    const session = typeof id === "string" ? this.sessions.get(id) : null;
    if (typeof id === "string") this.sessions.delete(id);
    if (!session || Date.now() >= this.expiresAt ||
      typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof))
      throw new Error("pairing-unavailable");
    return srpServer.deriveSession(session.secret, session.public, this.salt,
      PAIRING_IDENTITY, this.verifier, proof);
  }
}
