import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CreateSessionRequest, SessionSnapshot } from "../../shared/contracts.ts";
import type { WorkspacePreset } from "../../shared/backlog.ts";
import { normalizeImportedTasks } from "./OrchestrationTaskBoard.ts";
import { normalizeCanvasRegions, normalizeStickyNotes, normalizeBrowserCanvas } from "./SettingsStore.ts";
import { normalizePersistedTerminalSessions, type PersistedTerminalSession } from "./TerminalSessionStore.ts";

function validPresetName(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 80;
}

export interface WorkspaceArchiveDependencies {
  descriptors(): PersistedTerminalSession[];
  create(request: CreateSessionRequest): SessionSnapshot;
  setBounds(id: string, bounds: {position: {x:number;y:number};size:{width:number;height:number}}): void;
  available(provider: string): boolean;
  /** Host-owned launcher acknowledgement, never authority from the imported snapshot. */
  bypassAcknowledged?(provider: string): boolean;
  redact(text: string): string;
}

/** Portable descriptors, never PTY buffers, credentials or plugin native-code trust. */
export class WorkspaceArchive {
  private readonly file: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly deps: WorkspaceArchiveDependencies;
  constructor(userDataPath: string, deps: WorkspaceArchiveDependencies) {
    this.deps=deps;
    this.file = join(userDataPath, "workspace-presets.json");
  }
  export(): string {
    const sessions=this.deps.descriptors();
    if(sessions.length>100)throw new Error("Workspace export supports at most 100 cards; close cards before exporting.");
    return JSON.stringify({format: "canvastty-workspace", version: 1, exportedAt: Date.now(),
      sessions: sessions.map((record) => this.sanitize(this.portableRecord(record)))}, null, 2);
  }
  private portableRecord(record: PersistedTerminalSession, fresh = false): PersistedTerminalSession {
    return {
      id: record.id, provider: record.provider, profile: record.profile, role: record.role,
      title: record.title, titleCustomized: record.titleCustomized, cwd: record.cwd,
      position: {x: record.position.x, y: record.position.y}, size: {width: record.size.width, height: record.size.height},
      lastState: "running", restore: true,
      ...(record.parentSessionId !== undefined ? {parentSessionId: record.parentSessionId} : {}),
      ...(!fresh && record.threadId !== undefined ? {threadId: record.threadId} : {}),
      ...(record.model !== undefined ? {model: record.model} : {}),
      ...(record.effort !== undefined ? {effort: record.effort} : {}),
      // Keep placed cards inert on import without disclosing the plugin's private connection payload.
      ...(record.environment ? {environment: {pluginId: record.environment.pluginId, kind: record.environment.kind,
        ref: null, label: "Reconnect environment"}} : {})
    };
  }
  private sanitize(value: unknown): unknown {
    if (typeof value === "string") return this.deps.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.sanitize(entry));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^(?:password|token|apiKey|secret|authorization|capability|ownerPluginId)$/i.test(key))
      .map(([key, entry]) => [key, this.sanitize(entry)]));
    return value;
  }
  private parse(text: string): PersistedTerminalSession[] {
    if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Workspace snapshot is too large (maximum 2 MB).");
    let value: {format?:unknown;version?:unknown;sessions?:unknown;canvas?:unknown};
    try { value = JSON.parse(text) as typeof value; } catch { throw new Error("Workspace snapshot is not valid JSON."); }
    if (!value || value.format !== "canvastty-workspace" || value.version !== 1 || !Array.isArray(value.sessions)) throw new Error("Unsupported workspace snapshot format/version.");
    if(value.canvas!==undefined) {
      if(!value.canvas || typeof value.canvas!=="object" || Array.isArray(value.canvas))throw new Error("Invalid workspace canvas.");
      if((value.canvas as Record<string,unknown>).version!==1)throw new Error("Unsupported workspace canvas version.");
    }
    const normalized = normalizePersistedTerminalSessions({version: 2, sessions: value.sessions});
    if (normalized.sessions.length !== value.sessions.length || normalized.sessions.length > 100) throw new Error("Workspace contains invalid cards or more than 100 cards.");
    const ids = new Set(normalized.sessions.map((record) => record.id));
    for (const record of normalized.sessions) {
      if (record.parentSessionId && !ids.has(record.parentSessionId)) throw new Error("Workspace has a missing parent card.");
      const ancestry = new Set<string>([record.id]);
      let parent = record.parentSessionId;
      while (parent) {
        if (ancestry.has(parent)) throw new Error("Workspace has a cycle in its task tree.");
        ancestry.add(parent); parent = normalized.sessions.find((candidate) => candidate.id === parent)?.parentSessionId;
      }
    }
    return normalized.sessions;
  }
  async preview(text: string): Promise<{warnings:string[];count:number}> {
    const records = this.parse(text);
    return {warnings: await this.warnings(records), count: records.length};
  }
  private async warnings(records: PersistedTerminalSession[]): Promise<string[]> {
    const warnings: string[] = [];
    for (const record of records) {
      if (!this.deps.available(record.provider)) warnings.push(`${record.title}: ${record.provider} CLI is unavailable.`);
      if (!await stat(record.cwd).then((entry) => entry.isDirectory()).catch(() => false)) warnings.push(`${record.title}: folder is missing (${record.cwd}).`);
      if (record.environmentChoice || record.options) warnings.push(`${record.title}: imported plugin launcher and account choices are not applied; reselect them in the launcher.`);
      if (record.environment) warnings.push(`${record.title}: saved ${record.environment.pluginId} environment needs to be reconnected; this card will be skipped.`);
      if (record.profile === "yolo") warnings.push(`${record.title}: Bypass requires confirmation.`);
    }
    return warnings;
  }
  async import(text: string, confirmBypass: boolean): Promise<{warnings:string[];sessions:SessionSnapshot[];restoredIds:Record<string,string>}> {
    const records = this.parse(text);
    if (records.some((record) => record.profile === "yolo") && confirmBypass !== true) throw new Error("Confirm Bypass profiles before opening this workspace.");
    const warnings = await this.warnings(records);
    const candidates = new Set<string>();
    for (const record of records) {
      if (this.deps.available(record.provider) && !record.environment
        && await stat(record.cwd).then(entry => entry.isDirectory()).catch(() => false)) candidates.add(record.id);
    }
    const byId = new Map(records.map(record => [record.id, record]));
    for (const record of records) {
      if (record.profile !== "yolo" || record.provider === "terminal") continue;
      let ancestor: PersistedTerminalSession | undefined = record;
      while (ancestor && candidates.has(ancestor.id)) ancestor = ancestor.parentSessionId ? byId.get(ancestor.parentSessionId) : undefined;
      if (ancestor) continue; // This card or an ancestor will be skipped, not launched locally.
      if (record.role === "subagent") throw new Error("Bypass is never permitted for subagents; change this workspace card's profile before importing.");
      if (this.deps.bypassAcknowledged?.(record.provider) !== true) {
        throw new Error(`Acknowledge Bypass for ${record.provider} in CanvasTTY's launcher, then retry this import. No cards were created.`);
      }
    }
    const pending = [...records], sessions: SessionSnapshot[] = [], idMap = new Map<string,string>();
    while (pending.length) {
      const index = pending.findIndex((record) => !record.parentSessionId || idMap.has(record.parentSessionId)
        || !pending.some((candidate) => candidate.id === record.parentSessionId));
      if (index < 0) break;
      const record = pending.splice(index,1)[0];
      if (!candidates.has(record.id)) continue;
      if (record.parentSessionId && !idMap.has(record.parentSessionId)) { warnings.push(`${record.title}: parent could not be opened.`); continue; }
      try {
        const created = this.deps.create({provider: record.provider, cwd: record.cwd, profile: record.profile,
          position: record.position, title: record.title, role: record.role,
          ...(record.parentSessionId ? {parentSessionId:idMap.get(record.parentSessionId)!} : {}),
          ...(record.threadId ? {resumeThreadId:record.threadId} : {}),
          ...(record.model ? {model:record.model} : {}), ...(record.effort ? {effort:record.effort} : {})});
        this.deps.setBounds(created.id, {position:record.position,size:record.size});
        idMap.set(record.id,created.id); sessions.push({...created,size:record.size});
      } catch (error) { warnings.push(`${record.title}: ${error instanceof Error ? error.message : "could not be opened"}`); }
    }
    return {warnings,sessions,restoredIds:Object.fromEntries(idMap)};
  }
  async presets(): Promise<WorkspacePreset[]> {
    await this.queue;
    return this.readPresets();
  }
  savePreset(preset: WorkspacePreset): Promise<WorkspacePreset> {
    if (!preset || !/^[\w-]{1,100}$/.test(preset.id) || !validPresetName(preset.name)) return Promise.reject(new Error("Invalid workspace preset."));
    this.parse(preset.snapshot);
    const row: WorkspacePreset = {id:preset.id,name:this.deps.redact(preset.name),snapshot:this.freshSnapshot(preset.snapshot)};
    const work = this.queue.then(async () => {
      const rows = await this.readPresets();
      const next = [...rows.filter((entry) => entry.id !== row.id), row];
      if (next.length > 50) throw new Error("Maximum 50 workspace presets.");
      await this.writePresets(next); return row;
    });
    this.queue = work.then(() => undefined, () => undefined); return work;
  }
  deletePreset(id: string): Promise<void> {
    const work = this.queue.then(async () => this.writePresets((await this.readPresets()).filter((row) => row.id !== id)));
    this.queue = work.catch(() => undefined); return work;
  }
  private async readPresets(): Promise<WorkspacePreset[]> {
    try { return this.validatePresets(JSON.parse(await readFile(this.file,"utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private validatePresets(values: unknown): WorkspacePreset[] {
    if (!Array.isArray(values)) return [];
    const rows: WorkspacePreset[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    for (const value of values) {
      const row = (value && typeof value === "object" ? value : {}) as Partial<WorkspacePreset>;
      try {
        if (typeof row.id !== "string" || !/^[\w-]{1,100}$/.test(row.id) || seen.has(row.id) ||
          !validPresetName(row.name) || typeof row.snapshot !== "string") throw new Error("invalid preset");
        rows.push({ id: row.id, name: row.name, snapshot: this.freshSnapshot(row.snapshot) });
        seen.add(row.id);
      } catch {
        // A damaged record is skipped on read so it cannot hide its valid neighbors.
        skipped += 1;
      }
    }
    if (skipped > 0) console.warn(`Skipped ${skipped} damaged workspace preset${skipped === 1 ? "" : "s"}.`);
    return rows;
  }
  private async writePresets(rows: WorkspacePreset[]): Promise<void> {
    await mkdir(dirname(this.file), {recursive:true,mode:0o700});
    await writeFile(`${this.file}.tmp`,JSON.stringify(rows),{mode:0o600}); await rename(`${this.file}.tmp`,this.file);
  }
  private freshSnapshot(text:string):string {
    const sessions=this.parse(text).map(record=>this.portableRecord(record,true));
    const source=JSON.parse(text) as Record<string,unknown>;
    const sessionIds=Object.fromEntries(sessions.map(row=>[row.id,row.id]));
    let tasks;
    if(source.tasks!==undefined) {
      if(!Array.isArray(source.tasks) || source.tasks.length>100)throw new Error("Invalid workspace task groups.");
      tasks=source.tasks.map(group=>{
        if(!group || typeof group.rootSessionId!=="string" || !Object.hasOwn(sessionIds,group.rootSessionId))throw new Error("Invalid workspace task group root.");
        return {rootSessionId:group.rootSessionId,tasks:normalizeImportedTasks(group.tasks,group.rootSessionId,sessionIds,id=>id)};
      });
    }
    let canvas;
    if(source.canvas!==undefined) {
      // parse() has already validated the optional canvas envelope.
      const value=source.canvas as Record<string,unknown>;
      canvas={version:1,canvasRegions:normalizeCanvasRegions(value.canvasRegions),stickyNotes:normalizeStickyNotes(value.stickyNotes),
        browserCanvas:normalizeBrowserCanvas(value.browserCanvas,null)};
    }
    return JSON.stringify(this.sanitize({format:"canvastty-workspace",version:1,sessions,
      ...(tasks!==undefined?{tasks}:{}),...(canvas!==undefined?{canvas}:{})}));
  }
}
