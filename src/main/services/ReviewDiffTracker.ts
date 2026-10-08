import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ReviewDiffBaseline { root: string; head: string; reason?: string }

/** Host-owned attribution for managed PTYs. A shared or previously dirty tree cannot establish ownership. */
export class ReviewDiffTracker {
  private readonly active = new Map<string, { root: string | null; cwd: string }>();
  private readonly baselines = new Map<string, ReviewDiffBaseline>();

  /** Synchronous by design: no other managed launch can interleave between this capture and spawnPty. */
  beforeSpawn(id: string, cwd: string, requested: boolean, parentCwd?: string): void {
    this.forget(id);
    let root: string | null = null;
    try { root = this.root(cwd); } catch { /* A non-Git or inaccessible launch cannot supply a review diff. */ }
    let canonicalCwd = resolve(cwd);
    try { canonicalCwd = realpathSync(cwd); } catch { /* Retain the absolute path for conservative overlap checks. */ }
    for (const baseline of this.baselines.values()) {
      if (baseline.root === root || root === null && overlaps(canonicalCwd, baseline.root)) baseline.reason = "Another managed session started in this worktree; its changes cannot be attributed to this worker.";
    }
    const shared = [...this.active.values()].some(other => other.root === root || other.root === null && root !== null && overlaps(other.cwd, root));
    this.active.set(id, { root, cwd: canonicalCwd });
    if (!requested) return;
    const baseline: ReviewDiffBaseline = { root: root ?? cwd, head: "" };
    this.baselines.set(id, baseline);
    try {
      if (!root) throw new Error("The worker's effective launch directory is not a verifiable Git worktree.");
      if (!parentCwd || this.root(parentCwd) === root || shared) {
        throw new Error("Automatic review requires a separate worktree; this worker shares its tree with its parent or another managed session.");
      }
      const safe = this.safeArguments(root);
      if (this.git(root, [...safe, "ls-files", "--stage"]).split("\n").some(line => line.startsWith("160000 "))) {
        throw new Error("Automatic review cannot attribute changes in a worktree containing submodules.");
      }
      if (this.git(root, [...safe, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"])) {
        throw new Error("The worker worktree was already dirty at launch; automatic review cannot attribute those changes to the worker.");
      }
      const head = this.git(root, [...safe, "rev-parse", "--verify", "HEAD^{commit}"]);
      if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("The worker's initial Git commit could not be verified.");
      baseline.head = head;
    } catch (error) {
      baseline.reason = error instanceof Error ? error.message : "The worker review baseline could not be captured.";
    }
  }

  baseline(id: string): ReviewDiffBaseline {
    const baseline = this.baselines.get(id);
    if (!baseline) throw new Error("No worker-specific review baseline was captured for this launch.");
    if (baseline.reason) throw new Error(baseline.reason);
    if (this.root(baseline.root) !== baseline.root) throw new Error("The worker's Git worktree changed after launch.");
    return baseline;
  }

  assertCurrent(id: string, expected: ReviewDiffBaseline): void {
    if (this.baseline(id) !== expected) throw new Error("The worker was restarted or removed while its diff was being read.");
  }

  stopped(id: string): void { this.active.delete(id); }
  forget(id: string): void { this.active.delete(id); this.baselines.delete(id); }

  private root(cwd: string): string {
    return realpathSync(this.git(cwd, ["rev-parse", "--show-toplevel"]));
  }

  private safeArguments(cwd: string): string[] {
    let filters = "";
    try { filters = this.git(cwd, ["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]); }
    catch (error) { if ((error as {status?: number}).status !== 1) throw error; }
    return filters.split("\n").flatMap(line => {
      const key = line.split(/\s/u, 1)[0];
      return /^filter\..*\.(clean|smudge|process|required)$/u.test(key) ? ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`] : [];
    });
  }

  private git(cwd: string, args: string[]): string {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    return execFileSync("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "diff.external=", "-C", cwd, ...args], {
      env: {...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0"}, timeout: 1500, maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
    }).trimEnd();
  }
}

function overlaps(first: string, second: string): boolean {
  const inside = (root: string, path: string): boolean => {
    const rel = relative(root, path);
    return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  return inside(first, second) || inside(second, first);
}
