import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import type { ProviderId, SessionIsolation } from "../../../shared/contracts.ts";
import { autoKind, PROFILE_RANK, type LaunchProfile } from "../../../shared/autoMode.ts";
import { LaunchRefusal } from "../launchRefusal.ts";
import { isolationPaths } from "./isolationPaths.ts";
import { seatbeltProfile } from "./seatbelt.ts";
import { bubblewrapArguments, projectHooks } from "./bubblewrap.ts";
import { LinuxHostPaths } from "./linuxHostPaths.ts";
import type { AgentNetworkLaunch, AgentNetworkMode, AgentNetworkSummary, NetworkPolicyManager } from "./networkPolicy.ts";
import { isPluginDataPath, worktreeGitAccess } from "./worktreeGitAccess.ts";
import { validateSelectedAccountHome } from "../accountHomeIsolation.ts";
import { prepareReviewerHome } from "./reviewerHome.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** The prefix of a launch's own folder (its profile and TMPDIR) in the temporary folder. */
export const ISOLATION_FOLDER_PREFIX = "ctty-iso-";
/** Tells the agent inside the layer what it may do (its value is ISOLATION_NOTE). */
export const ISOLATION_ENV = "CANVASTTY_ISOLATION";
/** Where the docs say how to let bubblewrap create its namespaces (Ubuntu 24.04 and later restrict them). */
export const BUBBLEWRAP_USERNS_DOCS = "docs/installing-and-security.md#linux-when-bubblewrap-cannot-start";
/** A failed bubblewrap check is repeated after this long, so allowing it takes effect without a restart. */
const BUBBLEWRAP_PROBE_RETRY_MS = 60_000;
export const ISOLATION_NOTE = "CanvasTTY agent isolation: files can be written only inside the project folder, $TMPDIR and this CLI's own folders; SSH/cloud keys, other agents' credentials and CanvasTTY's tokens cannot be read; other processes, apps and daemons are out of reach. \"Operation not permitted\" outside that is this rule: do the work inside the project, or tell the person what you need.";
export const WORKTREE_GIT_NOTE = "A plugin worktree's Git metadata stays read-only under agent isolation to protect the shared repository and sibling worktrees. You can edit project files; git add and git commit are unavailable here. The host environment collects your file edits into a review for the user to accept.";

/** Restricted reviewers keep HOME, TMPDIR and their profile together below CanvasTTY's private run directory. */
function reviewerRunRoot(userDataPath: string): string {
  const root = join(realpathSync(userDataPath), "launch-runs");
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || realpathSync(root) !== root) {
    throw new LaunchRefusal("The private launch-runs folder is not a safe directory. The reviewer was not started.");
  }
  chmodSync(root, 0o700);
  return root;
}

const REVIEWER_SYSTEM_READ_ROOTS = [
  "/bin", "/usr/bin", "/sbin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share",
  "/System/Library", "/System/Volumes/Preboot/Cryptexes/OS", "/dev", "/private/var/db/dyld"
];
const MAX_REVIEWER_RUNTIME_FILES = 256;
const MAX_REVIEWER_RUNTIME_DEPTH = 16;

