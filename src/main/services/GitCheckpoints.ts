import { spawn } from "node:child_process";
import { realpath, mkdir, mkdtemp, readdir, readFile, writeFile, rename, rm, rmdir, stat, lstat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CheckpointEntry } from "../../shared/contracts.ts";
import { CheckpointRefusal } from "./checkpointRefusal.ts";

type CheckpointKind = CheckpointEntry["kind"];
type TrustedCheckpoint = {
  cwd: string; sessionId: string; kind: CheckpointKind;
  /** The snapshot commit (what the convenience ref points at); restores use the two trees. */
  oid: string; tree: string; indexTree: string;
  /** Host packs that together hold every object of both trees (oldest first); absent when none is kept. */
  packs?: string[];
};
type GitOptions = {
  signal?: AbortSignal; timeoutMs?: number; input?: string | Readable;
  /** Bytes of stdout kept; more is an error unless `truncate`, which stops Git and keeps the prefix. */
  limit?: number; truncate?: boolean; onTruncate?: () => void;
  /** Read the repository's attributes from this tree (and nowhere else in the project), or as the person's Git would. */
  attributes?: string | "person";
  /** Streams stdout instead of collecting it. */
  onStdout?: (chunk: Buffer) => void;
  extraConfig?: string[];
  /** Internal: false when this Git predates --attr-source (2.40). */
  attributeSource?: boolean;
};

const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const DEFAULT_STDOUT_LIMIT = 64 * 1024 * 1024;
const PREVIEW_LIMIT = 2 * 1024 * 1024;
const MAX_PACK_CHAIN = 16;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
/** How long a file system call on a project folder may take (an unmounted or hung network volume never answers). */
const FOLDER_TIMEOUT_MS = 5_000;
/** How long a preview may take in all (it may have to read a point's packs back into the repository). */
const PREVIEW_TIMEOUT_MS = 120_000;
/** A set-aside registry larger than this is not read for the packs it references: no pack is swept then. */
const MAX_QUARANTINED_BYTES = 64 * 1024 * 1024;
// Bidirectional formatting controls can make a shown diff or file name read differently from what it is.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export interface GitCheckpointLimits {
  /** Rollback points kept per card (oldest go first). */
  perSession?: number;
  /** Rollback points kept for all cards together. */
  total?: number;
  /** Bytes of protective packs kept for all cards together. */
  packBytes?: number;
}

/**
 * Rollback points of an agent's Git project, taken before its turns (auto and yolo cards) and before a restore. Each is
 * a `git stash create` snapshot (or HEAD) plus its index, listed only from the host registry (`storagePath`, in
 * userData/checkpoints; refs/canvastty/<session>/… are a convenience the agent may delete). After the turn may start,
 * the snapshot's trees are copied into host-owned packs next to it (checkpoint-objects), chained to the repository's
 * previous point so only what changed is packed.
 *
 * Git runs in the host (never in an agent's sandbox) with a stripped environment, without hooks, fsmonitor, replace
 * objects, external diff or text conversion, network access, or the project's own filter drivers, and reads attributes
 * only from a fixed tree. A project whose tracked files use a filter attribute (Git LFS, git-crypt) is refused instead:
 * a raw copy of such files would not round-trip. All Git work for one repository runs in one queue.
 */
export class GitCheckpoints {
  private redact: (text: string) => string;
  private readonly limits: Required<GitCheckpointLimits>;
  private readonly trusted = new Map<string, TrustedCheckpoint>();
  private loaded: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly background = new Map<string, Promise<unknown>>();
  /** Previews run in their own lane per repository: one never delays a turn's capture. */
  private readonly previews = new Map<string, Promise<unknown>>();
  private attributeSource: Promise<boolean> | null = null;
  private readonly heldPacks = new Map<string, number>();
  private readonly packSizes = new Map<string, number>();
  private readonly forgotten = new Set<string>();
  private readonly storagePath?: string;
  constructor(redact: (text: string) => string, limits: number | GitCheckpointLimits = {}, storagePath?: string) {
    this.redact = redact;
    const given = typeof limits === "number" ? { perSession: limits } : limits;
    this.limits = { perSession: given.perSession ?? 50, total: given.total ?? 1000, packBytes: given.packBytes ?? 2 * 1024 ** 3 };
    this.storagePath = storagePath;
  }

  // ---- registry -------------------------------------------------------------------------------------------------

