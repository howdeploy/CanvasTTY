import type { DataClass } from './contracts.ts';
import { assertContextRule, assertContextSelection, contextBytes, contextId, type ContextCategory, type ContextValue } from './contextProfiles.ts';

export interface CurrentContextInput { category: ContextCategory; key: string; value: ContextValue; tags?: string[]; dataClass?: DataClass }
/** Trusted launcher selection. Source, scope, provenance and history remain main-owned. */
export interface ContextLaunchSelection { enabled: boolean; taskId?: string; categories?: ContextCategory[]; current?: CurrentContextInput[] }
export interface ContextSourceSelection { enabled: boolean; revision?: number; project?: { id: string; label: string }; tasks: Array<{ id: string; label: string }> }
export interface LaunchContextPreview {
  enabled: boolean; text: string; bytes: number; dataClass: DataClass;
  revision?: number; digest?: string;
  route?: { accountId?: string; hostId?: string; model?: string; profileId?: string };
}
export interface ContextDeliverySummary {
  status: 'waiting' | 'delivered' | 'empty';
  projectId?: string; taskId?: string; categories?: ContextCategory[];
  revision: number; digest: string;
  highestDisclosedClass: DataClass;
  policyModel?: string;
}
export function assertContextLaunchSelection(value: unknown): asserts value is ContextLaunchSelection {
  const s = value as ContextLaunchSelection;
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['enabled', 'taskId', 'categories', 'current'].includes(k)) || typeof s.enabled !== 'boolean') throw new Error('Invalid context launch selection.');
  assertContextSelection({ taskId: s.taskId, categories: s.categories, maxDataClass: 'D3' });
  if (s.current !== undefined && (!Array.isArray(s.current) || s.current.length > 48 || contextBytes(JSON.stringify(s.current)) > 24 * 1024)) throw new Error('Current context exceeds its bound.');
  const keys = new Set<string>();
  for (const c of s.current ?? []) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['category', 'key', 'value', 'tags', 'dataClass'].includes(k))) throw new Error('Invalid current context fields.');
    assertContextRule({ ...c, id: 'current', scope: 'current', source: 'explicit', confidence: 1, enabled: true, updatedAt: 0, tags: c.tags === undefined ? [] : c.tags, dataClass: c.dataClass === undefined ? 'D2' : c.dataClass });
    if (keys.has(c.key)) throw new Error('Duplicate current context key.'); keys.add(c.key);
  }
}
export function assertContextDeliverySummary(value: unknown): asserts value is ContextDeliverySummary {
  const s = value as ContextDeliverySummary;
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['status', 'projectId', 'taskId', 'categories', 'revision', 'digest', 'highestDisclosedClass', 'policyModel'].includes(k)) || !['waiting', 'delivered', 'empty'].includes(s.status) || !Number.isSafeInteger(s.revision) || s.revision < 0 || typeof s.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(s.digest)) throw new Error('Invalid context delivery reference.');
  if (s.projectId !== undefined) contextId(s.projectId);
  assertContextSelection({ taskId: s.taskId, categories: s.categories, maxDataClass: s.highestDisclosedClass });
  if (s.taskId !== undefined && !s.projectId) throw new Error('Context task has no project.');
  if (s.policyModel !== undefined && (typeof s.policyModel !== 'string' || !s.policyModel.trim() || s.policyModel.length > 100 || /[\u0000-\u001f\u007f]/u.test(s.policyModel))) throw new Error('Invalid context model binding.');
}
