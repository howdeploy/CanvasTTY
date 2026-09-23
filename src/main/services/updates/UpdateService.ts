import type { UpdateStatus } from "../../../shared/contracts.ts";

export interface UpdateService {
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  onStatus(callback: (status: UpdateStatus) => void): () => void;
}