  private load(): Promise<void> {
    // A failed load (a transient read error) is tried again by the next call instead of disabling points for the run.
    this.loaded ??= this.loadOnce().catch((error: unknown) => {
      this.trusted.clear(); this.loaded = null;
      throw error;
    });
    return this.loaded;
  }
  private async loadOnce(): Promise<void> {
    if (!this.storagePath) return;
    let dropped = false;
    try {
      const text = await readFile(this.storagePath, "utf8");
      let values: unknown;
      try { values = Buffer.byteLength(text) <= MAX_REGISTRY_BYTES ? JSON.parse(text) : undefined; } catch { values = undefined; }
      if (!Array.isArray(values)) {
        await this.quarantine("unreadable or too large");
        values = [];
      }
      for (const row of values as unknown[]) {
        const parsed = parseRow(row);
        if (!parsed) { dropped = true; continue; }
        this.trusted.set(parsed.id, parsed.row);
      }
      if (dropped) await this.quarantine("invalid rows dropped", true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A project folder that cannot be found now keeps its points: it may be on a volume that is not mounted. They go
    // with their card or by retention.
    if (dropped) await this.persist();
    await this.sweepPackStorage();
  }
  /** A registry that cannot be read is kept aside (one copy) for diagnosis; rollback points start over. */
  private async quarantine(reason: string, copy = false): Promise<void> {
    const file = this.storagePath!;
    const aside = `${file}.quarantined`;
    try {
      if (copy) await writeFile(aside, await readFile(file), { mode: 0o600 });
      else await rename(file, aside);
      console.warn("Rollback point registry set aside:", reason);
    } catch (error) {
      console.warn("Rollback point registry could not be set aside.", (error as NodeJS.ErrnoException).code ?? "unknown error");
      if (!copy) await rm(file, { force: true }).catch(() => undefined);
    }
  }
  private async persist(signal?: AbortSignal): Promise<void> {
    if (!this.storagePath) return;
    const file = this.storagePath, text = JSON.stringify([...this.trusted].map(([id, row]) => ({ id, ...row })));
    const work = this.writes.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, text, { mode: 0o600, flag: "wx", signal }); signal?.throwIfAborted(); await rename(temp, file);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writes = work; await work;
  }
  /** Removes packs no row references, empty project folders, and staging folders of dead captures. */
  private async sweepPackStorage(): Promise<void> {
    const root = this.objectsRoot();
    if (!root) return;
    const projects = await readdir(root, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const referenced = new Set([...this.trusted.values()].flatMap((row) => (row.packs ?? []).map((pack) => this.packPath(row.cwd, pack))));
    // Packs a set-aside registry names stay with it, so it can still be recovered by hand.
    const aside = await this.quarantinedPacks();
    if (aside === null) return;
    for (const project of projects) {
      if (!project.isDirectory() || !/^[a-f0-9]{64}$/u.test(project.name)) continue;
      const directory = join(root, project.name);
      let remaining = 0;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const owner = /^\.pending-([1-9][0-9]{0,9})-[A-Za-z0-9]{6}$/u.exec(entry.name);
        if (entry.isDirectory() && owner) {
          const pid = Number(owner[1]);
          let dead = pid <= 0x7fffffff && pid !== process.pid;
          if (dead) { try { process.kill(pid, 0); dead = false; } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; } }
          // A live or inaccessible owner keeps its staging folder; only confirmed dead owners are removed.
          if (dead) await this.removePackStaging(path); else remaining++;
        } else if (entry.isFile() && /^pack-[a-f0-9]{40,64}\.pack$/u.test(entry.name) && !referenced.has(path) && !aside.has(entry.name.slice(5, -5))) {
          await rm(path, { force: true }).catch(() => undefined);
        } else remaining++;
      }
      if (remaining === 0) await rmdir(directory).catch(() => undefined);
    }
  }
  /** The pack hashes a set-aside registry mentions (read leniently: it may not parse); null when it cannot be read. */
  private async quarantinedPacks(): Promise<Set<string> | null> {
    const file = `${this.storagePath!}.quarantined`;
    try {
      if ((await stat(file)).size > MAX_QUARANTINED_BYTES) return null;
      return new Set((await readFile(file, "latin1")).match(/[a-f0-9]{40}(?:[a-f0-9]{24})?/gu) ?? []);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : null;
    }
  }
  private async removePackStaging(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true }).catch((error) => {
      // Cleanup failure must not turn an already published valid pack into an unregistered capture.
      console.warn("Could not remove unfinished checkpoint files.", (error as NodeJS.ErrnoException).code ?? "unknown error");
    });
  }

  // ---- Git ------------------------------------------------------------------------------------------------------

  private prefix(sessionId: string): string {
    if (!/^[\w-]{1,100}$/u.test(sessionId)) throw new Error("Invalid checkpoint session.");
    return `refs/canvastty/${sessionId}/`;
  }
  /**
   * One hardened Git call, streamed. Never inherits GIT_* variables (GIT_DIR, GIT_CONFIG_PARAMETERS…), never fetches,
   * never runs hooks or an fsmonitor, and reads attributes from `options.attributes` only.
   */
  private async git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
    if (options.attributes && options.attributes !== "person" && options.attributeSource === undefined) {
      options = { ...options, attributeSource: await this.supportsAttributeSource() };
    }
    return this.run(cwd, args, options);
  }
  /**
   * Git 2.40 added --attr-source. An older Git reads the project's .gitattributes from the working tree instead; the
   * project's own filter drivers are still blanked, so only the person's own (global or system) drivers could run.
   */
  private supportsAttributeSource(): Promise<boolean> {
    this.attributeSource ??= this.run(process.cwd(), ["version"], {}).then((text) => {
      const [major = 0, minor = 0] = (/git version (\d+)\.(\d+)/u.exec(text) ?? []).slice(1).map(Number);
      return major > 2 || (major === 2 && minor >= 40);
    }, () => false);
    return this.attributeSource;
  }
  private run(cwd: string, args: string[], options: GitOptions): Promise<string> {
    const { signal } = options;
    signal?.throwIfAborted();
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1",
      ...(options.attributes === "person" ? {} : { GIT_ATTR_NOSYSTEM: "1" })
    };
    const config = ["core.hooksPath=" + NULL_DEVICE, "core.fsmonitor=false", "diff.external=", "protocol.allow=never", "gc.auto=0",
      "maintenance.auto=false", "commit.gpgSign=false", "credential.helper=", "core.pager=cat",
      ...(options.attributes === "person" ? [] : ["core.attributesFile=" + NULL_DEVICE]), ...(options.extraConfig ?? [])];
    const attributeSource = options.attributes && options.attributes !== "person" && options.attributeSource !== false ? [`--attr-source=${options.attributes}`] : [];
    const argv = ["--no-pager", "--no-replace-objects", ...config.flatMap((value) => ["-c", value]), ...attributeSource, "-C", cwd, ...args];
    return new Promise<string>((resolve, reject) => {
      const child = spawn("git", argv, { env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
      const limit = options.limit ?? DEFAULT_STDOUT_LIMIT;
      const chunks: Buffer[] = []; let size = 0, stderr = "", truncated = false, settled = false;
      const timer = setTimeout(() => fail(Object.assign(new Error(`git ${args[0]} timed out.`), { code: "ETIMEDOUT" })), options.timeoutMs ?? 15_000);
      const abort = (): void => fail(signal?.reason ?? new Error("Checkpoint cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      const finish = (): void => { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      function fail(error: unknown): void {
        if (settled) return;
        finish(); child.kill("SIGKILL"); reject(error);
      }
      child.on("error", fail);
      child.stdout!.on("data", (chunk: Buffer) => {
        if (settled || truncated) return;
        if (options.onStdout) { try { options.onStdout(chunk); } catch (error) { fail(error); } return; }
        if (size + chunk.length > limit) {
          if (!options.truncate) { fail(Object.assign(new Error(`git ${args[0]} output is too large.`), { code: "ERR_OUTPUT_LIMIT" })); return; }
          // Keep whole lines only; the caller says the text is shortened.
          const room = chunk.subarray(0, limit - size);
          const end = room.lastIndexOf(10);
          chunks.push(room.subarray(0, end + 1)); size += end + 1;
          truncated = true; options.onTruncate?.(); child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk); size += chunk.length;
      });
      child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
      if (options.input !== undefined) {
        child.stdin!.on("error", () => undefined);
        if (typeof options.input === "string") child.stdin!.end(options.input);
        else { options.input.on("error", fail); options.input.pipe(child.stdin!); }
      }
      child.on("close", (code) => {
        if (settled) return;
        finish();
        if (code === 0 || truncated) resolve(Buffer.concat(chunks).toString("utf8").replace(/\n$/u, ""));
        else reject(Object.assign(new Error(`git ${args[0]} failed (${code}).`), { code, stderr: stderr.trim() }));
      });
    });
  }
  /** Streams the NUL-terminated records a Git command prints (paths are kept as bytes). */
  private async records(cwd: string, args: string[], onRecord: (record: Buffer) => void, options: GitOptions = {}): Promise<void> {
    let rest = Buffer.alloc(0);
    await this.git(cwd, args, { ...options, onStdout: (chunk) => {
      let data = rest.length ? Buffer.concat([rest, chunk]) : chunk, start = 0, end: number;
      while ((end = data.indexOf(0, start)) !== -1) { onRecord(data.subarray(start, end)); start = end + 1; }
      rest = Buffer.from(data.subarray(start));
      if (rest.length > 65_536) throw new Error("Git record is too long.");
      data = rest;
    } });
  }
  /** A Git listing whose stdout feeds another Git call. */
  private listInto(cwd: string, args: string[], signal?: AbortSignal): { stdout: Readable; done: Promise<void>; stop(): void } {
    const stdout = new PassThrough();
    const done = this.git(cwd, args, { signal, onStdout: (chunk) => { stdout.write(chunk); } })
      .then(() => { stdout.end(); }, (error: unknown) => { stdout.destroy(error as Error); throw error; });
    done.catch(() => undefined);
    return { stdout, done, stop: () => { if (!stdout.writableEnded) stdout.end(); } };
  }
  /** The tracked paths (or a tree's paths) whose filter attribute is set, as the given attributes source sees them. */
  private async filteredPaths(cwd: string, attributes: string | "person", tree?: string, signal?: AbortSignal): Promise<number> {
    const list = this.listInto(cwd, tree ? ["ls-tree", "-r", "-z", "--name-only", "--full-tree", tree] : ["ls-files", "-z"], signal);
    let filtered = 0, field = 0;
    try {
      await this.records(cwd, ["check-attr", "-z", "--stdin", "filter"], (record) => {
        // Triples of path, attribute name and value.
        if (field++ % 3 === 2) { const value = record.toString("utf8"); if (value !== "unspecified" && value !== "unset") filtered++; }
      }, { signal, attributes, input: list.stdout, timeoutMs: 15_000 });
      await list.done;
    } finally { list.stop(); }
    return filtered;
  }
  /**
   * Every filter driver Git would know here (the project's own config, which an agent may control, and the person's
   * global and system ones): blanked for every call that could run one. `--attr-source` does not cover
   * `$GIT_DIR/info/attributes`, so an attribute written there in a race could otherwise make the person's own Git LFS
   * or git-crypt driver run on a raw snapshot (or on a restore). With every known driver blank, such an attribute does
   * nothing; refusing projects whose files use a filter attribute keeps snapshots raw and round-trippable.
   */
  private async filterOverrides(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const names = new Set<string>();
    const output = await this.git(cwd, ["config", "--show-scope", "-z", "--get-regexp", "^filter\\."], { signal }).catch((error: { code?: unknown }) => {
      if (error.code === 1) return ""; throw error;
    });
    const fields = output.split("\0");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const key = fields[index + 1].split("\n", 1)[0];
      const name = /^filter\.(.+)\.[^.]+$/u.exec(key)?.[1];
      if (name === undefined) continue;
      if (name.includes("=") || names.size >= 64) throw new CheckpointRefusal("filters", "The project configures filter drivers that cannot be neutralized.");
      names.add(name);
    }
    return [...names].flatMap((name) => [`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`, `filter.${name}.required=false`]);
  }
  /** Refuses when a filter attribute applies to the project's tracked files (or to a saved tree's files). */
  private async requireNoFilters(cwd: string, pinned: string, signal?: AbortSignal, tree?: string): Promise<void> {
    const counts = await Promise.all([
      this.filteredPaths(cwd, "person", undefined, signal),
      this.filteredPaths(cwd, pinned, undefined, signal),
      ...(tree ? [this.filteredPaths(cwd, tree, tree, signal)] : [])
    ]);
    if (counts.some((count) => count > 0)) {
      throw new CheckpointRefusal("filters", "Files of this project use a Git filter (such as Git LFS or git-crypt); rollback points are unavailable.");
    }
  }

  // ---- queues ---------------------------------------------------------------------------------------------------

  /** Runs `job` after every earlier job of the same repository (only); a failure never blocks the next one. */
  private enqueue<T>(repository: string, job: () => Promise<T>, queues = this.queues): Promise<T> {
    const previous = queues.get(repository) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(job);
    const tail = work.catch(() => undefined);
    queues.set(repository, tail);
    void tail.then(() => { if (queues.get(repository) === tail) queues.delete(repository); });
    return work;
  }
  /** Settles once every queued job (protective packs and pruning included) has finished. */
  async idle(): Promise<void> {
    while (this.queues.size > 0 || this.background.size > 0 || this.previews.size > 0) {
      await Promise.all([...this.queues.values(), ...this.background.values(), ...this.previews.values()]);
    }
    await this.writes.catch(() => undefined);
  }

  async available(cwd: string, signal?: AbortSignal): Promise<boolean> {
    try { return await withinTime(realpath(await this.git(cwd, ["rev-parse", "--show-toplevel"], { signal }))) === await withinTime(realpath(cwd)); }
    catch { return false; }
  }

  // ---- capture --------------------------------------------------------------------------------------------------

  /**
   * Takes a rollback point. With a `signal` (the turn barrier) it settles as soon as the point is registered (or the
   * signal aborts); the protective pack is written afterwards in the repository's queue.
   */
  async capture(sessionId: string, cwd: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let root: string;
    try { root = await withinTime(realpath(cwd)); } catch { return; }
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    const work = this.enqueue(root, () => this.captureOne(sessionId, root, "before-turn", signal, commit));
    // Without a barrier signal the caller waits for the protective copy as well.
    if (!signal) { await work; await this.background.get(root); return; }
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason ?? new Error("Checkpoint cancelled.")); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try { await Promise.race([work, committed, cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
  }
  /**
   * Registers one rollback point; false when none could be taken here (no commit yet on the branch, the folder is not
   * the project's top, or the card was closed).
   */
  private async captureOne(sessionId: string, root: string, kind: CheckpointKind, signal?: AbortSignal, committed?: () => void): Promise<boolean> {
    signal?.throwIfAborted();
    if (this.forgotten.has(sessionId)) return false;
    await this.load();
    const facts = (await this.git(root, ["rev-parse", "--show-toplevel", "HEAD^{commit}", "HEAD^{tree}"], { signal }).catch(() => "")).split("\n");
    if (facts.length !== 3 || !OID.test(facts[1]) || !OID.test(facts[2]) || await withinTime(realpath(facts[0])).catch(() => "") !== root) {
      signal?.throwIfAborted(); return false;
    }
    const [, head, headTree] = facts;
    const [overrides] = await Promise.all([this.filterOverrides(root, signal), this.requireNoFilters(root, headTree, signal)]);
    const stash = await this.git(root, ["stash", "create"], { attributes: headTree, extraConfig: overrides, signal });
    if (stash && !OID.test(stash)) throw new Error("Invalid stash object.");
    const oid = stash || head;
    // A stash's second parent stores its index state. A clean checkpoint can itself be a merge commit,
    // whose second parent is an unrelated branch and must not be used as the saved index.
    const trees = stash ? (await this.git(root, ["rev-parse", `${stash}^{tree}`, `${stash}^2^{tree}`], { signal })).split("\n") : [headTree, headTree];
    if (trees.length !== 2 || !trees.every((tree) => OID.test(tree))) throw new Error("Invalid checkpoint trees.");
    // Checked again after the snapshot: a filter attribute or driver that appeared while it was taken (for example in
    // .git/info/attributes, which --attr-source does not cover) means the snapshot may not be the raw files.
    const [after] = await Promise.all([this.filterOverrides(root, signal), this.requireNoFilters(root, headTree, signal, trees[0])]);
    if (after.some((value) => !overrides.includes(value))) {
      throw new CheckpointRefusal("filters", "A Git filter driver appeared while the rollback point was taken.");
    }
    const ref = `${this.prefix(sessionId)}${this.nextPointTime()}-${randomUUID()}`;
    const row: TrustedCheckpoint = { cwd: root, sessionId, oid, tree: trees[0], indexTree: trees[1], kind };
    try {
      signal?.throwIfAborted();
      await this.git(root, ["update-ref", "--no-deref", ref, oid, ""], { signal });
      signal?.throwIfAborted();
      if (this.forgotten.has(sessionId)) throw new Error("The card was closed.");
      this.trusted.set(ref, row);
      await this.persist(signal);
      signal?.throwIfAborted();
    } catch (error) {
      if (this.trusted.get(ref) === row) {
        this.trusted.delete(ref);
        // A cancellation can race the atomic registry replacement; write the previous contents back.
        if (signal?.aborted) await this.persist().catch(() => undefined);
      }
      await this.git(root, ["update-ref", "-d", ref]).catch(() => undefined);
      throw error;
    }
    // The point exists now: the turn may start. Copying its objects and pruning older points never touch the agent's
    // files, so they run in the repository's background queue and never delay the next turn's capture.
    committed?.();
    void this.enqueue(root, async () => {
      await this.protect(ref, row).catch((error: unknown) => {
        console.warn("Rollback point objects could not be copied.", error instanceof Error ? error.message : "error");
      });
      await this.prune(ref);
    }, this.background).catch((error: unknown) => {
      console.warn("Rollback points could not be pruned.", error instanceof Error ? error.message : "error");
    });
    return true;
  }
  /**
   * Copies the point's two trees into host-owned packs, so deleting refs, rewriting history and garbage-collecting
   * the repository loses nothing it needs. Only objects the repository's previous protected point does not already
   * hold are packed (the files that changed, and their folders); its packs are referenced as well. A chain longer
   * than MAX_PACK_CHAIN starts over with one complete pack.
   */
  private async protect(ref: string, row: TrustedCheckpoint): Promise<void> {
    if (!this.storagePath || this.trusted.get(ref) !== row) return;
    // The repository's newest protected point: its chain is extended, or, once that is MAX_PACK_CHAIN packs long, a
    // complete pack starts a new chain (so no chain, and no pack holding everything since an old point, grows forever).
    let previous: TrustedCheckpoint | undefined;
    let newest = -1;
    for (const [id, other] of this.trusted) {
      const at = pointTime(id);
      if (other !== row && other.cwd === row.cwd && other.packs && at > newest) { previous = other; newest = at; }
    }
    if (previous && previous.packs!.length >= MAX_PACK_CHAIN) previous = undefined;
    const directory = dirname(this.packPath(row.cwd, "0".repeat(40))!);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Git can leave tmp_pack/partial index files when interrupted. Keep each invocation in its own
    // private staging folder so failure cleanup never removes a pack retained by another checkpoint.
    const staging = await mkdtemp(join(directory, `.pending-${process.pid}-`));
    const chain = previous?.packs ? [...previous.packs] : [];
    const release = chain.map((pack) => this.holdPack(row.cwd, pack));
    try {
      const input = [row.tree, row.indexTree, ...(previous ? [`^${previous.tree}`, `^${previous.indexTree}`] : [])].join("\n") + "\n";
      const hash = await this.git(row.cwd, ["pack-objects", "--revs", "--compression=1", join(staging, "pack")], {
        input, timeoutMs: 300_000, extraConfig: ["pack.threads=1", "pack.writeBitmapHashCache=false"]
      });
      if (!OID.test(hash)) throw new Error("Invalid checkpoint pack hash.");
      // Restore streams each pack to index-pack, which creates its own repository index. Retaining
      // Git's staging .idx would duplicate unused data; only the complete pack is published atomically.
      const target = this.packPath(row.cwd, hash)!;
      await rename(join(staging, `pack-${hash}.pack`), target);
      if (this.trusted.get(ref) !== row || chain.some((pack) => !existsSync(this.packPath(row.cwd, pack)!))) {
        await this.removePackIfUnreferenced(row.cwd, hash);
        return;
      }
      row.packs = [...chain.filter((pack) => pack !== hash), hash];
      await this.persist();
    } finally {
      for (const done of release) await done();
      await this.removePackStaging(staging);
    }
  }
  private async packSize(cwd: string, pack: string): Promise<number> {
    const key = `${cwd}\0${pack}`;
    let size = this.packSizes.get(key);
    if (size === undefined) {
      size = await stat(this.packPath(cwd, pack)!).then((info) => info.size, () => 0);
      this.packSizes.set(key, size);
    }
    return size;
  }
  /**
   * A new point's time: now, but always after every point already registered, so retention (which drops the oldest
   * first, by this time) keeps the newest even for two points in one millisecond or after the clock went back.
   */
  private nextPointTime(): number {
    let at = Date.now();
    for (const id of this.trusted.keys()) at = Math.max(at, pointTime(id) + 1);
    return at;
  }
  /** Keeps at most `perSession` points per card and `total`/`packBytes` overall, dropping the oldest first. */
  private async prune(newest?: string): Promise<void> {
    const rows = [...this.trusted].map(([id, row]) => ({ id, row, at: pointTime(id) })).sort((a, b) => b.at - a.at);
    const drop = new Set<string>();
    const perSession = new Map<string, number>();
    for (const { id, row } of rows) {
      const key = `${row.sessionId}\0${row.cwd}`, count = (perSession.get(key) ?? 0) + 1;
      perSession.set(key, count);
      if (count > this.limits.perSession) drop.add(id);
    }
    let kept = 0, bytes = 0;
    const counted = new Set<string>();
    let unprotect: TrustedCheckpoint | undefined;
    for (const { id, row } of rows) {
      if (drop.has(id)) continue;
      const fresh = (row.packs ?? []).filter((pack) => !counted.has(`${row.cwd}\0${pack}`));
      let extra = 0;
      for (const pack of fresh) extra += await this.packSize(row.cwd, pack);
      if (id === newest && bytes + extra > this.limits.packBytes) { unprotect = row; kept++; continue; }
      if (id !== newest && (kept + 1 > this.limits.total || bytes + extra > this.limits.packBytes)) { drop.add(id); continue; }
      kept++; bytes += extra;
      for (const pack of fresh) counted.add(`${row.cwd}\0${pack}`);
    }
    if (drop.size === 0 && !unprotect) return;
    const removed = [...drop].map((id) => ({ id, row: this.trusted.get(id)! }));
    for (const { id } of removed) this.trusted.delete(id);
    const unprotected = unprotect?.packs ?? [];
    // Too large to keep a copy of: the point stays, relying on the repository's own objects.
    if (unprotect) delete unprotect.packs;
    await this.persist();
    for (const pack of unprotected) await this.removePackIfUnreferenced(unprotect!.cwd, pack);
    await this.discard(removed);
  }
  /** Removes dropped points' refs (in each repository's own queue) and their packs once nothing references them. */
  private async discard(removed: Array<{ id: string; row: TrustedCheckpoint }>): Promise<void> {
    const byRepository = new Map<string, Array<{ id: string; row: TrustedCheckpoint }>>();
    for (const entry of removed) byRepository.set(entry.row.cwd, [...(byRepository.get(entry.row.cwd) ?? []), entry]);
    for (const [cwd, entries] of byRepository) {
      for (const pack of new Set(entries.flatMap(({ row }) => row.packs ?? []))) await this.removePackIfUnreferenced(cwd, pack);
      void this.enqueue(cwd, async () => {
        try { await withinTime(stat(cwd)); } catch { return; }
        await this.git(cwd, ["update-ref", "--stdin", "-z"], {
          input: entries.map(({ id }) => `delete ${id}\0\0`).join("")
        }).catch(() => undefined);
      });
    }
  }
  /** A closed card's rollback points go with it. */
  async forgetSession(sessionId: string): Promise<void> {
    this.forgotten.add(sessionId);
    await this.load();
    await this.drop(([, row]) => row.sessionId === sessionId);
  }
  /**
   * After the saved cards came back: points of the saved cards known not to come back are dropped. Only cards named
   * here go (never "everything not restored": the saved cards may be unreadable or from a newer version this run).
   */
  async forgetSessions(sessionIds: Iterable<string>): Promise<void> {
    const gone = new Set(sessionIds);
    if (gone.size === 0) return;
    for (const id of gone) this.forgotten.add(id);
    await this.load();
    await this.drop(([, row]) => gone.has(row.sessionId));
  }
  private async drop(match: (entry: [string, TrustedCheckpoint]) => boolean): Promise<void> {
    const removed = [...this.trusted].filter(match).map(([id, row]) => ({ id, row }));
    if (removed.length === 0) return;
    for (const { id } of removed) this.trusted.delete(id);
    await this.persist();
    await this.discard(removed);
  }
  private async removePackIfUnreferenced(cwd: string, pack?: string): Promise<void> {
    if (!pack || this.heldPacks.has(`${cwd}\0${pack}`) || [...this.trusted.values()].some((row) => row.cwd === cwd && row.packs?.includes(pack))) return;
    const path = this.packPath(cwd, pack);
    this.packSizes.delete(`${cwd}\0${pack}`);
    if (path) await rm(path, { force: true });
  }
  private holdPack(cwd: string, pack?: string): () => Promise<void> {
    if (!pack) return async () => undefined;
    const key = `${cwd}\0${pack}`; this.heldPacks.set(key, (this.heldPacks.get(key) ?? 0) + 1);
    let released = false;
    return async () => {
      if (released) return; released = true;
      const count = this.heldPacks.get(key) ?? 0;
      if (count > 1) this.heldPacks.set(key, count - 1);
      else { this.heldPacks.delete(key); await this.removePackIfUnreferenced(cwd, pack); }
    };
  }
  private objectsRoot(): string | undefined {
    return this.storagePath ? join(dirname(this.storagePath), "checkpoint-objects") : undefined;
  }
  private packPath(cwd: string, hash: string): string | undefined {
    const root = this.objectsRoot();
    return root ? join(root, createHash("sha256").update(cwd).digest("hex"), `pack-${hash}.pack`) : undefined;
  }

  // ---- list, preview, restore ------------------------------------------------------------------------------------

  async list(sessionId: string, cwd: string): Promise<CheckpointEntry[]> {
    await this.load();
    if (!await this.available(cwd)) return [];
    const root = await withinTime(realpath(cwd));
    const prefix = this.prefix(sessionId);
    // Only the protected host registry decides which snapshots exist; refs are an additional repository convenience.
    return [...this.trusted].filter(([id, row]) => id.startsWith(prefix) && row.cwd === root && row.sessionId === sessionId)
      .map(([id, row]) => ({ id, at: pointTime(id), kind: row.kind }))
      .sort((a, b) => b.at - a.at);
  }
  /** The registered row, with its objects back in the repository (from the host packs when some are missing). */
  private async requirePoint(sessionId: string, root: string, id: string, signal?: AbortSignal): Promise<TrustedCheckpoint> {
    if (!(await this.list(sessionId, root)).some((entry) => entry.id === id)) throw new CheckpointRefusal("unknown-checkpoint", "Checkpoint does not belong to this session.");
    const row = this.trusted.get(id)!;
    await this.ensureObjects(root, row, signal);
    return row;
  }
  /** Imports the point's packs only when the repository misses one of its objects (no pack piles up per preview). */
  private async ensureObjects(root: string, row: TrustedCheckpoint, signal?: AbortSignal): Promise<void> {
    if (await this.complete(root, row, signal)) return;
    for (const pack of row.packs ?? []) {
      const source = createReadStream(this.packPath(row.cwd, pack)!);
      try {
        await this.git(root, ["index-pack", "--stdin"], { input: source, timeoutMs: 300_000, limit: 4096, signal });
      } catch (error) {
        // A missing pack leaves the objects to the repository; the completeness check below decides.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally { source.destroy(); }
    }
    signal?.throwIfAborted();
    if (!await this.complete(root, row, signal)) throw new CheckpointRefusal("unknown-checkpoint", "The rollback point's objects are no longer in the repository.");
  }
  private async complete(root: string, row: TrustedCheckpoint, signal?: AbortSignal): Promise<boolean> {
    let missing = false;
    try {
      await this.git(root, ["rev-list", "--objects", "--no-object-names", "--missing=print", row.tree, row.indexTree], {
        timeoutMs: 120_000, signal, onStdout: (chunk) => { if (chunk.includes(63)) missing = true; }
      });
    } catch { signal?.throwIfAborted(); return false; }
    return !missing;
  }
  /**
   * What a restore of the point would change, as a diff from the current files to the point (lines marked `+` come
   * back, lines marked `-` go). Runs in the repository's own preview lane, never ahead of or behind a capture, holds
   * the point's packs while it reads them, and gives up after PREVIEW_TIMEOUT_MS.
   */
  async preview(sessionId: string, cwd: string, id: string): Promise<{ text: string; changedFiles: string[]; truncated: boolean }> {
    const root = await withinTime(realpath(cwd));
    return this.enqueue(root, async () => {
      const signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS);
      await this.load();
      const initial = this.trusted.get(id);
      const holds = (initial?.packs ?? []).map((pack) => this.holdPack(initial!.cwd, pack));
      try {
        const row = await this.requirePoint(sessionId, root, id, signal);
        const pinned = { ...await this.pinnedAttributes(root, signal), signal };
        let truncated = false;
        const options: GitOptions = { ...pinned, limit: PREVIEW_LIMIT, truncate: true, onTruncate: () => { truncated = true; } };
        // The restore direction (current files → the point). -R swaps the a/ b/ prefixes too, so they are swapped back:
        // the headers read a/ (now) → b/ (after the restore), as in any diff.
        const text = await this.git(root, ["diff", "-R", "--src-prefix=b/", "--dst-prefix=a/", "--no-ext-diff", "--no-textconv", "--no-color", row.tree, "--", "."], options);
        const names: string[] = [];
        let bytes = 0;
        await this.records(root, ["diff", "-R", "--name-only", "-z", "--no-ext-diff", "--no-textconv", row.tree, "--", "."], (record) => {
          if ((bytes += record.length) > PREVIEW_LIMIT) { truncated = true; return; }
          names.push(record.toString("utf8"));
        }, pinned);
        // A preview is cut at the output limit (the restore still uses the complete snapshot); the dialog says so.
        return { text: visible(this.redact(text)), changedFiles: names.map((name) => visible(this.redact(name))), truncated };
      } finally { for (const done of holds) await done(); }
    }, this.previews);
  }
  /** The attributes source and filter overrides for calls that compare with or write the working tree. */
  private async pinnedAttributes(root: string, signal?: AbortSignal): Promise<Pick<GitOptions, "attributes" | "extraConfig">> {
    const tree = await this.git(root, ["rev-parse", "--verify", "HEAD^{tree}"], { signal }).catch(() => "");
    return { attributes: OID.test(tree) ? tree : await this.emptyTree(root), extraConfig: await this.filterOverrides(root, signal) };
  }
  private async emptyTree(root: string): Promise<string> {
    const empty = await this.git(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
    if (!OID.test(empty)) throw new Error("Invalid empty tree.");
    return empty;
  }
  /**
   * Restores tracked files and the index (HEAD and the branch stay where they are); the current work is saved first
   * as a "before-restore" rollback point. Refused when a file the restore would write exists untracked, or when Git
   * is told to ignore changes in some tracked files: neither would be in that saved point.
   */
  async restore(sessionId: string, cwd: string, id: string): Promise<{ ok: true }> {
    const root = await withinTime(realpath(cwd));
    return this.enqueue(root, () => this.restoreOne(sessionId, root, id));
  }
  private async inspectIndex(root: string): Promise<{ paths: Set<string>; submodules: boolean; flagged: boolean }> {
    const paths = new Set<string>();
    let submodules = false, flagged = false;
    await this.records(root, ["ls-files", "-z", "-v", "--stage"], (record) => {
      // "<tag> <mode> <oid> <stage>\t<path>": a lowercase tag is assume-unchanged, S/s skip-worktree.
      const tab = record.indexOf(9);
      const head = record.subarray(0, tab).toString("latin1");
      const tag = head[0];
      if (tag === "S" || (tag >= "a" && tag <= "z")) flagged = true;
      if (head.slice(2, 8) === "160000") submodules = true;
      paths.add(record.subarray(tab + 1).toString("latin1"));
    });
    return { paths, submodules, flagged };
  }
  private async treeEntries(root: string, tree: string, onEntry: (mode: string, path: Buffer) => void): Promise<void> {
    await this.records(root, ["ls-tree", "-r", "-z", "--full-tree", tree], (record) => {
      const tab = record.indexOf(9);
      onEntry(record.subarray(0, 6).toString("latin1"), record.subarray(tab + 1));
    });
  }
  private async restoreOne(sessionId: string, root: string, id: string): Promise<{ ok: true }> {
    const initial = this.trusted.get(id);
    // Hold the point's packs: the safety capture's pruning may drop the point itself at a retention of one.
    const holds = (initial?.packs ?? []).map((pack) => this.holdPack(initial!.cwd, pack));
    const release = async (): Promise<void> => { for (const done of holds) await done(); };
    try {
      const row = await this.requirePoint(sessionId, root, id);
      const index = await this.inspectIndex(root);
      // Inspect modes only at NUL-delimited record starts: paths can contain newlines, tabs or "160000".
      // The parent snapshot does not retain dirty/untracked nested repository data for a safe recursive restore.
      let submodules = index.submodules;
      const incoming: Buffer[] = [];
      const target = new Set<string>();
      for (const tree of new Set([row.tree, row.indexTree])) {
        await this.treeEntries(root, tree, (mode, path) => {
          if (mode === "160000") submodules = true;
          if (tree !== row.tree) return;
          const key = path.toString("latin1");
          target.add(key);
          if (!index.paths.has(key)) incoming.push(Buffer.from(path));
        });
      }
      // A case-insensitive file system (macOS, Windows): a tracked path that differs from an incoming one only in case
      // is the same file. It is not an untracked collision, but Git would write the incoming file and then delete the
      // tracked one (the same file), so the tracked one is removed first (its content is in the safety point).
      // Unset (Git leaves it so on a case-sensitive file system) makes `git config` exit with 1: that is false.
      const ignoreCase = await this.git(root, ["config", "--type=bool", "core.ignorecase"]).then((value) => value === "true", () => false);
      const folded = new Map<string, string>();
      if (ignoreCase) for (const path of index.paths) folded.set(foldPath(path), path);
      const caseRenamed = new Set<string>();
      if (ignoreCase) {
        for (const path of incoming) {
          const tracked = folded.get(foldPath(path.toString("latin1")));
          if (tracked !== undefined && !target.has(tracked)) caseRenamed.add(tracked);
        }
      }
      if (submodules) {
        throw new CheckpointRefusal("submodules", "Submodule contents are not captured by checkpoints. Restoration is unavailable when the current index or saved checkpoint contains submodules; safeguard the nested repositories and restore them with Git separately.");
      }
      if (index.flagged) throw new CheckpointRefusal("worktree-conflict", "Git is told to ignore changes in some tracked files (assume-unchanged or skip-worktree).");
      if (await this.untrackedCollision(root, incoming, (key) => index.paths.has(key) || (ignoreCase && folded.has(foldPath(key))))) {
        throw new CheckpointRefusal("worktree-conflict", "A file the restore would write exists untracked in the folder.");
      }
      const head = await this.git(root, ["rev-parse", "--verify", "HEAD^{tree}"]).catch(() => "");
      await this.requireNoFilters(root, OID.test(head) ? head : await this.emptyTree(root), undefined, row.tree);
      // Never restore over work that could not be saved first (for example a branch without a commit yet).
      if (!await this.captureOne(sessionId, root, "before-restore")) {
        throw new CheckpointRefusal("no-safety-point", "The current work could not be saved as a rollback point first.");
      }
      // Capture may prune this checkpoint at a retention limit of one. Re-import its held private pack
      // after capture, immediately before restore, in case Git garbage-collected the earlier import.
      await this.ensureObjects(root, row);
      const options = { attributes: row.tree, extraConfig: await this.filterOverrides(root) };
      if (caseRenamed.size > 0) {
        const input = Readable.from([Buffer.concat([...caseRenamed].map((path) => Buffer.from(`${path}\0`, "latin1")))]);
        await this.git(root, ["--literal-pathspecs", "rm", "-q", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], { ...options, input, timeoutMs: 300_000 });
      }
      // Keep the current index until Git removes tracked paths absent from the target worktree.
      // Restoring the index first would turn post-checkpoint additions into untouched untracked files.
      await this.git(root, ["restore", `--source=${row.tree}`, "--worktree", "--", "."], { ...options, timeoutMs: 300_000 });
      await this.git(root, ["restore", `--source=${row.indexTree}`, "--staged", "--", "."], { ...options, timeoutMs: 300_000 });
      return { ok: true };
    } finally { await release(); }
  }
  /** A path the restore would create (or one of its folders) already exists without being tracked. */
  private async untrackedCollision(root: string, incoming: Buffer[], tracked: (path: string) => boolean): Promise<boolean> {
    const checked = new Set<string>();
    const base = Buffer.from(root + "/");
    for (const path of incoming) {
      const parts: number[] = [];
      for (let index = path.indexOf(47); index !== -1; index = path.indexOf(47, index + 1)) parts.push(index);
      for (const end of [...parts, path.length]) {
        const part = path.subarray(0, end), key = part.toString("latin1");
        if (checked.has(key)) continue;
        checked.add(key);
        if (tracked(key)) continue;
        let entry;
        try { entry = await lstat(Buffer.concat([base, part])); } catch { break; }
        if (!entry.isDirectory()) return true;
        // A folder where the point has a file (a file the turn turned into a folder): Git replaces it, deleting what is
        // in it. That is safe only when every file in it is tracked (so in the safety point); anything else refuses.
        if (end === path.length) {
          if (await this.untrackedInside(root, part)) return true;
          break;
        }
      }
    }
    return false;
  }
  /** Whether a folder holds any file Git does not track, ignored ones included (a path that is not UTF-8: assumed). */
  private async untrackedInside(root: string, folder: Buffer): Promise<boolean> {
    const name = folder.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(folder)) return true;
    let found = false;
    await this.records(root, ["--literal-pathspecs", "ls-files", "-z", "--others", "--", `${name}/`], () => { found = true; });
    return found;
  }
}

/** Settles like `work`, or fails once FOLDER_TIMEOUT_MS passed (a hung mount: the call itself cannot be cancelled). */
function withinTime<T>(work: Promise<T>, ms = FOLDER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("The folder did not answer in time."), { code: "ETIMEDOUT" })), ms);
    timer.unref?.();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A path (bytes as latin1) as a case-insensitive file system compares it. */
