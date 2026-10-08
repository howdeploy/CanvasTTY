import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MaterialService } from "../src/main/services/materials/MaterialService.ts";
import { materialUrl } from "../src/shared/materials.ts";

async function withStore(run, storageLimitBytes = 128) {
  const userDataPath = await mkdtemp(join(tmpdir(), "canvastty-storage-"));
  const root = join(userDataPath, "materials");
  const statePath = join(root, "state.json");
  const services = [];
  let persist = true;
  const create = () => {
    const service = new MaterialService({
      userDataPath,
      persist: () => persist,
      emit: () => undefined,
      watchFactory: () => ({ close() {} }),
      pollIntervalMs: 0,
      storageLimitBytes
    });
    services.push(service);
    return service;
  };
  const capture = (service, value = 1) => service.addCapture({
    bytes: Buffer.alloc(64, value), name: "clipboard.png", mimeType: "image/png",
    origin: { kind: "clipboard" }, point: { x: 0, y: 0 }
  });
  const blobs = async () => (await readdir(join(root, "versions")).catch(() => [])).sort();
  try {
    await run({ root, statePath, create, capture, blobs, setPersist: (value) => { persist = value; } });
  } finally {
    for (const service of services) await service.dispose();
    await rm(userDataPath, { recursive: true, force: true });
  }
}

for (const [name, damage] of [
  ["malformed JSON", () => "{broken"],
  ["newer schema", (state) => JSON.stringify({ ...state, version: 99 })],
  ["invalid shape", () => JSON.stringify({ version: 1, materials: "broken" })],
  ["unknown state fields", (state) => JSON.stringify({ ...state, futureData: [] })],
  ["unknown material fields", (state) => { state.materials[0].futureData = []; return JSON.stringify(state); }],
  ["unknown version fields", (state) => { state.materials[0].versions[0].futureData = []; return JSON.stringify(state); }],
  ["invalid material", (state) => { state.materials[0].kind = "unknown"; return JSON.stringify(state); }],
  ["invalid version", (state) => { state.materials[0].versions[0].reason = "unknown"; return JSON.stringify(state); }]
]) {
  test(`preserves ${name}`, async () => {
    await withStore(async ({ root, statePath, create, capture, blobs, setPersist }) => {
      const first = create();
      await first.load();
      assert.equal((await capture(first)).ok, true);
      await first.dispose();
      const before = await blobs();
      const damaged = damage(JSON.parse(await readFile(statePath, "utf8")));
      await writeFile(statePath, damaged);
      for (const persist of [true, false]) {
        setPersist(persist);
        const next = create();
        await next.load();
        assert.equal(await readFile(statePath, "utf8"), damaged);
        assert.equal(next.snapshot().loadError, "unreadable");
        assert.deepEqual(await capture(next, 2), { ok: false, reason: "unreadable" });
        await next.flush();
        await next.dispose();
        assert.equal(await readFile(statePath, "utf8"), damaged);
        assert.deepEqual(await blobs(), before);
        assert.deepEqual(await readFile(join(root, "versions", before[0])), Buffer.alloc(64, 1));
      }
    });
  });
}

test("preserves an unreadable state", async () => {
  await withStore(async ({ root, statePath, create, capture, blobs }) => {
    const first = create();
    await first.load();
    await capture(first);
    await first.dispose();
    const saved = await readFile(statePath);
    const before = await blobs();
    await rm(statePath);
    await mkdir(statePath);
    await writeFile(join(statePath, "saved"), saved);
    const next = create();
    await next.load();
    assert.equal(next.snapshot().loadError, "unreadable");
    assert.deepEqual(await capture(next, 2), { ok: false, reason: "unreadable" });
    await next.dispose();
    assert.deepEqual(await readFile(join(statePath, "saved")), saved);
    assert.deepEqual(await blobs(), before);
  });
});

