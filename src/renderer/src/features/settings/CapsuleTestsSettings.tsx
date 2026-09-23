import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../../shared/contracts';
import type { CapsuleReview, CapsuleTestRun, CapsuleTestSummary } from '../../../../shared/capsules';
import { CapsuleTestProfilesSettings } from './CapsuleTestProfilesSettings';

export function CapsuleTestsSettings({ settings, review, active, onPersist }: { settings: AppSettings; review: CapsuleReview | null; active: boolean; onPersist(patch: Partial<AppSettings>): Promise<void> }): React.JSX.Element {
  const ru = settings.locale === 'ru';
  const [items, setItems] = useState<CapsuleTestSummary[]>([]), [result, setResult] = useState<CapsuleTestRun | null>(null), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const profiles = (settings.capsuleTestProfiles ?? []).filter(profile => settings.containerProfiles.some(image => image.id === profile.containerProfileId && image.hostId === 'local'));
  const profileId = profiles.some(profile => profile.id === selected) ? selected : profiles[0]?.id ?? '';
  const pending = items.some(item => item.state === 'running' || item.state === 'preparing');
  const selectedState = items.find(item => item.id === result?.id)?.state;
  useEffect(() => {
    if (!active || !result || !selectedState || result.state === selectedState) return;
    let current = true;
    void window.canvasTTY.capsules.testResult(result.id).then(value => { if (current) setResult(value); }, reason => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [active, result?.id, selectedState, result?.state]);
  useEffect(() => {
    if (!active) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const list = await window.canvasTTY.capsules.testRuns(); if (!current) return;
        setItems(list);
        if (list.some(item => item.state === 'running' || item.state === 'preparing')) timer = setTimeout(() => void refresh(), 1000);
      } catch (reason) { if (current) setError(String(reason)); }
    };
    void refresh(); return () => { current = false; clearTimeout(timer); };
  }, [active, pending]);
  const refresh = async (): Promise<void> => { setItems(await window.canvasTTY.capsules.testRuns()); };
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('');
    try { await operation(); await refresh(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const labels = ru ? { preparing: 'Подготовка', running: 'Выполняется', passed: 'Пройден', failed: 'Не пройден', cancelled: 'Отменён', uncertain: 'Остановка не подтверждена', unavailable: 'Недоступен' } : { preparing: 'Preparing', running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Stop unconfirmed', unavailable: 'Unavailable' };
  return <section className="capsule-tests" aria-label={ru ? 'Проверки снимков' : 'Snapshot tests'}>
    <div className="agent-settings-heading"><h3>{ru ? 'Проверки снимков' : 'Snapshot tests'}</h3><button className="agent-settings-button" type="button" disabled={busy} onClick={() => void run(refresh)}>{ru ? 'Обновить проверки' : 'Refresh tests'}</button></div>
    <p className="agent-settings-hint">{ru ? 'Проверка запускается в отдельной копии показанных файлов, без Task.md, исходного проекта, ключей и сети. Нужны заранее подготовленный образ и сохранённая команда.' : 'Tests run in a separate copy of the reviewed files, without Task.md, the source checkout, credentials or network. A preprovisioned image and saved command are required.'}</p>
    {review ? <div className="capsule-tests__launch">
      <label className="agent-settings-field"><span>{ru ? 'Команда для показанного снимка' : 'Command for the shown snapshot'}</span><select value={profileId} disabled={busy || pending} onChange={event => setSelected(event.target.value)}><option value="">{ru ? 'Выберите сохранённую команду' : 'Choose a saved command'}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
      <button type="button" className="agent-settings-button agent-settings-button--primary" disabled={busy || pending || !profileId} onClick={() => void run(async () => { await window.canvasTTY.capsules.startTest(review.workspaceId, review.reviewId, profileId); setResult(null); })}>{ru ? 'Проверить показанный снимок' : 'Test shown snapshot'}</button>
    </div> : <p className="agent-settings-hint">{ru ? 'Сначала откройте изменения капсулы выше.' : 'Review a capsule above to test its snapshot.'}</p>}
    <details className="retained-workspaces__help"><summary>{ru ? 'Команды проверок' : 'Saved test commands'}</summary><CapsuleTestProfilesSettings settings={settings} onPersist={onPersist} /></details>
    <div className="retained-workspaces__list">{items.map(item => <div className="container-profiles__card" key={item.id}>
      <strong>{settings.capsuleTestProfiles?.find(profile => profile.id === item.testProfileId)?.label ?? (ru ? 'Сохранённая проверка' : 'Retained test')} · {labels[item.state]}</strong>
      <p className="agent-settings-hint">{new Date(item.createdAt).toLocaleString()}{review && ` · ${item.reviewDigest === review.digest ? (ru ? 'Показанный снимок' : 'Shown snapshot') : (ru ? 'Другой снимок' : 'Different snapshot')}`}</p>
      {item.reason && <p className="agent-settings-hint">{item.reason}</p>}
      {item.profileCurrent === false && <p className="agent-settings-hint">{ru ? 'Команда изменена или удалена после этой проверки.' : 'The saved command changed or was removed after this test.'}</p>}
      <button className="agent-settings-button" type="button" disabled={busy || item.state === 'unavailable'} onClick={() => void run(async () => setResult(await window.canvasTTY.capsules.testResult(item.id)))}>{ru ? 'Результат и журнал' : 'Result and log'}</button>
      {['running', 'preparing'].includes(item.state) && <button className="agent-settings-button" type="button" disabled={busy} onClick={() => void run(() => window.canvasTTY.capsules.cancelTest(item.id))}>{ru ? 'Отменить проверку' : 'Cancel test'}</button>}
      {item.stopped && !['running', 'preparing', 'unavailable'].includes(item.state) && <button className="agent-settings-button" type="button" disabled={busy} onClick={() => void run(async () => { await window.canvasTTY.capsules.cleanupTest(item.id); if (result?.id === item.id) setResult(null); })}>{ru ? 'Удалить результат проверки' : 'Remove test result'}</button>}
    </div>)}</div>
    {result && <section className="retained-workspaces__review" aria-label={ru ? 'Журнал проверки' : 'Test log'}>
      <div className="agent-settings-heading"><strong>{labels[result.state]}{result.exitCode !== null ? ` · ${ru ? 'код' : 'exit'} ${result.exitCode}` : ''}</strong><button className="agent-settings-button" type="button" onClick={() => setResult(null)}>{ru ? 'Закрыть журнал' : 'Close log'}</button></div>
      {review && <p className="agent-settings-hint">{result.reviewDigest === review.digest ? (ru ? 'Результат относится к показанному снимку.' : 'This result belongs to the shown snapshot.') : (ru ? 'Результат относится к другому снимку.' : 'This result belongs to a different snapshot.')}</p>}
      {result.truncated && <p className="agent-settings-hint">{ru ? 'Журнал достиг заданного лимита и обрезан.' : 'The log reached its configured limit and was truncated.'}</p>}
      <pre className="retained-capsules__patch" tabIndex={0}>{result.output || (['running', 'preparing'].includes(result.state) ? (ru ? 'Журнал появится после завершения проверки.' : 'The log is available after the test finishes.') : (ru ? 'Команда не оставила вывода.' : 'The command produced no output.'))}</pre>
    </section>}
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
  </section>;
}
