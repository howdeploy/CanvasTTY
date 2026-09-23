import type { ContainerProfile, ProviderId } from './contracts.ts';
const providers = new Set<ProviderId>(['terminal', 'opencode', 'minimax', 'omp']);
export function assertContainerProfile(value: unknown): asserts value is ContainerProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid container profile.');
  const p = value as ContainerProfile;
  const path = (v: unknown): v is string => typeof v === 'string' && /^\/[A-Za-z0-9_./ -]+$/u.test(v) && v.length <= 4096 && !v.split('/').includes('..');
  if (typeof p.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(p.id) || typeof p.label !== 'string' || !p.label.trim() || p.label.length > 100 ||
    typeof p.hostId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(p.hostId) || !['docker', 'podman'].includes(p.runtime) || !path(p.executable) || !path(p.python) || (p.hostId !== 'local' && !path(p.hostPython)) ||
    typeof p.image !== 'string' || p.image.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u.test(p.image) ||
    !['none', 'bridge'].includes(p.network) || !Number.isFinite(p.cpus) || p.cpus < 0.1 || p.cpus > 32 ||
    !Number.isInteger(p.memoryMb) || p.memoryMb < 128 || p.memoryMb > 65536 || !Number.isInteger(p.pids) || p.pids < 16 || p.pids > 4096 ||
    typeof p.user !== 'string' || !/^(?:keep-id|[0-9]{1,10}:[0-9]{1,10})$/u.test(p.user) || (p.user === 'keep-id' && p.runtime !== 'podman') ||
    !p.endpoint || (p.endpoint.kind !== 'native' && p.endpoint.kind !== 'unix') || (p.endpoint.kind === 'native' && p.runtime !== 'podman') || (p.endpoint.kind === 'unix' && !path(p.endpoint.socket)) ||
    !p.commands || typeof p.commands !== 'object' || Array.isArray(p.commands) || !Object.keys(p.commands).length || Object.entries(p.commands).some(([provider, command]) => !providers.has(provider as ProviderId) || !path(command))) throw new Error('Container profile needs one host, explicit engine endpoint, supported image commands, user and bounded CPU/RAM/PID limits.');
}
export function normalizeContainerProfiles(value: unknown): ContainerProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: ContainerProfile[] = [];
  for (const item of value.slice(0, 64)) {
    try { assertContainerProfile(item); if (profiles.some(p => p.id === item.id)) continue; profiles.push({ id: item.id, label: item.label, hostId: item.hostId, runtime: item.runtime, executable: item.executable, endpoint: item.endpoint.kind === 'native' ? { kind: 'native' } : { kind: 'unix', socket: item.endpoint.socket }, image: item.image, python: item.python, ...(item.hostPython ? { hostPython: item.hostPython } : {}), commands: { ...item.commands }, network: item.network, cpus: item.cpus, memoryMb: item.memoryMb, pids: item.pids, user: item.user }); } catch { /* Invalid profiles are unavailable, never repaired by weakening limits. */ }
  }
  return profiles;
}
