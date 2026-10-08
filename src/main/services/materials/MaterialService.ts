import { randomUUID } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type {
  CanvasMaterial,
  MaterialCreateResult,
  MaterialFailure,
  MaterialOrigin,
  MaterialRemark,
  MaterialResult,
  MaterialsAddResult,
  MaterialsSnapshot,
  MaterialState,
  MaterialVersion,
  MaterialVersionReason,
  MaterialVersionResult,
  Point,
  RemarkAnchor,
  RemarkDraft,
  RemarkPatch,
  RemarkResult,
  RemarkTarget,
  SessionBounds,
  Size
} from "../../../shared/contracts.ts";
import {
  clampSize,
  MATERIAL_LIMIT,
  MATERIAL_SCHEME,
  MATERIAL_STORAGE_LIMIT,
  MATERIAL_VERSION_LIMIT,
  MATERIAL_VERSION_MAX_BYTES,
  materialCardSize,
  materialsAtPoint,
  materialType,
  REMARK_TEXT_LIMIT
} from "../../../shared/materials.ts";
import { streamFile, textResponse } from "../fileResponse.ts";
import { IMAGE_HEADER_BYTES, imageDimensions } from "./imageDimensions.ts";
import {
  emptyMaterialState,
  MATERIAL_STATE_VERSION,
  normalizeAnchor,
  restoreMaterialState,
  REMARK_LIMIT,
  type StoredFileIdentity,
  type StoredMaterial,
  type StoredVersion
} from "./materialState.ts";
import { DirectoryWatchSet, nodeWatchFactory, type WatchFactory } from "./materialWatch.ts";
import { fileDigest, MaterialBlobError, MaterialBlobs } from "./MaterialBlobs.ts";

const MAX_NAME = 255;
const MATERIAL_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const PERSIST_DELAY_MS = 250;
const REFRESH_DELAY_MS = 150;
const POLL_INTERVAL_MS = 10_000;
const RENAME_SCAN_LIMIT = 5_000;
const RESPONSE_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff"
};

export interface MaterialServiceOptions {
  userDataPath: string;
  persist(): boolean;
  emit(snapshot: MaterialsSnapshot): void;
  watchFactory?: WatchFactory;
  now?(): number;
  pollIntervalMs?: number;
  storageLimitBytes?: number;
}

interface LiveState {
  state: MaterialState;
  signature: string | null;
  byteSize: number | null;
  modifiedAt: number | null;
  revision: number;
  movedTo: string | null;
}

interface MaterialCaptureInput {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  origin: MaterialOrigin;
  point: Point;
  natural?: Size | null;
}

export class MaterialService {
  private readonly options: MaterialServiceOptions;
  private readonly root: string;
  private readonly statePath: string;
  private readonly blobs: MaterialBlobs;
  private readonly materials = new Map<string, StoredMaterial>();
  private remarks: MaterialRemark[] = [];
  private counters = { remark: 0 };
  private readonly live = new Map<string, LiveState>();
  private readonly watchers: DirectoryWatchSet;
  private readonly pendingRefresh = new Set<string>();
  private readonly storageLimit: number;
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private writeQueue: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private loading: Promise<void> | null = null;
  private disposing: Promise<void> | null = null;
  private writable = false;
  private loadError: "unreadable" | undefined;
  private disposed = false;

  constructor(options: MaterialServiceOptions) {
    this.options = options;
    this.root = join(options.userDataPath, "materials");
    this.statePath = join(this.root, "state.json");
    this.blobs = new MaterialBlobs(join(this.root, "versions"));
    this.storageLimit = options.storageLimitBytes ?? MATERIAL_STORAGE_LIMIT;
    this.watchers = new DirectoryWatchSet(options.watchFactory ?? nodeWatchFactory, (ids) => this.scheduleRefresh(ids));
  }

  load(): Promise<void> {
    this.loading ??= this.restore();
    return this.loading;
  }

