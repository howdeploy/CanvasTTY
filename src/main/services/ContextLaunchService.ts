import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { CurrentContextInput } from '../../shared/contextRuntime.ts';
export type { CurrentContextInput } from '../../shared/contextRuntime.ts';
import { PROVIDER_LABELS, type DataClass, type ProviderId } from '../../shared/contracts.ts';
import { assertContextRule, assertContextSelection, contextBytes, contextId, contextText, resolveContext, type ContextCategory, type ContextRule } from '../../shared/contextProfiles.ts';
import type { ContextProfileStore } from './ContextProfileStore.ts';

/** Trusted launch intent only. There is deliberately no source/project/history authority here. */
export interface ContextLaunchIntent {
  enabled: boolean;
  provider: ProviderId;
  taskId?: string;
  categories?: ContextCategory[];
  current?: CurrentContextInput[];
  byteBudget?: number;
  includeInferred?: boolean;
}
/** Main resolves logical source/workspace ownership before constructing this proof. */
export interface OwnedContextSource { sourceCwd: string; taskId?: string; assertCurrent(): void }
export interface ContextRoute { provider: ProviderId; accountId?: string; hostId?: string; policyModel?: string; maxDataClass: DataClass }
export interface ContextLaunchReference { readonly projectId?: string; readonly taskId?: string; readonly revision: number }
export interface ContextLaunchCapture {
  readonly ref: ContextLaunchReference;
  readonly digest: string;
  /** Call once at each asynchronous boundary, not once for every route candidate. */
  assertCurrent(): void;
}
export interface PreparedLaunchContext {
  readonly text: string;
  readonly digest: string;
  readonly includedDataClass: DataClass;
  readonly ref: ContextLaunchReference;
  assertCurrent(): void;
}
interface Captured {
  intent: ContextLaunchIntent;
  provider: ProviderId;
  rules: ContextRule[];
  learnedRuleIds: ReadonlySet<string>;
  selection: { projectId?: string; organizationId?: string; taskId?: string; categories?: ContextCategory[]; byteBudget?: number; includeInferred?: boolean };
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const within = (root: string, path: string): boolean => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
function directoryIdentity(path: string): string {
  const info = lstatSync(path);
  if (!info.isDirectory() || realpathSync(path) !== path) throw new Error('Context source must be a canonical directory.');
  return `${info.dev}:${info.ino}`;
}
function normalizeIntent(intent: ContextLaunchIntent): ContextLaunchIntent {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || Object.keys(intent).some(key => !['enabled', 'provider', 'taskId', 'categories', 'current', 'byteBudget', 'includeInferred'].includes(key)) || typeof intent.enabled !== 'boolean' || typeof intent.provider !== 'string' || !Object.hasOwn(PROVIDER_LABELS, intent.provider)) throw new Error('Invalid context launch intent.');
  assertContextSelection({ taskId: intent.taskId, categories: intent.categories, byteBudget: intent.byteBudget, includeInferred: intent.includeInferred, maxDataClass: 'D3' });
  if (intent.current !== undefined && (!Array.isArray(intent.current) || intent.current.length > 48 || contextBytes(JSON.stringify(intent.current)) > 24 * 1024)) throw new Error('Current context exceeds its bound.');
  return structuredClone(intent);
}
function currentRules(inputs: CurrentContextInput[] = []): ContextRule[] {
  const keys = new Set<string>();
  return inputs.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['category', 'key', 'value', 'tags', 'dataClass'].includes(key))) throw new Error('Invalid current context fields.');
    const rule: ContextRule = { id: randomUUID(), scope: 'current', category: input.category, key: input.key, value: input.value, tags: input.tags === undefined ? [] : input.tags, dataClass: input.dataClass === undefined ? 'D2' : input.dataClass, source: 'explicit', confidence: 1, enabled: true, updatedAt: Date.now() };
    assertContextRule(rule);
    if (keys.has(rule.key)) throw new Error('Duplicate current context key.');
    keys.add(rule.key); return rule;
  });
}

/** Captures local authority once; policy supplies the route ceiling and retains all eligibility math. */
export class ContextLaunchService {
  private readonly store: Pick<ContextProfileStore, 'capture'>;
  private readonly captures = new WeakMap<ContextLaunchCapture, Captured>();
  constructor(store: Pick<ContextProfileStore, 'capture'>) { this.store = store; }

