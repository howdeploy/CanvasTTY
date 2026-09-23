import { useEffect, useState } from 'react';
import type { CapsuleReview, CapsuleSummary } from '../../../../shared/capsules';
import type { AppSettings } from '../../../../shared/contracts';
import { CapsuleTestsSettings } from './CapsuleTestsSettings';

export function RetainedCapsulesSettings({ settings, active, onPersist }: { settings: AppSettings; active: boolean; onPersist(patch: Partial<AppSettings>): Promise<void> }): React.JSX.Element {
  const ru = settings.locale === 'ru';
  const [items, setItems] = useState<CapsuleSummary[]>([]), [review, setReview] = useState<CapsuleReview | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const refresh = async (): Promise<void> => { setItems(await window.canvasTTY.capsules.list()); };
  useEffect(() => { let active = true; void window.canvasTTY.capsules.list().then(value => { if (active) setItems(value); }, reason => { if (active) setError(String(reason)); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, []);
  const run = async (operation: () => Promise<void>, invalidatesReview = false): Promise<void> => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (reason) { if (invalidatesReview) setReview(null); setError(String(reason)); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  };
  const labels = ru ? { retained: 'Сохранена', running: 'Работает', uncertain: 'Остановка не подтверждена', unavailable: 'Недоступна', applied: 'Применена', 'apply-recovery-needed': 'Нужно восстановление' } : { retained: 'Retained', running: 'Running', uncertain: 'Stop unconfirmed', unavailable: 'Unavailable', applied: 'Applied', 'apply-recovery-needed': 'Recovery needed' };
  const reviewedCapsule = items.find(item => item.id === review?.workspaceId);
  return <section className="retained-workspaces retained-capsules" aria-label={ru ? 'Капсулы выбранных файлов' : 'Selected-file capsules'}>
    <div className="agent-settings-heading"><h3>{ru ? 'Капсулы выбранных файлов' : 'Selected-file capsules'} <span className="agent-settings-count">{items.length}</span></h3><button type="button" className="agent-settings-button" disabled={busy} onClick={() => void run(refresh)}>{ru ? 'Обновить' : 'Refresh'}</button></div>
    <p className="agent-settings-hint">{ru ? 'Здесь сохраняется результат работы с выбранными файлами. Применяется только показанный снимок и только если исходные файлы не изменились.' : 'Selected-file output is retained here. Only the shown snapshot can be applied, and only if the original files are unchanged.'}</p>
    {!busy && !items.length && <p className="agent-settings-empty">{ru ? 'Выберите режим «Только выбранные файлы» при запуске агента в локальном контейнере.' : 'Choose Selected files only when launching an agent in a local container.'}</p>}
    <div className="retained-workspaces__list">{items.map(item => <details className="retained-workspaces__card" key={item.id}>
      <summary><span className="retained-workspaces__identity"><strong>{item.sourceDirectory.split(/[/\\]/).filter(Boolean).pop() || item.id} · {item.files.length} {ru ? 'файлов' : 'files'}</strong><small>{new Date(item.createdAt).toLocaleString()} · {item.dataClass} · {(item.capturedBytes / 1024).toFixed(1)} KiB</small></span><span className={`retained-workspaces__status retained-workspaces__status--${item.state}`}>{labels[item.state]}</span></summary>
      <div className="retained-workspaces__detail"><dl><dt>{ru ? 'Исходный проект' : 'Source project'}</dt><dd>{item.sourceDirectory}</dd><dt>{ru ? 'Сохранённый результат' : 'Retained output'}</dt><dd>{item.directory}</dd></dl>
        <ul className="capsule-file-list">{item.files.map(file => <li key={file}>{file}</li>)}</ul>
        {item.reason && <p className="agent-settings-error">{item.reason}</p>}
        {(item.state === 'running' || item.state === 'uncertain') && <p className="agent-settings-hint">{ru ? 'Остановите агент. Если остановка не подтверждена, используйте очистку его сохранённого поколения в разделе «Контейнеры».' : 'Stop the agent. If termination is unconfirmed, clean its saved generation under Containers.'}</p>}
        <div className="agent-settings-actions agent-settings-actions--start">
          <button className="agent-settings-button" type="button" disabled={busy || !['retained', 'applied'].includes(item.state)} onClick={() => void run(async () => { setReview(await window.canvasTTY.capsules.review(item.id)); }, true)}>{ru ? 'Просмотреть изменения' : 'Review changes'}</button>
          <button className="agent-settings-button agent-settings-button--danger" type="button" disabled={busy || item.state !== 'retained'} onClick={() => void run(async () => { await window.canvasTTY.capsules.cleanup(item.id); if (review?.workspaceId === item.id) setReview(null); await refresh(); })}>{ru ? 'Удалить неизменённую копию' : 'Remove unchanged copy'}</button>
          {item.state === 'apply-recovery-needed' && item.recoveryReviewId && <button className="agent-settings-button" type="button" disabled={busy} onClick={() => void run(async () => { await window.canvasTTY.capsules.recoverApply(item.id, item.recoveryReviewId!); await refresh(); setNotice(ru ? 'Незавершённое применение отменено. Результат сохранён.' : 'Incomplete apply rolled back. Output retained.'); }, true)}>{ru ? 'Восстановить после сбоя' : 'Recover incomplete apply'}</button>}
        </div>
      </div>
    </details>)}</div>
    {review && <section className="retained-workspaces__review" aria-label={ru ? 'Просмотр капсулы' : 'Capsule review'}>
      <div className="agent-settings-heading"><strong>{ru ? 'Изменения выбранных файлов' : 'Selected-file changes'} · {review.changedFiles.length}</strong><button type="button" className="agent-settings-button" disabled={busy} onClick={() => setReview(null)}>{ru ? 'Закрыть' : 'Close'}</button></div>
      <p className="agent-settings-hint">{ru ? 'Исходный проект' : 'Source project'}: {reviewedCapsule?.sourceDirectory}<br />{ru ? 'Снимок' : 'Snapshot'}: {new Date(review.createdAt).toLocaleString()}</p>
      <pre className="retained-capsules__patch" tabIndex={0}>{review.patch || (ru ? 'Выбранные файлы не изменены.' : 'Selected files are unchanged.')}</pre>
      <div className="agent-settings-actions agent-settings-actions--start">
        <button type="button" className="agent-settings-button" disabled={busy} onClick={() => void run(async () => { const saved = await window.canvasTTY.capsules.exportPatch(review.workspaceId, review.reviewId); setNotice(saved ? (ru ? 'Патч сохранён' : 'Patch saved') : (ru ? 'Сохранение отменено' : 'Save cancelled')); }, true)}>{ru ? 'Сохранить патч' : 'Save patch'}</button>
        <button type="button" className="agent-settings-button agent-settings-button--primary" disabled={busy || !review.changedFiles.length || reviewedCapsule?.state !== 'retained'} onClick={() => void run(async () => { await window.canvasTTY.capsules.apply(review.workspaceId, review.reviewId); setReview(null); await refresh(); setNotice(ru ? 'Показанные изменения применены к исходному проекту.' : 'Shown changes applied to the source project.'); }, true)}>{reviewedCapsule?.state === 'applied' ? (ru ? 'Уже применено' : 'Already applied') : (ru ? 'Применить показанные изменения' : 'Apply shown changes')}</button>
      </div>
    </section>}
    <CapsuleTestsSettings settings={settings} review={review} active={active} onPersist={onPersist} />
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
    <p className="agent-settings-notice" role="status">{busy ? (ru ? 'Выполняется…' : 'Working…') : notice}</p>
  </section>;
}
