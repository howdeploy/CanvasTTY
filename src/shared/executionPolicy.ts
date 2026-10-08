import type { AgentProviderId, SessionEnvironmentChoice } from "./contracts.ts";
import { AGENT_PROVIDERS } from "./contracts.ts";
export const DATA_CLASSES = ["D0", "D1", "D2", "D3"] as const;
export type ExecutionDataClass = typeof DATA_CLASSES[number];
export interface ExecutionTarget {
  id: string;
  label: string;
  provider: AgentProviderId;
  accountId: string;
  /** Native CLI model, never a wildcard. Account models are bound by inferenceModel instead. */
  model?: string;
  environment?: SessionEnvironmentChoice;
  maxDataClass: ExecutionDataClass;
  /** Public account route identity, excluding credentials. Required for account-backed targets. */
  inferenceModel?: string;
  endpoint?: string;
  accountKind?: string;
}
export interface ExecutionPolicy {
  enabled: boolean;
  defaultDataClass: ExecutionDataClass;
  targets: ExecutionTarget[];
}
export interface ExecutionAuthorization {
  dataClass: ExecutionDataClass;
  target: ExecutionTarget;
}
export const defaultExecutionPolicy = (): ExecutionPolicy => ({ enabled: false, defaultDataClass: "D2", targets: [] });
export const isDataClass = (v: unknown): v is ExecutionDataClass => DATA_CLASSES.includes(v as ExecutionDataClass);
export function highestDataClass(...values: unknown[]): ExecutionDataClass {
  return DATA_CLASSES[Math.max(0, ...values.map(v => isDataClass(v) ? DATA_CLASSES.indexOf(v) : 3))]!;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const short = (v: unknown, n = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= n && !/[\x00-\x1f]/u.test(v);
export function environmentKey(v?: SessionEnvironmentChoice): string {
  return JSON.stringify(v ? [v.pluginId, v.kind, Object.entries(v.options ?? {}).sort(([a], [b]) => a.localeCompare(b))] : null);
}
/** Accounts exposes only host:port, never a credential-bearing URL. */
export function publicEndpoint(v: unknown): string | undefined {
  if (!short(v, 300) || /[\s/@?#]/u.test(v)) {
    return undefined;
  }
  try {
    const u = new URL(`ctty://${v}`);
    return u.host === v.toLowerCase() ? u.host : undefined;
  }
  catch {
    return undefined;
  }
}
export function normalizeExecutionPolicy(value: unknown): ExecutionPolicy {
  if (value === undefined) {
    return defaultExecutionPolicy();
  }
  const bad = (): ExecutionPolicy => ({ enabled: true, defaultDataClass: "D3", targets: [] });
  if (!record(value) || typeof value.enabled !== "boolean" || !isDataClass(value.defaultDataClass) || !Array.isArray(value.targets) || value.targets.length > 64) {
    return bad();
  }
  const ids = new Set<string>();
  const targets: ExecutionTarget[] = [];
  for (const row of value.targets) {
    if (!record(row) || !short(row.id, 80) || !/^[a-zA-Z0-9_-]+$/u.test(row.id) || ids.has(row.id) || !short(row.label, 100)
      || !(AGENT_PROVIDERS as readonly unknown[]).includes(row.provider) || !short(row.accountId, 40) || !/^[a-z0-9][a-z0-9-]*$/u.test(row.accountId) || !isDataClass(row.maxDataClass)
      || row.model !== undefined && !short(row.model) || row.inferenceModel !== undefined && !short(row.inferenceModel) || row.accountKind !== undefined && !short(row.accountKind, 40)) {
      return bad();
    }
    if (row.accountId !== "default" && (!short(row.inferenceModel) || !publicEndpoint(row.endpoint) || !short(row.accountKind, 40) || row.model !== undefined)) {
      return bad();
    }
    let environment: SessionEnvironmentChoice | undefined;
    if (row.environment !== undefined) {
      const e = row.environment;
      if (!record(e) || !short(e.pluginId, 100) || !short(e.kind, 100) || e.options !== undefined && !record(e.options)) {
        return bad();
      }
      const entries = Object.entries(e.options ?? {});
      if (entries.length > 32 || entries.some(([k, v]) => !short(k, 80) || /password|secret|token|credential/iu.test(k) || typeof v !== "boolean" && (typeof v !== "string" || v.length > 500 || /[\x00-\x1f]/u.test(v))) || JSON.stringify(e).length > 4096) {
        return bad();
      }
      environment = { pluginId: e.pluginId, kind: e.kind, ...(e.options ? { options: { ...e.options } as Record<string, string | boolean> } : {}) };
    }
    ids.add(row.id);
    targets.push({ id: row.id, label: row.label, provider: row.provider as AgentProviderId, accountId: row.accountId, maxDataClass: row.maxDataClass,
      ...(row.model ? { model: row.model as string } : {}), ...(environment ? { environment } : {}), ...(row.accountId !== "default" ? { inferenceModel: row.inferenceModel as string, endpoint: publicEndpoint(row.endpoint)!, accountKind: row.accountKind as string } : {}) });
  }
  return { enabled: value.enabled, defaultDataClass: value.defaultDataClass, targets };
}
export function sameTarget(a: ExecutionTarget, b: ExecutionTarget): boolean {
  return a.id === b.id && a.provider === b.provider && a.accountId === b.accountId && a.model === b.model && a.inferenceModel === b.inferenceModel && a.endpoint === b.endpoint && a.accountKind === b.accountKind && a.maxDataClass === b.maxDataClass && environmentKey(a.environment) === environmentKey(b.environment);
}
export function targetAllows(target: ExecutionTarget, dataClass: ExecutionDataClass): boolean {
  return DATA_CLASSES.indexOf(target.maxDataClass) >= DATA_CLASSES.indexOf(dataClass);
}
export function normalizeExecutionAuthorization(v: unknown): ExecutionAuthorization | undefined {
  if (!record(v) || !isDataClass(v.dataClass)) {
    return undefined;
  }
  const p = normalizeExecutionPolicy({ enabled: true, defaultDataClass: v.dataClass, targets: [v.target] });
  return p.targets[0] ? { dataClass: v.dataClass, target: p.targets[0] } : undefined;
}
