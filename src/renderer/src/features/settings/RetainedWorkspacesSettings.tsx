import { useEffect, useState } from 'react';
import type { AppSettings, RetainedWorkspace, WorkspaceReview } from '../../../../shared/contracts';
import { t } from '../../lib/i18n';

/** Mounted only while the Agents settings page is visible; refresh is explicit and never polls. */
export function RetainedWorkspacesSettings({ settings, onChange }: { settings: AppSettings; onChange(patch: Partial<AppSettings>): Promise<void> }): React.JSX.Element {
  const locale = settings.locale;
  const ru = locale === 'ru';
  const [items, setItems] = useState<RetainedWorkspace[]>([]);
  const [review, setReview] = useState<WorkspaceReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    void window.canvasTTY.workspaces.list().then(value => { if (active) setItems(value); }, failure => { if (active) setError(String(failure)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null); setNotice('');
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <section className="retained-workspaces" aria-label={t(locale, 'retainedWorkspaces')}>
    <div className="agent-settings-heading"><h3>{t(locale, 'retainedWorkspaces')} <span className="agent-settings-count">{items.length}</span></h3>
      <button className="agent-settings-button" type="button" disabled={busy} onClick={() => void run(async () => setItems(await window.canvasTTY.workspaces.list()))}>{t(locale, 'workspaceRefresh')}</button>
    </div>
    <p className="agent-settings-hint">{ru ? 'Проверьте результат агента, сохраните патч или удалите пустую копию.' : 'Review agent output, save a patch or remove an unchanged checkout.'}</p>
    <details className="retained-workspaces__help"><summary>{ru ? 'Как работают отдельные копии' : 'How separate checkouts work'}</summary><p className="agent-settings-hint">{t(locale, 'worktreeExplanation')}</p></details>
    <fieldset className="retained-workspaces__policy"><legend>{t(locale, 'isolationRequired')}</legend>{(['normal', 'yolo'] as const).map(profile => <label key={profile}>
      <input type="checkbox" checked={(settings.requiresSandboxProfiles ?? []).includes(profile)} onChange={event => {
        const profiles = settings.requiresSandboxProfiles ?? [];
        void run(() => onChange({ requiresSandboxProfiles: event.target.checked ? [...profiles, profile] : profiles.filter(value => value !== profile) }));
      }} disabled={busy} /> {t(locale, profile)}
    </label>)}</fieldset>
    {items.length === 0 && !busy && <p className="agent-settings-empty">{t(locale, 'workspaceEmpty')}</p>}
    <div className="retained-workspaces__list">{items.map(item => <details className="retained-workspaces__card" key={item.id}><summary>
      <span className="retained-workspaces__identity"><strong>{item.sourceCwd?.split(/[/\\]/).filter(Boolean).pop() || item.id}</strong><small title={item.sourceCwd}>{item.sourceCwd || item.id}</small></span>
      <span className={`retained-workspaces__status retained-workspaces__status--${item.state}`}>{t(locale, `workspaceState_${item.state}`)}</span>
    </summary><div className="retained-workspaces__detail">
      <dl><dt>{t(locale, 'workspaceSource')}</dt><dd>{item.sourceCwd}</dd><dt>{t(locale, 'workspaceExecution')}</dt><dd>{item.executionCwd}</dd><dt>{t(locale, 'worktreeBase')}</dt><dd>{item.baseCommit}</dd></dl>
      {item.reason && <p className="agent-settings-hint">{item.reason}</p>}
      <div className="agent-settings-actions agent-settings-actions--start">
        <button className="agent-settings-button" type="button" disabled={busy || item.state !== 'retained'} onClick={() => void run(async () => setReview(await window.canvasTTY.workspaces.review(item.id)))}>{t(locale, 'workspaceReview')}</button>
        <button className="agent-settings-button agent-settings-button--danger" type="button" disabled={busy || item.state !== 'retained'} onClick={() => void run(async () => { await window.canvasTTY.workspaces.cleanup(item.id); setItems(await window.canvasTTY.workspaces.list()); if (review?.workspaceId === item.id) setReview(null); })}>{t(locale, 'workspaceCleanup')}</button>
      </div>
    </div></details>)}</div>
    {review && <section className="retained-workspaces__review" aria-label={t(locale, 'workspaceReview')}>
      <div className="agent-settings-heading"><strong>{t(locale, 'workspaceReview')}</strong><button className="agent-settings-button" type="button" onClick={() => setReview(null)}>{t(locale, 'close')}</button></div>
      <p className="agent-settings-hint">{t(locale, 'workspaceExportNote')}</p>
      {review.limitations.length > 0 && <ul className="agent-settings-hint">{review.limitations.map(value => <li key={value}>{value}</li>)}</ul>}
      <textarea aria-label={t(locale, 'workspacePatch')} value={review.patch} readOnly rows={12} spellCheck={false} />
      <button className="agent-settings-button agent-settings-button--primary" type="button" disabled={busy} onClick={() => void run(async () => { const saved = await window.canvasTTY.workspaces.exportPatch(review.workspaceId, review.reviewId); setNotice(saved ? (ru ? 'Патч сохранён' : 'Patch saved') : (ru ? 'Экспорт отменён' : 'Export cancelled')); })}>{t(locale, 'workspaceExport')}</button>
    </section>}
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
    <p className="agent-settings-notice" role="status">{busy ? t(locale, 'workspaceBusy') : notice}</p>
  </section>;
}
