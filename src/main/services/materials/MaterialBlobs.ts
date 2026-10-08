import { constants, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SHA256_PATTERN } from "./materialState.ts";

const TEMP_PREFIX = ".tmp-";
const READ_FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

type MaterialBlobErrorCode = "too-large" | "quota" | "unreadable";

export class MaterialBlobError extends Error {
  readonly code: MaterialBlobErrorCode;

  constructor(code: MaterialBlobErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface StoredBlob {
  sha256: string;
  byteSize: number;
}

export async function fileDigest(path: string, maxBytes: number): Promise<string | null> {
  const flags = READ_FILE_FLAGS;
  let handle;
  try {
    handle = await open(path, flags);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class MaterialBlobs {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  pathOf(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) throw new MaterialBlobError("unreadable", "Unknown version.");
    return join(this.root, sha256);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async has(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(sha256))).isFile();
    } catch {
      return false;
    }
  }

  async usedBytes(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0;
      throw error;
    }
    let bytes = 0;
    for (const entry of entries) {
      if (!SHA256_PATTERN.test(entry) && !entry.startsWith(TEMP_PREFIX)) continue;
      const info = await stat(join(this.root, entry));
      if (info.isFile()) bytes += info.size;
    }
    return bytes;
  }

  async writeFromFile(source: string, maxBytes: number, available: number): Promise<StoredBlob> {
    const flags = READ_FILE_FLAGS;
    let handle;
    try {
      handle = await open(source, flags);
    } catch {
      throw new MaterialBlobError("unreadable", "The file cannot be read.");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new MaterialBlobError("unreadable", "The file cannot be read.");
      if (info.size > maxBytes) throw new MaterialBlobError("too-large", "The file is too large to keep a version.");
      await this.ensureRoot();
      const temporary = join(this.root, `${TEMP_PREFIX}${randomUUID()}`);
      const hash = createHash("sha256");
      let byteSize = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          byteSize += chunk.length;
          if (byteSize > maxBytes) {
            callback(new MaterialBlobError("too-large", "The file is too large to keep a version."));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      try {
        await pipeline(handle.createReadStream({ autoClose: false }), meter, createWriteStream(temporary, { mode: 0o600, flush: true }));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error instanceof MaterialBlobError ? error : new MaterialBlobError("unreadable", "The file cannot be read.");
      }
      return await this.commit(temporary, hash.digest("hex"), byteSize, available);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async writeFromBytes(bytes: Uint8Array, maxBytes: number, available: number): Promise<StoredBlob> {
    if (bytes.byteLength > maxBytes) throw new MaterialBlobError("too-large", "The content is too large to keep.");
    await this.ensureRoot();
    const temporary = join(this.root, `${TEMP_PREFIX}${randomUUID()}`);
    await writeFile(temporary, bytes, { mode: 0o600, flush: true });
    return this.commit(temporary, createHash("sha256").update(bytes).digest("hex"), bytes.byteLength, available);
  }

  async collect(referenced: ReadonlySet<string>): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.startsWith(TEMP_PREFIX) || (SHA256_PATTERN.test(entry) && !referenced.has(entry)))
      .map((entry) => rm(join(this.root, entry), { force: true }).catch(() => undefined)));
  }

  private async commit(temporary: string, sha256: string, byteSize: number, available: number): Promise<StoredBlob> {
    const target = this.pathOf(sha256);
    if (await this.has(sha256)) {
      await rm(temporary, { force: true });
      return { sha256, byteSize };
    }
    if (byteSize > available) {
      await rm(temporary, { force: true });
      throw new MaterialBlobError("quota", "Version storage is full.");
    }
    await rename(temporary, target);
    return { sha256, byteSize };
  }
}
