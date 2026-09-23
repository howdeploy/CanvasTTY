import type { IsolationRequest } from "./contracts.ts";
export function assertIsolationRequest(value: unknown): asserts value is IsolationRequest | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid isolation request.");
  const item = value as Record<string, unknown>;
  if (!["direct", "worktree", "container"].includes(item.mode as string) || Object.keys(item).some(key => key !== "mode" && !(item.mode === "worktree" && key === "ref") && !(item.mode === "container" && key === "profileId"))) throw new Error("Invalid isolation request; execution paths are owned by the main process.");
  if (item.mode === "container" && (typeof item.profileId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(item.profileId))) throw new Error("A configured container profile is required.");
  if (item.ref !== undefined && (typeof item.ref !== "string" || item.ref.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._/~^{}@+-]*$/u.test(item.ref))) throw new Error("Invalid worktree ref.");
}
