import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { isPathInside } from "../../agent-runtime/path-inside.mjs";
import { randomUUID } from "node:crypto";
import { streamFile, textResponse } from "./fileResponse.ts";
import type {
  PluginMediaLibrary,
  PluginMediaTrack,
  PluginPermission,
  PluginPlaylistFile
} from "../../shared/contracts";

const REGISTRY_FILE = "plugin-media-libraries.json";
const MAX_TRACKS = 20_000;
const MAX_PLAYLISTS = 2_000;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

const AUDIO_MIME: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm"
};

const PLAYLIST_EXTENSIONS = new Set([".json", ".m3u", ".m3u8", ".pls"]);
const STREAM_HEADERS = { "access-control-allow-origin": "*" };

interface StoredLibrary {
  id: string;
  pluginId: string;
  rootPath: string;
  name: string;
  createdAt: number;
}

type AuthorizePlugin = (pluginId: string, permission: PluginPermission) => void;

export class PluginMediaService {
  private readonly registryPath: string;
  private readonly authorize: AuthorizePlugin;
  private readonly libraries = new Map<string, StoredLibrary>();
  private writeQueue = Promise.resolve();
  /** Plugins being uninstalled: no grant of theirs may be stored until that ends. */
  private readonly removing = new Set<string>();

  constructor(userDataPath: string, authorize: AuthorizePlugin) {
    this.registryPath = join(userDataPath, REGISTRY_FILE);
    this.authorize = authorize;
  }

  async load(): Promise<void> {
    try {
      const candidate: unknown = JSON.parse(await readFile(this.registryPath, "utf8"));
      if (!Array.isArray(candidate)) return;
      for (const value of candidate) {
        if (!isStoredLibrary(value)) continue;
        this.libraries.set(value.id, value);
      }
    } catch (error) {
      if (!isMissingFile(error)) console.warn("CanvasTTY plugin media grants could not be loaded.", error);
    }
  }

  async addLibrary(pluginId: string, selectedPath: string): Promise<PluginMediaLibrary> {
    this.authorize(pluginId, "media:library");
    const rootPath = await realpath(selectedPath);
    const metadata = await stat(rootPath);
    if (!metadata.isDirectory()) throw new Error("The selected music library is not a directory.");
    // The folder checks above take time (and the pick before them far longer): the plugin may have been
    // uninstalled meanwhile, and its grant must not be stored after its grants were revoked.
    this.assertGrantable(pluginId);
    const existing = [...this.libraries.values()].find((library) => (
      library.pluginId === pluginId && library.rootPath === rootPath
    ));
    if (existing) return publicLibrary(existing);

    const library: StoredLibrary = {
      id: randomUUID(),
      pluginId,
      rootPath,
      name: basename(rootPath),
      createdAt: Date.now()
    };
    this.libraries.set(library.id, library);
    await this.persist();
    return publicLibrary(library);
  }

