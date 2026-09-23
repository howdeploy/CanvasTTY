import { useState } from 'react';
import { CANVAS_LAUNCHER_ITEMS, DATA_CLASSES, REASONING_EFFORTS, reasoningEffortsFor, type AppSettings, type AgentProviderId, type ReasoningEffort } from '../../../../shared/contracts';
import { DECISION_CATEGORIES, DEFAULT_DECISION_SETTINGS, MAX_DECISION_ROUTES, routeEconomics, routeTupleKey, validateDecisionSettings, type DecisionRoute, type DecisionRule, type DecisionScore, type DecisionSettings as Configuration } from '../../../../shared/decisions';
import { PROVIDERS } from '../../lib/providers';
import { effortLabel } from '../../lib/effort';

const categoryRu = { general: 'Общая', code: 'Код', review: 'Проверка', research: 'Исследование', writing: 'Текст' };
const SCORES: DecisionScore[] = [1, 2, 3, 4, 5];

export function DecisionSettings({ settings, onPersist }: { settings: AppSettings; onPersist(patch: Partial<AppSettings>): Promise<void> }): React.JSX.Element {
  const ru = settings.locale === 'ru';
  const [draft, setDraft] = useState<Configuration>(() => structuredClone(settings.decisions ?? DEFAULT_DECISION_SETTINGS));
  const [routeId, setRouteId] = useState(''), [ruleId, setRuleId] = useState(''), [key, setKey] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [assembled, setAssembled] = useState<DecisionRoute[] | null>(null);
  const route = draft.routes.find(r => r.id === routeId), rule = draft.rules.find(r => r.id === ruleId);
  const update = (patch: Partial<Configuration>): void => { setDraft({ ...draft, ...patch }); setSaved(false); setError(''); };
  const updateRoute = (patch: Partial<DecisionRoute>): void => update({ routes: draft.routes.map(r => r.id === routeId ? { ...r, ...patch } : r) });
  const updateRule = (patch: Partial<DecisionRule>): void => update({ rules: draft.rules.map(r => r.id === ruleId ? { ...r, ...patch } : r) });
  const act = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('');
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const label = (r: DecisionRoute): string => [
    PROVIDERS[r.provider].label,
    settings.providerAccounts.find(a => a.id === r.accountId)?.label ?? (ru ? 'Текущий вход CLI' : 'Current CLI login'),
    r.hostId === 'local' ? (ru ? 'Этот компьютер' : 'This computer') : settings.remoteHosts.find(h => h.id === r.hostId)?.label ?? r.hostId,
    r.model ?? (ru ? 'Модель по умолчанию' : 'Default model'),
    r.effort ? effortLabel(settings.locale, r.effort).split(' — ')[0]! : (ru ? 'Степень CLI' : 'CLI effort')
  ].join(' · ');
  const economics = (r: DecisionRoute): string => {
    const { cost, quality } = routeEconomics(r);
    return `${ru ? 'цена' : 'cost'} ${cost ?? '?'}/5 · ${ru ? 'качество' : 'quality'} ${quality ?? '?'}/5`;
  };
  const toggleEffort = (effort: ReasoningEffort): void => update({
    autoEfforts: draft.autoEfforts.includes(effort) ? draft.autoEfforts.filter(e => e !== effort) : REASONING_EFFORTS.filter(e => e === effort || draft.autoEfforts.includes(e))
  });
  const materialize = (): void => {
    if (!assembled) return;
    const keys = new Set(draft.routes.map(routeTupleKey));
    const added = assembled.filter(r => !keys.has(routeTupleKey(r))).slice(0, Math.max(0, MAX_DECISION_ROUTES - draft.routes.length));
    update({ routes: [...draft.routes, ...added] });
  };
  const scoreSelect = (field: 'cost' | 'quality', current: DecisionRoute): React.JSX.Element => (
    <select value={current[field] ?? ''} onChange={e => updateRoute({ [field]: e.target.value ? Number(e.target.value) as DecisionScore : undefined })}>
      <option value="">{ru ? 'Авто по степени' : 'Derived from effort'}</option>
      {SCORES.map(score => <option key={score} value={score}>{score}</option>)}
    </select>
  );

  return <section className="decision-settings">
    <p>{ru ? 'Экспериментальный выбор исполнителя. Связки проверяются по правилам доступа, лимитам и классу данных до оценки. Настройка не запускает агентов.' : 'Experimental agent routing. Routes are checked against access rules, limits and data class before evaluation. Configuring does not launch agents.'}</p>
    <fieldset className="execution-fields" disabled={busy}>
      <label className="agent-settings-field"><span>{ru ? 'Режим выбора' : 'Routing mode'}</span>
        <select value={draft.mode} onChange={e => update({ mode: e.target.value as Configuration['mode'] })}>
          <option value="off">{ru ? 'Выключен' : 'Off'}</option>
          <option value="rules">{ru ? 'Локальные правила' : 'Local rules'}</option>
          <option value="jev">{ru ? 'Правила + Jev' : 'Rules + Jev'}</option>
          <option disabled value="laya">Laya · {ru ? 'ещё не подключён' : 'not connected yet'}</option>
        </select>
      </label>
      <p>{ru ? 'Явный запуск выбранного агента работает как прежде.' : 'Explicit agent launches keep their normal behavior.'}</p>

      <h3>{ru ? 'Автосборка связок' : 'Automatic routes'}</h3>
      <label><input type="checkbox" checked={draft.autoRoutes} onChange={e => update({ autoRoutes: e.target.checked })} />{ru ? 'Добавлять все доступные связки автоматически' : 'Add every available route automatically'}</label>
      <p>{ru ? 'Берутся аккаунты (или обычный вход CLI, если аккаунтов нет), компьютеры, где CLI найден, модели из списка аккаунта и выбранные степени рассуждений. Серверы не опрашиваются: используется последняя проверка сервера.' : 'Uses accounts (or the ordinary CLI login when none exist), computers where the CLI was found, account model lists and the selected reasoning efforts. Servers are not probed; the last server check is used.'}</p>
      <div className="decision-effort-group" role="group" aria-label={ru ? 'Степени рассуждений для автосборки' : 'Reasoning efforts to assemble'}>
        {REASONING_EFFORTS.map(effort => <label key={effort}><input type="checkbox" checked={draft.autoEfforts.includes(effort)} onChange={() => toggleEffort(effort)} />{effortLabel(settings.locale, effort)}</label>)}
      </div>
      <p>{ru ? 'Больше рассуждений — обычно точнее на сложных задачах, но дольше и дороже по токенам и лимитам. Степени поддерживают Claude, Codex и Grok; у Cursor степень задаётся моделью (например, «-thinking»).' : 'More reasoning is usually more accurate on hard tasks but slower and more expensive in tokens and limits. Claude, Codex and Grok support effort; Cursor selects it through the model (for example "-thinking").'}</p>
      <div className="agent-settings-actions">
        <button type="button" className="agent-settings-button" onClick={() => void act(async () => setAssembled(await window.canvasTTY.decisions.assemble(draft.autoEfforts)))}>{ru ? 'Показать собранные связки' : 'Preview assembled routes'}</button>
        {assembled && assembled.length > 0 && <button type="button" className="agent-settings-button" disabled={draft.routes.length >= MAX_DECISION_ROUTES} onClick={materialize}>{ru ? 'Добавить в список для правки' : 'Copy into editable routes'}</button>}
      </div>
      {assembled && <div className="decision-editor" role="status">
        {assembled.length === 0 ? <p>{ru ? 'Нет доступных связок: установите CLI или настройте аккаунт.' : 'No available routes: install a CLI or configure an account.'}</p>
          : <ul>{assembled.map(r => <li key={r.id}>{label(r)} · {economics(r)}</li>)}</ul>}
      </div>}

      <h3>{ru ? 'Настроенные связки' : 'Configured routes'}</h3>
      <label className="agent-settings-field"><span>{ru ? 'Редактировать связку' : 'Edit route'}</span>
        <select value={routeId} onChange={e => setRouteId(e.target.value)}>
          <option value="">{ru ? 'Выберите связку' : 'Select route'}</option>
          {draft.routes.map(r => <option key={r.id} value={r.id}>{label(r)}</option>)}
        </select>
      </label>
      <button type="button" className="agent-settings-button" disabled={draft.routes.length >= MAX_DECISION_ROUTES} onClick={() => { const id = `route-${crypto.randomUUID().slice(0, 8)}`; update({ routes: [...draft.routes, { id, provider: 'claude', hostId: 'local', transport: 'pty' }] }); setRouteId(id); }}>{ru ? 'Добавить исполнителя' : 'Add route'}</button>
      {route && <div className="decision-editor">
        <label className="agent-settings-field"><span>{ru ? 'Агент' : 'Agent'}</span>
          <select value={route.provider} onChange={e => updateRoute({ provider: e.target.value as AgentProviderId, accountId: undefined, model: undefined, effort: undefined, hostId: 'local' })}>
            {CANVAS_LAUNCHER_ITEMS.filter(p => p !== 'terminal').map(p => <option key={p} value={p}>{PROVIDERS[p].label}</option>)}
          </select>
        </label>
        <label className="agent-settings-field"><span>{ru ? 'Аккаунт' : 'Account'}</span>
          <select value={route.accountId ?? ''} onChange={e => { const account = settings.providerAccounts.find(a => a.id === e.target.value); updateRoute({ accountId: account?.id, hostId: account?.hostId ?? 'local' }); }}>
            <option value="">{ru ? 'Текущий вход CLI' : 'Current CLI login'}</option>
            {settings.providerAccounts.map(a => <option key={a.id} value={a.id}>{a.label} · {a.provider}</option>)}
          </select>
        </label>
        <label className="agent-settings-field"><span>{ru ? 'Устройство' : 'Computer'}</span>
          <select disabled={!!route.accountId} value={route.hostId} onChange={e => updateRoute({ hostId: e.target.value })}>
            <option value="local">{ru ? 'Этот компьютер' : 'This computer'}</option>
            {settings.remoteHosts.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}
          </select>
        </label>
        <label className="agent-settings-field"><span>{ru ? 'Модель, если требуется' : 'Model, if required'}</span><input value={route.model ?? ''} maxLength={100} onChange={e => updateRoute({ model: e.target.value || undefined })} /></label>
        <label className="agent-settings-field"><span>{ru ? 'Способ запуска' : 'Transport'}</span>
          <select value={route.transport} onChange={e => updateRoute({ transport: e.target.value as 'pty' | 'acp', ...(e.target.value === 'acp' ? { effort: undefined } : {}) })}>
            <option value="pty">PTY</option><option value="acp">ACP</option>
          </select>
        </label>
        {reasoningEffortsFor(route.provider).length > 0 && route.transport === 'pty' && <label className="agent-settings-field"><span>{ru ? 'Степень рассуждений' : 'Reasoning effort'}</span>
          <select value={route.effort ?? ''} onChange={e => updateRoute({ effort: (e.target.value || undefined) as ReasoningEffort | undefined })}>
            <option value="">{ru ? 'По умолчанию CLI' : 'CLI default'}</option>
            {reasoningEffortsFor(route.provider).map(effort => <option key={effort} value={effort}>{effortLabel(settings.locale, effort)}</option>)}
          </select>
        </label>}
        <label className="agent-settings-field"><span>{ru ? 'Относительная цена (1 — дешевле)' : 'Relative cost (1 = cheapest)'}</span>{scoreSelect('cost', route)}</label>
        <label className="agent-settings-field"><span>{ru ? 'Ожидаемое качество (5 — лучше)' : 'Expected quality (5 = best)'}</span>{scoreSelect('quality', route)}</label>
        <p>{ru ? 'Цена и качество — ваши оценки этой связки. Без них они выводятся из степени рассуждений. Аккаунт остаётся на своём устройстве; установленный CLI не подтверждает доступность модели у провайдера.' : 'Cost and quality are your estimates for this tuple; without them they are derived from reasoning effort. An account stays on its bound computer; an installed CLI does not prove model availability.'}</p>
        <button type="button" className="agent-settings-button" onClick={() => { update({ routes: draft.routes.filter(r => r.id !== routeId), rules: draft.rules.map(r => ({ ...r, prefer: r.prefer.filter(id => id !== routeId) })).filter(r => r.prefer.length) }); setRouteId(''); }}>{ru ? 'Удалить связку' : 'Remove route'}</button>
      </div>}

      <h3>{ru ? 'Правила по порядку' : 'Rules in order'}</h3>
      <p>{ru ? 'Первое совпадение выбирает исполнителя из настроенных связок. Без совпадения выбор делает сложность задачи: простая — дешевле, сложная — сильнее, обычная — средняя степень. Jev может оценить оставшийся выбор.' : 'The first match picks a configured route. Otherwise task difficulty decides: simple prefers cheaper, hard prefers stronger, normal prefers medium effort. Jev may evaluate the remaining choice.'}</p>
      <label className="agent-settings-field"><span>{ru ? 'Редактировать правило' : 'Edit rule'}</span>
        <select value={ruleId} onChange={e => setRuleId(e.target.value)}>
          <option value="">{ru ? 'Выберите правило' : 'Select rule'}</option>
          {draft.rules.map((r, i) => <option key={r.id} value={r.id}>{i + 1} · {r.taskContains || r.pathPattern || (r.category ? ru ? categoryRu[r.category] : r.category : ru ? 'Все задачи' : 'All tasks')}</option>)}
        </select>
      </label>
      <button type="button" className="agent-settings-button" disabled={!draft.routes.length || draft.rules.length >= 32} onClick={() => { const id = `rule-${crypto.randomUUID().slice(0, 8)}`; update({ rules: [...draft.rules, { id, prefer: [draft.routes[0]!.id] }] }); setRuleId(id); }}>{ru ? 'Добавить правило' : 'Add rule'}</button>
      {rule && <div className="decision-editor">
        <label className="agent-settings-field"><span>{ru ? 'Тип задачи' : 'Task category'}</span>
          <select value={rule.category ?? ''} onChange={e => updateRule({ category: e.target.value as DecisionRule['category'] || undefined })}>
            <option value="">{ru ? 'Любой' : 'Any'}</option>
            {DECISION_CATEGORIES.map(c => <option key={c} value={c}>{ru ? categoryRu[c] : c}</option>)}
          </select>
        </label>
        <label className="agent-settings-field"><span>{ru ? 'Задача содержит' : 'Task contains'}</span><input value={rule.taskContains ?? ''} maxLength={200} onChange={e => updateRule({ taskContains: e.target.value || undefined })} /></label>
        <label className="agent-settings-field"><span>{ru ? 'Шаблон папки · * или **' : 'Folder pattern · * or **'}</span><input value={rule.pathPattern ?? ''} maxLength={200} placeholder="**/src" onChange={e => updateRule({ pathPattern: e.target.value || undefined })} /></label>
        <label className="agent-settings-field"><span>{ru ? 'Максимальный класс задачи' : 'Maximum task class'}</span>
          <select value={rule.maxDataClass ?? ''} onChange={e => updateRule({ maxDataClass: e.target.value as DecisionRule['maxDataClass'] || undefined })}>
            <option value="">{ru ? 'Любой разрешённый' : 'Any permitted'}</option>
            {DATA_CLASSES.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="agent-settings-field"><span>{ru ? 'Предпочитаемый исполнитель' : 'Preferred route'}</span>
          <select value={rule.prefer[0] ?? ''} onChange={e => updateRule({ prefer: [e.target.value] })}>
            {draft.routes.map(r => <option key={r.id} value={r.id}>{label(r)}</option>)}
          </select>
        </label>
        <div className="agent-settings-actions">
          <button className="agent-settings-button" type="button" disabled={draft.rules[0]?.id === ruleId} onClick={() => { const rules = [...draft.rules], i = rules.findIndex(r => r.id === ruleId); [rules[i - 1], rules[i]] = [rules[i]!, rules[i - 1]!]; update({ rules }); }}>{ru ? 'Выше' : 'Move up'}</button>
          <button className="agent-settings-button" type="button" onClick={() => { update({ rules: draft.rules.filter(r => r.id !== ruleId) }); setRuleId(''); }}>{ru ? 'Удалить правило' : 'Remove rule'}</button>
        </div>
      </div>}

      {draft.mode === 'jev' && <div className="decision-editor">
        <h3>Jev</h3>
        <label><input type="checkbox" checked={draft.cloudMetadata} onChange={e => update({ cloudMetadata: e.target.checked })} />{ru ? 'Разрешить отправку признаков выбора в TypeSafe' : 'Allow sending routing traits to TypeSafe'}</label>
        <p>{ru ? 'Отправляются: тип и сложность задачи, класс данных, для каждой связки — агент, модель, степень рассуждений, оценки цены и качества, запас лимита подписки, локально или на сервере. Пути, имена аккаунтов, исходники и контекст не отправляются. Возможна оплата API.' : 'Sent: task category and difficulty, data class, and per route the agent, model, reasoning effort, cost and quality estimates, subscription limit headroom and local/remote. Paths, account names, sources and context are not sent. API charges may apply.'}</p>
        <label className="agent-settings-field"><span>{ru ? 'Текст задачи для Jev' : 'Task text for Jev'}</span>
          <select value={draft.taskText} onChange={e => update({ taskText: e.target.value as Configuration['taskText'] })}>
            <option value="off">{ru ? 'Не отправлять' : 'Never send'}</option>
            <option value="D1">{ru ? 'Только для задач D0–D1' : 'Only D0-D1 tasks'}</option>
            <option value="D2">{ru ? 'Для задач до D2 (конфиденциальные)' : 'Tasks up to D2 (confidential)'}</option>
          </select>
        </label>
        <p>{ru ? 'Текст задачи помогает Jev понять её сложность, но уходит в облако TypeSafe (до 2000 символов). Задачи D3 не отправляются никогда. Свободный текст задачи CanvasTTY считает не ниже D2.' : 'Task text helps Jev judge difficulty but is sent to the TypeSafe cloud (up to 2,000 characters). D3 tasks are never sent. CanvasTTY treats free task text as at least D2.'}</p>
        <label className="agent-settings-field"><span>{ru ? 'Модель Jev' : 'Jev model'}</span><input value={draft.jevModel} maxLength={100} onChange={e => update({ jevModel: e.target.value })} /></label>
        <label className="agent-settings-field"><span>{ru ? 'Порог уверенности · 0–1' : 'Confidence threshold · 0–1'}</span><input type="number" min={0} max={1} step={0.05} value={draft.minConfidence} onChange={e => update({ minConfidence: Number(e.target.value) })} /></label>
        <label className="agent-settings-field"><span>{ru ? 'Не более оценок в минуту' : 'Maximum evaluations per minute'}</span><input type="number" min={1} max={60} value={draft.maxCallsPerMinute} onChange={e => update({ maxCallsPerMinute: Number(e.target.value) })} /></label>
        <p role="status">{configured === null ? (ru ? 'Статус отдельного ключа не проверялся.' : 'Separate key status has not been checked.') : configured ? (ru ? 'Отдельный ключ сохранён.' : 'Separate key saved.') : (ru ? 'Отдельного ключа нет.' : 'No separate key saved.')}</p>
        <label className="agent-settings-field"><span>{ru ? 'Новый отдельный ключ Jev' : 'New separate Jev key'}</span><input type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} /></label>
        <div className="agent-settings-actions">
          <button type="button" className="agent-settings-button" onClick={() => void act(async () => setConfigured((await window.canvasTTY.decisions.secretStatus()).configured))}>{ru ? 'Проверить наличие ключа' : 'Check key status'}</button>
          <button type="button" className="agent-settings-button" disabled={!key.trim()} onClick={() => void act(async () => { await window.canvasTTY.decisions.setSecret(key); setKey(''); setConfigured(true); })}>{ru ? 'Сохранить ключ' : 'Save key'}</button>
          <button type="button" className="agent-settings-button" onClick={() => void act(async () => { await window.canvasTTY.decisions.removeSecret(); setKey(''); setConfigured(false); })}>{ru ? 'Удалить ключ' : 'Remove key'}</button>
        </div>
      </div>}

      <button type="button" className="agent-settings-button" onClick={() => void act(async () => { const config = validateDecisionSettings(draft); await onPersist({ decisions: config }); setSaved(true); })}>{ru ? 'Сохранить маршрутизацию' : 'Save routing'}</button>
      {saved && <p role="status">{ru ? 'Настройки сохранены.' : 'Settings saved.'}</p>}
    </fieldset>
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
  </section>;
}