function foldPath(path: string): string {
  return Buffer.from(path, "latin1").toString("utf8").normalize("NFC").toLowerCase();
}

/** Text shown in the dialog, without bidirectional formatting controls. */
function visible(text: string): string {
  return text.replace(BIDI_CONTROLS, "");
}

function pointTime(id: string): number {
  return Number(id.slice(id.lastIndexOf("/") + 1).split("-", 1)[0]);
}

function parseRow(value: unknown): { id: string; row: TrustedCheckpoint } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^refs\/canvastty\/[\w-]{1,100}\/\d{1,16}-[0-9a-f-]{36}$/u.test(row.id)) return null;
  if (typeof row.cwd !== "string" || !row.cwd || row.cwd.includes("\0") || typeof row.sessionId !== "string" || !row.id.startsWith(`refs/canvastty/${row.sessionId}/`)) return null;
  for (const key of ["oid", "tree", "indexTree"]) if (typeof row[key] !== "string" || !OID.test(row[key] as string)) return null;
  if (row.packs !== undefined && (!Array.isArray(row.packs) || row.packs.length > MAX_PACK_CHAIN + 1
    || !row.packs.every((pack) => typeof pack === "string" && OID.test(pack)))) return null;
  const kind = row.kind ?? "before-turn";
  if (kind !== "before-turn" && kind !== "before-restore") return null;
  return { id: row.id, row: { cwd: row.cwd, sessionId: row.sessionId, kind, oid: row.oid as string, tree: row.tree as string,
    indexTree: row.indexTree as string, ...(row.packs ? { packs: [...row.packs as string[]] } : {}) } };
}
