import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RetainedWorkspace, WorkspaceReview } from '../../shared/contracts.ts';

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_ENTRIES = 512;
const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
export interface CreateWorktree { sourceDirectory: string; ref?: string; sessionId?: string; leaseId?: string }
export interface IsolatedWorktree { id: string; directory: string; sourceDirectory: string; commit: string }
interface Manifest {
  version: 1; installation: string; token: string; workspace: IsolatedWorktree; sourceDev: number; sourceIno: number;
  commonDirectory: string; gitDirectory: string; baseBytes: number; createdAt: number; sessionId?: string;
  state: 'preparing' | 'idle' | 'running' | 'uncertain'; reason?: string;
}
interface WorktreeState { workspace: IsolatedWorktree; temporaryRoot: string; hooksDirectory: string; manifest?: Manifest; unavailable?: string }
function environment(): NodeJS.ProcessEnv { return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }; }
async function git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
  return (await execute('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', cwd, ...args], { env: environment(), timeout: 30_000, maxBuffer, encoding: 'utf8' })).stdout;
}
function within(root: string, path: string): boolean { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); }
function gitPath(output: string): string { return output.replace(/\n$/u, ""); }
function reason(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : 'Workspace verification failed.'; }

/** Detached checkouts prevent collisions, not access to other host files. Only explicit unchanged-idle cleanup removes them. */
export class WorktreeService {
  private readonly worktrees = new Map<string, WorktreeState>();
  private readonly rootDirectory?: string;
  private installation?: string;
  private initialized?: Promise<void>;
  private writes = Promise.resolve();
  private creationQueue = Promise.resolve();
  private readonly leases = new Map<string, string>();
  private readonly cleaning = new Set<string>();
  private readonly reviews = new Map<string, WorkspaceReview>();
  constructor(options: { rootDirectory?: string } = {}) { this.rootDirectory = options.rootDirectory; }

