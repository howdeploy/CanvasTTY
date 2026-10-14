import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProviderId } from "../../../shared/contracts.ts";
import { AGENT_PROVIDERS } from "../../../shared/contracts.ts";
import { otherSpellings } from "../onDiskPath.ts";
import { openCodeConfigPaths } from "../inspectedConfig.ts";

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
  /**
   * The sockets of CanvasTTY's own gateways for this launch, as the host set them up. Their folders are bound back;
   * a CANVASTTY_*_ADDRESS in the launch environment (the person's own or a plugin's) never is.
   */
  gatewaySockets?: readonly string[];
  /**
   * Folders the host itself placed this launch in (an environment's worktree, the folder the person chose for the
   * card the launch descends from). A project inside plugin data is reopened only when it is inside one of them.
   */
  placedProjects?: readonly PlacedProject[];
  /** Plan: the project is readable only (the CLI's own folders stay writable). */
  readOnlyProject?: boolean;
}

/**
 * A folder the host placed a launch in. `pluginId`: an environment of that plugin placed it, so it counts only inside
 * that plugin's own data folder; without it, the person chose the folder.
 */
export interface PlacedProject {
  folder: string;
  pluginId?: string;
}

export interface IsolationPaths {
  /** Writable folders (subpaths), every spelling. */
  writable: string[];
  /**
   * Read-only as a whole although a writable folder holds it: CanvasTTY's own data folder when the project contains it
   * (a project at HOME). Its settings and the plugins it runs are not the agent's to change; the writable folders above
   * that sit inside it (an account home, this launch's own folders) stay writable.
   */
  readOnlyFolders: string[];
  /**
   * The folders between a writable folder and a read-only folder inside it (`~/.config` for `~/.config/canvastty` in a
   * project at HOME): what is inside stays writable, but they cannot be renamed or replaced, which would move the
   * read-only folder out of its protected path and let a different one take its place.
   */
  fixedFolders: string[];
  /** Writable single files (with their `.lock` / `.tmp` / backup siblings). */
  writableFiles: string[];
  /** Folders that may be created (empty) on the way to a writable one: `~/.local/state` for `~/.local/state/opencode`. */
  creatableFolders: string[];
  /** Inside writable folders, still not writable: the repository's git config and `commondir`, the CLIs' own permission settings. */
  protectedWrites: string[];
  /** Permission-bearing agent directories and the repository's linked-worktree records; empty directories are neutral. */
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

/** The environment variables that name this provider's CLI home (empty when it has none). */
export function providerHomeVariables(provider: ProviderId): readonly string[] {
  return HOME_VARIABLES[provider] ?? [];
}

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

/** Plugins' private data below userData (PluginManager's `<userData>/plugin-data/<pluginId>`). */
export const PLUGIN_DATA_FOLDER = "plugin-data";

/**
 * CanvasTTY's own private data under userData: tokens, connection records, secret stores, account homes, prepared
 * launch files and every plugin's private data (an accounts plugin keeps all of its CLI homes there). Its gateways'
 * runtime folders stay readable: they hold token-authenticated sockets and per-run hook settings the CLI must read.
 */
export function privateAppData(userDataPath: string): string[] {
  return ["agent-control", "provider-secrets.bin", "plugin-secrets", "account-homes", "github-oauth.json", "launch-runs", PLUGIN_DATA_FOLDER]
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
  const project = input.cwd;
  // A project inside plugin data (a plugin environment's worktree) stays this launch's project: that exact folder is
  // reopened, never its siblings, its plugin's other data or all plugin data. Only when the host placed the launch
  // there: a folder an agent asked for (a subagent's cwd) could otherwise be a plugin's account homes.
  const pluginDataRoot = join(input.userDataPath, PLUGIN_DATA_FOLDER);
  const projectDepth = pluginDataDepth(pathSpellings, pluginDataRoot, project);
  if (projectDepth >= 0 && projectDepth < 2) throw new Error(`The project ${project} is CanvasTTY's private plugin data.`);
  if (projectDepth >= 2 && !(input.placedProjects ?? []).some((placed) => placesProject(pathSpellings, pluginDataRoot, placed, project))) {
    throw new Error(`The project ${project} is inside CanvasTTY's private plugin data, and CanvasTTY did not place this launch there. Only a plugin environment's own folder or a folder the person chose is opened inside plugin data.`);
  }
  const grants = [...(input.grantedPrivate ?? []), join(input.userDataPath, "launch-runs", safeSegment(input.sessionId)),
    ...(projectDepth >= 2 ? [project] : [])];
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
      if (!withinGrant && !ownAccount) throw new Error(`CLI home ${folder} overlaps protected CanvasTTY data.`);
    }
  }
  const gitDir = join(project, ".git");
  const repository = existsSync(join(gitDir, "config"));
  const configSources = input.provider === "opencode" ? openCodeConfigPaths(input.env, input.cwd) : { jsonFiles: [], agentDirectories: [] };
  const socketFolders = [
    ...(input.gatewaySockets ?? []).filter((path) => isAbsolute(path)).map((path) => dirname(path)),
    ...(input.socketFolders ?? []),
    input.sessionTemp,
    join(input.userDataPath, "browser", "runtime"),
    join(input.userDataPath, "lifecycle", "runtime"),
    join(input.userDataPath, "orchestration", "runtime")
  ];
  const writable = all([
    ...(input.readOnlyProject ? [] : [project]),
    input.sessionTemp,
    ...ownFolders,
    join(home, ".npm"), join(home, ".bun"), join(xdg.cache, "npm"), join(xdg.cache, "bun")
  ]);
  const userData = pathSpellings(input.userDataPath);
  const readOnlyFolders = writable.some((folder) => userData.some((path) => isWithin(path, folder))) ? userData : [];
  const fixedFolders = readOnlyFolders.flatMap((path) => writable.filter((folder) => folder !== path && isWithin(path, folder))
    .flatMap((folder) => ancestorsBelow(folder, path)));
  return {
    writable,
    readOnlyFolders,
    fixedFolders: [...new Set(fixedFolders)],
    writableFiles: all(own.files),
    creatableFolders: all([...ownFolders, join(home, ".npm"), join(home, ".bun")].flatMap((folder) => ancestorsBelow(home, folder))),
    protectedWrites: all([
      // A repository that exists keeps its config (hooksPath, fsmonitor, filters run code when the person uses git
      // later, outside the layer), and its per-worktree config; a new one may be created, which writes its config.
      ...(repository ? [join(gitDir, "config"), join(gitDir, "config.lock"), join(gitDir, "config.worktree"), join(gitDir, "config.worktree.lock")] : []),
      // Where git reads the shared config and hooks from. Protected where it exists: an empty placeholder (Linux) would
      // stop git from working; seatbelt also denies creating it (projectRoots).
      ...(existsSync(join(gitDir, "commondir")) ? [join(gitDir, "commondir")] : []),
      ...(input.provider === "codex" ? ownFolders.map((folder) => join(folder, "config.toml")) : []),
      ...(input.provider === "claude" ? ownFolders.flatMap((folder) => [join(folder, "settings.json"), join(folder, "settings.local.json")]) : []),
      ...configSources.jsonFiles
    ]),
    // Linked worktrees' records (their git folder, `commondir` and config): what git reads when the person works there.
    protectedDirectories: all([...configSources.agentDirectories.flatMap((folder) => [join(folder, "agent"), join(folder, "agents")]),
      ...(repository ? [join(gitDir, "worktrees")] : [])]),
    gitHooks: all([join(project, ".git", "hooks")]),
    projectRoots: input.readOnlyProject ? [] : all([project]),
    unreadable: all([...sensitive, ...others, ...privateData]),
    readableAgain: all([...grants, ...movedHomes]),
    socketFolders: all(socketFolders),
    // The temporary folder a launch's own folder lives in (sessionTemp is <temp root>/ctty-iso-…/tmp), and /tmp: where
    // CanvasTTY's gateways put their sockets when the userData path is too long for one.
    socketPrefixes: all([dirname(dirname(realish(input.sessionTemp))), "/private/tmp", "/tmp"].map((folder) => join(folder, "ctty-")))
  };
}

