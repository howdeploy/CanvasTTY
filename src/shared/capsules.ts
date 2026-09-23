import type { AgentProviderId, DataClass, ProviderId, SessionSnapshot } from './contracts.ts';

export interface CapsuleTestProfile {
  id: string; label: string; containerProfileId: string; command: string; args: string[]; timeoutMs: number; outputBytes: number;
}

export interface CapsuleTestRun {
  id: string; capsuleId: string; reviewId: string; reviewDigest: string; testProfileId: string; profileDigest: string;
  state: 'preparing' | 'running' | 'passed' | 'failed' | 'cancelled' | 'uncertain' | 'unavailable';
  createdAt: number; finishedAt?: number; imageId?: string; generationId?: string; directory: string;
  stopped: boolean; output: string; truncated: boolean; exitCode: number | null; reason?: string;
  /** Computed on read; identifies changed/deleted settings without relabelling past results. */
  profileCurrent?: boolean;
}
export type CapsuleTestSummary = Omit<CapsuleTestRun, 'output'>;

export function assertCapsuleTestProfile(value: unknown): asserts value is CapsuleTestProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved test profile.');
  const p = value as CapsuleTestProfile;
  if (Object.keys(p).some(key => !['id', 'label', 'containerProfileId', 'command', 'args', 'timeoutMs', 'outputBytes'].includes(key)) ||
    typeof p.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(p.id) || typeof p.containerProfileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(p.containerProfileId) ||
    typeof p.label !== 'string' || !p.label.trim() || p.label.length > 100 || typeof p.command !== 'string' || !/^\/[A-Za-z0-9_./ -]+$/u.test(p.command) || p.command.length > 4096 || p.command.split('/').includes('..') ||
    !Array.isArray(p.args) || p.args.length > 64 || p.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) || JSON.stringify(p.args).length > 16384 ||
    !Number.isInteger(p.timeoutMs) || p.timeoutMs < 1000 || p.timeoutMs > 120000 || !Number.isInteger(p.outputBytes) || p.outputBytes < 1024 || p.outputBytes > 1048576) throw new Error('Tests require a saved image profile, absolute command, bounded argv, deadline and output.');
}

export function normalizeCapsuleTestProfiles(value: unknown): CapsuleTestProfile[] {
  if (!Array.isArray(value)) return [];
  const result: CapsuleTestProfile[] = [];
  for (const item of value.slice(0, 32)) {
    try { assertCapsuleTestProfile(item); if (!result.some(profile => profile.id === item.id)) result.push(structuredClone(item)); }
    catch { /* Invalid test commands are unavailable; never invent a fallback. */ }
  }
  return result;
}

export interface PrepareCapsuleRequest { sourceCwd: string; files: string[]; task: { text: string; dataClass: DataClass } }
export interface CapsuleSummary {
  kind?: 'source' | 'advisory-review';
  id: string; sourceDirectory: string; directory: string; files: string[]; dataClass: DataClass; capturedBytes: number;
  state: 'retained' | 'running' | 'uncertain' | 'unavailable' | 'applied' | 'apply-recovery-needed';
  createdAt: number; reason?: string; recoveryReviewId?: string;
}
export interface CapsuleReview {
  workspaceId: string; reviewId: string; digest: string; createdAt: number; patch: string; changedFiles: string[]; policyDigest?: string;
}
export interface CapsuleApplyResult { workspaceId: string; reviewId: string; digest: string; appliedAt: number }
export interface AdvisoryReviewRequest { capsuleId: string; reviewId: string; parentSessionId: string; accountId: string; model: string; containerProfileId: string }
export interface AdvisoryReviewRoute { accountId: string; accountLabel: string; provider: AgentProviderId; model: string; containerProfileId: string; containerLabel: string; hostId: 'local' }
export interface AdvisoryReviewChoices { parents: { id: string; title: string; provider: ProviderId }[]; routes: AdvisoryReviewRoute[]; unavailable?: 'ownerless' | 'owner-unavailable' | 'advisory-source' | 'unchanged' }
export interface AdvisoryReviewPreview { previewId: string; route: AdvisoryReviewRoute; dataClass: DataClass; reviewDigest: string; text: string; contextDataClass: DataClass; contextBytes: number }
export interface CapsulesApi {
  reviewAgentChoices(id: string, reviewId: string): Promise<AdvisoryReviewChoices>;
  previewReviewAgent(input: AdvisoryReviewRequest): Promise<AdvisoryReviewPreview>;
  launchReviewAgent(previewId: string): Promise<SessionSnapshot>;
  cancelReviewAgent(previewId: string): Promise<void>;
  validateConventions(id: string, reviewId: string, maxDataClass: DataClass): Promise<import('./conventions.ts').ConventionReport>;
  currentConventions(id: string): Promise<import('./conventions.ts').ConventionReport>;
  startTest(id: string, reviewId: string, testProfileId: string): Promise<CapsuleTestSummary>;
  testRuns(): Promise<CapsuleTestSummary[]>;
  testResult(id: string): Promise<CapsuleTestRun>;
  cancelTest(id: string): Promise<void>;
  cleanupTest(id: string): Promise<void>;
  selectFiles(sourceCwd: string): Promise<string[] | null>;
  prepare(request: PrepareCapsuleRequest): Promise<CapsuleSummary>;
  list(): Promise<CapsuleSummary[]>;
  review(id: string): Promise<CapsuleReview>;
  exportPatch(id: string, reviewId: string): Promise<boolean>;
  apply(id: string, reviewId: string): Promise<CapsuleApplyResult>;
  recoverApply(id: string, reviewId: string): Promise<void>;
  cleanup(id: string): Promise<void>;
}
