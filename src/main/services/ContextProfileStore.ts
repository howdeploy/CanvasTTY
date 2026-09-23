import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { pathWithin as within } from './pathWithin.ts';
import { assertContextImports, assertContextRule, assertContextSelection, assertContextState, contextId, contextText, resolveContext, type ContextImportDiagnostic, type ContextProject, type ContextRuleInput, type ContextSelection, type ContextState, type ContextTask } from '../../shared/contextProfiles.ts';
import { assertContextLearning, learnedContextRules, type ContextFeedbackSession, type ContextFeedbackAction, type ContextFeedbackInput, type ContextLearning } from '../../shared/contextFeedback.ts';
import { captureContextFeedback, changeContextFeedback, type ContextSessionEvidence } from './ContextFeedback.ts';
import { dataClassForPath, DATA_CLASSES, type PathPolicy } from '../../shared/contracts.ts';
import { captureProjectConventions, contextRootIdentity } from './ProjectConventionImporter.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const empty = (): ContextState => ({ version: 1, revision: 0, projects: [], tasks: [], rules: [] });

function projectAt(projects: readonly ContextProject[], cwd: string): ContextProject | undefined {
  const path = realpathSync(cwd);
  const project = projects.filter(p => within(p.root, path)).sort((a, b) => b.root.length - a.root.length)[0];
  if (project && (realpathSync(project.root) !== project.root || !lstatSync(project.root).isDirectory())) throw new Error('Registered context project changed.');
  return project;
}

export interface ContextStoreCapture {
  readonly state: ContextState;
  readonly revision: number;
  readonly digest: string | undefined;
  readonly learnedRuleIds?: readonly string[];
  readonly diagnostics?: readonly ContextImportDiagnostic[];
  assertCurrent(): void;
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeTree); Object.freeze(value); }
  return value;
}

