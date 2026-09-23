import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentLaunchOptions, AppSettings } from '../../../../shared/contracts';
import type { ContainerPlacementExclusionCode, ContainerPlacementPreview } from '../../../../shared/containerPlacement';

const reasons: Record<ContainerPlacementExclusionCode, [string, string]> = {
  'profile-invalid': ['Профиль недоступен', 'Profile unavailable'], 'provider-command': ['В образе нет команды агента', 'No agent command in image'],
  'network-disabled': ['Профиль без доступа к API', 'Profile has no API network access'], 'host-invalid': ['Компьютер не настроен', 'Computer not configured'],
  'host-policy': ['Ограничения компьютера', 'Computer policy'], 'workspace-unmapped': ['Папка проекта не сопоставлена', 'Project folder is not mapped'],
  'account-unavailable': ['Нет подходящего API аккаунта', 'No compatible API account'], 'account-binding': ['Привязка аккаунта недоступна', 'Account binding unavailable'],
  'account-policy': ['Ограничения аккаунта или модели', 'Account or model policy'], 'credential-reference': ['Не настроен ключ на этом компьютере', 'Credential reference missing on this computer'],
  'launch-policy': ['Ограничения данных или запуска', 'Data or launch policy'], capacity: ['Достигнут лимит сессий', 'Session limit reached'],
  'configuration-changed': ['Настройки изменились', 'Configuration changed'], unavailable: ['Движок недоступен', 'Engine unavailable'],
  'image-unavailable': ['Образ недоступен', 'Image unavailable'], 'metrics-unavailable': ['Нагрузка неизвестна', 'Load is unknown'], resources: ['Недостаточно ресурсов', 'Insufficient resources']
};

/** On-demand only. An answer belongs to exactly one current draft/settings view. */
export function ContainerRoutePreview({ request, settings, active, disabled }: {
  request: AgentLaunchOptions | null; settings: AppSettings; active: boolean; disabled: boolean;
}): React.JSX.Element {
  const requestKey = JSON.stringify(request);
  const identity = useMemo(() => ({ request, active }), [requestKey, settings, active]);
  const current = useRef<typeof identity | null>(identity); current.current = identity;
  const [answer, setAnswer] = useState<{ identity: typeof identity; busy?: boolean; value?: ContainerPlacementPreview; error?: string } | null>(null);
  useEffect(() => { current.current = identity; return () => { if (current.current === identity) current.current = null; }; }, [identity]);
  const shown = answer?.identity === identity ? answer : null;
  const ru = settings.locale === 'ru', result = shown?.value;
  const host = (id: string): string => id === 'local' ? (ru ? 'Этот компьютер' : 'This computer') : settings.remoteHosts.find(h => h.id === id)?.label ?? id;
  const profile = (id: string): string => settings.containerProfiles.find(p => p.id === id)?.label ?? id;
  const account = (id?: string): string => settings.providerAccounts.find(a => a.id === id)?.label ?? id ?? '—';
  const preview = async (): Promise<void> => {
    if (!identity.request || !identity.active || disabled || shown?.busy) return;
    setAnswer({ identity, busy: true });
    try {
      const value = await window.canvasTTY.terminal.previewContainerPlacement({ ...identity.request, position: { x: 0, y: 0 } });
      if (current.current === identity) setAnswer({ identity, value });
    } catch (error) {
      if (current.current === identity) setAnswer({ identity, error: error instanceof Error ? error.message : (ru ? 'Не удалось проверить маршрут.' : 'Could not check the route.') });
    }
  };
  return <div className="container-route-preview">
    <p>{ru ? 'Будет выбран существующий образ и аккаунт на его компьютере. Агент получит полный Git worktree. Перед запуском выбор проверяется заново; предпросмотр не резервирует ресурсы.' : 'An existing image and an account on its computer will be selected. The agent receives a full Git worktree. Selection is checked again at launch; preview does not reserve resources.'}</p>
    <button type="button" className="agent-settings-button" disabled={disabled || !request || !active || shown?.busy} onClick={() => void preview()}>{shown?.busy ? (ru ? 'Проверяем…' : 'Checking…') : (ru ? 'Проверить маршрут' : 'Check route')}</button>
    {result?.kind === 'selected' && <div role="status" className="container-route-preview__selected"><strong>{profile(result.profileId)}</strong><span>{host(result.hostId)} · {account(result.accountId)}</span><span>{result.dataClass}{result.model ? ` · ${result.model}` : ''}</span></div>}
    {result?.kind === 'none' && <p role="status">{result.reason === 'too-many-candidates' ? (ru ? 'Слишком много вариантов. Выберите конкретный аккаунт.' : 'Too many candidates. Select a specific account.') : (ru ? 'Подходящего маршрута сейчас нет. Проверьте причины и настройки контейнеров.' : 'No eligible route is available. Check the reasons and container settings.')}</p>}
    {result && result.exclusions.length > 0 && <details><summary>{ru ? 'Причины исключения' : 'Exclusion reasons'} · {result.exclusions.length}{result.exclusionsTruncated ? '+' : ''}</summary><ul>{result.exclusions.map((entry, index) => <li key={index}>{[entry.profileId && profile(entry.profileId), entry.hostId && host(entry.hostId), entry.accountId && account(entry.accountId)].filter(Boolean).join(' · ')} — {reasons[entry.code][ru ? 0 : 1]}</li>)}</ul></details>}
    {shown?.error && <p className="agent-settings-error" role="alert">{shown.error}</p>}
  </div>;
}
