import { useEffect, useMemo, useRef, useState } from "react";
import type { LocaleId, ProviderSecretId, SessionSnapshot } from "../../../../shared/contracts";
import type { SecretGrant, SecretGrantDuration, SecretGrantRequest } from "../../../../shared/backlog";
import { backlogApi } from "./backlogRendererApi";
import { useVisibleRefresh } from "./visibleRefresh";

interface SecretGrantsPanelProps {
  sessionId: string;
  sessions: readonly SessionSnapshot[];
  locale: LocaleId;
  onError(message: string): void;
}

interface PanelScope {
  generation: number;
  active: boolean;
  refresh: Promise<void> | null;
  action: symbol | null;
}
interface PanelState {
  generation: number;
  requests: SecretGrantRequest[];
  grants: SecretGrant[];
  loading: boolean;
  busyId: string;
  error: string;
}
const EMPTY_PANEL: PanelState = { generation: 0, requests: [], grants: [], loading: false, busyId: "", error: "" };

export function SecretGrantsPanel(props: SecretGrantsPanelProps): React.JSX.Element {
  return <SecretGrantsPanelContent key={props.sessionId} {...props} />;
}

function SecretGrantsPanelContent({ sessionId, sessions, locale, onError }: SecretGrantsPanelProps): React.JSX.Element {
  const api = useMemo(() => backlogApi(), []);
  const [state, setState] = useState<PanelState>(EMPTY_PANEL);
  const { current: scope } = useRef<PanelScope>({ generation: 0, active: false, refresh: null, action: null });
  const errorHandler = useRef(onError);
  useEffect(() => { errorHandler.current = onError; }, [onError]);
  // The keyed parent remounts on task changes; effect generations also reject StrictMode's obsolete work.
  const { requests, grants, loading, busyId, error } = state.generation === scope.generation ? state : EMPTY_PANEL;
  const current = (generation: number): boolean => scope.active && scope.generation === generation;
  const update = (generation: number, patch: Partial<PanelState>): void => {
    if (!current(generation)) return;
    setState(previous => current(generation)
      ? { ...(previous.generation === generation ? previous : EMPTY_PANEL), ...patch, generation }
      : previous);
  };
  const text = locale === "ru" ? {
    title: "Доступ к ключам провайдеров", note: "Ключи используются только для изолированных запросов к API выбранного профиля. Они не показываются и не вставляются в сообщения.",
    pending: "Ожидают решения", grants: "Разрешения", noRequests: "Запросов на доступ нет.", noGrants: "Активных разрешений нет.",
    reason: "Причина", session: "Карточка", approve10m: "10 минут", approveTurn: "До конца хода", turnUnavailable: "Этот запуск не отслеживает завершение текущего хода или ход уже сменился.", approveSession: "До закрытия карточки",
    deny: "Отклонить", revoke: "Отозвать", approved: "Доступ разрешён", expires: "Истекает", turn: "до конца хода", sessionGrant: "до закрытия карточки",
    expired: "истёк", loading: "Загрузка…", refresh: "Обновить"
  } : {
    title: "Provider secret access", note: "Keys are used only for isolated API requests to a selected profile. Values are never shown or pasted into messages.",
    pending: "Pending requests", grants: "Active grants", noRequests: "No access requests.", noGrants: "No active grants.",
    reason: "Reason", session: "Card", approve10m: "10 minutes", approveTurn: "Until this turn ends", turnUnavailable: "This launch cannot track the current turn ending, or the turn has changed.", approveSession: "Until card closes",
    deny: "Deny", revoke: "Revoke", approved: "Access approved", expires: "Expires", turn: "until turn ends", sessionGrant: "until card closes",
    expired: "expired", loading: "Loading…", refresh: "Refresh"
  };

  const refresh = (generation: number): Promise<void> => {
    if (!current(generation)) return Promise.resolve();
    if (scope.refresh) return scope.refresh;
    const pending = Promise.all([api.secretRequests(sessionId), api.secretGrants(sessionId)])
      .then(([nextRequests, nextGrants]) => { update(generation, { requests: nextRequests, grants: nextGrants }); })
      .finally(() => { if (scope.refresh === pending) scope.refresh = null; });
    scope.refresh = pending;
    return pending;
  };

  const refreshSafely = async (): Promise<void> => {
    const generation = scope.generation;
    if (!current(generation) || document.hidden || scope.refresh) return;
    update(generation, { loading: true });
    try {
      await refresh(generation);
      update(generation, { error: "" });
    } catch (reason) {
      if (!current(generation)) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      update(generation, { error: message });
      errorHandler.current(message);
    } finally {
      update(generation, { loading: false });
    }
  };

  useEffect(() => {
    scope.active = true;
    scope.generation += 1;
    scope.refresh = null;
    scope.action = null;
    update(scope.generation, EMPTY_PANEL);
    void refreshSafely();
    return () => { scope.active = false; scope.generation += 1; scope.refresh = null; };
  }, [scope]);
  useVisibleRefresh(() => { void refreshSafely(); }, 5_000);

  const runGrantChange = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    const generation = scope.generation;
    if (!current(generation)) return;
    const actionToken = Symbol();
    scope.action = actionToken;
    update(generation, { busyId: key, error: "" });
    try {
      await action();
      if (current(generation)) await refresh(generation);
    } catch (reason) {
      if (!current(generation)) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      update(generation, { error: message }); errorHandler.current(message);
    } finally {
      if (current(generation) && scope.action === actionToken) {
        scope.action = null;
        update(generation, { busyId: "" });
      }
    }
  };

  const decide = (request: SecretGrantRequest, duration: SecretGrantDuration | null): Promise<void> =>
    runGrantChange(request.id, () => duration
      ? api.approveSecretRequest(sessionId, request.id, duration)
      : api.denySecretRequest(sessionId, request.id));

  const revoke = (grant: SecretGrant): Promise<void> => runGrantChange(`${grant.sessionId}:${grant.secretId}`,
    () => api.revokeSecretGrant(sessionId, grant.sessionId, grant.secretId as ProviderSecretId));

  const memberTitle = (id: string): string => sessions.find((candidate) => candidate.id === id)?.title ?? id;
  const durationText = (grant: SecretGrant): string => grant.duration === "10m" ? `${text.expires} ${new Date(grant.expiresAt ?? 0).toLocaleTimeString(locale)}`
    : grant.duration === "turn" ? text.turn : text.sessionGrant;

  return <section className="backlog-secret-grants">
    <header><h3>{text.title}</h3><button type="button" disabled={loading} onClick={() => void refreshSafely()}>{text.refresh}</button></header>
    <p className="backlog-secret-grants__note">{text.note}</p>
    {error && <p className="backlog-inspector__error" role="alert">{error}</p>}
    {loading && requests.length === 0 && grants.length === 0 && <p role="status">{text.loading}</p>}
    <section><h4>{text.pending}</h4>
      {requests.length === 0 ? <p className="backlog-inspector__empty">{text.noRequests}</p> : <ol className="backlog-secret-grants__list">
        {requests.map((request) => <li key={request.id}>
          <div className="backlog-secret-grants__request"><strong>{request.secretId}</strong><small>{text.session}: {memberTitle(request.sessionId)}</small>
            <p>{text.reason}: {request.reason}</p><time>{new Date(request.createdAt).toLocaleString(locale)}</time></div>
          <div className="backlog-secret-grants__actions">
            <button type="button" disabled={busyId === request.id} onClick={() => void decide(request, "10m")}>{text.approve10m}</button>
            <button type="button" disabled={busyId === request.id || !request.turnAvailable} title={request.turnAvailable ? undefined : text.turnUnavailable} onClick={() => void decide(request, "turn")}>{text.approveTurn}</button>
            <button type="button" disabled={busyId === request.id} onClick={() => void decide(request, "session")}>{text.approveSession}</button>
            <button type="button" disabled={busyId === request.id} onClick={() => void decide(request, null)}>{text.deny}</button>
          </div>
        </li>)}
      </ol>}
    </section>
    <section><h4>{text.grants}</h4>
      {grants.length === 0 ? <p className="backlog-inspector__empty">{text.noGrants}</p> : <ul className="backlog-secret-grants__list">
        {grants.map((grant) => {
          const key = `${grant.sessionId}:${grant.secretId}`;
          return <li key={key}>
            <div><strong>{grant.secretId}</strong><small>{text.session}: {memberTitle(grant.sessionId)} · {durationText(grant)}</small>
              <time>{text.approved}: {new Date(grant.approvedAt).toLocaleString(locale)}</time></div>
            <button type="button" disabled={busyId === key} onClick={() => void revoke(grant)}>{text.revoke}</button>
          </li>;
        })}
      </ul>}
    </section>
  </section>;
}
