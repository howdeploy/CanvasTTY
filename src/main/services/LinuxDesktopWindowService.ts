import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DesktopWindowCandidate } from "../../shared/desktopWindows.ts";
import type { LinuxDesktopWindowViewport } from "../../shared/linuxDesktopWindows.ts";

interface NativeCandidate { Handle: string; Pid: number; Title: string; Process: string }
interface Grant { owner: string; candidate: NativeCandidate; expires: number }
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** The Windows implementation is intentionally independent of this X11 transport. */
export class LinuxDesktopWindowService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private grants = new Map<string, Grant>();
  private attached = new Map<string, number>();
  private attaching = new Set<string>();
  private cancelled = new Set<string>();
  private pending = new Map<string, Pending>();
  private lease: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly helperPath: string, private readonly parentHandle: () => string,
    private readonly onFocus: (owner: string) => void) {}

  async list(owner: string): Promise<DesktopWindowCandidate[]> {
    const result = await this.command("list");
    if (!Array.isArray(result)) throw new Error("Invalid X11 window list.");
    for (const [id, grant] of this.grants) {
      if (grant.owner === owner || grant.expires < Date.now()) this.grants.delete(id);
    }
    return result.slice(0, 200).map((candidate: NativeCandidate) => {
      if (!candidate || !/^\d{1,10}$/.test(candidate.Handle) || !Number.isInteger(candidate.Pid)
        || candidate.Pid <= 1 || typeof candidate.Title !== "string" || candidate.Title.length > 1024
        || typeof candidate.Process !== "string" || candidate.Process.length > 256) {
        throw new Error("Invalid X11 window candidate.");
      }
      const id = randomUUID();
      this.grants.set(id, { owner, candidate, expires: Date.now() + 60_000 });
      return { id, title: candidate.Title, process: candidate.Process };
    });
  }

  async attach(owner: string, id: string): Promise<void> {
    if (this.attached.has(owner) || this.attaching.has(owner)) throw new Error("This card already has an embedded window.");
    if (this.attached.size + this.attaching.size >= 8) throw new Error("At most eight desktop windows may be embedded.");
    const grant = this.grants.get(id);
    if (!grant || grant.owner !== owner || grant.expires < Date.now()) throw new Error("Window selection expired. Refresh the list.");
    this.grants.delete(id);
    this.attaching.add(owner);
    try {
      await this.command("attach", { token: owner, handle: grant.candidate.Handle, pid: grant.candidate.Pid, parent: this.parentHandle() });
      if (!this.cancelled.has(owner)) this.attached.set(owner, Date.now());
    } finally {
      this.attaching.delete(owner);
      this.cancelled.delete(owner);
    }
  }

  async update(owner: string, viewport: LinuxDesktopWindowViewport): Promise<void> {
    if (!this.attached.has(owner)) throw new Error("Desktop window is no longer attached.");
    this.attached.set(owner, Date.now());
    try {
      await this.command("update", { token: owner, ...viewport });
    } catch (error) {
      await this.detach(owner).catch(() => undefined);
      throw error;
    }
  }

  async detach(owner: string): Promise<void> {
    for (const [id, grant] of this.grants) if (grant.owner === owner) this.grants.delete(id);
    if (!this.attached.has(owner) && !this.attaching.has(owner)) return;
    if (this.attaching.has(owner)) this.cancelled.add(owner);
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
    await new Promise<void>((resolve) => {
      // XFixes SaveSetRoot restores clients even if a hung helper must be killed.
      const terminate = setTimeout(() => child.kill("SIGTERM"), 2000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 4000);
      child.once("close", () => { clearTimeout(terminate); clearTimeout(kill); resolve(); });
      child.stdin.end();
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (process.platform !== "linux") throw new Error("The X11 desktop helper is Linux-only.");
    const parent = this.parentHandle();
    if (!/^\d{1,10}$/.test(parent) || Number(parent) <= 0 || Number(parent) > 0xffffffff) {
      throw new Error("CanvasTTY must run on X11/XWayland. Restart DEV with --ozone-platform=x11.");
    }
    const child = spawn("/usr/bin/python3", ["-I", "-u", this.helperPath, String(process.pid), parent], { stdio: "pipe" });
    this.child = child;
    let diagnostic = "", output = "";
    child.stderr.on("data", (data: Buffer) => { diagnostic = (diagnostic + data.toString("utf8")).slice(-4096); });
    const fail = (error: Error): void => {
      if (this.child !== child) return;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
      this.grants.clear();
      this.attached.clear();
      if (this.lease) clearInterval(this.lease);
      this.lease = null;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1024 * 1024) {
        child.stdin.end();
        fail(new Error("X11 helper response exceeds its size limit."));
        return;
      }
      let newline: number;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          const response = JSON.parse(line) as { id?: string; ok?: boolean; result?: unknown; error?: string; event?: string; token?: string };
          if (response?.event === "focus" && typeof response.token === "string" && this.attached.has(response.token)) {
            this.onFocus(response.token);
            continue;
          }
          const request = response && typeof response.id === "string" ? this.pending.get(response.id) : undefined;
          if (!request) continue;
          this.pending.delete(response.id!);
          clearTimeout(request.timer);
          if (response.ok === true) request.resolve(response.result);
          else request.reject(new Error(typeof response.error === "string" ? response.error : "X11 window operation failed."));
        } catch {
          child.stdin.end();
          fail(new Error("Invalid X11 helper response."));
          return;
        }
      }
    });
    child.once("error", fail);
    child.stdin.on("error", (error: Error) => { child.kill("SIGTERM"); fail(error); });
    child.once("close", () => {
      fail(new Error(diagnostic.trim() || "X11 desktop helper stopped. Python 3, libX11, libXfixes and DISPLAY are required."));
      if (this.child === child) this.child = null;
    });
    this.lease = setInterval(() => {
      for (const [owner, seen] of this.attached) if (Date.now() - seen > 3000) void this.detach(owner).catch(() => undefined);
    }, 1000);
    this.lease.unref();
    return child;
  }

  private command(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const child = this.start();
    if (this.pending.size >= 128) throw new Error("Too many pending X11 window operations.");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.dispose();
        reject(new Error("X11 desktop operation timed out; restoring the window."));
      }, 12_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, action, ...params }) + "\n", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}