/** How many folders below plugin data `path` is (0: plugin data itself), in any spelling; -1 when it is not inside. */
function pluginDataDepth(spellingsOf: (path: string) => string[], pluginDataRoot: string, path: string): number {
  const roots = spellingsOf(pluginDataRoot);
  return Math.max(-1, ...spellingsOf(path).flatMap((candidate) => roots
    .filter((root) => isWithin(candidate, root))
    .map((root) => relative(root, candidate).split(/[\\/]+/u).filter(Boolean).length)));
}

/**
 * `project` is inside a folder the host placed the launch in, and that folder is itself a folder inside one plugin's
 * data (never all of it or a whole plugin's data); an environment's folder counts only inside its own plugin's data.
 */
function placesProject(spellingsOf: (path: string) => string[], pluginDataRoot: string, placed: PlacedProject, project: string): boolean {
  if (!isAbsolute(placed.folder)) return false;
  if (pluginDataDepth(spellingsOf, pluginDataRoot, placed.folder) < 2) return false;
  if (placed.pluginId !== undefined) {
    // One folder name (PluginManager's `<plugin-data>/<pluginId>`), and the placed folder strictly inside it.
    if (!/^[^/\\.][^/\\]*$/u.test(placed.pluginId)) return false;
    if (pluginDataDepth(spellingsOf, join(pluginDataRoot, placed.pluginId), placed.folder) < 1) return false;
  }
  const folders = spellingsOf(placed.folder);
  return spellingsOf(project).some((candidate) => folders.some((folder) => isWithin(candidate, folder)));
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
