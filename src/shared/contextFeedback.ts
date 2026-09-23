import { assertContextRule, contextBytes, contextId, contextText, type ContextCategory, type ContextProject, type ContextRule, type ContextState, type ContextValue } from './contextProfiles.ts';
import { DATA_CLASSES, type DataClass } from './contracts.ts';

export interface ContextFeedbackSession { id: string; title: string; provider: import('./contracts.ts').ProviderId }
export interface ContextLearning { enabled: boolean; autoApply: boolean; threshold: number; advisoryThreshold: number }
export const DEFAULT_CONTEXT_LEARNING: Readonly<ContextLearning> = Object.freeze({ enabled: false, autoApply: false, threshold: .85, advisoryThreshold: .6 });
export type FeedbackKind = 'correction' | 'accepted-change' | 'suggestion';
export interface ContextFeedbackInput { eventId: string; projectId: string; kind: FeedbackKind; category: ContextCategory; key: string; before?: ContextValue; value: ContextValue; dataClass?: DataClass; sessionId?: string; note?: string }
export interface ContextEvidence {
  id: string; eventId: string; candidateId: string; kind: FeedbackKind; before?: ContextValue; value: ContextValue; dataClass: DataClass; note?: string;
  recordedAt: number; undone: boolean; fingerprint: string;
  provenance: { origin: 'user-correction' | 'user-accepted-change' | 'agent-suggestion'; projectRootIdentity: string; sourcePath: string; sessionId?: string; sessionGeneration?: string };
}
export interface ContextCandidate {
  id: string; projectId: string; category: ContextCategory; key: string; value: ContextValue; dataClass: DataClass;
  score: number; status: 'pending' | 'accepted' | 'rejected' | 'disabled'; updatedAt: number;
}
export interface ContextFeedbackState { candidates: ContextCandidate[]; evidence: ContextEvidence[] }
export interface ContextFeedbackAction { kind: 'accept' | 'reject' | 'disable' | 'undo-accept' | 'undo-evidence'; id: string }
export function canonicalContextValue(value: ContextValue): string {
  return JSON.stringify(value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(v => JSON.parse(canonicalContextValue(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonicalContextValue(value[k]!))])));
}
export function assertContextLearning(value: unknown): asserts value is ContextLearning {
  const s = value as ContextLearning;
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['enabled', 'autoApply', 'threshold', 'advisoryThreshold'].includes(k)) || typeof s.enabled !== 'boolean' || typeof s.autoApply !== 'boolean' || !Number.isFinite(s.threshold) || s.threshold < .5 || s.threshold > 1 || !Number.isFinite(s.advisoryThreshold) || s.advisoryThreshold < 0 || s.advisoryThreshold > s.threshold) throw new Error('Invalid project learning thresholds or settings.');
}
export function feedbackRule(c: ContextCandidate): ContextRule { return { id: c.id, scope: 'project', ownerId: c.projectId, category: c.category, key: c.key, value: c.value, dataClass: c.dataClass, source: 'inferred', confidence: c.score, enabled: true, tags: [], updatedAt: c.updatedAt }; }
export function assertContextFeedbackInput(value: unknown): asserts value is ContextFeedbackInput {
  const i = value as ContextFeedbackInput;
  if (!i || typeof i !== 'object' || Array.isArray(i) || Object.keys(i).some(k => !['eventId', 'projectId', 'kind', 'category', 'key', 'before', 'value', 'dataClass', 'sessionId', 'note'].includes(k)) || !['correction', 'accepted-change', 'suggestion'].includes(i.kind)) throw new Error('Invalid context feedback fields or provenance.');
  contextId(i.eventId); contextId(i.projectId); if (i.sessionId !== undefined) contextId(i.sessionId);
  if (i.note !== undefined) contextText(i.note, 1024, 'feedback note', true);
  const rule = { id: 'validation', scope: 'project', ownerId: i.projectId, category: i.category, key: i.key, value: i.value, dataClass: i.dataClass ?? 'D2', source: 'inferred', confidence: 0, enabled: true, tags: [], updatedAt: 0 };
  assertContextRule(rule); if (i.before !== undefined) assertContextRule({ ...rule, value: i.before });
  if (contextBytes(JSON.stringify(i)) > 8192) throw new Error('Context feedback exceeds its byte bound.');
}
export function assertContextFeedback(state: ContextState): void {
  const f = state.feedback; if (f === undefined) return;
  if (!f || Object.keys(f).some(k => !['candidates', 'evidence'].includes(k)) || !Array.isArray(f.candidates) || !Array.isArray(f.evidence) || f.candidates.length > 512 || f.evidence.length > 2048) throw new Error('Context feedback exceeds its inventory bound.');
  const ids = new Set<string>(), identities = new Set<string>(), events = new Set<string>(), counts = new Map<string, number>();
  for (const c of f.candidates) {
    if (!c || Object.keys(c).some(k => !['id', 'projectId', 'category', 'key', 'value', 'dataClass', 'score', 'status', 'updatedAt'].includes(k)) || !state.projects.some(p => p.id === c.projectId) || !['pending', 'accepted', 'rejected', 'disabled'].includes(c.status) || ids.has(c.id)) throw new Error('Invalid context candidate identity.');
    assertContextRule(feedbackRule(c)); ids.add(c.id);
    const identity = JSON.stringify([c.projectId, c.key, canonicalContextValue(c.value)]);
    if (identities.has(identity)) throw new Error('Duplicate context candidate.'); identities.add(identity);
    counts.set(c.projectId, (counts.get(c.projectId) ?? 0) + 1); if (counts.get(c.projectId)! > 128) throw new Error('Context project candidate inventory exceeded.');
  }
  ids.clear(); counts.clear();
  for (const e of f.evidence) {
    const c = f.candidates.find(c => c.id === e?.candidateId);
    if (!c || !e || Object.keys(e).some(k => !['id', 'eventId', 'candidateId', 'kind', 'before', 'value', 'dataClass', 'note', 'recordedAt', 'undone', 'fingerprint', 'provenance'].includes(k)) || ids.has(e.id) || typeof e.undone !== 'boolean' || !Number.isSafeInteger(e.recordedAt) || e.recordedAt < 0 || !/^[a-f0-9]{64}$/u.test(e.fingerprint)) throw new Error('Invalid context evidence.');
    contextId(e.id); ids.add(e.id);
    assertContextFeedbackInput({ eventId: e.eventId, projectId: c.projectId, kind: e.kind, category: c.category, key: c.key, value: e.value, dataClass: e.dataClass, ...(e.before !== undefined ? { before: e.before } : {}), ...(e.note !== undefined ? { note: e.note } : {}) });
    if (canonicalContextValue(e.value) !== canonicalContextValue(c.value) || DATA_CLASSES.indexOf(e.dataClass) > DATA_CLASSES.indexOf(c.dataClass)) throw new Error('Context evidence differs from its candidate.');
    const p = e.provenance;
    if (!p || Object.keys(p).some(k => !['origin', 'projectRootIdentity', 'sourcePath', 'sessionId', 'sessionGeneration'].includes(k)) || p.origin !== (e.kind === 'correction' ? 'user-correction' : e.kind === 'accepted-change' ? 'user-accepted-change' : 'agent-suggestion') || !/^\d+:\d+:\d+$/u.test(p.projectRootIdentity) || (p.sessionId === undefined) !== (p.sessionGeneration === undefined)) throw new Error('Invalid main-owned evidence provenance.');
    contextText(p.sourcePath, 4096, 'evidence source path', true);
    if (p.sourcePath.split('/').some(part => part === '..' || part === '.') || p.sourcePath.startsWith('/') || /[\\:\x00-\x1f\x7f]/u.test(p.sourcePath)) throw new Error('Invalid evidence source path.');
    if (p.sessionId !== undefined) { contextId(p.sessionId); contextText(p.sessionGeneration, 100, 'session generation'); }
    const event = `${c.projectId}:${e.eventId}`; if (events.has(event)) throw new Error('Duplicate context feedback event.'); events.add(event);
    counts.set(c.id, (counts.get(c.id) ?? 0) + 1); if (counts.get(c.id)! > 32) throw new Error('Context candidate evidence inventory exceeded.');
  }
}
/** A score is a deterministic heuristic, never a calibrated probability. Conflicts are cumulative until undone. */
export function refreshContextCandidates(feedback: ContextFeedbackState): void {
  const groups = new Map<string, { candidates: ContextCandidate[]; floor: number; votes: number; own: Map<string, number> }>();
  const byId = new Map<string, NonNullable<ReturnType<typeof groups.get>>>();
  for (const c of feedback.candidates) {
    const key = JSON.stringify([c.projectId, c.key]);
    let group = groups.get(key);
    if (!group) { group = { candidates: [], floor: 0, votes: 0, own: new Map() }; groups.set(key, group); }
    group.candidates.push(c); group.floor = Math.max(group.floor, DATA_CLASSES.indexOf(c.dataClass)); byId.set(c.id, group);
  }
  for (const e of feedback.evidence) {
    const group = byId.get(e.candidateId); if (!group) throw new Error('Unknown context evidence candidate.');
    group.floor = Math.max(group.floor, DATA_CLASSES.indexOf(e.dataClass));
    if (!e.undone && e.kind !== 'suggestion') { group.votes++; group.own.set(e.candidateId, (group.own.get(e.candidateId) ?? 0) + 1); }
  }
  for (const group of groups.values()) for (const c of group.candidates) {
    const own = group.own.get(c.id) ?? 0, conflict = group.votes - own;
    c.score = Math.max(0, Number(((own >= 3 ? .9 : own === 2 ? .71 : own === 1 ? .45 : 0) - Math.min(.9, conflict * .3)).toFixed(2)));
    c.dataClass = DATA_CLASSES[group.floor]!;
  }
}
export function learnedContextRules(state: ContextState, project: ContextProject | undefined): ContextRule[] {
  if (!project?.learning?.enabled) return [];
  const settings = project.learning;
  const candidates = (state.feedback?.candidates ?? []).filter(c => c.projectId === project.id);
  const accepted = new Set(candidates.filter(c => c.status === 'accepted').map(c => c.key));
  return candidates.filter(c => c.status === 'accepted' || !accepted.has(c.key) && c.status === 'pending' && settings.autoApply && c.score >= settings.threshold).map(feedbackRule);
}
export function contextCandidateState(c: ContextCandidate, project: ContextProject, candidates: readonly ContextCandidate[] = []): string {
  if (!project.learning?.enabled) return 'learning-off';
  if (c.status !== 'pending') return c.status === 'accepted' ? 'applied' : c.status;
  if (candidates.some(other => other.id !== c.id && other.projectId === c.projectId && other.key === c.key && other.status === 'accepted')) return 'superseded';
  return project.learning.autoApply && c.score >= project.learning.threshold ? 'applied' : c.score >= project.learning.advisoryThreshold ? 'advisory' : 'pending';
}
