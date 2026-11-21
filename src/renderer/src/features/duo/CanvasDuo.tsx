import "./canvasDuo.css";
import { duoWorkspace, useDuoWorkspace } from "./duoWorkspaceRuntime";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import { DUO_CURSOR_DESIGNS, DUO_CURSOR_NICKNAME_MAX_LENGTH, normalizeDuoCursorNickname, type DuoCard, type DuoCommand, type DuoCursorDesign, type DuoReply, type DuoSnapshot, type DuoState } from "../../../../shared/canvasDuo";
import { defaultDuoCursorDesign, duoCursorName, DuoCursorMark } from "./DuoCursorMark";
import { UiIcon } from "../../components/UiIcon";
import { useModalFocus } from "../../lib/useModalFocus";
import { Segmented } from "../settings/SettingsControls";
const EMPTY: DuoState = { role: "idle", invites: [], expiresAt: 0, available: [], selected: [], controlled: [], peer: false };
export default function CanvasDuo({ titlebarSlot, locale, cursorDesign, cursorNickname = "", onCursorDesignChange, onCursorNicknameChange, onVisibilityChange, onCreateShared, onFocusTerminal, onGoHome, onCreateNote }: {
  titlebarSlot: HTMLDivElement | null;
  locale: LocaleId;
  cursorDesign?: DuoCursorDesign;
  cursorNickname?: string;
  onCursorDesignChange(design: DuoCursorDesign): void;
  onCursorNicknameChange(nickname: string): void;
  onVisibilityChange(open: boolean): void;
  onCreateShared(): void;
  onFocusTerminal(card: DuoCard): void;
  onGoHome(): void;
  onCreateNote(): void;
}): React.JSX.Element {
  const ru = locale === "ru";
  const [open, setOpen] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);
  const [state, setState] = useState(EMPTY);
  const [snapshot, setSnapshot] = useState<DuoSnapshot | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [controlled, setControlled] = useState<string[]>([]);
  const [invite, setInvite] = useState("");
  const workspace = useDuoWorkspace();
  const [fullCanvas,setFullCanvas]=useState(true);
  const [manage, setManage] = useState(false);
  const [commentCard, setCommentCard] = useState("");
  const [sharedComment, setSharedComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnosticStatus,setDiagnosticStatus]=useState("");
  const [copied, setCopied] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const active = useRef(true); const lastCursor = useRef(0); const panel = useRef<HTMLElement>(null);
  const lastState = useRef(EMPTY);
  const apply = (reply: DuoReply): void => {
    if (!active.current) return;
    duoWorkspace.publish(reply);
    const previous = lastState.current;
    lastState.current = reply.state;
    if (reply.state.role !== previous.role) {
      setSelected(reply.state.selected); setControlled(reply.state.controlled); setManage(reply.state.manage===true); if(reply.state.role!=="idle")setFullCanvas(reply.state.fullCanvas===true);
    } else if (reply.state.role === "host") {
      // Preserve unsaved edits, but never display an input grant revoked by a
      // disconnect/expired peer lease as still active.
      const removed = previous.selected.filter(id => !reply.state.selected.includes(id));
      const added = reply.state.selected.filter(id => !previous.selected.includes(id));
      if (removed.length || added.length) setSelected(ids => [...new Set([...ids.filter(id => !removed.includes(id)), ...added])]);
      const revoked = previous.controlled.filter(id => !reply.state.controlled.includes(id));
      const granted = reply.state.controlled.filter(id => !previous.controlled.includes(id));
      if (revoked.length || granted.length) setControlled(ids => [...new Set([...ids.filter(id => !revoked.includes(id)), ...granted])]);
      if (previous.manage && !reply.state.manage) setManage(false);
    }
    setState(reply.state);
    if (reply.snapshot) setSnapshot(duoWorkspace.get().reply?.snapshot ?? reply.snapshot);
    if (reply.state.role === "idle") setSnapshot(null);
  };
  const changeOpen = (value: boolean): void => {
    if (!value) setNicknameDraft(null);
    setOpen(value);
    onVisibilityChange(value);
  };
  useEffect(() => { active.current = true; void window.canvasTTY.duo.command({ action: "state" }).then(reply => { if (!active.current) return; apply(reply); setSelected(reply.state.selected); setControlled(reply.state.controlled); }).catch(e => { if (active.current) setError(String(e)); }); return () => { active.current = false; onVisibilityChange(false); }; }, []);
  useModalFocus(panel, open);
  useEffect(() => {
    const receive = (): void => { void window.canvasTTY.duo.command({action:'invitation'}).then(reply=>{
      if(active.current && reply.invitation){ setInvite(reply.invitation); changeOpen(true); }
    }).catch(()=>undefined); };
    const unsubscribe=window.canvasTTY.duo.onInvitation(receive); receive(); return unsubscribe;
  }, []);
  const run = async (command: DuoCommand): Promise<boolean> => {
    if (busy && command.action!=="stop") return false; setBusy(true); setError("");
    try {
      const reply=await window.canvasTTY.duo.command(command); apply(reply);
      if(command.action==='host' && reply.state.invites[0]){window.canvasTTY.clipboard.writeText(reply.state.invites[0]);setCopied(true);setTimeout(()=>setCopied(false),2000);}
      if(command.action==='join'||command.action==='host') changeOpen(false);
      return true;
    }
    catch (e) { if (active.current) setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { if (active.current) setBusy(false); }
  };
  useEffect(() => {
    return window.canvasTTY.duo.onChanged(reply=>{apply(reply);setError(reply.error??"");});
  }, []);
  useEffect(()=>{
    if(open)void window.canvasTTY.duo.command({action:'state'}).then(apply).catch(e=>setError(String(e)));
  },[open]);
  const shareCursor = (event: React.PointerEvent<HTMLElement>, cardId: string): void => {
    if (Date.now() - lastCursor.current < 400 || busy) return;
    lastCursor.current = Date.now(); const r = event.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    void window.canvasTTY.duo.command({ action: "cursor", cardId, x: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)), design: cursorDesign, nickname: cursorNickname }).catch(() => undefined);
  };
  const shared = workspace.reply?.snapshot;
  const sharedActive = Boolean(workspace.reply && workspace.reply.state.role!=="idle");
  const selectedCommentCard = shared?.cards.some(c=>c.id===commentCard) ? commentCard : (state.fullCanvas?"canvas":shared?.cards[0]?.id ?? "");
  const status = workspace.connected ? (ru ? "Подключено" : "Connected")
    : state.status === "waiting" ? (ru ? "Ожидаем гостя" : "Waiting for guest")
      : state.role === "idle" ? "" : (ru ? "Нет связи" : "Disconnected");
  const role = state.role === "host" ? (ru ? "Хост" : "Host") : (ru ? "Гость" : "Guest");
  const cursorDesignLabel = ru ? "Дизайн курсора" : "Cursor design";
  const selectedCursorDesign = cursorDesign ?? defaultDuoCursorDesign(state.role);
  const nextNickname = normalizeDuoCursorNickname(nicknameDraft ?? cursorNickname) ?? "";
  const launchLabel = status ? `Duo · ${status}` : "Duo";
  const launch = <button type="button" className="duo-launch" onClick={() => changeOpen(!open)}
    aria-label={launchLabel} title={launchLabel} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "canvas-duo-panel" : undefined}>
    <UiIcon name="app-window" size="1.05em" /><span>Duo</span>
    {status && <span className="duo-status-dot" data-connected={workspace.connected} aria-hidden="true" />}
  </button>;
  return <>
    {sharedActive && <aside className="duo-workspace-hud" aria-label={ru ? "Общий холст" : "Shared canvas"}>
      <strong>Duo · {role}</strong>
      <span className="duo-status" role="status"><span className="duo-status-dot" data-connected={workspace.connected} />{status}</span>
      <button type="button" className="duo-action" disabled={state.role==="guest" && (!workspace.connected || !shared?.manage)} onClick={()=>{if(state.role==="guest"&&state.fullCanvas&&!state.documentSync){void duoWorkspace.command({action:"surface-action",name:"terminal"}).catch(()=>undefined);}else onCreateShared();}}>
        <UiIcon name="terminal" size="1em" />{ru ? "Терминал" : "Terminal"}
      </button>
      {workspace.connected && (!state.fullCanvas || state.documentSync) && shared?.cards.length ? (
        <DuoTerminalPicker cards={shared.cards} viewer={state.role} ru={ru} onFocusTerminal={onFocusTerminal} />
      ) : null}
      {state.fullCanvas && <>
        <button type="button" className="duo-action" disabled={state.role==='guest'&&(!workspace.connected||!state.manage)} onClick={()=>{if(state.documentSync)onCreateNote();else void duoWorkspace.command({action:'surface-action',name:'note'}).catch(()=>undefined);}}>
          <UiIcon name="sticky-note" size="1em" />{ru ? "Заметка" : "Note"}
        </button>
        <button type="button" className="duo-action" onClick={()=>{if(state.documentSync)onGoHome();else void duoWorkspace.command({action:'surface-action',name:'home'}).catch(()=>undefined);}}>
          <UiIcon name="home" size="1em" />Home
        </button>
      </>}
      <button type="button" className="duo-action duo-action--danger" onClick={()=>void run({action:"stop"})}>{ru ? "Отключиться" : "Disconnect"}</button>
      {workspace.error && <p role="alert">{workspace.error}</p>}
      <details className="duo-shared-comments" open={state.fullCanvas?undefined:true}><summary>{ru ? "Чат" : "Chat"}</summary>
        <select aria-label={ru ? "Канал чата" : "Chat channel"} value={selectedCommentCard} onChange={e=>setCommentCard(e.target.value)}>{state.fullCanvas&&<option value="canvas">{ru ? "Весь холст" : "Entire canvas"}</option>}{shared?.cards.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select>
        <div className="duo-comments" aria-live="polite">{shared?.comments.filter(c=>c.cardId===selectedCommentCard).map(c=><p key={c.id}><b>{c.author === "host" ? (ru ? "Хост" : "Host") : (ru ? "Гость" : "Guest")}</b> {c.text}</p>)}</div>
        <form onSubmit={e=>{e.preventDefault();void duoWorkspace.command({action:"comment",cardId:selectedCommentCard,text:sharedComment}).then(()=>setSharedComment("")).catch(()=>undefined);}}>
          <input aria-label={ru ? "Сообщение" : "Chat message"} value={sharedComment} maxLength={1000} onChange={e=>setSharedComment(e.target.value)} placeholder={ru ? "Сообщение…" : "Message…"} />
          <button className="duo-action" disabled={!selectedCommentCard || !sharedComment.trim() || (state.role==="guest"&&!workspace.connected)}>{ru ? "Отправить" : "Send"}</button>
        </form>
      </details>
    </aside>}
    {titlebarSlot ? createPortal(launch, titlebarSlot) : launch}
    {open && <div className="dialog-backdrop duo-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) changeOpen(false);
    }}>
    <section ref={panel} id="canvas-duo-panel" className="settings-panel settings-panel--open duo-panel"
      role="dialog" aria-labelledby="canvas-duo-title" aria-modal="true" tabIndex={-1}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); changeOpen(false); } }}>
      <header className="settings-panel__header">
        <h2 id="canvas-duo-title">Canvas Duo</h2>
        {status && <span className="duo-status" role="status"><span className="duo-status-dot" data-connected={workspace.connected} />{status}</span>}
        <button className="settings-panel__close" type="button" onClick={() => changeOpen(false)} aria-label={ru ? "Закрыть" : "Close"}><UiIcon name="close" size="1.05em" /></button>
      </header>
      <div className="settings-panel__content duo-panel__body" data-role={state.role}>
        {state.role === "guest" && state.fullCanvas && <section className="duo-section">
          <h3>{ru ? "Доступ к холсту" : "Canvas access"}</h3>
          <p className="duo-muted">{state.manage && workspace.connected
            ? (ru ? "Хост разрешил управление." : "The host has allowed control.")
            : (ru ? "Только просмотр. Управление может разрешить хост." : "View only. The host can grant control.")}</p>
        </section>}
        {state.role !== "guest" && <section className="duo-setup duo-section">
          <h3>{state.role === "idle" ? (ru ? "Пригласить гостя" : "Invite a guest") : (ru ? "Доступ гостя" : "Guest access")}</h3>
          {state.role === "idle" && <div className="duo-sharing-scope" role="group" aria-label={ru ? "Что увидит гость" : "What the guest can see"}>
            <Segmented value={fullCanvas ? "canvas" : "terminals"} disabled={busy}
              options={[["canvas", ru ? "Весь холст" : "Entire canvas"], ["terminals", ru ? "Терминалы" : "Terminals"]]}
              onChange={value => setFullCanvas(value === "canvas")} />
          </div>}
          {fullCanvas && <p className="duo-muted">{ru ? "Гость увидит содержимое холста, включая открытые страницы браузера." : "The guest can see the canvas, including open browser pages."}</p>}
          {!fullCanvas && !state.available.length && <p className="duo-muted">{ru ? "Откройте терминал, чтобы поделиться им." : "Open a terminal to share it."}</p>}
          {!fullCanvas && state.available.map(card => <div className="duo-choice" key={card.id}><label><input type="checkbox" checked={selected.includes(card.id)} disabled={busy || (!selected.includes(card.id) && selected.length >= 8)} onChange={e => { const checked = e.currentTarget.checked; setSelected(ids => checked ? [...ids, card.id] : ids.filter(id => id !== card.id)); if (!checked) setControlled(ids => ids.filter(id => id !== card.id)); }} />{card.title}</label>
            <label><input type="checkbox" checked={controlled.includes(card.id)} disabled={busy || !selected.includes(card.id)} onChange={e => { const checked = e.currentTarget.checked; setControlled(ids => checked ? [...ids, card.id] : ids.filter(id => id !== card.id)); }} />{ru ? "Разрешить ввод" : "Allow input"}</label></div>)}
          <label className="duo-manage"><input type="checkbox" checked={manage} disabled={busy} onChange={e=>setManage(e.target.checked)} />
            <span>{ru ? "Разрешить управление" : "Allow control"}
              <small className="duo-muted">{ru ? "Действия выполняются на компьютере хоста с его правами." : "Actions run on the host’s computer with the host’s permissions."}</small>
            </span>
          </label>
          <button type="button" className="duo-action duo-action--primary" disabled={busy || (!fullCanvas && selected.length === 0)} onClick={() => void run({ action: state.role === "host" ? "select" : "host", selected:fullCanvas?[]:selected, controlled:fullCanvas?[]:controlled, manage, ...(state.role==="idle"?{fullCanvas,documentSync:fullCanvas}:{}) })}>
            {state.role === "host" ? (ru ? "Применить доступ" : "Apply access") : (ru ? "Создать и скопировать ссылку" : "Create and copy link")}
          </button>
        </section>}
        {state.role === "idle" && <form className="duo-join duo-section" onSubmit={e => { e.preventDefault(); if (invite && !busy) void run({ action: "join", invite }); }}>
          <h3>{ru ? "Подключиться по ссылке" : "Join with a link"}</h3>
          <label>{ru ? "Ссылка-приглашение" : "Invitation link"}<input autoComplete="off" spellCheck={false} value={invite} onChange={e => setInvite(e.target.value.trim())} maxLength={1800} placeholder={ru ? "Вставьте ссылку-приглашение" : "Paste invitation link"} /></label>
          <button className="duo-action duo-action--primary" disabled={busy || !invite}>{ru ? "Подключиться" : "Connect"}</button>
        </form>}
        {state.role === "host" && <section className="duo-section">
          <h3>{ru ? "Приглашение" : "Invitation"}</h3>
          <p className="duo-muted">{ru ? "Ссылка действует до" : "Link expires at"} {new Date(state.expiresAt).toLocaleTimeString(ru ? "ru-RU" : "en-US", { hour: "2-digit", minute: "2-digit" })}</p>
          {state.invites.map(code => <div className="duo-invite-row" key={code}>
            <input aria-label={ru ? "Ссылка-приглашение" : "Invitation link"} readOnly value={code} onFocus={e => e.currentTarget.select()} />
            <button type="button" className="duo-action" onClick={() => { window.canvasTTY.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
              <UiIcon name={copied ? "done" : "copy"} size="1em" />{copied ? (ru ? "Скопировано" : "Copied") : (ru ? "Копировать" : "Copy")}
            </button>
          </div>)}
        </section>}
        <section className="duo-cursor-design duo-section">
          <h3 id="duo-cursor-design-title">{cursorDesignLabel}</h3>
          <form className="duo-input duo-cursor-nickname" onSubmit={event => {
            event.preventDefault();
            if (nextNickname === cursorNickname) return;
            setNicknameDraft(nextNickname);
            onCursorNicknameChange(nextNickname);
          }}>
            <label>
              {ru ? "Твой ник" : "Your nickname"}
              <input autoComplete="off" maxLength={DUO_CURSOR_NICKNAME_MAX_LENGTH} dir="auto"
                value={nicknameDraft ?? cursorNickname} onChange={event => setNicknameDraft(event.target.value)} />
            </label>
            <button type="submit" className="duo-action" disabled={nextNickname === cursorNickname}>{ru ? "Сохранить" : "Save"}</button>
          </form>
          <div className="duo-cursor-design__grid" role="group" aria-labelledby="duo-cursor-design-title">
            {DUO_CURSOR_DESIGNS.map(design => (
              <button type="button" key={design} className="duo-cursor-design__option"
                aria-pressed={selectedCursorDesign === design} onClick={() => onCursorDesignChange(design)}>
                <DuoCursorMark design={design} />
                <span>{duoCursorName(design, locale)}</span>
              </button>
            ))}
          </div>
        </section>
        {error && <p role="alert" className="duo-error">{error}</p>}
        {Boolean(snapshot?.cards.length) && <div className="duo-cards">{snapshot?.cards.map(card => <article key={card.id} className="duo-card duo-section">
          <h3><span>{card.title}</span><small className="duo-muted">{card.provider} · {card.running ? (ru ? "Активен" : "Running") : (ru ? "Остановлен" : "Stopped")}{card.control ? (ru ? " · Ввод разрешён" : " · Input allowed") : ""}</small></h3>
          <div className="duo-screen" onPointerMove={e => shareCursor(e, card.id)}>
            <pre>{card.text}</pre>
            {snapshot.cursors.filter(c => c.cardId === card.id && c.author !== state.role).map(c => (
              <span key={c.author} className="duo-cursor" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}>
                <DuoCursorMark design={c.design} author={c.author} nickname={c.nickname} locale={locale} />
              </span>
            ))}
          </div>
          {state.role === "guest" && card.control && <form className="duo-input" onSubmit={e => { e.preventDefault(); const text = drafts[card.id] ?? ""; void run({ action: "input", cardId: card.id, text: text + "\r" }).then(ok => { if (ok) setDrafts(d => ({ ...d, [card.id]: "" })); }); }}>
            <label>{ru ? "Команда для терминала хоста" : "Host terminal command"}<input value={drafts[card.id] ?? ""} maxLength={4000} disabled={busy || !card.running} onChange={e => { const value = e.currentTarget.value; setDrafts(d => ({ ...d, [card.id]: value })); }} /></label><button className="duo-action duo-action--primary" disabled={busy || !card.running}>{ru ? "Отправить" : "Send"}</button>
            <button type="button" className="duo-action" disabled={busy || !card.running} onClick={() => void run({ action: "input", cardId: card.id, text: "\u0003" })}>Ctrl+C</button>
          </form>}
          <div className="duo-comments">{snapshot.comments.filter(c => c.cardId === card.id).map(c => <p key={c.id}><strong>{c.author === "host" ? (ru ? "Хост" : "Host") : (ru ? "Гость" : "Guest")}</strong> {c.text}</p>)}</div>
          <form className="duo-input" onSubmit={e => { e.preventDefault(); void run({ action: "comment", cardId: card.id, text: comments[card.id] ?? "" }).then(ok => { if (ok) setComments(d => ({ ...d, [card.id]: "" })); }); }}><input aria-label={ru ? "Сообщение в чат терминала" : "Terminal chat message"} placeholder={ru ? "Сообщение в чат терминала…" : "Message…"} maxLength={1000} disabled={busy} value={comments[card.id] ?? ""} onChange={e => { const value = e.currentTarget.value; setComments(d => ({ ...d, [card.id]: value })); }} /><button className="duo-action" disabled={busy || !comments[card.id]?.trim()}>{ru ? "Отправить" : "Send"}</button></form>
        </article>)}</div>}
      </div>
      <footer className="duo-panel__footer">
        <div className="duo-diagnostics">
          <button type="button" className="duo-action"
            title={ru ? "Журнал подключения без приглашений, адресов и содержимого холста" : "Connection log without invitations, addresses, or canvas content"}
            onClick={() => {
              void window.canvasTTY.duo.diagnostics().then(report => {
                window.canvasTTY.clipboard.writeText(JSON.stringify(report, null, 2));
                setDiagnosticStatus(ru ? "Диагностика скопирована" : "Diagnostics copied");
              }).catch(() => setDiagnosticStatus(ru ? "Не удалось получить диагностику" : "Could not read diagnostics"));
            }}><UiIcon name="copy" size="1em" />{ru ? "Скопировать диагностику" : "Copy diagnostics"}</button>
          <small className="duo-muted" role="status">{diagnosticStatus}</small>
        </div>
        {state.connection && <small className="duo-muted">{ru ? "Прямое зашифрованное соединение" : "Direct encrypted connection"}</small>}
        {(state.role !== "idle" || busy) && <button type="button" className="duo-stop duo-action duo-action--danger" onClick={() => void run({ action: "stop" })}>
          {state.role === "idle" ? (ru ? "Отменить" : "Cancel") : (ru ? "Отключиться" : "Disconnect")}
        </button>}
      </footer>
    </section></div>}
  </>;
}

