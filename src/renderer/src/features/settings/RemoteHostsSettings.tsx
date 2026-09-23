import { useEffect, useRef, useState } from "react";
import type { AgentProviderId, AppSettings, DataClass, LocalOperationalMetrics, RemoteHost, SavedHostDiagnosticSnapshot, ServerPreparationJob, SessionSnapshot } from "../../../../shared/contracts";
import { DATA_CLASSES, remoteHostInvalidReason } from "../../../../shared/contracts";
import { hostDependents } from "../../../../shared/executionSettings";
import { validatedConnectionsPatch } from "../../../../shared/connectionsSettings";
import { t, type TranslationKey } from "../../lib/i18n";
import { AGENT_PROVIDERS, PROVIDERS } from "../../lib/providers";
import { draftHost, hostDraft, HOST_NUMERIC_FIELDS, type HostDraft } from "./hostSettingsDraft";

type Props = { settings: AppSettings; active: boolean; sessions: SessionSnapshot[]; recordId?: string; selectionRequest?: unknown; onPersist(patch: Partial<AppSettings>): Promise<void> };
export function RemoteHostsSettings({ settings, active, sessions, recordId, selectionRequest, onPersist }: Props): React.JSX.Element {
  const locale = settings.locale;
  const [selectedId, setSelectedId] = useState("local"), [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, HostDraft>>({}), [newId, setNewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [checking, setChecking] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [diagnostics, setDiagnostics] = useState<Record<string, { identity: string; snapshot: SavedHostDiagnosticSnapshot }>>({});
  const [localMetrics, setLocalMetrics] = useState<LocalOperationalMetrics | null>(null);
  const [preparation, setPreparation] = useState<Record<string, ServerPreparationJob>>({});
  const preparing = Object.values(preparation).filter(job => !job.finishedAt).map(job => job.jobId);
  const preparingKey = preparing.join(",");
  useEffect(() => {
    if (!active || !preparingKey) return;
    const timer = window.setInterval(() => {
      void window.canvasTTY.hosts.prepareStatus(preparingKey.split(",")).then(jobs => setPreparation(old => ({ ...old, ...Object.fromEntries(jobs.map(job => [job.hostId, job])) }))).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [active, preparingKey]);
  const prepare = async (hostIds: string[]): Promise<void> => {
    const jobIds = await window.canvasTTY.hosts.prepare(hostIds);
    const jobs = await window.canvasTTY.hosts.prepareStatus(jobIds);
    setPreparation(old => ({ ...old, ...Object.fromEntries(jobs.map(job => [job.hostId, job])) }));
  };
  const skipKey = { "api-blocked": "hostPrepareSkip_apiBlocked", "api-unknown": "hostPrepareSkip_apiUnknown", "host-rule": "hostPrepareSkip_hostRule", "not-installable": "hostPrepareSkip_notInstallable" } as const;
  const preparationView = (job: ServerPreparationJob): React.JSX.Element => <div className="host-preparation" role="status">
    <p><strong>{t(locale, `hostPreparePhase_${job.phase}` as TranslationKey)}</strong>{!job.finishedAt && " …"}</p>
    {job.installed.length > 0 && <p>{t(locale, "hostPrepareInstalled")}: {job.installed.map(provider => PROVIDERS[provider].label).join(", ")}</p>}
    {job.skipped.length > 0 && <p>{t(locale, "hostPrepareSkipped")}: {job.skipped.map(item => `${PROVIDERS[item.provider].label} (${t(locale, skipKey[item.reason])})`).join(", ")}</p>}
    {job.error && <p className="agent-settings-error">{job.error}</p>}
    {job.log.length > 0 && <pre className="host-preparation__log">{job.log.slice(-4).join("\n")}</pre>}
  </div>;
  const heading = useRef<HTMLHeadingElement>(null), generation = useRef(0);
  useEffect(() => { if (recordId) { setSelectedId(recordId); setQuery(""); } }, [recordId, selectionRequest]);
  const saved = settings.remoteHosts.find(host => host.id === selectedId);
  const selected = saved ?? drafts[selectedId]?.value;
  const draft = drafts[selectedId] ?? (selected ? hostDraft(selected) : undefined);
  const candidate = draft ? draftHost(draft) : undefined;
  const savedIdentity = JSON.stringify(saved);
  const draftIdentity = JSON.stringify(candidate);
  const dirty = !!draft && (!draft.origin || JSON.stringify(candidate) !== draft.origin);
  const conflict = !!draft?.origin && draft.origin !== savedIdentity;
  const current = useRef({ active, selectedId, savedIdentity, draftIdentity }); current.current = { active, selectedId, savedIdentity, draftIdentity };
  useEffect(() => { generation.current++; setChecking(false); }, [active, selectedId, savedIdentity, draftIdentity]);
  const catalog = newId && drafts[newId] ? [...settings.remoteHosts, drafts[newId]!.value] : settings.remoteHosts;
  const filtered = catalog.filter(host => `${host.label} ${host.sshHost}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const update = (patch: Partial<RemoteHost>): void => { if (draft) { setDrafts(old => ({ ...old, [selectedId]: { ...draft, value: { ...draft.value, ...patch } } })); setError(""); setNotice(""); } };
  const clear = (id: string): void => setDrafts(old => { const next = { ...old }; delete next[id]; return next; });
  const select = (id: string): void => { setSelectedId(id); setError(""); setNotice(""); requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: "nearest" }); }); };
  const add = (): void => { if (newId) { select(newId); return; } const id = `host-${crypto.randomUUID()}`; const value = { id, label: t(locale, "hostNew"), sshHost: "" }; setDrafts(old => ({ ...old, [id]: hostDraft(value, true) })); setNewId(id); setQuery(""); select(id); };
  const run = async (work: () => Promise<void>): Promise<void> => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (cause) { setError(`${t(locale, "connectionFailed")} ${cause instanceof Error ? cause.message : ""}`); } finally { setBusy(false); } };
  const save = async (): Promise<void> => { if (!candidate || conflict) return; const patch = { remoteHosts: saved ? settings.remoteHosts.map(host => host.id === candidate.id ? candidate : host) : [...settings.remoteHosts, candidate] }; validatedConnectionsPatch(settings, patch); await onPersist(patch); clear(candidate.id); if (candidate.id === newId) setNewId(null); setNotice(t(locale, "hostSaved")); };
  const dependencies = [...hostDependents(settings, selectedId), ...sessions.filter(session => session.hostId === selectedId && session.exitCode === null).map(session => session.title)];
  const remove = async (): Promise<void> => { if (selectedId !== newId) await onPersist({ remoteHosts: settings.remoteHosts.filter(host => host.id !== selectedId) }); clear(selectedId); if (selectedId === newId) setNewId(null); select("local"); };
  const inspect = async (): Promise<void> => {
    const token = ++generation.current, id = selectedId, identity = savedIdentity, inputIdentity = draftIdentity;
    const accepts = (): boolean => generation.current === token && current.current.active && current.current.selectedId === id && current.current.savedIdentity === identity && current.current.draftIdentity === inputIdentity;
    setChecking(true); setError("");
    try {
      if (id === "local") { const result = await window.canvasTTY.operationalMetrics.local(); if (accepts()) setLocalMetrics(result); }
      else { const result = await window.canvasTTY.hosts.inspect(id); if (accepts()) setDiagnostics(old => ({ ...old, [id]: { identity, snapshot: result } })); }
    } catch (cause) { if (accepts()) setError(cause instanceof Error ? cause.message : t(locale, "hostUnknown")); }
    finally { if (accepts()) setChecking(false); }
  };
  const numberLabels: Record<typeof HOST_NUMERIC_FIELDS[number], TranslationKey> = { sshPort: "hostPort", priority: "hostPriority", maxSessions: "hostSessions", minFreeMemoryMb: "hostMemory", maxLoadPerCore: "hostLoad" };
  const invalid = candidate ? remoteHostInvalidReason(candidate) : null;
  const diagnostic = diagnostics[selectedId], snapshot = diagnostic?.snapshot;
  const metric = (value: number | null | undefined): string => value == null ? t(locale, "hostUnknown") : String(value);
  const observed = (at: number): string => `${t(locale, "hostMeasured")}: ${new Date(at).toLocaleString(locale)}`;
  return <section className="api-profiles remote-hosts"><div className="agent-settings-heading"><h3>{t(locale, "hosts")}</h3><div className="agent-settings-actions"><button className="agent-settings-button" type="button" disabled={busy || settings.remoteHosts.length === 0 || settings.remoteHosts.every(host => preparation[host.id] && !preparation[host.id]!.finishedAt)} onClick={() => void run(() => prepare(settings.remoteHosts.map(host => host.id)))}>{t(locale, "hostPrepareAll")}</button><button className="agent-settings-button" type="button" disabled={busy} onClick={add}>{t(locale, "hostAdd")}</button></div></div>
    <div className="api-profiles__workspace"><div className="api-profiles__catalog"><label className="agent-settings-field"><span>{t(locale, "hostSearch")}</span><input value={query} onChange={event => setQuery(event.target.value)} /></label><p className="agent-settings-hint">{filtered.length} / {catalog.length}</p><div className="api-profiles__list">
      <button type="button" className={`api-profiles__item${selectedId === "local" ? " api-profiles__item--active" : ""}`} onClick={() => select("local")}><strong>{t(locale, "accountLocalHost")}</strong></button>
      {filtered.map(host => <button key={host.id} type="button" className={`api-profiles__item${selectedId === host.id ? " api-profiles__item--active" : ""}`} onClick={() => select(host.id)}><strong>{host.label}</strong><small>{host.sshHost}</small>{drafts[host.id] && <small>{t(locale, "connectionUnsaved")}</small>}{preparation[host.id] && <small>{t(locale, `hostPreparePhase_${preparation[host.id]!.phase}` as TranslationKey)}</small>}</button>)}</div></div>
    <div className="api-profiles__editor"><h3 ref={heading} tabIndex={-1}>{selectedId === "local" ? t(locale, "accountLocalHost") : selected?.label ?? t(locale, "accountMissingHost")}</h3>
    {selectedId === "local" ? <p className="agent-settings-hint">{t(locale, "hostLocalNote")}</p> : draft && candidate && <>
      {!filtered.some(host => host.id === selectedId) && <p className="agent-settings-hint">{t(locale, "connectionHiddenSelection")} <button className="agent-settings-button" type="button" onClick={() => setQuery("")}>{t(locale, "connectionResetSearch")}</button></p>}
      {conflict && <p role="alert" className="agent-settings-error">{t(locale, "connectionConflict")} <button className="agent-settings-button" type="button" onClick={() => clear(selectedId)}>{t(locale, "connectionReload")}</button></p>}
      <fieldset className="execution-fields" disabled={busy}><div className="agent-settings-grid">
      <label className="agent-settings-field"><span>{t(locale, "accountName")}</span><input value={candidate.label} maxLength={80} aria-invalid={!candidate.label.trim()} aria-describedby="host-form-error" onChange={event => update({ label: event.target.value })} /></label>
      <label className="agent-settings-field"><span>{t(locale, "hostAddress")}</span><input value={candidate.sshHost} maxLength={253} aria-invalid={!!remoteHostInvalidReason({ ...candidate, sshUser: undefined, workspaces: undefined, providerAccess: undefined })} aria-describedby="host-form-error" onChange={event => update({ sshHost: event.target.value })} /></label>
      <label className="agent-settings-field"><span>{t(locale, "accountClassCap")}</span><select value={candidate.maxDataClass ?? "D3"} onChange={event => update({ maxDataClass: event.target.value as DataClass })}>{DATA_CLASSES.map(c => <option key={c} value={c}>{t(locale, `dataClass${c}`)}</option>)}</select></label>
      <label className="agent-settings-field"><span>{t(locale, "hostProviders")}</span><select value={candidate.providerAccess?.mode ?? "all"} onChange={event => update({ providerAccess: event.target.value === "all" ? undefined : { mode: event.target.value as "allowlist" | "blocklist", providers: candidate.providerAccess?.providers ?? [] } })}><option value="all">{t(locale, "hostAllProviders")}</option><option value="allowlist">{t(locale, "hostAllowlist")}</option><option value="blocklist">{t(locale, "hostBlocklist")}</option></select></label>
      </div>{candidate.providerAccess && <div className="host-provider-grid">{AGENT_PROVIDERS.map(provider => <label key={provider} className="agent-settings-check"><input type="checkbox" checked={candidate.providerAccess!.providers.includes(provider)} onChange={event => update({ providerAccess: { ...candidate.providerAccess!, providers: event.target.checked ? [...candidate.providerAccess!.providers, provider as AgentProviderId] : candidate.providerAccess!.providers.filter(p => p !== provider) } })} /><span>{PROVIDERS[provider].label}</span></label>)}</div>}
      <details className="connection-assessment"><summary>{t(locale, "hostAdvanced")}</summary><div className="agent-settings-grid"><label className="agent-settings-field"><span>{t(locale, "hostUser")}</span><input value={candidate.sshUser ?? ""} maxLength={64} onChange={event => update({ sshUser: event.target.value })} /></label>{HOST_NUMERIC_FIELDS.map(key => <label className="agent-settings-field" key={key}><span>{t(locale, numberLabels[key])}</span><input type="number" value={draft.numbers[key]} min={key === "sshPort" || key === "maxSessions" ? 1 : 0} step={key === "maxLoadPerCore" ? "any" : 1} onChange={event => { setDrafts(old => ({ ...old, [selectedId]: { ...draft, numbers: { ...draft.numbers, [key]: event.target.value } } })); setError(""); setNotice(""); }} /></label>)}</div></details>
      <h4>{t(locale, "hostPaths")}</h4><p className="agent-settings-hint">{t(locale, "hostNoSync")}</p><div className="execution-policy-rows">{(candidate.workspaces ?? []).map((mapping, index) => <div key={index} className="execution-policy-row">{(["localPath", "remotePath"] as const).map(key => <label className="agent-settings-field" key={key}><span>{t(locale, key === "localPath" ? "hostLocalPath" : "hostRemotePath")}</span><input value={mapping[key]} maxLength={4096} onChange={event => update({ workspaces: candidate.workspaces!.map((row, i) => i === index ? { ...row, [key]: event.target.value } : row) })} /></label>)}<button className="agent-settings-button" type="button" onClick={() => update({ workspaces: candidate.workspaces!.filter((_, i) => i !== index) })}>{t(locale, "connectionRemove")}</button></div>)}</div>
      <button className="agent-settings-button" type="button" disabled={(candidate.workspaces?.length ?? 0) >= 8} onClick={() => update({ workspaces: [...candidate.workspaces ?? [], { localPath: "", remotePath: "" }] })}>{t(locale, "hostMappingAdd")}</button></fieldset>
      {dependencies.length > 0 && <p className="agent-settings-hint">{t(locale, "hostDependencies")} {dependencies.join(", ")}. {t(locale, "hostRemoveBlocked")}</p>}
      <p id="host-form-error" className="agent-settings-error" role={invalid ? "alert" : undefined}>{invalid}</p>
      <div className="agent-settings-actions"><button type="button" className="agent-settings-button agent-settings-button--danger" disabled={busy || dependencies.length > 0} onClick={() => void run(remove)}>{t(locale, "connectionRemove")}</button><button type="button" className="agent-settings-button" disabled={busy || !dirty} onClick={() => draft.origin ? clear(selectedId) : void run(remove)}>{t(locale, "connectionDiscard")}</button><button type="button" className="agent-settings-button agent-settings-button--primary" disabled={busy || !dirty || conflict} onClick={() => void run(save)}>{t(locale, "save")}</button></div>
    </>}
    {selectedId !== "local" && saved && <div className="connection-assessment"><h4>{t(locale, "hostPrepare")}</h4><p className="agent-settings-hint">{t(locale, "hostPrepareNote")}</p>
      <button type="button" className="agent-settings-button" disabled={busy || dirty || (!!preparation[selectedId] && !preparation[selectedId]!.finishedAt)} onClick={() => void run(() => prepare([selectedId]))}>{t(locale, "hostPrepare")}</button>
      {preparation[selectedId] && preparationView(preparation[selectedId]!)}</div>}
    <div className="connection-assessment"><h4>{t(locale, "hostDiagnostics")}</h4>{dirty && <p className="agent-settings-hint">{t(locale, "hostSaveBeforeProbe")}</p>}<button type="button" className="agent-settings-button" disabled={checking || !active || selectedId !== "local" && (!saved || dirty)} onClick={() => void inspect()}>{t(locale, checking ? "hostChecking" : selectedId === "local" ? "hostLocalInspect" : "hostInspect")}</button>
    {selectedId === "local" ? localMetrics ? <dl className="host-metrics"><dt>{t(locale, "hostMeasured")}</dt><dd>{new Date(localMetrics.collectedAt).toLocaleString(locale)}</dd><dt>{t(locale, "hostSessionsMetric")}</dt><dd>{localMetrics.activeSessions}</dd><dt>{t(locale, "hostLoadMetric")}</dt><dd>{metric(localMetrics.load1)}</dd><dt>{t(locale, "hostMemoryMetric")}</dt><dd>{metric(localMetrics.memoryAvailableMb)}</dd><dt>CanvasTTY CPU % / RAM MiB</dt><dd>{metric(localMetrics.cpuPercent)} / {metric(localMetrics.memoryWorkingSetMb)}</dd></dl> : <p>{t(locale, "hostNotChecked")}</p> : <><p className="agent-settings-hint">{t(locale, "hostProbeNote")}</p>{snapshot ? diagnostic?.identity !== savedIdentity || dirty ? <p role="status">{t(locale, "hostStale")}</p> : <>
      <p>{t(locale, snapshot.discovery.reachable ? "hostReachable" : "hostUnreachable")} · {observed(snapshot.discovery.collectedAt)}</p>{snapshot.discovery.detail && <p>{snapshot.discovery.detail}</p>}
      <ul className="host-provider-status">{snapshot.discovery.providers.map(row => <li key={row.provider}>{PROVIDERS[row.provider].label}: {t(locale, row.installed ? "hostInstalled" : "hostMissingCli")}</li>)}</ul>
      <p>{t(locale, "hostEndpoint")} · {observed(snapshot.access.collectedAt)}</p>{snapshot.access.detail && <p>{snapshot.access.detail}</p>}<ul className="host-provider-status">{Object.entries(snapshot.access.providers).map(([provider, available]) => <li key={provider}>{PROVIDERS[provider as AgentProviderId]?.label ?? provider}: {t(locale, available ? "hostEndpointYes" : "hostEndpointNo")}</li>)}</ul>
      <p>{observed(snapshot.metrics.collectedAt)} · {t(locale, snapshot.metrics.reachable ? "hostReachable" : "hostUnreachable")}</p>{snapshot.metrics.detail && <p>{snapshot.metrics.detail}</p>}<dl className="host-metrics"><dt>{t(locale, "hostLoadMetric")}</dt><dd>{metric(snapshot.metrics.load1)}</dd><dt>{t(locale, "hostMemoryMetric")}</dt><dd>{metric(snapshot.metrics.memoryAvailableMb)}</dd><dt>{t(locale, "hostGpuMetric")}</dt><dd>{metric(snapshot.metrics.gpuVramUsedMb)} / {metric(snapshot.metrics.gpuVramTotalMb)}</dd><dt>{t(locale, "hostSessionsMetric")}</dt><dd>{sessions.filter(s => s.hostId === selectedId && s.exitCode === null).length}</dd></dl>
    </> : <p>{t(locale, "hostNotChecked")}</p>}</>}
    </div></div></div><p className="agent-settings-error" role={error ? "alert" : undefined}>{error}</p><p role="status">{busy ? t(locale, "connectionSaving") : notice}</p>
  </section>;
}
