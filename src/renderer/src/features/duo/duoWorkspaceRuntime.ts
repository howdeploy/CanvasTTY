import { useSyncExternalStore } from "react";
import type { CanvasTTYApi, ProviderId, SessionSnapshot, TerminalDataEvent } from "../../../../shared/contracts";
import type { DuoCard, DuoCommand, DuoReply } from "../../../../shared/canvasDuo";
import { mergeDuoSnapshot } from '../../../../shared/canvasDuo.ts';

type View = { reply: DuoReply | null; error: string; connected: boolean };
let view: View = { reply: null, error: "", connected: false };
const listeners = new Set<() => void>();
const dataListeners = new Set<(event: TerminalDataEvent) => void>();
const sessions = new Map<string, { key: string; session: SessionSnapshot }>();
export const duoWorkspace = {
  get: (): View => view,
  subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  publish(reply: DuoReply): void {
    const previous = view.reply?.snapshot;
    const sameWorkspace = reply.state.workspaceId === view.reply?.state.workspaceId;
    if (sameWorkspace && reply.snapshot) reply = { ...reply, snapshot: mergeDuoSnapshot(previous, reply.snapshot) };
    if (reply.state.role === "idle") sessions.clear();
    if(!reply.snapshot && reply.state.role!=="idle" && reply.state.workspaceId===view.reply?.state.workspaceId) reply={...reply,snapshot:previous};
    view = { reply, error: reply.error ?? "", connected: reply.state.status === "connected" || (reply.state.status === undefined && reply.state.role === "guest") };
    for (const c of reply.snapshot?.cards ?? []) {
      if (!c.output) continue;
      const old = previous?.cards.find(item => item.id === c.id)?.output;
      if (!old || c.output.outputOffset > old.outputOffset) {
        const event = { id: c.id, data: c.output.buffer, outputOffset: c.output.outputOffset };
        for (const listener of dataListeners) listener(event);
      }
    }
    for (const listener of listeners) listener();
  },
  fail(error: unknown, disconnected = true): void {
    view = { ...view, error: error instanceof Error ? error.message : String(error), connected: disconnected ? false : view.connected };
    for (const listener of listeners) listener();
  },
  async command(command: DuoCommand): Promise<DuoReply> {
    try { const reply = await window.canvasTTY.duo.command(command); duoWorkspace.publish(reply); return reply; }
    catch (error) { duoWorkspace.fail(error, /disconnected|timed out|closed|invitation|Start or join|connection/i.test(String(error))); throw error; }
  }
};
export function useDuoWorkspace(): View { return useSyncExternalStore(duoWorkspace.subscribe, duoWorkspace.get); }
export function duoSession(card: DuoCard): SessionSnapshot {
  const key = JSON.stringify([card.title, card.provider, card.position, card.size, card.running, card.revision, card.control, card.nativeEditor]);
  const old = sessions.get(card.id); if (old?.key === key) return old.session;
  const session: SessionSnapshot = { id: card.id, revision: card.revision ?? 1, provider: card.provider as ProviderId, profile: "normal", title: card.title, titleCustomized: true, cwd: "", position: card.position, size: card.size, role: "agent", status: card.running ? "idle" : "done", startedAt: 0, exitCode: card.running ? null : 0, failureDetails: null, buffer: "", nativeEditor: card.nativeEditor };
  sessions.set(card.id, { key, session }); return session;
}
const guest = (): boolean => view.reply?.state.role === "guest";
const active = (): boolean => Boolean(view.reply && view.reply.state.role !== "idle");
const card = (id: string): DuoCard => {
  const c = view.reply?.snapshot?.cards.find(c => c.id === id);
  if (!c) throw new Error("This terminal is not in the shared workspace."); return c;
};
const send = (command: DuoCommand): void => { void duoWorkspace.command(command).catch(() => undefined); };
const requireConnection = (): void => { if (guest() && !view.connected) throw new Error("Duo: connection lost. Reconnect before editing the shared workspace."); };

