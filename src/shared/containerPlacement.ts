import { assertContextLaunchSelection } from './contextRuntime.ts';
import { CANVAS_LAUNCHER_ITEMS, DATA_CLASSES } from './contracts.ts';
import type { CreateSessionRequest, DataClass } from './contracts.ts';

/** Transient selection intent. It is never an isolation mode or saved session. */
export interface ContainerPlacementRequest { profileIds?: string[] }
export type ContainerAutoLaunchRequest = CreateSessionRequest & { containerPlacement: ContainerPlacementRequest };
export type ContainerPlacementExclusionCode = 'profile-invalid' | 'provider-command' | 'network-disabled' | 'host-invalid' | 'host-policy' | 'workspace-unmapped' | 'account-unavailable' | 'account-binding' | 'account-policy' | 'credential-reference' | 'launch-policy' | 'capacity' | 'configuration-changed' | 'unavailable' | 'image-unavailable' | 'metrics-unavailable' | 'resources';
export interface ContainerPlacementExclusion { profileId?: string; hostId?: string; accountId?: string; code: ContainerPlacementExclusionCode }
export interface ContainerPlacementTuple { profileId: string; hostId: string; accountId?: string }
export type ContainerPlacementPreview = (
  | ({ kind: 'selected'; dataClass: DataClass; model?: string } & ContainerPlacementTuple)
  | { kind: 'none'; reason: 'no-eligible-route' | 'too-many-candidates' }
) & { exclusions: ContainerPlacementExclusion[]; exclusionsTruncated: boolean };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FIELDS = new Set(['context', 'containerPlacement', 'provider', 'cwd', 'profile', 'position', 'title', 'role', 'parentSessionId', 'accountId', 'model', 'dataClass', 'allowSubagents', 'transport', 'initialPrompt', 'hostId', 'isolation']);
export function assertContainerPlacementRequest(value: unknown): asserts value is ContainerAutoLaunchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid container placement request.');
  const r = value as ContainerAutoLaunchRequest, placement = r.containerPlacement;
  if (r.context !== undefined) assertContextLaunchSelection(r.context);
  if (Object.keys(r).some(key => !FIELDS.has(key)) || !placement || typeof placement !== 'object' || Array.isArray(placement)
    || Object.keys(placement).some(key => key !== 'profileIds')
    || (placement.profileIds !== undefined && (!Array.isArray(placement.profileIds) || placement.profileIds.length < 1 || placement.profileIds.length > 64
      || placement.profileIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(placement.profileIds).size !== placement.profileIds.length))
    || r.hostId !== undefined || r.isolation !== undefined || r.transport !== undefined && r.transport !== 'pty'
    || !CANVAS_LAUNCHER_ITEMS.includes(r.provider) || !['normal', 'yolo'].includes(r.profile)
    || typeof r.cwd !== 'string' || r.cwd.length < 1 || r.cwd.length > 4096 || /[\u0000-\u001f\u007f]/u.test(r.cwd)
    || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(r.cwd))
    || !r.position || !Number.isFinite(r.position.x) || !Number.isFinite(r.position.y)
    || r.accountId !== undefined && (r.provider === 'terminal' || typeof r.accountId !== 'string' || !ID.test(r.accountId))
    || r.model !== undefined && (typeof r.model !== 'string' || !r.model.trim() || r.model.length > 100 || /[\u0000-\u001f\u007f]/u.test(r.model))
    || r.dataClass !== undefined && !DATA_CLASSES.includes(r.dataClass)
    || r.allowSubagents !== undefined && typeof r.allowSubagents !== 'boolean'
    || r.role !== undefined && !['interactive', 'orchestrator', 'subagent'].includes(r.role)
    || r.role === 'subagent' && r.parentSessionId === undefined
    || r.parentSessionId !== undefined && (typeof r.parentSessionId !== 'string' || !ID.test(r.parentSessionId))
    || r.title !== undefined && (typeof r.title !== 'string' || r.title.length > 1000)
    || r.initialPrompt !== undefined && (r.provider === 'terminal' || typeof r.initialPrompt !== 'string' || r.initialPrompt.includes('\0') || new TextEncoder().encode(r.initialPrompt).length > 60 * 1024)) {
    throw new Error('Container placement needs an ordinary PTY request without a fixed host, isolation or capsule, and at most 64 unique profile ids.');
  }
}
