import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WebContents } from "electron";
import type { BrowserService } from "../BrowserService.ts";
import type { AgentPresenceSnapshot, BrowserActivityEvent, BrowserActor, BrowserCommand, BrowserResult, BrowserSnapshot,
  BrowserViewportBounds, CanvasWheelCaptureMode } from "../../../shared/contracts.ts";
import { BrowserCommandDispatcher, type BrowserAuditWriter } from "./BrowserCommandDispatcher.ts";
import { BrowserKernelError } from "./BrowserErrors.ts";
import { sanitizeAgentResult } from "./BrowserCore.ts";
import { DEFAULT_BROWSER_URL, isSafeBrowserUrl } from "./BrowserPolicyService.ts";

export const DEFAULT_BROWSER_ID = "default";
export const MAX_BROWSER_WINDOWS = 16;
const HUMAN: BrowserActor = { kind: "human", connectionId: "renderer" };
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const EMPTY: BrowserSnapshot = { tabs: [], activeTabId: null, visible: false, agents: [], downloads: [], pendingDialog: null };

interface WindowEntry {
  id: string;
  title: string;
  visible: boolean;
  owner: string | null;
  ownerLabel: string | null;
  service: BrowserService;
}

export interface BrowserWorkspaceOptions {
  userDataPath: string;
  audit: BrowserAuditWriter;
  createInstance(id: string, onState: (state: BrowserSnapshot) => void): BrowserService;
  onState(state: BrowserSnapshot): void;
  onActivity?(event: BrowserActivityEvent): void;
}

/** One audited routing layer; each card keeps its own native view and tab selection. */
export class BrowserWorkspace {
  readonly core = this;
  private readonly options: BrowserWorkspaceOptions;
  private readonly windows = new Map<string, WindowEntry>();
  private readonly current = new Map<string, string>();
  private readonly disconnected = new Set<string>();
  private readonly inflight = new Map<string, Set<Promise<BrowserResult>>>();
  private readonly dispatcher: BrowserCommandDispatcher;
  private readonly readyPromise: Promise<void>;
  private readonly filePath: string;
  private humanCurrent = DEFAULT_BROWSER_ID;
  private writeQueue = Promise.resolve();
  private disposed = false;

  constructor(options: BrowserWorkspaceOptions) {
    this.options = options;
    this.filePath = join(options.userDataPath, "browser-windows.json");
    this.add(DEFAULT_BROWSER_ID, "Browser", false);
    this.dispatcher = new BrowserCommandDispatcher({
      audit: options.audit,
      execute: (actor, command, signal) => this.run(actor, command, signal),
      getRevision: (id) => this.tab(id)?.documentRevision ?? null,
      getOrigin: (id) => { try { return new URL(this.tab(id)?.url ?? "").origin; } catch { return null; } },
      onActivity: options.onActivity
    });
    this.readyPromise = this.initialize();
  }

  ready(): Promise<void> { return this.readyPromise; }
  get primaryInstance(): BrowserService { return this.require(DEFAULT_BROWSER_ID).service; }

  getState(): BrowserSnapshot {
    const windows = [...this.windows.values()].map((entry) => ({ id: entry.id, title: entry.title, owner: entry.ownerLabel,
      snapshot: { ...entry.service.getState(), browserId: entry.id, visible: entry.visible } }));
    const active = windows.find((entry) => entry.id === this.humanCurrent)?.snapshot ?? EMPTY;
    const agents = new Map(windows.flatMap((entry) => entry.snapshot.agents).map((agent) => [agent.agentId, agent]));
    return { ...active, windows, tabs: windows.flatMap((entry) => entry.snapshot.tabs), agents: [...agents.values()],
      downloads: windows.flatMap((entry) => entry.snapshot.downloads) };
  }

  async execute(actor: BrowserActor, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
    await this.readyPromise;
    if (!command || typeof command !== "object") return this.dispatcher.execute(actor, command, signal);
    const key = actorKey(actor);
    const suppliedTab = command.tabId ?? (typeof command.ref === "object" ? command.ref.tabId : undefined);
    const browserId = command.browserId ?? (suppliedTab ? this.byTab(suppliedTab)?.id : undefined)
      ?? (actor.kind === "human" ? this.humanCurrent : this.current.get(key));
    const entry = browserId ? this.windows.get(browserId) : undefined;
    const tabId = suppliedTab ?? (needsTab(command.type) ? entry?.service.getState().activeTabId ?? undefined : undefined);
    const normalized = { ...command, ...(browserId ? { browserId } : {}), ...(tabId ? { tabId } : {}) };
    const pending = this.dispatcher.execute(actor, normalized, signal).then((result) => actor.kind === "agent" ? sanitizeAgentResult(result) : result);
    const owned = this.inflight.get(key) ?? new Set<Promise<BrowserResult>>();
    this.inflight.set(key, owned); owned.add(pending);
    try { return await pending; } finally { owned.delete(pending); if (owned.size === 0) this.inflight.delete(key); }
  }