  async recover(): Promise<void> { return this.initialized ??= this.readRegistry(); }
  private async readRegistry(): Promise<void> {
    if (!this.rootDirectory) return;
    try {
      await this.privateDirectory(this.rootDirectory);
      try { this.installation = (await this.privateFile(join(this.rootDirectory, 'owner'), 128)).trim(); } catch { this.installation = undefined; }
      const names = await readdir(this.rootDirectory);
      if (names.length > MAX_ENTRIES + 4) throw new Error('Managed workspace registry exceeds its bound; manual inspection required.');
      for (const id of names.filter(name => UUID.test(name))) {
        const temporaryRoot = join(this.rootDirectory, id);
        const fallback = { id, directory: join(temporaryRoot, 'workspace'), sourceDirectory: '', commit: '' };
        const state: WorktreeState = { workspace: fallback, temporaryRoot, hooksDirectory: join(temporaryRoot, 'disabled-hooks') };
        this.worktrees.set(id, state);
        try {
          await this.privateDirectory(temporaryRoot);
          const candidate = JSON.parse(await this.privateFile(join(temporaryRoot, 'manifest.json'), 8192)) as Manifest;
          if (!this.validManifest(candidate, id)) throw new Error('Invalid workspace manifest; retained without cleanup permission.');
          state.manifest = candidate; state.workspace = candidate.workspace;
          await this.verify(state);
          if (candidate.state !== 'idle') { candidate.state = 'uncertain'; candidate.reason = 'Previous process termination is unconfirmed. Files are retained; automatic reuse and cleanup are disabled.'; }
        } catch (error) { state.unavailable = reason(error); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // No feature use means no directories, Git helpers or engines are created.
    }
  }
  async create(input: CreateWorktree): Promise<IsolatedWorktree> {
    let result!: IsolatedWorktree;
    const operation = this.creationQueue.catch(() => undefined).then(async () => { result = await this.createOwned(input); });
    this.creationQueue = operation; await operation; return result;
  }
  private async createOwned(input: CreateWorktree): Promise<IsolatedWorktree> {
    await this.recover();
    if (this.worktrees.size >= MAX_ENTRIES) throw new Error('Managed workspace limit reached; review and clean unchanged workspaces first.');
    const ref = input.ref ?? 'HEAD';
    if (typeof ref !== 'string' || ref.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._/~^{}@+-]*$/u.test(ref)) throw new Error('Invalid worktree ref.');
    if (typeof input.sourceDirectory !== 'string' || /[\x00-\x1f\x7f]/u.test(input.sourceDirectory)) throw new Error('Worktree source paths cannot contain control characters.');
    const source = await realpath(input.sourceDirectory);
    const sourceDirectory = await realpath(gitPath(await git(source, ['rev-parse', '--show-toplevel'])));
    const commit = (await git(sourceDirectory, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error('The worktree ref did not resolve to a commit.');
    const tree = await git(sourceDirectory, ['ls-tree', '-rlz', commit]);
    const entries = tree.split('\0').filter(Boolean);
    const baseBytes = entries.reduce((sum, entry) => sum + Number(entry.match(/^\d+ \w+ [a-f0-9]+\s+(\d+)\t/u)?.[1] ?? 0), 0);
    if (entries.length > 20_000 || baseBytes > 1024 ** 3 || [...this.worktrees.values()].reduce((sum, item) => sum + (item.manifest?.baseBytes ?? 0), baseBytes) > 4 * 1024 ** 3) throw new Error('Managed checkout size limit exceeded (20,000 entries, 1 GiB per checkout, 4 GiB total base data).');
    const temporaryBase = this.rootDirectory ? await this.ensureRoot() : await realpath(tmpdir());
    if (sourceDirectory === temporaryBase || within(sourceDirectory, temporaryBase)) throw new Error('A worktree needs an owned directory outside the source checkout.');
    const id = randomUUID();
    const temporaryRoot = this.rootDirectory ? join(temporaryBase, id) : await mkdtemp(join(temporaryBase, 'canvastty-worktree-'));
    if (this.rootDirectory) await mkdir(temporaryRoot, { mode: 0o700 });
    const directory = join(temporaryRoot, 'workspace');
    const hooksDirectory = join(temporaryRoot, 'disabled-hooks');
    await mkdir(hooksDirectory, { mode: 0o700 });
    const workspace: IsolatedWorktree = { id, directory, sourceDirectory, commit };
    const commonDirectory = await realpath(resolve(sourceDirectory, gitPath(await git(sourceDirectory, ['rev-parse', '--git-common-dir']))));
    const identity = await lstat(sourceDirectory);
    const manifest: Manifest = { version: 1, installation: this.installation ?? id, token: randomUUID(), workspace, sourceDev: identity.dev, sourceIno: identity.ino, commonDirectory, gitDirectory: '', baseBytes, createdAt: Date.now(), ...(input.sessionId ? { sessionId: input.sessionId } : {}), state: 'preparing' };
    const state: WorktreeState = { workspace, temporaryRoot, hooksDirectory, ...(this.rootDirectory ? { manifest } : {}) };
    this.worktrees.set(id, state);
    if (input.leaseId) this.leases.set(id, input.leaseId);
    if (this.rootDirectory) { await writeFile(join(temporaryRoot, 'owner'), manifest.token, { mode: 0o600, flag: 'wx' }); await this.persist(state); }
    try {
      await git(sourceDirectory, ['-c', `core.hooksPath=${hooksDirectory}`, '-c', 'submodule.recurse=false', 'worktree', 'add', '--detach', '--', directory, commit]);
      if (state.manifest) { state.manifest.gitDirectory = await realpath(gitPath(await git(directory, ['rev-parse', '--absolute-git-dir']))); state.manifest.state = 'idle'; await this.persist(state); }
      return { ...workspace };
    } catch (error) { this.leases.delete(id); state.unavailable = 'Workspace preparation failed; partial output retained for inspection.'; if (state.manifest) { state.manifest.reason = state.unavailable; await this.persist(state); } throw error; }
  }
  async reuse(id: string, sourceCwd: string): Promise<IsolatedWorktree> {
    await this.recover(); const state = this.require(id); await this.verify(state);
    const source = await realpath(sourceCwd);
    if (source !== state.workspace.sourceDirectory && !within(state.workspace.sourceDirectory, source)) throw new Error('Workspace belongs to another source repository.');
    if (state.manifest && state.manifest.state !== 'idle') throw new Error(state.manifest.reason ?? 'Workspace still has an active or unconfirmed process.');
    return { ...state.workspace };
  }
  async reserve(id: string, leaseId: string): Promise<void> {
    const state = this.require(id);
    if (this.cleaning.has(id) || this.leases.has(id) || (state.manifest && state.manifest.state !== 'idle')) throw new Error('Workspace is busy or process termination is unconfirmed.');
    this.leases.set(id, leaseId);
    try { await this.verify(state); } catch (error) { this.leases.delete(id); throw error; }
  }
  async setRunning(id: string, leaseId: string): Promise<void> { const state = this.require(id); if (this.leases.get(id) !== leaseId) throw new Error("Workspace reservation changed."); await this.verify(state); if (state.manifest) { state.manifest.state = 'running'; delete state.manifest.reason; await this.persist(state); } }
  async retain(id: string, processExited: boolean, leaseId?: string): Promise<void> {
    const state = this.require(id); if (leaseId !== undefined && this.leases.get(id) !== leaseId) return;
    if (processExited) this.leases.delete(id);
    if (!state.manifest) return;
    if (processExited) { state.manifest.state = 'idle'; state.manifest.reason = 'Process exited; output retained for review.'; }
    else if (state.manifest.state === 'running') { state.manifest.state = 'uncertain'; state.manifest.reason = 'Process termination is unconfirmed; output retained.'; }
    await this.persist(state);
  }
  /** Called only after an exact owned container ID has been inspected as stopped and removed. */
  async confirmContainerStopped(id: string, leaseId: string): Promise<void> {
    await this.recover(); const state = this.require(id); await this.verify(state);
    const current = this.leases.get(id);
    if (current !== undefined && current !== leaseId) return;
    await this.retain(id, true);
  }
  async list(): Promise<RetainedWorkspace[]> {
    await this.recover(); return [...this.worktrees.values()].map(state => ({ id: state.workspace.id, sourceCwd: state.workspace.sourceDirectory, executionCwd: state.workspace.directory, baseCommit: state.workspace.commit, createdAt: state.manifest?.createdAt ?? 0,
      state: state.unavailable ? 'unavailable' : state.manifest?.state === 'idle' || !state.manifest ? 'retained' : state.manifest.state === 'running' ? 'running' : 'uncertain', reason: state.unavailable ?? state.manifest?.reason ?? 'Separate checkout; changes are retained until explicitly reviewed.', sessionId: state.manifest?.sessionId }));
  }
  async review(id: string): Promise<WorkspaceReview> {
    await this.recover();
    if (this.leases.has(id) || this.cleaning.has(id)) throw new Error('Workspace is reserved or busy; stop the agent before review.');
    const state = this.require(id); await this.verify(state);
    if (state.manifest && state.manifest.state !== 'idle') throw new Error('Stop the agent and confirm process exit before reviewing this workspace.');
    const tracked = await git(state.workspace.directory, ['ls-files', '-v', '-z', '--cached']);
    if (tracked.split('\0').some(entry => entry && !entry.startsWith('H '))) throw new Error('Index flags can hide output. Remove assume-unchanged / skip-worktree flags in the retained checkout before review.');
    const patch = await git(state.workspace.directory, ['-c', 'color.ui=false', 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', state.workspace.commit, '--'], MAX_REVIEW_BYTES);
    const status = await git(state.workspace.directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], MAX_REVIEW_BYTES);
    const limitations = ['Patch includes committed and tracked working changes from the base commit. Applying it to the source is a separate manual action.'];
    if (status.split('\0').some(entry => entry.startsWith('?? ') || entry.startsWith('!! '))) limitations.push('Untracked and ignored files are retained in the execution directory but are not included in this patch. Copy them explicitly after inspection.');
    if ((await git(state.workspace.directory, ['rev-parse', 'HEAD'])).trim() !== state.workspace.commit) limitations.push('This checkout contains commits after the base; preserve their history separately. Cleanup is disabled.');
    const result: WorkspaceReview = { workspaceId: id, reviewId: randomUUID(), patch, limitations, baseCommit: state.workspace.commit, createdAt: Date.now() };
    while (this.reviews.size >= 4) this.reviews.delete(this.reviews.keys().next().value!);
    this.reviews.set(result.reviewId, result); return structuredClone(result);
  }
  exportReview(id: string, reviewId: string): WorkspaceReview { const review = this.reviews.get(reviewId); if (!review || review.workspaceId !== id) throw new Error('Review expired; review the workspace again before exporting.'); return structuredClone(review); }
  async cleanup(id: string): Promise<void> {
    await this.recover(); const state = this.worktrees.get(id); if (!state) throw new Error('Workspace is not registered.');
    if (this.leases.has(id) || this.cleaning.has(id)) throw new Error('Workspace is reserved or busy; retained.');
    this.cleaning.add(id);
    try {
      await this.verify(state).catch(error => { state.unavailable = reason(error); throw error; });
      if (state.manifest && state.manifest.state !== 'idle') throw new Error('Workspace process is running or termination is unconfirmed; retained.');
      const { workspace } = state;
      const tracked = await git(workspace.directory, ['ls-files', '-v', '-z', '--cached']);
      if (tracked.split('\0').some(entry => entry && !entry.startsWith('H '))) throw new Error('Worktree has index flags that may hide changes; retained.');
      if ((await git(workspace.directory, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'])).trim()) throw new Error('Worktree has dirty or untracked changes; retained.');
      if ((await git(workspace.directory, ['rev-parse', 'HEAD'])).trim() !== workspace.commit) throw new Error('Worktree has new commits; retained.');
      await git(workspace.sourceDirectory, ['worktree', 'remove', '--', workspace.directory]);
      if (state.manifest) { await unlink(join(state.temporaryRoot, 'manifest.json')); await unlink(join(state.temporaryRoot, 'owner')); }
      await rmdir(state.hooksDirectory); await rmdir(state.temporaryRoot); this.worktrees.delete(id);
    } catch (error) { if (state.manifest && !state.unavailable) { state.manifest.reason = reason(error); await this.persist(state).catch(() => undefined); } throw error; }
    finally { this.cleaning.delete(id); }
  }
  async dispose(): Promise<IsolatedWorktree[]> {
    // Runtime uses durable mode: closing the app is never an instruction to discard output.
    if (!this.rootDirectory) for (const id of [...this.worktrees.keys()]) await this.cleanup(id).catch(() => undefined);
    await this.writes; return [...this.worktrees.values()].map(({ workspace }) => ({ ...workspace }));
  }
  private require(id: string): WorktreeState { if (!UUID.test(id)) throw new Error('Invalid workspace id.'); const state = this.worktrees.get(id); if (!state) throw new Error('Workspace is not registered.'); if (state.unavailable) throw new Error(state.unavailable); return state; }
  private async verify(state: WorktreeState): Promise<void> {
    if (state.unavailable) throw new Error(state.unavailable);
    const { workspace, manifest } = state;
    if ((await lstat(workspace.directory)).isSymbolicLink() || await realpath(workspace.directory) !== workspace.directory) throw new Error('Worktree directory was replaced; refusing cleanup.');
    if (!manifest) return;
    if (!this.rootDirectory || state.temporaryRoot !== join(this.rootDirectory, workspace.id) || workspace.directory !== join(state.temporaryRoot, 'workspace')) throw new Error('Workspace is outside its owned root.');
    await this.privateDirectory(this.rootDirectory); await this.privateDirectory(state.temporaryRoot);
    const disk = JSON.parse(await this.privateFile(join(state.temporaryRoot, 'manifest.json'), 8192)) as Manifest;
    if (!this.validManifest(disk, workspace.id) || JSON.stringify([disk.workspace, disk.token, disk.sourceDev, disk.sourceIno, disk.commonDirectory, disk.gitDirectory]) !== JSON.stringify([manifest.workspace, manifest.token, manifest.sourceDev, manifest.sourceIno, manifest.commonDirectory, manifest.gitDirectory])) throw new Error('Workspace manifest identity changed; retained.');
    if ((await this.privateFile(join(state.temporaryRoot, 'owner'), 128)).trim() !== manifest.token) throw new Error('Workspace ownership marker does not match.');
    const source = await lstat(workspace.sourceDirectory);
    if (source.isSymbolicLink() || await realpath(workspace.sourceDirectory) !== workspace.sourceDirectory || source.dev !== manifest.sourceDev || source.ino !== manifest.sourceIno) throw new Error('Source repository identity changed; workspace retained.');
    const common = await realpath(resolve(workspace.directory, gitPath(await git(workspace.directory, ['rev-parse', '--git-common-dir']))));
    const sourceCommon = await realpath(resolve(workspace.sourceDirectory, gitPath(await git(workspace.sourceDirectory, ['rev-parse', '--git-common-dir']))));
    const gitDirectory = await realpath(gitPath(await git(workspace.directory, ['rev-parse', '--absolute-git-dir'])));
    if (common !== manifest.commonDirectory || sourceCommon !== common || gitDirectory !== manifest.gitDirectory || !within(join(common, 'worktrees'), gitDirectory)) throw new Error('Worktree Git membership changed; workspace retained.');
    if (gitPath(await readFile(join(gitDirectory, 'gitdir'), 'utf8')) !== join(workspace.directory, '.git')) throw new Error('Worktree backlink does not match.');
    const members = (await git(workspace.sourceDirectory, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
    if (!members.includes(`worktree ${workspace.directory}`)) throw new Error('Worktree is no longer registered with its source repository.');
  }
  private validManifest(value: Manifest, id: string): boolean {
    return value?.version === 1 && !!this.installation && UUID.test(this.installation) && value.installation === this.installation && UUID.test(value.token) && value.workspace?.id === id && value.workspace.directory === join(this.rootDirectory!, id, 'workspace')
      && typeof value.workspace.sourceDirectory === 'string' && isAbsolute(value.workspace.sourceDirectory) && /^[a-f0-9]{40,64}$/u.test(value.workspace.commit)
      && typeof value.commonDirectory === 'string' && isAbsolute(value.commonDirectory) && typeof value.gitDirectory === 'string' && Number.isSafeInteger(value.sourceDev) && Number.isSafeInteger(value.sourceIno)
      && Number.isFinite(value.baseBytes) && value.baseBytes >= 0 && ['preparing', 'idle', 'running', 'uncertain'].includes(value.state) && Number.isFinite(value.createdAt);
  }
  private async privateDirectory(path: string): Promise<void> { const st = await lstat(path); if (!st.isDirectory() || st.isSymbolicLink() || await realpath(path) !== path || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) throw new Error('Managed workspace directory ownership or permissions changed.'); }
  private async privateFile(path: string, maxBytes: number): Promise<string> { const st = await lstat(path); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > maxBytes || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) throw new Error('Invalid managed workspace metadata file.'); return readFile(path, 'utf8'); }
  private async ensureRoot(): Promise<string> {
    const root = this.rootDirectory!; await mkdir(root, { recursive: true, mode: 0o700 }); await this.privateDirectory(root);
    if (!this.installation) { const names = await readdir(root); if (names.length) throw new Error('Managed root has no valid owner marker; refusing adoption.'); this.installation = randomUUID(); await writeFile(join(root, 'owner'), this.installation, { flag: 'wx', mode: 0o600 }); }
    return root;
  }
  private persist(state: WorktreeState): Promise<void> {
    if (!state.manifest) return Promise.resolve(); const text = JSON.stringify(state.manifest); if (Buffer.byteLength(text) > 8192) return Promise.reject(new Error('Workspace manifest exceeds its bound.'));
    const target = join(state.temporaryRoot, 'manifest.json');
    this.writes = this.writes.catch(() => undefined).then(async () => { await this.privateDirectory(state.temporaryRoot); const temporary = `${target}.${randomUUID()}.tmp`; await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, target); }); return this.writes;
  }
}
