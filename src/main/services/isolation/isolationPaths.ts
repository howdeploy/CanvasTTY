import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProviderId } from "../../../shared/contracts.ts";
import { AGENT_PROVIDERS } from "../../../shared/contracts.ts";
import { otherSpellings } from "../onDiskPath.ts";
import { openCodeConfigPaths } from "../inspectedConfig.ts";
import type { WorktreeGitAccess } from "./worktreeGitAccess.ts";

/**
 * The folders one isolated agent may write, the ones it may not read, and the sockets it may connect to. Pure: the
 * caller passes the home folder, the launch environment and CanvasTTY's own data folder, so a test (and a fake HOME)
 * decides every path.
 */
export interface IsolationPathInput {
  provider: ProviderId;
  /** The folder the agent works in (the project). */
  cwd: string;
  /** This launch's own temporary folder (TMPDIR inside the layer). */
  sessionTemp: string;
  /** The agent's launch environment (HOME, XDG_*, CODEX_HOME, CLAUDE_CONFIG_DIR, GROK_HOME, CanvasTTY's socket addresses). */
  env: Readonly<Record<string, string | undefined>>;
  /** Host environment captured before launch contributors; credentials there stay hidden if HOME moves. */
  hostEnvironment?: Readonly<Record<string, string | undefined>>;
  /** CanvasTTY's userData folder. */
  userDataPath: string;
  /** The session id, for its own plugin launch files and its own control grant. */
  sessionId: string;
  /** Folders under CanvasTTY's private data this launch was handed (its own control grant, its account home). */
  grantedPrivate?: readonly string[];
  /** Extra socket folders this launch may connect to (the control grant's endpoint folder). */
  socketFolders?: readonly string[];
  /** Plan: the project is readable only (the CLI's own folders stay writable). */
  readOnlyProject?: boolean;
  /** Additional host-selected trees that a diff-only reviewer must not read. */
  deniedReadPaths?: readonly string[];
  /** Host-only diff reviewer: hide the rest of HOME while keeping its CLI state and explicit runtime files. */
  restrictHomeReads?: boolean;
  /** Exact host-created reviewer run folder; replaces the ordinary session launch-runs grant. */
  privateRunDirectory?: string;
  runtimeReadable?: readonly string[];
  /** Host-derived from cwd + task root after validating a linked worktree; never supplied by a plugin. */
  worktreeGitAccess?: WorktreeGitAccess | null;
}

export interface IsolationPaths {
  /** A diff reviewer reads only supplied files, fresh state, trusted runtime and OS libraries. */
  restrictReads?:boolean;
  /** Writable folders (subpaths), every spelling. */
  writable: string[];
  /** Writable single files (with their `.lock` / `.tmp` / backup siblings). */
  writableFiles: string[];
  /** Folders that may be created (empty) on the way to a writable one: `~/.local/state` for `~/.local/state/opencode`. */
  creatableFolders: string[];
  /** Inside writable folders, still not writable: the repository's git config, the CLIs' own permission settings. */
  protectedWrites: string[];
  /** Permission-bearing agent directories; empty directories are neutral, unlike a fabricated build.md. */
  protectedDirectories?: string[];
  /** The project's git hook folders: only `*.sample` files may be written there (what `git init` creates). */
  gitHooks: string[];
  /**
   * The writable project folder (every spelling; none for a read-only project). No repository anywhere under it gets
   * hooks or `info/attributes` from the agent: they would run, or pick filters, outside the layer.
   */
  projectRoots: string[];
  /** Not readable at all: other agents' credentials, SSH/cloud keys, CanvasTTY's tokens and secret stores. */
  unreadable: string[];
  /** Readable again inside an unreadable folder: what this launch was handed. */
  readableAgain: string[];
  /** Folders whose Unix sockets the agent may connect to. */
  socketFolders: string[];
  /** Folders whose name starts with this prefix hold CanvasTTY's gateway sockets (token-authenticated). */
  socketPrefixes: string[];
}