  capture(input: ContextLaunchIntent, ownedSource: OwnedContextSource | (() => OwnedContextSource), inherited?: { projectId: string; intent: ContextLaunchIntent }): ContextLaunchCapture | undefined {
    // The caller can provide a lazy source resolver, so disabled/plain shell paths touch no filesystem.
    if (input?.enabled === false || input?.provider === 'terminal') return;
    let intent = normalizeIntent(input);
    const source = typeof ownedSource === 'function' ? ownedSource() : ownedSource;
    if (!source || typeof source.assertCurrent !== 'function') throw new Error('Missing owned context source.');
    contextText(source.sourceCwd, 4096, 'source path');
    if (!isAbsolute(source.sourceCwd)) throw new Error('Context source must be absolute.');
    const sourcePath = source.sourceCwd, assertSource = source.assertCurrent.bind(source);
    assertSource();
    const canonical = realpathSync(sourcePath), sourceIdentity = directoryIdentity(canonical);
    const snapshot = this.store.capture(canonical);
    const project = snapshot.state.projects.filter(project => within(project.root, canonical)).sort((a, b) => b.root.length - a.root.length)[0];
    if (inherited && project?.id === inherited.projectId) intent = normalizeIntent({ ...inherited.intent, provider: intent.provider, enabled: intent.enabled });
    const transient = currentRules(intent.current);
    const projectIdentity = project ? directoryIdentity(project.root) : undefined;
    if (source.taskId !== undefined) contextId(source.taskId);
    if (source.taskId !== undefined && intent.taskId !== undefined && source.taskId !== intent.taskId) throw new Error('Context task differs from its owned source.');
    const taskId = intent.taskId ?? source.taskId;
    if (taskId && !snapshot.state.tasks.some(task => task.id === taskId && task.projectId === project?.id)) throw new Error('Context task does not belong to this source project.');
    const ref = Object.freeze({ ...(project ? { projectId: project.id } : {}), ...(taskId ? { taskId } : {}), revision: snapshot.revision });
    const selection = { projectId: project?.id, taskId, organizationId: project?.organizationId, categories: intent.categories, byteBudget: intent.byteBudget, includeInferred: intent.includeInferred };
    const capture = Object.freeze({
      ref,
      digest: hash({ registry: snapshot.digest ?? null, intent, source: canonical, sourceIdentity, projectIdentity, ref }),
      assertCurrent(): void {
        snapshot.assertCurrent(); assertSource();
        if (realpathSync(sourcePath) !== canonical || directoryIdentity(canonical) !== sourceIdentity || project && directoryIdentity(project.root) !== projectIdentity) throw new Error('Context source or registered project changed before launch.');
      }
    });
    this.captures.set(capture, { intent, provider: intent.provider, rules: [...snapshot.state.rules, ...transient], learnedRuleIds: new Set(snapshot.learnedRuleIds ?? []), selection });
    return capture;
  }

  intent(capture: ContextLaunchCapture): ContextLaunchIntent {
    const captured = this.captures.get(capture); if (!captured) throw new Error('Unknown context launch capture.');
    return structuredClone(captured.intent);
  }

  /** Pure projection over a captured snapshot. The caller checks capture freshness around awaits. */
  project(capture: ContextLaunchCapture | undefined, route: ContextRoute): PreparedLaunchContext | undefined {
    if (!capture) return;
    const captured = this.captures.get(capture);
    if (!captured) throw new Error('Unknown context launch capture.');
    if (!route || typeof route !== 'object' || Array.isArray(route) || Object.keys(route).some(key => !['provider', 'accountId', 'hostId', 'policyModel', 'maxDataClass'].includes(key))) throw new Error('Invalid context route.');
    if (route.provider !== captured.provider) throw new Error('Context route provider changed.');
    for (const id of [route.accountId, route.hostId]) if (id !== undefined) contextText(id, 200, 'route identity');
    if (route.policyModel !== undefined) contextText(route.policyModel, 200, 'route model');
    const selected = resolveContext(captured.rules, { ...captured.selection, maxDataClass: route.maxDataClass }, captured.learnedRuleIds);
    return Object.freeze({ text: selected.text, digest: hash({ capture: capture.digest, route, text: selected.text }), includedDataClass: selected.dataClass, ref: capture.ref, assertCurrent: capture.assertCurrent });
  }
}
