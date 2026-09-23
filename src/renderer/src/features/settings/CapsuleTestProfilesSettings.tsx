import { useState } from 'react';
import type { AppSettings } from '../../../../shared/contracts';
import { assertCapsuleTestProfile, type CapsuleTestProfile } from '../../../../shared/capsules';

export function CapsuleTestProfilesSettings({ settings, onPersist }: { settings: AppSettings; onPersist(patch: Partial<AppSettings>): Promise<void> }): React.JSX.Element {
  const ru = settings.locale === 'ru', profiles = settings.capsuleTestProfiles ?? [];
  const localImages = settings.containerProfiles.filter(profile => profile.hostId === 'local');
  const [draft, setDraft] = useState<CapsuleTestProfile | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const set = (patch: Partial<CapsuleTestProfile>): void => setDraft(current => current && ({ ...current, ...patch }));
  const save = async (next: CapsuleTestProfile[]): Promise<void> => {
    setBusy(true); setError('');
    try { next.forEach(assertCapsuleTestProfile); await onPersist({ capsuleTestProfiles: next }); setDraft(null); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="capsule-test-profiles">
    {profiles.map(profile => <div className="container-profiles__card" key={profile.id}>
      <strong>{profile.label}</strong><code>{profile.command}</code>
      <button className="agent-settings-button" type="button" disabled={busy} onClick={() => { setDraft(structuredClone(profile)); setError(''); }}>{ru ? 'Изменить' : 'Edit'}</button>
      <button className="agent-settings-button" type="button" disabled={busy} onClick={() => void save(profiles.filter(item => item.id !== profile.id))}>{ru ? 'Удалить команду' : 'Remove command'}</button>
    </div>)}
    <button className="agent-settings-button" type="button" disabled={busy || profiles.length >= 32} onClick={() => { setError(''); setDraft({ id: crypto.randomUUID(), label: '', containerProfileId: localImages[0]?.id ?? '', command: '/usr/bin/node', args: ['--test'], timeoutMs: 30000, outputBytes: 65536 }); }}>{ru ? 'Добавить команду проверки' : 'Add test command'}</button>
    {draft && <fieldset className="container-profiles__editor agent-settings-grid" disabled={busy}>
      <legend>{ru ? 'Сохранённая команда' : 'Saved test command'}</legend>
      <label className="agent-settings-field"><span>{ru ? 'Название проверки' : 'Test name'}</span><input value={draft.label} maxLength={100} onChange={event => set({ label: event.target.value })} /></label>
      <label className="agent-settings-field"><span>{ru ? 'Локальный профиль образа' : 'Local image profile'}</span><select value={draft.containerProfileId} onChange={event => set({ containerProfileId: event.target.value })}><option value="">{ru ? 'Выберите профиль' : 'Choose a profile'}</option>{localImages.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
      <label className="agent-settings-field agent-settings-field--wide"><span>{ru ? 'Исполняемый файл в образе' : 'Executable inside the image'}</span><input value={draft.command} maxLength={4096} onChange={event => set({ command: event.target.value })} /></label>
      <div className="capsule-test-arguments agent-settings-field--wide">
        {draft.args.map((argument, index) => <div className="capsule-test-argument" key={index}>
          <label className="agent-settings-field"><span>{ru ? 'Аргумент' : 'Argument'} {index + 1}</span><textarea rows={1} value={argument} maxLength={4096} onChange={event => set({ args: draft.args.map((value, at) => at === index ? event.target.value : value) })} /></label>
          <button className="agent-settings-button" type="button" aria-label={`${ru ? 'Удалить аргумент' : 'Remove argument'} ${index + 1}`} onClick={() => set({ args: draft.args.filter((_, at) => at !== index) })}>{ru ? 'Удалить' : 'Remove'}</button>
        </div>)}
        <button className="agent-settings-button" type="button" disabled={draft.args.length >= 64} onClick={() => set({ args: [...draft.args, ''] })}>{ru ? 'Добавить аргумент' : 'Add argument'}</button>
      </div>
      <label className="agent-settings-field"><span>{ru ? 'Таймаут, секунды' : 'Timeout, seconds'}</span><input type="number" min={1} max={120} value={draft.timeoutMs / 1000} onChange={event => set({ timeoutMs: Number(event.target.value) * 1000 })} /></label>
      <label className="agent-settings-field"><span>{ru ? 'Лимит журнала, КиБ' : 'Log limit, KiB'}</span><input type="number" min={1} max={1024} value={draft.outputBytes / 1024} onChange={event => set({ outputBytes: Number(event.target.value) * 1024 })} /></label>
      <p className="agent-settings-hint agent-settings-field--wide">{ru ? 'Аргументы передаются буквально, без обработки оболочкой. Команда и зависимости должны уже находиться в образе. Рабочая папка — /workspace с выбранными файлами.' : 'Arguments are passed literally, without shell expansion. The executable and dependencies must already exist in the image. The working directory is /workspace with the selected files.'}</p>
      <button className="agent-settings-button agent-settings-button--primary" type="button" onClick={() => void save([...profiles.filter(profile => profile.id !== draft.id), draft])}>{ru ? 'Сохранить команду' : 'Save command'}</button>
      <button className="agent-settings-button" type="button" onClick={() => setDraft(null)}>{ru ? 'Отмена' : 'Cancel'}</button>
    </fieldset>}
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
  </div>;
}