/** Each provider's own state, configuration and cache folders, relative to HOME unless an env variable moves them. */
function providerFolders(provider: ProviderId, env: IsolationPathInput["env"], home: string): { folders: string[]; files: string[] } {
  const xdg = xdgFolders(env, home);
  const named = (name: string): string[] => [
    join(home, `.${name}`),
    join(xdg.config, name), join(xdg.data, name), join(xdg.state, name), join(xdg.cache, name),
    join(home, "Library", "Caches", name), join(home, "Library", "Application Support", name)
  ];
  switch (provider) {
    case "codex":
      return { folders: [env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(home, ".codex"), ...named("codex")], files: [] };
    case "claude": {
      const config = env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : join(home, ".claude");
      return {
        folders: [config, ...named("claude"), join(home, "Library", "Caches", "claude-cli-nodejs")],
        // Claude Code keeps its state next to HOME (and next to its config folder when CLAUDE_CONFIG_DIR moves it). On
        // macOS it keeps its sign-in in the login keychain, which the Security framework rewrites from inside the
        // process (a temporary `.sb-…` sibling renamed over it): refreshing the sign-in needs that one file writable.
        files: [join(home, ".claude.json"), join(config, ".claude.json"), join(home, "Library", "Keychains", "login.keychain-db")]
      };
    }
    case "grok":
      return { folders: [env.GROK_HOME && isAbsolute(env.GROK_HOME) ? env.GROK_HOME : join(home, ".grok"), ...named("grok")], files: [] };
    case "opencode":
      return { folders: named("opencode"), files: [] };
    case "hermes":
      return { folders: [env.HERMES_HOME && isAbsolute(env.HERMES_HOME) ? env.HERMES_HOME : join(home, ".hermes"), ...named("hermes")], files: [] };
    case "kimi":
      return { folders: [env.KIMI_HOME && isAbsolute(env.KIMI_HOME) ? env.KIMI_HOME : join(home, ".kimi"), ...named("kimi")], files: [] };
    case "cursor":
      return { folders: [...named("cursor"), ...named("cursor-agent")], files: [] };
    case "antigravity":
      return { folders: [...named("antigravity"), join(home, ".gemini")], files: [] };
    case "terminal":
      return { folders: [], files: [] };
    default:
      return { folders: named(provider), files: [] };
  }
}

/** The variables that move a CLI's home away from where providerFolders looks. */
const HOME_VARIABLES: Partial<Record<ProviderId, readonly string[]>> = {
  codex: ["CODEX_HOME"],
  claude: ["CLAUDE_CONFIG_DIR"],
  grok: ["GROK_HOME"],
  hermes: ["HERMES_HOME"],
  kimi: ["KIMI_HOME"],
  opencode: ["OPENCODE_CONFIG_DIR"],
  qwen: ["QWEN_HOME"]
};
/** A CLI's configuration file named by a variable (it may hold keys): unreadable to other CLIs, never writable to its own. */
const CONFIG_FILE_VARIABLES: Partial<Record<ProviderId, readonly string[]>> = { opencode: ["OPENCODE_CONFIG"] };

function movedProviderHomes(provider: ProviderId, env: IsolationPathInput["env"], variables = HOME_VARIABLES): string[] {
  return (variables[provider] ?? [])
    .map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && isAbsolute(value));
}

function xdgFolders(env: IsolationPathInput["env"], home: string): { config: string; data: string; state: string; cache: string } {
  const pick = (value: string | undefined, fallback: string): string => value && isAbsolute(value) ? value : fallback;
  return {
    config: pick(env.XDG_CONFIG_HOME, join(home, ".config")),
    data: pick(env.XDG_DATA_HOME, join(home, ".local", "share")),
    state: pick(env.XDG_STATE_HOME, join(home, ".local", "state")),
    cache: pick(env.XDG_CACHE_HOME, join(home, ".cache"))
  };
}

