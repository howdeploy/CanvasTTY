import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_FILE_BYTES;
const MAX_TASK_BYTES = 65_536;

export type CapsuleDataClass = 'D0' | 'D1' | 'D2' | 'D3';
export interface CreateTaskCapsule {
  sourceDirectory: string;
  files: string[];
  task: string;
  dataClass: CapsuleDataClass;
  /** Authoritative classification of each selected source file; unknown must fail closed. */
  classifyFile: (relativePath: string) => CapsuleDataClass | Promise<CapsuleDataClass>;
}
export interface TaskCapsule {
  id: string;
  directory: string;
  sourceDirectory: string;
  files: string[];
  dataClass: CapsuleDataClass;
}
export interface CapsuleReview {
  patch: string;
  changedFiles: string[];
}
interface Snapshot { contents: Buffer; mode: number }
interface CapsuleState { capsule: TaskCapsule; baseline: Map<string, Snapshot> }

function validClass(value: unknown): value is CapsuleDataClass {
  return typeof value === 'string' && /^D[0-3]$/u.test(value);
}

function assertSafePath(path: string): void {
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
async function snapshotFile(root: string, path: string, maxBytes = MAX_FILE_BYTES): Promise<Snapshot> {
  await checkComponents(root, path);
  const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error(`Only regular, unlinked files are allowed: ${path}`);
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
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== length) {
      throw new Error(`Capsule file changed during snapshot: ${path}`);
    }
    return { contents: Buffer.from(buffer.subarray(0, length)), mode: before.mode & 0o111 ? 0o755 : 0o644 };
  } finally { await handle.close(); }
}

async function writeSnapshot(root: string, path: string, snapshot: Snapshot): Promise<void> {
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

/** Copies an explicit file set. It limits disclosure; it does not restrict process access to the host. */
export class TaskCapsuleService {
  private readonly capsules = new Map<string, CapsuleState>();

  async create(input: CreateTaskCapsule): Promise<TaskCapsule> {
    if (!validClass(input.dataClass) || typeof input.classifyFile !== 'function') throw new Error('A valid capsule data classification is required.');
    if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > MAX_FILES) throw new Error(`Capsule file count must be 1–${MAX_FILES}.`);
    if (typeof input.task !== 'string' || Buffer.byteLength(input.task) > MAX_TASK_BYTES) throw new Error('Capsule task is too large.');
    const paths = new Set<string>();
    for (const path of input.files) {
      assertSafePath(path);
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
    const directory = await temporaryOutside(sourceDirectory, 'canvastty-capsule-');
    try {
      for (const [path, snapshot] of baseline) await writeSnapshot(directory, path, snapshot);
      await writeFile(join(directory, 'Task.md'), input.task, { mode: 0o600 });
      const capsule: TaskCapsule = { id: randomUUID(), directory, sourceDirectory, files: [...baseline.keys()], dataClass: input.dataClass };
      this.capsules.set(capsule.id, { capsule, baseline });
      return { ...capsule, files: [...capsule.files] };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async review(id: string): Promise<CapsuleReview> {
    const state = this.capsules.get(id);
    if (!state) throw new Error('Unknown task capsule.');
    const current = new Map<string, Snapshot>();
    let entries = 0;
    let total = 0;
    const walk = async (directory: string, prefix = ''): Promise<void> => {
      if (await realpath(directory) !== directory) throw new Error('Symbolic links are not allowed in capsules.');
      for await (const entry of await opendir(directory)) {
        if (++entries > MAX_FILES * 21 + 1) throw new Error('Capsule entry count limit exceeded.');
        const path = prefix + entry.name;
        if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path}`);
        if (entry.isDirectory()) {
          if (![...state.baseline.keys()].some((file) => file.startsWith(`${path}/`))) throw new Error(`Unselected capsule directory: ${path}`);
          await walk(join(directory, entry.name), `${path}/`);
        } else {
          if (path !== 'Task.md' && !state.baseline.has(path)) throw new Error(`Unselected capsule file: ${path}`);
          const snapshot = await snapshotFile(state.capsule.directory, path, path === 'Task.md' ? MAX_TASK_BYTES : MAX_FILE_BYTES);
          total += snapshot.contents.length;
          if (total > MAX_TOTAL_BYTES) throw new Error('Capsule exceeds its total byte limit.');
          if (path !== 'Task.md') current.set(path, snapshot);
        }
      }
    };
    await walk(state.capsule.directory);
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
      let patch: string;
      try {
        ({ stdout: patch } = await execute('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-color', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--', 'before', 'after'], { cwd: staging, maxBuffer: MAX_TOTAL_BYTES * 4, timeout: 15_000, encoding: 'utf8' }));
      } catch (error) {
        const result = error as { code?: unknown; stdout?: string };
        if (result.code !== 1 || typeof result.stdout !== 'string') throw error;
        patch = result.stdout;
      }
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
    const state = this.capsules.get(id);
    if (!state) return;
    await rm(state.capsule.directory, { recursive: true, force: true });
    this.capsules.delete(id);
  }

  async dispose(): Promise<void> {
    for (const id of this.capsules.keys()) await this.cleanup(id);
  }
}