function DuoTerminalPicker({ cards, viewer, ru, onFocusTerminal }: {
  cards: DuoCard[];
  viewer: DuoState["role"];
  ru: boolean;
  onFocusTerminal(card: DuoCard): void;
}) {
  const other = viewer === "guest" ? "host" : "guest";
  const groups = [
    { role: viewer, label: ru ? "Мои терминалы" : "My terminals" },
    { role: other, label: other === "host" ? (ru ? "Терминалы хоста" : "Host terminals") : (ru ? "Терминалы гостя" : "Guest terminals") },
    { role: undefined, label: ru ? "Общие терминалы" : "Shared terminals" }
  ];
  const label = ru ? "Перейти к терминалу" : "Go to terminal";
  return <select className="duo-terminal-picker" aria-label={label} value="" onChange={event => {
    const card = cards.find(item => item.id === event.target.value);
    if (card) onFocusTerminal(card);
  }}>
    <option value="" disabled>{label}</option>
    {groups.map(group => {
      const owned = cards.filter(card => card.participant === group.role);
      return owned.length > 0 && <optgroup key={group.role ?? "shared"} label={group.label}>
        {owned.map((card, index) => <option key={card.id} value={card.id}>{index + 1}. {card.title}</option>)}
      </optgroup>;
    })}
  </select>;
}
