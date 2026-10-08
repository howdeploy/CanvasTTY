import { useEffect, useRef, useState, type FormEvent } from "react";
import { CANVAS_LAUNCHER_ITEMS, PROVIDER_LABELS, type ProviderId } from "../../../src/shared/providerCatalog.ts";
import {
  CompanionClient, forgetPairing, loadSaved, markApproved, startPairing,
  type Action, type Overview, type Session,
} from "./client.ts";
import "./style.css";
import type { CompanionQuestion } from "../../../src/shared/companion.ts";

const statusNames: Record<Session["status"], string> = {
  idle: "Ready", working: "Working", needs_approval: "Needs attention",
  unavailable: "Activity unknown", done: "Done", failed: "Failed",
};
const PIN_KEY = "canvastty.mobile.pins.v1";
function savedPins(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Connection unavailable";
}
function shortDate(value: number): string {
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : "Unknown start";
}

export default function App() {
  const [client, setClient] = useState<CompanionClient | null>(() => {
    const saved = loadSaved();
    return saved ? new CompanionClient(saved) : null;
  });
  const [pin, setPin] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selected, setSelected] = useState("");
  const [menuOpen, setMenuOpen] = useState(true);
  const [filter, setFilter] = useState<ProviderId | "all">("all");
  const [pins, setPins] = useState(savedPins);
  const [readable, setReadable] = useState<{ sessionId: string; body: string; question?: CompanionQuestion | null } | null>(null);
  const [replyDraft, setReplyDraft] = useState({ requestId: "", text: "" });
  const [rename, setRename] = useState<string | null>(null);
  const [mutation, setMutation] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const pairController = useRef<AbortController | null>(null);
  const mutationInFlight = useRef(false);
  const viewRevision = useRef(0);

  // Reset synchronously before the polling effect starts for a new selection.
  function selectSession(id: string, closeMenu = true) {
    if (closeMenu) setMenuOpen(false);
    if (id === selected) return;
    viewRevision.current += 1;
    setReadable(null);
    setRename(null);
    setSelected(id);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  useEffect(() => {
    if (!client || client.state !== "pending") return;
    let active: AbortController | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const check = async () => {
      if (stopped || document.hidden || active) return;
      active = new AbortController();
      const signal = active.signal;
      try {
        const state = await client.approval(signal);
        if (signal.aborted || stopped) return;
        if (state === "approved") {
          setClient(markApproved(client));
          setError("");
          return;
        }
        if (state === "rejected") {
          forgetPairing();
          setClient(null);
          setError("Desktop rejected the request or the code expired. Start pairing again.");
          return;
        }
        delay = 1000;
        setError("");
      } catch (failure) {
        if (signal.aborted || stopped) return;
        setError(`Waiting for desktop approval: ${message(failure)}`);
        delay = Math.min(delay * 2, 15000);
      } finally {
        active = null;
        if (!stopped && !document.hidden) timer = setTimeout(check, delay);
      }
    };
    const visibility = () => {
      if (document.hidden) {
        active?.abort();
        clearTimeout(timer);
        timer = undefined;
      } else if (!active && !timer) void check();
    };
    void check();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      active?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [client]);

  useEffect(() => {
    if (!client || client.state !== "approved") return;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delay = 2500;
    const poll = async () => {
      if (stopped || document.hidden || controller) return;
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const next = await client.action<Overview>({ type: "sessions.overview" }, signal);
        if (signal.aborted) return;
        setOverview(next);
        setConnected(true);
        setError("");
        if (!selected && next.sessions[0]) {
          selectSession(next.sessions[0].id, false);
          return;
        }
        const sessionId = selected;
        if (sessionId && next.sessions.some(session => session.id === sessionId)) {
          const view = await client.action<{ body: string; revision: string; question?: CompanionQuestion | null }>({ type: "session.read", sessionId }, signal);
          if (!signal.aborted) setReadable({ sessionId, body: view.body, question: view.question });
        }
        delay = 2500;
      } catch (failure) {
        if (signal.aborted) return;
        setConnected(false);
        setError(`Connection unavailable: ${message(failure)}. Retrying; if access was revoked on the desktop, forget this connection and pair again. Actions are not retried.`);
        delay = Math.min(delay * 2, 30000);
      } finally {
        controller = null;
        if (!stopped && !document.hidden) timer = setTimeout(poll, delay);
      }
    };
    const visibility = () => {
      if (document.hidden) {
        controller?.abort();
        clearTimeout(timer);
        timer = undefined;
      } else if (!controller && !timer) void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [client, selected, refresh]);

  async function pair(event: FormEvent) {
    event.preventDefault();
    if (pairBusy) return;
    setPairBusy(true);
    setError("");
    const controller = new AbortController();
    pairController.current = controller;
    try {
      const next = await startPairing(location.origin, pin, controller.signal);
      setPin("");
      setClient(next);
    } catch (failure) {
      if (!controller.signal.aborted) {
        const pending = loadSaved();
        if (pending?.state === "pending") setClient(new CompanionClient(pending));
        setError(message(failure));
      }
    } finally { pairController.current = null; setPairBusy(false); }
  }
  function disconnect() {
    viewRevision.current += 1;
    pairController.current?.abort();
    forgetPairing();
    setClient(null);
    setOverview(null);
    selectSession("");
    setMenuOpen(true);
    setConnected(false);
    setError("");
  }
  async function act<T>(action: Action, onSuccess?: (value: T) => void) {
    if (!client || mutationInFlight.current || !connected) return;
    if (action.type === "session.interrupt" && !window.confirm("Stop this agent's current turn?")) return;
    const revision = viewRevision.current;
    mutationInFlight.current = true;
    setMutation(true);
    setError("");
    try {
      const result = await client.action<T>(action);
      if (viewRevision.current === revision) onSuccess?.(result);
      setRefresh(value => value + 1);
    } catch (failure) {
      setError(`Action outcome may be unknown: ${message(failure)}. Check the desktop before sending again.`);
    } finally { mutationInFlight.current = false; setMutation(false); }
  }
  function togglePin(id: string) {
    const next = pins.includes(id) ? pins.filter(value => value !== id) : [...pins, id];
    setPins(next);
    localStorage.setItem(PIN_KEY, JSON.stringify(next));
  }
  const sessions = overview?.sessions || [];
  const current = sessions.find(session => session.id === selected);
  const question = readable?.sessionId === selected ? readable.question : null;
  function reply(answer: string | number) {
    if (!current || !question || !window.confirm(`Send this answer to ${current.title}?`)) return;
    void act({ type: "session.reply", sessionId: current.id, requestId: question.id, answer }, () => {
      setReadable(view => view ? { ...view, question: null } : view);
      setReplyDraft({ requestId: "", text: "" });
    });
  }
  const sorted = sessions.filter(session => filter === "all" || session.provider === filter)
    .sort((a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id)) || b.startedAt - a.startedAt);
  const groups = [
    { label: "Attention", items: sorted.filter(session => session.status === "needs_approval" || session.status === "failed") },
    { label: "Working", items: sorted.filter(session => session.status === "working") },
    { label: "Other sessions · recent first", items: sorted.filter(session => !["needs_approval", "failed", "working"].includes(session.status)) },
  ];

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">&gt;_</span><div><h1 className="brand-name">CanvasTTY</h1><span className="brand-caption">WEB COMPANION</span></div></div>
      <div className="topbar-right"><span className={`connection ${connected ? "online" : ""}`}>{client?.state === "pending" ? "Awaiting desktop approval" : connected ? "Connected" : client ? "Reconnecting" : "Not paired"}</span>
        {client?.state === "approved" && <button className="menu-toggle" type="button" aria-expanded={menuOpen} aria-controls="session-menu" onClick={() => setMenuOpen(value => !value)}>{menuOpen ? "Close menu" : "Sessions"}</button>}
      </div>
    </header>
    {!globalThis.isSecureContext && <p className="alert">Open this companion through trusted private-network HTTPS, Tailscale Serve HTTPS, or USB reverse loopback; Web Crypto requires a secure context.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
    {!client ? <section className="pair-card">
      <h2>Pair this browser</h2><p>On the desktop, enable the companion, choose shared sessions and open a six-digit pairing code. Approval is required on the desktop.</p>
      <form onSubmit={pair}>
        <p>Host: <code>{location.origin}</code>. To pair a different desktop, open its own trusted private-network HTTPS, Tailscale HTTPS, or USB loopback /mobile/ address first.</p>
        <label>Six-digit code<input type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" required /></label>
        <button className="primary" disabled={pairBusy || !globalThis.isSecureContext}>{pairBusy ? "Pairing…" : "Request pairing"}</button>
      </form>
    </section> : client.state === "pending" ? <section className="pair-card">
      <h2>Waiting for approval</h2><p>Approve this browser in CanvasTTY on the desktop. This page checks the request while it is visible; it resumes after reopening.</p>
      <button onClick={disconnect}>Forget this request</button>
    </section> : <div className="layout">
      {menuOpen && <div className="menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
      <aside id="session-menu" className={`sidebar ${menuOpen ? "menu-open" : ""}`} aria-label="Session menu">
        <div className="section-head"><div><span className="eyebrow">DESKTOP / SHARED</span><h2>Shared sessions</h2></div><button className="subtle" onClick={() => setRefresh(value => value + 1)}>Refresh</button></div>
        <label className="compact">Provider<select value={filter} onChange={event => setFilter(event.target.value as ProviderId | "all")}><option value="all">All providers</option>{CANVAS_LAUNCHER_ITEMS.map(provider => <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>)}</select></label>
        {groups.map(group => group.items.length > 0 && <section key={group.label} className="session-group"><h3>{group.label}</h3>{group.items.map(session => <div key={session.id} className={`session-item ${selected === session.id ? "active" : ""}`}>
          <button className="session-select" aria-current={selected === session.id ? "true" : undefined} onClick={() => selectSession(session.id)}><span className="session-title">{session.title}</span><span className="session-meta">{PROVIDER_LABELS[session.provider]} · {statusNames[session.status]}</span><span className="session-meta">{shortDate(session.startedAt)}</span>{session.attention?.length ? <span className="session-meta" role="status">Attention: {session.attention.at(-1)?.kind}</span> : null}</button>
          <button aria-label={pins.includes(session.id) ? `Unpin ${session.title}` : `Pin ${session.title}`} aria-pressed={pins.includes(session.id)} className="pin" onClick={() => togglePin(session.id)}>{pins.includes(session.id) ? "★" : "☆"}</button>
        </div>)}</section>)}
        {!sorted.length && <p className="muted">{sessions.length ? "No sessions for this provider." : "No sessions shared yet. Select sessions on the desktop."}</p>}
        <button className="subtle forget" onClick={disconnect}>Forget connection on this browser</button>
      </aside>
      <section className="detail" aria-label="Session detail">
        {!current ? <p className="muted">Choose a shared session to view its status and questions.</p> : <>
          <div className="detail-head"><div><span className="eyebrow">{PROVIDER_LABELS[current.provider]} · {statusNames[current.status]}</span><h2>{current.title}</h2><small>Started {shortDate(current.startedAt)}{current.exitCode !== null ? ` · Exit ${current.exitCode}` : ""}</small></div><div className="detail-actions">
            {overview?.permissions.allowRename && <button onClick={() => setRename(current.title)}>Rename</button>}
            {overview?.permissions.allowClose && <button className="danger" disabled={!connected || mutation} onClick={() => { if (window.confirm(`Close ${current.title} on the desktop?`)) void act({ type: "session.close", sessionId: current.id }, () => selectSession("")); }}>Close</button>}
            {overview?.permissions.allowInterrupt && current.exitCode === null && <button disabled={!connected || mutation} onClick={() => void act({ type: "session.interrupt", sessionId: current.id })}>Stop turn</button>}
          </div></div>
          {rename !== null && <form className="rename" onSubmit={event => { event.preventDefault(); const title = rename.trim(); if (title) void act({ type: "session.rename", sessionId: current.id, title }, () => setRename(null)); }}><input aria-label="New session title" maxLength={80} value={rename} onChange={event => setRename(event.target.value)} /><button disabled={!connected || mutation || !rename.trim()}>Save name</button><button type="button" onClick={() => setRename(null)}>Cancel</button></form>}
          <p className="notice">This phone receives status, task summaries and questions. Terminal output and files stay on the desktop.</p>
          <pre className="readable">{(readable?.sessionId === current.id && readable.body) || `${current.title}\nStatus: ${statusNames[current.status]}`}</pre>
          {question && <section aria-label="Agent question" className="pair-card">
            <h3>Agent question</h3><pre>{question.question}</pre>
            {!overview?.permissions.allowReply ? <p className="notice">Reply access is disabled on the desktop.</p>
              : question.options.length ? question.options.map((option, index) => <button key={index}
                disabled={!connected || mutation || Date.now() >= question.expiresAt}
                onClick={() => reply(index)}>{option}</button>)
              : <form onSubmit={event => { event.preventDefault(); reply(replyDraft.requestId === question.id ? replyDraft.text : ""); }}>
                <textarea aria-label="Answer" maxLength={2000} value={replyDraft.requestId === question.id ? replyDraft.text : ""}
                  onChange={event => setReplyDraft({ requestId: question.id, text: event.target.value })} />
                <button disabled={!connected || mutation || Date.now() >= question.expiresAt ||
                  replyDraft.requestId !== question.id || !replyDraft.text.trim()}>Send answer</button>
              </form>}
          </section>}
        </>}
      </section>
    </div>}
  </main>;
}
