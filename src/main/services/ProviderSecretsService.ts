import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderSecretId, ProviderSecretOwner, ProviderSecretRef, ProviderSecretStatus } from "../../shared/contracts.ts";
import { PROVIDER_SECRET_IDS, PROVIDER_SECRET_LIMITS as LIMIT } from "../../shared/contracts.ts";
import { isProviderSecretRef } from "../../shared/providerAccountPolicy.ts";
import type { SecretEncryption } from "./PluginSecretsService";

type Entry = { value: string; owner?: ProviderSecretOwner };
type Entries = Record<string, Entry>;
type OwnerAllowed = (owner: ProviderSecretOwner, pendingCreation: boolean) => boolean;

/** Only main can retrieve plaintext. Renderer methods return flags and opaque IDs. */
export class ProviderSecretsService {
  private readonly root: string;
  private revision = 0;
  get generation(): number { return this.revision; }
  private write: Promise<void> = Promise.resolve();
  private readonly encryption: SecretEncryption;
  private readonly ownerAllowed: OwnerAllowed;

  constructor(userDataPath: string, encryption: SecretEncryption, ownerAllowed: OwnerAllowed = () => true) {
    this.root = join(userDataPath, "provider-secrets.bin");
    this.encryption = encryption;
    this.ownerAllowed = ownerAllowed;
  }
  async load(): Promise<void> { await mkdir(dirname(this.root), { recursive: true }); }

