import "./canvasDuo.css";
import { duoWorkspace, useDuoWorkspace } from "./duoWorkspaceRuntime";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type { DuoCommand, DuoReply, DuoSnapshot, DuoState } from "../../../../shared/canvasDuo";
const EMPTY: DuoState = { role: "idle", invites: [], expiresAt: 0, available: [], selected: [], controlled: [], peer: false };
export default function CanvasDuo({ titlebarSlot, locale, onVisibilityChange, onCreateShared, onGoHome, onCreateNote }: { titlebarSlot: HTMLDivElement | null; locale: LocaleId; onVisibilityChange(open: boolean): void; onCreateShared(): void; onGoHome(): void; onCreateNote(): void }): React.JSX.Element {
  const ru = locale === "ru";
  const [open, setOpen] = useState(false);
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
  const changeOpen = (value: boolean): void => { setOpen(value); onVisibilityChange(value); };
  useEffect(() => { active.current = true; void window.canvasTTY.duo.command({ action: "state" }).then(reply => { if (!active.current) return; apply(reply); setSelected(reply.state.selected); setControlled(reply.state.controlled); }).catch(e => { if (active.current) setError(String(e)); }); return () => { active.current = false; onVisibilityChange(false); }; }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("button")?.focus());
    return () => { cancelAnimationFrame(frame); previous?.focus(); };
  }, [open]);
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
    void window.canvasTTY.duo.command({ action: "cursor", cardId, x: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)) }).catch(() => undefined);
  };
  const shared = workspace.reply?.snapshot;
  const sharedActive = Boolean(workspace.reply && workspace.reply.state.role!=="idle");
  const selectedCommentCard = shared?.cards.some(c=>c.id===commentCard) ? commentCard : (state.fullCanvas?"canvas":shared?.cards[0]?.id ?? "");
  const launch = <button type="button" className={`duo-launch${state.role !== "idle" ? " duo-launch--active" : ""}`} onClick={() => changeOpen(!open)} aria-expanded={open} aria-controls="canvas-duo-panel">◉ Duo{state.role !== "idle" ? workspace.connected ? " · LIVE" : state.role === "host" ? (ru ? " · Ожидание" : " · Waiting") : (ru ? " · Нет связи" : " · Disconnected") : ""}</button>;
  return <>
    {sharedActive && <aside className="duo-workspace-hud" aria-label="Общее рабочее пространство">
      <strong>Общий стол · {state.role==="host" ? "этот компьютер — хост" : state.fullCanvas ? "тот же Canvas хозяина" : "терминалы на компьютере хоста"}</strong>
      <span role="status">{workspace.connected ? "Соединение установлено" : workspace.reply?.state.status==="waiting" ? "Ожидаем участника" : "Связь потеряна · управление недоступно"}</span>
      <button disabled={state.role==="guest" && (!workspace.connected || !shared?.manage)} onClick={()=>{if(state.role==="guest"&&state.fullCanvas&&!state.documentSync){void duoWorkspace.command({action:"surface-action",name:"terminal"}).catch(()=>undefined);}else onCreateShared();}}>＋ Общий терминал</button>
      {state.fullCanvas&&<><button disabled={state.role==='guest'&&(!workspace.connected||!state.manage)} onClick={()=>{if(state.documentSync)onCreateNote();else void duoWorkspace.command({action:'surface-action',name:'note'}).catch(()=>undefined);}}>＋ Заметка</button><button onClick={()=>{if(state.documentSync)onGoHome();else void duoWorkspace.command({action:'surface-action',name:'home'}).catch(()=>undefined);}}>Home</button></>}
      <button onClick={()=>void run({action:"stop"})}>Отключиться</button>
      {workspace.error && <p role="alert">{workspace.error}</p>}
      <details className="duo-shared-comments" open={state.fullCanvas?undefined:true}><summary>Комментарии общего стола</summary>
        <select aria-label="Терминал для комментария" value={selectedCommentCard} onChange={e=>setCommentCard(e.target.value)}>{state.fullCanvas&&<option value="canvas">Весь холст</option>}{shared?.cards.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select>
        <div aria-live="polite">{shared?.comments.filter(c=>c.cardId===selectedCommentCard).map(c=><p key={c.id}><b>{c.author==="host"?"Хост":"Гость"}</b> {c.text}</p>)}</div>
        <form onSubmit={e=>{e.preventDefault();void duoWorkspace.command({action:"comment",cardId:selectedCommentCard,text:sharedComment}).then(()=>setSharedComment("")).catch(()=>undefined);}}>
          <input aria-label="Общий комментарий" value={sharedComment} maxLength={1000} onChange={e=>setSharedComment(e.target.value)} placeholder="Сообщение для второго участника…" />
          <button disabled={!selectedCommentCard || !sharedComment.trim() || (state.role==="guest"&&!workspace.connected)}>Отправить</button>
        </form>
      </details>
    </aside>}
    {titlebarSlot ? createPortal(launch, titlebarSlot) : launch}
    {open && <div className="duo-backdrop" onPointerDown={() => changeOpen(false)} /> }
    {open && <section ref={panel} id="canvas-duo-panel" className="duo-panel" role="dialog" aria-label="Canvas Duo" aria-modal="true" onKeyDown={e => {
      if (e.key === "Tab") {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])];
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first && last) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last && first) { e.preventDefault(); first.focus(); }
      }
      if (e.key === "Escape") { e.stopPropagation(); changeOpen(false); } }}>
      <header><div><strong>Canvas Duo</strong><small>{ru ? "Одна рабочая сессия. Два компьютера." : "One workspace. Two computers."}</small></div><button onClick={() => changeOpen(false)} aria-label={ru ? "Закрыть панель" : "Close panel"}>×</button></header>
      <div className="duo-panel__body">
        <details className="duo-diagnostics"><summary>{ru ? "Проблема с подключением?" : "Connection trouble?"}</summary>
          <p>{ru ? "Скопируйте журнал этапов подключения для разбора. Он не содержит приглашений, адресов устройств или содержимого рабочего стола. Автоматической отправки нет." : "Copy connection stages for troubleshooting. No invitations, device addresses, or workspace content are included. Nothing is uploaded automatically."}</p>
          <button onClick={()=>{void window.canvasTTY.duo.diagnostics().then(report=>{window.canvasTTY.clipboard.writeText(JSON.stringify(report,null,2));setDiagnosticStatus(ru?"Диагностика скопирована":"Diagnostics copied");}).catch(()=>setDiagnosticStatus(ru?"Не удалось получить диагностику":"Could not read diagnostics"));}}>{ru ? "Скопировать диагностику Duo" : "Copy Duo diagnostics"}</button>
          <span role="status">{diagnosticStatus}</span>
        </details>
        <p>{ru ? "Пригласите человека по ссылке — Canvas напрямую соединит ваши компьютеры. Содержимое зашифровано между устройствами. Ссылка действует один час; ввод разрешаете вы." : "Invite someone with a link — Canvas connects your computers directly. Content is encrypted between devices. The link lasts one hour; you decide who can type."}</p>
        {state.role !== "guest" && <details className="duo-setup" open={state.role === "idle"}><summary>{ru ? "Что увидит гость" : "What your guest can see"} · {fullCanvas?"весь холст":selected.length}</summary>
          {state.role==='idle'&&<label className="duo-manage"><input type="checkbox" checked={fullCanvas} onChange={e=>setFullCanvas(e.target.checked)}/>Весь Canvas: Home, терминалы, заметки, файлы, медиа, плагины и браузер. У каждого своя камера: масштаб и перемещение независимы.</label>}
          {fullCanvas&&<p>Гость видит весь холст и открытые в Canvas страницы, включая данные на них. При разрешении управления он работает с файлами и приложениями Canvas с вашими правами. Системные окна вне Canvas не передаются.</p>}
          {!fullCanvas && !state.available.length && <p>{ru ? "Откройте терминал, затем выберите его здесь." : "Open a terminal, then select it here."}</p>}
          {!fullCanvas && state.available.map(card => <div className="duo-choice" key={card.id}><label><input type="checkbox" checked={selected.includes(card.id)} disabled={busy || (!selected.includes(card.id) && selected.length >= 8)} onChange={e => { const checked = e.currentTarget.checked; setSelected(ids => checked ? [...ids, card.id] : ids.filter(id => id !== card.id)); if (!checked) setControlled(ids => ids.filter(id => id !== card.id)); }} />{card.title}</label>
            <label><input type="checkbox" checked={controlled.includes(card.id)} disabled={busy || !selected.includes(card.id)} onChange={e => { const checked = e.currentTarget.checked; setControlled(ids => checked ? [...ids, card.id] : ids.filter(id => id !== card.id)); }} />{ru ? "Разрешить ввод" : "Allow input"}</label></div>)}
          <label className="duo-manage"><input type="checkbox" checked={manage} onChange={e=>setManage(e.target.checked)} />Разрешить управление общим столом: создание, ввод, редактирование, перемещение и закрытие элементов. Терминалы выполняют команды с правами пользователя хоста.</label>
          <button disabled={busy || (!fullCanvas && selected.length === 0)} onClick={() => void run({ action: state.role === "host" ? "select" : "host", selected:fullCanvas?[]:selected, controlled:fullCanvas?[]:controlled, manage, ...(state.role==="idle"?{fullCanvas,documentSync:fullCanvas}:{}) })}>{state.role === "host" ? (ru ? "Применить доступ" : "Apply access") : (ru ? "Создать и скопировать ссылку" : "Create and copy link")}</button>
        </details>}
        {state.role === "idle" && <form className="duo-join" onSubmit={e => { e.preventDefault(); void run({ action: "join", invite }); }}>
          <h3>{ru ? "Подключиться к другому Canvas" : "Join another Canvas"}</h3>
          <label>{ru ? "Ссылка-приглашение" : "Invitation link"}<input autoComplete="off" spellCheck={false} value={invite} onChange={e => setInvite(e.target.value.trim())} maxLength={1800} placeholder={ru ? "Вставьте ссылку-приглашение" : "Paste invitation link"} /></label>
          <button disabled={busy || !invite}>{ru ? "Подключиться" : "Connect"}</button>
        </form>}
        {state.role === "host" && <details className="duo-invites" open={!state.peer}><summary>{state.peer ? (ru ? "Гость подключён" : "Guest connected") : (ru ? "Ожидаем гостя" : "Waiting for guest")} · {ru ? "до" : "until"} {new Date(state.expiresAt).toLocaleTimeString(ru ? "ru-RU" : "en-US")}</summary>
          {state.invites.map(code => <div key={code}><label>{ru ? "Ссылка-приглашение" : "Invitation link"}<input readOnly value={code} onFocus={e => e.currentTarget.select()} /></label><button onClick={() => { window.canvasTTY.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? "✓" : (ru ? "Копировать" : "Copy")}</button></div>)}
          <p>{ru ? "Отправьте ссылку человеку. Он откроет её и нажмёт «Подключиться» в Canvas. Ввод выключен, пока вы его не разрешите." : "Send the link. They open it and click Connect in Canvas. Input stays off until you allow it."}</p>
        </details>}
        {state.connection && <p className="duo-connection">P2P · {ru ? "Прямое зашифрованное соединение" : "Direct encrypted connection"}</p>}
        {(state.role !== "idle" || busy) && <button className="duo-stop" onClick={() => void run({ action: "stop" })}>{ru ? "Отключить Duo и отозвать доступ" : "Disconnect Duo and revoke access"}</button>}
        {error && <p role="alert" className="duo-error">{error}</p>}
        <div className="duo-cards">{snapshot?.cards.map(card => <article key={card.id} className="duo-card">
          <h3><span>{card.title}</span><small>{card.provider} · {card.running ? "LIVE" : "STOPPED"}{card.control ? " · INPUT" : ""}</small></h3>
          <div className="duo-screen" onPointerMove={e => shareCursor(e, card.id)}><pre>{card.text}</pre>{snapshot.cursors.filter(c => c.cardId === card.id && c.author !== (state.role === "host" ? "host" : "guest")).map(c => <span key={c.author} className="duo-cursor" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}>↖ {c.author}</span>)}</div>
          {state.role === "guest" && card.control && <form className="duo-input" onSubmit={e => { e.preventDefault(); const text = drafts[card.id] ?? ""; void run({ action: "input", cardId: card.id, text: text + "\r" }).then(ok => { if (ok) setDrafts(d => ({ ...d, [card.id]: "" })); }); }}>
            <label>{ru ? "Команда для терминала хоста (Enter отправляет)" : "Host terminal command (Enter sends)"}<input value={drafts[card.id] ?? ""} maxLength={4000} disabled={busy || !card.running} onChange={e => { const value = e.currentTarget.value; setDrafts(d => ({ ...d, [card.id]: value })); }} /></label><button disabled={busy || !card.running}>{ru ? "Отправить ↵" : "Send ↵"}</button>
            <button type="button" disabled={busy || !card.running} onClick={() => void run({ action: "input", cardId: card.id, text: "\u0003" })}>Ctrl+C</button>
          </form>}
          <div className="duo-comments">{snapshot.comments.filter(c => c.cardId === card.id).map(c => <p key={c.id}><strong>{c.author === "host" ? (ru ? "Хост" : "Host") : (ru ? "Гость" : "Guest")}</strong> {c.text}</p>)}</div>
          <form className="duo-input" onSubmit={e => { e.preventDefault(); void run({ action: "comment", cardId: card.id, text: comments[card.id] ?? "" }).then(ok => { if (ok) setComments(d => ({ ...d, [card.id]: "" })); }); }}><input aria-label={ru ? "Комментарий к карточке" : "Card comment"} placeholder={ru ? "Комментарий к карточке…" : "Comment on this card…"} maxLength={1000} disabled={busy} value={comments[card.id] ?? ""} onChange={e => { const value = e.currentTarget.value; setComments(d => ({ ...d, [card.id]: value })); }} /><button disabled={busy || !comments[card.id]?.trim()}>{ru ? "Добавить" : "Add"}</button></form>
        </article>)}</div>
        <p className="duo-scope">{ru ? (state.fullCanvas||fullCanvas ? "Общие объекты Canvas; у каждого своя камера, масштаб и фокус. Терминалы выполняются на хосте. Страницы браузера передаются отдельно; системные диалоги выбора файлов подтверждает хозяин." : "Режим терминалов: выбранные терминалы, курсоры и комментарии на основном холсте.") : "Shared Canvas objects with independent cameras, zoom and focus. Terminals run on the host; native file dialogs are handled by the host."}</p>
      </div>
    </section>}
  </>;
}
