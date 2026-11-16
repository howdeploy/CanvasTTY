import { inspectSkinMedia, type SkinMediaFormat, type SkinMediaInfo } from "../../shared/skinMedia.ts";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PIXEL_SKIN_APERTURES } from "../../shared/contracts.ts";
import type {
  PixelSkinAperture,
  PixelSkinApertures,
  PixelSkinControls,
  PixelSkinPackInstallRequest,
  PixelSkinPackSummary,
  PixelSkinSlot,
  PixelTerminalBorderSkinId
} from "../../shared/contracts";

export const PIXEL_SKIN_SLOTS = [
  "minimal_idle", "minimal_working", "minimal_completed",
  "detailed_idle", "detailed_working", "detailed_completed",
  "master_idle", "master_working", "master_completed", "background"
] as const satisfies readonly PixelSkinSlot[];

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
export const MAX_PIXEL_SKIN_ARCHIVE_BYTES = 150 * 1024 * 1024;
const MAX_PACK_BYTES = MAX_PIXEL_SKIN_ARCHIVE_BYTES;
const MAX_PACKS = 100;
const MAX_ARCHIVE_ENTRIES = 100;
const ID_PATTERN = /^pixel:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const require = createRequire(import.meta.url);
const unzipper = require("unzipper") as {
  Open: { buffer(data: Buffer): Promise<{ files: Array<{
    path: string;
    type: string;
    uncompressedSize: number;
    stream(): AsyncIterable<Buffer>;
  }> }> };
};

function pngChunkCrc(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) crc = CRC_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface PackManifest {
  schemaVersion: 1;
  bundledSha256?: string;
  media?: Partial<Record<PixelSkinSlot, SkinMediaInfo>>;
  id: PixelTerminalBorderSkinId;
  name: string;
  width: number;
  height: number;
  aperture: PixelSkinAperture;
  apertures: PixelSkinApertures;
  controls?: PixelSkinControls;
}

function isVideo(format: SkinMediaFormat): boolean { return format === "mp4" || format === "webm"; }
function mediaLimit(format: SkinMediaFormat): number { return isVideo(format) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES; }
function validMediaManifest(value: unknown): PackManifest["media"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid theme media.");
  const media: NonNullable<PackManifest["media"]> = {};
  for (const [slot, item] of Object.entries(value)) {
    if (!isPixelSkinSlot(slot) || !item || typeof item !== "object") throw new Error("Invalid theme media slot.");
    const { format, animated } = item as SkinMediaInfo;
    if (!["png", "gif", "webp", "mp4", "webm"].includes(format) || typeof animated !== "boolean"
      || (slot !== "background" && isVideo(format))) throw new Error("Invalid theme media format.");
    media[slot] = item as SkinMediaInfo;
  }
  return media;
}

const DEFAULT_APERTURE: PixelSkinAperture = { left: 8, right: 8, top: 17, bottom: 13 };

function validControls(value: unknown): PixelSkinControls | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid control plaques.");
  const levels = ["minimal", "detailed", "master"] as const;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || levels.some(level => !(level in input))) throw new Error("Invalid control plaques.");
  const result = {} as PixelSkinControls;
  for (const level of levels) {
    const rect = input[level] as Record<string, unknown> | null;
    if (!rect || typeof rect !== "object" || Array.isArray(rect)
      || ["left", "top", "width", "height"].some(key => typeof rect[key] !== "number" || !Number.isFinite(rect[key]))) {
      throw new Error("Invalid control plaque rectangle.");
    }
    const { left, top, width, height } = rect as unknown as PixelSkinControls[typeof level];
    if (left < 0 || top < 0 || width < 8 || height < 2 || left + width > 100 || top + height > 100) {
      throw new Error("Control plaque must fit inside the artwork.");
    }
    result[level] = { left, top, width, height };
  }
  return result;
}

