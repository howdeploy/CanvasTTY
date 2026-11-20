import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { isPathInside } from "../../agent-runtime/path-inside.mjs";
import { terminalFileDropText } from "../../shared/terminalFileDrop.ts";
import type { PluginFileEntry, PluginFileListing, PluginFileRoot, PluginPermission } from "../../shared/contracts";
import { streamFile, textResponse } from "./fileResponse.ts";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
  ".opus": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac"
};
const TEXT = new Set(".txt .md .markdown .json .js .mjs .cjs .ts .tsx .jsx .py .rs .go .css .html .xml .yaml .yml .toml .ini .conf .sh .zsh .bash .ps1 .csv .log .sql .c .cpp .h .java .rb .vue .svelte .gitignore".split(" "));
const MAX_TEXT = 256 * 1024;
const PAGE_SIZE = 200;
interface Grant extends PluginFileRoot { pluginId: string; path: string }
interface DragGrant { pluginId: string; rootId: string; relativePath: string; expires: number }

/** Host-owned read grants. A plugin never supplies an absolute filesystem path. */
export class PluginFileService {
  private grants = new Map<string, Grant>();
  private drags = new Map<string, DragGrant>();
  private removing = new Set<string>();
  private readonly registryPath: string;
  private readonly authorize: (id: string, permission: PluginPermission) => void;
  private writeQueue = Promise.resolve();

  constructor(userDataPath: string, authorize: (id: string, permission: PluginPermission) => void) {
    this.registryPath = join(userDataPath, "plugin-file-roots.json");
    this.authorize = authorize;
  }

  async load(): Promise<void> {
    try {
      const values: unknown = JSON.parse(await readFile(this.registryPath, "utf8"));
      if (!Array.isArray(values)) return;
      for (const value of values) {
        if (value && typeof value.id === "string" && typeof value.pluginId === "string"
          && typeof value.name === "string" && typeof value.path === "string" && isAbsolute(value.path)) {
          this.grants.set(value.id, value);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("File grants could not be loaded.");
    }
  }

  async addRoot(pluginId: string, selectedPath: string): Promise<PluginFileRoot> {
    this.authorize(pluginId, "files:read");
    const path = await realpath(selectedPath);
    if (!(await stat(path)).isDirectory()) throw new Error("Select a folder.");
    this.authorize(pluginId, "files:read");
    if (this.removing.has(pluginId)) throw new Error("Plugin is being removed.");
    const existing = [...this.grants.values()].find((grant) => grant.pluginId === pluginId && grant.path === path);
    if (existing) return publicRoot(existing);
    const grant = { id: randomUUID(), pluginId, path, name: basename(path) || path };
    this.grants.set(grant.id, grant);
    await this.persist();
    return publicRoot(grant);
  }

  roots(pluginId: string): PluginFileRoot[] {
    this.authorize(pluginId, "files:read");
    return [...this.grants.values()].filter((grant) => grant.pluginId === pluginId).map(publicRoot);
  }

  async list(pluginId: string, rootId: string, relativePath: string, options: Record<string, unknown>): Promise<PluginFileListing> {
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error("Invalid page offset.");
    const query = typeof options.query === "string" ? options.query.slice(0, 200).toLocaleLowerCase() : "";
    const path = await this.resolvePath(pluginId, rootId, relativePath);
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => (entry.isDirectory() || entry.isFile()) && (options.showHidden === true || !entry.name.startsWith("."))
        && entry.name.toLocaleLowerCase().includes(query))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const page = entries.slice(offset as number, (offset as number) + PAGE_SIZE);
    const result: PluginFileEntry[] = [];
    for (let index = 0; index < page.length; index += 32) {
      const batch = await Promise.all(page.slice(index, index + 32).map(async (entry) => {
        const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        try { return await this.entry(pluginId, rootId, child); } catch { return null; }
      }));
      result.push(...batch.filter((entry): entry is PluginFileEntry => entry !== null));
    }
    this.requireRoot(pluginId, rootId);
    return { entries: result, total: entries.length, nextOffset: (offset as number) + page.length < entries.length ? (offset as number) + page.length : null };
  }

  async entry(pluginId: string, rootId: string, relativePath: string): Promise<PluginFileEntry> {
    const path = await this.resolvePath(pluginId, rootId, relativePath);
    const info = await stat(path);
    if (!info.isFile() && !info.isDirectory()) throw new Error("Not a regular file or folder.");
    const mimeType = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
    const name = basename(path);
    const kind = info.isDirectory() ? "directory" : mimeType.startsWith("image/") ? "image"
      : mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio"
        : TEXT.has(extname(path).toLowerCase()) || /^(readme|license|dockerfile|makefile)$/i.test(name) ? "text" : "file";
    this.pruneDrags();
    const dragToken = randomUUID();
    this.drags.set(dragToken, { pluginId, rootId, relativePath, expires: Date.now() + 30 * 60_000 });
    return {
      name, relativePath, kind, size: info.size, modifiedAt: info.mtimeMs, mimeType, dragToken,
      streamUrl: kind === "image" || kind === "video" || kind === "audio"
        ? `canvastty-files://${pluginId}/${rootId}/${relativePath.split("/").map(encodeURIComponent).join("/")}` : null
    };
  }

  async readText(pluginId: string, rootId: string, relativePath: string): Promise<{ content: string; truncated: boolean }> {
    const path = await this.resolvePath(pluginId, rootId, relativePath);
    if (!(await stat(path)).isFile()) throw new Error("Not a regular file.");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Not a regular file.");
      const buffer = Buffer.alloc(MAX_TEXT);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      if (content.includes("\0")) throw new Error("Binary file has no text preview.");
      this.requireRoot(pluginId, rootId);
      return { content, truncated: info.size > bytesRead };
    } finally { await handle.close(); }
  }

