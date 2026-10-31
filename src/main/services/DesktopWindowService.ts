import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  DesktopWindowCandidate,
  DesktopWindowViewport,
} from "../../shared/desktopWindows.ts";

interface NativeCandidate {
  Handle: string;
  Pid: number;
  Title: string;
  Process: string;
}
interface Grant {
  owner: string;
  candidate: NativeCandidate;
  expires: number;
}
interface Attachment {
  owner: string;
  seen: number;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** HWNDs stay in the main process; plugins receive short-lived, owner-bound capabilities. */
export class DesktopWindowService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private grants = new Map<string, Grant>();
  private attached = new Map<string, Attachment>();
  private pending = new Map<string, Pending>();
  private attaching = new Set<string>();
  private cancelledAttaches = new Set<string>();
  private lease: ReturnType<typeof setInterval> | null = null;
  private diagnostic = "";

  private readonly helperPath: string;
  private readonly parentHandle: () => string;
  constructor(helperPath: string, parentHandle: () => string) {
    this.helperPath = helperPath;
    this.parentHandle = parentHandle;
  }

  async list(owner: string): Promise<DesktopWindowCandidate[]> {
    const result = (await this.command("list")) as NativeCandidate[] | null;
    for (const [id, grant] of this.grants)
      if (grant.owner === owner || grant.expires < Date.now())
        this.grants.delete(id);
    return (Array.isArray(result) ? result : [])
      .slice(0, 200)
      .map((candidate) => {
        const id = randomUUID();
        this.grants.set(id, { owner, candidate, expires: Date.now() + 60_000 });
        return { id, title: candidate.Title, process: candidate.Process };
      });
  }

  async attach(owner: string, id: string): Promise<void> {
    if (this.attached.has(owner) || this.attaching.has(owner))
      throw new Error("This card already has an embedded window.");
    if (this.attached.size + this.attaching.size >= 8)
      throw new Error("At most eight desktop windows may be embedded.");
    const grant = this.grants.get(id);
    if (!grant || grant.owner !== owner || grant.expires < Date.now())
      throw new Error("Window selection expired. Refresh the list.");
    this.grants.delete(id);
    this.attaching.add(owner);
    try {
      const candidate = grant.candidate;
      await this.command("attach", {
        token: owner,
        handle: candidate.Handle,
        pid: candidate.Pid,
        parent: this.parentHandle(),
      });
      if (!this.cancelledAttaches.has(owner))
        this.attached.set(owner, { owner, seen: Date.now() });
    } finally {
      this.attaching.delete(owner);
      this.cancelledAttaches.delete(owner);
    }
  }

  async update(owner: string, viewport: DesktopWindowViewport): Promise<void> {
    const entry = this.attached.get(owner);
    if (!entry) throw new Error("Desktop window is no longer attached.");
    entry.seen = Date.now();
    await this.command("update", { token: owner, ...viewport });
  }

  async detach(owner: string): Promise<void> {
    for (const [id, grant] of this.grants)
      if (grant.owner === owner) this.grants.delete(id);
    // Attach and detach share the helper's FIFO pipe. Sending detach even while an
    // attach is in flight prevents a closed/reloaded card from leaving an orphan.
    if (!this.attached.has(owner) && !this.attaching.has(owner)) return;
    if (this.attaching.has(owner)) this.cancelledAttaches.add(owner);
    try {
      await this.command("detach", { token: owner });
    } finally {
      this.attached.delete(owner);
    }
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.lease) clearInterval(this.lease);
    this.lease = null;
    // Closing stdin makes the native helper restore every window before exiting.
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.stdin.end();
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (process.platform !== "win32")
      throw new Error(
        "Desktop window embedding is currently supported on Windows only.",
      );
    if (this.child) return this.child;
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.helperPath,
        "-OwnerProcessId",
        String(process.pid),
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    this.child = child;
    this.diagnostic = "";
    child.stderr.on("data", (data: Buffer) => {
      this.diagnostic = (this.diagnostic + data.toString("utf8")).slice(-4096);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let response: {
        id: string;
        ok: boolean;
        result?: unknown;
        error?: string;
      };
      try {
        response = JSON.parse(line);
      } catch {
        return;
      }
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.ok) request.resolve(response.result);
      else
        request.reject(
          new Error(response.error ?? "Desktop window operation failed."),
        );
    });
    const fail = (error: Error): void => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.attached.clear();
      this.grants.clear();
      this.child = null;
      if (this.lease) clearInterval(this.lease);
      this.lease = null;
    };
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.once("exit", () =>
      fail(new Error(this.diagnostic || "Desktop window helper stopped.")),
    );
    this.lease = setInterval(() => {
      for (const entry of this.attached.values()) {
        if (Date.now() - entry.seen > 3_000)
          void this.detach(entry.owner).catch(() => undefined);
      }
    }, 1000);
    this.lease.unref();
    return child;
  }

  private command(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const child = this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Restore through EOF if a native operation stalls; never leave a window owned by a timed-out request.
        child.stdin.end();
        reject(new Error("Desktop window operation timed out."));
      }, 12_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ id, action, ...params }) + "\n",
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        },
      );
    });
  }
}
