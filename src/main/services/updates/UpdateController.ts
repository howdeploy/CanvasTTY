import type { UpdateStatus } from "../../../shared/contracts.ts";
import type { UpdateService } from "./UpdateService.ts";

export interface AvailableUpdate {
  version: string;
  notes?: string;
  manualUrl?: string;
}

export interface UpdateAdapter {
  check(): Promise<AvailableUpdate | null>;
  download(progress: (percent?: number) => void): Promise<void>;
  install(): Promise<void>;
}

export function isNewStableVersion(candidate: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) return null;
    return value.split(".").map(Number);
  };
  const next = parse(candidate);
  const prior = parse(current);
  if (!next || !prior) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== prior[index]) return next[index] > prior[index];
  }
  return false;
}

export class UpdateController implements UpdateService {
  private readonly adapter: UpdateAdapter;
  private readonly currentVersion: string;
  private value: UpdateStatus = { type: "idle" };
  private listeners = new Set<(status: UpdateStatus) => void>();
  private busy = false;

  constructor(adapter: UpdateAdapter, currentVersion: string) {
    this.adapter = adapter;
    this.currentVersion = currentVersion;
  }

  status(): UpdateStatus { return this.value; }

  onStatus(callback: (status: UpdateStatus) => void): () => void {
    this.listeners.add(callback);
    callback(this.value);
    return () => { this.listeners.delete(callback); };
  }

  private emit(status: UpdateStatus): void {
    this.value = status;
    for (const callback of this.listeners) callback(status);
  }

  private async run(task: () => Promise<void>): Promise<void> {
    if (this.busy) throw new Error("An update operation is already in progress");
    this.busy = true;
    try { await task(); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Update failed";
      this.emit({ type: "error", message });
      throw error;
    } finally { this.busy = false; }
  }

  check(): Promise<void> {
    // A cached update remains installable until the user explicitly restarts.
    if (this.value.type === "ready") return Promise.resolve();
    return this.run(async () => {
      this.emit({ type: "checking" });
      const candidate = await this.adapter.check();
      if (candidate && isNewStableVersion(candidate.version, this.currentVersion)) {
        this.emit({ type: "available", ...candidate });
      } else this.emit({ type: "upToDate" });
    });
  }

  download(): Promise<void> {
    if (this.value.type !== "available") return Promise.reject(new Error("No available update"));
    const { version } = this.value;
    return this.run(async () => {
      this.emit({ type: "downloading" });
      await this.adapter.download(percent => this.emit({ type: "downloading", percent }));
      this.emit({ type: "ready", version });
    });
  }

  install(): Promise<void> {
    if (this.value.type !== "ready") return Promise.reject(new Error("No downloaded update"));
    return this.run(async () => {
      this.emit({ type: "installing" });
      await this.adapter.install();
    });
  }
}
