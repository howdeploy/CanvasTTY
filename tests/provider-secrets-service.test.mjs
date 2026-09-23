import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderSecretsService } from "../src/main/services/ProviderSecretsService.ts";
import { PROVIDER_SECRET_IDS } from "../src/shared/contracts.ts";

function fakeEncryption(available = true) {
  return {
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decrypt: (value) => Buffer.from(value.toString().slice("encrypted:".length), "base64").toString()
  };
}

async function fixture(t, { available = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-provider-secrets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ProviderSecretsService(root, fakeEncryption(available));
  await service.load();
  return { root, service };
}

test("stores provider secrets encrypted at rest and restores them", async (t) => {
  const { root, service } = await fixture(t);
  await service.set("OPENAI_API_KEY", "sk-test-value");
  assert.equal(await service.get("OPENAI_API_KEY"), "sk-test-value");

  const bytes = await readFile(join(root, "provider-secrets.bin"));
  assert.equal(bytes.includes(Buffer.from("sk-test-value")), false);
  assert.equal(bytes.includes(Buffer.from("encrypted:")), true);
});

test("status reports configured flags only, never values", async (t) => {
  const { service } = await fixture(t);
  await service.set("ZAI_API_KEY", "zai-secret");
  const status = await service.status();

  assert.deepEqual(
    PROVIDER_SECRET_IDS.filter((secretId) => status[secretId]),
    ["ZAI_API_KEY"]
  );
  assert.deepEqual(Object.values(status).every((value) => typeof value === "boolean"), true);
});

test("clearing the last secret removes the store file", async (t) => {
  const { root, service } = await fixture(t);
  await service.set("MINIMAX_API_KEY", "minimax-secret");
  await service.delete("MINIMAX_API_KEY");

  assert.equal(await service.get("MINIMAX_API_KEY"), null);
  await assert.rejects(() => readFile(join(root, "provider-secrets.bin")), /ENOENT/u);
  const status = await service.status();
  assert.deepEqual(
    PROVIDER_SECRET_IDS.filter((secretId) => status[secretId]),
    []
  );
});

test("secrets survive a service restart through the encrypted file", async (t) => {
  const { root, service } = await fixture(t);
  await service.set("ANTHROPIC_API_KEY", "first");
  await service.set("CURSOR_API_KEY", "second");

  const reloaded = new ProviderSecretsService(root, fakeEncryption());
  await reloaded.load();
  assert.equal(await reloaded.get("ANTHROPIC_API_KEY"), "first");
  assert.equal(await reloaded.get("CURSOR_API_KEY"), "second");
});

test("unknown secret ids and invalid values are rejected", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(() => service.set("NOT_A_KNOWN_KEY", "value"), /unknown/ui);
  await assert.rejects(() => service.set("OPENAI_API_KEY", ""), /non-empty/u);
  await assert.rejects(
    () => service.set("OPENAI_API_KEY", "x".repeat(16 * 1024 + 1)),
    /16 KB/u
  );
  await assert.rejects(() => service.delete("NOT_A_KNOWN_KEY"), /unknown/ui);
});

test("storage fails closed when OS encryption is unavailable", async (t) => {
  const { service } = await fixture(t, { available: false });
  await assert.rejects(() => service.set("OPENAI_API_KEY", "value"), /unavailable/u);
  await assert.rejects(() => service.status(), /unavailable/u);
});

test("corrupted encrypted payloads fail closed instead of leaking partial data", async (t) => {
  const { root, service } = await fixture(t);
  await service.set("OPENAI_API_KEY", "value");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "provider-secrets.bin"), Buffer.from("garbage"));

  const reloaded = new ProviderSecretsService(root, fakeEncryption());
  await reloaded.load();
  await assert.rejects(() => reloaded.get("OPENAI_API_KEY"), /decrypted/u);
});

test("two hundred opaque references have distinct owners and preserve legacy keys", async (t) => {
  const { root, service } = await fixture(t);
  await service.set("OPENAI_API_KEY", "legacy-secret");
  const entries = await Promise.all(Array.from({ length: 200 }, (_, index) => service.create({ profileId: `profile-${index}`, hostId: "local" }, `value-${index}`)));
  assert.equal(new Set(entries.map((e) => e.ref)).size, 200);
  assert.ok(entries.every((e) => /^secret:[0-9a-f-]{36}$/.test(e.ref)));
  assert.equal((await service.scopedStatus()).length, 200);
  assert.equal(await service.get(entries[199].ref, entries[199].owner), "value-199");
  assert.equal(await service.get("OPENAI_API_KEY"), "legacy-secret");
  await assert.rejects(service.get(entries[0].ref, { profileId: "profile-1", hostId: "local" }), /belong/);
  await assert.rejects(service.get(entries[0].ref, { profileId: "profile-0", hostId: "remote" }), /belong/);
  await assert.rejects(service.get(entries[0].ref), /owner/);
  await assert.rejects(service.update(entries[0].ref, entries[1].owner, "overwrite"), /belong/);
  await service.update(entries[0].ref, entries[0].owner, "replacement");
  const reloaded = new ProviderSecretsService(root, fakeEncryption());
  assert.equal(await reloaded.get(entries[0].ref, entries[0].owner), "replacement");
  assert.equal(JSON.stringify(await reloaded.scopedStatus()).includes("replacement"), false);
  await reloaded.remove(entries[0].ref, entries[0].owner);
  assert.equal((await reloaded.scopedStatus()).length, 199);
});

test("legacy encrypted format migrates atomically without discarding values", async (t) => {
  const { root, service } = await fixture(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "provider-secrets.bin"), fakeEncryption().encrypt(JSON.stringify({ OPENAI_API_KEY: "old", ANTHROPIC_API_KEY: "keep" })));
  await service.create({ profileId: "new-profile", hostId: "local" }, "new-key");
  assert.equal(await service.get("OPENAI_API_KEY"), "old");
  assert.equal(await service.get("ANTHROPIC_API_KEY"), "keep");
  const stored = JSON.parse(fakeEncryption().decrypt(await readFile(join(root, "provider-secrets.bin"))));
  assert.equal(stored.version, 2);
});

test("encrypted file quota is checked before decrypting and owner guards protect runtime reads", async (t) => {
  const { root } = await fixture(t);
  const { open } = await import("node:fs/promises");
  const file = await open(join(root, "provider-secrets.bin"), "w");
  await file.truncate(48 * 1024 * 1024 + 1); await file.close();
  let decrypts = 0;
  const service = new ProviderSecretsService(root, { ...fakeEncryption(), decrypt() { decrypts++; throw new Error("should not decrypt"); } });
  await assert.rejects(service.status(), /file quota/);
  assert.equal(decrypts, 0);
});

test("200 maximum-size escaped values fit the documented storage bounds", async (t) => {
  const { root, service } = await fixture(t);
  const { randomUUID } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const entries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`secret:${randomUUID()}`, { owner: { profileId: `p-${i}`, hostId: "local" }, value: "\u0001".repeat(16 * 1024) }]));
  const content = JSON.stringify({ version: 2, entries });
  assert.ok(Buffer.byteLength(content) < 32 * 1024 * 1024);
  await writeFile(join(root, "provider-secrets.bin"), fakeEncryption().encrypt(content));
  assert.equal((await service.scopedStatus()).length, 200);
  await service.set("OPENAI_API_KEY", "ordinary-key");
  assert.equal(await service.get("OPENAI_API_KEY"), "ordinary-key");
});
