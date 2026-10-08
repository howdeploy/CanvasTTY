import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MaterialService } from "../src/main/services/materials/MaterialService.ts";
import { materialUrl } from "../src/shared/materials.ts";

function pngBytes(width, height, extra = 0) {
  const bytes = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function withService(run) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-clipboard-"));
  const userData = join(root, "user-data");
  const snapshots = [];
  const service = new MaterialService({
    userDataPath: userData,
    persist: () => true,
    emit: (snapshot) => snapshots.push(snapshot),
    pollIntervalMs: 0
  });
  await service.load();
  try {
    await run({ service, snapshots, userData });
  } finally {
    await service.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function body(response) {
  return Buffer.from(await response.arrayBuffer());
}

test("pasting a PNG from the clipboard creates a ready image card with clipboard origin", async () => {
  await withService(async ({ service }) => {
    const bytes = pngBytes(40, 30);
    const created = await service.addCapture({
      bytes,
      name: "clipboard-20260101-120000.png",
      mimeType: "image/png",
      origin: { kind: "clipboard" },
      point: { x: 100, y: 200 },
      natural: { width: 40, height: 30 }
    });
    assert.equal(created.ok, true);
    const material = service.snapshot().materials[0];
    assert.equal(material.kind, "image");
    assert.equal(material.origin.kind, "clipboard");
    assert.equal(material.state, "ready");
    assert.equal(material.location, null);
    assert.equal(material.byteSize, bytes.length);
    assert.ok(material.position.x > 0 || material.position.y > 0);

    const response = await service.protocolResponse(new Request(materialUrl(material.id, null, material.liveRevision)));
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), bytes);
  });
});

test("pasting the same PNG twice creates two independent cards", async () => {
  await withService(async ({ service }) => {
    const bytes = pngBytes(10, 10);
    const first = await service.addCapture({
      bytes,
      name: "clipboard-20260101-120001.png",
      mimeType: "image/png",
      origin: { kind: "clipboard" },
      point: { x: 0, y: 0 }
    });
    const second = await service.addCapture({
      bytes,
      name: "clipboard-20260101-120002.png",
      mimeType: "image/png",
      origin: { kind: "clipboard" },
      point: { x: 0, y: 0 }
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.materialId, second.materialId);
    assert.equal(service.snapshot().materials.length, 2);
  });
});

test("a capture survives a service restart when persistence is on", async () => {
  await withService(async ({ service, userData }) => {
    const bytes = pngBytes(20, 20);
    const created = await service.addCapture({
      bytes,
      name: "clipboard-20260101-120003.png",
      mimeType: "image/png",
      origin: { kind: "clipboard" },
      point: { x: 50, y: 60 }
    });
    assert.equal(created.ok, true);
    const id = created.materialId;
    await service.flush();

    const next = new MaterialService({
      userDataPath: userData,
      persist: () => true,
      emit: () => undefined,
      pollIntervalMs: 0
    });
    await next.load();
    try {
      const materials = next.snapshot().materials;
      assert.equal(materials.length, 1);
      assert.equal(materials[0].id, id);
      assert.equal(materials[0].state, "ready");
      assert.equal(materials[0].origin.kind, "clipboard");
      const response = await next.protocolResponse(new Request(materialUrl(id, null, materials[0].liveRevision)));
      assert.equal(response.status, 200);
      assert.deepEqual(await body(response), bytes);
    } finally {
      await next.dispose().catch(() => undefined);
    }
  });
});

test("a capture is discarded when persistence is off", async () => {
  await withService(async ({ userData }) => {
    const transient = new MaterialService({
      userDataPath: userData,
      persist: () => false,
      emit: () => undefined,
      pollIntervalMs: 0
    });
    await transient.load();
    try {
      const created = await transient.addCapture({
        bytes: pngBytes(8, 8),
        name: "clipboard-20260101-120004.png",
        mimeType: "image/png",
        origin: { kind: "clipboard" },
        point: { x: 0, y: 0 }
      });
      assert.equal(created.ok, true);
    } finally {
      await transient.dispose().catch(() => undefined);
    }

    const next = new MaterialService({
      userDataPath: userData,
      persist: () => true,
      emit: () => undefined,
      pollIntervalMs: 0
    });
    await next.load();
    try {
      assert.equal(next.snapshot().materials.length, 0);
    } finally {
      await next.dispose().catch(() => undefined);
    }
  });
});

test("the canvas pastes materials only on the Cmd/Ctrl chord", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  assert.match(source, /\} else if \(\(event\.ctrlKey \|\| event\.metaKey\) && !event\.altKey && matchesPhysicalOrLayoutKey\(event, "KeyV", "v"\)/);
});