  async dropText(token: string, platform = process.platform): Promise<string> {
    this.pruneDrags();
    const grant = this.drags.get(token);
    if (!grant) throw new Error("File drag expired. Refresh the folder and try again.");
    const path = await this.resolvePath(grant.pluginId, grant.rootId, grant.relativePath);
    this.requireRoot(grant.pluginId, grant.rootId);
    return terminalFileDropText([path], platform);
  }

  async revealPath(pluginId: string, rootId: string, relativePath: string): Promise<string> {
    return this.resolvePath(pluginId, rootId, relativePath);
  }

  async revoke(pluginId: string, rootId: string): Promise<void> {
    this.requireRoot(pluginId, rootId);
    this.grants.delete(rootId);
    this.pruneDrags();
    await this.persist();
  }
  beginRemoval(pluginId: string): void { this.removing.add(pluginId); }
  endRemoval(pluginId: string): void { this.removing.delete(pluginId); }
  async revokeAll(pluginId: string): Promise<void> {
    for (const [id, grant] of this.grants) if (grant.pluginId === pluginId) this.grants.delete(id);
    this.pruneDrags();
    await this.persist();
  }

  async protocolResponse(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return textResponse("Method unavailable.", 405);
      const url = new URL(request.url);
      if (url.protocol !== "canvastty-files:") return textResponse("Unsupported protocol.", 400);
      const [rootId, ...parts] = url.pathname.slice(1).split("/").map(decodeURIComponent);
      const relativePath = safeRelativePath(parts.join("/"));
      const mime = MIME[extname(relativePath).toLowerCase()];
      if (!mime) throw new Error("Unsupported preview.");
      const path = await this.resolvePath(url.hostname, rootId, relativePath);
      return await streamFile(request, path, mime, {
        "access-control-allow-origin": "*", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox"
      });
    } catch { return textResponse("File preview is unavailable.", 404); }
  }

  private requireRoot(pluginId: string, rootId: string): Grant {
    this.authorize(pluginId, "files:read");
    const grant = this.grants.get(rootId);
    if (!grant || grant.pluginId !== pluginId || this.removing.has(pluginId)) throw new Error("Folder access is unavailable.");
    return grant;
  }
  private async resolvePath(pluginId: string, rootId: string, relativePath: string): Promise<string> {
    const grant = this.requireRoot(pluginId, rootId);
    const relative = safeRelativePath(relativePath);
    // Keep the original canonical root pinned: replacing it by an external symlink cannot move a grant.
    if (await realpath(grant.path) !== grant.path) throw new Error("Folder changed. Select it again.");
    const path = await realpath(resolve(grant.path, relative));
    if (!isPathInside(grant.path, path)) throw new Error("File is outside the selected folder.");
    this.requireRoot(pluginId, rootId);
    return path;
  }
  private pruneDrags(): void {
    for (const [token, grant] of this.drags) {
      if (grant.expires < Date.now() || !this.grants.has(grant.rootId) || this.drags.size >= 20_000) this.drags.delete(token);
    }
  }
  private persist(): Promise<void> {
    const content = JSON.stringify([...this.grants.values()]);
    const write = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.registryPath), { recursive: true });
      const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.registryPath);
    });
    this.writeQueue = write;
    return write;
  }
}

function publicRoot({ id, name }: Grant): PluginFileRoot { return { id, name }; }
function safeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length > 4096 || /[\\:\x00-\x1f\x7f]/u.test(value)
    || value.startsWith("/") || value.split("/").some((part) => part === "." || part === ".." || (part === "" && value !== ""))) {
    throw new Error("Invalid relative file path.");
  }
  return value;
}
