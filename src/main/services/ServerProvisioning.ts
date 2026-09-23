import { randomUUID } from "node:crypto";
import { isValidRemoteHost, providerPermittedOnHost, type AgentProviderId, type RemoteHost } from "../../shared/contracts.ts";
import type { RemoteHostRunner } from "./RemoteHostsService.ts";
import type { RemoteProviderAccess } from "./RemoteProviderAccess.ts";
import type { RemoteProviderDiscovery } from "./RemoteProviderDiscovery.ts";

/** Official npm packages only; everything else is reported as not installable here. */
export const PROVISIONABLE_AGENTS: Readonly<Partial<Record<AgentProviderId, string>>> = Object.freeze({
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
  qwen: "@qwen-code/qwen-code"
});

const BASE_PACKAGES = ["nodejs", "npm", "podman", "uidmap", "slirp4netns", "git", "curl", "python3"];
/** Below this, npm installs can exhaust memory and make the server unreachable. */
const SWAP_BELOW_MB = 2048;
const MAX_LOG_LINES = 200;
const MAX_JOBS = 64;

export type ProvisionPhase = "queued" | "checking" | "swap" | "packages" | "agents" | "verifying" | "done" | "failed";

export interface ProvisionJob {
  jobId: string;
  hostId: string;
  phase: ProvisionPhase;
  log: string[];
  installed: AgentProviderId[];
  skipped: Array<{ provider: AgentProviderId; reason: "api-blocked" | "api-unknown" | "host-rule" | "not-installable" }>;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const TIMEOUTS = { check: 30_000, swap: 90_000, packages: 900_000, agents: 1_200_000 };

/** Runs as root, or through passwordless sudo; anything else stops with a clear reason. */
const PRIVILEGE = 'if [ "$(id -u)" -eq 0 ]; then S=""; elif sudo -n true 2>/dev/null; then S="sudo -n"; else echo CTTY_NO_ROOT; exit 3; fi';

function remoteScript(body: string): string[] {
  if (body.includes("'")) throw new Error("Provisioning scripts must not contain single quotes.");
  return [`sh -c '${PRIVILEGE}; ${body}'`];
}

function field(output: string, name: string): string | undefined {
  return output.split(/\r?\n/u).find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim();
}

export class ServerProvisioning {
  private readonly hosts: () => readonly RemoteHost[];
  private readonly run: RemoteHostRunner;
  private readonly access: Pick<RemoteProviderAccess, "probe">;
  private readonly discovery: Pick<RemoteProviderDiscovery, "discover">;
  private readonly jobs = new Map<string, ProvisionJob>();
  private readonly activeHosts = new Set<string>();

  constructor(options: { hosts: () => readonly RemoteHost[]; run: RemoteHostRunner; access: Pick<RemoteProviderAccess, "probe">; discovery: Pick<RemoteProviderDiscovery, "discover"> }) {
    this.hosts = options.hosts;
    this.run = options.run;
    this.access = options.access;
    this.discovery = options.discovery;
  }

  /** Starts one background job per saved host; a host already being prepared keeps its running job. */
  start(hostIds: unknown): string[] {
    if (!Array.isArray(hostIds) || hostIds.length === 0 || hostIds.length > 64 || hostIds.some(id => typeof id !== "string")) throw new Error("Choose saved servers to prepare.");
    const ids: string[] = [];
    for (const hostId of new Set(hostIds as string[])) {
      const host = this.hosts().find(item => item.id === hostId);
      if (!host || !isValidRemoteHost(host)) throw new Error(`Server ${hostId} is not a valid saved server.`);
      const running = [...this.jobs.values()].find(job => job.hostId === hostId && !job.finishedAt);
      if (running) { ids.push(running.jobId); continue; }
      const job: ProvisionJob = { jobId: randomUUID(), hostId, phase: "queued", log: [], installed: [], skipped: [], startedAt: Date.now() };
      this.jobs.set(job.jobId, job);
      this.prune();
      ids.push(job.jobId);
      void this.execute(job, host);
    }
    return ids;
  }

  status(jobIds: unknown): ProvisionJob[] {
    if (!Array.isArray(jobIds) || jobIds.length > 64) throw new Error("Invalid provisioning job list.");
    return jobIds.flatMap(id => { const job = typeof id === "string" ? this.jobs.get(id) : undefined; return job ? [structuredClone(job)] : []; });
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter(job => job.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!);
    while (this.jobs.size > MAX_JOBS && finished.length) this.jobs.delete(finished.shift()!.jobId);
  }

  private note(job: ProvisionJob, line: string): void {
    job.log.push(line);
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }

