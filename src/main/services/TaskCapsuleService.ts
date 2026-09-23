import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { validCapsuleSourceProof, type CapsuleSourceProof } from './CapsuleSource.ts';
import type { CapsuleReview, CapsuleApplyResult } from '../../shared/capsules.ts';
export type { CapsuleReview, CapsuleApplyResult } from '../../shared/capsules.ts';

const execute = promisify(execFile);
const MAX_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_FILE_BYTES;
const MAX_TASK_BYTES = 65_536;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_MANIFEST_BYTES = 12 * 1024 * 1024;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export type CapsuleDataClass = 'D0' | 'D1' | 'D2' | 'D3';
export interface CapsuleOwner { parentSessionId: string; generation: string; binding: string }
function validOwner(value: CapsuleOwner | undefined): boolean {
  return value === undefined || !!value && Object.keys(value).length === 3 && UUID.test(value.parentSessionId) && UUID.test(value.generation) && /^[a-f0-9]{64}$/u.test(value.binding);
}
export interface CreateTaskCapsule {
  sourceDirectory: string;
  files: string[];
  task: string;
  dataClass: CapsuleDataClass;
  provenance?: CapsuleSourceProof;
  owner?: CapsuleOwner;
  /** Authoritative classification of each selected source file; unknown must fail closed. */
  classifyFile: (relativePath: string) => CapsuleDataClass | Promise<CapsuleDataClass>;
}
export interface TaskCapsule {
  id: string;
  directory: string;
  sourceDirectory: string;
  files: string[];
  dataClass: CapsuleDataClass;
  provenance?: CapsuleSourceProof;
  owner?: CapsuleOwner;
}
export interface CapsuleLaunchMarker { name: string; token: string }
interface StoredReview { review: CapsuleReview; outputDigest: string; files: { path: string; data: string; mode: number; dev?: number; ino?: number }[]; task: string }
export interface Snapshot { contents: Buffer; mode: number; dev?: number; ino?: number }
interface CapsuleManifest {
  version: 1; installation: string; token: string; capsule: TaskCapsule;
  sourceDev: number; sourceIno: number; workspaceDev: number; workspaceIno: number; createdAt: number;
  phase: 'retained' | 'reserved' | 'running' | 'uncertain' | 'applying' | 'apply-recovery-needed'; leaseId?: string;
  review?: { id: string; digest: string; blobHash: string };
  applied?: CapsuleApplyResult;
  journalHash?: string;
  task: string; files: { path: string; data: string; mode: number; dev: number; ino: number }[];
}
interface CapsuleState { capsule: TaskCapsule; baseline: Map<string, Snapshot>; manifest?: CapsuleManifest; diskDigest?: string; unavailable?: string }
export interface RetainedCapsule extends TaskCapsule { state: 'retained' | 'running' | 'uncertain' | 'unavailable' | 'applied' | 'apply-recovery-needed'; createdAt: number; reason?: string; capturedBytes: number; recoveryReviewId?: string }

function validClass(value: unknown): value is CapsuleDataClass {
  return typeof value === 'string' && /^D[0-3]$/u.test(value);
}

export function assertSafeCapsulePath(path: string): void {
  if (typeof path !== 'string' || path.length > 1024 || isAbsolute(path) ||
    !/^[a-zA-Z0-9._@+ /-]+$/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.split('/').length > 20) {
    throw new Error(`Unsafe capsule path: ${String(path)}`);
  }
  if (path.toLowerCase() === 'task.md') throw new Error('Task.md is reserved for the capsule task.');
  const sensitive = path.split('/').some((part) => {
    const name = part.toLowerCase();
    return name.startsWith('.env') || /^\.(?:git|ssh|aws|azure|config|docker|gnupg)(?:[.-]|$)/u.test(name) ||
      /^\.(?:npmrc|pypirc|netrc|gitconfig|yarnrc)(?:[.-]|$)/u.test(name) ||
      /(?:^|[._-])(?:credentials?|secrets?|production|prod)(?:[._-]|$)/u.test(name) ||
      /\.(?:pem|key|p12|pfx|keystore)$/u.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(name);
  });
  if (sensitive) throw new Error(`Sensitive path is not allowed in a capsule: ${path}`);
}