  listLibraries(pluginId: string): PluginMediaLibrary[] {
    this.authorize(pluginId, "media:library");
    return [...this.libraries.values()]
      .filter((library) => library.pluginId === pluginId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(publicLibrary);
  }

  async scanLibrary(pluginId: string, libraryId: string): Promise<PluginMediaTrack[]> {
    this.authorize(pluginId, "media:library");
    const library = this.requireLibrary(pluginId, libraryId);
    const files = await scanFiles(library.rootPath, (extension) => extension in AUDIO_MIME, MAX_TRACKS);
    return files.map((file) => ({
      id: file.relativePath,
      name: basename(file.relativePath, extname(file.relativePath)),
      relativePath: file.relativePath,
      size: file.size,
      mimeType: AUDIO_MIME[extname(file.relativePath).toLowerCase()],
      streamUrl: mediaUrl(pluginId, library.id, file.relativePath)
    }));
  }

  async revokeLibrary(pluginId: string, libraryId: string): Promise<void> {
    this.authorize(pluginId, "media:library");
    this.requireLibrary(pluginId, libraryId);
    this.libraries.delete(libraryId);
    await this.persist();
  }

  /** Uninstall starts: from now on the plugin's grant writes are refused, until endRemoval. */
  beginRemoval(pluginId: string): void {
    this.removing.add(pluginId);
  }

  /** Uninstall finished or failed. After a finished one the plugin is unknown, so authorization refuses it anyway. */
  endRemoval(pluginId: string): void {
    this.removing.delete(pluginId);
  }

  private assertGrantable(pluginId: string): void {
    if (this.removing.has(pluginId)) throw new Error("The plugin is being uninstalled.");
    this.authorize(pluginId, "media:library");
  }

  async revokeAll(pluginId: string): Promise<void> {
    let changed = false;
    for (const [id, library] of this.libraries) {
      if (library.pluginId !== pluginId) continue;
      this.libraries.delete(id);
      changed = true;
    }
    if (changed) await this.persist();
  }

  async listPlaylists(pluginId: string, libraryId: string): Promise<PluginPlaylistFile[]> {
    this.authorize(pluginId, "playlists:read");
    const library = this.requireLibrary(pluginId, libraryId);
    const files = await scanFiles(library.rootPath, (extension) => PLAYLIST_EXTENSIONS.has(extension), MAX_PLAYLISTS);
    return files.filter((file) => isReadablePlaylistPath(file.relativePath)).map(publicPlaylist);
  }

  async readPlaylist(pluginId: string, libraryId: string, playlistId: string): Promise<string> {
    this.authorize(pluginId, "playlists:read");
    const library = this.requireLibrary(pluginId, libraryId);
    const relativePath = safeRelativePath(playlistId);
    if (!isReadablePlaylistPath(relativePath)) {
      throw new Error("Unsupported playlist format.");
    }
    const path = await containedExistingFile(library.rootPath, relativePath);
    const metadata = await stat(path);
    if (metadata.size > MAX_PLAYLIST_BYTES) throw new Error("Playlist file exceeds 4 MB.");
    return readFile(path, "utf8");
  }

  async writePlaylist(
    pluginId: string,
    libraryId: string,
    name: string,
    content: string
  ): Promise<PluginPlaylistFile> {
    this.authorize(pluginId, "playlists:write");
    const library = this.requireLibrary(pluginId, libraryId);
    const fileName = safePlaylistName(name);
    if (Buffer.byteLength(content, "utf8") > MAX_PLAYLIST_BYTES) {
      throw new Error("Playlist file exceeds 4 MB.");
    }

    const playlistDirectory = join(library.rootPath, "Playlists");
    try {
      const existing = await lstat(playlistDirectory);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error("The library Playlists entry is not a safe directory.");
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await mkdir(playlistDirectory);
    }
    const canonicalDirectory = await realpath(playlistDirectory);
    if (!isPathInside(await realpath(library.rootPath), canonicalDirectory)) {
      throw new Error("The library Playlists directory is outside the selected library.");
    }

    const path = join(canonicalDirectory, fileName);
    // A fixed `<name>.tmp` could already be a link pointing outside the
    // library, and writeFile follows it. A new random name created with O_EXCL
    // ("wx") fails on any existing entry, link or not.
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    const metadata = await stat(path);
    return publicPlaylist({ relativePath: `Playlists/${fileName}`, size: metadata.size });
  }

  async protocolResponse(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "canvastty-media:") return textResponse("Unsupported protocol.", 400);
      const pluginId = decodeURIComponent(url.hostname);
      this.authorize(pluginId, "media:library");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const libraryId = parts.shift();
      if (!libraryId || parts.length === 0) return textResponse("Track is unavailable.", 404);
      const library = this.requireLibrary(pluginId, libraryId);
      const relativePath = safeRelativePath(parts.join("/"));
      if (!(extname(relativePath).toLowerCase() in AUDIO_MIME)) return textResponse("Track is unavailable.", 404);
      const path = await containedExistingFile(library.rootPath, relativePath);
      return streamFile(request, path, AUDIO_MIME[extname(relativePath).toLowerCase()], STREAM_HEADERS);
    } catch {
      return textResponse("Track is unavailable.", 404);
    }
  }

  private requireLibrary(pluginId: string, libraryId: string): StoredLibrary {
    const library = this.libraries.get(libraryId);
    if (!library || library.pluginId !== pluginId) throw new Error("Music library access is unavailable.");
    return library;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.libraries.values()], null, 2);
    const temporaryPath = `${this.registryPath}.tmp`;
    const write = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.registryPath), { recursive: true });
      await writeFile(temporaryPath, snapshot, "utf8");
      await rename(temporaryPath, this.registryPath);
    });
    this.writeQueue = write;
    return write;
  }
}

interface ScannedFile {
  relativePath: string;
  size: number;
}

async function scanFiles(
  rootPath: string,
  accepts: (extension: string) => boolean,
  limit: number
): Promise<ScannedFile[]> {
  const root = await realpath(rootPath);
  const results: ScannedFile[] = [];
  const pending = [root];
  while (pending.length > 0 && results.length < limit) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (!entry.isFile() || !accepts(extension)) continue;
      const metadata = await stat(path);
      results.push({ relativePath: relative(root, path).split(sep).join("/"), size: metadata.size });
      if (results.length >= limit) break;
    }
  }
  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function containedExistingFile(rootPath: string, relativePath: string): Promise<string> {
  const root = await realpath(rootPath);
  const candidate = await realpath(resolve(root, safeRelativePath(relativePath)));
  if (!isPathInside(root, candidate)) throw new Error("Media file is outside the selected library.");
  const metadata = await stat(candidate);
  if (!metadata.isFile()) throw new Error("Media file is unavailable.");
  return candidate;
}

function safeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || value.includes("\\") || value.includes("\0")) {
    throw new Error("Media path is invalid.");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Media path is invalid.");
  return parts.join("/");
}

function safePlaylistName(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 180 || value !== basename(value)) {
    throw new Error("Playlist name is invalid.");
  }
  const extension = extname(value).toLowerCase();
  if (!PLAYLIST_EXTENSIONS.has(extension)) throw new Error("Unsupported playlist format.");
  if (/[/\\\u0000-\u001f\u007f]/.test(value)) throw new Error("Playlist name is invalid.");
  return value;
}

function isReadablePlaylistPath(relativePath: string): boolean {
  const extension = extname(relativePath).toLowerCase();
  return PLAYLIST_EXTENSIONS.has(extension)
    && (extension !== ".json" || relativePath.startsWith("Playlists/"));
}

function publicLibrary(library: StoredLibrary): PluginMediaLibrary {
  return { id: library.id, name: library.name };
}

function publicPlaylist(file: ScannedFile): PluginPlaylistFile {
  return {
    id: file.relativePath,
    name: basename(file.relativePath),
    relativePath: file.relativePath,
    size: file.size
  };
}

function mediaUrl(pluginId: string, libraryId: string, relativePath: string): string {
  return `canvastty-media://${encodeURIComponent(pluginId)}/${encodeURIComponent(libraryId)}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function isStoredLibrary(value: unknown): value is StoredLibrary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredLibrary>;
  return typeof candidate.id === "string"
    && typeof candidate.pluginId === "string"
    && typeof candidate.rootPath === "string"
    && typeof candidate.name === "string"
    && typeof candidate.createdAt === "number";
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