test("does not treat stored captures as a new store", async () => {
  await withStore(async ({ statePath, create, capture, blobs }) => {
    const first = create();
    await first.load();
    await capture(first);
    await first.dispose();
    const before = await blobs();
    await rm(statePath);
    const next = create();
    await next.load();
    assert.equal(next.snapshot().loadError, "unreadable");
    await next.dispose();
    await assert.rejects(readFile(statePath), { code: "ENOENT" });
    assert.deepEqual(await blobs(), before);
  });
});

test("collects after a valid load", async () => {
  await withStore(async ({ root, create, capture, blobs }) => {
    const first = create();
    await first.load();
    const saved = await capture(first);
    await first.dispose();
    const orphan = createHash("sha256").update("orphan").digest("hex");
    await writeFile(join(root, "versions", orphan), "orphan");
    const next = create();
    await next.load();
    assert.equal((await blobs()).length, 1);
    const response = await next.protocolResponse(new Request(materialUrl(saved.materialId, null)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(64, 1));
  });
});

test("retains metadata for a missing capture", async () => {
  await withStore(async ({ root, statePath, create, capture, blobs }) => {
    const first = create();
    await first.load();
    const saved = await capture(first);
    await first.dispose();
    const [blob] = await blobs();
    const bytes = await readFile(join(root, "versions", blob));
    await rm(join(root, "versions", blob));
    const next = create();
    await next.load();
    await next.dispose();
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).materials[0]?.id, saved.materialId);
    assert.equal(next.snapshot().materials[0]?.state, "unreadable");
    await writeFile(join(root, "versions", blob), bytes);
    const recovered = create();
    await recovered.load();
    assert.equal(recovered.snapshot().materials[0]?.state, "ready");
  });
});

test("reclaims captures during the run", async () => {
  await withStore(async ({ create, capture, blobs }) => {
    const service = create();
    await service.load();
    const retained = await capture(service, 0);
    for (let index = 1; index <= 6; index += 1) {
      const added = await capture(service, index);
      assert.equal(added.ok, true);
      await service.remove(added.materialId);
      assert.equal((await blobs()).length, 1);
    }
    const response = await service.protocolResponse(new Request(materialUrl(retained.materialId, null)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(64));
  });
});

test("bounds unique blob storage", async () => {
  await withStore(async ({ create, capture, blobs }) => {
    const service = create();
    await service.load();
    const first = await capture(service, 1);
    const duplicate = await capture(service, 1);
    assert.equal(first.ok && duplicate.ok, true);
    assert.equal((await capture(service, 2)).ok, true);
    assert.deepEqual(await capture(service, 3), { ok: false, reason: "quota" });
    await service.remove(first.materialId);
    assert.equal((await blobs()).length, 2);
    assert.deepEqual(await capture(service, 3), { ok: false, reason: "quota" });
    await service.remove(duplicate.materialId);
    assert.equal((await capture(service, 3)).ok, true);
  });
});

test("failed persistence retains blobs and their budget", async () => {
  await withStore(async ({ root, statePath, create, capture, blobs }) => {
    const first = create();
    await first.load();
    const saved = await capture(first);
    await first.flush();
    await mkdir(`${statePath}.tmp`);
    await first.remove(saved.materialId);
    assert.equal((await blobs()).length, 1);
    assert.deepEqual(await capture(first, 2), { ok: false, reason: "quota" });
    const next = create();
    await next.load();
    const response = await next.protocolResponse(new Request(materialUrl(saved.materialId, null)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(64, 1));
    assert.equal((await readdir(join(root, "versions"))).length, 1);
    await rm(`${statePath}.tmp`, { recursive: true });
  }, 64);
});

test("serializes capture, removal and shutdown", async () => {
  await withStore(async ({ create, capture, blobs }) => {
    const first = create();
    await first.load();
    const old = await capture(first);
    const removed = first.remove(old.materialId);
    const pending = capture(first, 2);
    await first.dispose();
    await removed;
    const saved = await pending;
    assert.equal(saved.ok, true);
    const next = create();
    await next.load();
    assert.deepEqual(next.snapshot().materials.map((material) => material.id), [saved.materialId]);
    assert.equal((await blobs()).length, 1);
    const response = await next.protocolResponse(new Request(materialUrl(saved.materialId, null)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(64, 2));
  });
});
