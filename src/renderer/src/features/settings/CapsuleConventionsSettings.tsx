import { useEffect, useRef, useState } from 'react';
import type { AppSettings, DataClass } from '../../../../shared/contracts';
import type { CapsuleReview } from '../../../../shared/capsules';
import type { ConventionReport } from '../../../../shared/conventions';

export function CapsuleConventionsSettings({ settings, review, active }: { settings: AppSettings; review: CapsuleReview | null; active: boolean }): React.JSX.Element | null {
  const ru = settings.locale === 'ru', [clearance, setClearance] = useState<DataClass>('D2');
  const [report, setReport] = useState<ConventionReport | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => { generation.current++; setReport(null); setError(''); setBusy(false); }, [review?.reviewId, active, settings, clearance]);
  useEffect(() => () => { generation.current++; }, []);
  // A report is a snapshot. Returning to this window revokes the displayed copy until main rechecks it.
  useEffect(() => {
    const clear = (): void => { generation.current++; setReport(null); setBusy(false); };
    window.addEventListener('focus', clear); return () => window.removeEventListener('focus', clear);
  }, []);
  if (!review) return null;
  const run = async (current = false): Promise<void> => {
    const token = ++generation.current, previous = report; setBusy(true); setError(''); setReport(null);
    try {
      const result = current && previous ? await window.canvasTTY.capsules.currentConventions(previous.id) : await window.canvasTTY.capsules.validateConventions(review.workspaceId, review.reviewId, clearance);
      if (token === generation.current) setReport(result);
    } catch (e) { if (token === generation.current) setError(String(e)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  return <details className="context-settings__preview capsule-conventions"><summary>{ru ? 'Проверка соглашений проекта' : 'Project convention checks'}</summary>
    <p className="agent-settings-hint">{ru ? 'Явная проверка выбранного снимка. Включите её для исходного проекта в разделе «Контекст». Проверяются только поддерживаемые правила validate.*; исправления и запросы к модели не запускаются.' : 'Explicit checks of the selected snapshot. Enable them for the source project under Context. Only supported validate.* rules are checked; no fixes or model requests run.'}</p>
    <div className="agent-settings-grid"><label className="agent-settings-field"><span>{ru ? 'Класс данных отчёта' : 'Report clearance'}</span><select disabled={busy} value={clearance} onChange={e => setClearance(e.target.value as DataClass)}>{['D0', 'D1', 'D2', 'D3'].map(c => <option key={c}>{c}</option>)}</select></label>
      <button type="button" className="agent-settings-button" disabled={busy || !active} onClick={() => void run()}>{ru ? 'Проверить соглашения' : 'Check conventions'}</button></div>
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
    {busy && <p className="agent-settings-hint" role="status">{ru ? 'Проверяем снимок…' : 'Checking snapshot…'}</p>}
    {report && <div className="capsule-conventions__result">
      <p className="agent-settings-hint" role="status">{report.state === 'disabled' ? (ru ? 'Проверки проекта выключены.' : 'Project checks are disabled.') : `${ru ? 'Предупреждения' : 'Warnings'}: ${report.warnings.length} · ${ru ? 'Файлов в доступной области' : 'Files in permitted scope'}: ${report.coverage.length}`}</p>
      {report.state === 'complete' && <><p className="agent-settings-hint">{ru ? 'Результат относится только к этому снимку и указанной области покрытия. Отсутствие предупреждений не означает полную проверку проекта. После изменения файлов или правил проверьте заново.' : 'This result covers only this snapshot and the reported scope. No warnings does not mean the entire project passed. Recheck after changing files or rules.'}</p>
        <button type="button" className="agent-settings-button" disabled={busy} onClick={() => void run(true)}>{ru ? 'Проверить актуальность' : 'Check currentness'}</button></>}
      {!!report.warnings.length && <ol className="capsule-conventions__findings">{report.warnings.map((f, i) => <li key={i}><strong>{f.path}:{f.line}</strong><p>{f.message}</p><small>{f.key} · {f.source} · {f.ruleId}</small></li>)}</ol>}
      {!!report.diagnostics.length && <details><summary>{ru ? 'Ограничения и диагностика' : 'Limits and diagnostics'} ({report.diagnostics.length})</summary><ul className="capsule-conventions__findings">{report.diagnostics.map((d, i) => <li key={i}>{d.path && <strong>{d.path} · </strong>}{d.key && <span>{d.key} · {d.source}: </span>}{d.message}</li>)}</ul></details>}
      {report.truncated && <p className="agent-settings-error">{ru ? 'Достигнут предел отчёта. Покрытие неполное; сократите выбранную область.' : 'Report bound reached. Coverage is incomplete; narrow the selected scope.'}</p>}
      {!!report.coverage.length && <details><summary>{ru ? 'Область покрытия и идентичность' : 'Coverage and identity'}</summary><ul className="capsule-conventions__findings">{report.coverage.map(c => <li key={c.path}>{c.path} · {c.changedLines} {ru ? 'новых строк' : 'added/changed lines'} · {c.checks} {ru ? 'проверок' : 'checks'}</li>)}</ul><p className="agent-settings-hint context-settings__path">{ru ? 'Снимок' : 'Snapshot'}: {report.reviewDigest}<br />{ru ? 'Контекст' : 'Context'}: {report.contextDigest}</p></details>}
    </div>}
  </details>;
}
