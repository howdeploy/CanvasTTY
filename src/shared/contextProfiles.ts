import { assertContextFeedback, assertContextLearning, type ContextFeedbackSession, type ContextFeedbackAction, type ContextFeedbackInput, type ContextFeedbackState, type ContextLearning } from './contextFeedback.ts';
import type { DataClass } from './contracts.ts';

export const CONTEXT_CATEGORIES = ['design', 'architecture', 'code-style', 'security', 'testing', 'deployment', 'documentation', 'business-rules', 'naming', 'dependencies', 'communication'] as const;
export type ContextCategory = typeof CONTEXT_CATEGORIES[number];
export type ContextScope = 'defaults' | 'user' | 'organization' | 'project' | 'task' | 'current';
export type ContextValue = string | number | boolean | null | ContextValue[] | { [key: string]: ContextValue };
export interface ContextRule {
  id: string; scope: ContextScope; ownerId?: string; category: ContextCategory; key: string; value: ContextValue;
  tags: string[]; dataClass: DataClass; source: 'explicit' | 'imported' | 'inferred'; confidence: number; enabled: boolean; updatedAt: number;
  /** Local editor provenance; never rendered into the provider capsule. */
  provenance?: { sourcePath: string; sourceHash: string; sourceLine: number };
}
export interface ContextImport { path: string; kind: 'instructions' | 'readme' | 'editorconfig' | 'config' | 'css'; dataClass?: DataClass; selectors?: string[] }
export interface ContextProject { id: string; label: string; root: string; organizationId?: string; rootIdentity?: string; importsEnabled?: boolean; imports?: ContextImport[]; learning?: ContextLearning; validationEnabled?: boolean }
export interface ContextImportDiagnostic { sourcePath: string; dataClass: DataClass; status: 'missing' | 'reference' | 'unsupported'; message: string }
export interface ContextTask { id: string; label: string; projectId: string }
export interface ContextState { version: 1; revision: number; projects: ContextProject[]; tasks: ContextTask[]; rules: ContextRule[]; feedback?: ContextFeedbackState }
export interface ContextPreview { text: string; dataClass: DataClass; included: ContextRule[]; omitted: number; bytes: number; diagnostics?: ContextImportDiagnostic[] }
export interface ContextSelection { projectId?: string; organizationId?: string; taskId?: string; maxDataClass: DataClass; categories?: ContextCategory[]; byteBudget?: number; includeInferred?: boolean }
export type ContextRuleInput = Omit<ContextRule, 'id' | 'source' | 'confidence' | 'updatedAt' | 'dataClass' | 'provenance'> & { id?: string; dataClass?: DataClass };
export interface ContextApi {
  source(cwd: string): Promise<import('./contextRuntime.ts').ContextSourceSelection>;
  previewLaunch(request: import('./contracts.ts').CreateSessionRequest): Promise<import('./contextRuntime.ts').LaunchContextPreview>;
  get(): Promise<ContextState>;
  saveProject(project: Omit<ContextProject, 'id'> & { id?: string }, revision: number): Promise<ContextState>;
  saveTask(task: Omit<ContextTask, 'id'> & { id?: string }, revision: number): Promise<ContextState>;
  saveRule(rule: ContextRuleInput, revision: number): Promise<ContextState>;
  remove(kind: 'project' | 'task' | 'rule', id: string, revision: number): Promise<ContextState>;
  feedbackSessions(projectId: string): Promise<ContextFeedbackSession[]>;
  saveLearning(projectId: string, settings: ContextLearning, revision: number): Promise<ContextState>;
  captureFeedback(input: ContextFeedbackInput, revision: number): Promise<ContextState>;
  feedbackAction(action: ContextFeedbackAction, revision: number): Promise<ContextState>;
  preview(selection: ContextSelection): Promise<ContextPreview>;
}
export const contextBytes = (value: string): number => new TextEncoder().encode(value).length;
const classes = ['D0', 'D1', 'D2', 'D3'] as const;
const scopes: ContextScope[] = ['defaults', 'user', 'organization', 'project', 'task', 'current'];
const sources = ['inferred', 'imported', 'explicit'];
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
export function contextText(value: unknown, limit: number, name: string, empty = false): asserts value is string {
  if (typeof value !== 'string' || !empty && !value.trim() || contextBytes(value) > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) throw new Error(`Invalid or over-limit context ${name}.`);
}
export function contextId(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) throw new Error('Invalid context identity.'); }
export function assertContextImports(project: Pick<ContextProject, 'imports' | 'importsEnabled' | 'rootIdentity'>): void {
  if (project.importsEnabled !== undefined && typeof project.importsEnabled !== 'boolean' || project.rootIdentity !== undefined && (typeof project.rootIdentity !== 'string' || !/^\d+:\d+:\d+$/u.test(project.rootIdentity))) throw new Error('Invalid context import settings.');
  if (project.imports === undefined) return;
  if (!Array.isArray(project.imports) || project.imports.length > 32) throw new Error('Context imports exceed the file inventory bound.');
  const paths = new Set<string>();
  for (const entry of project.imports) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(k => !['path', 'kind', 'dataClass', 'selectors'].includes(k))) throw new Error('Invalid context import fields.');
    contextText(entry.path, 1024, 'import path');
    const parts = entry.path.split('/');
    if (paths.has(entry.path) || parts.length > 20 || parts.some(p => !p || p === '.' || p === '..' || ['.git', 'node_modules'].includes(p) || contextBytes(p) > 255) || /[\\:\x00-\x1f\x7f]/u.test(entry.path) || /[\uD800-\uDFFF]/u.test(entry.path)) throw new Error('Invalid relative context import path or depth bound.');
    paths.add(entry.path);
    if (!['instructions', 'readme', 'editorconfig', 'config', 'css'].includes(entry.kind) || entry.dataClass !== undefined && !classes.includes(entry.dataClass)) throw new Error('Invalid context import kind or class.');
    const name = parts.at(-1)!;
    const supported = entry.kind === 'instructions' ? /^(AGENTS|CLAUDE|CONTRIBUTING)\.md$/iu.test(name) || parts.includes('.cursor') && parts.includes('rules') && name.endsWith('.mdc')
      : entry.kind === 'readme' ? /^README(?:\.md)?$/iu.test(name) : entry.kind === 'editorconfig' ? name === '.editorconfig'
      : entry.kind === 'css' ? name.endsWith('.css') : /^(?:\.?prettier(?:rc|\.config)|\.?eslint(?:rc|\.config))(?:\.(?:json|ya?ml|[cm]?js|ts))?$/u.test(name);
    if (!supported) throw new Error('Unsupported selected context import filename.');
    if (entry.selectors !== undefined && (entry.kind !== 'css' || !Array.isArray(entry.selectors) || !entry.selectors.length || entry.selectors.length > 8 || entry.selectors.some(s => typeof s !== 'string' || contextBytes(s) > 120 || !/^(?::root|\.[A-Za-z_][A-Za-z0-9_-]*|\[data-theme=["']?[A-Za-z0-9_-]+["']?\])$/u.test(s)))) throw new Error('Invalid static CSS theme selector.');
  }
}
function valueShape(value: unknown, depth = 0): void {
  if (depth > 4) throw new Error('Context value exceeds its depth bound.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') { contextText(value, 4096, 'value', true); return; }
  if (!value || typeof value !== 'object' || Object.keys(value).length > 64) throw new Error('Invalid context value.');
  for (const [key, child] of Object.entries(value)) { if (dangerous.has(key)) throw new Error('Unsafe context value key.'); contextText(key, 160, 'value key'); valueShape(child, depth + 1); }
}
export function assertContextRule(value: unknown): asserts value is ContextRule {
  const r = value as ContextRule;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Invalid context rule.');
  contextId(r.id); contextText(r.key, 160, 'key');
  if (dangerous.has(r.key) || !scopes.includes(r.scope) || !CONTEXT_CATEGORIES.includes(r.category) || !classes.includes(r.dataClass) || !sources.includes(r.source) || typeof r.enabled !== 'boolean' || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1 || !Number.isSafeInteger(r.updatedAt) || r.updatedAt < 0) throw new Error('Invalid context rule fields.');
  if (['project', 'organization', 'task'].includes(r.scope)) contextId(r.ownerId);
  else if (r.ownerId !== undefined) throw new Error('This context scope has no owner.');
  if (!Array.isArray(r.tags) || r.tags.length > 16) throw new Error('Context tags exceed their bound.');
  r.tags.forEach(tag => contextText(tag, 40, 'tag'));
  valueShape(r.value);
  if (r.provenance !== undefined) {
    const p = r.provenance;
    if (r.source !== 'imported' || !p || Object.keys(p).some(k => !['sourcePath', 'sourceHash', 'sourceLine'].includes(k)) || !/^[a-f0-9]{64}$/u.test(p.sourceHash) || !Number.isSafeInteger(p.sourceLine) || p.sourceLine < 1) throw new Error('Invalid imported context provenance.');
    contextText(p.sourcePath, 1024, 'provenance path');
  }
  if (contextBytes(JSON.stringify(r)) > 4096) throw new Error('Context rule exceeds its byte bound.');
}
export function assertContextState(value: unknown): asserts value is ContextState {
  const s = value as ContextState;
  if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Array.isArray(s.projects) || s.projects.length > 128 || !Array.isArray(s.tasks) || s.tasks.length > 256 || !Array.isArray(s.rules) || s.rules.length > 2000 || contextBytes(JSON.stringify(s)) > 8 * 1024 * 1024) throw new Error('Invalid or over-limit context registry.');
  const projects = new Set<string>(), tasks = new Set<string>(), organizations = new Set<string>(), rules = new Set<string>();
  for (const p of s.projects) {
    if (p.validationEnabled !== undefined && typeof p.validationEnabled !== 'boolean') throw new Error('Invalid convention validation setting.');
    assertContextImports(p); if (p.learning !== undefined) assertContextLearning(p.learning);
    contextId(p.id); contextText(p.label, 160, 'project label'); contextText(p.root, 4096, 'project path');
    if (projects.has(p.id)) throw new Error('Duplicate context project.'); projects.add(p.id);
    if (p.organizationId !== undefined) { contextId(p.organizationId); organizations.add(p.organizationId); }
  }
  for (const t of s.tasks) { contextId(t.id); contextText(t.label, 160, 'task label'); if (!projects.has(t.projectId) || tasks.has(t.id)) throw new Error('Invalid context task project.'); tasks.add(t.id); }
  assertContextFeedback(s);
  for (const r of s.rules) {
    assertContextRule(r);
    if (rules.has(r.id) || r.scope === 'current' || r.scope === 'project' && !projects.has(r.ownerId!) || r.scope === 'task' && !tasks.has(r.ownerId!) || r.scope === 'organization' && !organizations.has(r.ownerId!)) throw new Error('Invalid stored context rule scope.');
    rules.add(r.id);
  }
}
export function assertContextSelection(value: unknown): asserts value is ContextSelection {
  const s = value as ContextSelection;
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(key => !['projectId', 'organizationId', 'taskId', 'maxDataClass', 'categories', 'byteBudget', 'includeInferred'].includes(key)) || !classes.includes(s.maxDataClass)) throw new Error('Invalid context preview selection.');
  for (const id of [s.projectId, s.organizationId, s.taskId]) if (id !== undefined) contextId(id);
  if (s.categories !== undefined && (!Array.isArray(s.categories) || s.categories.length > CONTEXT_CATEGORIES.length || s.categories.some(c => !CONTEXT_CATEGORIES.includes(c)))) throw new Error('Invalid context categories.');
  if (s.byteBudget !== undefined && (!Number.isSafeInteger(s.byteBudget) || s.byteBudget < 512 || s.byteBudget > 24 * 1024)) throw new Error('Invalid context byte budget.');
  if (s.includeInferred !== undefined && typeof s.includeInferred !== 'boolean') throw new Error('Invalid inferred context setting.');
}
/** Resolve before filtering: a hidden specific winner must never revive a contradictory public fallback. */
export function resolveContext(rules: readonly ContextRule[], selection: ContextSelection, trustedInferredIds?: ReadonlySet<string>): ContextPreview {
  assertContextSelection(selection);
  if (rules.length > 2048) throw new Error('Context resolution exceeds its rule bound.');
  const winners = new Map<string, ContextRule>();
  const priority = (r: ContextRule): number => scopes.indexOf(r.scope) * 10 + sources.indexOf(r.source);
  for (const rule of rules) {
    assertContextRule(rule);
    if (!rule.enabled || rule.source === 'inferred' && (trustedInferredIds ? !trustedInferredIds.has(rule.id) : !selection.includeInferred || rule.confidence < .85) || rule.scope === 'project' && rule.ownerId !== selection.projectId || rule.scope === 'organization' && rule.ownerId !== selection.organizationId || rule.scope === 'task' && rule.ownerId !== selection.taskId) continue;
    const previous = winners.get(rule.key);
    if (!previous || priority(rule) > priority(previous) || priority(rule) === priority(previous) && (rule.updatedAt > previous.updatedAt || rule.updatedAt === previous.updatedAt && rule.id.localeCompare(previous.id) > 0)) winners.set(rule.key, rule);
  }
  const mandatory = (r: ContextRule): boolean => r.category === 'security' || r.category === 'dependencies';
  const visible = [...winners.values()].filter(r => classes.indexOf(r.dataClass) <= classes.indexOf(selection.maxDataClass) && (!selection.categories?.length || mandatory(r) || selection.categories.includes(r.category)));
  visible.sort((a, b) => Number(mandatory(b)) - Number(mandatory(a)) || priority(b) - priority(a) || a.key.localeCompare(b.key));
  const budget = selection.byteBudget ?? 12288, scopeBytes = new Map<ContextScope, number>();
  const scopeBudget = { defaults: 1024, user: 2048, organization: 2048, project: 6144, task: 4096, current: 4096 };
  const included: ContextRule[] = []; let text = '', omitted = 0, dataClass: DataClass = 'D0';
  const heading = 'CanvasTTY standing context. Current explicit task instructions take precedence over preferences.\n';
  for (const rule of visible) {
    const line = `[${rule.category}] ${rule.key} = ${JSON.stringify(rule.value)}\n`, bytes = contextBytes(line);
    const candidate = (text || heading) + line;
    if (contextBytes(candidate) > budget || !mandatory(rule) && (scopeBytes.get(rule.scope) ?? 0) + bytes > scopeBudget[rule.scope]) {
      if (mandatory(rule)) throw new Error('Required security/dependency context exceeds the budget. Narrow the selected rules.');
      omitted++; continue;
    }
    text = candidate; included.push(structuredClone(rule)); scopeBytes.set(rule.scope, (scopeBytes.get(rule.scope) ?? 0) + bytes);
    if (classes.indexOf(rule.dataClass) > classes.indexOf(dataClass)) dataClass = rule.dataClass;
  }
  return { text, dataClass, included, omitted, bytes: contextBytes(text) };
}
