import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AppSettings } from '../../shared/contracts.ts';
import { assertCapsuleTestProfile, type CapsuleTestProfile, type CapsuleTestRun, type CapsuleTestSummary } from '../../shared/capsules.ts';
import { assertSafeCapsulePath, snapshotCapsuleDirectory, writeSnapshot, type CapsuleLaunchMarker } from './TaskCapsuleService.ts';
import type { CapsuleLaunchService } from './CapsuleLaunchService.ts';
import type { ContainerExecutionService } from './ContainerExecutionService.ts';
import { runCapsuleTestProcess, type TestProcessRunner } from './CapsuleTestProcess.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): string => digest(JSON.stringify(value));
type TestSettings = Pick<AppSettings, 'capsuleTestProfiles'>;
interface TestManifest {
  version: 1; installation: string; token: string; lease: string; run: CapsuleTestRun; profile: CapsuleTestProfile;
  directoryDev: number; directoryIno: number; snapshotBytes: number;
  files: { path: string; hash: string; mode: number; dev: number; ino: number }[];
}
interface Entry { manifest: TestManifest; diskDigest: string; unavailable?: string; writing?: Promise<void> }
interface Options { rootDirectory: string; runner?: TestProcessRunner }

/** Saved fixed commands over private frozen snapshots. This service never prepares provider credentials. */
export class CapsuleTestService {
  private readonly capsules: CapsuleLaunchService;
  private readonly containers: ContainerExecutionService;
  private readonly settings: () => TestSettings;
  private readonly root: string;
  private readonly runner: TestProcessRunner;
  private installation?: string;
  private initialization?: Promise<void>;
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private starting = false;
  private closing = false;