  private async step(job: ProvisionJob, host: RemoteHost, phase: ProvisionPhase, body: string, timeoutMs: number): Promise<string> {
    job.phase = phase;
    const result = await this.run(host, remoteScript(body), timeoutMs);
    const output = `${result.stdout}\n${result.stderr}`;
    if (output.includes("CTTY_NO_ROOT")) throw new Error("Server preparation needs root or passwordless sudo for this SSH user.");
    if (result.code !== 0) throw new Error(`${phase} failed (exit ${result.code ?? "timeout"}): ${output.trim().split(/\r?\n/u).slice(-3).join(" | ").slice(0, 400)}`);
    return result.stdout;
  }

  private async execute(job: ProvisionJob, host: RemoteHost): Promise<void> {
    if (this.activeHosts.has(host.id)) return;
    this.activeHosts.add(host.id);
    try {
      const facts = await this.step(job, host, "checking",
        '. /etc/os-release; echo os=$ID; echo mem=$(awk "/MemTotal/{print int(\\$2/1024)}" /proc/meminfo); echo swap=$(awk "/SwapTotal/{print int(\\$2/1024)}" /proc/meminfo); command -v apt-get >/dev/null && echo apt=yes || echo apt=no',
        TIMEOUTS.check);
      const os = field(facts, "os"), mem = Number(field(facts, "mem")), swap = Number(field(facts, "swap"));
      this.note(job, `os=${os} memory=${mem}MB swap=${swap}MB`);
      if (field(facts, "apt") !== "yes" || !["ubuntu", "debian"].includes(os ?? "")) throw new Error("Automatic preparation supports Ubuntu and Debian servers.");

      // Only agents whose API answers from this server are worth installing there.
      const reach = await this.access.probe(host);
      const wanted: AgentProviderId[] = [];
      for (const [provider, pkg] of Object.entries(PROVISIONABLE_AGENTS) as Array<[AgentProviderId, string]>) {
        if (!pkg) continue;
        if (!providerPermittedOnHost(host, provider)) job.skipped.push({ provider, reason: "host-rule" });
        else if (reach.providers[provider] === true) wanted.push(provider);
        else job.skipped.push({ provider, reason: reach.providers[provider] === false ? "api-blocked" : "api-unknown" });
      }
      this.note(job, `agents to install: ${wanted.join(", ") || "none"}`);

      if (Number.isFinite(mem) && mem < SWAP_BELOW_MB && swap === 0) {
        await this.step(job, host, "swap",
          // Swap counts only once the kernel reports it active; fstab is updated after that, never before.
          '[ -f /swapfile ] || { $S fallocate -l 2G /swapfile && $S chmod 600 /swapfile && $S mkswap /swapfile >/dev/null; } || { echo CTTY_SWAP_FAILED; exit 5; }; $S swapon /swapfile 2>/dev/null; swapon --show=NAME --noheadings | grep -qx /swapfile || { echo CTTY_SWAP_FAILED; exit 5; }; grep -q "^/swapfile " /etc/fstab || echo "/swapfile none swap sw 0 0" | $S tee -a /etc/fstab >/dev/null',
          TIMEOUTS.swap);
        this.note(job, "added a 2 GB swap file");
      }

      await this.step(job, host, "packages",
        `export DEBIAN_FRONTEND=noninteractive; $S apt-get update -qq >/dev/null && $S apt-get install -y -qq ${BASE_PACKAGES.join(" ")} >/dev/null && echo node=$(node --version) podman=$(podman --version | cut -d" " -f3)`,
        TIMEOUTS.packages).then(out => this.note(job, `packages ready: ${out.trim().split(/\r?\n/u).at(-1) ?? ""}`));

      if (wanted.length) {
        const packages = wanted.map(provider => PROVISIONABLE_AGENTS[provider]!).join(" ");
        await this.step(job, host, "agents", `$S npm install -g --no-fund --no-audit --loglevel=error ${packages} >/dev/null && echo ok`, TIMEOUTS.agents);
      }

      job.phase = "verifying";
      const discovered = await this.discovery.discover(host, undefined, wanted);
      job.installed = discovered.providers.filter(item => item.installed).map(item => item.provider);
      const missing = wanted.filter(provider => !job.installed.includes(provider));
      this.note(job, `installed: ${job.installed.join(", ") || "none"}${missing.length ? `; missing after install: ${missing.join(", ")}` : ""}`);
      if (missing.length) throw new Error(`Installed CLI not found afterwards: ${missing.join(", ")}.`);
      job.phase = "done";
    } catch (error) {
      job.phase = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      this.note(job, job.error);
    } finally {
      job.finishedAt = Date.now();
      this.activeHosts.delete(host.id);
    }
  }
}