/** Private, lazy store. Constructing it and disabled launch paths perform no filesystem work. */
export class ContextProfileStore {
  private readonly directory: string;
  private value?: ContextState;
  private diskDigest?: string;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly pathPolicies: () => readonly PathPolicy[];
  constructor(directory: string, pathPolicies: () => readonly PathPolicy[] = () => []) { this.directory = directory; this.pathPolicies = pathPolicies; }
  private root(): string { return join(realpathSync(dirname(this.directory)), this.directory.slice(dirname(this.directory).length + 1)); }
  private verifyDirectory(): void {
    const root = this.root(), info = lstatSync(root);
    if (!info.isDirectory() || realpathSync(root) !== root || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('Context storage must be a private canonical owned directory.');
  }
  private read(): string | undefined {
    try { this.verifyDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let fd: number;
    try { fd = openSync(join(this.root(), 'profiles.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.size > MAX_BYTES || process.getuid && before.uid !== process.getuid()) throw new Error('Invalid private context registry.');
      const bytes = Buffer.alloc(before.size + 1); let length = 0;
      while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, length); if (!n) break; length += n; }
      const after = fstatSync(fd);
      if (length !== before.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw new Error('Context registry changed during reading.');
      this.verifyDirectory();
      const current = lstatSync(join(this.root(), 'profiles.json'));
      if (current.dev !== after.dev || current.ino !== after.ino || current.ctimeMs !== after.ctimeMs || !current.isFile()) throw new Error('Context registry changed during reading.');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { closeSync(fd); }
  }
  get(): ContextState {
    if (!this.value) {
      const raw = this.read(), value: unknown = raw === undefined ? empty() : JSON.parse(raw);
      assertContextState(value); this.value = value; this.diskDigest = raw === undefined ? undefined : digest(raw);
    }
    return structuredClone(this.value);
  }
  /** Runtime snapshots reject external edits instead of silently trusting the editor's cache. */
  capture(sourceCwd?: string): ContextStoreCapture {
    const value = this.get(), expected = this.diskDigest;
    const project = sourceCwd === undefined ? undefined : value.projects.filter(p => within(p.root, sourceCwd)).sort((a, b) => b.root.length - a.root.length)[0];
    const policies = structuredClone(this.pathPolicies()), policyDigest = digest(JSON.stringify(policies));
    const learned = learnedContextRules(value, project);
    if (learned.length) {
      const candidateKeys = new Map(value.feedback!.candidates.filter(c => c.projectId === project!.id).map(c => [c.id, c.key]));
      const floors = new Map<string, number>();
      for (const e of value.feedback!.evidence) {
        const key = candidateKeys.get(e.candidateId); if (key === undefined) continue;
        const floor = DATA_CLASSES.indexOf(dataClassForPath(policies, join(project!.root, e.provenance.sourcePath), 'D2', project!.root));
        floors.set(key, Math.max(floors.get(key) ?? 0, floor));
      }
      for (const rule of learned) rule.dataClass = DATA_CLASSES[Math.max(DATA_CLASSES.indexOf(rule.dataClass), floors.get(rule.key) ?? 0)]!;
    }
    if (learned.length && contextRootIdentity(project!.root) !== project!.rootIdentity) throw new Error('Learned context project root identity changed.');
    const imports = captureProjectConventions(project, value.projects, policies, 2000 - value.rules.length - learned.length);
    if (value.rules.length + imports.rules.length + learned.length > 2000) throw new Error('Combined context rules exceed their inventory bound.');
    const state = freezeTree({ ...value, rules: [...value.rules, ...imports.rules, ...learned] });
    const assertCurrent = (): void => {
      if (this.value?.revision !== state.revision || this.diskDigest !== expected) throw new Error('Context revision changed before launch.');
      const raw = this.read();
      if ((raw === undefined ? undefined : digest(raw)) !== expected) throw new Error('Context registry changed outside this editor; reload the application.');
      if (digest(JSON.stringify(this.pathPolicies())) !== policyDigest) throw new Error('Context path policy changed before launch.');
      if (learned.length && contextRootIdentity(project!.root) !== project!.rootIdentity) throw new Error('Learned context project root identity changed.');
      imports.assertCurrent();
    };
    assertCurrent();
    return Object.freeze({ state, revision: state.revision, digest: sourceCwd === undefined ? expected : digest(JSON.stringify({ registry: expected, imports: imports.digest, policyDigest })), diagnostics: freezeTree(imports.diagnostics), learnedRuleIds: Object.freeze(learned.map(r => r.id)), assertCurrent });
  }
  private update(revision: number, change: (next: ContextState) => void, guard: () => void = () => {}): Promise<ContextState> {
    const operation = this.writes.catch(() => {}).then(async () => {
      const next = this.get();
      if (!Number.isSafeInteger(revision) || revision !== next.revision) throw new Error('Context revision changed. Reload before saving.');
      change(next); next.revision++; assertContextState(next);
      const old = this.read();
      if ((old === undefined ? undefined : digest(old)) !== this.diskDigest) throw new Error('Context registry changed outside this editor; reload the application.');
      const root = this.root(); await mkdir(root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      this.verifyDirectory();
      const path = join(root, `${randomUUID()}.tmp`), raw = JSON.stringify(next), file = await open(path, 'wx', 0o600);
      try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
      try { guard(); await rename(path, join(root, 'profiles.json')); }
      catch (error) { await rm(path, { force: true }); throw error; }
      this.value = next; this.diskDigest = digest(raw); return structuredClone(next);
    });
    this.writes = operation; return operation;
  }
  saveProject(input: Omit<ContextProject, 'id'> & { id?: string }, revision: number): Promise<ContextState> {
    return this.update(revision, state => {
      if (!input || Object.keys(input).some(key => !['id', 'label', 'root', 'organizationId', 'rootIdentity', 'importsEnabled', 'imports', 'learning', 'validationEnabled'].includes(key))) throw new Error('Invalid context project fields.');
      assertContextImports(input); if (input.learning !== undefined) assertContextLearning(input.learning);
      contextText(input.label, 160, 'project label'); contextText(input.root, 4096, 'project path');
      if (!isAbsolute(input.root) || realpathSync(input.root) !== input.root || !lstatSync(input.root).isDirectory()) throw new Error('Context project needs its canonical directory, without links.');
      if (input.id !== undefined) { contextId(input.id); if (!state.projects.some(p => p.id === input.id)) throw new Error('Unknown context project.'); }
      if (input.organizationId !== undefined) contextId(input.organizationId);
      if (state.projects.some(p => p.root === input.root && p.id !== input.id)) throw new Error('This context project directory is already registered.');
      const rootIdentity = contextRootIdentity(input.root), previous = state.projects.find(p => p.id === input.id);
      if (input.rootIdentity !== undefined && input.rootIdentity !== previous?.rootIdentity || previous?.root === input.root && previous.rootIdentity !== undefined && previous.rootIdentity !== rootIdentity) throw new Error('Registered context project root identity changed. Remove and register the project again.');
      if (input.learning !== undefined && JSON.stringify(input.learning) !== JSON.stringify(previous?.learning)) throw new Error('Use project learning settings to change learning.');
      if (previous && previous.root !== input.root && state.feedback?.candidates.some(c => c.projectId === previous.id)) throw new Error('Register a new project to keep existing feedback bound to its original root.');
      const project: ContextProject = { id: input.id ?? randomUUID(), label: input.label.trim(), root: input.root, rootIdentity, ...(input.organizationId ? { organizationId: input.organizationId } : {}), ...(input.importsEnabled !== undefined ? { importsEnabled: input.importsEnabled } : {}), ...(input.imports !== undefined ? { imports: structuredClone(input.imports) } : {}), ...(input.validationEnabled !== undefined ? { validationEnabled: input.validationEnabled } : {}), ...(previous?.learning ? { learning: structuredClone(previous.learning) } : {}) };
      state.projects = [...state.projects.filter(p => p.id !== project.id), project];
    });
  }
  conventionProject(sourceCwd: string): ContextProject | undefined { return projectAt(this.get().projects, sourceCwd); }
  feedbackSessions(projectId: string, list: () => readonly ContextFeedbackSession[], resolve: (id: string) => ContextSessionEvidence): ContextFeedbackSession[] {
    contextId(projectId);
    const projects = this.get().projects;
    const project = projects.find(p => p.id === projectId); if (!project) throw new Error('Unknown context feedback project.');
    if (!project.learning?.enabled) return [];
    if (contextRootIdentity(project.root) !== project.rootIdentity) throw new Error('Context feedback project root identity changed.');
    const result: ContextFeedbackSession[] = [];
    for (const session of list().slice(0, 128)) {
      try {
        const proof = resolve(session.id); proof.assertCurrent();
        if (projectAt(projects, proof.sourceCwd)?.id === project.id) result.push({ id: session.id, title: session.title, provider: session.provider });
      } catch { /* Closed or unrelated sessions are not selectable evidence. */ }
    }
    return result;
  }
  saveLearning(projectId: string, settings: ContextLearning, revision: number): Promise<ContextState> {
    return this.update(revision, state => {
      contextId(projectId); assertContextLearning(settings);
      const project = state.projects.find(p => p.id === projectId); if (!project) throw new Error('Unknown context learning project.');
      if (contextRootIdentity(project.root) !== project.rootIdentity) throw new Error('Context learning project identity changed.');
      project.learning = structuredClone(settings);
    });
  }
  captureFeedback(input: ContextFeedbackInput, revision: number, resolveSession?: () => ContextSessionEvidence): Promise<ContextState> {
    let guard = (): void => {};
    return this.update(revision, state => { guard = captureContextFeedback(state, input, this.pathPolicies, resolveSession); }, () => guard());
  }
  feedbackAction(action: ContextFeedbackAction, revision: number): Promise<ContextState> {
    return this.update(revision, state => changeContextFeedback(state, action));
  }
  saveTask(input: Omit<ContextTask, 'id'> & { id?: string }, revision: number): Promise<ContextState> {
    return this.update(revision, state => {
      if (!input || Object.keys(input).some(key => !['id', 'label', 'projectId'].includes(key))) throw new Error('Invalid context task fields.');
      contextText(input.label, 160, 'task label'); contextId(input.projectId);
      if (!state.projects.some(p => p.id === input.projectId) || input.id !== undefined && !state.tasks.some(t => t.id === input.id)) throw new Error('Unknown context task or project.');
      const task = { id: input.id ?? randomUUID(), label: input.label.trim(), projectId: input.projectId };
      state.tasks = [...state.tasks.filter(t => t.id !== task.id), task];
    });
  }
  saveRule(input: ContextRuleInput, revision: number): Promise<ContextState> {
    return this.update(revision, state => {
      const candidate = input as ContextRuleInput & { source?: unknown; confidence?: unknown; updatedAt?: unknown };
      if (!candidate || Object.keys(candidate).some(key => !['id', 'scope', 'ownerId', 'category', 'key', 'value', 'tags', 'dataClass', 'enabled', 'source', 'confidence', 'updatedAt'].includes(key)) || candidate.source !== undefined && candidate.source !== 'explicit' || candidate.confidence !== undefined && candidate.confidence !== 1) throw new Error('Manual rules require explicit provenance.');
      if (candidate.id !== undefined) { contextId(candidate.id); if (!state.rules.some(r => r.id === candidate.id && r.source === 'explicit')) throw new Error('Unknown or read-only context rule.'); }
      const rule = { id: candidate.id ?? randomUUID(), scope: candidate.scope, ...(candidate.ownerId ? { ownerId: candidate.ownerId } : {}), category: candidate.category, key: candidate.key, value: structuredClone(candidate.value), tags: [...candidate.tags], dataClass: candidate.dataClass ?? 'D2', enabled: candidate.enabled, source: 'explicit' as const, confidence: 1, updatedAt: Date.now() };
      assertContextRule(rule); state.rules = [...state.rules.filter(r => r.id !== rule.id), rule];
    });
  }
  remove(kind: 'project' | 'task' | 'rule', id: string, revision: number): Promise<ContextState> {
    return this.update(revision, state => {
      contextId(id);
      if (kind === 'rule') state.rules = state.rules.filter(r => r.id !== id);
      else if (kind === 'task') { state.tasks = state.tasks.filter(t => t.id !== id); state.rules = state.rules.filter(r => r.scope !== 'task' || r.ownerId !== id); }
      else if (kind === 'project') {
        if (state.feedback) { state.feedback.candidates = state.feedback.candidates.filter(c => c.projectId !== id); state.feedback.evidence = state.feedback.evidence.filter(e => state.feedback!.candidates.some(c => c.id === e.candidateId)); }
        state.projects = state.projects.filter(p => p.id !== id); state.tasks = state.tasks.filter(t => t.projectId !== id);
        state.rules = state.rules.filter(r => r.scope === 'project' ? r.ownerId !== id : r.scope === 'task' ? state.tasks.some(t => t.id === r.ownerId) : r.scope === 'organization' ? state.projects.some(p => p.organizationId === r.ownerId) : true);
      } else throw new Error('Invalid context record kind.');
    });
  }
  projectFor(cwd: string): ContextProject | undefined {
    return projectAt(this.get().projects, cwd);
  }
  preview(selection: ContextSelection) {
    assertContextSelection(selection); const state = this.get();
    const project = state.projects.find(p => p.id === selection.projectId);
    if (selection.projectId && !project || selection.taskId && !state.tasks.some(t => t.id === selection.taskId && t.projectId === project?.id)) throw new Error('Unknown context preview project or task.');
    const snapshot = this.capture(project?.root);
    const preview = resolveContext(snapshot.state.rules, { ...selection, organizationId: project?.organizationId }, new Set(snapshot.learnedRuleIds ?? []));
    snapshot.assertCurrent();
    return { ...preview, diagnostics: snapshot.diagnostics?.filter(d => DATA_CLASSES.indexOf(d.dataClass) <= DATA_CLASSES.indexOf(selection.maxDataClass)) ?? [] };
  }
  source(cwd: string): import('../../shared/contextRuntime.ts').ContextSourceSelection {
    contextText(cwd, 4096, 'source path');
    if (!isAbsolute(cwd)) throw new Error('Context source must be absolute.');
    if (!lstatSync(realpathSync(cwd)).isDirectory()) throw new Error('Context source must be a directory.');
    const snapshot = this.capture(), project = this.projectFor(cwd);
    snapshot.assertCurrent();
    return { enabled: true, revision: snapshot.revision, ...(project ? { project: { id: project.id, label: project.label } } : {}),
      tasks: snapshot.state.tasks.filter(task => task.projectId === project?.id).map(task => ({ id: task.id, label: task.label })) };
  }
}
