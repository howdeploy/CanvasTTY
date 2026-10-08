import { execFileSync } from "node:child_process";

export type ProcessGroupSignal = "SIGSTOP" | "SIGCONT";
export interface OwnedProcessGroup {
  readonly pid: number;
}
export interface ProcessTreePauseResult {
  supported: boolean;
  failed?: string;
}
export interface ProcessRow { pid: number; ppid: number }

type SignalGroup = (groupId: number, signal: ProcessGroupSignal) => void;
/**
 * Descendant tracking. `list` returns every process with its parent; `signal` delivers to one pid. A process that
 * called setsid() (or otherwise left the PTY's process group) is still a descendant by parent chain, so it is found
 * here even though the group signal cannot reach it.
 */
export interface ProcessTreeAccess {
  list(): ProcessRow[];
  signal(pid: number, signal: ProcessGroupSignal): void;
}

interface PausedTree { groupId: number; descendants: number[] }

/** Bounded rescans: a running descendant may fork between one listing and its own SIGSTOP. */
const MAX_SCAN_ROUNDS = 8;
const MAX_DESCENDANTS = 4096;

/**
 * Suspends a PTY process group whose leader was started and remains owned by this host, plus every process that
 * descends from that leader by parent pid at pause time, including ones that moved to their own session.
 * node-pty's forkpty child is the process-group/session leader, so a negative pid targets that child's group rather
 * than a caller-selected pid. Callers still retain the precise PTY object; a PID alone is never accepted as a target.
 *
 * Known limit: a process whose parent already exited before the pause was re-parented to init (or a subreaper) and
 * has no parent chain to the PTY any more, so it cannot be attributed to the task and keeps running.
 */
export class ProcessTreePause {
  private readonly pausedGroups = new WeakMap<object, PausedTree>();
  private readonly signalGroup: SignalGroup;
  private readonly tree: ProcessTreeAccess | null;
  readonly supported: boolean;

  /**
   * With no arguments the real process table and signals are used. An injected `signalGroup` without `tree`
   * disables descendant tracking, so a test double can never reach real processes through `ps`.
   */
  constructor(
    platform = process.platform,
    signalGroup?: SignalGroup,
    tree?: ProcessTreeAccess | null
  ) {
    this.supported = platform !== "win32";
    this.signalGroup = signalGroup ?? ((groupId, signal) => process.kill(-groupId, signal));
    this.tree = tree !== undefined ? tree : signalGroup ? null : (this.supported ? systemProcessTree() : null);
  }

  isPaused(process: OwnedProcessGroup):boolean {return this.pausedGroups.has(process);}

  pause(process: OwnedProcessGroup): ProcessTreePauseResult {
    if (!this.supported) return unsupportedResult();
    const groupId = process.pid;
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      return { supported: true, failed: "The owned PTY did not provide a valid process-group identifier." };
    }
    if (this.pausedGroups.has(process)) return { supported: true };
    try {
      this.signalGroup(groupId, "SIGSTOP");
    } catch (error) {
      if (signalCode(error) !== "ESRCH") {
        return { supported: true, failed: `Could not suspend the owned PTY process group (${signalCode(error) ?? "unknown error"}).` };
      }
    }
    const scan = this.stopDescendants(groupId);
    this.pausedGroups.set(process, { groupId, descendants: scan.stopped });
    return { supported: true, ...(scan.failed ? { failed: scan.failed } : {}) };
  }

  resume(process: OwnedProcessGroup): ProcessTreePauseResult {
    // No group can be recorded on an unsupported platform, so cleanup is a no-op and must not
    // manufacture a failure for every ordinary PTY exit.
    if (!this.supported) return { supported: true };
    const paused = this.pausedGroups.get(process);
    if (paused === undefined) return { supported: true };
    try {
      this.signalGroup(paused.groupId, "SIGCONT");
    } catch (error) {
      if (signalCode(error) !== "ESRCH") {
        return { supported: true, failed: `Could not resume the owned PTY process group (${signalCode(error) ?? "unknown error"}).` };
      }
    }
    const remaining: number[] = [];
    let failure: string | undefined;
    for (const pid of paused.descendants) {
      try { this.tree?.signal(pid, "SIGCONT"); }
      catch (error) {
        if (signalCode(error) === "ESRCH") continue;
        remaining.push(pid);
        failure = `Could not resume a detached descendant process (${signalCode(error) ?? "unknown error"}).`;
      }
    }
    if (failure) {
      // Keep ownership of the descendants that are still stopped so a later resume can retry them.
      this.pausedGroups.set(process, { groupId: paused.groupId, descendants: remaining });
      return { supported: true, failed: failure };
    }
    this.pausedGroups.delete(process);
    return { supported: true };
  }

  /** Stops every descendant of `rootPid` by parent chain, rescanning until a pass finds nothing new. */
  private stopDescendants(rootPid: number): { stopped: number[]; failed?: string } {
    if (!this.tree) return { stopped: [] };
    const stopped = new Set<number>(), known = new Set<number>([rootPid]);
    const failures = new Set<string>();
    for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
      let rows: ProcessRow[];
      try { rows = this.tree.list(); }
      catch {
        failures.add("Could not list descendant processes; a process that left the PTY's process group may keep running.");
        break;
      }
      const children = new Map<number, number[]>();
      for (const row of rows) {
        const list = children.get(row.ppid);
        if (list) list.push(row.pid); else children.set(row.ppid, [row.pid]);
      }
      // Earlier-seen descendants stay roots, so a child whose parent exited between rounds is still reached
      // when it was already known.
      const queue = [...known];
      let found = false;
      while (queue.length) {
        const parent = queue.pop()!;
        for (const pid of children.get(parent) ?? []) {
          if (pid === process.pid || pid <= 1 || known.has(pid)) continue;
          known.add(pid);
          queue.push(pid);
          if (known.size > MAX_DESCENDANTS) break;
          try { this.tree.signal(pid, "SIGSTOP"); stopped.add(pid); found = true; }
          catch (error) {
            if (signalCode(error) !== "ESRCH") failures.add(`Could not suspend a descendant process (${signalCode(error) ?? "unknown error"}).`);
          }
        }
      }
      if (!found || known.size > MAX_DESCENDANTS) break;
    }
    if (known.size > MAX_DESCENDANTS) failures.add("The task has too many descendant processes to suspend individually.");
    return { stopped: [...stopped], ...(failures.size ? { failed: [...failures].join(" ") } : {}) };
  }
}

function systemProcessTree(): ProcessTreeAccess {
  return {
    list() {
      const text = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      const rows: ProcessRow[] = [];
      for (const line of text.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
        if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
      }
      return rows;
    },
    signal(pid, signal) { process.kill(pid, signal); }
  };
}

function signalCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return null;
}

function unsupportedResult(): ProcessTreePauseResult {
  return {
    supported: false,
    failed: "Windows cannot safely suspend a PTY process tree; existing processes may continue while input and new launches are blocked."
  };
}