/** Credentials and keys no agent reads inside the layer (other than its own CLI's folders, handled separately). */
function sensitiveHomeFolders(home: string, xdgConfig: string): string[] {
  return [
    ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".netrc", ".git-credentials", ".password-store",
    ".config/gh", ".config/gcloud", ".config/op", ".npmrc", ".pypirc", ".gem/credentials", ".cargo/credentials",
    ".cargo/credentials.toml", ".terraform.d/credentials.tfrc.json", ".vault-token"
  ].map((name) => join(home, name)).concat([join(xdgConfig, "gh"), join(xdgConfig, "gcloud")]);
}

/**
 * CanvasTTY's own private data under userData (the same list base protection refuses): tokens, connection records,
 * secret stores, account homes and prepared launch files. Its gateways' runtime folders stay readable: they hold
 * token-authenticated sockets and per-run hook settings the CLI must read.
 */
export function privateAppData(userDataPath: string): string[] {
  return ["agent-control", "provider-secrets.bin", "plugin-secrets", "account-homes", "github-oauth.json", "launch-runs", "plugin-data", "checkpoints.json", "checkpoint-objects", "task-budgets.json", "usage-prices.json", "flow-approvals.json", "session-timeline"]
    .map((name) => join(userDataPath, name));
}

/** Every spelling of a path an agent or the kernel may use: as given, resolved through links, NFC and NFD. */
export function spellings(path: string): string[] {
  const found = new Set<string>();
  const add = (value: string): void => {
    if (!value || !isAbsolute(value)) return;
    found.add(value);
    for (const other of otherSpellings(value)) found.add(other);
  };
  add(resolve(path));
  add(realish(resolve(path)));
  return [...found];
}

/** realpath of the longest existing ancestor plus the rest, so /tmp and /var resolve to /private on macOS. */
function realish(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest.length > 0 ? join(real, ...rest.reverse()) : real;
    } catch { /* go up */ }
    const parent = dirname(current);
    if (parent === current) return path;
    rest.push(current.slice(parent.length).replace(/^[\\/]+/u, ""));
    current = parent;
  }
}