/** A stable, explicit terminal transport. No replacement of the global preload API. */
export function duoTerminalTransport(local: CanvasTTYApi["terminal"]): CanvasTTYApi["terminal"] {
  const pendingInput = new Map<string, { text: string; workspaceId?: string; running: boolean }>();
  let lastInputAt = -Infinity;
  const flushInput = async (id: string): Promise<void> => {
    const pending = pendingInput.get(id);
    if (!pending) return;
    // Keep room under the host's 30 requests/s limit for updates and heartbeat.
    // The first key still gets the short batch delay; sustained input is coalesced.
    const wait = 50 - (performance.now() - lastInputAt);
    if (wait > 0) { setTimeout(() => void flushInput(id), Math.ceil(wait)); return; }
    try {
      requireConnection();
      if (!guest() || view.reply?.state.workspaceId !== pending.workspaceId || !card(id).control) throw new Error("Duo: input permission changed. Pending input discarded.");
      lastInputAt = performance.now();
      const text = pending.text.slice(0, 4096);
      pending.text = pending.text.slice(text.length);
      await duoWorkspace.command({ action: "input", cardId: id, text });
      if (pending.text) { setTimeout(() => void flushInput(id), 8); return; }
    } catch (error) { duoWorkspace.fail(error, /connection|disconnected|expired|rejected/i.test(String(error))); }
    pendingInput.delete(id);
  };
  const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    ...local,
    list: () => guest() ? Promise.resolve((view.reply?.snapshot?.cards ?? []).map(duoSession)) : local.list(),
    async create(request) {
      if (!active() || (view.reply?.state.role==="host" && view.reply.state.fullCanvas)) return local.create(request);
      requireConnection();
      if (request.provider !== "terminal") throw new Error("В общем столе пока можно создавать только обычные терминалы. Агент запускается хостом и добавляется через Duo.");
      const reply = await duoWorkspace.command({ action: "create", x: request.position.x, y: request.position.y });
      const created = reply.snapshot?.cards.find(c => c.id === reply.snapshot?.createdId);
      if (!created) throw new Error("Shared terminal was not confirmed by the host.");
      return duoSession(created);
    },
    readBuffer: id => {
      if (!guest()) return local.readBuffer(id);
      const output = card(id).output;
      return output ? Promise.resolve(output) : Promise.reject(new Error("Host needs the shared-workspace update."));
    },
    onData: (listener, id) => {
      if (!guest()) return local.onData(listener, id);
      const filtered = (event: TerminalDataEvent): void => { if (!id || id === event.id) listener(event); };
      dataListeners.add(filtered); return () => { dataListeners.delete(filtered); };
    },
    input: (id, text, protocolReply) => {
      if (!guest()) return local.input(id, text, protocolReply);
      if (protocolReply) return; // The host terminal handles its own terminal queries.
      try { requireConnection(); if (!card(id).control) throw new Error("Хост не разрешил ввод в этот терминал."); if (!text) return;
        const pending = pendingInput.get(id) ?? { text: "", workspaceId: view.reply?.state.workspaceId, running: false };
        if (pending.text.length + text.length > 131072) throw new Error("Duo: слишком большой объём ввода. Отправьте текст частями.");
        pending.text += text; pendingInput.set(id, pending);
        if (!pending.running) { pending.running = true; setTimeout(() => void flushInput(id), 8); } }
      catch (error) { duoWorkspace.fail(error, false); }
    },
    resize: (id, cols, rows) => {
      if (!guest()) return local.resize(id, cols, rows);
      // The host owns PTY geometry. Local zoom/fit must never resize the other user's terminal.
      if (view.reply?.state.documentSync) return;
      const c = view.reply?.snapshot?.cards.find(c => c.id === id);
      if (view.connected && c?.control && (c.output?.cols !== cols || c.output.rows !== rows)) {
        clearTimeout(resizeTimers.get(id));
        const workspaceId = view.reply?.state.workspaceId;
        resizeTimers.set(id, setTimeout(() => {
          resizeTimers.delete(id);
          if (guest() && view.connected && view.reply?.state.workspaceId === workspaceId) send({ action: "resize", cardId: id, cols, rows });
        }, 180));
      }
    },
    setBounds: (id, bounds) => {
      if (!guest()) return local.setBounds(id, bounds);
      if (!view.connected) return;
      send({ action: "bounds", cardId: id, bounds });
    },
    async rename(id, title) {
      if (!guest()) return local.rename(id, title);
      requireConnection(); await duoWorkspace.command({ action: "rename", cardId: id, text: title }); return duoSession(card(id));
    },
    async dispose(id, options) {
      if (!guest()) return local.dispose(id, options);
      requireConnection(); await duoWorkspace.command({ action: "close", cardId: id });
    },
    restart: (id, options) => guest() ? Promise.reject(new Error("Перезапуск выполняет хост.")) : local.restart(id, options),
    setRestore: (id, restore) => guest() ? Promise.resolve(duoSession(card(id))) : local.setRestore(id, restore),
    setVisible: (id, visible) => { if (!guest()) local.setVisible(id, visible); },
    acknowledgeOutput: (id, offset) => { if (!guest()) local.acknowledgeOutput?.(id, offset); },
    async openFile(id, reference) {
      if(!guest())return local.openFile(id,reference);
      requireConnection();await duoWorkspace.command({action:'file-open',cardId:id,text:reference});
    },
    async canOpenFile(id,reference) {
      if(!guest())return local.canOpenFile(id,reference);
      if(!view.connected||!view.reply?.state.manage)return false;
      return (await duoWorkspace.command({action:'file-can-open',cardId:id,text:reference})).snapshot?.result===true;
    },
    fileDropText: files => {requireConnection();return local.fileDropText(files);}
  };
}
