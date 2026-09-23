import { join } from 'node:path';
import { ProviderSecretsService } from '../ProviderSecretsService.ts';
import type { SecretEncryption } from '../PluginSecretsService.ts';
const OWNER = { profileId: 'decision-jev', hostId: 'local' };
/** Separate encrypted file and owner namespace; no provider key fallback or startup read. */
export class DecisionSecrets {
 private readonly storage: ProviderSecretsService;
 private revision = 0;
 private readonly changed: () => void;
 private mutation: Promise<void> = Promise.resolve();
 constructor(root: string, encryption: SecretEncryption, changed: () => void = () => {}) { this.changed = changed; this.storage = new ProviderSecretsService(join(root, 'decision-secrets'), encryption, owner => owner.profileId === OWNER.profileId && owner.hostId === OWNER.hostId); }
 get generation(): number { return this.revision; }
 async status(): Promise<{ configured: boolean }> { await this.mutation; return { configured: (await this.entries()).length === 1 }; }
 private async entries() { const entries = await this.storage.scopedStatus(); if (entries.some(e => e.owner.profileId !== OWNER.profileId || e.owner.hostId !== OWNER.hostId) || entries.length > 1) throw new Error('Invalid decision credential store.'); return entries; }
 async get(): Promise<string | null> { await this.mutation; const entry = (await this.entries())[0]; return entry ? this.storage.get(entry.ref, OWNER) : null; }
 set(value: string): Promise<void> {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16384 || /[\r\n]/u.test(value)) return Promise.reject(new Error('Invalid decision credential.'));
  return this.mutate(async () => { const entry = (await this.entries())[0]; if (entry) await this.storage.update(entry.ref, OWNER, value); else await this.storage.create(OWNER, value); });
 }
 remove(): Promise<void> { return this.mutate(async () => { const entry = (await this.entries())[0]; if (entry) await this.storage.remove(entry.ref, OWNER); }); }
 private mutate(work: () => Promise<void>): Promise<void> { this.revision++; this.changed(); const next = this.mutation.then(work, work); this.mutation = next.catch(() => {}); return next; }
}
