import { useEffect, useRef, useState } from 'react';
import type { LocaleId, SessionSnapshot } from '../../../../shared/contracts';
import { attachTerminalOutput } from './terminalOutput';

/** Plain text transcript: ACP bytes never enter xterm or an HTML renderer. */
export function AcpSessionPanel({ session, locale }: { session: SessionSnapshot; locale: LocaleId }): React.JSX.Element {
  const [transcript, setTranscript] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const [unread, setUnread] = useState(false);
  const ru = locale === 'ru';
  const state = session.acp;
  const phaseLabels = ru ? { starting: 'Подключение', idle: 'Готов', running: 'Работает', done: 'Ответ завершён', failed: 'Ошибка' } : { starting: 'Connecting', idle: 'Ready', running: 'Working', done: 'Response complete', failed: 'Failed' };
  const stopLabels: Record<string, string> = ru ? { end_turn: 'Готово', max_tokens: 'Лимит ответа', max_turn_requests: 'Лимит действий', refusal: 'Запрос отклонён', cancelled: 'Остановлен' } : { end_turn: 'Complete', max_tokens: 'Response limit', max_turn_requests: 'Action limit', refusal: 'Request declined', cancelled: 'Cancelled' };
  const ready = session.exitCode === null && (state?.phase === 'idle' || state?.phase === 'done');
  useEffect(() => {
    followOutput.current = true; setUnread(false);
    setTranscript('');
    return attachTerminalOutput(window.canvasTTY.terminal, session.id, text => setTranscript(current => (current + text).slice(-240_000)), reason => setError(String(reason)));
  }, [session.id]);
  useEffect(() => {
    const element = log.current;
    if (element && followOutput.current) element.scrollTop = element.scrollHeight;
    else if (transcript) setUnread(true);
  }, [transcript]);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const send = (): void => { if (!prompt.trim() || !ready || busy) return; void run(async () => { await window.canvasTTY.terminal.agentPrompt(session.id, prompt); setPrompt(''); }); };
  return <section className="terminal-card__surface acp-panel" aria-label={ru ? 'Диалог ACP' : 'ACP conversation'} onKeyDown={event => event.stopPropagation()}>
    <div className="acp-panel__toolbar">
      <span>ACP · {phaseLabels[state?.phase ?? (session.exitCode === null ? 'starting' : 'failed')]}{state?.stopReason ? ` · ${stopLabels[state.stopReason] ?? state.stopReason}` : ''}</span>
      <label>{ru ? 'Модель' : 'Model'}<select aria-label={ru ? 'Модель ACP' : 'ACP model'} value={state?.effectiveModel ?? ''} disabled={!ready || busy || !state?.models.length} onChange={event => void run(() => window.canvasTTY.terminal.acpModel(session.id, event.target.value))}>
        {!state?.effectiveModel && <option value="">{ru ? 'Не подтверждена' : 'Unconfirmed'}</option>}
        {state?.models.map(model => <option value={model.value} key={model.value}>{model.name}</option>)}
      </select></label>
      <button type="button" disabled={busy || state?.phase !== 'running'} onClick={() => void run(() => window.canvasTTY.terminal.cancelTurn(session.id))}>{ru ? 'Остановить' : 'Cancel turn'}</button>
    </div>
    <pre ref={log} className="acp-panel__transcript" tabIndex={0} aria-label={ru ? 'История диалога' : 'Transcript'} onScroll={event => {
      const element = event.currentTarget;
      followOutput.current = element.scrollHeight - element.clientHeight - element.scrollTop < 32;
      if (followOutput.current) setUnread(false);
    }}>{transcript || (ru ? 'Ответ появится здесь.' : 'The response will appear here.')}</pre>
    {unread && <button className="acp-panel__new-output" type="button" onClick={() => { followOutput.current = true; setUnread(false); const element = log.current; if (element) element.scrollTop = element.scrollHeight; }}>{ru ? 'Новые сообщения ↓' : 'New output ↓'}</button>}
    {state?.activity && <div className="acp-panel__activity" role="status">{state.activity}</div>}
    {!!state?.permissions.length && <div className="acp-panel__permissions">{state.permissions.map(permission => <fieldset key={permission.requestId}>
      <legend>{permission.title}</legend><div>{permission.options.map(option => <button key={option.optionId} type="button" disabled={busy} onClick={() => void run(() => window.canvasTTY.terminal.acpPermission(session.id, permission.requestId, option.optionId))}>{option.name}</button>)}</div>
    </fieldset>)}</div>}
    {(error || session.failureDetails) && <div className="acp-panel__error" role="alert">{error ?? session.failureDetails}</div>}
    <form className="acp-panel__prompt" onSubmit={event => { event.preventDefault(); send(); }}>
      <label>{ru ? 'Сообщение' : 'Prompt'}<textarea rows={2} maxLength={65_536} value={prompt} disabled={!ready || busy} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }} /></label>
      <button type="submit" disabled={!ready || busy || !prompt.trim()}>{ru ? 'Отправить' : 'Send'}</button>
    </form>
  </section>;
}
