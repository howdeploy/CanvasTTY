import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { pathWithin as within } from './pathWithin.ts';
import { dataClassForPath, DATA_CLASSES, type DataClass, type PathPolicy } from '../../shared/contracts.ts';
import { contextId, contextText, type ContextState } from '../../shared/contextProfiles.ts';
import { assertContextFeedbackInput, canonicalContextValue, refreshContextCandidates, type ContextFeedbackAction, type ContextFeedbackInput } from '../../shared/contextFeedback.ts';
import { contextRootIdentity } from './ProjectConventionImporter.ts';

export interface ContextSessionEvidence { sessionId: string; generation: string; sourceCwd: string; dataClass: DataClass; assertCurrent(): void }
/** Only the authenticated local renderer calls this. A suggestion remains unconfirmed even there. */
export function captureContextFeedback(state: ContextState, input: ContextFeedbackInput, policies: () => readonly PathPolicy[], resolveSession?: () => ContextSessionEvidence): () => void {
  assertContextFeedbackInput(input);
  const project = state.projects.find(p => p.id === input.projectId);
  if (!project) throw new Error('Unknown context feedback project.');
  if (!project.learning?.enabled) throw new Error('Project context learning is disabled.');
  const rootIdentity = contextRootIdentity(project.root);
  if (project.rootIdentity !== rootIdentity) throw new Error('Context feedback project root identity changed.');
  const session = input.sessionId === undefined ? undefined : resolveSession?.();
  if (input.sessionId !== undefined && (!session || session.sessionId !== input.sessionId || !DATA_CLASSES.includes(session.dataClass))) throw new Error('Missing verified current context session.');
  if (session) {
    contextText(session.generation, 100, 'session generation'); session.assertCurrent();
    const path = realpathSync(session.sourceCwd), owner = state.projects.filter(p => within(p.root, path)).sort((a, b) => b.root.length - a.root.length)[0];
    if (owner?.id !== project.id) throw new Error('Context evidence session belongs to another project.');
  }
  const assertCurrent = (): void => { session?.assertCurrent(); if (contextRootIdentity(project.root) !== rootIdentity) throw new Error('Context evidence project changed before saving.'); };
  assertCurrent();
  const fingerprint = createHash('sha256').update(canonicalContextValue(Object.fromEntries(Object.entries({ ...input, ...(session ? { verifiedGeneration: session.generation } : {}) }).filter(([, value]) => value !== undefined)))).digest('hex');
  const feedback = state.feedback ??= { candidates: [], evidence: [] };
  const projectCandidates = new Set(feedback.candidates.filter(c => c.projectId === project.id).map(c => c.id));
  const replay = feedback.evidence.find(e => e.eventId === input.eventId && projectCandidates.has(e.candidateId));
  if (replay) { if (replay.fingerprint !== fingerprint) throw new Error('Context feedback replay differs from its original event.'); return assertCurrent; }
  let candidate = feedback.candidates.find(c => c.projectId === project.id && c.key === input.key && canonicalContextValue(c.value) === canonicalContextValue(input.value));
  const floor = DATA_CLASSES[Math.max(DATA_CLASSES.indexOf(input.dataClass ?? 'D2'), DATA_CLASSES.indexOf(session?.dataClass ?? 'D0'), DATA_CLASSES.indexOf(dataClassForPath(policies(), session?.sourceCwd ?? project.root, 'D2', project.root)))]!;
  const recordedAt = Date.now();
  if (!candidate) {
    candidate = { id: randomUUID(), projectId: project.id, category: input.category, key: input.key, value: structuredClone(input.value), dataClass: floor, score: 0, status: 'pending', updatedAt: recordedAt };
    feedback.candidates.push(candidate);
  } else if (candidate.category !== input.category) throw new Error('Existing context candidate has a different category.');
  candidate.updatedAt = recordedAt;
  feedback.evidence.push({ id: randomUUID(), eventId: input.eventId, candidateId: candidate.id, kind: input.kind, value: structuredClone(input.value), ...(input.before !== undefined ? { before: structuredClone(input.before) } : {}), ...(input.note !== undefined ? { note: input.note } : {}), dataClass: floor, recordedAt, undone: false, fingerprint,
    provenance: { origin: input.kind === 'correction' ? 'user-correction' : input.kind === 'accepted-change' ? 'user-accepted-change' : 'agent-suggestion', projectRootIdentity: rootIdentity, sourcePath: relative(project.root, session ? realpathSync(session.sourceCwd) : project.root).split(sep).join('/'), ...(session ? { sessionId: session.sessionId, sessionGeneration: session.generation } : {}) } });
  refreshContextCandidates(feedback);
  return assertCurrent;
}
export function changeContextFeedback(state: ContextState, action: ContextFeedbackAction): void {
  if (!action || Object.keys(action).some(k => !['kind', 'id'].includes(k)) || !['accept', 'reject', 'disable', 'undo-accept', 'undo-evidence'].includes(action.kind)) throw new Error('Invalid context feedback action.');
  contextId(action.id);
  const feedback = state.feedback;
  if (!feedback) throw new Error('Unknown context feedback identity.');
  if (action.kind === 'undo-evidence') {
    const evidence = feedback.evidence.find(e => e.id === action.id); if (!evidence) throw new Error('Unknown context evidence identity.');
    evidence.undone = true;
  } else {
    const candidate = feedback.candidates.find(c => c.id === action.id); if (!candidate) throw new Error('Unknown context candidate identity.');
    candidate.status = action.kind === 'accept' ? 'accepted' : action.kind === 'reject' ? 'rejected' : 'disabled';
    if (action.kind === 'accept') for (const other of feedback.candidates) if (other.id !== candidate.id && other.projectId === candidate.projectId && other.key === candidate.key && other.status === 'accepted') other.status = 'pending';
    candidate.updatedAt = Date.now();
  }
  refreshContextCandidates(feedback);
}
