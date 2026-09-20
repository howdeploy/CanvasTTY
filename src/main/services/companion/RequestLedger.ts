import { createHash } from "node:crypto";
import {
  CompanionError,
  type CompanionRequest,
} from "../../../shared/companion.ts";

interface Receipt {
  digest: string;
  expiresAt: number;
  result: Promise<unknown>;
  pending: boolean;
}

/** One result per device/request within its bounded validity window. */
export class RequestLedger {
  private readonly entries = new Map<string, Receipt>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;

  constructor(
    now: () => number = Date.now,
    maxEntries = 1024,
    maxAgeMs = 120_000,
  ) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.maxAgeMs = maxAgeMs;
  }

  run(
    deviceId: string,
    request: Pick<CompanionRequest, "id" | "sentAt"> & { action: unknown },
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (!entry.pending && entry.expiresAt < now) this.entries.delete(key);
    }
    if (request.sentAt < now - this.maxAgeMs || request.sentAt > now + 30_000) {
      return Promise.reject(new CompanionError("stale-request"));
    }
    const key = JSON.stringify([deviceId, request.id]);
    const digest = createHash("sha256")
      .update(JSON.stringify(request.action))
      .digest("hex");
    const previous = this.entries.get(key);
    if (previous) {
      return previous.digest === digest
        ? previous.result
        : Promise.reject(new CompanionError("request-conflict"));
    }
    // Do not evict a valid receipt and accidentally allow a repeated input.
    if (this.entries.size >= this.maxEntries)
      return Promise.reject(new CompanionError("busy"));
    const entry: Receipt = {
      digest,
      expiresAt: request.sentAt + this.maxAgeMs,
      pending: true,
      result: Promise.resolve().then(operation),
    };
    this.entries.set(key, entry);
    void entry.result
      .finally(() => {
        entry.pending = false;
      })
      .catch(() => undefined);
    return entry.result;
  }

  forgetDevice(deviceId: string): void {
    for (const key of this.entries.keys()) {
      if ((JSON.parse(key) as string[])[0] === deviceId)
        this.entries.delete(key);
    }
  }
}