  constructor(capsules: CapsuleLaunchService, containers: ContainerExecutionService, settings: () => TestSettings, options: Options) {
    this.capsules = capsules; this.containers = containers; this.settings = settings; this.root = options.rootDirectory; this.runner = options.runner ?? runCapsuleTestProcess;
  }
  private profile(id: string): CapsuleTestProfile {
    const value = this.settings().capsuleTestProfiles?.find(item => item.id === id); assertCapsuleTestProfile(value); return structuredClone(value);
  }
  profiles(): Pick<CapsuleTestProfile, 'id' | 'label' | 'containerProfileId' | 'timeoutMs' | 'outputBytes'>[] {
    return (this.settings().capsuleTestProfiles ?? []).flatMap(profile => {
      try { assertCapsuleTestProfile(profile); if (this.containers.profile(profile.containerProfileId).hostId !== 'local') return []; }
      catch { return []; }
      const { id, label, containerProfileId, timeoutMs, outputBytes } = profile;
      return [{ id, label, containerProfileId, timeoutMs, outputBytes }];
    });
  }
  async recover(): Promise<void> { return this.initialization ??= this.load(); }
  private async privateDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || await realpath(path) !== path || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('Test storage must be a canonical private owned directory.');
  }
  private async readPrivate(path: string, limit: number): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.size > limit || process.getuid && before.uid !== process.getuid()) throw new Error('Invalid private test record.');
      const buffer = Buffer.alloc(limit + 1); let length = 0;
      while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      const after = await handle.stat();
      if (length > limit || length !== before.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw new Error('Test record changed during reading.');
      return buffer.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
  }
  private async verify(entry: Entry): Promise<void> {
    await entry.writing; await this.verifyOwnership(entry);
  }
  private async verifyOwnership(entry: Entry): Promise<void> {
    if (entry.unavailable) throw new Error('Test run is unavailable; files retained.');
    const m = entry.manifest, parent = join(this.root, m.run.id);
    await this.privateDirectory(this.root); await this.privateDirectory(parent); await this.privateDirectory(m.run.directory);
    if ((await this.readPrivate(join(this.root, 'owner'), 128)).trim() !== this.installation || (await this.readPrivate(join(parent, 'owner'), 128)).trim() !== m.token || entry.diskDigest && digest(await this.readPrivate(join(parent, 'manifest.json'), MAX_RECORD_BYTES)) !== entry.diskDigest) throw new Error('Test run ownership changed; snapshot retained.');
    const info = await lstat(m.run.directory);
    if (info.dev !== m.directoryDev || info.ino !== m.directoryIno) throw new Error('Test snapshot identity changed.');
  }
  private async persist(entry: Entry): Promise<void> {
    entry.writing = (entry.writing ?? Promise.resolve()).then(async () => {
      await this.verifyOwnership(entry);
      const parent = join(this.root, entry.manifest.run.id);
      const raw = JSON.stringify(entry.manifest); if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw new Error('Test record exceeds its bound.');
      const temporary = join(parent, `${randomUUID()}.tmp`), handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(parent, 'manifest.json')); entry.diskDigest = digest(raw);
    });
    try { await entry.writing; }
    catch (error) { entry.unavailable = 'Test record could not be saved; files retained.'; entry.manifest.run.state = 'unavailable'; entry.manifest.run.reason = entry.unavailable; throw error; }
  }
  private async load(): Promise<void> {
    try { await this.privateDirectory(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    this.installation = (await this.readPrivate(join(this.root, 'owner'), 128)).trim();
    if (!UUID.test(this.installation)) throw new Error('Invalid test storage installation.');
    const names = await readdir(this.root); if (names.length > 65) throw new Error('Test run registry exceeds its bound.');
    let total = 0;
    for (const id of names.filter(name => UUID.test(name))) {
      let entry: Entry | undefined;
      try {
        const parent = join(this.root, id); await this.privateDirectory(parent);
        const raw = await this.readPrivate(join(parent, 'manifest.json'), Math.min(MAX_RECORD_BYTES, 128 * 1024 * 1024 - total)); total += Buffer.byteLength(raw);
        if (total > 128 * 1024 * 1024) throw new Error('Test recovery budget exceeded.');
        const m = JSON.parse(raw) as TestManifest; assertCapsuleTestProfile(m.profile);
        if (!m.run || !Number.isSafeInteger(m.run.createdAt) || m.run.createdAt < 0 || m.run.finishedAt !== undefined && (!Number.isSafeInteger(m.run.finishedAt) || m.run.finishedAt < m.run.createdAt) || typeof m.run.truncated !== 'boolean' || m.run.exitCode !== null && (!Number.isInteger(m.run.exitCode) || m.run.exitCode < 0 || m.run.exitCode > 255) || m.run.reason !== undefined && (typeof m.run.reason !== 'string' || m.run.reason.length > 500) || m.run.generationId !== undefined && !UUID.test(m.run.generationId) || m.run.imageId !== undefined && (typeof m.run.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(m.run.imageId))) throw new Error('Invalid saved test result.');
        if (m.version !== 1 || m.installation !== this.installation || !UUID.test(m.token) || !UUID.test(m.lease) || !m.run || m.run.id !== id || m.run.directory !== join(parent, 'workspace') || !UUID.test(m.run.capsuleId) || !UUID.test(m.run.reviewId) || !HEX.test(m.run.reviewDigest) || m.run.profileDigest !== hash(m.profile) || m.run.testProfileId !== m.profile.id || typeof m.run.stopped !== 'boolean' || !['preparing', 'running', 'passed', 'failed', 'cancelled', 'uncertain'].includes(m.run.state) || typeof m.run.output !== 'string' || m.run.output.length > m.profile.outputBytes || !Array.isArray(m.files) || m.files.length > 128 || !Number.isSafeInteger(m.snapshotBytes) || m.snapshotBytes < 0 || m.snapshotBytes > MAX_RECORD_BYTES || ![m.directoryDev, m.directoryIno].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid saved test run.');
        const paths = new Set<string>();
        for (const file of m.files) {
          assertSafeCapsulePath(file.path);
          if (paths.has(file.path.toLowerCase()) || !HEX.test(file.hash) || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || ![file.dev, file.ino].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid saved test snapshot.');
          paths.add(file.path.toLowerCase());
        }
        entry = { manifest: m, diskDigest: digest(raw) }; await this.verify(entry);
        if (['preparing', 'running'].includes(m.run.state)) { m.run.state = m.run.stopped ? 'failed' : 'uncertain'; m.run.reason = 'Interrupted test. Nothing was rerun; verify and clean the recorded container.'; await this.persist(entry); }
        this.entries.set(id, entry);
      } catch {
        const run: CapsuleTestRun = { id, capsuleId: '', reviewId: '', reviewDigest: '', testProfileId: '', profileDigest: '', state: 'unavailable', createdAt: 0, directory: join(this.root, id, 'workspace'), stopped: false, output: '', truncated: false, exitCode: null, reason: 'Test record could not be verified; files retained.' };
        this.entries.set(id, { manifest: { run } as TestManifest, diskDigest: '', unavailable: run.reason });
      }
    }
  }
  private require(id: string): Entry {
    const entry = this.entries.get(id); if (!UUID.test(id) || !entry || entry.unavailable) throw new Error('Unknown or unavailable test run.'); return entry;
  }
  private profileCurrent(entry: Entry): boolean { try { return hash(this.profile(entry.manifest.run.testProfileId)) === entry.manifest.run.profileDigest; } catch { return false; } }
  async get(id: string): Promise<CapsuleTestRun> { await this.recover(); const entry = this.require(id); await this.verify(entry); return { ...structuredClone(entry.manifest.run), profileCurrent: this.profileCurrent(entry) }; }
  async list(capsuleId?: string): Promise<CapsuleTestSummary[]> { await this.recover(); return [...this.entries.values()].map(entry => { const { output: _output, ...summary } = entry.manifest.run; return { ...structuredClone(summary), profileCurrent: this.profileCurrent(entry) }; }).filter(run => capsuleId === undefined || run.capsuleId === capsuleId); }

  async start(capsuleId: string, reviewId: string, testProfileId: string, assertCurrent: () => void = () => {}): Promise<CapsuleTestRun> {
    if (this.closing || this.starting || this.active.size) throw new Error('One isolated test run may be active at a time.');
    this.starting = true;
    try {
      assertCurrent(); const profile = this.profile(testProfileId);
      const snapshot = await this.capsules.testSnapshot(capsuleId, reviewId); assertCurrent();
      await this.recover();
      if (this.closing || this.entries.size >= 64 || [...this.entries.values()].some(entry => entry.unavailable)) throw new Error('Test registry needs explicit cleanup before another run.');
      const bytes = snapshot.files.reduce((sum, file) => sum + file.contents.length, 0);
      if ([...this.entries.values()].reduce((sum, entry) => sum + entry.manifest.snapshotBytes + entry.manifest.profile.outputBytes, bytes + profile.outputBytes) > 128 * 1024 * 1024) throw new Error('Retained test storage budget reached.');
      const source = this.capsules.storage.describe(capsuleId).sourceDirectory, relation = relative(source, this.root);
      if (!isAbsolute(this.root) || !relation || relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)) throw new Error('Test storage must be outside the original project.');
      await mkdir(this.root, { recursive: true, mode: 0o700 }); await this.privateDirectory(this.root);
      if (!this.installation) { this.installation = randomUUID(); await writeFile(join(this.root, 'owner'), this.installation, { flag: 'wx', mode: 0o600 }); }
      if ((await this.readPrivate(join(this.root, 'owner'), 128)).trim() !== this.installation || (await readdir(this.root)).length >= 65) throw new Error('Test storage ownership or capacity changed.');
      const id = randomUUID(), parent = join(this.root, id), directory = join(parent, 'workspace');
      await mkdir(parent, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
      for (const file of snapshot.files) { assertSafeCapsulePath(file.path); await writeSnapshot(directory, file.path, file); }
      const captured = await snapshotCapsuleDirectory(directory, snapshot.files.map(file => file.path), undefined, false);
      const info = await lstat(directory);
      const manifest: TestManifest = { version: 1, installation: this.installation, token: randomUUID(), lease: randomUUID(), profile, snapshotBytes: bytes,
        directoryDev: info.dev, directoryIno: info.ino,
        files: [...captured.current].map(([path, file]) => ({ path, hash: digest(file.contents), mode: file.mode, dev: file.dev!, ino: file.ino! })),
        run: { id, capsuleId, reviewId, reviewDigest: snapshot.review.digest, testProfileId, profileDigest: hash(profile), state: 'preparing', createdAt: Date.now(), directory, stopped: true, output: '', truncated: false, exitCode: null } };
      const entry = { manifest, diskDigest: '' };
      await writeFile(join(parent, 'owner'), manifest.token, { flag: 'wx', mode: 0o600 }); await this.persist(entry); this.entries.set(id, entry);
      const controller = new AbortController();
      const task = Promise.resolve().then(() => this.execute(entry, controller.signal, assertCurrent)).finally(() => { this.active.delete(id); });
      this.active.set(id, { controller, task });
      void task.catch(() => {});
      return structuredClone(manifest.run);
    } finally { this.starting = false; }
  }
  private async verifySnapshot(entry: Entry, marker?: CapsuleLaunchMarker): Promise<void> {
    await this.verify(entry);
    const actual = await snapshotCapsuleDirectory(entry.manifest.run.directory, entry.manifest.files.map(file => file.path), marker, false);
    if (actual.current.size !== entry.manifest.files.length || entry.manifest.files.some(file => {
      const value = actual.current.get(file.path); return !value || digest(value.contents) !== file.hash || value.mode !== file.mode || value.dev !== file.dev || value.ino !== file.ino;
    })) throw new Error('Frozen test snapshot changed before launch.');
  }
  private async execute(entry: Entry, signal: AbortSignal, authority: () => void): Promise<void> {
    const m = entry.manifest, run = m.run;
    let prepared: Awaited<ReturnType<ContainerExecutionService['prepareTest']>> | undefined;
    let state: CapsuleTestRun['state'] = 'failed';
    const current = (): void => { signal.throwIfAborted(); authority(); if (this.closing || prepared && run.stopped || hash(this.profile(run.testProfileId)) !== run.profileDigest) throw new Error('Test command or authority changed.'); };
    try {
      current(); await this.verifySnapshot(entry); current();
      if ((await this.capsules.exportReview(run.capsuleId, run.reviewId)).digest !== run.reviewDigest) throw new Error('Reviewed test input changed.');
      run.stopped = false; await this.persist(entry); current();
      prepared = await this.containers.prepareTest(run.testProfileId, { kind: 'capsule-test', id: run.id, directory: run.directory, sourceDirectory: run.directory }, current, m.lease, async marker => {
        await this.verifySnapshot(entry, marker); current();
        if ((await this.capsules.exportReview(run.capsuleId, run.reviewId)).digest !== run.reviewDigest) throw new Error('Reviewed test input changed.');
      });
      run.generationId = prepared.generationId; run.imageId = prepared.imageId; await this.persist(entry);
      await prepared.beforeSpawn?.(); current();
      run.state = 'running'; await this.persist(entry); current();
      if (!prepared.process?.cwd || !prepared.process.environment) throw new Error('Fixed test process is unavailable.');
      const result = await this.runner({ command: prepared.process.command, args: prepared.process.args, cwd: prepared.process.cwd, environment: prepared.process.environment }, { timeoutMs: m.profile.timeoutMs, outputBytes: m.profile.outputBytes, signal, assertCurrent: current });
      run.output = result.output; run.truncated = result.truncated;
      if (result.reason) { state = result.reason === 'cancelled' ? 'cancelled' : 'failed'; run.reason = `Test stopped: ${result.reason}.`; }
      else {
        current(); const exit = await this.containers.testExit(prepared.generationId); current(); run.exitCode = exit.exitCode;
        state = exit.exitCode === 0 && result.exitCode === 0 && !exit.oomKilled ? 'passed' : 'failed';
        if (exit.oomKilled) run.reason = 'Test exceeded its memory limit.';
      }
    } catch (error) {
      state = signal.aborted || this.closing ? 'cancelled' : 'failed';
      run.reason = error instanceof Error ? error.message.slice(0, 500) : 'Test failed; snapshot retained.';
    } finally {
      try {
        if (prepared) await prepared.cleanup();
        else if (!run.stopped && !await this.containers.blocksWorkspace(run.id)) run.stopped = true;
      } catch { run.stopped = false; }
      run.state = run.stopped ? state : 'uncertain'; run.finishedAt = Date.now();
      if (!run.stopped) run.reason = 'Container stop is unconfirmed. Snapshot retained; clean its recorded generation under Containers.';
      await this.persist(entry);
    }
  }
  async confirmStopped(id: string, lease: string): Promise<void> {
    await this.recover(); const entry = this.require(id); await this.verify(entry);
    if (entry.manifest.lease !== lease) return;
    entry.manifest.run.stopped = true; await this.persist(entry);
    if (!this.active.has(id) && entry.manifest.run.state === 'uncertain') { entry.manifest.run.state = 'failed'; entry.manifest.run.reason = 'Container stop confirmed. The previous test outcome remains unknown.'; await this.persist(entry); }
  }
  async wait(id: string): Promise<CapsuleTestRun> { await this.active.get(id)?.task; return this.get(id); }
  async cancel(id: string): Promise<void> { await this.recover(); this.require(id); this.active.get(id)?.controller.abort(); }
  async cleanup(id: string): Promise<void> {
    await this.recover(); const entry = this.require(id);
    if (this.active.has(id) || !entry.manifest.run.stopped || await this.containers.blocksWorkspace(id)) throw new Error('Test container stop is unconfirmed; snapshot retained.');
    await this.verify(entry); await rm(join(this.root, id), { recursive: true }); this.entries.delete(id);
  }
  async shutdown(): Promise<void> { this.closing = true; for (const run of this.active.values()) run.controller.abort(); await Promise.allSettled([...this.active.values()].map(run => run.task)); }
}