export function isolationPaths(input: IsolationPathInput): IsolationPaths {
  const home = input.env.HOME && isAbsolute(input.env.HOME) ? input.env.HOME : "/nonexistent-home";
  const xdg = xdgFolders(input.env, home);
  const hostEnv = input.hostEnvironment ?? input.env;
  const hostHome = hostEnv.HOME && isAbsolute(hostEnv.HOME) ? hostEnv.HOME : home;
  const hostXdg = xdgFolders(hostEnv, hostHome);
  // One launch may name the same source in several phases. Canonicalize it once, without a stale cross-run cache.
  const spellingCache = new Map<string, string[]>();
  const pathSpellings = (path: string): string[] => {
    let found = spellingCache.get(path);
    if (!found) { found = spellings(path); spellingCache.set(path, found); }
    return found;
  };
  const all = (paths: readonly string[]): string[] => [...new Set(paths.flatMap(pathSpellings))];
  const own = providerFolders(input.provider, input.env, home);
  // A launch that moved its CLI home into CanvasTTY's account homes (an accounts plugin) or elsewhere: that folder is
  // its own state too. Only this CLI's own variables: another CLI's (inherited from the person's shell) is that CLI's.
  const movedHomes = input.provider === "opencode" && input.env.OPENCODE_CONFIG_DIR
    ? [resolve(input.cwd, input.env.OPENCODE_CONFIG_DIR)]
    : movedProviderHomes(input.provider, input.env);
  const ownFolders = [...own.folders, ...movedHomes];
  // Other CLIs' credentials where they are by default and where the launch environment moved them (their own home
  // variables, XDG_*): an exported GROK_HOME is where Grok's sign-in really is.
  const hides = (folder: string): boolean => [home, input.cwd].some((kept) => isWithin(kept, folder));
  const others = AGENT_PROVIDERS.filter((provider) => provider !== input.provider)
    .flatMap((provider) => {
      const defaults = providerFolders(provider, {}, home);
      const moved = providerFolders(provider, input.env, home);
      return [...defaults.folders, ...defaults.files, ...moved.folders, ...moved.files,
        ...movedProviderHomes(provider, input.env), ...movedProviderHomes(provider, input.env, CONFIG_FILE_VARIABLES)];
    })
    // A folder another CLI shares with this one (~/.cache/<name> never overlaps; .gemini could) stays this CLI's; a
    // variable pointing at HOME or above the project would hide them, so it is not followed.
    .filter((folder) => !ownFolders.includes(folder) && !hides(folder));
  const privateData = privateAppData(input.userDataPath);
  if (input.privateRunDirectory !== undefined && (!input.restrictHomeReads || !isAbsolute(input.privateRunDirectory))) {
    throw new Error("A private reviewer run grant must be an absolute path in restricted mode.");
  }
  let privateRunDirectory = input.privateRunDirectory;
  if (privateRunDirectory) {
    const runsRoot = join(realpathSync(input.userDataPath), "launch-runs");
    const rootInfo = lstatSync(runsRoot);
    const runInfo = lstatSync(privateRunDirectory);
    const canonicalRun = realpathSync(privateRunDirectory);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || realpathSync(runsRoot) !== runsRoot
      || runInfo.isSymbolicLink() || !runInfo.isDirectory() || canonicalRun !== privateRunDirectory
      || dirname(canonicalRun) !== runsRoot) {
      throw new Error("A private reviewer run grant must be one exact directory below the canonical launch-runs folder.");
    }
    privateRunDirectory = canonicalRun;
  }
  const grants = [...(input.grantedPrivate ?? []), privateRunDirectory ?? join(input.userDataPath, "launch-runs", safeSegment(input.sessionId))];
  const access=input.worktreeGitAccess;
  const worktree=access && isWithin(input.cwd,access.cwd) ? access : null;
  const project = worktree?.cwd ?? input.cwd;
  if (input.readOnlyProject) {
    const projectPaths = pathSpellings(project);
    const otherWritePaths = all([
      ...ownFolders, ...own.files, input.sessionTemp,
      join(home, ".npm"), join(home, ".bun"), join(xdg.cache, "npm"), join(xdg.cache, "bun")
    ]);
    for (const path of otherWritePaths) {
      if (projectPaths.some((root) => isWithin(root, path) || isWithin(path, root))) {
        throw new Error(`Writable CLI state ${path} overlaps the read-only project ${project}.`);
      }
    }
  }
  const trustedOwn = providerFolders(input.provider, {}, hostHome);
  const trustedOthers = AGENT_PROVIDERS.filter((provider) => provider !== input.provider).flatMap((provider) => {
    const defaults = providerFolders(provider, {}, hostHome);
    const configured = providerFolders(provider, hostEnv, hostHome);
    return [...defaults.folders, ...defaults.files, ...configured.folders, ...configured.files,
      ...movedProviderHomes(provider, hostEnv), ...movedProviderHomes(provider, hostEnv, CONFIG_FILE_VARIABLES)];
  }).filter((path) => ![...trustedOwn.folders, ...trustedOwn.files].includes(path)
    && ![hostHome, input.cwd].some((kept) => isWithin(kept, path)));
  const sensitive = all([...sensitiveHomeFolders(home, xdg.config), ...sensitiveHomeFolders(hostHome, hostXdg.config), ...trustedOthers]);
  if (pathSpellings(home).some((candidate) => sensitive.some((path) => isWithin(candidate, path)))) {
    throw new Error(`Launch HOME ${home} overlaps protected host credentials.`);
  }
  const privateSpellings = privateData.map((path) => ({ path, spellings: pathSpellings(path) }));
  const grantSpellings = all(grants);
  const accountRoot = join(input.userDataPath, "account-homes");
  const accountSpellings = pathSpellings(accountRoot);
  // Never re-allow a broad or aliased provider home over credentials. Account homes and this run's own
  // prepared files remain available, but only below their granted root; the root itself is never an account.
  for (const folder of ownFolders) {
    const candidates = pathSpellings(folder);
    const overlaps = (paths: readonly string[]): boolean => candidates.some((candidate) => paths.some((path) => isWithin(candidate, path) || isWithin(path, candidate)));
    if (overlaps(sensitive)) throw new Error(`CLI home ${folder} overlaps protected host credentials.`);
    for (const hidden of privateSpellings) {
      if (!overlaps(hidden.spellings)) continue;
      const withinGrant = candidates.every((candidate) => grantSpellings.some((grant) => isWithin(candidate, grant)));
      const ownAccount = hidden.path === accountRoot && candidates.every((candidate) => accountSpellings.some((base) => candidate !== base && isWithin(candidate, base)));
      // A CLI home inside this exact project adds no visibility beyond the project already granted. A moved home in
      // the plugin-data parent or a sibling is never enough to reopen that larger private tree.
      const insideProject = candidates.every((candidate) => pathSpellings(project).some((base) => isWithin(candidate, base)));
      if (!withinGrant && !ownAccount && !(hidden.path === join(input.userDataPath, "plugin-data") && insideProject)) {
        throw new Error(`CLI home ${folder} overlaps protected CanvasTTY data.`);
      }
    }
  }
  const configSources = input.provider === "opencode" ? openCodeConfigPaths(input.env, input.cwd) : { jsonFiles: [], agentDirectories: [] };
  if (input.restrictHomeReads) {
    const forbidden = all([...sensitive, ...privateData, ...(input.deniedReadPaths ?? [])]);
    const exceptions = [...ownFolders, ...own.files];
    for (const path of exceptions) {
      if (!isAbsolute(path)) throw new Error("A reviewer read exception must be absolute.");
      const candidates = pathSpellings(path);
      const broad = candidates.some(candidate => pathSpellings(home).concat(pathSpellings(hostHome))
        .some(root => isWithin(root,candidate)));
      const overlaps = candidates.some(candidate => forbidden.some(hidden => isWithin(candidate,hidden) || isWithin(hidden,candidate)));
      const inGrant = candidates.every(candidate => grantSpellings.some(grant => isWithin(candidate,grant)));
      if (broad || overlaps && !inGrant) throw new Error("A reviewer read exception overlaps a protected tree.");
    }
    // Trusted host executables and bundled hooks may be files in the reviewed repository. Grant exact files only;
    // no runtime directory may reopen project contents or another provider's credentials.
    const privateForbidden = all([...sensitive, ...others, ...privateData]);
    for (const path of input.runtimeReadable ?? []) {
      if (!isAbsolute(path)) throw new Error("A reviewer runtime file must be absolute.");
      if (!existsSync(path)) continue; // A different provider's optional bundled adapter may be absent.
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error("A reviewer runtime grant must be a file.");
      if (stat.nlink !== 1) throw new Error("A reviewer runtime grant must be a single-link file.");
      if (pathSpellings(path).some(candidate => privateForbidden.some(hidden => isWithin(candidate, hidden))))
        throw new Error("A reviewer runtime file overlaps protected data.");
    }
  }
  const socketFolders = [
    ...Object.entries(input.env)
      .filter(([name, value]) => /^CANVASTTY_.*_ADDRESS$/u.test(name) && typeof value === "string" && isAbsolute(value))
      .map(([, value]) => dirname(value!)),
    ...(input.socketFolders ?? []),
    input.sessionTemp,
    join(input.userDataPath, "browser", "runtime"),
    join(input.userDataPath, "lifecycle", "runtime"),
    join(input.userDataPath, "orchestration", "runtime")
  ];
  return {
    ...(input.restrictHomeReads ? {restrictReads:true} : {}),
    writable: all([
      ...(input.readOnlyProject ? [] : [project]),
      input.sessionTemp,
      ...ownFolders,
      join(home, ".npm"), join(home, ".bun"), join(xdg.cache, "npm"), join(xdg.cache, "bun")
    ]),
    writableFiles: all(own.files),
    creatableFolders: all([
      ...[...ownFolders, join(home, ".npm"), join(home, ".bun")].flatMap((folder) => ancestorsBelow(home, folder)),
    ]),
    protectedWrites: all([
      // A repository that exists keeps its config (hooksPath, fsmonitor, filters run code when the person uses git
      // later, outside the layer); a new one may be created, which writes its config.
      ...(existsSync(join(project, ".git", "config")) ? [join(project, ".git", "config"), join(project, ".git", "config.lock")] : []),
      ...(worktree ? [
        join(project, ".git"),
        join(worktree.adminDir, "HEAD")
      ] : []),
      ...(input.provider === "codex" ? ownFolders.map((folder) => join(folder, "config.toml")) : []),
      ...(input.provider === "claude" ? ownFolders.flatMap((folder) => [join(folder, "settings.json"), join(folder, "settings.local.json")]) : []),
      ...configSources.jsonFiles
    ]),
    protectedDirectories: all([
      ...configSources.agentDirectories.flatMap((folder) => [join(folder, "agent"), join(folder, "agents")]),
      ...(worktree ? [worktree.adminDir, worktree.commonDir] : [])
    ]),
    gitHooks: all([join(project, ".git", "hooks"), ...(worktree ? [join(worktree.adminDir, "hooks"), join(worktree.commonDir, "hooks")] : [])]),
    projectRoots: input.readOnlyProject ? [] : all([project]),
    unreadable: all([
      ...sensitive, ...others, ...privateData, ...(worktree ? worktree.otherAdminDirs : []),
      ...(input.restrictHomeReads ? [home, hostHome] : []),
      ...(input.deniedReadPaths ?? []),
    ]),
    readableAgain: all([...grants, ...movedHomes, ...(worktree ? [project, worktree.adminDir] : []),
      ...(input.restrictHomeReads ? [...ownFolders, ...own.files, input.sessionTemp, input.cwd,
        "/bin","/usr/bin","/sbin","/usr/sbin","/usr/lib","/usr/libexec","/usr/share","/System/Library","/System/Library/dyld",
        "/System/Volumes/Preboot/Cryptexes/OS","/dev","/private/var/db/dyld","/private/var/select/sh",
        join(home,".npm"),join(home,".bun"),join(xdg.cache,"npm"),join(xdg.cache,"bun"),...(input.runtimeReadable ?? [])] : [])]),
    socketFolders: all(socketFolders),
    socketPrefixes: all([dirname(dirname(realish(input.sessionTemp))), "/private/tmp", "/tmp"].map((folder) => join(folder, "ctty-")))
    // The temporary folder a launch's own folder lives in (sessionTemp is <temp root>/ctty-iso-…/tmp), and /tmp: where
    // CanvasTTY's gateways put their sockets when the userData path is too long for one.
  };
}

/** `path` is `folder` or inside it, by the host's path rules (separators, a drive on Windows). */
function isWithin(path: string, folder: string): boolean {
  const rest = relative(folder, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

/** The folders between `home` (exclusive) and `folder` (exclusive). */
function ancestorsBelow(home: string, folder: string): string[] {
  const found: string[] = [];
  for (let current = dirname(folder); current !== home && isWithin(current, home); current = dirname(current)) found.push(current);
  return found;
}

/** The launch pipeline's folder name for a session (LaunchPipeline.safeSegment). */
export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 128) || "_";
}
