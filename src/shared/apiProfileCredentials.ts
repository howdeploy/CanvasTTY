import type { ApiProfile, ProviderSecretRef, RemoteApiCredentialRef } from "./contracts.ts";
import { PROVIDER_SECRET_IDS } from "./contracts.ts";

export function isProviderSecretRef(value: unknown): value is ProviderSecretRef {
  return typeof value === "string" && (/^secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    || (PROVIDER_SECRET_IDS as readonly string[]).includes(value));
}
export function validRemoteApiCredential(value: unknown): value is RemoteApiCredentialRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (ref.kind === "environment") return Object.keys(ref).length === 2 && typeof ref.name === "string"
    && /^[A-Z][A-Z0-9_]{0,127}$/u.test(ref.name)
    && !/^(LD_|DYLD_|PYTHON|DOCKER|CONTAINER|PODMAN|XDG_|SSH_|GIT_|NODE_|PERL|RUBY)/u.test(ref.name)
    && !["PATH", "HOME", "USER", "LOGNAME", "ENV", "BASH_ENV", "SHELL", "SHELLOPTS", "BASHOPTS", "IFS", "CDPATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].includes(ref.name);
  return ref.kind === "key-file" && Object.keys(ref).length === 2 && typeof ref.path === "string"
    && ref.path.startsWith("/") && new TextEncoder().encode(ref.path).length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(ref.path)
    && ref.path.slice(1).split("/").every(part => part !== "" && part !== "." && part !== "..");
}
/** Stable nonsecret reference bytes; property insertion order never changes route evidence. */
export function copyRemoteApiCredential(ref: RemoteApiCredentialRef): RemoteApiCredentialRef {
  return ref.kind === "environment" ? { kind: ref.kind, name: ref.name } : { kind: ref.kind, path: ref.path };
}
export function validApiProfileCredential(profile: Pick<ApiProfile, "hostId" | "secretRef" | "remoteCredential">): boolean {
  if (profile.hostId === undefined || profile.hostId === "local") return isProviderSecretRef(profile.secretRef) && profile.remoteCredential === undefined;
  return typeof profile.hostId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile.hostId)
    && profile.hostId !== "auto" && profile.secretRef === undefined && validRemoteApiCredential(profile.remoteCredential);
}