  private async restore(): Promise<void> {
    let state = emptyMaterialState();
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      state = restoreMaterialState(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      const newStore = Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        && await this.blobs.usedBytes().then((bytes) => bytes === 0, () => false);
      if (!newStore) {
        console.warn("CanvasTTY materials could not be loaded and are left on disk as they are.", error);
        this.loadError = "unreadable";
        this.changed(false);
        return;
      }
    }
    if (!this.options.persist()) state = emptyMaterialState();
    for (const material of state.materials) {
      this.materials.set(material.id, material);
    }
    this.remarks = state.remarks
      .filter((remark) => this.materials.has(remark.target.materialId))
      .map((remark) => remark.reference && !this.hasVersion(remark.reference.materialId, remark.reference.versionId) ? { ...remark, reference: null } : remark);
    this.counters = state.counters;
    this.writable = true;
    await this.collect();
    if (this.disposed) return;
    for (const material of this.materials.values()) {
      await this.refreshLive(material);
      if (this.disposed) return;
      this.watchers.track(material.id, material.path);
    }
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    if (interval > 0) {
      this.pollTimer = setInterval(() => {
        this.watchers.retry();
        this.scheduleRefresh([...this.materials.keys()]);
      }, interval);
      this.pollTimer.unref?.();
    }
    this.changed(false);
  }

  snapshot(): MaterialsSnapshot {
    return {
      revision: this.revision,
      ...(this.loadError ? { loadError: this.loadError } : {}),
      materials: [...this.materials.values()].map((material) => this.publicMaterial(material)),
      remarks: structuredClone(this.remarks),
      storage: { usedBytes: this.usedBytes(), limitBytes: this.storageLimit }
    };
  }

  location(id: string): string | null {
    return this.materials.get(id)?.path ?? null;
  }