async function checkComponents(root: string, path: string): Promise<void> {
  if (await realpath(root) !== root) throw new Error('Capsule directory must not be a symbolic link.');
  let current = root;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Invalid capsule directory: ${path}`);
  }
}

/** Bounded reads and no-follow checks are defense in depth, not an OS sandbox. */
export async function snapshotFile(root: string, path: string, maxBytes = MAX_FILE_BYTES): Promise<Snapshot> {
  await checkComponents(root, path);
  const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.mode & 0o7000) throw new Error(`Only regular, unlinked files without special mode bits are allowed: ${path}`);
    if (before.size > maxBytes) throw new Error(`Capsule file is too large: ${path}`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`Capsule file is too large: ${path}`);
    await checkComponents(root, path);
    const after = await lstat(join(root, path));
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.mode !== before.mode || after.size !== length || after.nlink !== 1) {
      throw new Error(`Capsule file changed during snapshot: ${path}`);
    }
    return { contents: Buffer.from(buffer.subarray(0, length)), mode: before.mode & 0o777, dev: before.dev, ino: before.ino };
  } finally { await handle.close(); }
}

export async function writeSnapshot(root: string, path: string, snapshot: Snapshot): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, snapshot.contents, { mode: snapshot.mode });
  await chmod(target, snapshot.mode);
}

async function temporaryOutside(source: string, prefix: string): Promise<string> {
  const base = await realpath(tmpdir());
  const relation = relative(source, base);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))) {
    throw new Error('A capsule needs a temporary directory outside the source directory.');
  }
  return mkdtemp(join(base, prefix));
}


export async function snapshotCapsuleDirectory(root: string, paths: Iterable<string>, marker?: CapsuleLaunchMarker, includeTask = true): Promise<{ current: Map<string, Snapshot>; task?: Snapshot }> {
  const selected = new Set(paths);
  if (marker && (!/^\.canvastty-container-[a-f0-9-]{36}$/u.test(marker.name) || !UUID.test(marker.token))) throw new Error('Invalid capsule launch marker.');
  const current = new Map<string, Snapshot>();
  let task: Snapshot | undefined;
  let entries = 0;
  let total = 0;
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    if (await realpath(directory) !== directory) throw new Error('Symbolic links are not allowed in capsules.');
    for await (const entry of await opendir(directory)) {
      if (++entries > MAX_FILES * 21 + 1) throw new Error('Capsule entry count limit exceeded.');
      const path = prefix + entry.name;
      if (marker?.name === path) {
        const markerFile = await snapshotFile(root, path, 128);
        if (markerFile.contents.toString('utf8') !== marker.token) throw new Error('Capsule launch marker changed.');
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path}`);
      if (entry.isDirectory()) {
        if (![...selected].some((file) => file.startsWith(`${path}/`))) throw new Error(`Unselected capsule directory: ${path}`);
        await walk(join(directory, entry.name), `${path}/`);
      } else {
        if (!(includeTask && path === 'Task.md') && !selected.has(path)) throw new Error(`Unselected capsule file: ${path}`);
        const snapshot = await snapshotFile(root, path, path === 'Task.md' ? MAX_TASK_BYTES : MAX_FILE_BYTES);
        total += snapshot.contents.length;
        if (total > MAX_TOTAL_BYTES) throw new Error('Capsule exceeds its total byte limit.');
        if (path !== 'Task.md') current.set(path, snapshot); else task = snapshot;
      }
    }
  };
  await walk(root);
  if (includeTask && !task) throw new Error('Capsule Task.md is missing; output retained.');
  return { current, task };
}

/** Copies an explicit file set. It limits disclosure; it does not restrict process access to the host. */
export class TaskCapsuleService {
  private readonly capsules = new Map<string, CapsuleState>();
  private readonly rootDirectory?: string;
  private installation?: string;
  private initialized?: Promise<void>;
  private creationQueue = Promise.resolve();
  private readonly busy = new Set<string>();
  private readonly sourceWrites = new Set<string>();
  private readonly beforeApplyWrite?: (path: string) => void | Promise<void>;
  constructor(options: { rootDirectory?: string; beforeApplyWrite?: (path: string) => void | Promise<void> } = {}) { this.rootDirectory = options.rootDirectory; this.beforeApplyWrite = options.beforeApplyWrite; }

