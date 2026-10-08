import { constants, realpathSync, statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  FileEntry,
  FileReadResult,
  FileRootDescriptor,
  FileRootKind,
  FileRootReference,
  FileSearchResult
} from "../../shared/contracts";

export interface FileAccessLimits {
  maxTextBytes: number;
  maxImageBytes: number;
  maxDirectoryEntries: number;
  maxSearchResults: number;
  maxSearchDepth: number;
  skipDirectories: string[];
}

const DEFAULT_LIMITS: FileAccessLimits = {
  maxTextBytes: 2_000_000,
  maxImageBytes: 25 * 1024 * 1024,
  maxDirectoryEntries: 2_000,
  maxSearchResults: 500,
  maxSearchDepth: 12,
  skipDirectories: ["node_modules", ".git", "dist", "out", "build", ".cache"]
};

const BINARY_SAMPLE_BYTES = 64 * 1024;
const MAX_CONTROL_RATIO = 0.3;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml"
};

interface RegisteredRoot {
  rootId: string;
  path: string;
  label: string;
  rootType: FileRootKind;
  available: boolean;
}

interface FileAccessOptions {
  resolveSessionCwd: (sessionId: string) => string | undefined;
  limits?: Partial<FileAccessLimits>;
}

type ResolvedTarget =
  | { ok: true; real: string; root: RegisteredRoot }
  | { ok: false; reason: "not-permitted" | "unavailable" };

export class FileAccessService {
  private readonly roots = new Map<string, RegisteredRoot>();
  private readonly resolveSessionCwd: (sessionId: string) => string | undefined;
  private readonly limits: FileAccessLimits;

  constructor(options: FileAccessOptions) {
    this.resolveSessionCwd = options.resolveSessionCwd;
    this.limits = {
      maxTextBytes: options.limits?.maxTextBytes ?? DEFAULT_LIMITS.maxTextBytes,
      maxImageBytes: options.limits?.maxImageBytes ?? DEFAULT_LIMITS.maxImageBytes,
      maxDirectoryEntries: options.limits?.maxDirectoryEntries ?? DEFAULT_LIMITS.maxDirectoryEntries,
      maxSearchResults: options.limits?.maxSearchResults ?? DEFAULT_LIMITS.maxSearchResults,
      maxSearchDepth: options.limits?.maxSearchDepth ?? DEFAULT_LIMITS.maxSearchDepth,
      skipDirectories: options.limits?.skipDirectories
        ? [...options.limits.skipDirectories]
        : [...DEFAULT_LIMITS.skipDirectories]
    };
  }

  registerSessionRoot(sessionId: string): FileRootDescriptor | null {
    const cwd = this.resolveSessionCwd(sessionId);
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    try {
      const canonical = realpathSync(cwd);
      if (!statSync(canonical).isDirectory()) return null;
      return this.register(canonical, "session");
    } catch {
      return null;
    }
  }

  registerFolderRoot(folderPath: string): FileRootDescriptor {
    let canonical: string;
    try {
      canonical = realpathSync(folderPath);
    } catch {
      throw new Error("The selected folder is unavailable.");
    }
    if (!statSync(canonical).isDirectory()) throw new Error("The selected folder is not a directory.");
    return this.register(canonical, "folder");
  }

  async registerRoot(reference: FileRootReference): Promise<FileRootDescriptor | null> {
    if (reference.rootType === "session") return this.registerSessionRoot(reference.sessionId);
    // Folder roots are normally created by the native dialog; `folderPath` is
    // only supplied when re-registering a persisted root after relaunch. A
    // folder that has since disappeared resolves null (unavailable) rather than
    // throwing, so restore can surface the missing-root state.
    if (typeof reference.folderPath === "string" && reference.folderPath.length > 0) {
      try {
        return this.registerFolderRoot(reference.folderPath);
      } catch {
        return null;
      }
    }
    return null;
  }

  releaseRoot(rootId: string): void {
    this.roots.delete(rootId);
  }

  listRoots(): FileRootDescriptor[] {
    return [...this.roots.values()].map((root) => this.describe(root));
  }

