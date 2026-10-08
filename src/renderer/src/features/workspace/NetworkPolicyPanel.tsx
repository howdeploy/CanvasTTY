import { useEffect, useRef, useState } from "react";
import type { AgentNetworkPolicy } from "../../../../shared/backlog";
import { AsyncRequestEpoch, PendingOperation } from "./workspaceAsyncState";

export function NetworkPolicyPanel({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<{sessionId:string;policy:AgentNetworkPolicy} | null>(null);
  const [domains, setDomains] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const requests = useRef(new AsyncRequestEpoch());
  const saveOperation = useRef(new PendingOperation());

  useEffect(() => {
    const request = requests.current.next();
    saveOperation.current.cancel();
    setBusy(false);
    setSnapshot(null);
    setReason("");
    setMessage("");
    void window.canvasTTY.backlog.networkPolicy(sessionId).then((row) => {
      if (!requests.current.isCurrent(request) || sessionIdRef.current !== sessionId) return;
      setSnapshot({sessionId,policy:row.policy});
      setDomains(row.policy.domains.join("\n"));
      setReason(row.reason ?? "");
    }).catch((error: unknown) => {
      if (requests.current.isCurrent(request) && sessionIdRef.current === sessionId) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      if (requests.current.isCurrent(request)) requests.current.invalidate();
      saveOperation.current.cancel();
    };
  }, [sessionId]);

  const currentPolicy = snapshot?.sessionId === sessionId ? snapshot.policy : null;
  const setPolicy = (policy: AgentNetworkPolicy): void => setSnapshot({sessionId,policy});
  const save = async (): Promise<void> => {
    if (!currentPolicy || sessionIdRef.current !== sessionId) return;
    const operation = saveOperation.current.begin();
    if (operation === null) return;
    const request = requests.current.next();
    const targetSessionId = sessionId;
    setBusy(true);
    setMessage("");
    try {
      const next = await window.canvasTTY.backlog.setNetworkPolicy(targetSessionId, {
        ...currentPolicy,
        domains: domains.split(/[\s,]+/u).filter(Boolean)
      });
      if (!requests.current.isCurrent(request) || !saveOperation.current.isCurrent(operation)
        || sessionIdRef.current !== targetSessionId) return;
      setPolicy(next);
      setDomains(next.domains.join("\n"));
      setMessage("Saved. Restart this task's agents to apply the policy to their processes.");
    } catch (error) {
      if (requests.current.isCurrent(request) && saveOperation.current.isCurrent(operation)
        && sessionIdRef.current === targetSessionId) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requests.current.isCurrent(request) && saveOperation.current.finish(operation)) setBusy(false);
    }
  };

  if (!currentPolicy) return <p>{message || "Loading network policy…"}</p>;
  return <section className="backlog-network-policy" aria-busy={busy}>
    <h4>Project network policy</h4>
    <label>Network <select disabled={busy} value={currentPolicy.mode} onChange={event => setPolicy({ ...currentPolicy, mode: event.target.value as AgentNetworkPolicy["mode"] })}>
      <option value="open">Open</option><option value="allowed-domains">Allowed domains</option><option value="offline">Offline</option>
    </select></label>
    {currentPolicy.mode === "allowed-domains" && <>
      <label><input type="checkbox" disabled={busy} checked={currentPolicy.providerApis} onChange={event => setPolicy({ ...currentPolicy, providerApis: event.target.checked })} /> Provider APIs</label>
      <label><input type="checkbox" disabled={busy} checked={currentPolicy.packageRegistries} onChange={event => setPolicy({ ...currentPolicy, packageRegistries: event.target.checked })} /> Package registries</label>
      <label>Additional domains <textarea disabled={busy} rows={4} value={domains} placeholder="api.example.com" onChange={event => setDomains(event.target.value)} /></label>
      <p>Listed domains include their subdomains. Add the API domain for custom models or gateways.</p>
    </>}
    {reason && <p role="status">Restrictions unavailable: {reason}. Strict launches will be refused.</p>}
    <button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save project policy"}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
