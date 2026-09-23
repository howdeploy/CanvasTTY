import { useState } from 'react';
import type { DataClass } from '../../../../shared/contracts';
import { CONTEXT_CATEGORIES, type ContextCategory, type ContextProject, type ContextState } from '../../../../shared/contextProfiles';
import { contextCandidateState, DEFAULT_CONTEXT_LEARNING, type ContextFeedbackSession, type ContextFeedbackAction, type ContextLearning, type FeedbackKind } from '../../../../shared/contextFeedback';

const stateLabels: Record<string, string> = { 'learning-off': 'Обучение выключено', pending: 'Ожидает', advisory: 'Рекомендация', applied: 'Допущено в контекст', rejected: 'Отклонено', disabled: 'Отключено', superseded: 'Есть принятое значение' };
const kindLabels = { correction: 'Исправление пользователя', 'accepted-change': 'Принятое изменение', suggestion: 'Предложение агента без подтверждения' };
export function ContextFeedbackSettings({ state, project, ru, busy, editorActive, activate, close, perform, replace }: {
  state: ContextState; project: ContextProject; ru: boolean; busy: boolean; editorActive: boolean;
  activate(): void; close(): void; perform(operation: () => Promise<void>): Promise<void>; replace(next: ContextState): void;
}): React.JSX.Element {
  const api = window.canvasTTY.context;
  const [sessions, setSessions] = useState<ContextFeedbackSession[]>([]);
  const [mode, setMode] = useState<'capture' | 'settings' | 'candidate'>('capture'), [candidateId, setCandidateId] = useState('');
  const [learning, setLearning] = useState<ContextLearning>({ ...DEFAULT_CONTEXT_LEARNING, ...project.learning });
  const [eventId, setEventId] = useState(''), [kind, setKind] = useState<FeedbackKind>('correction'), [category, setCategory] = useState<ContextCategory>('design');
  const [key, setKey] = useState(''), [before, setBefore] = useState(''), [value, setValue] = useState(''), [note, setNote] = useState(''), [sessionId, setSessionId] = useState(''), [dataClass, setDataClass] = useState<DataClass>('D2'), [json, setJson] = useState(false);
  const candidates = state.feedback?.candidates.filter(c => c.projectId === project.id) ?? [];
  const candidate = candidates.find(c => c.id === candidateId), evidence = state.feedback?.evidence.filter(e => e.candidateId === candidateId) ?? [];
  const show = (next: typeof mode): void => { setMode(next); activate(); };
  const action = (kind: ContextFeedbackAction['kind'], id: string): void => { void perform(async () => replace(await api.feedbackAction({ kind, id }, state.revision))); };
  return <details className="context-feedback"><summary>{ru ? 'Исправления и обучение проекта' : 'Project corrections and learning'}</summary>
    <p className="agent-settings-hint">{ru ? 'Здесь сохраняются только явно отмеченные исправления и принятые изменения. Вывод терминала не анализируется. Обучение и автоприменение по умолчанию выключены.' : 'Only explicitly marked corrections and accepted changes are recorded. Terminal output is not analyzed. Learning and automatic application are off by default.'}</p>
    <p className="agent-settings-hint">{ru ? 'Оценка — эвристика: 1 / 2 / 3 независимых подтверждения дают 0,45 / 0,71 / 0,90. Каждое противоречащее подтверждение вычитает 0,30. Повтор события и предложение агента оценку не повышают. Это не вероятность.' : 'Heuristic score: 1 / 2 / 3 independent confirmations yield 0.45 / 0.71 / 0.90. Each conflicting confirmation subtracts 0.30. Replays and agent suggestions add no score. This is not a probability.'}</p>
    <div className="context-settings__actions">
      <button className="agent-settings-button" type="button" disabled={busy} onClick={() => { setLearning({ ...DEFAULT_CONTEXT_LEARNING, ...project.learning }); show('settings'); }}>{ru ? 'Настроить обучение' : 'Configure learning'}</button>
      <button className="agent-settings-button" type="button" disabled={busy || !project.learning?.enabled} onClick={() => void perform(async () => { setSessions([]); const choices = await api.feedbackSessions(project.id); setSessions(choices); if (!choices.some(s => s.id === sessionId)) setSessionId(''); if (!eventId) setEventId(crypto.randomUUID()); show('capture'); })}>{ru ? 'Записать исправление' : 'Capture correction'}</button>
    </div>
    <div className="context-settings__rules" aria-label={ru ? 'Предложения проекта' : 'Project suggestions'}>{candidates.map(c => <button className="context-settings__rule" type="button" key={c.id} disabled={busy} onClick={() => { setCandidateId(c.id); show('candidate'); }}>
      <strong>{c.key}</strong><span>{ru ? stateLabels[contextCandidateState(c, project, candidates)] : contextCandidateState(c, project, candidates)} · {c.score.toFixed(2)} · {c.dataClass} · inferred</span><span>{typeof c.value === 'string' ? c.value : JSON.stringify(c.value)}</span>
    </button>)}</div>
    {!candidates.length && <p className="agent-settings-hint">{ru ? 'В этом проекте пока нет предложений.' : 'No suggestions in this project yet.'}</p>}
    {editorActive && mode === 'settings' && <fieldset className="container-profiles__editor agent-settings-grid" disabled={busy}><legend>{ru ? 'Обучение этого проекта' : 'Learning for this project'}</legend>
      <label className="context-settings__switch agent-settings-field--wide"><input type="checkbox" checked={learning.enabled} onChange={e => setLearning({ ...learning, enabled: e.target.checked })} /><span>{ru ? 'Собирать исправления и использовать принятые предложения' : 'Record corrections and use accepted suggestions'}</span></label>
      <label className="context-settings__switch agent-settings-field--wide"><input type="checkbox" checked={learning.autoApply} onChange={e => setLearning({ ...learning, autoApply: e.target.checked })} /><span>{ru ? 'Автоматически применять при достижении порога' : 'Apply automatically at the threshold'}</span></label>
      <label className="agent-settings-field"><span>{ru ? 'Порог автоприменения (0,50–1)' : 'Automatic threshold (0.50–1)'}</span><input type="number" min="0.5" max="1" step="0.01" value={learning.threshold} onChange={e => setLearning({ ...learning, threshold: Number(e.target.value) })} /></label>
      <label className="agent-settings-field"><span>{ru ? 'Порог рекомендации' : 'Advisory threshold'}</span><input type="number" min="0" max={learning.threshold} step="0.01" value={learning.advisoryThreshold} onChange={e => setLearning({ ...learning, advisoryThreshold: Number(e.target.value) })} /></label>
      <p className="agent-settings-hint agent-settings-field--wide">{ru ? 'Принятое вручную предложение допускается независимо от оценки. Правила из файлов и явные правила сильнее. Выключение обучения убирает все изученные правила из следующих запусков и новых задач ACP. Уже переданный текст остаётся в истории провайдера.' : 'Manually accepted suggestions are eligible regardless of score. Imported and explicit rules take precedence. Disabling learning removes learned rules from future launches and new ACP tasks. Previously disclosed text remains in provider history.'}</p>
      <button type="button" className="agent-settings-button agent-settings-button--primary" onClick={() => void perform(async () => { replace(await api.saveLearning(project.id, learning, state.revision)); close(); })}>{ru ? 'Сохранить обучение' : 'Save learning'}</button>
      <button type="button" className="agent-settings-button" onClick={close}>{ru ? 'Отмена' : 'Cancel'}</button>
    </fieldset>}
    {editorActive && mode === 'capture' && <fieldset className="container-profiles__editor agent-settings-grid" disabled={busy}><legend>{ru ? 'Явное исправление' : 'Explicit correction'}</legend>
      <label className="agent-settings-field agent-settings-field--wide"><span>{ru ? 'Тип свидетельства' : 'Evidence kind'}</span><select value={kind} onChange={e => setKind(e.target.value as FeedbackKind)}>{Object.entries(kindLabels).map(([k, label]) => <option key={k} value={k}>{ru ? label : k}</option>)}</select></label>
      <label className="agent-settings-field"><span>{ru ? 'Категория исправления' : 'Correction category'}</span><select value={category} onChange={e => setCategory(e.target.value as ContextCategory)}>{CONTEXT_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></label>
      <label className="agent-settings-field"><span>{ru ? 'Минимальный класс свидетельства' : 'Minimum evidence class'}</span><select value={dataClass} onChange={e => setDataClass(e.target.value as DataClass)}>{['D0', 'D1', 'D2', 'D3'].map(c => <option key={c}>{c}</option>)}</select></label>
      <label className="agent-settings-field agent-settings-field--wide"><span>{ru ? 'Ключ исправления' : 'Correction key'}</span><input maxLength={160} value={key} onChange={e => setKey(e.target.value)} /></label>
      <label className="agent-settings-field agent-settings-field--wide"><span>{ru ? 'Было, необязательно' : 'Before, optional'}</span><textarea rows={2} maxLength={4096} value={before} onChange={e => setBefore(e.target.value)} /></label>
      <label className="agent-settings-field agent-settings-field--wide"><span>{ru ? 'Предлагаемое значение' : 'Proposed value'}</span><textarea rows={3} maxLength={4096} value={value} onChange={e => setValue(e.target.value)} /></label>
      <label className="agent-settings-field"><span>{ru ? 'Формат исправления' : 'Correction format'}</span><select value={json ? 'json' : 'text'} onChange={e => setJson(e.target.value === 'json')}><option value="text">{ru ? 'Текст' : 'Text'}</option><option value="json">JSON</option></select></label>
      <label className="agent-settings-field"><span>{ru ? 'Текущая сессия проекта, необязательно' : 'Current project session, optional'}</span><select value={sessionId} onChange={e => setSessionId(e.target.value)}><option value="">{ru ? 'Без сессии' : 'No session'}</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title} · {session.provider}</option>)}</select></label>
      <label className="agent-settings-field agent-settings-field--wide"><span>{ru ? 'Основание, необязательно' : 'Evidence note, optional'}</span><textarea rows={2} maxLength={1024} value={note} onChange={e => setNote(e.target.value)} /></label>
      <p className="agent-settings-hint agent-settings-field--wide">{ru ? 'Сохранение подтверждает выбранный тип события. Можно выбрать работающую сессию этого проекта. Класс учитывает источник и историю сессии; неизвестный источник — D2.' : 'Saving attests to the selected event kind. You can select a running session from this project. Classification includes source and session history; unknown sources are D2.'}</p>
      <button type="button" className="agent-settings-button agent-settings-button--primary" disabled={!project.learning?.enabled || !key.trim() || !value.trim()} onClick={() => void perform(async () => {
        replace(await api.captureFeedback({ eventId, projectId: project.id, kind, category, key, value: json ? JSON.parse(value) : value, ...(before ? { before: json ? JSON.parse(before) : before } : {}), ...(note ? { note } : {}), ...(sessionId ? { sessionId } : {}), dataClass }, state.revision));
        setEventId(''); setBefore(''); setValue(''); setNote(''); close();
      })}>{ru ? 'Сохранить свидетельство' : 'Save evidence'}</button>
      <button type="button" className="agent-settings-button" onClick={close}>{ru ? 'Отмена' : 'Cancel'}</button>
    </fieldset>}
    {editorActive && mode === 'candidate' && candidate && <fieldset className="container-profiles__editor agent-settings-grid" disabled={busy}><legend>{ru ? 'Предложение и свидетельства' : 'Suggestion and evidence'}</legend>
      <p className="agent-settings-hint agent-settings-field--wide context-settings__path">{candidate.key} · {candidate.dataClass} · {candidate.score.toFixed(2)} · {ru ? stateLabels[contextCandidateState(candidate, project, candidates)] : contextCandidateState(candidate, project, candidates)}</p>
      <pre className="context-settings__text agent-settings-field--wide">{JSON.stringify(candidate.value, null, 2)}</pre>
      <div className="context-settings__actions agent-settings-field--wide">
        <button className="agent-settings-button" type="button" onClick={() => action('accept', candidate.id)}>{ru ? 'Принять для проекта' : 'Accept for project'}</button>
        <button className="agent-settings-button" type="button" onClick={() => action('reject', candidate.id)}>{ru ? 'Отклонить' : 'Reject'}</button>
        <button className="agent-settings-button" type="button" onClick={() => action('disable', candidate.id)}>{ru ? 'Отключить предложение' : 'Disable suggestion'}</button>
        <button className="agent-settings-button" type="button" onClick={() => action('undo-accept', candidate.id)}>{ru ? 'Отменить применение' : 'Undo application'}</button>
      </div>
      <p className="agent-settings-hint agent-settings-field--wide">{ru ? 'Действия сохраняют происхождение и действуют только в этом проекте. Ручное принятие не повышает эвристическую оценку. Отклонение и отмена блокируют автоприменение до нового ручного принятия. Глобальное правило можно создать отдельно явным редактированием.' : 'Actions preserve provenance and affect only this project. Manual acceptance does not raise the heuristic score. Rejection and undo block automatic application until manual acceptance. A global rule requires separate explicit editing.'}</p>
      <div className="agent-settings-field--wide context-feedback__evidence">{evidence.map(e => <details key={e.id}><summary>{ru ? kindLabels[e.kind] : e.kind} · {e.dataClass} · {new Date(e.recordedAt).toLocaleString()} {e.undone ? (ru ? '· Отменено' : '· Undone') : ''}</summary>
        <p className="agent-settings-hint context-settings__path">{e.provenance.origin} · {e.eventId}<br />{e.provenance.sessionId && `${e.provenance.sessionId} · ${e.provenance.sessionGeneration}`}</p>
        <pre className="context-settings__text">{e.before !== undefined ? `${ru ? 'Было' : 'Before'}: ${JSON.stringify(e.before, null, 2)}\n` : ''}{ru ? 'Стало' : 'After'}: {JSON.stringify(e.value, null, 2)}{e.note ? `\n${e.note}` : ''}</pre>
        <button type="button" className="agent-settings-button" disabled={e.undone} onClick={() => action('undo-evidence', e.id)}>{ru ? 'Отменить свидетельство' : 'Undo evidence'}</button>
      </details>)}</div>
      <button className="agent-settings-button" type="button" onClick={close}>{ru ? 'Закрыть предложение' : 'Close suggestion'}</button>
    </fieldset>}
  </details>;
}