  async recover(): Promise<void> { return this.initialized ??= this.readRegistry(); }
  private async privateDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || await realpath(path) !== path || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('Capsule storage must be a canonical private owned directory.');
  }
  private async privateFile(path: string, limit: number): Promise<string> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > limit || process.getuid && info.uid !== process.getuid()) throw new Error('Capsule metadata is not a bounded private file.');
      const bytes = Buffer.alloc(limit + 1); let length = 0;
      while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      const after = await file.stat();
      if (length > limit || info.size !== length || info.ctimeMs !== after.ctimeMs || info.mtimeMs !== after.mtimeMs) throw new Error('Capsule metadata changed during reading.');
      return bytes.subarray(0, length).toString('utf8');
    } finally { await file.close(); }
  }
  private async readRegistry(): Promise<void> {
    if (!this.rootDirectory) return;
    try { await this.privateDirectory(this.rootDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const names = await readdir(this.rootDirectory);
    if (names.length > 514) throw new Error('Capsule registry exceeds its bound.');
    this.installation = (await this.privateFile(join(this.rootDirectory, 'owner'), 128)).trim();
    if (!UUID.test(this.installation)) throw new Error('Invalid capsule installation identity.');
    let registryBytes = 0;
    for (const id of names.filter(name => UUID.test(name))) {
      const directory = join(this.rootDirectory, id, 'workspace');
      const state: CapsuleState = { capsule: { id, directory, sourceDirectory: '', files: [], dataClass: 'D3' }, baseline: new Map() };
      this.capsules.set(id, state);
      try {
        await this.privateDirectory(join(this.rootDirectory, id));
        registryBytes += (await lstat(join(this.rootDirectory, id, 'manifest.json'))).size;
        if (registryBytes > 128 * 1024 * 1024) throw new Error('Capsule registry storage budget exceeded.');
        const raw = await this.privateFile(join(this.rootDirectory, id, 'manifest.json'), MAX_MANIFEST_BYTES);
        const manifest: CapsuleManifest = JSON.parse(raw), capsule = manifest.capsule;
        if (manifest.version !== 1 || manifest.installation !== this.installation || !UUID.test(manifest.token) || capsule?.id !== id || capsule.directory !== directory || typeof capsule.sourceDirectory !== 'string' || !isAbsolute(capsule.sourceDirectory) || !validClass(capsule.dataClass) || !Array.isArray(capsule.files) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES || manifest.files.length !== capsule.files.length || !['retained', 'reserved', 'running', 'uncertain', 'applying', 'apply-recovery-needed'].includes(manifest.phase) || ['reserved', 'running', 'uncertain'].includes(manifest.phase) && !UUID.test(manifest.leaseId ?? '') || ['retained', 'applying', 'apply-recovery-needed'].includes(manifest.phase) && manifest.leaseId !== undefined || typeof manifest.task !== 'string' || Buffer.byteLength(manifest.task) > MAX_TASK_BYTES || ![manifest.sourceDev, manifest.sourceIno, manifest.workspaceDev, manifest.workspaceIno, manifest.createdAt].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid capsule manifest.');
        let total = Buffer.byteLength(manifest.task); const paths = new Set<string>();
        for (const [index, file] of manifest.files.entries()) {
          assertSafeCapsulePath(file.path);
          if (file.path !== capsule.files[index] || paths.has(file.path.toLowerCase()) || typeof file.data !== 'string' || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || ![file.dev, file.ino].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid capsule baseline.');
          paths.add(file.path.toLowerCase()); const contents = Buffer.from(file.data, 'base64'); total += contents.length;
          if (contents.toString('base64') !== file.data || contents.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('Capsule baseline exceeds its bound.');
          state.baseline.set(file.path, { contents, mode: file.mode, dev: file.dev, ino: file.ino });
        }
        state.manifest = manifest; state.capsule = capsule; state.diskDigest = hash(raw);
        if (capsule.provenance !== undefined && !validCapsuleSourceProof(capsule.provenance)) throw new Error('Invalid capsule source provenance.');
        if (!validOwner(capsule.owner)) throw new Error('Invalid capsule ownership.');
        await this.verify(state);
        if (manifest.phase !== 'retained') { manifest.phase = ['applying', 'apply-recovery-needed'].includes(manifest.phase) ? 'apply-recovery-needed' : 'uncertain'; await this.persist(state); }
      } catch (error) { state.unavailable = error instanceof Error ? error.message : 'Capsule recovery failed.'; }
    }
  }
  private async verify(state: CapsuleState): Promise<void> {
    if (state.unavailable) throw new Error(state.unavailable);
    if (!state.manifest) return;
    const root = this.rootDirectory!, parent = join(root, state.capsule.id), m = state.manifest;
    await this.privateDirectory(root); await this.privateDirectory(parent); await this.privateDirectory(state.capsule.directory);
    if ((await this.privateFile(join(root, 'owner'), 128)).trim() !== this.installation || (await this.privateFile(join(parent, 'owner'), 128)).trim() !== m.token || hash(await this.privateFile(join(parent, 'manifest.json'), MAX_MANIFEST_BYTES)) !== state.diskDigest) throw new Error('Capsule ownership or manifest changed; output retained.');
    const source = await lstat(state.capsule.sourceDirectory), workspace = await lstat(state.capsule.directory);
    if (!source.isDirectory() || await realpath(state.capsule.sourceDirectory) !== state.capsule.sourceDirectory || source.dev !== m.sourceDev || source.ino !== m.sourceIno || workspace.dev !== m.workspaceDev || workspace.ino !== m.workspaceIno) throw new Error('Capsule source or workspace identity changed; output retained.');
  }
  private async persist(state: CapsuleState): Promise<void> {
    if (!state.manifest) return;
    const parent = join(this.rootDirectory!, state.capsule.id); await this.privateDirectory(parent);
    const raw = JSON.stringify(state.manifest); if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) throw new Error('Capsule metadata exceeds its bound.');
    await this.writePrivate(parent, 'manifest.json', raw); state.diskDigest = hash(raw);
  }
  private async writePrivate(parent: string, name: string, raw: string): Promise<void> {
    await this.privateDirectory(parent);
    const temporary = join(parent, randomUUID() + '.tmp'); const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(parent, name));
  }
  private require(id: string): CapsuleState {
    const state = this.capsules.get(id); if (!state || !UUID.test(id)) throw new Error('Unknown task capsule.');
    if (state.unavailable) throw new Error(state.unavailable); return state;
  }
  describe(id: string): TaskCapsule { return structuredClone(this.require(id).capsule); }
  async inspect(id: string): Promise<TaskCapsule> { return this.exclusive(id, async state => { await this.snapshotOutput(state); return structuredClone(state.capsule); }); }
  private async exclusive<T>(id: string, operation: (state: CapsuleState) => Promise<T>): Promise<T> {
    await this.recover(); const state = this.require(id);
    if (this.busy.has(id)) throw new Error('Capsule is busy; output retained.'); this.busy.add(id);
    try { await this.verify(state); return await operation(state); } finally { this.busy.delete(id); }
  }
  private idle(state: CapsuleState): void { if (state.manifest && state.manifest.phase !== 'retained') throw new Error('Capsule process is running or termination is unconfirmed; output retained.'); }
  async list(): Promise<RetainedCapsule[]> {
    await this.recover(); return [...this.capsules.values()].map(state => this.retainedSummary(state));
  }
  async summary(id: string): Promise<RetainedCapsule> {
    await this.recover();
    const state = this.capsules.get(id);
    if (!state) throw new Error('Unknown task capsule.');
    return this.retainedSummary(state);
  }
  private retainedSummary(state: CapsuleState): RetainedCapsule {
    const manifest = state.manifest;
    let status: RetainedCapsule['state'] = 'retained';
    if (state.unavailable) status = 'unavailable';
    else if (manifest?.phase === 'running') status = 'running';
    else if (manifest?.phase === 'applying' || manifest?.phase === 'apply-recovery-needed') status = 'apply-recovery-needed';
    else if (manifest && manifest.phase !== 'retained') status = 'uncertain';
    else if (manifest?.applied) status = 'applied';
    return {
      ...structuredClone(state.capsule),
      capturedBytes: [...state.baseline.values()].reduce((sum, file) => sum + file.contents.length, Buffer.byteLength(manifest?.task ?? '')),
      state: status,
      createdAt: manifest?.createdAt ?? 0,
      ...(manifest?.review?.id && UUID.test(manifest.review.id) && ['applying', 'apply-recovery-needed'].includes(manifest.phase) ? { recoveryReviewId: manifest.review.id } : {}),
      ...(state.unavailable ? { reason: state.unavailable } : {})
    };
  }
  async reserve(id: string, leaseId: string): Promise<string> { return this.exclusive(id, async state => { this.idle(state); if (!state.manifest || !UUID.test(leaseId)) throw new Error('Durable capsule lease required.'); if (state.manifest.applied) throw new Error('Applied capsules need a new source capture before another agent launch.'); const digest = this.outputDigest(await this.snapshotOutput(state)); state.manifest.phase = 'reserved'; state.manifest.leaseId = leaseId; await this.persist(state); return digest; }); }
  async verifyLaunch(id: string, leaseId: string, digest: string, marker?: CapsuleLaunchMarker): Promise<TaskCapsule> {
    return this.exclusive(id, async state => {
      if (this.outputDigest(await this.snapshotOutput(state, { leaseId, marker })) !== digest) throw new Error('Capsule payload changed during launch. Prepare again.');
      return structuredClone(state.capsule);
    });
  }
  async retainUncertain(id: string, leaseId: string): Promise<void> { await this.exclusive(id, async state => { if (state.manifest?.leaseId !== leaseId) return; state.manifest.phase = 'uncertain'; await this.persist(state); }); }
  async setRunning(id: string, leaseId: string): Promise<void> { await this.exclusive(id, async state => { if (!state.manifest || state.manifest.phase !== 'reserved' || state.manifest.leaseId !== leaseId) throw new Error('Capsule lease changed.'); state.manifest.phase = 'running'; await this.persist(state); }); }
  async confirmContainerStopped(id: string, leaseId: string): Promise<void> { await this.exclusive(id, async state => { if (state.manifest?.leaseId !== leaseId) return; state.manifest.phase = 'retained'; delete state.manifest.leaseId; await this.persist(state); }); }

  async create(input: CreateTaskCapsule): Promise<TaskCapsule> {
    input = { ...input, files: Array.isArray(input.files) ? [...input.files] : input.files };
    let result!: TaskCapsule;
    const operation = this.creationQueue.catch(() => undefined).then(async () => { result = await this.createOwned(input); });
    this.creationQueue = operation; await operation; return result;
  }
  private async createOwned(input: CreateTaskCapsule): Promise<TaskCapsule> {
    await this.recover();
    if (!validOwner(input.owner)) throw new Error('Invalid capsule ownership.');
    if (!validClass(input.dataClass) || typeof input.classifyFile !== 'function') throw new Error('A valid capsule data classification is required.');
    if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > MAX_FILES) throw new Error(`Capsule file count must be 1–${MAX_FILES}.`);
    if (typeof input.task !== 'string' || Buffer.byteLength(input.task) > MAX_TASK_BYTES) throw new Error('Capsule task is too large.');
    const paths = new Set<string>();
    for (const path of input.files) {
      assertSafeCapsulePath(path);
      if (paths.has(path.toLowerCase())) throw new Error(`Duplicate capsule file: ${path}`);
      paths.add(path.toLowerCase());
    }
    const sourceDirectory = await realpath(input.sourceDirectory);
    if (!(await lstat(sourceDirectory)).isDirectory()) throw new Error('Capsule source must be a directory.');
    const baseline = new Map<string, Snapshot>();
    let total = Buffer.byteLength(input.task);
    for (const path of input.files) {
      const classification = await input.classifyFile(path);
      if (!validClass(classification)) throw new Error(`Missing or invalid file classification: ${path}`);
      if (classification > input.dataClass) throw new Error(`File ${path} is ${classification}, above capsule class ${input.dataClass}.`);
      const snapshot = await snapshotFile(sourceDirectory, path);
      total += snapshot.contents.length;
      if (total > MAX_TOTAL_BYTES) throw new Error('Capsule exceeds its total byte limit.');
      baseline.set(path, snapshot);
    }
    const id = randomUUID(); let directory: string;
    if (this.rootDirectory) {
      if (this.capsules.size >= 512 || [...this.capsules.values()].reduce((sum, state) => sum + (state.manifest ? Buffer.byteLength(JSON.stringify(state.manifest)) : MAX_MANIFEST_BYTES) * 4, total * 6) > 512 * 1024 * 1024) throw new Error('Capsule registry storage budget reached; retained output is never evicted.');
      const relation = relative(sourceDirectory, this.rootDirectory);
      if (!isAbsolute(this.rootDirectory) || !relation || relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)) throw new Error('Capsule storage must be outside the source directory.');
      await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 }); await this.privateDirectory(this.rootDirectory);
      if ((await readdir(this.rootDirectory)).length >= 513) throw new Error('Capsule registry limit reached; partial records are retained.');
      if (!this.installation) { this.installation = randomUUID(); await writeFile(join(this.rootDirectory, 'owner'), this.installation, { flag: 'wx', mode: 0o600 }); }
      if ((await this.privateFile(join(this.rootDirectory, 'owner'), 128)).trim() !== this.installation) throw new Error('Capsule storage ownership changed.');
      await mkdir(join(this.rootDirectory, id), { mode: 0o700 }); directory = join(this.rootDirectory, id, 'workspace'); await mkdir(directory, { mode: 0o700 });
    } else directory = await temporaryOutside(sourceDirectory, 'canvastty-capsule-');
    try {
      for (const [path, snapshot] of baseline) await writeSnapshot(directory, path, snapshot);
      await writeFile(join(directory, 'Task.md'), input.task, { mode: 0o600 });
      if (input.provenance !== undefined && !validCapsuleSourceProof(input.provenance)) throw new Error('Invalid capsule source provenance.');
      const capsule: TaskCapsule = { id, directory, sourceDirectory, files: [...baseline.keys()], dataClass: input.dataClass, ...(input.provenance ? { provenance: structuredClone(input.provenance) } : {}), ...(input.owner ? { owner: structuredClone(input.owner) } : {}) };
      const state: CapsuleState = { capsule, baseline };
      if (this.rootDirectory) {
        const source = await lstat(sourceDirectory), workspace = await lstat(directory);
        state.manifest = { version: 1, installation: this.installation!, token: randomUUID(), capsule, sourceDev: source.dev, sourceIno: source.ino, workspaceDev: workspace.dev, workspaceIno: workspace.ino, createdAt: Date.now(), phase: 'retained', task: input.task, files: [...baseline].map(([path, snapshot]) => ({ path, data: snapshot.contents.toString('base64'), mode: snapshot.mode, dev: snapshot.dev!, ino: snapshot.ino! })) };
        await writeFile(join(this.rootDirectory, id, 'owner'), state.manifest.token, { flag: 'wx', mode: 0o600 }); await this.persist(state);
      }
      this.capsules.set(capsule.id, state);
      return { ...capsule, files: [...capsule.files] };
    } catch (error) {
      if (!this.rootDirectory) await rm(directory, { recursive: true, force: true });
      else this.capsules.set(id, { capsule: { id, directory, sourceDirectory, files: [...baseline.keys()], dataClass: input.dataClass }, baseline, unavailable: 'Capsule preparation failed; partial files retained.' });
      throw error;
    }
  }

  async review(id: string, policyDigest?: string): Promise<CapsuleReview> {
    return this.exclusive(id, async state => {
      const output = await this.snapshotOutput(state);
      const result = await this.reviewOwned(state, output.current), outputDigest = this.outputDigest(output);
      if (outputDigest !== this.outputDigest(await this.snapshotOutput(state))) throw new Error('Capsule output changed; review again.');
      const review: CapsuleReview = { ...result, workspaceId: id, reviewId: randomUUID(), createdAt: Date.now(), ...(policyDigest ? { policyDigest } : {}), digest: hash(JSON.stringify([state.capsule, state.manifest?.files, outputDigest, result.patch, policyDigest])) };
      if (state.manifest) {
        const stored: StoredReview = { review, outputDigest, files: [...output.current].map(([path, snapshot]) => ({ path, data: snapshot.contents.toString('base64'), mode: snapshot.mode, dev: snapshot.dev, ino: snapshot.ino })), task: output.task.contents.toString('base64') };
        const raw = JSON.stringify(stored);
        if (Buffer.byteLength(raw) > 16 * 1024 * 1024 || Buffer.byteLength(review.patch) > 2 * 1024 * 1024) throw new Error('Capsule review exceeds its storage or patch bound; output retained.');
        await this.verify(state); await this.writePrivate(join(this.rootDirectory!, id), 'review.json', raw);
        state.manifest.review = { id: review.reviewId, digest: review.digest, blobHash: hash(raw) }; await this.persist(state);
      }
      return review;
    });
  }
  private outputDigest(output: { current: Map<string, Snapshot>; task: Snapshot }): string {
    return hash(JSON.stringify([[...output.current].sort(([a], [b]) => a.localeCompare(b)), output.task]));
  }
  private async storedReview(state: CapsuleState, reviewId: string): Promise<StoredReview> {
    if (!UUID.test(reviewId) || state.manifest?.review?.id !== reviewId) throw new Error('Capsule review expired. Review again.');
    const raw = await this.privateFile(join(this.rootDirectory!, state.capsule.id, 'review.json'), 16 * 1024 * 1024);
    if (hash(raw) !== state.manifest.review.blobHash) throw new Error('Stored capsule review changed; output retained.');
    const stored: StoredReview = JSON.parse(raw);
    if (stored.review?.reviewId !== reviewId || stored.review.workspaceId !== state.capsule.id || stored.review.digest !== state.manifest.review.digest || !Array.isArray(stored.files) || stored.files.length > MAX_FILES) throw new Error('Invalid stored capsule review.');
    return stored;
  }
  async exportReview(id: string, reviewId: string, requireCurrent = false): Promise<CapsuleReview> { return this.exclusive(id, async state => { const stored = await this.storedReview(state, reviewId); if (requireCurrent && stored.outputDigest !== this.outputDigest(await this.snapshotOutput(state))) throw new Error('Capsule output changed. Review again.'); return structuredClone(stored.review); }); }
  /** Main-only frozen bytes for a separate test mount; never accepts a renderer patch. */
  async frozenTestFiles(id: string, reviewId: string): Promise<{ review: CapsuleReview; files: { path: string; contents: Buffer; mode: number }[] }> {
    return this.exclusive(id, async state => {
      this.idle(state);
      const stored = await this.storedReview(state, reviewId);
      if (stored.outputDigest !== this.outputDigest(await this.snapshotOutput(state))) throw new Error('Capsule output changed. Review again.');
      return { review: structuredClone(stored.review), files: stored.files.map(file => ({ path: file.path, contents: Buffer.from(file.data, 'base64'), mode: file.mode })) };
    });
  }
  async apply(id: string, reviewId: string, assertCurrent: () => void = () => {}): Promise<CapsuleApplyResult> {
    return this.exclusive(id, async state => {
      this.idle(state);
      const stored = await this.storedReview(state, reviewId), manifest = state.manifest!;
      assertCurrent();
      if (manifest.applied?.reviewId === reviewId && manifest.applied.digest === stored.review.digest) return structuredClone(manifest.applied);
      if (stored.outputDigest !== this.outputDigest(await this.snapshotOutput(state))) throw new Error('Capsule output changed. Review again before applying.');
      const targets = stored.review.changedFiles.map(path => join(state.capsule.sourceDirectory, path));
      if (targets.some(path => this.sourceWrites.has(path))) throw new Error('Source files are busy with another capsule apply.');
      targets.forEach(path => this.sourceWrites.add(path));
      const handles = new Map<string, Awaited<ReturnType<typeof open>>>();
      const after = new Map(stored.files.map(file => [file.path, { contents: Buffer.from(file.data, 'base64'), mode: file.mode }]));
      const completed: string[] = [];
      const journal = { version: 1, workspaceId: id, reviewId, digest: stored.review.digest, state: 'applying', completed, entries: stored.review.changedFiles.map(path => ({ path, before: manifest.files.find(file => file.path === path), after: stored.files.find(file => file.path === path) ?? null })) };
      const saveJournal = async (): Promise<void> => {
        const raw = JSON.stringify(journal); if (Buffer.byteLength(raw) > 24 * 1024 * 1024) throw new Error('Capsule apply journal exceeds its bound.');
        await this.writePrivate(join(this.rootDirectory!, id), 'apply.json', raw); manifest.journalHash = hash(raw); await this.persist(state);
      };
      const matches = (actual: Snapshot, expected: Snapshot, identity = true): boolean => actual.contents.equals(expected.contents) && actual.mode === expected.mode && (!identity || actual.dev === expected.dev && actual.ino === expected.ino);
      try {
        // Validate every changed target before the first write; keep its no-follow handle open.
        for (const path of stored.review.changedFiles) {
          const baseline = state.baseline.get(path); if (!baseline) throw new Error('Review contains an unselected source path.');
          let actual: Snapshot;
          try { actual = await snapshotFile(state.capsule.sourceDirectory, path); } catch { throw new Error('Source file changed or is unavailable; no changes applied.'); }
          if (!matches(actual, baseline)) throw new Error('Source file changed since capsule creation; no changes applied.');
          const handle = await open(join(state.capsule.sourceDirectory, path), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          handles.set(path, handle); const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1 || info.dev !== baseline.dev || info.ino !== baseline.ino) throw new Error('Source file changed before apply.');
        }
        await this.verify(state); assertCurrent(); manifest.phase = 'applying'; await saveJournal();
        try {
          for (const path of stored.review.changedFiles) {
            await this.beforeApplyWrite?.(path);
            const baseline = state.baseline.get(path)!, target = after.get(path);
            if (!matches(await snapshotFile(state.capsule.sourceDirectory, path), baseline)) throw new Error('Source changed during apply.');
            assertCurrent();
            if (target) {
              const handle = handles.get(path)!;
              await handle.writeFile(target.contents); await handle.truncate(target.contents.length);
              await handle.chmod((baseline.mode & ~0o111) | (target.mode & 0o111)); await handle.sync();
              const actual = await snapshotFile(state.capsule.sourceDirectory, path);
              if (!matches(actual, { ...baseline, contents: target.contents, mode: (baseline.mode & ~0o111) | (target.mode & 0o111) })) throw new Error('Source changed while writing reviewed bytes.');
            } else await rm(join(state.capsule.sourceDirectory, path), { force: false });
            completed.push(path); await saveJournal();
          }
          const applied: CapsuleApplyResult = { workspaceId: id, reviewId, digest: stored.review.digest, appliedAt: Date.now() };
          assertCurrent();
          manifest.applied = applied; manifest.phase = 'retained'; journal.state = 'applied'; await saveJournal();
          return structuredClone(applied);
        } catch (error) {
          // Only roll back bytes that still equal our exact recorded write. Never overwrite a new user edit.
          let rolledBack = true;
          for (const path of [...completed].reverse()) {
            const baseline = state.baseline.get(path)!, target = after.get(path);
            try {
              if (target) {
                const expected = { ...baseline, contents: target.contents, mode: (baseline.mode & ~0o111) | (target.mode & 0o111) };
                if (!matches(await snapshotFile(state.capsule.sourceDirectory, path), expected)) throw new Error('Source no longer matches applied bytes.');
                const handle = handles.get(path)!; await handle.write(baseline.contents, 0, baseline.contents.length, 0); await handle.truncate(baseline.contents.length); await handle.chmod(baseline.mode); await handle.sync();
              } else {
                const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined;
                if (parentPath) await checkComponents(state.capsule.sourceDirectory, parentPath);
                const handle = await open(join(state.capsule.sourceDirectory, path), 'wx', baseline.mode);
                try { await handle.writeFile(baseline.contents); await handle.chmod(baseline.mode); await handle.sync(); } finally { await handle.close(); }
                const restored = await snapshotFile(state.capsule.sourceDirectory, path); baseline.dev = restored.dev; baseline.ino = restored.ino;
                const entry = manifest.files.find(file => file.path === path)!; entry.dev = restored.dev!; entry.ino = restored.ino!;
              }
            } catch { rolledBack = false; }
          }
          // A failed in-progress write may have changed bytes before completion was recorded.
          for (const path of stored.review.changedFiles) {
            try { if (!matches(await snapshotFile(state.capsule.sourceDirectory, path), state.baseline.get(path)!)) rolledBack = false; } catch { rolledBack = false; }
          }
          delete manifest.applied;
          manifest.phase = rolledBack ? 'retained' : 'apply-recovery-needed'; journal.state = rolledBack ? 'rolled-back' : 'recovery-needed';
          await saveJournal().catch(() => { manifest.phase = 'apply-recovery-needed'; });
          throw new Error(rolledBack && manifest.phase === 'retained' ? 'Capsule apply failed and was rolled back; reviewed output retained.' : 'Capsule apply needs recovery. Journal and reviewed output retained; source was not overwritten with uncertain bytes.', { cause: error });
        }
      } finally {
        await Promise.all([...handles.values()].map(handle => handle.close())); targets.forEach(path => this.sourceWrites.delete(path));
      }
    });
  }
  /** Explicit rollback only where source still equals either the baseline or the exact reviewed write. */
  async recoverApply(id: string, reviewId: string, assertCurrent: () => void = () => {}): Promise<void> {
    await this.exclusive(id, async state => {
      assertCurrent();
      const manifest = state.manifest;
      if (!manifest || manifest.phase !== 'apply-recovery-needed' || !manifest.journalHash) throw new Error('Capsule has no recoverable apply journal.');
      const stored = await this.storedReview(state, reviewId), parent = join(this.rootDirectory!, id);
      const raw = await this.privateFile(join(parent, 'apply.json'), 24 * 1024 * 1024);
      if (hash(raw) !== manifest.journalHash) throw new Error('Apply journal changed; manual source inspection required.');
      const journal = JSON.parse(raw);
      if (journal.version !== 1 || journal.workspaceId !== id || journal.reviewId !== reviewId || journal.digest !== stored.review.digest) throw new Error('Apply recovery identity changed.');
      const targets = stored.review.changedFiles.map(path => join(state.capsule.sourceDirectory, path));
      if (targets.some(path => this.sourceWrites.has(path))) throw new Error('Source files are busy.');
      targets.forEach(path => this.sourceWrites.add(path));
      const pending: { path: string; baseline: Snapshot; current?: Snapshot }[] = [];
      try {
        // Classify every target first. Unknown bytes are never an instruction to overwrite them.
        for (const path of stored.review.changedFiles) {
          const baseline = state.baseline.get(path); if (!baseline) throw new Error('Invalid source path in recovery.');
          const target = stored.files.find(file => file.path === path);
          let current: Snapshot | undefined;
          try { current = await snapshotFile(state.capsule.sourceDirectory, path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (current?.contents.equals(baseline.contents) && current.mode === baseline.mode) continue;
          if (target ? !current || !current.contents.equals(Buffer.from(target.data, 'base64')) || current.mode !== ((baseline.mode & ~0o111) | (target.mode & 0o111)) || current.dev !== baseline.dev || current.ino !== baseline.ino : current !== undefined) throw new Error('Source has new user edits; recovery retained without overwriting them.');
          pending.push({ path, baseline, current });
        }
        for (const { path, baseline, current } of pending) {
          await this.verify(state);
          if (current) {
            const latest = await snapshotFile(state.capsule.sourceDirectory, path);
            if (!latest.contents.equals(current.contents) || latest.dev !== current.dev || latest.ino !== current.ino || latest.mode !== current.mode) throw new Error('Source changed during recovery.');
          } else {
            const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined;
            if (parentPath) await checkComponents(state.capsule.sourceDirectory, parentPath);
          }
          assertCurrent();
          const handle = await open(join(state.capsule.sourceDirectory, path), current ? constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK : 'wx', baseline.mode);
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink !== 1 || current && (info.dev !== current.dev || info.ino !== current.ino)) throw new Error('Source identity changed during recovery.');
            assertCurrent();
            await handle.writeFile(baseline.contents); await handle.truncate(baseline.contents.length); await handle.chmod(baseline.mode); await handle.sync();
          } finally { await handle.close(); }
          const restored = await snapshotFile(state.capsule.sourceDirectory, path);
          if (!restored.contents.equals(baseline.contents) || restored.mode !== baseline.mode) throw new Error('Source changed after recovery.');
          baseline.dev = restored.dev; baseline.ino = restored.ino;
          const entry = manifest.files.find(file => file.path === path)!; entry.dev = restored.dev!; entry.ino = restored.ino!;
        }
        journal.state = 'rolled-back'; const updated = JSON.stringify(journal);
        await this.writePrivate(parent, 'apply.json', updated); manifest.journalHash = hash(updated);
        manifest.phase = 'retained'; delete manifest.applied; await this.persist(state);
      } finally { targets.forEach(path => this.sourceWrites.delete(path)); }
    });
  }
  private async snapshotOutput(state: CapsuleState, launch?: { leaseId: string; marker?: CapsuleLaunchMarker }): Promise<{ current: Map<string, Snapshot>; task: Snapshot }> {
    if (launch) {
      if (!state.manifest || !['reserved', 'running'].includes(state.manifest.phase) || state.manifest.leaseId !== launch.leaseId) throw new Error('Capsule launch lease changed.');
      if (launch.marker && (!/^\.canvastty-container-[a-f0-9-]{36}$/u.test(launch.marker.name) || !UUID.test(launch.marker.token))) throw new Error('Invalid capsule launch marker.');
    } else this.idle(state);
    const output = await snapshotCapsuleDirectory(state.capsule.directory, state.baseline.keys(), launch?.marker);
    return { current: output.current, task: output.task! };
  }
  private async reviewOwned(state: CapsuleState, current: Map<string, Snapshot>): Promise<Pick<CapsuleReview, 'patch' | 'changedFiles'>> {
    const changedFiles = [...state.baseline.keys()].filter((path) => {
      const before = state.baseline.get(path)!;
      const after = current.get(path);
      return !after || before.mode !== after.mode || !before.contents.equals(after.contents);
    });
    if (!changedFiles.length) return { patch: '', changedFiles };
    const staging = await temporaryOutside(state.capsule.sourceDirectory, 'canvastty-capsule-review-');
    try {
      await mkdir(join(staging, 'before'));
      await mkdir(join(staging, 'after'));
      for (const path of changedFiles) {
        await writeSnapshot(join(staging, 'before'), path, state.baseline.get(path)!);
        const snapshot = current.get(path);
        if (snapshot) await writeSnapshot(join(staging, 'after'), path, snapshot);
      }
      let patchBytes: Buffer;
      try {
        ({ stdout: patchBytes } = await execute('git', ['-c', 'core.quotePath=false', '-c', 'core.fileMode=true', 'diff', '--no-index', '--no-color', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--', 'before', 'after'], { cwd: staging, env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' }, maxBuffer: state.manifest ? 2 * 1024 * 1024 : MAX_TOTAL_BYTES * 4, timeout: 15_000, encoding: 'buffer' }));
      } catch (error) {
        const result = error as { code?: unknown; stdout?: Buffer };
        if (result.code !== 1 || !Buffer.isBuffer(result.stdout)) throw error;
        patchBytes = result.stdout;
      }
      let patch = new TextDecoder('utf-8', { fatal: true }).decode(patchBytes);
      // Only generated header lines are rewritten; source content remains byte-for-byte intact.
      patch = patch.split('\n').map((line) => {
        if (line.startsWith('diff --git ')) return line.replace(/a\/(?:before|after)\//u, 'a/').replace(/b\/(?:before|after)\//u, 'b/');
        if (line.startsWith('--- a/before/')) return line.replace('--- a/before/', '--- a/');
        if (line.startsWith('+++ b/after/')) return line.replace('+++ b/after/', '+++ b/');
        return line;
      }).join('\n');
      return { patch, changedFiles };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async cleanup(id: string): Promise<void> {
    await this.exclusive(id, async state => {
      if (state.manifest) {
        this.idle(state); if ((await this.reviewOwned(state, (await this.snapshotOutput(state)).current)).changedFiles.length) throw new Error('Capsule has changed output; retained.');
        const task = await snapshotFile(state.capsule.directory, 'Task.md', MAX_TASK_BYTES);
        if (!task.contents.equals(Buffer.from(state.manifest.task))) throw new Error('Capsule task changed; output retained.');
        await this.verify(state);
      }
      await rm(this.rootDirectory ? join(this.rootDirectory, id) : state.capsule.directory, { recursive: true, force: false });
      this.capsules.delete(id);
    });
  }

  async dispose(): Promise<void> {
    await this.creationQueue.catch(() => undefined);
    if (!this.rootDirectory) for (const id of this.capsules.keys()) await this.cleanup(id);
  }
}
