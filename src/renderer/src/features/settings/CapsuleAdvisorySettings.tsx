import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../../../shared/contracts';
import type { AdvisoryReviewChoices, AdvisoryReviewRoute, AdvisoryReviewPreview, CapsuleReview } from '../../../../shared/capsules';

const routeKey = (route: AdvisoryReviewRoute): string => JSON.stringify([route.accountId, route.model, route.containerProfileId]);

export function CapsuleAdvisorySettings({ settings, review, active, onRevealSession }: { settings: AppSettings; review: CapsuleReview; active: boolean; onRevealSession?(id: string): void }): React.JSX.Element {
  const ru = settings.locale === 'ru';
  const [choices, setChoices] = useState<AdvisoryReviewChoices | null>(null), [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<AdvisoryReviewPreview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [child, setChild] = useState<string | null>(null);
  const generation = useRef(0), token = useRef<string | null>(null), launching = useRef(false);
  const clear = (): void => { generation.current++; setPreview(null); const previous = token.current; token.current = null; if (previous && !launching.current) void window.canvasTTY.capsules.cancelReviewAgent(previous).catch(() => {}); };
  useEffect(() => { clear(); setBusy(false); }, [settings, active]);
  useEffect(() => { const focus = (): void => { if (!launching.current) { clear(); setBusy(false); } }; window.addEventListener('focus', focus); return () => { window.removeEventListener('focus', focus); clear(); }; }, []);
  const refresh = async (): Promise<void> => {
    clear(); const current = generation.current; setBusy(true); setError('');
    try { const value = await window.canvasTTY.capsules.reviewAgentChoices(review.workspaceId, review.reviewId); if (current === generation.current) { setChoices(value); if (!value.routes.some(route => routeKey(route) === selected)) setSelected(''); } }
    catch (e) { if (current === generation.current) { setChoices(null); setError(String(e)); } }
    finally { if (current === generation.current) setBusy(false); }
  };
  const prepare = async (): Promise<void> => {
    clear(); const current = generation.current, route = choices?.routes.find(route => routeKey(route) === selected), parent = choices?.parents[0];
    if (!route || !parent) return;
    setBusy(true); setError('');
    try {
      const value = await window.canvasTTY.capsules.previewReviewAgent({ capsuleId: review.workspaceId, reviewId: review.reviewId, parentSessionId: parent.id, accountId: route.accountId, model: route.model, containerProfileId: route.containerProfileId });
      if (current === generation.current) { token.current = value.previewId; setPreview(value); }
      else await window.canvasTTY.capsules.cancelReviewAgent(value.previewId);
    } catch (e) { if (current === generation.current) setError(String(e)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const launch = async (): Promise<void> => {
    if (!preview) return; const id = preview.previewId; launching.current = true; setBusy(true); setError('');
    try { const session = await window.canvasTTY.capsules.launchReviewAgent(id); setChild(session.id); token.current = null; setPreview(null); }
    catch (e) { setPreview(null); token.current = null; setError(String(e)); }
    finally { launching.current = false; setBusy(false); }
  };
  const reason = choices?.unavailable;
  return <details className="context-settings__preview capsule-advisory"><summary>{ru ? 'Рецензия агента' : 'Review with agent'}</summary>
    <p className="agent-settings-hint">{ru ? 'Отдельный запрос к выбранной модели расходует квоту аккаунта. Агент получает только патч и подходящий контекст проекта в контейнере с доступом к файлам только для чтения. Ответ — рекомендация; изменения не применяются.' : 'A separate request to your selected model consumes account quota. The agent receives only the patch and eligible project context in a container with read-only files. Its response is advisory; changes are not applied.'}</p>
    <button type="button" className="agent-settings-button" disabled={busy || !active} onClick={() => void refresh()}>{ru ? 'Загрузить доступные маршруты' : 'Load available routes'}</button>
    {reason && <p className="agent-settings-hint" role="status">{reason === 'ownerless' ? (ru ? 'Эта капсула создана без родительского агента. Рецензия доступна для капсул, созданных работающим агентом с разрешённым делегированием.' : 'This capsule has no parent agent. Review is available for capsules captured by a live agent with delegation enabled.') : reason === 'unchanged' ? (ru ? 'В снимке нет изменений.' : 'This snapshot has no changes.') : (ru ? 'Исходный родительский агент недоступен или его полномочия изменились. Создайте новую капсулу из действующей сессии.' : 'The original parent is unavailable or its authority changed. Capture a new capsule from an authorized live session.')}</p>}
    {!!choices?.parents.length && <div className="agent-settings-grid">
      <label className="agent-settings-field"><span>{ru ? 'Родительский агент' : 'Parent agent'}</span><select value={choices.parents[0]!.id} disabled>{choices.parents.map(parent => <option key={parent.id} value={parent.id}>{parent.title} · {parent.provider}</option>)}</select></label>
      <label className="agent-settings-field"><span>{ru ? 'Аккаунт · модель · контейнер' : 'Account · model · container'}</span><select value={selected} disabled={busy} onChange={e => { clear(); setSelected(e.target.value); setError(''); }}><option value="">{ru ? 'Выберите маршрут' : 'Choose a route'}</option>{choices.routes.map(route => <option key={routeKey(route)} value={routeKey(route)}>{route.accountLabel} · {route.model} · {route.containerLabel}</option>)}</select></label>
    </div>}
    {choices && !reason && !choices.routes.length && <p className="agent-settings-hint">{ru ? 'Настройте локальный API-аккаунт с конкретной моделью и совместимый контейнер с сетью bridge. Закреплённый сервер аккаунта не меняется.' : 'Configure a local API account with an exact model and a compatible bridge-network container. The account stays on its fixed host.'}</p>}
    <div className="agent-settings-actions agent-settings-actions--start"><button type="button" className="agent-settings-button" disabled={busy || !active || !choices?.parents.length || selected === ''} onClick={() => void prepare()}>{ru ? 'Проверить маршрут и контекст' : 'Preview route and context'}</button></div>
    {preview && <section aria-label={ru ? 'Контекст рецензии' : 'Review context'}><p className="agent-settings-hint">{preview.route.accountLabel} · {preview.route.provider} · {preview.route.model}<br />{ru ? 'Этот компьютер' : 'This computer'} · {preview.route.containerLabel} · {preview.dataClass}<br />{ru ? 'Контекст' : 'Context'}: {preview.contextBytes} B · {preview.contextDataClass}</p><pre className="context-settings__text" tabIndex={0}>{preview.text || (ru ? 'Дополнительный контекст не включён.' : 'No optional context included.')}</pre>
      <button type="button" className="agent-settings-button agent-settings-button--primary" disabled={busy || !active} onClick={() => void launch()}>{ru ? 'Запустить платную рецензию' : 'Launch paid review'}</button></section>}
    {busy && <p className="agent-settings-hint" role="status">{ru ? 'Подготовка…' : 'Preparing…'}</p>}
    {busy && token.current && <button type="button" className="agent-settings-button" onClick={() => void window.canvasTTY.capsules.cancelReviewAgent(token.current!).catch(e => setError(String(e)))}>{ru ? 'Отменить подготовку' : 'Cancel preparation'}</button>}
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
    {child && <div className="agent-settings-notice" role="status"><p>{ru ? 'Сессия «Advisory review» сохранена на холсте. Статус запуска и ответ доступны в её окне.' : 'The “Advisory review” session is retained on the canvas. Its window shows launch status and output.'}</p>{onRevealSession && <button type="button" className="agent-settings-button" onClick={() => onRevealSession(child)}>{ru ? 'Открыть рецензию' : 'Open review'}</button>}</div>}
  </details>;
}