  private async run(actor: BrowserActor, command: BrowserCommand, signal: AbortSignal): Promise<{ data?: unknown; tabId?: string | null }> {
    if (this.disposed) throw new BrowserKernelError("BRIDGE_UNAVAILABLE", "Browser workspace is closed.");
    if (command.browserId !== undefined && (typeof command.browserId !== "string" || !ID.test(command.browserId))) throw new BrowserKernelError("BROWSER_NOT_FOUND", "Invalid Browser card ID.");
    if (command.type === "browser_list_windows") return { data: { windows: [...this.windows.values()].map((entry) => ({
      id: entry.id, title: entry.title, visible: entry.visible, owner: entry.ownerLabel,
      available: entry.owner === null || entry.owner === actorKey(actor), tabCount: entry.service.getState().tabs.length
    })), currentBrowserId: actor.kind === "human" ? this.humanCurrent : this.current.get(actorKey(actor)) ?? null } };
    if (command.type === "browser_get_activity") {
      const since = command.cursor === undefined ? 0 : Number(command.cursor);
      if (!Number.isSafeInteger(since) || since < 0) throw new BrowserKernelError("PERMISSION_DENIED", "Invalid activity cursor.");
      const all = this.dispatcher.getActivity(since);
      const events = all.filter((event) => belongsTo(event, actor)).slice(0, command.limit ?? 1000);
      return { data: { events, nextCursor: String(events.at(-1)?.sequence ?? all.at(-1)?.sequence ?? since) } };
    }
    if (command.type === "browser_new_window") {
      const snapshot = await this.createWindow(actor, command.url, command.title, signal);
      return { data: snapshot, tabId: snapshot.activeTabId };
    }
    let entry = command.browserId ? this.windows.get(command.browserId) : undefined;
    if (command.browserId && !entry) throw new BrowserKernelError("BROWSER_NOT_FOUND", "Browser card was not found.");
    if (!entry && command.type === "browser_new_tab") {
      const snapshot = await this.createWindow(actor, command.url, undefined, signal);
      return { data: snapshot, tabId: snapshot.activeTabId };
    }
    if (!entry && command.type === "browser_list_tabs") return { data: structuredClone(EMPTY) };
    if (!entry) throw new BrowserKernelError("BROWSER_REQUIRED", "Create or select a Browser card first.");
    this.claim(entry, actor);
    if (command.tabId && this.byTab(command.tabId)?.id !== entry.id) throw new BrowserKernelError("TAB_NOT_FOUND", "Tab is outside the selected Browser card.");
    if (command.type === "browser_activate_window") {
      this.select(entry, actor);
      await entry.service.open(); entry.visible = true; await this.persist(); this.emit();
      return { data: entry.service.getState(), tabId: entry.service.getState().activeTabId };
    }
    const { browserId: _browserId, title: _title, ...scoped } = command;
    const result = await entry.service.executeInWorkspace(actor, scoped, signal);
    return result;
  }

