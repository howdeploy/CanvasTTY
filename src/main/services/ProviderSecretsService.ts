import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderSecretId } from "../../shared/contracts.ts";
import { PROVIDER_SECRET_IDS } from "../../shared/contracts.ts";
import type { SecretEncryption } from "./PluginSecretsService";

const MAX_SECRET_VALUE_BYTES = 16 * 1024;
const MAX_SECRET_PAYLOAD_BYTES = 64 * 1024;

// The renderer may learn whether a key is configured, never the value itself.
// Values are read back only inside the main process (future launch-time
// environment injection for BYOK-capable provider CLIs).
export class ProviderSecretsService {
  private readonly root: string;
  private write: Promise<void> = Promise.resolve();
  private readonly encryption: SecretEncryption;

  constructor(userDataPath: string, encryption: SecretEncryption) {
    this.root = join(userDataPath, "provider-secrets.bin");
    this.encryption = encryption;
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.root), { recursive: true });
  }

  async get(secretId: ProviderSecretId): Promise<string | null> {
    const values = await this.read();
    return Object.prototype.hasOwnProperty.call(values, secretId) ? values[secretId] : null;
  }

  async set(secretId: ProviderSecretId, value: string): Promise<void> {
    assertSecretId(secretId);
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_SECRET_VALUE_BYTES) {
      throw new Error("Provider secret must be a non-empty string no larger than 16 KB.");
    }
    await this.mutate((values) => {
      values[secretId] = value;
    });
  }

  async delete(secretId: ProviderSecretId): Promise<void> {
    assertSecretId(secretId);
    await this.mutate((values) => {
      delete values[secretId];
    });
  }

  async status(): Promise<Record<ProviderSecretId, boolean>> {
    const values = await this.read();
    return Object.fromEntries(PROVIDER_SECRET_IDS.map((secretId) => [
      secretId,
      Object.prototype.hasOwnProperty.call(values, secretId)
    ])) as Record<ProviderSecretId, boolean>;
  }

  private async mutate(mutation: (values: Record<string, string>) => void): Promise<void> {
    const operation = async (): Promise<void> => {
      const values = await this.read();
      mutation(values);
      const keys = Object.keys(values);
      if (keys.length === 0) {
        await rm(this.root, { force: true });
        return;
      }
      const plaintext = JSON.stringify(values);
      if (Buffer.byteLength(plaintext) > MAX_SECRET_PAYLOAD_BYTES) {
        throw new Error("Provider secret storage exceeds the 64 KB quota.");
      }
      const encrypted = this.encryption.encrypt(plaintext);
      const temporaryPath = `${this.root}.tmp`;
      await mkdir(dirname(this.root), { recursive: true });
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, this.root);
    };
    const next = this.write.then(operation, operation);
    this.write = next.catch(() => undefined);
    await next;
  }

  private async read(): Promise<Record<string, string>> {
    if (!this.encryption.isAvailable()) {
      throw new Error("Secure provider storage is unavailable on this system.");
    }
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.root);
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    try {
      const plaintext = this.encryption.decrypt(encrypted);
      if (Buffer.byteLength(plaintext) > MAX_SECRET_PAYLOAD_BYTES) throw new Error("Secret payload is too large.");
      const candidate: unknown = JSON.parse(plaintext);
      if (!isSecretRecord(candidate)) throw new Error("Secret payload is invalid.");
      return { ...candidate };
    } catch {
      throw new Error("Provider secrets could not be decrypted.");
    }
  }
}

function assertSecretId(value: ProviderSecretId): void {
  if (!PROVIDER_SECRET_IDS.includes(value)) {
    throw new Error("Provider secret id is unknown.");
  }
}

function isSecretRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => (
    (PROVIDER_SECRET_IDS as readonly string[]).includes(key)
    && typeof item === "string"
    && item.length > 0
    && Buffer.byteLength(item) <= MAX_SECRET_VALUE_BYTES
  ));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