  addPaths(paths: readonly unknown[], point: unknown): Promise<MaterialsAddResult> {
    return this.serial(async () => {
      const result: MaterialsAddResult = { added: [], existing: [], rejected: [] };
      if (!this.writable) {
        result.rejected = paths.slice(0, MATERIAL_LIMIT).map((path) => ({
          name: typeof path === "string" ? displayName(path) : "file", reason: "unreadable"
        }));
        return result;
      }
      const fresh: StoredMaterial[] = [];
      const infos = new Map<string, BigIntStats>();
      if (paths.length > MATERIAL_LIMIT) {
        result.rejected.push({ name: `+${paths.length - MATERIAL_LIMIT}`, reason: "limit" });
      }
      for (const candidate of paths.slice(0, MATERIAL_LIMIT)) {
        const name = typeof candidate === "string" ? displayName(candidate) : "file";
        if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\0")) {
          result.rejected.push({ name, reason: "unreadable" });
          continue;
        }
        let resolved: string;
        let info: BigIntStats;
        try {
          resolved = await realpath(candidate);
          info = await stat(resolved, { bigint: true });
        } catch {
          result.rejected.push({ name, reason: "unreadable" });
          continue;
        }
        if (!info.isFile()) {
          result.rejected.push({ name, reason: "not-a-file" });
          continue;
        }
        const existing = this.findByPath(resolved) ?? fresh.find((material) => material.path === resolved);
        if (existing) {
          if (!result.existing.includes(existing.id)) result.existing.push(existing.id);
          continue;
        }
        if (this.materials.size + fresh.length >= MATERIAL_LIMIT) {
          result.rejected.push({ name, reason: "limit" });
          continue;
        }
        const type = materialType(basename(resolved));
        const kind = type.kind === "image" ? "image" : "file";
        const natural = kind === "image" ? await readImageDimensions(resolved) : null;
        const material: StoredMaterial = {
          id: randomUUID(),
          kind,
          name,
          mimeType: kind === "image" ? type.mimeType : "application/octet-stream",
          position: { x: 0, y: 0 },
          size: materialCardSize(kind, natural),
          path: resolved,
          identity: fileIdentity(info),
          origin: null,
          createdAt: this.now(),
          versions: [],
          nextVersion: 1
        };
        fresh.push(material);
        infos.set(material.id, info);
      }
      const placed = materialsAtPoint(fresh.map((material) => material.size), finitePoint(point));
      fresh.forEach((material, index) => {
        material.position = placed[index].position;
        this.materials.set(material.id, material);
        const info = infos.get(material.id)!;
        this.live.set(material.id, {
          state: "ready",
          signature: signatureOf(info),
          byteSize: Number(info.size),
          modifiedAt: Number(info.mtimeMs),
          revision: 1,
          movedTo: null
        });
        this.watchers.track(material.id, material.path);
        result.added.push(material.id);
      });
      if (fresh.length > 0) this.changed();
      return result;
    });
  }

  addCapture(input: MaterialCaptureInput): Promise<MaterialCreateResult> {
    return this.serial(async () => {
      if (!this.writable) return failure("unreadable");
      if (this.materials.size >= MATERIAL_LIMIT) return failure("material-limit");
      let blob;
      try {
        blob = await this.blobs.writeFromBytes(input.bytes, MATERIAL_CAPTURE_MAX_BYTES, await this.availableBytes());
      } catch (error) {
        return failure(blobFailure(error));
      }
      const type = materialType(input.name);
      const createdAt = this.now();
      const size = materialCardSize(type.kind, input.natural ?? null);
      const [placed] = materialsAtPoint([size], finitePoint(input.point));
      const material: StoredMaterial = {
        id: randomUUID(),
        kind: type.kind,
        name: displayName(input.name),
        mimeType: input.mimeType,
        position: placed.position,
        size,
        path: null,
        identity: null,
        origin: input.origin,
        createdAt,
        versions: [{
          id: randomUUID(),
          number: 1,
          sha256: blob.sha256,
          byteSize: blob.byteSize,
          mimeType: input.mimeType,
          createdAt,
          reason: "capture",
          signature: blob.sha256,
          natural: type.kind === "image" ? input.natural ?? null : null
        }],
        nextVersion: 2
      };
      this.materials.set(material.id, material);
      await this.refreshLive(material);
      this.changed();
      return { ok: true, materialId: material.id };
    });
  }

  setBounds(id: string, bounds: unknown): void {
    if (!this.writable || this.disposed) return;
    const material = this.materials.get(id);
    if (!material || !isBounds(bounds)) return;
    material.position = { x: bounds.position.x, y: bounds.position.y };
    material.size = clampSize(bounds.size);
    this.changed();
  }

  setBoundsBatch(entries: unknown): void {
    if (!this.writable || this.disposed) return;
    if (!Array.isArray(entries)) return;
    let any = false;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const { id, bounds } = entry as { id?: unknown; bounds?: unknown };
      const material = typeof id === "string" ? this.materials.get(id) : undefined;
      if (!material || !isBounds(bounds)) continue;
      material.position = { x: bounds.position.x, y: bounds.position.y };
      material.size = clampSize(bounds.size);
      any = true;
    }
    if (any) this.changed();
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (!this.materials.delete(id)) return;
      this.remarks = this.remarks
        .filter((remark) => remark.target.materialId !== id)
        .map((remark) => remark.reference?.materialId === id ? { ...remark, reference: null } : remark);
      this.live.delete(id);
      this.pendingRefresh.delete(id);
      this.watchers.untrack(id);
      await this.collect();
      this.changed();
    });
  }

  pinVersion(id: string, reason: MaterialVersionReason = "pinned"): Promise<MaterialVersionResult> {
    return this.serial(() => this.createVersion(id, reason));
  }

  addRemark(draft: unknown): Promise<RemarkResult> {
    return this.serial(async () => {
      const parsed = parseRemarkDraft(draft);
      if (!parsed || !this.materials.has(parsed.materialId)) return failure("unavailable");
      if (parsed.reference && !this.materials.has(parsed.reference.materialId)) return failure("unavailable");
      if (!anchorFits(this.materials.get(parsed.materialId)!, parsed.anchor)) return failure("kind-mismatch");
      if (parsed.reference && !anchorFits(this.materials.get(parsed.reference.materialId)!, parsed.reference.anchor)) {
        return failure("kind-mismatch");
      }
      if (this.remarks.length >= REMARK_LIMIT) return failure("remark-limit");
      if (!await this.versionable(parsed.materialId) || (parsed.reference && !await this.versionable(parsed.reference.materialId))) {
        return failure("unavailable");
      }
      const target = await this.createVersion(parsed.materialId, "remark");
      if (!target.ok) return target;
      let reference: RemarkTarget | null = null;
      if (parsed.reference) {
        const referenceVersion = await this.createVersion(parsed.reference.materialId, "remark");
        if (!referenceVersion.ok) return referenceVersion;
        reference = {
          materialId: parsed.reference.materialId,
          versionId: referenceVersion.version.id,
          anchor: parsed.reference.anchor
        };
      }
      const now = this.now();
      this.counters.remark += 1;
      const remark: MaterialRemark = {
        id: randomUUID(),
        number: this.counters.remark,
        target: { materialId: parsed.materialId, versionId: target.version.id, anchor: parsed.anchor },
        reference,
        text: parsed.text,
        status: "open",
        createdAt: now,
        updatedAt: now,
        handoffIds: [],
        report: null
      };
      this.remarks.push(remark);
      this.changed();
      return { ok: true, remark: structuredClone(remark) };
    });
  }

  updateRemark(id: string, patch: unknown): Promise<RemarkResult> {
    return this.serial(async () => {
      const remark = this.remarks.find((candidate) => candidate.id === id);
      const parsed = parseRemarkPatch(patch);
      if (!remark || !parsed) return failure("unavailable");
      if (parsed.text !== undefined && remark.status !== "open" && remark.status !== "reopened") return failure("unavailable");
      if (parsed.status !== undefined && !remarkTransitionAllowed(remark.status, parsed.status)) return failure("unavailable");
      if (parsed.text !== undefined) remark.text = parsed.text;
      if (parsed.status !== undefined) remark.status = parsed.status;
      remark.updatedAt = this.now();
      this.changed();
      return { ok: true, remark: structuredClone(remark) };
    });
  }

  deleteRemark(id: string): Promise<void> {
    return this.serial(async () => {
      const before = this.remarks.length;
      this.remarks = this.remarks.filter((remark) => remark.id !== id);
      if (this.remarks.length !== before) this.changed();
    });
  }

  relink(id: string, candidate: unknown): Promise<MaterialResult> {
    return this.serial(() => this.relinkTo(id, candidate, false));
  }

  acceptMove(id: string): Promise<MaterialResult> {
    return this.serial(async () => {
      const movedTo = this.live.get(id)?.movedTo;
      return movedTo ? this.relinkTo(id, movedTo, true) : failure("unavailable");
    });
  }

  private async relinkTo(id: string, candidate: unknown, sameFileOnly: boolean): Promise<MaterialResult> {
    const material = this.materials.get(id);
    if (!material || material.path === null) return failure("unavailable");
    if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\0")) return failure("unreadable");
    let resolved: string;
    let info: BigIntStats;
    try {
      resolved = await realpath(candidate);
      info = await stat(resolved, { bigint: true });
    } catch {
      return failure("unreadable");
    }
    if (!info.isFile()) return failure("not-a-file");
    if (sameFileOnly && (resolved !== candidate || !sameFile(info, material.identity))) return failure("unreadable");
    const other = this.findByPath(resolved);
    if (other && other.id !== id) return failure("already-on-canvas");
    const name = displayName(candidate);
    const type = materialType(basename(resolved));
    const kind = type.kind === "image" ? "image" : "file";
    if (kind !== material.kind) return failure("kind-mismatch");
    material.path = resolved;
    material.name = name;
    material.mimeType = kind === "image" ? type.mimeType : "application/octet-stream";
    material.identity = fileIdentity(info);
    this.watchers.track(id, resolved);
    await this.refreshLive(material, true);
    this.changed();
    return { ok: true };
  }

  async protocolResponse(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.protocol !== `${MATERIAL_SCHEME}:`) return textResponse("Unsupported protocol.", 400);
      const material = this.materials.get(decodeURIComponent(url.hostname));
      if (!material) return textResponse("Material is unavailable.", 404);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "live" && parts.length === 1) {
        if (material.path === null) {
          const latest = material.versions.at(-1);
          return latest
            ? await streamFile(request, this.blobs.pathOf(latest.sha256), latest.mimeType, RESPONSE_HEADERS)
            : textResponse("Material is unavailable.", 404);
        }
        const resolved = await realpath(material.path);
        const info = await stat(resolved);
        if (resolved !== material.path || !info.isFile()) return textResponse("Material is unavailable.", 404);
        return await streamFile(request, resolved, material.mimeType, RESPONSE_HEADERS);
      }
      if (parts[0] === "v" && parts.length === 2) {
        const version = material.versions.find((candidate) => candidate.id === parts[1]);
        if (version) return await streamFile(request, this.blobs.pathOf(version.sha256), version.mimeType, RESPONSE_HEADERS);
      }
      return textResponse("Material is unavailable.", 404);
    } catch {
      return textResponse("Material is unavailable.", 404);
    }
  }

  async flush(strict = false): Promise<void> {
    await this.loading;
    await this.queue;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.writeState(strict);
  }

  dispose(): Promise<void> {
    this.disposing ??= this.close();
    return this.disposing;
  }

  private async close(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    await this.flush();
    this.watchers.close();
    if (this.writable && !this.options.persist()) await this.collect();
  }

  private scheduleRefresh(ids: readonly string[]): void {
    if (this.disposed) return;
    for (const id of ids) this.pendingRefresh.add(id);
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const pending = [...this.pendingRefresh];
      this.pendingRefresh.clear();
      void this.serial(async () => {
        let any = false;
        for (const id of pending) {
          const material = this.materials.get(id);
          if (material && await this.refreshLive(material)) any = true;
        }
        if (any) this.changed(false);
      });
    }, REFRESH_DELAY_MS);
    this.refreshTimer.unref?.();
  }

  private async refreshLive(material: StoredMaterial, forceRevision = false): Promise<boolean> {
    const previous = this.live.get(material.id);
    const next = material.path === null
      ? await this.blobs.has(material.versions.at(-1)?.sha256 ?? "")
        ? captureLive(material)
        : unavailable("unreadable", previous)
      : await inspectWorkingFile(material, previous);
    const changedContent = next.signature !== (previous?.signature ?? null);
    const latest = material.versions.at(-1);
    if (changedContent && material.path !== null && next.state === "ready" && latest && latest.signature !== next.signature
      && latest.byteSize === next.byteSize && await fileDigest(material.path, latest.byteSize) === latest.sha256) {
      latest.signature = next.signature;
    }
    const revision = previous
      ? previous.revision + (changedContent || forceRevision ? 1 : 0)
      : Math.max(1, next.revision);
    const updated: LiveState = { ...next, revision };
    if (next.state === "ready" && material.path !== null && next.identity) material.identity = next.identity;
    this.live.set(material.id, updated);
    return !previous
      || previous.state !== updated.state
      || previous.revision !== updated.revision
      || previous.movedTo !== updated.movedTo;
  }

  private async createVersion(id: string, reason: MaterialVersionReason): Promise<MaterialVersionResult> {
    const material = this.materials.get(id);
    if (!material) return failure("unavailable");
    const latest = material.versions.at(-1);
    if (material.path === null) {
      const kept = material.versions.at(-1);
      return kept ? { ok: true, version: this.publicVersion(material, kept) } : failure("unavailable");
    }
    await this.refreshLive(material);
    const live = this.live.get(id);
    if (live?.state !== "ready") return failure("unavailable");
    if (latest && latest.signature !== null && latest.signature === live.signature) {
      if (reason === "pinned" && latest.reason !== "pinned") {
        latest.reason = "pinned";
        this.changed();
      }
      return { ok: true, version: this.publicVersion(material, latest) };
    }
    let blob;
    try {
      blob = await this.blobs.writeFromFile(material.path, MATERIAL_VERSION_MAX_BYTES, await this.availableBytes());
    } catch (error) {
      return failure(blobFailure(error));
    }
    if (latest && latest.sha256 === blob.sha256) {
      latest.signature = live.signature;
      if (reason === "pinned" && latest.reason !== "pinned") {
        latest.reason = "pinned";
        this.changed();
      }
      return { ok: true, version: this.publicVersion(material, latest) };
    }
    if (material.versions.length >= MATERIAL_VERSION_LIMIT && !this.prunableVersion(material)) {
      await this.collect();
      return failure("version-limit");
    }
    const version: StoredVersion = {
      id: randomUUID(),
      number: material.nextVersion,
      sha256: blob.sha256,
      byteSize: blob.byteSize,
      mimeType: material.mimeType,
      createdAt: this.now(),
      reason,
      signature: live.signature,
      natural: material.kind === "image" ? await readImageDimensions(this.blobs.pathOf(blob.sha256)) : null
    };
    material.nextVersion += 1;
    material.versions.push(version);
    while (material.versions.length > MATERIAL_VERSION_LIMIT) {
      const prunable = this.prunableVersion(material);
      if (!prunable) break;
      material.versions = material.versions.filter((candidate) => candidate !== prunable);
    }
    await this.collect();
    this.changed();
    return { ok: true, version: this.publicVersion(material, version) };
  }

  private prunableVersion(material: StoredMaterial): StoredVersion | null {
    const kept = new Set<string>();
    for (const remark of this.remarks) {
      kept.add(remark.target.versionId);
      if (remark.reference) kept.add(remark.reference.versionId);
    }
    return material.versions.find((version) => version.reason !== "pinned" && !kept.has(version.id)) ?? null;
  }

  private async versionable(id: string): Promise<boolean> {
    const material = this.materials.get(id);
    if (!material) return false;
    if (material.path === null) return material.versions.length > 0;
    await this.refreshLive(material);
    return this.live.get(id)?.state === "ready";
  }

  private publicMaterial(material: StoredMaterial): CanvasMaterial {
    const live = this.live.get(material.id);
    return {
      id: material.id,
      kind: material.kind,
      name: material.name,
      mimeType: material.mimeType,
      position: { ...material.position },
      size: { ...material.size },
      location: material.path,
      state: live?.state ?? "unreadable",
      movedTo: live?.movedTo ?? null,
      liveRevision: live?.revision ?? 1,
      byteSize: live?.byteSize ?? null,
      modifiedAt: live?.modifiedAt ?? null,
      origin: material.origin ? structuredClone(material.origin) : null,
      versions: material.versions.map((version) => this.publicVersion(material, version)),
      createdAt: material.createdAt
    };
  }

  private publicVersion(material: StoredMaterial, version: StoredVersion): MaterialVersion {
    const live = this.live.get(material.id);
    const current = material.path === null
      ? material.versions.at(-1)?.id === version.id
      : live?.state === "ready" && version.signature !== null && live.signature === version.signature;
    return {
      id: version.id,
      number: version.number,
      createdAt: version.createdAt,
      byteSize: version.byteSize,
      reason: version.reason,
      current,
      natural: version.natural ? { ...version.natural } : null
    };
  }

  private hasVersion(materialId: string, versionId: string): boolean {
    return this.materials.get(materialId)?.versions.some((version) => version.id === versionId) ?? false;
  }

  private findByPath(path: string): StoredMaterial | undefined {
    for (const material of this.materials.values()) if (material.path === path) return material;
    return undefined;
  }

  private changed(persist = true): void {
    this.revision += 1;
    if (persist) this.schedulePersist();
    this.options.emit(this.snapshot());
  }

  private schedulePersist(): void {
    if (this.disposed || !this.writable) return;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.writeState();
    }, PERSIST_DELAY_MS);
    this.persistTimer.unref?.();
  }

  private writeState(strict = false): Promise<void> {
    if (!this.writable) return strict ? Promise.reject(new Error("CanvasTTY materials state is not writable.")) : this.writeQueue;
    const state = this.options.persist()
      ? { version: MATERIAL_STATE_VERSION, materials: [...this.materials.values()], remarks: this.remarks, counters: this.counters }
      : emptyMaterialState();
    const snapshot = JSON.stringify(state);
    const temporary = `${this.statePath}.tmp`;
    const write = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    this.writeQueue = write.catch((error) => {
      console.warn("CanvasTTY materials could not be saved.", error);
    });
    return strict ? write : this.writeQueue;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("CanvasTTY materials are closed."));
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private usedBytes(): number {
    const sizes = new Map<string, number>();
    for (const material of this.materials.values()) {
      for (const version of material.versions) sizes.set(version.sha256, version.byteSize);
    }
    let total = 0;
    for (const size of sizes.values()) total += size;
    return total;
  }

  private async availableBytes(): Promise<number> {
    return Math.max(0, this.storageLimit - await this.blobs.usedBytes());
  }

  private async collect(): Promise<void> {
    try {
      await this.writeState(true);
    } catch {
      return;
    }
    await this.blobs.collect(this.disposed && !this.options.persist() ? new Set() : this.referencedHashes());
  }

  private referencedHashes(): Set<string> {
    const hashes = new Set<string>();
    for (const material of this.materials.values()) {
      for (const version of material.versions) hashes.add(version.sha256);
    }
    return hashes;
  }
}

