import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { normalizePersistedTerminalSessions, replaceFile, type PersistedTerminalSession } from "./TerminalSessionStore.ts";
import type { WorkspacePresetSummary, WorkspacePresetLayout } from "../../shared/workspacePresets.ts";

import { normalizePresetLayout } from "./workspacePresetLayout.ts";

interface WorkspacePreset {
  id: string;
  name: string;
  updatedAt: number;
  sessions: PersistedTerminalSession[];
  layout: WorkspacePresetLayout;
}

/** Uses the standard session recipe, including opaque plugin references; no input or scrollback. */
export class WorkspacePresetStore {
  readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; this.filePath = join(directory, "workspace-presets.json"); }

  private async read(): Promise<WorkspacePreset[]> {
    let raw: string;
    try { raw = await readFile(this.filePath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("Workspace preset file is too large; it was left unchanged.");
    const data = JSON.parse(raw) as { version?: unknown; presets?: unknown };
    if (data?.version !== 1 || !Array.isArray(data.presets) || data.presets.length > 64) {
      throw new Error("Unsupported workspace preset file; it was left unchanged.");
    }
    const ids = new Set<string>();
    return data.presets.map((p: WorkspacePreset) => {
      if (!p || typeof p.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(p.id) || ids.has(p.id)
        || typeof p.name !== "string" || !p.name.trim() || p.name.length > 80
        || !Number.isFinite(p.updatedAt) || !Array.isArray(p.sessions)) throw new Error("Invalid workspace preset file; it was left unchanged.");
      ids.add(p.id);
      const sessions = normalizePersistedTerminalSessions({ version: 2, sessions: p.sessions }).sessions;
      if (sessions.length !== p.sessions.length) throw new Error("Invalid saved session recipe; presets were left unchanged.");
      return { id: p.id, name: p.name, updatedAt: p.updatedAt, sessions, layout: normalizePresetLayout(p.layout) };
    });
  }

  private async write(presets: WorkspacePreset[]): Promise<void> {
    const data = JSON.stringify({ version: 1, presets }, null, 2) + "\n";
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error("Workspace preset storage is full.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      await replaceFile(temporary, this.filePath);
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next;
    return next;
  }

  async list(): Promise<WorkspacePresetSummary[]> {
    await this.queue.catch(() => undefined);
    return (await this.read()).map(({ id, name, updatedAt, sessions, layout }) => ({ id, name, updatedAt,
      surfaces: layout.stickyNotes.length + layout.fileCards.length + layout.pluginCanvas.length, browserTabs: layout.browserUrls.length,
      sessions: sessions.length, titles: sessions.map(s => s.title) }));
  }

  async get(id: unknown): Promise<WorkspacePreset> {
    await this.queue.catch(() => undefined);
    const preset = (await this.read()).find(p => p.id === id);
    if (!preset) throw new Error("Workspace preset does not exist.");
    return preset;
  }

  save(name: unknown, sessions: PersistedTerminalSession[], id?: unknown, layout?: WorkspacePresetLayout): Promise<void> {
    return this.mutate(async () => {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Enter a workspace name (1–80 characters).");
      const presets = await this.read();
      const previous = id === undefined ? undefined : presets.find(p => p.id === id);
      if (id !== undefined && !previous) throw new Error("Workspace preset does not exist.");
      if (!previous && presets.length >= 64) throw new Error("At most 64 workspace presets are supported.");
      const normalized = normalizePersistedTerminalSessions({ version: 2, sessions }).sessions;
      if (normalized.length !== sessions.length) throw new Error("Invalid session recipe.");
      const preset: WorkspacePreset = { id: previous?.id ?? randomUUID(), name: name.trim(), updatedAt: Date.now(), sessions: normalized, layout: normalizePresetLayout(layout) };
      await this.write(previous ? presets.map(p => p.id === previous.id ? preset : p) : [...presets, preset]);
    });
  }

  remove(id: unknown): Promise<void> {
    return this.mutate(async () => {
      const presets = await this.read();
      if (!presets.some(p => p.id === id)) throw new Error("Workspace preset does not exist.");
      await this.write(presets.filter(p => p.id !== id));
    });
  }
}