/** Resolve only the selected runtime's exact Mach-O dependencies; never grant its containing directory. */
function reviewerRuntimeDependencies(roots: readonly string[], env: Readonly<Record<string, string | undefined>>): string[] {
  const runtimeFiles = new Set<string>();
  const queue: Array<{ path: string; executablePath: string; runpaths: string[]; depth: number; selectedCommand: boolean }> = roots
    .filter((path) => isAbsolute(path) && existsSync(path))
    .map((path, index) => ({ path, executablePath: realpathSync(path), runpaths: [], depth: 0, selectedCommand: index === 0 }));
  const seen = new Set<string>();
  const isSystemFile = (path: string): boolean => REVIEWER_SYSTEM_READ_ROOTS.some((root) => {
    const rest = relative(root, path);
    return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
  });
  const resolveRunpath = (value: string, loader: string, executable: string): string | null => {
    if (value.startsWith("@loader_path/")) return join(dirname(loader), value.slice("@loader_path/".length));
    if (value.startsWith("@executable_path/")) return join(dirname(executable), value.slice("@executable_path/".length));
    return isAbsolute(value) ? value : null;
  };
  const runtimePaths = (file: string, executable: string): string[] => {
    const result = spawnSync("/usr/bin/otool", ["-l", file], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) return [];
    const lines = (result.stdout ?? "").split(/\r?\n/u);
    const paths: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].trim() !== "cmd LC_RPATH") continue;
      for (let next = index + 1; next < Math.min(lines.length, index + 5); next++) {
        const match = /^\s*path\s+(.+?)\s+\(offset\s+\d+\)\s*$/u.exec(lines[next]);
        if (!match) continue;
        const path = resolveRunpath(match[1], file, executable);
        if (path) paths.push(path);
        break;
      }
    }
    return paths;
  };
  const shebangInterpreter = (file: string): string | null => {
    const descriptor = openSync(file, "r");
    let firstLine: string;
    try {
      const buffer = Buffer.alloc(4096);
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
      firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/u, 1)[0];
    } finally {
      closeSync(descriptor);
    }
    if (!firstLine.startsWith("#!")) return null;
    const words = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
    let interpreter = words.shift();
    if (!interpreter) throw new LaunchRefusal("The diff-only reviewer command has an invalid interpreter line.");
    if (interpreter === "/usr/bin/env") {
      if (words[0] === "-S") words.shift();
      if (words[0]?.startsWith("-")) throw new LaunchRefusal("The diff-only reviewer command uses an unsupported env interpreter option.");
      const name = words[0];
      if (!name) throw new LaunchRefusal("The diff-only reviewer command has no env interpreter.");
      const found = (env.PATH ?? "").split(delimiter).filter(Boolean).map((folder) => join(folder, name)).find((path) => existsSync(path));
      if (!found) throw new LaunchRefusal("The diff-only reviewer interpreter could not be resolved from PATH.");
      interpreter = found;
    }
    if (!isAbsolute(interpreter) || !existsSync(interpreter)) throw new LaunchRefusal("The diff-only reviewer interpreter could not be verified.");
    return realpathSync(interpreter);
  };

  while (queue.length > 0) {
    const current = queue.shift()!;
    const file = realpathSync(current.path);
    if (isSystemFile(file)) continue;
    if (seen.has(file)) continue;
    if (seen.size >= MAX_REVIEWER_RUNTIME_FILES || current.depth > MAX_REVIEWER_RUNTIME_DEPTH) {
      throw new LaunchRefusal("The diff-only reviewer runtime has too many linked libraries to verify safely.");
    }
    seen.add(file);
    const stat = statSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new LaunchRefusal("A diff-only reviewer runtime file is not a single-link regular file.");
    const linked = spawnSync("/usr/bin/otool", ["-L", file], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
    if (linked.error || linked.status !== 0) {
      if (!current.selectedCommand) continue; // AgentRuntimeBridge can also hand us exact text hooks and config files.
      const interpreter = shebangInterpreter(file);
      if (!interpreter) throw new LaunchRefusal("The diff-only reviewer command is not a verifiable macOS runtime.");
      queue.push({ path: interpreter, executablePath: interpreter, runpaths: current.runpaths, depth: current.depth + 1, selectedCommand: false });
      continue;
    }
    const localRunpaths = runtimePaths(file, current.executablePath);
    const availableRunpaths = [...new Set([...localRunpaths, ...current.runpaths])];
    const lines = (linked.stdout ?? "").split(/\r?\n/u).slice(1);
    for (const line of lines) {
      const entry = line.trim();
      if (!entry) continue;
      const installName = entry.replace(/\s+\(compatibility version\s+.*$/u, "").replace(/\s+\(current version\s+.*$/u, "");
      const candidates = installName.startsWith("@rpath/")
        ? availableRunpaths.map((path) => join(path, installName.slice("@rpath/".length)))
        : [resolveRunpath(installName, file, current.executablePath)].filter((path): path is string => Boolean(path));
      const dependency = candidates.find((candidate) => existsSync(candidate));
      if (!dependency) {
        if (installName.startsWith("@")) throw new LaunchRefusal("A diff-only reviewer runtime dependency could not be resolved safely.");
        continue; // A Mach-O may list a dylib for another architecture that is not installed here.
      }
      const resolved = realpathSync(dependency);
      if (isSystemFile(resolved)) continue;
      const dependencyStat = statSync(resolved);
      if (!dependencyStat.isFile() || dependencyStat.nlink !== 1) throw new LaunchRefusal("A diff-only reviewer runtime dependency is not a single-link regular file.");
      runtimeFiles.add(dependency);
      runtimeFiles.add(resolved);
      queue.push({ path: resolved, executablePath: current.executablePath, runpaths: availableRunpaths, depth: current.depth + 1, selectedCommand: false });
    }
  }
  return [...runtimeFiles];
}

export interface AgentIsolationOptions {
  /** CanvasTTY's userData folder (its private data is never readable inside the layer). */
  userDataPath: string;
  /** The person's setting (Settings → Agents → Agent isolation). */
  enabled: () => boolean;
  /** Environment before plugin contributions; copied when the layer is constructed. */
  hostEnvironment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** Where each launch's own folder is made; the system temporary folder by default. */
  tempRoot?: string;
  sandboxExecPath?: string;
  /** bubblewrap's path on Linux; found on PATH when omitted, null when it is not installed. */
  bubblewrapPath?: string | null;
  exists?: (path: string) => boolean;
  /** Linux: the host folders and placeholders bubblewrap needs (shared across launches); tests pass their own. */
  linuxHostPaths?: LinuxHostPaths;
  /** Optional per-project network policy store and host-side allowlist proxy. */
  networkPolicy?: NetworkPolicyManager;
  /** Packaged native canvastty-helper; both strict Linux network modes require its Unix socket guard. */
  networkHelperPath?: string | null;
  /** Linux: checks the native helper's Landlock boundary without starting an agent. */
  networkIsolationProbe?: (helper: string) => string | null;
  /**
   * Linux: runs bubblewrap once with the namespaces a launch uses and returns null when it works, or what it said.
   * bubblewrap can be installed and still unable to create an unprivileged user namespace (Ubuntu 24.04's AppArmor
   * `kernel.apparmor_restrict_unprivileged_userns=1`). Tests pass their own.
   */
  bubblewrapProbe?: (bwrap: string) => string | null;
  now?: () => number;
}

export interface IsolationDecisionInput {
  provider: ProviderId;
  /** Project root used to resolve its network policy; omitted by older callers to use the global policy. */
  cwd?: string;
  profile: LaunchProfile;
  /** Not launched by the person: a subagent, or an agent a plugin started. */
  delegated: boolean;
  /** A plugin environment runs this card; `isolated` when it does not run on this computer's files (container, remote). */
  environment?: { isolated: boolean; label: string } | null;
}

export interface IsolationDecision {
  /** Wrap the launch in the layer. */
  apply: boolean;
  /** What the card shows; absent when the layer does not concern this launch (a plain terminal, a manual agent). */
  isolation?: SessionIsolation;
  /** The profile to launch in: lowered to normal when a subagent's layer is missing. */
  profile: LaunchProfile;
  /** The launch must not start, and why. */
  refuse?: string;
}

export interface IsolationLaunch {
  sessionId: string;
  provider: ProviderId;
  cwd: string;
  /** Original project root used for policy lookup when cwd is a plugin-provided worktree or container path. */
  networkProjectRoot?: string;
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  /** Folders under CanvasTTY's private data this launch was handed (its control grant, its account home). */
  grantedPrivate?: readonly string[];
  /** Host-derived candidate from the selected Accounts contribution; validated against userData at wrap time. */
  accountHome?: string;
  /** Host-derived project/session roots hidden from the diff-only reviewer. */
  deniedReadPaths?: readonly string[];
  /** Model API hosts of the selected model account; allowed with the provider APIs in allowed-domains mode. */
  apiDomains?: readonly string[];
  restrictHomeReads?: boolean;
  runtimeReadable?: readonly string[];
  /** The launch profile: in plan the project is not writable. */
  profile?: LaunchProfile;
}

export interface WrappedLaunch {
  /** Immutable evidence for this generated wrapper; no credentials, domains or paths. */
  executionProtection?: import("../../../shared/executionProtection.ts").ExecutionProtection;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Host-owned summary for a safe platform-specific restriction (shown on the session card). */
  isolationReason?: string;
  /** Removes the launch's own folder (profile and temporary files); call when its process exited or was replaced. */
  cleanup(): void;
}

/**
 * CanvasTTY's operating-system isolation layer around an agent's whole process tree (the CLI, its tools, MCP servers
 * and hooks): macOS seatbelt through sandbox-exec, Linux bubblewrap. It applies to agents the person did not launch
 * directly (subagents, plugin-started agents) and to every launch in a profile other than normal (manual), unless
 * the person turned it off. It fails closed: when it cannot be set up, the launch is refused, never run without it.
 */
export class AgentIsolation {
  private readonly options: AgentIsolationOptions;
  private readonly platform: NodeJS.Platform;
  private readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  private bubblewrap: string | null | undefined;
  private readonly linuxHostPaths: LinuxHostPaths;
  /** The last bubblewrap check: a working one is kept, a failed one is repeated after BUBBLEWRAP_PROBE_RETRY_MS. */
  private readonly isolationChecks = new Map<string, { failure: string | null; at: number }>();

  constructor(options: AgentIsolationOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.hostEnvironment = { ...(options.hostEnvironment ?? process.env) };
    this.bubblewrap = options.bubblewrapPath;
    this.linuxHostPaths = options.linuxHostPaths ?? new LinuxHostPaths();
  }

  /** The layer this computer has, or why it has none. */
  availability(): { layer: "seatbelt" | "bubblewrap" } | { reason: string } {
    const exists = this.options.exists ?? existsSync;
    if (this.platform === "darwin") {
      return exists(this.options.sandboxExecPath ?? SANDBOX_EXEC)
        ? { layer: "seatbelt" }
        : { reason: "macOS sandbox-exec is missing on this computer." };
    }
    if (this.platform === "linux") {
      if (this.bubblewrap === undefined) this.bubblewrap = findOnPath("bwrap", exists);
      if (!this.bubblewrap) return { reason: "bubblewrap (bwrap) is not installed; install it to isolate agents on Linux." };
      const failure = this.cachedProbe(`bwrap:${this.bubblewrap}`, () => (this.options.bubblewrapProbe ?? probeBubblewrap)(this.bubblewrap!));
      return failure === null
        ? { layer: "bubblewrap" }
        : { reason: `bubblewrap (bwrap) is installed but cannot create its sandbox here (${failure}); Ubuntu 24.04 and later block unprivileged user namespaces through AppArmor. ${BUBBLEWRAP_USERNS_DOCS} says how to allow it.` };
    }
    if (this.platform === "win32") return { reason: "CanvasTTY has no agent isolation layer on Windows yet." };
    return { reason: `CanvasTTY has no agent isolation layer on ${this.platform}.` };
  }

  /** The layer is on and can contain an agent here. */
  containment(): boolean {
    return this.enabled() && "layer" in this.availability();
  }

  decide(input: IsolationDecisionInput): IsolationDecision {
    const { provider, delegated } = input;
    let profile = input.profile;
    if (provider === "terminal") return { apply: false, profile };
    let networkMode: AgentNetworkMode = "open";
    try { networkMode = this.options.networkPolicy?.getPolicy(input.cwd).mode ?? "open"; }
    catch (error) {
      return { apply: false, profile, refuse: `The saved agent network policy cannot be read: ${error instanceof Error ? error.message : String(error)} The agent was not started.` };
    }
    const strictNetwork = networkMode !== "open";
    const wanted = delegated || profile !== "normal" || strictNetwork;
    if (!wanted) return { apply: false, profile };
    const containedAuto = profile === "auto" && autoKind(provider) === "contained";
    if (input.environment?.isolated) {
      if (strictNetwork) return { apply: false, profile, refuse: `${networkMode} network mode cannot be enforced inside ${input.environment.label}. The agent was not started.` };
      return { apply: false, profile, isolation: { state: "environment", reason: `Runs in ${input.environment.label}; the isolation layer of this computer does not apply there.` } };
    }
    if (strictNetwork) {
      if (!this.enabled()) return { apply: false, profile, refuse: `${networkMode} network mode requires agent isolation to be on. The agent was not started.` };
      const available = this.availability();
      if ("reason" in available) return { apply: false, profile, refuse: `${networkMode} network mode cannot be enforced: ${available.reason} The agent was not started.` };
      const socketFailure = this.platform === "linux" ? this.networkIsolationFailure() : null;
      if (socketFailure) return { apply: false, profile, refuse: `${networkMode} network mode cannot be enforced: ${socketFailure} The agent was not started.` };
      if (networkMode === "allowed-domains") {
        const proxy = this.options.networkPolicy?.availability();
        if (!proxy?.available) return { apply: false, profile, refuse: `allowed-domains network mode cannot be enforced: ${proxy && "reason" in proxy ? proxy.reason : "the proxy manager is not configured"} The agent was not started.` };
      }
    }
    const lower = (state: SessionIsolation["state"], why: string): IsolationDecision => {
      if (containedAuto && !delegated) {
        return { apply: false, profile, refuse: `${provider} has no auto mode of its own; its auto runs only inside CanvasTTY's agent isolation, and ${why}` };
      }
      // Without a layer the person did not turn off, a subagent or plugin-started agent never runs more freely than
      // normal (asking). The person turning it off is their opt-in (on Windows the only way to auto subagents), except
      // for a contained auto, which is a bypass and exists only inside the layer.
      if (delegated && (containedAuto || (state === "unavailable" && PROFILE_RANK[profile] > PROFILE_RANK.normal))) {
        const from = profile;
        profile = "normal";
        return { apply: false, profile, isolation: { state, reason: `${why} It runs in normal (it asks) instead of ${from}.` } };
      }
      return { apply: false, profile, isolation: { state, reason: why } };
    };
    if (!this.enabled()) return lower("off", "agent isolation is off in Settings → Agents.");
    const available = this.availability();
    if ("reason" in available) return lower("unavailable", available.reason);
    return { apply: true, profile, isolation: { state: "on", layer: available.layer } };
  }

  networkPolicyFor(projectRoot: string | undefined, provider: ProviderId): AgentNetworkSummary | null {
    return this.options.networkPolicy?.getEffectivePolicy(projectRoot, provider) ?? null;
  }

  /** Wraps one launch; throws a LaunchRefusal (fail closed) when the layer cannot be set up. */
  wrap(launch: IsolationLaunch): WrappedLaunch {
    const available = this.availability();
    if ("reason" in available) throw new LaunchRefusal(`agent isolation is not available: ${available.reason} The agent was not started without it.`);
    let folder: string | null = null;
    let releaseHostPaths: (() => void) | null = null;
    let networkLaunch: AgentNetworkLaunch | null = null;
    const cleanup = (): void => {
      releaseHostPaths?.();
      releaseHostPaths = null;
      networkLaunch?.cleanup();
      networkLaunch = null;
      if (folder) rmSync(folder, { recursive: true, force: true });
      folder = null;
    };
    try {
      const root = launch.restrictHomeReads
        ? reviewerRunRoot(this.options.userDataPath)
        : realpathSync(this.options.tempRoot ?? tmpdir());
      folder = mkdtempSync(join(root, ISOLATION_FOLDER_PREFIX));
      chmodSync(folder, 0o700);
      const temp = join(folder, "tmp");
      mkdirSync(temp, { mode: 0o700 });
      const requestedCwdInPluginData = isPluginDataPath(launch.cwd, this.options.userDataPath);
      const cwd = realpathSync(launch.cwd);
      // Avoid resolving an executable through a chain of HOME symlinks from inside the reviewer sandbox. The host
      // resolves only the selected executable; its file grant already covers this canonical spelling.
      const launchCommand = launch.restrictHomeReads ? realpathSync(launch.command) : launch.command;
      if (launch.restrictHomeReads && (launch.profile !== "plan" || !launch.deniedReadPaths?.length))
        throw new LaunchRefusal("Restricted reviewer reads require a Plan profile and verified project roots.");
      const deniedReadPaths = launch.deniedReadPaths?.map((path) => {
        if (!isAbsolute(path)) throw new LaunchRefusal("A reviewer isolation root is not absolute.");
        const denied = realpathSync(path);
        const within = (path: string, folder: string): boolean => {
          const rest = relative(folder, path);
          return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
        };
        if (!statSync(denied).isDirectory() || denied === dirname(denied)
          || within(cwd, denied) || within(denied, cwd)) {
          throw new LaunchRefusal("A reviewer isolation root is missing or overlaps its temporary workspace.");
        }
        return denied;
      });
      if (launch.deniedReadPaths && deniedReadPaths?.length !== launch.deniedReadPaths.length) {
        throw new LaunchRefusal("A reviewer isolation root could not be verified.");
      }
      const trustedWorktree = worktreeGitAccess(cwd, launch.networkProjectRoot ?? cwd, this.options.userDataPath);
      if ((requestedCwdInPluginData || isPluginDataPath(cwd, this.options.userDataPath)) && !trustedWorktree) {
        throw new LaunchRefusal("The plugin environment worktree could not be verified against the task's original Git repository. The agent was not started.");
      }
      const launchEnvironment = { ...launch.env };
      const accountHome = launch.accountHome === undefined
        ? undefined
        : validateSelectedAccountHome(this.options.userDataPath, launch.provider, launch.accountHome);
      // A reviewer on the worker's model account: a copy of the account's run file in the reviewer's own temp folder
      // (CanvasTTY's launch-runs stays unreadable to it).
      const accountRunSource = launch.restrictHomeReads && launch.provider === "opencode" && launch.apiDomains?.length
        ? accountLaunchRunFile(launchEnvironment.OPENCODE_CONFIG, this.options.userDataPath) : undefined;
      let accountRunConfig: string | undefined;
      if (accountRunSource) {
        accountRunConfig = join(temp, "account-opencode.json");
        copyFileSync(accountRunSource, accountRunConfig, fsConstants.COPYFILE_EXCL);
        chmodSync(accountRunConfig, 0o600);
      }
      if (launch.restrictHomeReads) prepareReviewerHome(launchEnvironment, launch.provider, temp, launch.runtimeReadable ?? [], accountRunConfig);
      const reviewerRuntimeFiles = launch.restrictHomeReads && this.platform === "darwin"
        ? reviewerRuntimeDependencies([launchCommand, ...(launch.runtimeReadable ?? [])], launchEnvironment)
        : [];
      networkLaunch = this.options.networkPolicy?.prepareLaunch(launch.networkProjectRoot ?? cwd, launch.provider, launch.apiDomains) ?? null;
      const networkMode = networkLaunch?.mode ?? "open";
      const executionProtection = Object.freeze({ state: "applied", location: "local", layer: available.layer,
        filesystem: launch.profile === "plan" ? "read-only-project" : "project-and-runtime", network: networkMode } as const);
      if (networkMode !== "open" && this.platform === "linux") {
        const failure = this.networkIsolationFailure();
        if (failure) throw new LaunchRefusal(`${networkMode} network mode cannot be enforced: ${failure} The agent was not started.`);
      }
      if (networkMode !== "open") stripBrowserEnvironment(launchEnvironment);
      const paths = isolationPaths({
        provider: launch.provider,
        cwd,
        sessionTemp: temp,
        env: launchEnvironment,
        hostEnvironment: this.hostEnvironment,
        userDataPath: this.options.userDataPath,
        sessionId: launch.sessionId,
        ...(launch.restrictHomeReads ? { privateRunDirectory: folder } : {}),
        networkMode,
        ...(deniedReadPaths ? { deniedReadPaths } : {}),
        ...(launch.restrictHomeReads ? { restrictHomeReads: true, runtimeReadable: [...reviewerRuntimeFiles, launchCommand,
          ...(networkMode !== "open" && this.platform === "linux" ? [this.options.networkHelperPath!] : []), ...(launch.runtimeReadable ?? [])] } : {}),
        ...(trustedWorktree ? { worktreeGitAccess: trustedWorktree } : {}),
        ...((launch.grantedPrivate || accountHome) ? {
          grantedPrivate: [...(launch.grantedPrivate ?? []), ...(accountHome && !launch.restrictHomeReads ? [accountHome] : [])]
        } : {}),
        ...(launch.profile === "plan" ? { readOnlyProject: true } : {})
      });
      // `git init` and `git clone` copy git's template, sample hooks included: an empty one writes no hooks.
      const gitTemplate = join(folder, "git-template");
      mkdirSync(gitTemplate, { mode: 0o500 });
      // An agent that meets "Operation not permitted" can read why here, instead of trying other ways around it.
      const worktreeGitMetadataReadOnly = Boolean(trustedWorktree);
      const isolationNote = worktreeGitMetadataReadOnly ? `${ISOLATION_NOTE} ${WORKTREE_GIT_NOTE}` : ISOLATION_NOTE;
      const env: Record<string, string> = { ...launchEnvironment, TMPDIR: `${temp}/`, TMP: temp, TEMP: temp, GIT_TEMPLATE_DIR: gitTemplate, [ISOLATION_ENV]: isolationNote };
      if (worktreeGitMetadataReadOnly) env.GIT_OPTIONAL_LOCKS = "0";
      if (networkMode !== "open") {
        stripProxyEnvironment(env);
        env.CANVASTTY_NETWORK_MODE = networkMode;
      }
      if (networkLaunch?.mode === "allowed-domains" && this.platform === "darwin") {
        if (!networkLaunch.token || !networkLaunch.macProxyPort) throw new LaunchRefusal("The macOS allowlist proxy was not ready. The agent was not started.");
        const proxy = `http://canvastty:${networkLaunch.token}@127.0.0.1:${networkLaunch.macProxyPort}`;
        setProxyEnvironment(env, proxy);
      }
      if (available.layer === "seatbelt") {
        const profilePath = join(folder, "profile.sb");
        const network = networkLaunch && networkLaunch.mode !== "open" ? {
          mode: networkLaunch.mode,
          ...(networkLaunch.mode === "allowed-domains" && networkLaunch.macProxyPort ? { proxyPort: networkLaunch.macProxyPort } : {}),
          loopbackPorts: claudeHookPorts(launch.provider, launch.args)
        } as const : undefined;
        writeFileSync(profilePath, seatbeltProfile(paths, network), { mode: 0o600, flag: "wx" });
        return { executionProtection, command: this.options.sandboxExecPath ?? SANDBOX_EXEC, args: ["-f", profilePath, launchCommand, ...launch.args], env,
          ...(worktreeGitMetadataReadOnly ? { isolationReason: WORKTREE_GIT_NOTE } : {}), cleanup };
      }
      // bubblewrap mounts only what exists: the CLI's own missing folders are created and a missing protected file
      // gets a placeholder first (LinuxHostPaths), both undone by cleanup().
      releaseHostPaths = this.linuxHostPaths.prepare(paths);
      const kind = (path: string): "file" | "directory" | "socket" | null => {
        try { const stat = statSync(path); return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSocket() ? "socket" : null; } catch { return null; }
      };
      let command = launchCommand;
      let commandArgs = [...launch.args];
      if (networkLaunch && networkLaunch.mode !== "open") {
        if (networkLaunch.mode === "allowed-domains" && (!networkLaunch.unixProxyPath || !networkLaunch.token)) {
          throw new LaunchRefusal("allowed-domains network mode could not prepare its Linux socket bridge. The agent was not started.");
        }
        command = this.options.networkHelperPath!;
        // These exact addresses come from core grants; no plugin-supplied CANVASTTY_* name grants a socket.
        const gatewaySockets = [env.CANVASTTY_RUNTIME_ADDRESS, env.CANVASTTY_ORCHESTRATION_ADDRESS].filter((path): path is string => Boolean(path));
        commandArgs = ["network-bridge", ...(networkLaunch.mode === "offline" ? ["--offline"] : ["--socket", networkLaunch.unixProxyPath!, "--token", networkLaunch.token!]),
          ...[...new Set(gatewaySockets)].flatMap((path) => ["--allow-socket", path]), "--", launchCommand, ...launch.args];
      }
      const args = bubblewrapArguments(paths, {
        command, args: commandArgs, cwd,
        ...(launch.env.XDG_RUNTIME_DIR ? { runtimeDir: launch.env.XDG_RUNTIME_DIR } : {}),
        ...(networkLaunch && networkLaunch.mode !== "open" ? {
          network: { mode: networkLaunch.mode, ...(networkLaunch.unixProxyPath ? { proxySocketPath: networkLaunch.unixProxyPath } : {}) }
        } : {})
      }, kind);
      const hooks = projectHooks(cwd);
      const mountPoint = kind(dirname(hooks)) === null && args.includes(hooks);
      return {
        executionProtection,
        command: this.bubblewrap!,
        args,
        env,
        ...(worktreeGitMetadataReadOnly ? { isolationReason: WORKTREE_GIT_NOTE } : {}),
        cleanup: () => {
          cleanup();
          // bwrap created an empty `.git/hooks` as the throwaway hooks mount point in a folder that had no repository:
          // unless the agent made one there, nothing is left behind.
          if (mountPoint) removeMountPoint(hooks);
        }
      };
    } catch (error) {
      cleanup();
      if (error instanceof LaunchRefusal) throw error;
      throw new LaunchRefusal(`agent isolation could not be set up: ${error instanceof Error ? error.message : String(error)} The agent was not started without it.`);
    }
  }

  /** Null when bubblewrap can start here; cached, so a launch costs one check at most once a minute. */
  private cachedProbe(key: string, probe: () => string | null): string | null {
    const now = (this.options.now ?? Date.now)();
    const last = this.isolationChecks.get(key);
    if (last && (last.failure === null || now - last.at < BUBBLEWRAP_PROBE_RETRY_MS)) return last.failure;
    let failure: string | null;
    try { failure = probe(); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    this.isolationChecks.set(key, { failure, at: now });
    return failure;
  }

  private networkIsolationFailure(): string | null {
    const helper = this.options.networkHelperPath;
    if (!helper) return "CanvasTTY's native Unix socket guard is missing on Linux.";
    return this.cachedProbe(`network:${helper}`, () => (this.options.networkIsolationProbe ?? probeNetworkIsolation)(helper));
  }

  private enabled(): boolean {
    try { return this.options.enabled() !== false; } catch { return true; }
  }
}

function stripProxyEnvironment(env: Record<string, string>): void {
  for (const key of Object.keys(env)) if (/^(?:https?|all|no)_proxy$/iu.test(key)) delete env[key];
}

function stripBrowserEnvironment(env: Record<string, string>): void {
  for (const key of [
    "CANVASTTY_AGENT_BROWSER_ADDRESS", "CANVASTTY_AGENT_CAPABILITY", "CANVASTTY_AGENT_CONNECTION_ID",
    "CANVASTTY_AGENT_ID", "CANVASTTY_AGENT_PROVIDER"
  ]) delete env[key];
}

function setProxyEnvironment(env: Record<string, string>, proxy: string): void {
  env.HTTP_PROXY = proxy;
  env.http_proxy = proxy;
  env.HTTPS_PROXY = proxy;
  env.https_proxy = proxy;
  env.ALL_PROXY = proxy;
  env.all_proxy = proxy;
  // The seatbelt profile grants only an exact capability-bearing hook port on loopback; the network proxy itself
  // rejects private addresses. This lets a generated Claude lifecycle hook reach that one local listener.
  env.NO_PROXY = "127.0.0.1,localhost,::1";
  env.no_proxy = env.NO_PROXY;
}

/** The only direct loopback HTTP request retained in strict mode: a capability-bearing Claude lifecycle hook. */
function claudeHookPorts(provider: ProviderId, args: readonly string[]): number[] {
  if (provider !== "claude") return [];
  const found = new Set<number>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "http" && typeof record.url === "string" && record.url.startsWith("http://127.0.0.1:")) {
      const headers = record.headers && typeof record.headers === "object" ? record.headers as Record<string, unknown> : {};
      const hasCapability = Object.values(headers).some((header) => typeof header === "string" && header.includes("CANVASTTY_RUNTIME_CAPABILITY"));
      const url = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/claude\/v1\//u.exec(record.url);
      const port = url ? Number(url[1]) : 0;
      if (hasCapability && Number.isInteger(port) && port > 0 && port <= 65_535) found.add(port);
    }
    for (const item of Object.values(record)) visit(item);
  };
  for (const arg of args) {
    if (!arg.trimStart().startsWith("{")) continue;
    try { visit(JSON.parse(arg) as unknown); } catch { /* non-JSON provider argument */ }
  }
  return [...found];
}

/** Removes `<project>/.git` when all it holds is the empty `hooks` and `info` mount points. */
function removeMountPoint(hooks: string): void {
  const gitDir = dirname(hooks);
  try {
    const names = readdirSync(gitDir);
    if (!names.every((name) => name === "hooks" || name === "info")) return;
    for (const name of names) rmdirSync(join(gitDir, name));
    rmdirSync(gitDir);
  } catch { /* not empty, or already gone */ }
}

/** Starts `true` under bubblewrap with the namespaces a launch gets: null when it runs, else bubblewrap's first line. */
export function probeBubblewrap(bwrap: string): string | null {
  return probeIsolationCommand(bwrap, ["--die-with-parent", "--unshare-pid", "--unshare-ipc", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"]);
}

/** Tests the same kernel boundary every strict launch applies; old or disabled Landlock refuses before launch. */
export function probeNetworkIsolation(helper: string): string | null {
  return probeIsolationCommand(helper, ["network-bridge", "--probe"]);
}

function probeIsolationCommand(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    timeout: 5_000
  });
  if (result.status === 0) return null;
  const said = (result.stderr ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  const detail = said ?? result.error?.message ?? (result.signal ? `stopped by ${result.signal}` : `exit code ${String(result.status)}`);
  return detail.length > 200 ? `${detail.slice(0, 199)}…` : detail;
}

function findOnPath(name: string, exists: (path: string) => boolean): string | null {
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, name);
    if (exists(candidate)) return candidate;
  }
  for (const folder of ["/usr/bin", "/usr/local/bin", "/bin"]) {
    const candidate = join(folder, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The folder of a session's control grant, from the launch environment (it is readable inside the layer). */
export function controlGrantFolder(env: Readonly<Record<string, string | undefined>>): string | null {
  const connection = env.CANVASTTY_CONTROL_CONNECTION;
  return connection ? dirname(connection) : null;
}

/** A model account's OpenCode run file: a single-link regular file inside CanvasTTY's own launch-runs folder. */
function accountLaunchRunFile(path: string | undefined, userDataPath: string): string | undefined {
  if (!path || !isAbsolute(path)) return undefined;
  try {
    const root = realpathSync(join(userDataPath, "launch-runs"));
    const file = realpathSync(path);
    const rest = relative(root, file);
    const stat = statSync(file);
    return rest && !rest.startsWith("..") && !isAbsolute(rest) && stat.isFile() && stat.nlink === 1 ? file : undefined;
  } catch { return undefined; }
}