interface InspectedLive extends Omit<LiveState, "revision"> {
  revision: number;
  identity?: StoredFileIdentity;
}

async function inspectWorkingFile(material: StoredMaterial, previous: LiveState | undefined): Promise<InspectedLive> {
  const path = material.path!;
  try {
    const resolved = await realpath(path);
    const info = await stat(resolved, { bigint: true });
    if (!info.isFile()) return unavailable("unreadable", previous);
    if (resolved !== path) {
      const entry = await lstat(path).catch(() => null);
      return entry?.isFile() && sameFile(info, material.identity)
        ? { ...unavailable("moved", previous), movedTo: resolved }
        : unavailable("unreadable", previous);
    }
    return {
      state: "ready",
      signature: signatureOf(info),
      byteSize: Number(info.size),
      modifiedAt: Number(info.mtimeMs),
      revision: 1,
      movedTo: null,
      identity: fileIdentity(info)
    };
  } catch (error) {
    if (!isMissing(error)) return unavailable("unreadable", previous);
    const movedTo = await renamedTo(material, previous);
    return { ...unavailable(movedTo ? "moved" : "missing", previous), movedTo };
  }
}

async function renamedTo(material: StoredMaterial, previous: LiveState | undefined): Promise<string | null> {
  if (!material.identity) return null;
  if (previous?.state === "moved" && previous.movedTo) {
    const info = await stat(previous.movedTo, { bigint: true }).catch(() => null);
    return info?.isFile() && sameFile(info, material.identity) ? previous.movedTo : null;
  }
  if (previous && previous.state !== "ready") return null;
  return findRenamed(dirname(material.path!), material.identity);
}

