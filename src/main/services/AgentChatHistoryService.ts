import { stat } from "node:fs/promises";
import { normalizeThreadId } from "../../agent-runtime/runtime-protocol.mjs";
import type { AgentChatHistoryPage, AgentChatHistoryProviderId, AgentChatHistoryResumeResult, AgentProviderId, Point, SessionSnapshot } from "../../shared/contracts.ts";
import type { SettingsStore } from "./SettingsStore.ts";
import type { TerminalManager } from "./TerminalManager.ts";
import type { ProviderCliRegistry } from "./providerCliRegistry.ts";
import { codexHistory } from "./agent-history/codexHistory.ts";
import { grokHistory } from "./agent-history/grokHistory.ts";
import { hermesHistory } from "./agent-history/hermesHistory.ts";
import { opencodeHistory } from "./agent-history/opencodeHistory.ts";
import { unsupportedHistory, missing, type HistoryAdapter, type HistoryRecords } from "./agent-history/historyFiles.ts";
import { jsonlHistory } from "./agent-history/jsonlHistory.ts";
import { kimiHistory } from "./agent-history/kimiHistory.ts";
import { minimaxHistory } from "./agent-history/minimaxHistory.ts";
import { cursorHistory } from "./agent-history/cursorHistory.ts";
import { resolveAgentHistoryPaths } from "./agent-history/historyPaths.ts";

const PAGE_SIZE = 50;
type CodexLaunchGuard = (cwd: string) => Promise<void>;
type CachedHistory = HistoryRecords & { generation: number };

export class AgentChatHistoryService {
  private readonly adapters: Record<AgentProviderId, HistoryAdapter>;
  private readonly cache = new Map<AgentChatHistoryProviderId, CachedHistory>();
  private readonly pending = new Map<AgentChatHistoryProviderId, Promise<CachedHistory>>();
  private controller = new AbortController();
  private generation = 0;

  constructor(
    private readonly settings: SettingsStore,
    private readonly providerClis: ProviderCliRegistry,
    private readonly terminals: TerminalManager,
    hermesHome: string
  ) {
    const paths = resolveAgentHistoryPaths();
    this.adapters = {
      codex: codexHistory(paths.codex),
      hermes: hermesHistory(hermesHome),
      grok: grokHistory(paths.grok),
      opencode: opencodeHistory(paths.opencode),
      claude: jsonlHistory("claude", paths.claude),
      qwen: jsonlHistory("qwen", paths.qwen),
      kimi: kimiHistory(paths.kimi, paths.kimiCode),
      omp: jsonlHistory("omp", paths.omp),
      pi: jsonlHistory("pi", paths.pi),
      cursor: cursorHistory(paths.cursor),
      minimax: minimaxHistory(paths.minimax),
      devin: unsupportedHistory("Devin"),
      antigravity: unsupportedHistory("Antigravity")
    };
  }

  providers(): AgentChatHistoryProviderId[] {
    if (this.controller.signal.aborted || !this.settings.get().agentChatHistoryVisible) return [];
    const enabled = this.settings.get().homeLauncherProviders;
    return (Object.keys(this.adapters) as AgentChatHistoryProviderId[]).filter((provider) =>
      (enabled.includes(provider) || this.providerClis.get(provider).state === "available")
      && this.providerClis.get(provider).state === "available");
  }

  settingsChanged(): void {
    if (this.settings.get().agentChatHistoryVisible) return;
    this.dispose();
    this.controller = new AbortController();
  }

  dispose(): void {
    this.controller.abort();
    this.pending.clear();
    this.cache.clear();
  }