function validApertures(value: unknown, fallback: PixelSkinAperture): PixelSkinApertures {
  if (value === undefined) return { minimal: fallback, detailed: fallback, master: fallback };
  if (!value || typeof value !== "object") throw new Error("Terminal apertures are invalid.");
  const apertures = value as Record<string, unknown>;
  if (Object.keys(apertures).length !== 3 || ["minimal", "detailed", "master"].some((level) => !(level in apertures))) {
    throw new Error("Terminal apertures are invalid.");
  }
  return {
    minimal: validAperture(apertures.minimal),
    detailed: validAperture(apertures.detailed),
    master: validAperture(apertures.master)
  };
}

function validAperture(value: unknown): PixelSkinAperture {
  if (value === undefined) return DEFAULT_APERTURE;
  if (!value || typeof value !== "object") throw new Error("Terminal aperture is invalid.");
  const aperture = value as Record<string, unknown>;
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    if (typeof aperture[edge] !== "number" || !Number.isFinite(aperture[edge])
      || aperture[edge] < 2 || aperture[edge] > 35) throw new Error("Terminal aperture is invalid.");
  }
  if ((aperture.left as number) + (aperture.right as number) > 55
    || (aperture.top as number) + (aperture.bottom as number) > 55) {
    throw new Error("Terminal aperture leaves too little room for output.");
  }
  return aperture as unknown as PixelSkinAperture;
}

export function isPixelTerminalBorderSkinId(value: unknown): value is PixelTerminalBorderSkinId {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isPixelSkinSlot(value: unknown): value is PixelSkinSlot {
  return typeof value === "string" && (PIXEL_SKIN_SLOTS as readonly string[]).includes(value);
}

function parsePng(data: Uint8Array): { width: number; height: number } {
  if (!(data instanceof Uint8Array) || data.byteLength < 57 || data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("PNG file size is invalid.");
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Only PNG images are accepted.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let hasImageData = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > MAX_IMAGE_BYTES || end > bytes.length) throw new Error("PNG chunks are malformed.");
    if (pngChunkCrc(bytes, offset + 4, offset + 8 + length) !== bytes.readUInt32BE(offset + 8 + length)) {
      throw new Error("PNG checksum is invalid.");
    }
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (offset === 8) {
      if (kind !== "IHDR" || length !== 13) throw new Error("PNG header is malformed.");
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      if (width < 320 || height < 200 || width > 4096 || height > 4096) {
        throw new Error("PNG dimensions must be between 320x200 and 4096x4096.");
      }
    }
    if (kind === "IDAT") hasImageData = true;
    if (kind === "IEND") {
      if (length !== 0 || end !== bytes.length) throw new Error("PNG ending is malformed.");
      ended = true;
      break;
    }
    offset = end;
  }
  if (!hasImageData || !ended) throw new Error("PNG image data is incomplete.");
  return { width, height };
}

function validName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Theme name is required.");
  const name = value.trim();
  if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Theme name is invalid.");
  return name;
}

export class PixelSkinPackRegistry {
  private readonly root: string;
  private readonly bundledRoot?: string;
  private readonly packs = new Map<PixelTerminalBorderSkinId, PackManifest>();
  private readonly listeners = new Set<() => void>();