  private async createWindow(actor: BrowserActor, url: string | undefined, title: string | undefined, signal: AbortSignal): Promise<BrowserSnapshot> {
    if (this.windows.size >= MAX_BROWSER_WINDOWS) throw new BrowserKernelError("RATE_LIMITED", "Browser card limit reached.");
    if (url !== undefined && !isSafeBrowserUrl(url)) throw new BrowserKernelError("INVALID_URL", "A Browser card requires an HTTP(S) URL.");
    if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 80 || /[\x00-\x1f]/.test(title))) {
      throw new BrowserKernelError("PERMISSION_DENIED", "Invalid Browser card title.");
    }
    const id = randomUUID();
    const number = [...this.windows.values()].filter((entry) => entry.visible || entry.service.getState().tabs.length > 0).length + 1;
    const entry = this.add(id, title?.trim() || `Browser ${number}`, true);
    this.claim(entry, actor); this.select(entry, actor);
    await entry.service.ready();
    await entry.service.executeInWorkspace(actor, { type: "browser_new_tab", requestId: randomUUID(), url: url ?? DEFAULT_BROWSER_URL }, signal);
    await this.persist(); this.emit();
    return entry.service.getState();
  }

  private claim(entry: WindowEntry, actor: BrowserActor): void {
    if (actor.kind === "human") return;
    const key = actorKey(actor);
    if (entry.owner && entry.owner !== key) throw new BrowserKernelError("BROWSER_IN_USE", "Browser card belongs to another agent.");
    entry.owner = key; entry.ownerLabel = `${actor.provider} · ${actor.terminalSessionId.slice(0, 8)}`;
    if (!this.current.has(key)) this.current.set(key, entry.id);
  }
  private select(entry: WindowEntry, actor: BrowserActor): void {
    if (actor.kind === "human") this.humanCurrent = entry.id;
    else this.current.set(actorKey(actor), entry.id);
  }

  subscribe(actor: BrowserActor, since: number, listener: (event: BrowserActivityEvent) => void): () => void {
    return this.dispatcher.subscribe(since, (event) => { if (belongsTo(event, actor)) listener(event); });
  }
  agentConnected(actor: BrowserActor): void { this.disconnected.delete(actorKey(actor)); }
  agentHeartbeat(actor: BrowserActor, timestamp: number): void { for (const entry of this.windows.values()) entry.service.core.agentHeartbeat(actor, timestamp); }
  agentCursor(actor: BrowserActor, cursor: { tabId: string; x: number; y: number }): void {
    const entry = this.byTab(cursor.tabId);
    if (entry && entry.owner === actorKey(actor)) entry.service.core.agentCursor(actor, cursor);
  }
  agentDisconnected(actor: BrowserActor): void {
    const key = actorKey(actor); this.disconnected.add(key);
    void Promise.allSettled([...(this.inflight.get(key) ?? [])]).then(() => {
      if (!this.disconnected.has(key)) return;
      this.dispatcher.clearActor(actor); this.current.delete(key);
      this.disconnected.delete(key);
      for (const entry of this.windows.values()) {
        entry.service.core.agentDisconnected(actor);
        if (entry.owner === key) { entry.owner = null; entry.ownerLabel = null; }
      }
      this.emit();
    });
  }

  async open(url?: string, browserId = this.humanCurrent): Promise<BrowserSnapshot> {
    await this.readyPromise;
    const entry = this.require(browserId); this.humanCurrent = browserId;
    entry.visible = true;
    const snapshot = entry.service.getState();
    if (snapshot.tabs.length === 0) await this.humanCommand({ type: "browser_new_tab", browserId, url: url ? entry.service.normalizeInput(url) : DEFAULT_BROWSER_URL });
    else if (url && snapshot.activeTabId) await this.navigate(snapshot.activeTabId, url);
    else await entry.service.open();
    await this.persist(); this.emit(); return this.getState();
  }
  async close(browserId = this.humanCurrent): Promise<void> {
    const entry = this.require(browserId); await entry.service.close(); entry.visible = false; await this.persist(); this.emit();
  }
  async closeAllTabs(browserId = this.humanCurrent): Promise<BrowserSnapshot> { for (const tab of this.require(browserId).service.getState().tabs) await this.closeTab(tab.id); return this.getState(); }
  async newTab(url?: string, browserId = this.humanCurrent): Promise<BrowserSnapshot> { return this.humanCommand({ type: "browser_new_tab", url, browserId }); }
  async selectTab(tabId: string): Promise<BrowserSnapshot> { this.humanCurrent = this.byTab(tabId)?.id ?? this.humanCurrent; return this.humanCommand({ type: "browser_activate_tab", tabId }); }
  async closeTab(tabId: string): Promise<BrowserSnapshot> { return this.humanCommand({ type: "browser_close_tab", tabId }); }
  async navigate(tabId: string, value: string): Promise<BrowserSnapshot> { return this.humanCommand({ type: "browser_navigate", tabId, url: this.requireTab(tabId).service.normalizeInput(value) }); }
  async back(tabId: string): Promise<BrowserSnapshot> { return this.humanCommand({ type: "browser_back", tabId }); }
  async forward(tabId: string): Promise<BrowserSnapshot> { return this.humanCommand({ type: "browser_forward", tabId }); }
  async reload(tabId: string): Promise<BrowserSnapshot> { return this.humanCommand({ type: "browser_reload", tabId }); }
  executeHuman(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> { return this.execute(HUMAN, command, signal); }
  private async humanCommand(command: Omit<BrowserCommand, "requestId">): Promise<BrowserSnapshot> {
    const result = await this.executeHuman({ ...command, requestId: randomUUID() });
    if (!result.ok) throw new Error(result.error?.message ?? "Browser action failed.");
    return this.getState();
  }
  getActivity(since = 0): BrowserActivityEvent[] { return this.dispatcher.getActivity(since); }
  focus(browserId = this.humanCurrent): void { this.humanCurrent = browserId; this.require(browserId).service.focus(); }
  setInputFocused(focused: boolean, browserId = this.humanCurrent): void {
    if (focused) this.humanCurrent = browserId;
    for (const entry of this.windows.values()) if (focused || entry.id === browserId) entry.service.setInputFocused(focused && entry.id === browserId);
  }
  setViewport(bounds: BrowserViewportBounds, browserId = this.humanCurrent): void { this.windows.get(browserId)?.service.setViewport(bounds); }
  decidePageWheel(sender: WebContents, input: unknown) { return this.byContents(sender)?.service.decidePageWheel(sender, input) ?? { generation: 0, owner: "page" as const }; }
  handlePageWheel(sender: WebContents, input: unknown): void { this.byContents(sender)?.service.handlePageWheel(sender, input); }
  beginRendererWheelSequence(input: unknown): void { for (const entry of this.windows.values()) entry.service.beginRendererWheelSequence(input); }
  setCanvasWheelCaptureMode(mode: CanvasWheelCaptureMode): void { for (const entry of this.windows.values()) entry.service.setCanvasWheelCaptureMode(mode); }
  setCanvasNavigationActive(active: boolean): void { for (const entry of this.windows.values()) entry.service.setCanvasNavigationActive(active); }
  setRendererCanvasGestureActive(active: boolean): void { for (const entry of this.windows.values()) entry.service.setRendererCanvasGestureActive(active); }
  cancelCanvasNavigationGesture(): void { for (const entry of this.windows.values()) entry.service.cancelCanvasNavigationGesture(); }
  setAgentPresences(values: readonly AgentPresenceSnapshot[]): void { for (const entry of this.windows.values()) entry.service.setAgentPresences(values.filter((agent) => agent.currentTabId && this.byTab(agent.currentTabId)?.id === entry.id)); }
  async setRestoreTabs(enabled: boolean): Promise<void> { for (const entry of this.windows.values()) await entry.service.setRestoreTabs(enabled); }
  async clearData(): Promise<BrowserSnapshot> { for (const entry of this.windows.values()) await entry.service.clearData(); return this.getState(); }
  async dispose(): Promise<void> { this.disposed = true; await this.readyPromise; await this.dispatcher.closeAndDrain(); await Promise.allSettled([...this.windows.values()].map((entry) => entry.service.dispose())); }

  private add(id: string, title: string, visible: boolean): WindowEntry {
    const service = this.options.createInstance(id, () => this.emit());
    const entry: WindowEntry = { id, title, visible, owner: null, ownerLabel: null, service };
    this.windows.set(id, entry); return entry;
  }
  private require(id: string): WindowEntry { const entry = this.windows.get(id); if (!entry) throw new BrowserKernelError("BROWSER_NOT_FOUND", "Browser card was not found."); return entry; }
  private byTab(id: string): WindowEntry | undefined { return [...this.windows.values()].find((entry) => entry.service.getState().tabs.some((tab) => tab.id === id)); }
  private requireTab(id: string): WindowEntry { const entry = this.byTab(id); if (!entry) throw new BrowserKernelError("TAB_NOT_FOUND", "Browser tab was not found."); return entry; }
  private byContents(contents: WebContents): WindowEntry | undefined { return [...this.windows.values()].find((entry) => entry.service.ownsContents(contents)); }
  private tab(id: string) { return this.byTab(id)?.service.getState().tabs.find((tab) => tab.id === id); }
  private emit(): void { if (!this.disposed) this.options.onState(this.getState()); }
  private async initialize(): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.filePath, "utf8")); } catch { parsed = null; }
    if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === 1 && "windows" in parsed && Array.isArray(parsed.windows)) {
      for (const value of parsed.windows.slice(0, MAX_BROWSER_WINDOWS)) {
        if (!value || typeof value !== "object" || typeof value.id !== "string" || !ID.test(value.id)
          || typeof value.title !== "string" || value.title.length > 80) continue;
        if (this.windows.size >= MAX_BROWSER_WINDOWS && !this.windows.has(value.id)) continue;
        const entry = this.windows.get(value.id) ?? this.add(value.id, value.title, value.visible === true);
        entry.visible = value.visible === true;
      }
    }
    await Promise.all([...this.windows.values()].map((entry) => entry.service.ready()));
  }
  private persist(): Promise<void> {
    const text = JSON.stringify({ version: 1, windows: [...this.windows.values()].map(({ id, title, visible }) => ({ id, title, visible })) }, null, 2) + "\n";
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true }); const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 }); await rename(temporary, this.filePath);
    });
    return this.writeQueue;
  }
}

function actorKey(actor: BrowserActor): string { return actor.kind === "agent" ? `${actor.agentId}:${actor.connectionId}` : `human:${actor.connectionId}`; }
function belongsTo(event: BrowserActivityEvent, actor: BrowserActor): boolean { return actor.kind === "human" || event.agentId === actor.agentId && event.terminalSessionId === actor.terminalSessionId; }
function needsTab(type: BrowserCommand["type"]): boolean { return !["browser_new_window", "browser_list_windows", "browser_activate_window", "browser_new_tab", "browser_list_tabs", "browser_get_activity"].includes(type); }
