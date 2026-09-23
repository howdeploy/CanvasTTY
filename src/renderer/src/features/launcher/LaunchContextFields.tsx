import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentLaunchOptions, AppSettings } from '../../../../shared/contracts';
import { CONTEXT_CATEGORIES, type ContextCategory } from '../../../../shared/contextProfiles';
import type { CurrentContextInput, ContextSourceSelection, LaunchContextPreview } from '../../../../shared/contextRuntime';
import type { LaunchDraft } from './launchDraft';

const labels: Record<ContextCategory, string> = { design: 'Дизайн', architecture: 'Архитектура', 'code-style': 'Стиль кода', security: 'Безопасность', testing: 'Тестирование', deployment: 'Развёртывание', documentation: 'Документация', 'business-rules': 'Бизнес-правила', naming: 'Именование', dependencies: 'Зависимости', communication: 'Общение' };

/** Drafts stay in the launcher; source identities and the actual projection come from main. */
export function LaunchContextFields({ draft, settings, request, active, busy, update, openSettings }: {
  draft: LaunchDraft; settings: AppSettings; request: AgentLaunchOptions | null; active: boolean; busy: boolean;
  update(patch: Partial<LaunchDraft>): void; openSettings(): void;
}): React.JSX.Element {
  const ru = settings.locale === 'ru';
  const [expanded, setExpanded] = useState(false), [reload, setReload] = useState(0);
  const enabled = settings.contextProfilesEnabled && (draft.contextEnabled ?? true);
  const sourceIdentity = useMemo(() => ({ cwd: draft.cwd, active: active && expanded && enabled }), [draft.cwd, active, expanded, enabled, settings, reload]);
  const sourceCurrent = useRef<typeof sourceIdentity | null>(sourceIdentity); sourceCurrent.current = sourceIdentity;
  const [sourceAnswer, setSourceAnswer] = useState<{ identity: typeof sourceIdentity; value?: ContextSourceSelection; error?: string } | null>(null);
  useEffect(() => {
    if (sourceIdentity.active) void window.canvasTTY.context.source(sourceIdentity.cwd).then(value => {
      if (sourceCurrent.current === sourceIdentity) setSourceAnswer({ identity: sourceIdentity, value });
    }, error => { if (sourceCurrent.current === sourceIdentity) setSourceAnswer({ identity: sourceIdentity, error: String(error) }); });
    return () => { if (sourceCurrent.current === sourceIdentity) sourceCurrent.current = null; };
  }, [sourceIdentity]);
  const source = sourceAnswer?.identity === sourceIdentity ? sourceAnswer : null;
  const requestKey = JSON.stringify(request);
  const previewIdentity = useMemo(() => ({ request, active: active && expanded && enabled }), [requestKey, settings, active, expanded, enabled]);
  const previewCurrent = useRef<typeof previewIdentity | null>(previewIdentity); previewCurrent.current = previewIdentity;
  const [answer, setAnswer] = useState<{ identity: typeof previewIdentity; busy?: boolean; value?: LaunchContextPreview; error?: string } | null>(null);
  useEffect(() => () => { if (previewCurrent.current === previewIdentity) previewCurrent.current = null; }, [previewIdentity]);
  const shown = answer?.identity === previewIdentity ? answer : null;
  const preview = async (): Promise<void> => {
    if (!previewIdentity.request || !previewIdentity.active || busy || shown?.busy) return;
    setAnswer({ identity: previewIdentity, busy: true });
    try {
      const value = await window.canvasTTY.context.previewLaunch({ ...previewIdentity.request, position: { x: 0, y: 0 } });
      if (previewCurrent.current === previewIdentity) setAnswer({ identity: previewIdentity, value });
    } catch (error) { if (previewCurrent.current === previewIdentity) setAnswer({ identity: previewIdentity, error: String(error) }); }
  };
  const current = draft.currentContext ?? [];
  const changeRule = (index: number, patch: Partial<CurrentContextInput>): void => update({ currentContext: current.map((rule, i) => i === index ? { ...rule, ...patch } : rule) });
  const result = shown?.value;
  return <details className="launch-context" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{ru ? 'Контекст и правила' : 'Context and rules'} · {enabled ? (ru ? 'Включены' : 'Enabled') : (ru ? 'Выключены' : 'Disabled')}</summary>
    <div className="launch-context__body">
      <label className="launch-context__switch"><input type="checkbox" checked={enabled} disabled={busy || !settings.contextProfilesEnabled} onChange={event => update({ contextEnabled: event.target.checked })} /><span>{ru ? 'Добавить правила к этому запуску' : 'Include rules in this launch'}</span></label>
      {!settings.contextProfilesEnabled && <p>{ru ? 'Передача контекста выключена в настройках.' : 'Context delivery is disabled in settings.'}</p>}
      <button type="button" className="agent-settings-button" disabled={busy} onClick={openSettings}>{ru ? 'Настройки контекста' : 'Context settings'}</button>
      {enabled && <>
        <p role="status">{source?.value ? source.value.project?.label ?? (ru ? 'Общие правила: папка не зарегистрирована как проект.' : 'Global rules: this directory is not a registered project.') : source?.error ? '' : (ru ? 'Определяем проект…' : 'Resolving project…')}</p>
        {source?.error && <p className="agent-settings-error" role="alert">{source.error}</p>}
        <button type="button" className="agent-settings-button" disabled={busy || !source} onClick={() => setReload(value => value + 1)}>{ru ? 'Обновить список задач' : 'Refresh task list'}</button>
        <label>{ru ? 'Правила задачи' : 'Task rules'}<select value={draft.contextTaskId ?? ''} disabled={busy || !source?.value} onChange={event => update({ contextTaskId: event.target.value || undefined })}>
          <option value="">{ru ? 'Без отдельной задачи' : 'No specific task'}</option>
          {source?.value?.tasks.map(task => <option key={task.id} value={task.id}>{task.label}</option>)}
          {draft.contextTaskId && !source?.value?.tasks.some(task => task.id === draft.contextTaskId) && <option value={draft.contextTaskId}>{ru ? 'Задача недоступна для этой папки — выберите другую' : 'Task unavailable for this directory — choose another'}</option>}
        </select></label>
        <label>{ru ? 'Категории правил' : 'Rule categories'}<select value={draft.contextCategories?.[0] ?? ''} disabled={busy} onChange={event => update({ contextCategories: event.target.value ? [event.target.value as ContextCategory] : undefined })}><option value="">{ru ? 'Все категории' : 'All categories'}</option>{CONTEXT_CATEGORIES.map(category => <option key={category} value={category}>{ru ? labels[category] : category}</option>)}</select></label>
        <p>{ru ? 'Правила безопасности и зависимостей включаются при любом выборе категории. Доступ определяется аккаунтом, моделью и компьютером.' : 'Security and dependency rules are included for every category. Access depends on the account, model and computer.'}</p>
        <details><summary>{ru ? 'Текущие инструкции' : 'Current instructions'} · {current.length}</summary><div className="launch-context__rules">
          {current.map((rule, index) => <fieldset key={index} disabled={busy}><legend>{ru ? 'Инструкция' : 'Instruction'} {index + 1}</legend>
            <label>{ru ? 'Категория' : 'Category'}<select value={rule.category} onChange={event => changeRule(index, { category: event.target.value as ContextCategory })}>{CONTEXT_CATEGORIES.map(category => <option key={category} value={category}>{ru ? labels[category] : category}</option>)}</select></label>
            <label>{ru ? 'Ключ правила' : 'Rule key'}<input value={rule.key} maxLength={160} onChange={event => changeRule(index, { key: event.target.value })} /></label>
            <label>{ru ? 'Значение' : 'Value'}<textarea rows={3} value={typeof rule.value === 'string' ? rule.value : JSON.stringify(rule.value)} maxLength={4096} onChange={event => changeRule(index, { value: event.target.value })} /></label>
            <label>{ru ? 'Класс данных' : 'Data class'}<select value={rule.dataClass ?? 'D2'} onChange={event => changeRule(index, { dataClass: event.target.value as CurrentContextInput['dataClass'] })}>{['D0', 'D1', 'D2', 'D3'].map(value => <option key={value}>{value}</option>)}</select></label>
            <button type="button" className="agent-settings-button" onClick={() => update({ currentContext: current.filter((_, i) => i !== index) })}>{ru ? 'Удалить инструкцию' : 'Remove instruction'}</button>
          </fieldset>)}
          <button type="button" className="agent-settings-button" disabled={busy || current.length >= 48} onClick={() => update({ currentContext: [...current, { category: 'communication', key: '', value: '', dataClass: 'D2' }] })}>{ru ? 'Добавить текущую инструкцию' : 'Add current instruction'}</button>
          <p>{ru ? 'Текущая инструкция заменяет правило с тем же ключом только для этого запуска. Черновик не сохраняется в общих настройках.' : 'A current instruction overrides the same key for this launch. The draft is not saved in general settings.'}</p>
        </div></details>
        <button type="button" className="agent-settings-button" disabled={busy || !request || shown?.busy || !active} onClick={() => void preview()}>{shown?.busy ? (ru ? 'Собираем…' : 'Building…') : (ru ? 'Показать передаваемый контекст' : 'Show context to be sent')}</button>
        {shown?.error && <p className="agent-settings-error" role="alert">{shown.error}</p>}
        {result && <div className="launch-context__preview" role="status">{result.route && <p>{settings.providerAccounts.find(account => account.id === result.route?.accountId)?.label ?? result.route.accountId ?? (ru ? 'Аккаунт CLI' : 'CLI account')} · {result.route.hostId ? settings.remoteHosts.find(host => host.id === result.route?.hostId)?.label ?? result.route.hostId : (ru ? 'Этот компьютер' : 'This computer')}{result.route.model ? ` · ${result.route.model}` : ''}</p>}<p>{result.enabled ? `${result.dataClass} · ${result.bytes} ${ru ? 'байт UTF-8' : 'UTF-8 bytes'}` : (ru ? 'Передача контекста выключена.' : 'Context delivery is disabled.')}</p><pre>{result.text || (ru ? 'Нет подходящих правил.' : 'No applicable rules.')}</pre><p>{ru ? 'Перед запуском выбор проверяется заново; предпросмотр не резервирует ресурсы.' : 'Selection is checked again at launch; preview does not reserve resources.'}</p>{draft.transport === 'acp' && <p>{ru ? 'ACP обновляет правила перед каждой задачей и проверяет подтверждённую модель.' : 'ACP refreshes rules before each task and checks the confirmed model.'}</p>}</div>}
      </>}
    </div>
  </details>;
}