  constructor(userDataPath: string, bundledRoot?: string) {
    this.root = join(userDataPath, "pixel-skins");
    this.bundledRoot = bundledRoot;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const id = `pixel:${entry.name}`;
      if (!isPixelTerminalBorderSkinId(id)) continue;
      try {
        const path = join(this.root, entry.name);
        const manifestPath = join(path, "manifest.json");
        if (!(await lstat(manifestPath)).isFile()) continue;
        const raw = await readFile(manifestPath);
        if (raw.length > 4096) continue;
        const manifest = JSON.parse(raw.toString("utf8")) as Partial<PackManifest>;
        if (manifest.schemaVersion !== 1 || manifest.id !== id) continue;
        const name = validName(manifest.name);
        const aperture = validAperture(manifest.aperture);
        const apertures = validApertures(manifest.apertures, aperture);
        const controls = validControls(manifest.controls);
        if (!Number.isInteger(manifest.width) || !Number.isInteger(manifest.height)) continue;
        const media = validMediaManifest(manifest.media);
        const files = await Promise.all(PIXEL_SKIN_SLOTS.map(async (slot) => {
          const format = media?.[slot]?.format ?? "png";
          const stat = await lstat(join(path, `${slot}.${format}`));
          return stat.isFile() && !stat.isSymbolicLink() && stat.size <= mediaLimit(format);
        }));
        if (files.every(Boolean)) this.packs.set(id, {
          schemaVersion: 1, id, name, aperture, apertures, ...(controls ? { controls } : {}), ...(media ? { media } : {}),
          ...(typeof manifest.bundledSha256 === 'string' && /^[0-9a-f]{64}$/.test(manifest.bundledSha256) ? { bundledSha256: manifest.bundledSha256 } : {}),
          width: manifest.width as number, height: manifest.height as number
        });
      } catch {
        // A malformed user pack is unavailable; it must not prevent app startup.
      }
    }
    if (this.bundledRoot) await this.initializeBundled(this.bundledRoot);
  }

  /** Trusted build resources only. Reuse the full importer and stable IDs on every profile. */
  private async initializeBundled(root: string): Promise<void> {
    try {
      const raw = await readFile(join(root, "catalog.json"));
      if (raw.length > 16_384) throw new Error("Bundled theme catalog is too large.");
      const catalog = JSON.parse(raw.toString("utf8")) as { schemaVersion?: number; presets?: unknown[]; retiredIds?: unknown[] };
      if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.presets) || catalog.presets.length > 10) {
        throw new Error("Invalid bundled theme catalog.");
      }
      // Only explicit build-owned IDs are retired. Preserve their files for
      // recovery and leave arbitrary user imports alone.
      if (catalog.retiredIds !== undefined) {
        if (!Array.isArray(catalog.retiredIds) || catalog.retiredIds.length > 10
          || !catalog.retiredIds.every(isPixelTerminalBorderSkinId)
          || catalog.presets.some(p => p && typeof p === 'object' && catalog.retiredIds!.includes((p as {id?:unknown}).id))) {
          throw new Error("Invalid retired theme catalog.");
        }
        for (const id of catalog.retiredIds as PixelTerminalBorderSkinId[]) {
          if (!this.packs.has(id)) continue;
          const archive = join(this.root, '.retired');
          await mkdir(archive, { recursive: true });
          await rename(join(this.root, id.slice(6)), join(archive, `${id.slice(6)}-${randomUUID()}`));
          this.packs.delete(id);
        }
      }
      for (const value of catalog.presets) {
        try {
          if (!value || typeof value !== "object") throw new Error("Invalid bundled theme.");
          const preset = value as { id: string; name: string; archive: string; apertures: PixelSkinApertures };
          if (!isPixelTerminalBorderSkinId(preset.id) || !/^[a-z0-9-]+\.zip$/.test(preset.archive)) {
            throw new Error("Invalid bundled theme identity.");
          }
          const bytes = await readFile(join(root, preset.archive));
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          if (this.packs.get(preset.id)?.bundledSha256 === sha256) continue;
          await this.installZip(bytes, preset.name, preset.apertures, preset.id, sha256);
        } catch (error) {
          // A damaged preset must not prevent terminals or user themes from opening.
          console.warn("[PixelSkinPackRegistry] Bundled theme unavailable:", error);
        }
      }
    } catch (error) {
      console.warn("[PixelSkinPackRegistry] Bundled catalog unavailable:", error);
    }
  }

  list(): PixelSkinPackSummary[] {
    return [...this.packs.values()].map(({ id, name, aperture, apertures, controls, media }) => ({ id, name, aperture, apertures, ...(controls ? { controls } : {}), ...(media ? { media } : {}) }));
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async installZip(archive: Uint8Array, name: string, apertures?: PixelSkinApertures, bundledId?: PixelTerminalBorderSkinId, bundledSha256?: string): Promise<PixelSkinPackSummary> {
    if (!(archive instanceof Uint8Array) || archive.byteLength < 22 || archive.byteLength > MAX_PACK_BYTES) {
      throw new Error("Theme ZIP file size is invalid.");
    }
    const directory = await unzipper.Open.buffer(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
    if (directory.files.length > MAX_ARCHIVE_ENTRIES) throw new Error("Theme ZIP has too many entries.");
    // Optional measured geometry travels with the ZIP; old ten-image archives still work.
    const layouts = directory.files.filter(entry => entry.type === "File" && entry.path.replace(/\\/g, "/").split("/").at(-1) === "layout.json");
    if (layouts.length > 1) throw new Error("Duplicate theme layout.");
    let controls: PixelSkinControls | undefined;
    let embeddedApertures: PixelSkinApertures | undefined;
    if (layouts[0]) {
      if (layouts[0].uncompressedSize > 4096) throw new Error("Theme layout is too large.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of layouts[0].stream()) {
        size += chunk.length;
        if (size > 4096) throw new Error("Theme layout is too large.");
        chunks.push(chunk);
      }
      const layout = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!layout || layout.schemaVersion !== 1) throw new Error("Unsupported theme layout.");
      controls = validControls(layout.controls);
      if (layout.apertures !== undefined) embeddedApertures = validApertures(layout.apertures, DEFAULT_APERTURE);
    }
    const entries = new Map<PixelSkinSlot, typeof directory.files[number]>();
    for (const entry of directory.files) {
      if (entry.type !== "File") continue;
      const filename = entry.path.replace(/\\/g, "/").split("/").at(-1) ?? "";
      const match = /^(.*)\.(png|apng|gif|webp|mp4|webm)$/i.exec(filename);
      if (!match) continue;
      const slot = match[1].toLowerCase();
      if (!isPixelSkinSlot(slot)) continue;
      if (entries.has(slot)) throw new Error(`Theme ZIP contains duplicate ${filename}.`);
      if (entry.uncompressedSize < 1 || entry.uncompressedSize > MAX_VIDEO_BYTES) {
        throw new Error(`${filename} exceeds the media size limit.`);
      }
      entries.set(slot, entry);
    }
    if (entries.size !== PIXEL_SKIN_SLOTS.length) {
      throw new Error("Theme ZIP needs nine PNG/APNG/GIF/WebP frames and a PNG/APNG/GIF/WebP/MP4/WebM background.");
    }
    const files = {} as Record<PixelSkinSlot, Uint8Array>;
    let total = 0;
    for (const slot of PIXEL_SKIN_SLOTS) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of entries.get(slot)!.stream()) {
        size += chunk.length;
        if (size > MAX_VIDEO_BYTES || total + size > MAX_PACK_BYTES) throw new Error(`${slot} exceeds the media size limit.`);
        chunks.push(chunk);
      }
      total += size;
      files[slot] = Buffer.concat(chunks, size);
    }
    return this.installPack({ name, apertures: apertures ?? embeddedApertures, controls, files }, bundledId, bundledSha256);
  }

  async install(request: PixelSkinPackInstallRequest): Promise<PixelSkinPackSummary> {
    return this.installPack(request);
  }

  private async installPack(request: PixelSkinPackInstallRequest, bundledId?: PixelTerminalBorderSkinId, bundledSha256?: string): Promise<PixelSkinPackSummary> {
    if (!request || typeof request !== "object" || !request.files || typeof request.files !== "object") {
      throw new Error("Theme package is invalid.");
    }
    const replacingBundled = bundledId !== undefined && bundledSha256 !== undefined && this.packs.has(bundledId);
    if (bundledSha256 !== undefined && (!bundledId || !/^[0-9a-f]{64}$/.test(bundledSha256))) throw new Error("Invalid bundled theme digest.");
    if (this.packs.size >= MAX_PACKS && !replacingBundled) throw new Error("Too many pixel themes are installed.");
    const name = validName(request.name);
    const controls = validControls(request.controls);
    const aperture = validAperture(request.aperture);
    const apertures = request.apertures
      ? validApertures(request.apertures, aperture)
      : request.aperture
        ? validApertures(undefined, aperture)
        : validApertures(DEFAULT_PIXEL_SKIN_APERTURES, aperture);
    const files = request.files as Record<string, unknown>;
    if (Object.keys(files).length !== PIXEL_SKIN_SLOTS.length
      || Object.keys(files).some((slot) => !isPixelSkinSlot(slot))) {
      throw new Error("A theme needs exactly nine terminal frames and one background.");
    }
    let width = 0;
    let height = 0;
    let total = 0;
    const media: Partial<Record<PixelSkinSlot, SkinMediaInfo>> = {};
    for (const slot of PIXEL_SKIN_SLOTS) {
      const data = files[slot];
      if (!(data instanceof Uint8Array)) throw new Error(`${slot} must be media bytes.`);
      total += data.byteLength;
      if (total > MAX_PACK_BYTES) throw new Error("Theme package is too large.");
      if (data.byteLength > MAX_VIDEO_BYTES) throw new Error(`${slot} is too large.`);
      const info = inspectSkinMedia(data);
      if (data.byteLength > mediaLimit(info.format)) throw new Error(`${slot} exceeds the media size limit.`);
      if (slot !== "background" && isVideo(info.format)) throw new Error("Video is supported only for the Canvas background; use APNG/WebP for frames.");
      if (info.format === "png") parsePng(data);
      if (info.width !== undefined && (info.width < 320 || info.height! < 200 || info.width > 4096 || info.height! > 4096)) {
        throw new Error("Image dimensions must be between 320x200 and 4096x4096.");
      }
      if (info.format !== "png" || info.animated) media[slot] = info;
      const dimensions = { width: info.width!, height: info.height! };
      if (slot !== "background") {
        if (!width) ({ width, height } = dimensions);
        else if (width !== dimensions.width || height !== dimensions.height) {
          throw new Error("All nine terminal frames must have the same dimensions.");
        }
      }
    }
    const id = bundledId ?? `pixel:${randomUUID()}` as PixelTerminalBorderSkinId;
    if (!isPixelTerminalBorderSkinId(id) || (this.packs.has(id) && !replacingBundled)) throw new Error("Theme ID is invalid or already installed.");
    const extra = { ...(Object.keys(media).length ? { media } : {}), ...(controls ? { controls } : {}) };
    const manifest: PackManifest = { schemaVersion: 1, id, name, width, height, aperture, apertures, ...extra, ...(bundledSha256 ? { bundledSha256 } : {}) };
    await mkdir(this.root, { recursive: true });
    const temporary = await mkdtemp(join(this.root, ".install-"));
    const destination = join(this.root, id.slice("pixel:".length));
    let backup: string | undefined;
    try {
      for (const slot of PIXEL_SKIN_SLOTS) {
        await writeFile(join(temporary, `${slot}.${media[slot]?.format ?? "png"}`), files[slot] as Uint8Array, { flag: "wx" });
      }
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
      // Validate and write the complete replacement before touching the installed
      // build-owned pack. Keep its stable ID, settings and recoverable old files.
      if (replacingBundled) {
        await mkdir(join(this.root, '.retired'), { recursive: true });
        backup = join(this.root, '.retired', `${id.slice(6)}-${randomUUID()}`);
        await rename(destination, backup);
      }
      await rename(temporary, destination);
    } catch (error) {
      if (backup) await rename(backup, destination);
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    this.packs.set(id, manifest);
    for (const listener of this.listeners) listener();
    return { id, name, aperture, apertures, ...extra };
  }

  async readAsset(id: PixelTerminalBorderSkinId, slot: PixelSkinSlot): Promise<Uint8Array | null> {
    if (!isPixelTerminalBorderSkinId(id) || !isPixelSkinSlot(slot) || !this.packs.has(id)) return null;
    const format = this.packs.get(id)?.media?.[slot]?.format ?? "png";
    const path = join(this.root, id.slice("pixel:".length), `${slot}.${format}`);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > mediaLimit(format)) return null;
      return await readFile(path);
    } catch {
      return null;
    }
  }
}
