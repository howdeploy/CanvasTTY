import type { RemoteHost } from "../../../../shared/contracts.ts";
export const HOST_NUMERIC_FIELDS = ["sshPort", "priority", "maxSessions", "minFreeMemoryMb", "maxLoadPerCore"] as const;
export interface HostDraft { value: RemoteHost; numbers: Record<typeof HOST_NUMERIC_FIELDS[number], string>; origin: string | null }
export function hostDraft(value: RemoteHost, fresh = false): HostDraft {
  return { value: structuredClone(value), numbers: Object.fromEntries(HOST_NUMERIC_FIELDS.map(key => [key, value[key] === undefined ? "" : String(value[key])])) as HostDraft["numbers"], origin: fresh ? null : JSON.stringify(value) };
}
export function draftHost(draft: HostDraft): RemoteHost {
  const value = { ...draft.value, ...(draft.value.sshUser === "" ? { sshUser: undefined } : {}) };
  for (const key of HOST_NUMERIC_FIELDS) { const raw = draft.numbers[key]; if (raw === "") delete value[key]; else value[key] = Number(raw); }
  return value;
}