  async list(provider: AgentChatHistoryProviderId, cursor?: string): Promise<AgentChatHistoryPage> {
    this.assertProvider(provider);
    const empty: AgentChatHistoryPage = { provider, items: [], nextCursor: null };
    const cli = this.providerClis.get(provider);
    if (cli.state === "unavailable") return { ...empty, error: cli.diagnostic };
    try {
      const match = cursor === undefined ? null : /^(\d+):(\d+)$/.exec(cursor);
      if (cursor !== undefined && !match) throw new Error("Invalid history page. Refresh the list.");
      const data = await this.load(provider, cursor !== undefined);
      if (match && Number(match[1]) !== data.generation) throw new Error("History changed. Refresh the list.");
      const offset = match ? Number(match[2]) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.items.length) throw new Error("Invalid history page. Refresh the list.");
      return {
        provider, items: data.items.slice(offset, offset + PAGE_SIZE),
        nextCursor: offset + PAGE_SIZE < data.items.length ? `${data.generation}:${offset + PAGE_SIZE}` : null,
        ...(data.skipped ? { warning: `${data.skipped} unreadable or unsupported history records were skipped.` } : {})
      };
    } catch (error) {
      return { ...empty, error: missing(error) ? "History store was not found. Start a conversation in this CLI first."
        : error instanceof Error ? error.message : "History could not be read. Check access and refresh the list." };
    }
  }

  async resume(provider: AgentChatHistoryProviderId, id: string, position: Point, beforeCodexLaunch?: CodexLaunchGuard): Promise<AgentChatHistoryResumeResult> {
    try { return await this.resumeConversation(provider, id, position, beforeCodexLaunch); }
    catch (error) {
      return { error: { code: "resume-failed", message: missing(error)
        ? "History store was not found. Refresh the list."
        : error instanceof Error ? error.message : "The conversation could not be resumed." } };
    }
  }

  private async resumeConversation(provider: AgentChatHistoryProviderId, id: string, position: Point, beforeCodexLaunch?: CodexLaunchGuard): Promise<AgentChatHistoryResumeResult> {
    this.assertProvider(provider);
    const threadId = normalizeThreadId(provider, id);
    if (!threadId) return { error: { code: "invalid-id", message: "Invalid provider conversation ID." } };
    const existing = this.terminals.findLocalConversation(provider, threadId);
    if (existing) return this.resumeExisting(existing, beforeCodexLaunch);
    const cli = this.providerClis.get(provider);
    if (cli.state === "unavailable") return { error: { code: "cli-unavailable", message: cli.diagnostic } };
    // Reload before a launch: the entry may have been deleted or its recorded cwd changed.
    const signal = this.controller.signal;
    const history = await this.adapters[provider].read(signal);
    signal.throwIfAborted();
    this.assertProvider(provider);
    const item = history.items.find((candidate) => candidate.id === threadId);
    if (!item) return { error: { code: "conversation-missing", message: "This conversation no longer exists. Refresh the history." } };
    if (!item.cwd) return { error: { code: "cwd-unknown", message: "This conversation has no recorded working directory and cannot be resumed here." } };
    try {
      if (!(await stat(item.cwd)).isDirectory()) throw new Error("Not a directory");
    } catch {
      return { error: { code: "cwd-unavailable", message: `The recorded working directory is unavailable: ${item.cwd}` } };
    }
    signal.throwIfAborted();
    this.assertProvider(provider);
    if (provider === "codex") await beforeCodexLaunch?.(item.cwd);
    signal.throwIfAborted();
    this.assertProvider(provider);
    const raced = this.terminals.findLocalConversation(provider, threadId);
    if (raced) return this.resumeExisting(raced, beforeCodexLaunch);
    return { session: this.terminals.create({ provider, cwd: item.cwd, profile: "normal", position, title: item.title, resumeThreadId: threadId }), reused: false };
  }

  private async resumeExisting(session: SessionSnapshot, beforeCodexLaunch?: CodexLaunchGuard): Promise<AgentChatHistoryResumeResult> {
    if (session.exitCode !== null && beforeCodexLaunch) {
      const folder = this.terminals.localCodexFolderForTrust(session.id);
      if (folder) await beforeCodexLaunch(folder);
      this.controller.signal.throwIfAborted();
      this.assertProvider(session.provider as AgentChatHistoryProviderId);
      const current = this.terminals.list().find((candidate) => candidate.id === session.id);
      if (!current) throw new Error("The conversation was closed during confirmation.");
      if (current.exitCode !== null && folder && this.terminals.localCodexFolderForTrust(session.id) !== folder) {
        throw new Error("The conversation folder changed during confirmation.");
      }
      session = current;
    }
    const resumed = session.exitCode === null ? session : this.terminals.restart(session.id, {
      resume: true, ...(beforeCodexLaunch ? { beforeLocalCodexLaunch: beforeCodexLaunch } : {})
    });
    if (resumed.status === "failed") {
      return { error: { code: "resume-failed", message: resumed.failureDetails || "The conversation could not be resumed. Check the terminal card." } };
    }
    return { session: resumed, reused: true };
  }

  private assertProvider(provider: AgentChatHistoryProviderId): void {
    if (!Object.hasOwn(this.adapters, provider) || !this.providers().includes(provider)) {
      throw new Error("Chat history is disabled for this provider.");
    }
  }

  private async load(provider: AgentChatHistoryProviderId, keepPage = false): Promise<CachedHistory> {
    const cached = this.cache.get(provider);
    if (cached && keepPage) return cached;
    const pending = this.pending.get(provider);
    if (pending) return pending;
    const signal = this.controller.signal;
    const request = this.adapters[provider].read(signal).then((records): CachedHistory => {
      signal.throwIfAborted();
      records.items.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id));
      const data = { ...records, generation: ++this.generation };
      this.cache.set(provider, data);
      return data;
    });
    this.pending.set(provider, request);
    try { return await request; }
    finally { if (this.pending.get(provider) === request) this.pending.delete(provider); }
  }
}
