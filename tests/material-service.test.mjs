import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MaterialService } from "../src/main/services/materials/MaterialService.ts";
import { materialUrl } from "../src/shared/materials.ts";
import { pngBytes, withMaterials } from "./material-fixtures.mjs";

async function until(read, predicate, timeoutMs = 3_000) {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() - started > timeoutMs) assert.fail(`condition not reached: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function only(service) {
  const { materials } = service.snapshot();
  assert.equal(materials.length, 1);
  return materials[0];
}

async function body(response) {
  return Buffer.from(await response.arrayBuffer());
}

test("dropped files become cards at the drop point; folders, missing and relative paths are refused", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    const notes = join(work, "notes.md");
    await writeFile(hero, pngBytes(1920, 1080, 16));
    await writeFile(notes, "# Brief\n");
    await mkdir(join(work, "assets"));
    const result = await service.addPaths([hero, notes, join(work, "assets"), join(work, "gone.png"), "relative.png", 7], { x: 500, y: 300 });
    assert.equal(result.added.length, 2);
    assert.deepEqual(result.rejected.map((entry) => entry.reason), ["not-a-file", "unreadable", "unreadable", "unreadable"]);
    const [image, file] = service.snapshot().materials;
    assert.deepEqual({ kind: image.kind, name: image.name, location: image.location, state: image.state },
      { kind: "image", name: "hero.png", location: hero, state: "ready" });
    assert.deepEqual(image.size, { width: 440, height: 302 });
    assert.equal(file.kind, "text");
    assert.deepEqual(image.position, { x: 500, y: 300 });
    assert.deepEqual(file.position, { x: 500 + 440 + 24, y: 300 });
    assert.deepEqual(await readFile(hero), pngBytes(1920, 1080, 16));
  });
});

test("unreadable images reject individually", { skip: process.platform === "win32" }, async () => {
  await withMaterials(async ({ work, service }) => {
    const readable = join(work, "notes.txt");
    const denied = join(work, "denied.png");
    await writeFile(readable, "keep");
    await writeFile(denied, pngBytes(4, 4));
    await chmod(denied, 0);
    try {
      const result = await service.addPaths([readable, denied], { x: 0, y: 0 });
      assert.equal(result.added.length, 1);
      assert.deepEqual(result.rejected, [{ name: "denied.png", reason: "unreadable" }]);
      assert.equal(only(service).location, readable);
    } finally {
      await chmod(denied, 0o600);
    }
  });
});

for (const replacement of ["symlink", "fifo"]) {
  test(`image ${replacement} races reject`, { skip: process.platform === "win32" }, async () => {
    await withMaterials(async ({ work, userData }) => {
      await writeFile(join(work, "notes.txt"), "keep");
      await writeFile(join(work, "hero.png"), pngBytes(4, 4));
      await writeFile(join(work, "other.png"), pngBytes(99, 99));
      const source = `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        import { execFileSync } from "node:child_process";
        import { join } from "node:path";
        import { MaterialService } from ${JSON.stringify(new URL("../src/main/services/materials/MaterialService.ts", import.meta.url).href)};
        const [work, userData, replacement] = process.argv.slice(1);
        const image = join(work, "hero.png");
        const original = fs.promises.open;
        let replaced = false;
        fs.promises.open = async (path, ...args) => {
          if (path === image && !replaced) {
            replaced = true;
            await fs.promises.unlink(image);
            if (replacement === "fifo") execFileSync("mkfifo", [image]);
            else await fs.promises.symlink(join(work, "other.png"), image);
          }
          return original(path, ...args);
        };
        syncBuiltinESMExports();
        const service = new MaterialService({userDataPath:userData,persist:()=>true,emit(){},pollIntervalMs:0,watchFactory:()=>({close(){}})});
        await service.load();
        const result = await service.addPaths([join(work, "notes.txt"), image], {x:0,y:0});
        await service.dispose();
        process.stdout.write(JSON.stringify(result));
      `;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, work, userData, replacement], { encoding: "utf8", timeout: 2_000 });
      assert.equal(child.status, 0, child.error?.code ?? child.stderr);
      const result = JSON.parse(child.stdout);
      assert.equal(result.added.length, 1);
      assert.deepEqual(result.rejected, [{ name: "hero.png", reason: "unreadable" }]);
    });
  });
}

for (const command of ["relink", "acceptMove"]) {
  test(`legacy files ${command}`, async () => {
    await withMaterials(async ({ work, userData, service, create, watch }) => {
      const original = join(work, "brief.md");
      const moved = join(work, "moved.md");
      await writeFile(original, "# Keep\n");
      await writeFile(join(work, "movie.mp4"), "video");
      await service.addPaths([original], { x: 10, y: 20 });
      const material = only(service);
      await service.pinVersion(material.id);
      const remark = (await service.addRemark({ materialId: material.id, anchor: { kind: "whole" }, reference: { materialId: material.id, anchor: { kind: "whole" } }, text: "keep" })).remark;
      await service.dispose();
      const statePath = join(userData, "materials", "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.materials[0].kind = "file";
      state.materials[0].mimeType = "application/octet-stream";
      for (const version of state.materials[0].versions) version.mimeType = "application/octet-stream";
      await writeFile(statePath, JSON.stringify(state));
      const restored = await create();
      assert.deepEqual(await restored.relink(material.id, join(work, "movie.mp4")), { ok: false, reason: "kind-mismatch" });
      await rename(original, moved);
      if (command === "acceptMove") {
        watch.fire(work);
        await until(() => only(restored).state, (value) => value === "moved");
      }
      const result = command === "acceptMove" ? await restored.acceptMove(material.id) : await restored.relink(material.id, moved);
      assert.deepEqual(result, { ok: true });
      assert.equal(only(restored).id, material.id);
      assert.equal(only(restored).kind, "text");
      assert.equal(only(restored).location, moved);
      assert.deepEqual(only(restored).versions.map((version) => version.id), state.materials[0].versions.map((version) => version.id));
      assert.deepEqual(restored.remark(remark.id), remark);
      assert.deepEqual(await body(await restored.protocolResponse(new Request(materialUrl(material.id, remark.target.versionId)))), Buffer.from("# Keep\n"));
    });
  });
}

test("file identity is stored as exact dev/ino strings and survives a rename", async () => {
  await withMaterials(async ({ work, service, watch, userData }) => {
    const hero = join(work, "hero.png");
    const moved = join(work, "hero-moved.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    await service.flush();
    const identity = JSON.parse(await readFile(join(userData, "materials/state.json"), "utf8")).materials[0].identity;
    assert.equal(typeof identity.dev, "string");
    assert.equal(typeof identity.ino, "string");
    assert.match(identity.dev, /^\d+$/);
    assert.match(identity.ino, /^\d+$/);

    await rename(hero, moved);
    watch.fire(work);
    await until(() => only(service).state, (state) => state === "moved");
    await service.acceptMove(only(service).id);
    await service.flush();
    const after = JSON.parse(await readFile(join(userData, "materials/state.json"), "utf8")).materials[0];
    assert.equal(after.name, "hero-moved.png");
    assert.deepEqual(after.identity, identity);
  });
});

test("legacy cards survive identity migration", async () => {
  for (const identity of [{ dev: 1, ino: 2 }, { dev: 1, ino: 9007199254740992 }]) {
    await withMaterials(async ({ work, service, userData, create }) => {
      await service.dispose();
      const state = JSON.parse(await readFile(new URL("./fixtures/material-state-v1.json", import.meta.url), "utf8"));
      state.materials[0].path = join(work, "missing.png");
      state.materials[0].identity = identity;
      const captured = state.materials[1];
      const version = captured.versions[0];
      await mkdir(join(userData, "materials/versions"), { recursive: true });
      await writeFile(join(userData, "materials/versions", version.sha256), pngBytes(4, 4));
      await writeFile(join(userData, "materials/state.json"), JSON.stringify(state));

      const restored = await create();
      const snapshot = restored.snapshot();
      assert.equal(snapshot.loadError, undefined);
      assert.deepEqual(snapshot.materials.map((material) => material.id), state.materials.map((material) => material.id));
      assert.deepEqual(await body(await restored.protocolResponse(new Request(materialUrl(captured.id, version.id)))), pngBytes(4, 4));
      const saved = JSON.parse(await readFile(join(userData, "materials/state.json"), "utf8"));
      assert.deepEqual(saved.materials[0].identity, identity.ino === 2 ? { dev: "1", ino: "2" } : null);
      const fresh = join(work, "fresh.png");
      await writeFile(fresh, pngBytes(8, 8));
      assert.equal((await restored.addPaths([fresh], { x: 0, y: 0 })).added.length, 1);
    });
  }
});

test("files past the canvas limit in one drop are reported, not dropped silently", async () => {
  await withMaterials(async ({ work, service }) => {
    const files = [];
    for (let index = 0; index < 258; index += 1) {
      const path = join(work, `${index}.png`);
      await writeFile(path, pngBytes(4, 4));
      files.push(path);
    }
    const result = await service.addPaths(files, { x: 0, y: 0 });
    assert.deepEqual(result.rejected, [{ name: "+2", reason: "limit" }]);
  });
});

test("the same file, dropped again or through a symlink, points at the existing card", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(10, 10));
    await symlink(hero, join(work, "alias.png"));
    const first = await service.addPaths([hero], { x: 0, y: 0 });
    const again = await service.addPaths([join(work, "alias.png"), hero], { x: 0, y: 0 });
    assert.deepEqual(again, { added: [], existing: [first.added[0]], rejected: [] });
    assert.equal(service.snapshot().materials.length, 1);
  });
});

test("a symlink disguised as an image is typed by its real target", async () => {
  await withMaterials(async ({ work, service }) => {
    const secret = join(work, "id_ed25519");
    await writeFile(secret, "PRIVATE KEY");
    await symlink(secret, join(work, "avatar.png"));
    await service.addPaths([join(work, "avatar.png")], { x: 0, y: 0 });
    const material = only(service);
    assert.equal(material.kind, "file");
    assert.equal(material.mimeType, "application/octet-stream");
    assert.equal(material.location, secret);
  });
});

test("the live file streams byte ranges with sandbox headers; unknown ids get nothing", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4, 6));
    await service.addPaths([hero], { x: 0, y: 0 });
    const material = only(service);
    const response = await service.protocolResponse(new Request(materialUrl(material.id, null, 1), {
      headers: { range: "bytes=1-3" }
    }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-range"), "bytes 1-3/39");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual([...await body(response)], [0x50, 0x4e, 0x47]);
    const unknown = await service.protocolResponse(new Request(materialUrl("99999999-9999-4999-8999-999999999999", null)));
    assert.equal(unknown.status, 404);
    const other = await service.protocolResponse(new Request("canvastty-media://x/y"));
    assert.equal(other.status, 400);
  });
});

test("a working file replaced by a symlink is no longer served", async () => {
  await withMaterials(async ({ work, service, watch }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await writeFile(join(work, "secret.txt"), "secret");
    await service.addPaths([hero], { x: 0, y: 0 });
    const material = only(service);
    await unlink(hero);
    await symlink(join(work, "secret.txt"), hero);
    const response = await service.protocolResponse(new Request(materialUrl(material.id, null, 2)));
    assert.equal(response.status, 404);
    watch.fire(work);
    await until(() => only(service).state, (state) => state === "unreadable");
  });
});

test("live changes bump the revision; deletion and a rename in the same folder have their own states", async () => {
  await withMaterials(async ({ work, service, watch }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    assert.deepEqual(watch.directories(), [work]);
    const before = only(service).liveRevision;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(hero, pngBytes(8, 8, 32));
    watch.fire(work);
    await until(() => only(service).liveRevision, (revision) => revision > before);
    assert.equal(only(service).byteSize, 65);

    await rename(hero, join(work, "hero-final.png"));
    watch.fire(work);
    const moved = await until(() => only(service), (material) => material.state === "moved");
    assert.equal(moved.movedTo, join(work, "hero-final.png"));
    assert.deepEqual(await service.acceptMove(moved.id), { ok: true });
    const relinked = only(service);
    assert.deepEqual({ state: relinked.state, name: relinked.name, location: relinked.location },
      { state: "ready", name: "hero-final.png", location: join(work, "hero-final.png") });

    await unlink(join(work, "hero-final.png"));
    watch.fire(work);
    await until(() => only(service).state, (state) => state === "missing");
    assert.equal(only(service).movedTo, null);
  });
});

test("relinking needs a readable file of the same kind that is not already on the canvas", async () => {
  await withMaterials(async ({ work, service }) => {
    await writeFile(join(work, "a.png"), pngBytes(4, 4));
    await writeFile(join(work, "b.png"), pngBytes(4, 4));
    await writeFile(join(work, "c.md"), "text");
    await service.addPaths([join(work, "a.png"), join(work, "b.png")], { x: 0, y: 0 });
    const [first] = service.snapshot().materials;
    assert.deepEqual(await service.relink(first.id, join(work, "c.md")), { ok: false, reason: "kind-mismatch" });
    assert.deepEqual(await service.relink(first.id, join(work, "b.png")), { ok: false, reason: "already-on-canvas" });
    assert.deepEqual(await service.relink(first.id, join(work, "none.png")), { ok: false, reason: "unreadable" });
    assert.deepEqual(await service.relink(first.id, work), { ok: false, reason: "not-a-file" });
  });
});

test("a pinned version keeps its bytes after the working file changes; identical content reuses it", async () => {
  await withMaterials(async ({ work, service, userData }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4, 1));
    await service.addPaths([hero], { x: 0, y: 0 });
    const id = only(service).id;
    const first = await service.pinVersion(id);
    assert.equal(first.ok, true);
    assert.equal(first.version.number, 1);
    const same = await service.pinVersion(id);
    assert.equal(same.version.id, first.version.id);

    await writeFile(hero, pngBytes(9, 9, 2));
    const second = await service.pinVersion(id);
    assert.equal(second.version.number, 2);
    const old = await service.protocolResponse(new Request(materialUrl(id, first.version.id)));
    assert.deepEqual(await body(old), pngBytes(4, 4, 1));
    const live = await service.protocolResponse(new Request(materialUrl(id, null, 5)));
    assert.deepEqual(await body(live), pngBytes(9, 9, 2));
    assert.equal((await readdir(join(userData, "materials", "versions"))).length, 2);
    assert.equal(service.snapshot().storage.usedBytes, 34 + 35);
  });
});

test("a touched or rewritten file with the same bytes stays the current version", async () => {
  await withMaterials(async ({ work, service, watch }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4, 1));
    await service.addPaths([hero], { x: 0, y: 0 });
    const id = only(service).id;
    await service.pinVersion(id);
    const settle = async () => {
      watch.fire(work);
      await new Promise((resolve) => setTimeout(resolve, 400));
    };
    await utimes(hero, new Date(), new Date(Date.now() + 5_000));
    await settle();
    assert.equal(only(service).versions[0].current, true);
    await writeFile(`${hero}.tmp`, pngBytes(4, 4, 1));
    await rename(`${hero}.tmp`, hero);
    await settle();
    assert.equal(only(service).versions[0].current, true);
    await writeFile(hero, pngBytes(5, 4, 1));
    await settle();
    assert.equal(only(service).versions[0].current, false);
  });
});

test("version storage is bounded and reports a full store instead of evicting", async () => {
  await withMaterials(async ({ work, service }) => {
    const big = join(work, "big.png");
    await writeFile(big, pngBytes(4, 4, 200));
    await service.addPaths([big], { x: 0, y: 0 });
    assert.deepEqual(await service.pinVersion(only(service).id), { ok: false, reason: "quota" });
    assert.equal(only(service).versions.length, 0);
  }, { storageLimitBytes: 100 });
});

test("a missing working file cannot be pinned", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    await unlink(hero);
    assert.deepEqual(await service.pinVersion(only(service).id), { ok: false, reason: "unavailable" });
  });
});

test("clipboard captures live only in CanvasTTY storage and are served from it", async () => {
  await withMaterials(async ({ service }) => {
    const bytes = pngBytes(640, 480, 5);
    const { materialId: id } = await service.addCapture({
      bytes,
      name: "clipboard-1.png",
      mimeType: "image/png",
      origin: { kind: "clipboard" },
      point: { x: 0, y: 0 },
      natural: { width: 640, height: 480 }
    });
    const material = only(service);
    assert.equal(material.id, id);
    assert.deepEqual({ location: material.location, state: material.state, versions: material.versions.map((v) => v.reason) },
      { location: null, state: "ready", versions: ["capture"] });
    assert.deepEqual(await body(await service.protocolResponse(new Request(materialUrl(id, null)))), bytes);
    assert.equal((await service.pinVersion(id)).version.reason, "capture");
  });
});

test("removing a card never touches the original and collects its versions", async () => {
  await withMaterials(async ({ work, service, userData, watch }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    await service.pinVersion(only(service).id);
    await service.remove(only(service).id);
    assert.equal(service.snapshot().materials.length, 0);
    assert.equal((await stat(hero)).isFile(), true);
    assert.deepEqual(await readdir(join(userData, "materials", "versions")), []);
    assert.deepEqual(watch.directories(), []);
  });
});

test("cards, bounds and versions survive a restart; with saving off the next start is empty", async () => {
  await withMaterials(async ({ work, service, create, setPersist }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    const id = only(service).id;
    service.setBounds(id, { position: { x: 12, y: 34 }, size: { width: 5, height: 5000 } });
    await service.pinVersion(id);
    await service.flush();

    const restored = await create();
    const material = only(restored);
    assert.deepEqual(material.position, { x: 12, y: 34 });
    assert.deepEqual(material.size, { width: 220, height: 1_800 });
    assert.equal(material.versions.length, 1);
    assert.equal(material.state, "ready");

    setPersist(false);
    await restored.flush();
    const empty = await create();
    assert.equal(empty.snapshot().materials.length, 0);
  });
});

test("bounds from the renderer are validated before they are stored", async () => {
  await withMaterials(async ({ work, service }) => {
    await writeFile(join(work, "a.png"), pngBytes(4, 4));
    await service.addPaths([join(work, "a.png")], { x: 0, y: 0 });
    const before = only(service);
    service.setBounds(before.id, { position: { x: Number.NaN, y: 0 }, size: { width: 300, height: 300 } });
    service.setBounds(before.id, "garbage");
    service.setBounds("unknown", { position: { x: 0, y: 0 }, size: { width: 300, height: 300 } });
    assert.deepEqual(only(service).position, before.position);
  });
});

test("a batch of bounds lands as one snapshot and keeps junk out", async () => {
  await withMaterials(async ({ work, service, snapshots }) => {
    await writeFile(join(work, "a.png"), pngBytes(4, 4));
    await writeFile(join(work, "b.png"), pngBytes(4, 4));
    await service.addPaths([join(work, "a.png")], { x: 0, y: 0 });
    await service.addPaths([join(work, "b.png")], { x: 40, y: 40 });
    const [first, second] = service.snapshot().materials;
    const before = snapshots.length;
    service.setBoundsBatch([
      { id: first.id, bounds: { position: { x: 10, y: 10 }, size: { width: 300, height: 300 } } },
      { id: second.id, bounds: { position: { x: 50, y: 50 }, size: { width: 300, height: 300 } } },
      { id: "unknown", bounds: { position: { x: 0, y: 0 }, size: { width: 300, height: 300 } } },
      { id: first.id, bounds: "garbage" }
    ]);
    assert.equal(snapshots.length, before + 1);
    const [movedFirst, movedSecond] = service.snapshot().materials;
    assert.deepEqual(movedFirst.position, { x: 10, y: 10 });
    assert.deepEqual(movedSecond.position, { x: 50, y: 50 });
    service.setBoundsBatch([{ id: first.id, bounds: "garbage" }]);
    assert.equal(snapshots.length, before + 1);
  });
});

test("remarks attach to the current version and can be updated and deleted", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    const id = only(service).id;

    const added = await service.addRemark({ materialId: id, anchor: { kind: "whole" }, reference: null, text: "first" });
    assert.equal(added.ok, true);
    assert.equal(added.remark.text, "first");
    assert.equal(added.remark.status, "open");
    assert.equal(only(service).versions.length, 1);

    const updated = await service.updateRemark(added.remark.id, { text: "second" });
    assert.equal(updated.ok, true);
    assert.equal(updated.remark.text, "second");

    await service.deleteRemark(added.remark.id);
    assert.equal(service.snapshot().remarks.length, 0);
  });
});

test("remark limits are enforced", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    await writeFile(hero, pngBytes(4, 4));
    await service.addPaths([hero], { x: 0, y: 0 });
    const id = only(service).id;
    for (let index = 0; index < 2_001; index += 1) {
      const result = await service.addRemark({ materialId: id, anchor: { kind: "whole" }, reference: null, text: `r${index}` });
      if (!result.ok) {
        assert.deepEqual(result, { ok: false, reason: "remark-limit" });
        return;
      }
    }
    assert.fail("expected remark-limit");
  });
});

test("a remark anchor on an image must fit the drawable kinds", async () => {
  await withMaterials(async ({ work, service }) => {
    const hero = join(work, "hero.png");
    const doc = join(work, "doc.md");
    await writeFile(hero, pngBytes(4, 4));
    await writeFile(doc, "text");
    await service.addPaths([hero, doc], { x: 0, y: 0 });
    const [image, file] = service.snapshot().materials;
    const imageRemark = await service.addRemark({ materialId: image.id, anchor: { kind: "point", x: 0.5, y: 0.5 }, reference: null, text: "ok" });
    assert.equal(imageRemark.ok, true);
    const fileRemark = await service.addRemark({ materialId: file.id, anchor: { kind: "whole" }, reference: null, text: "ok" });
    assert.equal(fileRemark.ok, true);
    const bad = await service.addRemark({ materialId: file.id, anchor: { kind: "point", x: 0.5, y: 0.5 }, reference: null, text: "no" });
    assert.deepEqual(bad, { ok: false, reason: "kind-mismatch" });
  });
});

test("collect keeps blobs while the state cannot be persisted", async () => {
  await withMaterials(async ({ service, userData, create }) => {
    const created = await service.addCapture({ bytes: pngBytes(4, 4, 1), name: "a.png", mimeType: "image/png", origin: { kind: "clipboard" }, point: { x: 0, y: 0 }, natural: { width: 4, height: 4 } });
    await service.flush();
    const blobs = async () => await readdir(join(userData, "materials", "versions")).catch(() => []);
    assert.equal((await blobs()).length > 0, true);
    await mkdir(join(userData, "materials", "state.json.tmp"));
    await service.remove(created.materialId);
    assert.equal((await blobs()).length > 0, true, "the blob survives while state.json.tmp is blocked");
    await rm(join(userData, "materials", "state.json.tmp"), { recursive: true });
    const restarted = await create();
    assert.equal(restarted.snapshot().materials.length, 1, "the removal was not persisted either");
  });
});
