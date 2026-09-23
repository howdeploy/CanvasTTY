import { CONVENTION_PRESETS } from '../../../../shared/conventions';
import { useEffect, useState } from 'react';
import type { AppSettings, DataClass } from '../../../../shared/contracts';
import { CONTEXT_CATEGORIES, type ContextCategory, type ContextPreview, type ContextProject, type ContextRule, type ContextRuleInput, type ContextScope, type ContextState } from '../../../../shared/contextProfiles';
import { ContextFeedbackSettings } from './ContextFeedbackSettings';
import { ContextImportFields } from './ContextImportFields';

const categoryRu: Record<ContextCategory, string> = { design: 'Дизайн', architecture: 'Архитектура', 'code-style': 'Стиль кода', security: 'Безопасность', testing: 'Тестирование', deployment: 'Развёртывание', documentation: 'Документация', 'business-rules': 'Бизнес-правила', naming: 'Именование', dependencies: 'Зависимости', communication: 'Общение' };
const scopes: ContextScope[] = ['project', 'task', 'organization', 'user', 'defaults'];
const scopeRu: Record<ContextScope, string> = { project: 'Проект', task: 'Задача', organization: 'Организация', user: 'Пользователь', defaults: 'По умолчанию', current: 'Текущая инструкция' };
type ProjectDraft = Omit<ContextProject, 'id'> & { id?: string };
export function ContextSettings({ settings, active, onPersist }: { settings: AppSettings; active: boolean; onPersist(patch: Partial<AppSettings>): Promise<void> }): React.JSX.Element {
  const ru = settings.locale === 'ru', api = window.canvasTTY.context;
  const [state, setState] = useState<ContextState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(''), [taskId, setTaskId] = useState(''), [search, setSearch] = useState('');
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null), [taskLabel, setTaskLabel] = useState('');
  const [draft, setDraft] = useState<ContextRuleInput | null>(null), [valueText, setValueText] = useState(''), [jsonValue, setJsonValue] = useState(false), [tagsText, setTagsText] = useState('');
  const [preview, setPreview] = useState<ContextPreview | null>(null), [ceiling, setCeiling] = useState<DataClass>('D2');
  const [category, setCategory] = useState<ContextCategory | ''>('');
  const [feedbackEditor, setFeedbackEditor] = useState(false);
  const [imported, setImported] = useState<ContextRule | null>(null);
  const project = state?.projects.find(p => p.id === projectId), tasks = state?.tasks.filter(t => t.projectId === projectId) ?? [];
  const act = async (operation: () => Promise<void>): Promise<void> => { setBusy(true); setError(''); try { await operation(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const reload = async (): Promise<void> => { setPreview(null); setImported(null); setState(await api.get()); };
  useEffect(() => { if (active && !state) void act(reload); }, [active]);
  const replace = (next: ContextState): void => { setState(next); setPreview(null); setImported(null); };
  const edit = (rule?: ContextRuleInput): void => {
    setFeedbackEditor(false); setImported(null); setProjectDraft(null);
    const next = rule ? structuredClone(rule) : { scope: project ? 'project' as const : 'user' as const, ...(project ? { ownerId: project.id } : {}), category: 'design' as const, key: '', value: '', tags: [], dataClass: 'D2' as const, enabled: true };
    setDraft(next); setTagsText(next.tags.join(', ')); setJsonValue(typeof next.value !== 'string'); setValueText(typeof next.value === 'string' ? next.value : JSON.stringify(next.value, null, 2)); setError('');
  };
  const set = (patch: Partial<ContextRuleInput>): void => setDraft(d => d && ({ ...d, ...patch }));
  const selectScope = (scope: ContextScope): void => setDraft(d => {
    if (!d) return d;
    const { ownerId: _owner, ...rest } = d;
    return { ...rest, scope, ...(['project', 'organization', 'task'].includes(scope) ? { ownerId: scope === 'project' ? projectId : scope === 'organization' ? project?.organizationId ?? '' : taskId || tasks[0]?.id || '' } : {}) };
  });
  const rules = [...(state?.rules ?? []), ...(preview?.included.filter(r => r.source === 'imported') ?? [])].filter(r => (r.scope === 'project' ? r.ownerId === projectId : r.scope === 'task' ? tasks.some(t => t.id === r.ownerId) : r.scope === 'organization' ? r.ownerId === project?.organizationId : true) && (!category || r.category === category) && `${r.key} ${JSON.stringify(r.value)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const component = draft?.category === 'design' && draft.key.startsWith('design.components.') && jsonValue;
  let componentValues: { foreground?: string; background?: string } = {};
  if (component) { try { const parsed: unknown = JSON.parse(valueText); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) componentValues = parsed; } catch { /* Keep the raw draft available below. */ } }
  const newToken = (family: string): void => { edit(); setDraft({ scope: project ? 'project' : 'user', ...(project ? { ownerId: project.id } : {}), category: 'design', key: `design.${family}.name`, value: '', tags: [], dataClass: 'D2', enabled: true }); if (family === 'components') { setJsonValue(true); setValueText(JSON.stringify({ foreground: '', background: '' }, null, 2)); } };
  return <div className="settings-section context-settings">
    <h3>{ru ? 'Контекст и предпочтения' : 'Context and preferences'}</h3>
    <label className="context-settings__switch"><input type="checkbox" checked={!!settings.contextProfilesEnabled} disabled={busy} onChange={event => { const enabled = event.target.checked; void act(() => onPersist({ contextProfilesEnabled: enabled })); }} /><span>{ru ? 'Передавать правила агентам' : 'Send rules to agents'}</span></label>
    <p className="agent-settings-hint">{ru ? 'По умолчанию выключено. Правила можно отключить для отдельного запуска. Нативный CLI получает их при запуске, ACP — перед каждой новой задачей.' : 'Off by default. You can disable rules for an individual launch. Native CLIs receive them at startup; ACP refreshes them before each new task.'}</p>
    <p className="agent-settings-hint">{ru ? 'Правила хранятся отдельно от общих настроек. Приоритет: текущая инструкция → задача → проект → организация → пользователь → значения по умолчанию. Неизвестный класс данных — D2.' : 'Rules are stored separately from general settings. Priority: current instruction → task → project → organization → user → defaults. Unclassified content defaults to D2.'}</p>
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
    <div className="agent-settings-grid">
      <label className="agent-settings-field"><span>{ru ? 'Проект' : 'Project'}</span><select value={projectId} disabled={busy} onChange={e => { setFeedbackEditor(false); setDraft(null); setProjectDraft(null); setProjectId(e.target.value); setTaskId(''); setPreview(null); setImported(null); }}><option value="">{ru ? 'Общие правила' : 'Global rules'}</option>{state?.projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <label className="agent-settings-field"><span>{ru ? 'Задача' : 'Task'}</span><select value={taskId} disabled={busy || !project} onChange={e => { setTaskId(e.target.value); setPreview(null); setImported(null); }}><option value="">{ru ? 'Без правил задачи' : 'No task rules'}</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
    </div>
    {project && <p className="agent-settings-hint context-settings__path">{project.root}</p>}
    <div className="context-settings__actions">
      <button type="button" className="agent-settings-button" disabled={busy || !state} onClick={() => { setFeedbackEditor(false); setDraft(null); setImported(null); setProjectDraft({ label: '', root: '' }); }}>{ru ? 'Добавить проект' : 'Add project'}</button>
      {project && <button type="button" className="agent-settings-button" disabled={busy} onClick={() => { setFeedbackEditor(false); setDraft(null); setImported(null); setProjectDraft(structuredClone(project)); }}>{ru ? 'Изменить проект' : 'Edit project'}</button>}
      <button type="button" className="agent-settings-button" disabled={busy} onClick={() => void act(reload)}>{ru ? 'Обновить' : 'Refresh'}</button>
    </div>
    {projectDraft && <fieldset className="container-profiles__editor agent-settings-grid" disabled={busy}>
      <legend>{ru ? 'Проект контекста' : 'Context project'}</legend>
      <label className="agent-settings-field"><span>{ru ? 'Название' : 'Name'}</span><input value={projectDraft.label} maxLength={160} onChange={e => setProjectDraft({ ...projectDraft, label: e.target.value })} /></label>
      <label className="agent-settings-field"><span>{ru ? 'Организация, необязательно' : 'Organization, optional'}</span><input value={projectDraft.organizationId ?? ''} maxLength={64} onChange={e => setProjectDraft({ ...projectDraft, organizationId: e.target.value || undefined })} /></label>
      <label className="agent-settings-field agent-settings-field--wide"><span>{ru ? 'Папка проекта' : 'Project directory'}</span><input value={projectDraft.root} readOnly /></label>
      <button type="button" className="agent-settings-button" onClick={() => void act(async () => { const path = await window.canvasTTY.dialog.pickDirectory(projectDraft.root || undefined); if (path) setProjectDraft({ ...projectDraft, root: path }); })}>{ru ? 'Выбрать папку' : 'Choose directory'}</button>
      <label className="context-settings__switch agent-settings-field--wide"><input type="checkbox" checked={!!projectDraft.validationEnabled} onChange={e => setProjectDraft({ ...projectDraft, validationEnabled: e.target.checked })} /><span>{ru ? 'Разрешить явную проверку соглашений для снимков проекта' : 'Enable explicit convention checks for project snapshots'}</span></label>
      <p className="agent-settings-hint agent-settings-field--wide">{ru ? 'По умолчанию выключено. Запускается кнопкой в просмотре капсулы или явным инструментом родительского агента. Автоматических проверок и исправлений нет.' : 'Off by default. Runs from the capsule review button or an explicit parent-agent tool. There are no automatic checks or fixes.'}</p>
      <ContextImportFields ru={ru} entries={projectDraft.imports ?? []} enabled={!!projectDraft.importsEnabled} onChange={(imports, importsEnabled) => setProjectDraft({ ...projectDraft, imports, importsEnabled })} />
      <button type="button" className="agent-settings-button agent-settings-button--primary" onClick={() => void act(async () => { const next = await api.saveProject(projectDraft, state!.revision); replace(next); setProjectId(next.projects.at(-1)!.id); setTaskId(''); setProjectDraft(null); })}>{ru ? 'Сохранить проект' : 'Save project'}</button>
      {projectDraft.id && <button type="button" className="agent-settings-button" onClick={() => void act(async () => { replace(await api.remove('project', projectDraft.id!, state!.revision)); setProjectId(''); setTaskId(''); setProjectDraft(null); })}>{ru ? 'Удалить проект и его правила' : 'Remove project and its rules'}</button>}
      <button type="button" className="agent-settings-button" onClick={() => setProjectDraft(null)}>{ru ? 'Отмена' : 'Cancel'}</button>
    </fieldset>}
    {project && <details><summary>{ru ? 'Управление задачами' : 'Manage tasks'}</summary><div className="agent-settings-grid">
      <label className="agent-settings-field"><span>{ru ? 'Название новой задачи' : 'New task name'}</span><input value={taskLabel} maxLength={160} onChange={e => setTaskLabel(e.target.value)} /></label>
      <button className="agent-settings-button" type="button" disabled={busy || !taskLabel.trim()} onClick={() => void act(async () => { const next = await api.saveTask({ label: taskLabel, projectId }, state!.revision); replace(next); setTaskId(next.tasks.at(-1)!.id); setTaskLabel(''); })}>{ru ? 'Добавить задачу' : 'Add task'}</button>
      {taskId && <button className="agent-settings-button" type="button" disabled={busy} onClick={() => void act(async () => { replace(await api.remove('task', taskId, state!.revision)); setTaskId(''); })}>{ru ? 'Удалить задачу и её правила' : 'Remove task and its rules'}</button>}
    </div></details>}
    {project && state && <ContextFeedbackSettings key={project.id} state={state} project={project} ru={ru} busy={busy} editorActive={feedbackEditor} activate={() => { setDraft(null); setProjectDraft(null); setImported(null); setFeedbackEditor(true); }} close={() => setFeedbackEditor(false)} perform={act} replace={replace} />}
    <div className="agent-settings-grid">
      <label className="agent-settings-field"><span>{ru ? 'Поиск правил' : 'Search rules'}</span><input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label className="agent-settings-field"><span>{ru ? 'Категория' : 'Category'}</span><select value={category} disabled={busy} onChange={e => { setCategory(e.target.value as ContextCategory | ''); setPreview(null); setImported(null); }}><option value="">{ru ? 'Все категории' : 'All categories'}</option>{CONTEXT_CATEGORIES.map(c => <option key={c} value={c}>{ru ? categoryRu[c] : c}</option>)}</select></label>
    </div>
    {project?.importsEnabled && <p className="agent-settings-hint">{ru ? 'Соберите предпросмотр ниже, чтобы увидеть разрешённые импортированные правила и их источники. Они перечитываются при каждом запуске.' : 'Build the preview below to see permitted imported rules and their sources. They are read again for every launch.'}</p>}
    <div className="context-settings__rules" aria-label={ru ? 'Правила контекста' : 'Context rules'}>{rules.map(rule => <button type="button" className={`context-settings__rule${rule.enabled ? '' : ' context-settings__rule--disabled'}`} key={rule.id} onClick={() => { if (rule.source === 'imported') { setFeedbackEditor(false); setDraft(null); setProjectDraft(null); setImported(rule); } else edit(rule); }} disabled={busy}>
      <strong>{rule.key}</strong><span>{ru ? scopeRu[rule.scope] : rule.scope} · {rule.dataClass} · {rule.source} · {rule.enabled ? (ru ? 'Включено' : 'Enabled') : (ru ? 'Выключено' : 'Disabled')}</span><span>{typeof rule.value === 'string' ? rule.value : JSON.stringify(rule.value)}</span>
    </button>)}</div>
    {state && !rules.length && <p className="agent-settings-hint">{ru ? 'Здесь пока нет подходящих правил.' : 'No matching rules yet.'}</p>}
    <button type="button" className="agent-settings-button" disabled={busy || !state} onClick={() => edit()}>{ru ? 'Добавить правило' : 'Add rule'}</button>
    <details><summary>{ru ? 'Токены дизайна — явные значения' : 'Design tokens — explicit values'}</summary><div className="context-settings__actions">{[['colors', 'Цвет'], ['typography', 'Типографика'], ['spacing', 'Отступ'], ['radius', 'Радиус'], ['components', 'Цвета компонента']].map(([family, label]) => <button key={family} type="button" disabled={busy || !state} className="agent-settings-button" onClick={() => newToken(family!)}>{ru ? label : family}</button>)}</div><p className="agent-settings-hint">{ru ? 'Явные значения проекта сильнее импортированных с тем же ключом. Для изменения CSS-токена выберите его в предпросмотре и создайте переопределение.' : 'Explicit project values override imports with the same key. Select an imported CSS token to create an override.'}</p></details>
    <details><summary>{ru ? 'Проверяемые соглашения — шаблоны JSON' : 'Checkable conventions — JSON presets'}</summary><p className="agent-settings-hint">{ru ? 'Ключи validate.* используют узкий структурированный формат. Обычные текстовые инструкции не исполняются. Отредактируйте значения шаблона перед сохранением.' : 'validate.* keys use a narrow structured vocabulary. Ordinary prose is not executable. Edit the preset values before saving.'}</p><div className="context-settings__actions">{CONVENTION_PRESETS.map(preset => <button key={preset.key} type="button" className="agent-settings-button" disabled={busy || !state} onClick={() => edit({ scope: project ? 'project' : 'user', ...(project ? { ownerId: project.id } : {}), category: preset.category, key: preset.key, value: preset.value, tags: [], dataClass: 'D2', enabled: true })}>{ru ? preset.ru : preset.label}</button>)}</div></details>
    {imported && <fieldset className="container-profiles__editor agent-settings-grid"><legend>{ru ? 'Импортированное правило — только чтение' : 'Imported rule — read only'}</legend>
      <p className="agent-settings-hint agent-settings-field--wide context-settings__path">{imported.key} · {imported.dataClass}<br />{imported.provenance?.sourcePath}:{imported.provenance?.sourceLine}<br />SHA-256: {imported.provenance?.sourceHash}</p>
      <pre className="context-settings__text agent-settings-field--wide">{typeof imported.value === 'string' ? imported.value : JSON.stringify(imported.value, null, 2)}</pre>
      <p className="agent-settings-hint agent-settings-field--wide">{ru ? 'Источник является авторитетным для импорта. Здесь показан снимок последнего предпросмотра; следующий предпросмотр и запуск читают файл заново.' : 'The source file is authoritative for this import. This is the last preview snapshot; the next preview and launch read the file again.'}</p>
      <button type="button" disabled={busy} className="agent-settings-button" onClick={() => edit({ scope: 'project', ownerId: imported.ownerId, category: imported.category, key: imported.key, value: imported.value, tags: [], dataClass: imported.dataClass, enabled: true })}>{ru ? 'Создать явное переопределение' : 'Create explicit override'}</button>
      <button type="button" className="agent-settings-button" onClick={() => setImported(null)}>{ru ? 'Закрыть' : 'Close'}</button>
    </fieldset>}
    {draft && <fieldset className="container-profiles__editor agent-settings-grid" disabled={busy}>
      <legend>{ru ? 'Правило контекста' : 'Context rule'}</legend>
      <label className="agent-settings-field"><span>{ru ? 'Область действия' : 'Scope'}</span><select value={draft.scope} onChange={e => selectScope(e.target.value as ContextScope)}>{scopes.map(s => <option key={s} value={s} disabled={s === 'project' && !project || s === 'task' && !tasks.length || s === 'organization' && !project?.organizationId}>{ru ? scopeRu[s] : s}</option>)}</select></label>
      <label className="agent-settings-field"><span>{ru ? 'Категория правила' : 'Rule category'}</span><select value={draft.category} onChange={e => set({ category: e.target.value as ContextCategory })}>{CONTEXT_CATEGORIES.map(c => <option key={c} value={c}>{ru ? categoryRu[c] : c}</option>)}</select></label>
      {draft.scope === 'task' && <label className="agent-settings-field"><span>{ru ? 'Задача правила' : 'Rule task'}</span><select value={draft.ownerId ?? ''} onChange={e => set({ ownerId: e.target.value })}>{tasks.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>}
      <label className="agent-settings-field"><span>{ru ? 'Ключ, например design.button.text' : 'Key, e.g. design.button.text'}</span><input value={draft.key} maxLength={160} onChange={e => set({ key: e.target.value })} /></label>
      <label className="agent-settings-field"><span>{ru ? 'Класс данных' : 'Data class'}</span><select value={draft.dataClass ?? 'D2'} onChange={e => set({ dataClass: e.target.value as DataClass })}>{['D0', 'D1', 'D2', 'D3'].map(c => <option key={c}>{c}</option>)}</select></label>
      {component && (['foreground', 'background'] as const).map(key => <label className="agent-settings-field" key={key}><span>{ru ? key === 'foreground' ? 'Цвет текста компонента' : 'Фон компонента' : `Component ${key}`}</span><input value={typeof componentValues[key] === 'string' ? componentValues[key] : ''} placeholder={key === 'foreground' ? 'var(--brand-dark)' : '#F3ECE4'} onChange={e => setValueText(JSON.stringify({ ...componentValues, [key]: e.target.value }, null, 2))} /></label>)}
      <label className="agent-settings-field agent-settings-field--wide"><span>{ru ? 'Значение правила' : 'Rule value'}</span><textarea rows={4} value={valueText} maxLength={4096} onChange={e => setValueText(e.target.value)} /></label>
      <label className="agent-settings-field"><span>{ru ? 'Формат значения' : 'Value format'}</span><select value={jsonValue ? 'json' : 'text'} onChange={e => setJsonValue(e.target.value === 'json')}><option value="text">{ru ? 'Текст' : 'Text'}</option><option value="json">JSON</option></select></label>
      <label className="agent-settings-field"><span>{ru ? 'Метки через запятую' : 'Comma-separated tags'}</span><input value={tagsText} onChange={e => setTagsText(e.target.value)} /></label>
      <label className="agent-settings-field"><span>{ru ? 'Использование' : 'Status'}</span><select value={String(draft.enabled)} onChange={e => set({ enabled: e.target.value === 'true' })}><option value="true">{ru ? 'Включено' : 'Enabled'}</option><option value="false">{ru ? 'Выключено' : 'Disabled'}</option></select></label>
      <p className="agent-settings-hint agent-settings-field--wide">{ru ? 'Источник: явное правило пользователя. Другие правила с тем же ключом разрешаются по приоритету, затем фильтруются по доступу. Редактор не изменяет файлы проекта.' : 'Source: explicit user rule. Same-key conflicts resolve by priority before access filtering. This editor does not alter project files.'}</p>
      <button className="agent-settings-button agent-settings-button--primary" type="button" onClick={() => void act(async () => { replace(await api.saveRule({ ...draft, tags: tagsText.split(',').map(v => v.trim()).filter(Boolean), value: jsonValue ? JSON.parse(valueText) : valueText }, state!.revision)); setDraft(null); })}>{ru ? 'Сохранить правило' : 'Save rule'}</button>
      <button className="agent-settings-button" type="button" onClick={() => setDraft(null)}>{ru ? 'Отмена' : 'Cancel'}</button>
      {draft.id && <button className="agent-settings-button" type="button" onClick={() => void act(async () => { replace(await api.remove('rule', draft.id!, state!.revision)); setDraft(null); })}>{ru ? 'Удалить правило' : 'Remove rule'}</button>}
    </fieldset>}
    <details className="context-settings__preview"><summary>{ru ? 'Предпросмотр правил' : 'Preview rules'}</summary>
      <p className="agent-settings-hint">{ru ? 'Показывает разрешённые правила выбранного проекта и задачи. Лимит — 12 КиБ UTF‑8; это не число токенов.' : 'Shows permitted rules for the selected project and task. The limit is 12 KiB of UTF-8, not a token count.'}</p>
      <div className="agent-settings-grid"><label className="agent-settings-field"><span>{ru ? 'Максимальный класс в предпросмотре' : 'Preview clearance'}</span><select value={ceiling} disabled={busy} onChange={e => { setCeiling(e.target.value as DataClass); setPreview(null); setImported(null); }}>{['D0', 'D1', 'D2', 'D3'].map(c => <option key={c}>{c}</option>)}</select></label>
      <button type="button" className="agent-settings-button" disabled={busy || !state} onClick={() => void act(async () => { setPreview(null); setImported(null); setPreview(await api.preview({ ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}), maxDataClass: ceiling, ...(category ? { categories: [category] } : {}) })); }) }>{ru ? 'Собрать предпросмотр' : 'Build preview'}</button></div>
      {preview && <div><p className="agent-settings-hint">{preview.included.length} {ru ? 'правил' : 'rules'} · {preview.bytes} {ru ? 'байт' : 'bytes'} · {preview.dataClass}{preview.omitted ? ` · ${ru ? 'Не вошло по объёму' : 'Omitted by budget'}: ${preview.omitted}` : ''}</p><pre className="context-settings__text">{preview.text || (ru ? 'Нет правил для этого выбора.' : 'No rules for this selection.')}</pre></div>}
      {preview?.diagnostics?.map((d, i) => <p key={i} className="agent-settings-hint context-settings__path">{d.sourcePath} · {d.dataClass} · {d.status}: {d.message}</p>)}
    </details>
  </div>;
}
