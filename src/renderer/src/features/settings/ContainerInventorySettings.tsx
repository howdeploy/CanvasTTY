import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ContainerInventorySnapshot } from '../../../../shared/contracts';

export function ContainerInventorySettings({ settings, active }: { settings: AppSettings; active: boolean }): React.JSX.Element {
  const text = (en: string, ru: string): string => settings.locale === 'ru' ? ru : en;
  const [snapshots, setSnapshots] = useState<ContainerInventorySnapshot[] | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [host, setHost] = useState('all'), [query, setQuery] = useState('');
  const request = useRef(0);
  const signature = JSON.stringify([settings.containerProfiles, settings.remoteHosts]);
  useEffect(() => { request.current++; setBusy(false); setError(false); setSnapshots(null); return () => { request.current++; }; }, [active, signature]);
  const refresh = async (): Promise<void> => {
    if (!active) return;
    const token = ++request.current; setBusy(true); setError(false);
    try { const result = await window.canvasTTY.containers.inventory(undefined, true); if (token === request.current) setSnapshots(result); }
    catch { if (token === request.current) { setSnapshots(null); setError(true); } }
    finally { if (token === request.current) setBusy(false); }
  };
  const hostLabel = (id: string): string => id === 'local' ? text('This computer', 'Этот компьютер') : settings.remoteHosts.find(item => item.id === id)?.label ?? text('Missing server', 'Сервер не найден');
  const hosts = [...new Set(settings.containerProfiles.map(profile => profile.hostId))];
  const selectedHost = host === 'all' || hosts.includes(host) ? host : 'all';
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return <section className="container-inventory" aria-label={text('Docker and Podman overview', 'Обзор Docker и Podman')} aria-busy={busy}>
    <div className="container-inventory__heading"><h3>{text('Docker & Podman', 'Docker и Podman')}</h3><button className="agent-settings-button agent-settings-button--primary" type="button" disabled={busy || !active || !hosts.length} onClick={() => void refresh()}>{busy ? text('Checking…', 'Проверка…') : text('Refresh status', 'Обновить состояние')}</button></div>
    <p className="agent-settings-hint">{text('Containers on this computer and your saved servers. Refresh to read current state; no background polling.', 'Контейнеры на этом компьютере и сохранённых серверах. Состояние обновляется по кнопке.')}</p>
    {hosts.length > 0 && <div className="agent-settings-grid">
      <label className="agent-settings-field"><span>{text('Computer', 'Компьютер')}</span><select value={selectedHost} onChange={event => setHost(event.target.value)}><option value="all">{text('All computers', 'Все компьютеры')}</option>{hosts.map(id => <option key={id} value={id}>{hostLabel(id)}</option>)}</select></label>
      <label className="agent-settings-field"><span>{text('Find a container', 'Найти контейнер')}</span><input type="search" value={query} maxLength={256} onChange={event => setQuery(event.target.value)} placeholder={text('Name, image or ID', 'Название, образ или ID')} /></label>
    </div>}
    <div role="status">{error ? <p className="agent-settings-notice">{text('Status could not be refreshed. Check your saved connections and retry.', 'Не удалось обновить состояние. Проверьте сохранённые подключения и повторите попытку.')}</p> : snapshots === null && <p className="agent-settings-hint">{hosts.length ? text('Refresh to check saved engines.', 'Обновите состояние для проверки движков.') : text('Add a container profile below to connect an engine.', 'Добавьте профиль контейнера ниже, чтобы подключить движок.')}</p>}</div>
    {snapshots?.filter(snapshot => selectedHost === 'all' || snapshot.hostId === selectedHost).map(snapshot => {
      const rows = snapshot.containers.filter(row => !normalizedQuery || [row.name, row.image, row.id, row.state, row.status].some(value => value.toLocaleLowerCase().includes(normalizedQuery)));
      return <article className="container-inventory__engine" key={snapshot.profiles.map(profile => profile.profileId).join(',')}>
        <div className="container-inventory__heading"><strong>{hostLabel(snapshot.hostId)} · {snapshot.runtime === 'docker' ? 'Docker' : 'Podman'}</strong><span className="container-inventory__badge">{snapshot.available ? text('Available', 'Доступен') : text('Unavailable', 'Недоступен')}</span></div>
        {snapshot.available && <p className="agent-settings-hint">{snapshot.engineName} · {snapshot.rootless ? 'Rootless' : text('System engine', 'Системный движок')} · {text('Checked', 'Проверено')} {new Date(snapshot.checkedAt).toLocaleTimeString(settings.locale)}</p>}
        {!snapshot.available && <p className="agent-settings-notice">{snapshot.reasonCode === 'configuration-changed' ? text('The connection changed during the check. Refresh again.', 'Подключение изменилось во время проверки. Обновите состояние заново.') : text('The configured engine could not be read. Check its endpoint and server connection.', 'Не удалось прочитать состояние движка. Проверьте его endpoint и подключение к серверу.')}</p>}
        <ul className="container-inventory__profiles">{snapshot.profiles.map(profile => <li key={profile.profileId}><span>{settings.containerProfiles.find(item => item.id === profile.profileId)?.label ?? profile.profileId}</span><span>{profile.imageAvailable ? text('Image available', 'Образ доступен') : text('Image not verified', 'Образ не проверен')}</span></li>)}</ul>
        {snapshot.available && <>
          <ul className="container-inventory__rows">{rows.map(row => <li key={row.id}>
            <div className="container-inventory__heading"><strong>{row.name || row.id.slice(0, 12)}</strong><span className="container-inventory__badge">{row.state || text('Unknown', 'Неизвестно')}</span></div>
            <span className="container-inventory__image">{row.image}</span><span>{row.status}</span>
            <div className="container-inventory__heading"><code title={row.id}>{row.id.slice(0, 12)}</code><span className="agent-settings-hint">{row.managed ? text('CanvasTTY record', 'Запись CanvasTTY') : text('Read only', 'Только просмотр')}</span></div>
          </li>)}</ul>
          {!rows.length && <p className="agent-settings-hint">{snapshot.containers.length ? text('No containers match this search.', 'Нет контейнеров по этому запросу.') : text('No containers found.', 'Контейнеры не найдены.')}</p>}
          {snapshot.truncated && <p className="agent-settings-hint">{text('Showing the 64 most recent containers. Other containers are outside this overview.', 'Показаны 64 последних контейнера. Остальные не включены в обзор.')}</p>}
        </>}
      </article>;
    })}
  </section>;
}
