import type { ContainerInventoryRow } from '../../shared/contracts.ts';

export const CONTAINER_INVENTORY_RESPONSE_BYTES = 128 * 1024;
export const CONTAINER_INVENTORY_ARGUMENTS = ['container', 'ls', '--all', '--no-trunc', '--last', '65', '--format', '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}}}'];
type Row = Omit<ContainerInventoryRow, 'managed'>;
export interface EngineContainerInventory { rows: Row[]; truncated: boolean }

/** The engine prints only these five fields, never commands, environment or mounts. */
export function parseContainerInventory(raw: string): EngineContainerInventory {
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Container inventory exceeds its bound.');
  const lines = raw.trim() ? raw.trim().split('\n') : [];
  if (lines.length > 65) throw new Error('Container inventory exceeds its row bound.');
  const seen = new Set<string>();
  const rows = lines.map(line => {
    const value = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,image,name,state,status' || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/u.test(value.id) || seen.has(value.id)) throw new Error('Invalid container inventory row.');
    seen.add(value.id);
    // Podman versions can expose Names as a list; the public summary is always text.
    if (Array.isArray(value.name) && value.name.length <= 16 && value.name.every((name: unknown) => typeof name === 'string')) value.name = value.name.join(', ');
    for (const [key, limit] of [['name', 128], ['image', 512], ['state', 32], ['status', 128]] as const) {
      if (typeof value[key] !== 'string' || Buffer.byteLength(value[key]) > limit || /[\x00-\x1f\x7f-\x9f]/u.test(value[key])) throw new Error('Invalid container inventory field.');
    }
    return value as Row;
  });
  return { rows: rows.slice(0, 64), truncated: rows.length > 64 };
}

export function parseRemoteContainerInventory(value: unknown): EngineContainerInventory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote inventory.');
  const data = value as EngineContainerInventory;
  if (Object.keys(data).sort().join(',') !== 'rows,truncated' || !Array.isArray(data.rows) || data.rows.length > 64 || typeof data.truncated !== 'boolean' || data.truncated && data.rows.length !== 64) throw new Error('Invalid remote inventory.');
  return { rows: parseContainerInventory(data.rows.map(row => JSON.stringify(row)).join('\n')).rows, truncated: data.truncated };
}