function unavailable(state: MaterialState, previous: LiveState | undefined): InspectedLive {
  return {
    state,
    signature: null,
    byteSize: null,
    modifiedAt: previous?.modifiedAt ?? null,
    revision: 1,
    movedTo: null
  };
}

async function findRenamed(directory: string, identity: StoredFileIdentity): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  for (const entry of entries.slice(0, RENAME_SCAN_LIMIT)) {
    const candidate = join(directory, entry);
    try {
      const info = await stat(candidate, { bigint: true });
      if (info.isFile() && sameFile(info, identity)) return await realpath(candidate) === candidate ? candidate : null;
    } catch {
      continue;
    }
  }
  return null;
}

async function readImageDimensions(path: string): Promise<Size | null> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await open(path, flags);
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return imageDimensions(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function signatureOf(info: BigIntStats): string {
  return `${info.size}:${info.mtimeNs}:${info.ino}`;
}

function fileIdentity(info: BigIntStats): StoredFileIdentity {
  return { dev: String(info.dev), ino: String(info.ino) };
}

function sameFile(info: BigIntStats, identity: StoredFileIdentity | null): boolean {
  return identity !== null && String(info.dev) === identity.dev && String(info.ino) === identity.ino;
}

function displayName(path: string): string {
  return (basename(path) || "file").slice(0, MAX_NAME);
}

function finitePoint(value: unknown): Point {
  if (value && typeof value === "object") {
    const { x, y } = value as Partial<Point>;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return { x: 0, y: 0 };
}

function isBounds(value: unknown): value is SessionBounds {
  if (!value || typeof value !== "object") return false;
  const { position, size } = value as Partial<SessionBounds>;
  return Boolean(position && size)
    && [position!.x, position!.y, size!.width, size!.height].every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function captureLive(material: StoredMaterial): InspectedLive {
  const latest = material.versions.at(-1);
  return {
    state: latest ? "ready" : "unreadable",
    signature: latest?.sha256 ?? null,
    byteSize: latest?.byteSize ?? null,
    modifiedAt: latest?.createdAt ?? null,
    revision: latest?.number ?? 1,
    movedTo: null
  };
}

function parseRemarkDraft(value: unknown): RemarkDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<RemarkDraft>;
  if (typeof draft.materialId !== "string" || typeof draft.text !== "string") return null;
  const anchor = normalizeAnchor(draft.anchor);
  const text = draft.text.trim();
  if (!anchor || text.length === 0 || text.length > REMARK_TEXT_LIMIT) return null;
  if (draft.reference === null || draft.reference === undefined) {
    return { materialId: draft.materialId, anchor, reference: null, text };
  }
  const referenceAnchor = normalizeAnchor(draft.reference.anchor);
  if (typeof draft.reference.materialId !== "string" || !referenceAnchor) return null;
  return { materialId: draft.materialId, anchor, reference: { materialId: draft.reference.materialId, anchor: referenceAnchor }, text };
}

function parseRemarkPatch(value: unknown): RemarkPatch | null {
  if (!value || typeof value !== "object") return null;
  const patch = value as RemarkPatch;
  const result: RemarkPatch = {};
  if (patch.text !== undefined) {
    if (typeof patch.text !== "string") return null;
    const text = patch.text.trim();
    if (text.length === 0 || text.length > REMARK_TEXT_LIMIT) return null;
    result.text = text;
  }
  if (patch.status !== undefined) {
    if (patch.status !== "open" && patch.status !== "accepted" && patch.status !== "reopened") return null;
    result.status = patch.status;
  }
  return result.text === undefined && result.status === undefined ? null : result;
}

function remarkTransitionAllowed(from: MaterialRemark["status"], to: NonNullable<RemarkPatch["status"]>): boolean {
  if (to === "accepted") return from !== "accepted";
  if (to === "reopened") return from === "sent" || from === "reported" || from === "accepted";
  return from === "reopened";
}

function anchorFits(material: StoredMaterial, anchor: RemarkAnchor): boolean {
  switch (anchor.kind) {
    case "whole": return true;
    case "lines": return material.kind === "text";
    case "time": return material.kind === "video" || material.kind === "audio";
    case "page": return material.kind === "pdf";
    case "step": return false;
    case "region":
    case "point": return material.kind === "image";
  }
}

function blobFailure(error: unknown): MaterialFailure {
  if (error instanceof MaterialBlobError) {
    if (error.code === "too-large") return "too-large";
    if (error.code === "quota") return "quota";
  }
  return "unreadable";
}

function failure(reason: MaterialFailure): { ok: false; reason: MaterialFailure } {
  return { ok: false, reason };
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}