  async list(rootId: string, relativePath: string): Promise<FileEntry[]> {
    const root = this.requireRoot(rootId);
    if (!root.available) throw new Error("The file root is unavailable.");
    const real = await this.resolveForOperation(root, relativePath);
    let metadata;
    try {
      metadata = await stat(real);
    } catch {
      throw new Error("The requested directory is unavailable.");
    }
    if (!metadata.isDirectory()) throw new Error("The requested path is not a directory.");

    let entries;
    try {
      entries = await readdir(real, { withFileTypes: true });
    } catch {
      throw new Error("The requested directory could not be read.");
    }

    const base = toPosix(relative(root.path, real));
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const kind: FileEntry["kind"] | null = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : null;
      if (kind === null) continue;
      const relativeEntry = base.length === 0 ? entry.name : `${base}/${entry.name}`;
      let size: number | null = null;
      if (kind === "file") {
        try {
          size = (await stat(join(real, entry.name))).size;
        } catch {
          continue;
        }
      }
      result.push({ name: entry.name, relativePath: relativeEntry, kind, size });
    }
    result.sort(compareEntries);
    return result.slice(0, this.limits.maxDirectoryEntries);
  }

  async read(rootId: string, relativePath: string): Promise<FileReadResult> {
    const root = this.roots.get(rootId);
    if (!root || !root.available) return { kind: "unsupported", reason: "not-permitted" };
    const target = await this.resolveTarget(root, relativePath);
    if (!target.ok) return { kind: "unsupported", reason: target.reason };

    let handle;
    try {
      handle = await open(target.real, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      return { kind: "unsupported", reason: openFailureReason(error) };
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) return { kind: "unsupported", reason: "not-permitted" };

      // Post-open containment re-checks. `O_NOFOLLOW` guards only the final
      // component, so an intermediate directory swapped after `realpath` could
      // redirect the open; re-resolve the requested path and compare the
      // descriptor's real target (/proc/self/fd or /dev/fd) against the root.
      // Residual race: the descriptor path is read after the open, so a swap
      // between the open and these checks is caught where the platform exposes
      // the fd path, but there is no atomic openat chain here by design.
      let resolvedAfterOpen: string;
      try {
        resolvedAfterOpen = realpathSync(target.real);
      } catch {
        return { kind: "unsupported", reason: "unavailable" };
      }
      if (!isContainedPath(root.path, resolvedAfterOpen)) {
        return { kind: "unsupported", reason: "not-permitted" };
      }
      const descriptorPath = await descriptorRealPath(handle);
      if (descriptorPath !== null && !isContainedPath(root.path, descriptorPath)) {
        return { kind: "unsupported", reason: "not-permitted" };
      }

      const size = metadata.size;

      const mediaType = IMAGE_MIME[extname(target.real).toLowerCase()];
      if (mediaType) {
        if (size > this.limits.maxImageBytes) return { kind: "too-large", reason: "too-large", size };
        const data = await readExactly(handle, size);
        return {
          kind: "image",
          mediaType,
          dataUrl: `data:${mediaType};base64,${data.toString("base64")}`,
          size
        };
      }

      const limit = this.limits.maxTextBytes;
      const inspected = await readExactly(handle, Math.min(size, limit));
      if (looksBinary(inspected)) return { kind: "unsupported", reason: "binary" };
      return {
        kind: "text",
        content: inspected.toString("utf8"),
        truncated: size > limit,
        size
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async search(rootId: string, query: string): Promise<FileSearchResult> {
    const root = this.requireRoot(rootId);
    if (!root.available) throw new Error("The file root is unavailable.");
    const needle = typeof query === "string" ? query.toLowerCase() : "";
    const skip = new Set(this.limits.skipDirectories);
    const matches: string[] = [];
    let truncated = false;

    const pending: Array<{ dir: string; depth: number }> = [{ dir: root.path, depth: 0 }];
    while (pending.length > 0) {
      const { dir, depth } = pending.pop()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          if (depth < this.limits.maxSearchDepth) {
            pending.push({ dir: join(dir, entry.name), depth: depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().includes(needle)) continue;
        if (matches.length >= this.limits.maxSearchResults) {
          truncated = true;
          pending.length = 0;
          break;
        }
        matches.push(toPosix(relative(root.path, join(dir, entry.name))));
      }
    }

    matches.sort((left, right) => left.localeCompare(right));
    return { relativePaths: matches, truncated };
  }

  revalidateRoot(rootId: string): boolean {
    const root = this.roots.get(rootId);
    if (!root) return false;
    try {
      const canonical = realpathSync(root.path);
      const valid = canonical === root.path && statSync(root.path).isDirectory();
      root.available = valid;
      return valid;
    } catch {
      root.available = false;
      return false;
    }
  }

  private register(canonicalPath: string, rootType: FileRootKind): FileRootDescriptor {
    const root: RegisteredRoot = {
      rootId: randomUUID(),
      path: canonicalPath,
      label: basename(canonicalPath) || "root",
      rootType,
      available: true
    };
    this.roots.set(root.rootId, root);
    return this.describe(root);
  }

  private describe(root: RegisteredRoot): FileRootDescriptor {
    return {
      rootId: root.rootId,
      label: root.label,
      available: root.available,
      rootType: root.rootType,
      // Folder roots carry their canonical path so the renderer can persist it
      // and re-register the root after relaunch. Session roots omit it so the
      // session cwd is never exposed across the bridge.
      ...(root.rootType === "folder" ? { folderPath: root.path } : {})
    };
  }

  private requireRoot(rootId: string): RegisteredRoot {
    const root = this.roots.get(rootId);
    if (!root) throw new Error("The file root is not registered.");
    return root;
  }

  private async resolveForOperation(root: RegisteredRoot, relativePath: string): Promise<string> {
    const target = await this.resolveTarget(root, relativePath);
    if (!target.ok) {
      throw new Error(
        target.reason === "not-permitted"
          ? "The requested path is outside the root."
          : "The requested path is unavailable."
      );
    }
    return target.real;
  }

  private async resolveTarget(root: RegisteredRoot, relativePath: string): Promise<ResolvedTarget> {
    if (!root.available) return { ok: false, reason: "not-permitted" };
    if (typeof relativePath !== "string" || relativePath.includes("\0") || relativePath.includes("\\")) {
      return { ok: false, reason: "not-permitted" };
    }
    if (isAbsolute(relativePath)) return { ok: false, reason: "not-permitted" };

    const candidate = resolve(root.path, relativePath);
    if (!isContainedPath(root.path, candidate)) return { ok: false, reason: "not-permitted" };

    let real;
    try {
      // Canonicalize with the same resolver used when the root was registered
      // (`realpathSync`). The async `realpath` can return a differently-cased or
      // 8.3-shortened path on Windows, which would fail the containment check.
      real = realpathSync(candidate);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!isContainedPath(root.path, real)) return { ok: false, reason: "not-permitted" };
    return { ok: true, real, root };
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  // Windows paths are case-insensitive and `realpath` may surface a long (`\\?\`)
  // form, so compare normalized values there instead of raw strings.
  const normalizedRoot = normalizePathForCompare(root);
  const normalizedCandidate = normalizePathForCompare(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedCandidate.startsWith(prefix);
}

function normalizePathForCompare(value: string): string {
  if (process.platform !== "win32") return value;
  const withoutLongPrefix = value.startsWith("\\\\?\\") ? value.slice(4) : value;
  return withoutLongPrefix.toLowerCase();
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function compareEntries(left: FileEntry, right: FileEntry): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name);
}

async function descriptorRealPath(handle: Awaited<ReturnType<typeof open>>): Promise<string | null> {
  for (const candidate of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
    try {
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return true;
  const sample = buffer.length > BINARY_SAMPLE_BYTES ? buffer.subarray(0, BINARY_SAMPLE_BYTES) : buffer;
  if (!isValidUtf8(sample)) return true;
  return hasHighControlRatio(sample);
}

function isValidUtf8(buffer: Buffer): boolean {
  // A bounded read may split the final multi-byte code point, so a strict decode
  // of the tail can look invalid even when the bytes are valid UTF-8. Decode
  // strictly first; if that fails, retry with a streaming decoder that tolerates
  // an incomplete trailing sequence while still rejecting genuinely invalid
  // bytes. Trimming a fixed number of bytes is wrong: cutting three bytes off a
  // complete two-byte character (or the middle of a four-byte one) corrupts it.
  try {
    STRICT_UTF8.decode(buffer);
    return true;
  } catch {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream: true });
      return true;
    } catch {
      return false;
    }
  }
}

function hasHighControlRatio(buffer: Buffer): boolean {
  let control = 0;
  for (const byte of buffer) {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      control += 1;
    }
  }
  return control / buffer.length > MAX_CONTROL_RATIO;
}

function openFailureReason(error: unknown): "not-permitted" | "unavailable" {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "ELOOP" || code === "EISDIR") return "not-permitted";
  return "unavailable";
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}