  async get(ref: ProviderSecretRef, owner?: ProviderSecretOwner): Promise<string | null> {
    assertReference(ref);
    await this.write;
    const values = await this.read();
    const entry = values[ref];
    this.assertOwner(ref, entry, owner);
    return entry?.value ?? null;
  }
  async set(secretId: ProviderSecretId, value: string): Promise<void> {
    assertLegacyId(secretId); assertValue(value);
    await this.mutate((values) => { values[secretId] = { value }; });
  }
  async delete(secretId: ProviderSecretId): Promise<void> {
    assertLegacyId(secretId);
    await this.mutate((values) => { delete values[secretId]; });
  }
  async status(): Promise<Record<ProviderSecretId, boolean>> {
    await this.write;
    const values = await this.read();
    return Object.fromEntries(PROVIDER_SECRET_IDS.map((id) => [id, !!values[id]])) as Record<ProviderSecretId, boolean>;
  }
  async create(owner: ProviderSecretOwner, value: string): Promise<ProviderSecretStatus> {
    assertOwnerShape(owner); assertValue(value);
    if (!this.ownerAllowed(owner, true)) throw new Error("Secret owner is not a configured or pending API profile on this host.");
    const ref: ProviderSecretRef = `secret:${randomUUID()}`;
    const copied = { profileId: owner.profileId, hostId: owner.hostId };
    await this.mutate((values) => { values[ref] = { value, owner: copied }; });
    return { ref, owner: copied, configured: true };
  }
  async scopedStatus(): Promise<ProviderSecretStatus[]> {
    await this.write;
    const values = await this.read();
    return Object.entries(values).flatMap(([ref, entry]) => entry.owner ? [{ ref: ref as ProviderSecretRef, owner: { ...entry.owner }, configured: true }] : []);
  }
  async update(ref: ProviderSecretRef, owner: ProviderSecretOwner, value: string): Promise<void> {
    assertReference(ref); assertValue(value);
    await this.mutate((values) => {
      this.assertOwner(ref, values[ref], owner);
      if (!values[ref]?.owner) throw new Error("Scoped credential reference is not configured.");
      values[ref] = { value, owner: { ...values[ref]!.owner! } };
    });
  }
  async remove(ref: ProviderSecretRef, owner: ProviderSecretOwner): Promise<void> {
    assertReference(ref);
    await this.mutate((values) => {
      // Owner equality still protects orphaned pending entries after profile deletion.
      this.assertOwner(ref, values[ref], owner, true);
      if (!ref.startsWith("secret:")) throw new Error("Use the legacy key operation for this reference.");
      delete values[ref];
    });
  }
  private assertOwner(ref: ProviderSecretRef, entry: Entry | undefined, owner?: ProviderSecretOwner, deleting = false): void {
    if (!ref.startsWith("secret:")) return;
    assertOwnerShape(owner);
    if (!entry?.owner || entry.owner.profileId !== owner.profileId || entry.owner.hostId !== owner.hostId) throw new Error("Credential reference does not belong to this profile and host.");
    if (!deleting && !this.ownerAllowed(owner, false)) throw new Error("Credential owner is not configured on this host.");
  }
  private async mutate(mutation: (entries: Entries) => void): Promise<void> {
    const operation = async (): Promise<void> => {
      const values = await this.read(); mutation(values); validateEntries(values);
      if (Object.keys(values).length === 0) { await rm(this.root, { force: true }); this.revision++; return; }
      const plaintext = JSON.stringify({ version: 2, entries: values });
      if (Buffer.byteLength(plaintext) > LIMIT.payloadBytes) throw new Error("Provider secrets exceed the serialized storage quota.");
      const encrypted = this.encryption.encrypt(plaintext);
      if (encrypted.byteLength > LIMIT.encryptedBytes) throw new Error("Encrypted provider secrets exceed the storage quota.");
      const temporary = `${this.root}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.root), { recursive: true });
      try { await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" }); await rename(temporary, this.root); this.revision++; }
      finally { await rm(temporary, { force: true }); }
    };
    const next = this.write.then(operation, operation);
    this.write = next.catch(() => undefined); await next;
  }
  private async read(): Promise<Entries> {
    if (!this.encryption.isAvailable()) throw new Error("Secure provider storage is unavailable on this system.");
    let encrypted: Buffer;
    try {
      const file = await open(this.root, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > LIMIT.encryptedBytes) throw new Error("Encrypted provider storage exceeds its file quota.");
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) { const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
        if (offset > stat.size) throw new Error("Provider secret storage changed while reading.");
        encrypted = buffer.subarray(0, offset);
      } finally { await file.close(); }
    } catch (error) { if (isMissingFile(error)) return {}; throw error; }
    try {
      const plaintext = this.encryption.decrypt(encrypted);
      if (Buffer.byteLength(plaintext) > LIMIT.payloadBytes) throw new Error("Secret payload is too large.");
      const candidate: unknown = JSON.parse(plaintext);
      if (!isRecord(candidate)) throw new Error("Invalid secret store.");
      let entries: Entries;
      if (candidate.version === 2 && isRecord(candidate.entries)) entries = candidate.entries as Entries;
      else entries = Object.fromEntries(Object.entries(candidate).map(([id, value]) => { assertLegacyId(id); return [id, { value }]; })) as Entries;
      validateEntries(entries);
      return Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { value: entry.value, ...(entry.owner ? { owner: { ...entry.owner } } : {}) }]));
    } catch { throw new Error("Provider secrets could not be decrypted."); }
  }
}
function assertReference(ref: unknown): asserts ref is ProviderSecretRef { if (!isProviderSecretRef(ref)) throw new Error("Provider secret id is unknown."); }
function assertLegacyId(ref: unknown): asserts ref is ProviderSecretId { if (!(PROVIDER_SECRET_IDS as readonly unknown[]).includes(ref)) throw new Error("Provider secret id is unknown."); }
function assertValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > LIMIT.valueBytes) throw new Error("Provider secret must be a non-empty string no larger than 16 KB.");
}
function assertOwnerShape(owner: unknown): asserts owner is ProviderSecretOwner {
  if (!isRecord(owner) || typeof owner.profileId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(owner.profileId) || typeof owner.hostId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(owner.hostId)) throw new Error("Credential owner must name an API profile and one host.");
}
function validateEntries(entries: Entries): void {
  if (Object.keys(entries).length > LIMIT.count) throw new Error("Provider secrets exceed the reference count quota.");
  let bytes = 0;
  for (const [id, entry] of Object.entries(entries)) {
    assertReference(id); if (!isRecord(entry)) throw new Error("Invalid secret entry."); assertValue(entry.value);
    if (id.startsWith("secret:")) assertOwnerShape(entry.owner); else if (entry.owner !== undefined) throw new Error("Legacy secret cannot have a scoped owner.");
    bytes += Buffer.byteLength(entry.value);
  }
  if (bytes > LIMIT.rawBytes) throw new Error("Provider secrets exceed the 4 MiB value quota.");
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isMissingFile(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
