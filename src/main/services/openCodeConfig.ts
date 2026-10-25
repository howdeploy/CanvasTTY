import { ORCHESTRATION_MCP_SERVER_NAME } from "../../agent-browser/orchestration-catalog.mjs";
import { MCP_SERVER_NAME } from "../../agent-browser/tool-catalog.mjs";
import { ORCHESTRATION_ENV } from "./agent-browser/orchestration-protocol.ts";
import { otherSpellings } from "./onDiskPath.ts";
import { join } from "node:path";
import { lazyRequire } from "../lazyRequire.ts";
import { openCodeConfigPaths, parseJsonc, readInspectedFile } from "./inspectedConfig.ts";

const lazyYaml = lazyRequire<typeof import("yaml")>("yaml");

const OPENCODE_CONFIG_CONTENT = "OPENCODE_CONFIG_CONTENT";
const OPENCODE_PERMISSION = "OPENCODE_PERMISSION";

interface OpenCodeStdioHelper {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

type OpenCodeConfig = Record<string, unknown>;

/** `helper` null: browser access is off, only canvastty_agents is attached. */
export function openCodeBrowserEnvironment(
  helper: OpenCodeStdioHelper | null,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  orchestrationHelper?: OpenCodeStdioHelper
): Record<string, string> {
  const config = parseInlineConfig(environment[OPENCODE_CONFIG_CONTENT]);
  const mcp = objectField(config.mcp, "mcp");
  return {
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify({
      ...config,
      mcp: {
        ...mcp,
        ...(helper ? {
          [MCP_SERVER_NAME]: {
            type: "local",
            command: [helper.command, ...helper.args],
            enabled: true,
            ...(helper.env && Object.keys(helper.env).length > 0
              ? { environment: helper.env }
              : {})
          }
        } : {}),
        ...(orchestrationHelper
          ? { [ORCHESTRATION_MCP_SERVER_NAME]: openCodeOrchestrationEntry(orchestrationHelper) }
          : {})
      },
      ...(helper ? { permission: allowBrowserTools(config.permission) } : {})
    })
  };
}

// OpenCode merges the parent environment into local MCP servers, so the
// orchestration variables reach the helper through inheritance exactly like
// the browser variables do. The {env:NAME} references pin them explicitly:
// OpenCode substitutes those tokens from its own environment while loading the
// inline config, which resolves to the inherited value when the variables are
// present and keeps the helper reachable even if a future version stopped
// passing the full parent environment.
function openCodeOrchestrationEntry(helper: OpenCodeStdioHelper): Record<string, unknown> {
  return {
    type: "local",
    command: [helper.command, ...helper.args],
    enabled: true,
    environment: {
      ...helper.env,
      ...Object.fromEntries(Object.values(ORCHESTRATION_ENV).map((key) => [key, `{env:${key}}`]))
    }
  };
}

export function openCodeYoloEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const config = parseInlineConfig(environment[OPENCODE_CONFIG_CONTENT]);
  return {
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify({ ...config, permission: "allow" })
  };
}

/**
 * OpenCode's "auto" profile for this run (OpenCode 1.18 has no auto flag). How OpenCode 1.18.33 decides
 * (packages/opencode/src/agent/agent.ts, permission/index.ts): the build agent's rules are its defaults, then the
 * merged top-level `permission`, then the merged `agent.build.permission`; Permission.evaluate takes the LAST rule
 * whose permission key and pattern both match (`*` and `?` wildcards, the key included, so `"*": "deny"` covers
 * every tool). Config files and this run's inline config are merged with remeda's mergeDeep: a key keeps the place
 * where it first appeared. OPENCODE_PERMISSION merges into the top-level rules after the inline config.
 *
 * Auto adds rules under `agent.build` for the tools it opens (read, glob, grep, list, edit, bash), and never grants
 * what the person's own configuration denies or asks about:
 * - a tool that any of the person's deny or ask rules reaches through another key (`"*"`, `"ed*"`, …) is left alone,
 *   as is a tool the person's config files already name under `agent.build.permission` (merging would put auto's
 *   rules after theirs). Such a tool behaves exactly as without auto;
 * - a tool with canonical array-index pattern names is left alone too: object enumeration puts those rules
 *   before auto's wildcard regardless of insertion order. Numeric bash rules that would lose the shell prompt
 *   require guarded Auto; otherwise launch stops;
 * - for any other tool, auto's rules come first and the person's own rules for that tool (top-level and this run's
 *   agent.build, in their order) after them, so the person's rules still win;
 * - a config file that exists but cannot be read or parsed leaves every tool alone. Malformed OPENCODE_PERMISSION
 *   JSON is ignored, like OpenCode; valid JSON with an unsupported permission shape stops auto or accept-edits.
 * Auto's rules: read, glob, grep, list allowed, except `.env` files (they ask, like OpenCode's default); edit (edit,
 * write, apply_patch) allowed; bash allowed only when `shellGuarded` (CanvasTTY's base protection is on and its guard
 * runs in this OpenCode), otherwise it asks. external_directory is not touched: a path outside the project still asks.
 * `thirdPartyModel` (a launch contributor put OpenCode on another model) keeps bash asking, like accept-edits, in a
 * subagent's card too: that ask reaches the person through needs_approval, and the orchestrator cannot answer it.
 */
export function openCodeAutoEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  options: { shellGuarded: boolean; thirdPartyModel?: boolean; cwd?: string; readFile?: (path: string) => string | null; platform?: NodeJS.Platform }
): Record<string, string> {
  if (parseEnvironmentPermission(environment[OPENCODE_PERMISSION]) === null) {
    throw new Error("OPENCODE_PERMISSION must contain a permission object with allow, ask, or deny actions before CanvasTTY can use auto or accept-edits.");
  }
  const config = parseInlineConfig(environment[OPENCODE_CONFIG_CONTENT]);
  const agents = objectField(config.agent, "agent");
  const build = objectField(agents.build, "agent.build");
  const permission = build.permission === undefined ? {} : objectField(build.permission, "agent.build.permission");
  const person = openCodePersonRules(environment, options.cwd, options.readFile);
  const auto = openCodeAutoPermission(options.shellGuarded && options.thirdPartyModel !== true);
  return {
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify({
      ...config,
      agent: {
        ...agents,
        build: {
          ...build,
          permission: autoWithPersonRules(permission, auto, person, options.platform ?? process.platform)
        }
      }
    })
  };
}

type Action = "allow" | "ask" | "deny";
type Rule = Action | Record<string, Action>;
type PermissionBlock = Record<string, Rule>;

/** The person's OpenCode permission rules, merged the way OpenCode merges its configuration. */
export interface OpenCodePersonRules {
  /** The merged top-level `permission` of the config files, this run's inline config, and OPENCODE_PERMISSION. */
  top: PermissionBlock;
  /** The merged `agent.build.permission` of the config files and agent files (this run's inline one is not here). */
  fileAgent: PermissionBlock;
  /** This run's inline `agent.build.permission`. */
  inlineAgent: PermissionBlock;
  /** A config source could not be understood: auto must not assume anything about its permissions. */
  unknown: boolean;
}

/**
 * The person's OpenCode configuration as OpenCode 1.18 loads it: the global config files, OPENCODE_CONFIG, the
 * project's opencode.json(c) from the file system root down to the working folder, `.opencode` folders and
 * OPENCODE_CONFIG_DIR (their opencode.json(c) and `agent/build.md`), this run's inline config, then the top-level
 * OPENCODE_PERMISSION environment rules. Remote
 * (well-known) configurations of a signed-in organization are not read.
 */
export function openCodePersonRules(
  environment: Readonly<Record<string, string | undefined>>,
  cwd?: string,
  readFile?: (path: string) => string | null
): OpenCodePersonRules {
  const paths = openCodeConfigPaths(environment, cwd);
  let top: PermissionBlock = {};
  let fileAgent: PermissionBlock = {};
  let unknown = false;
  const fileCache = new Map<string, string | null>();
  const read = (path: string): string | null => {
    if (fileCache.has(path)) return fileCache.get(path)!;
    let text: string | null;
    if (readFile) {
      try { text = readFile(path); }
      catch { unknown = true; text = null; }
    } else {
      const file = readInspectedFile(path);
      if (file.kind === "uninspectable") unknown = true;
      text = file.kind === "text" ? file.text : null;
    }
    fileCache.set(path, text);
    return text;
  };
  const take = (value: unknown, into: "top" | "agent"): void => {
    const block = permissionBlock(value);
    if (block === null) { unknown = true; return; }
    if (into === "top") top = mergeDeep(top, block);
    else fileAgent = mergeDeep(fileAgent, block);
  };
  for (const source of paths.orderedSources) {
    if (source.kind === "json") {
      const text = read(source.path);
      if (text === null) continue;
      const parsed = parseLoose(text);
      if (!isObject(parsed)) { if (text.trim()) unknown = true; continue; }
      if (parsed.permission !== undefined) take(parsed.permission, "top");
      const agent = isObject(parsed.agent) && isObject(parsed.agent.build) ? parsed.agent.build.permission : undefined;
      if (agent !== undefined) take(agent, "agent");
      continue;
    }
    const permissions: unknown[] = [];
    for (const file of [join(source.directory, "agent", "build.md"), join(source.directory, "agents", "build.md")]) {
      const text = read(file);
      if (text === null) continue;
      const front = markdownFrontMatter(text);
      if (front === null) { unknown = true; continue; }
      if (front.permission !== undefined) permissions.push(front.permission);
    }
    if (permissions.length > 1) unknown = true;
    else if (permissions.length === 1) take(permissions[0], "agent");
  }
  const inline = parseLoose(environment[OPENCODE_CONFIG_CONTENT] ?? "");
  let inlineAgent: PermissionBlock = {};
  if (isObject(inline)) {
    if (inline.permission !== undefined) take(inline.permission, "top");
    const agent = isObject(inline.agent) && isObject(inline.agent.build) ? inline.agent.build.permission : undefined;
    if (agent !== undefined) {
      const block = permissionBlock(agent);
      if (block === null) unknown = true;
      else inlineAgent = block;
    }
  }
  const environmentPermission = parseEnvironmentPermission(environment[OPENCODE_PERMISSION]);
  if (environmentPermission === null) unknown = true;
  else if (environmentPermission !== undefined) top = mergeDeep(top, environmentPermission);
  return { top, fileAgent, inlineAgent, unknown };
}

const AUTO_TOOLS = ["read", "glob", "grep", "list", "edit", "bash"] as const;

/**
 * This run's `agent.build.permission`: the inline one it started with, then auto's rules for each tool it may open
 * (see openCodeAutoEnvironment), each followed by the person's own rules for that tool.
 */
function autoWithPersonRules(
  inline: OpenCodeConfig,
  auto: PermissionBlock,
  person: OpenCodePersonRules,
  platform: NodeJS.Platform
): OpenCodeConfig {
  const result: OpenCodeConfig = { ...inline };
  if (person.unknown) return result;
  const personRules = [...permissionRules(person.top), ...permissionRules(person.fileAgent), ...permissionRules(person.inlineAgent)];
  for (const tool of AUTO_TOOLS) {
    const reachedElsewhere = personRules.some((rule) => rule.permission !== tool && rule.action !== "allow"
      && wildcardMatch(tool, rule.permission, platform));
    // JavaScript enumerates array-index keys before every other string key, including our wildcard.
    // An overlay cannot put those person rules last. Keep this tool's original ordering instead.
    const indexedPattern = personRules.some((rule) => wildcardMatch(tool, rule.permission, platform)
      && isArrayIndexPattern(rule.pattern));
    if (reachedElsewhere || Object.hasOwn(person.fileAgent, tool)) continue;
    if (indexedPattern) {
      if (tool === "bash" && auto.bash === "ask") {
        throw new Error("OpenCode numeric bash permission patterns require guarded Auto; Auto without base protection and Accept edits cannot preserve these rules safely.");
      }
      continue;
    }
    const patterns: Record<string, Action> = Object.create(null);
    const add = (rule: Rule | undefined): void => {
      if (rule === undefined) return;
      for (const [pattern, action] of Object.entries(typeof rule === "string" ? { "*": rule } : rule)) {
        delete patterns[pattern];
        patterns[pattern] = action;
      }
    };
    add(auto[tool]);
    add(person.top[tool]);
    add(person.inlineAgent[tool]);
    const keys = Object.keys(patterns);
    delete result[tool];
    result[tool] = keys.length === 1 && keys[0] === "*" ? patterns["*"] : patterns;
  }
  return result;
}

function isArrayIndexPattern(pattern: string): boolean {
  const index = Number(pattern);
  return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === pattern;
}

/** OpenCode's Permission.fromConfig: one rule per tool action, one per pattern of a tool object, in order. */
function permissionRules(block: PermissionBlock): Array<{ permission: string; pattern: string; action: Action }> {
  return Object.entries(block).flatMap(([permission, rule]) => typeof rule === "string"
    ? [{ permission, pattern: "*", action: rule }]
    : Object.entries(rule).map(([pattern, action]) => ({ permission, pattern, action })));
}

/** Undefined means absent or malformed JSON; null means valid JSON with an unsupported permission shape.
 * OpenCode merges this environment source raw, without its config schema's single-action normalization. */
function parseEnvironmentPermission(raw: string | undefined): PermissionBlock | null | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  return isObject(parsed) ? permissionBlock(parsed) : null;
}

/** A permission value as OpenCode's schema reads it (a single action means every tool), or null when it is not one. */
function permissionBlock(value: unknown): PermissionBlock | null {
  if (isAction(value)) return { "*": value };
  if (!isObject(value)) return null;
  const block: PermissionBlock = {};
  for (const [key, rule] of Object.entries(value)) {
    if (isAction(rule)) { block[key] = rule; continue; }
    if (!isObject(rule) || !Object.values(rule).every(isAction)) return null;
    block[key] = { ...(rule as Record<string, Action>) };
  }
  return block;
}

function isAction(value: unknown): value is Action {
  return value === "allow" || value === "ask" || value === "deny";
}

/** remeda's mergeDeep as OpenCode uses it for configuration: a key keeps its first place, objects merge. */
function mergeDeep(target: PermissionBlock, source: PermissionBlock): PermissionBlock {
  const result: PermissionBlock = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = result[key];
    result[key] = isObject(current) && isObject(value) ? { ...current, ...value } : value;
  }
  return result;
}

/** OpenCode's Wildcard.match (packages/core/src/util/wildcard.ts). */
export function wildcardMatch(input: string, pattern: string, platform: NodeJS.Platform = process.platform): boolean {
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, platform === "win32" ? "si" : "s").test(input.replaceAll("\\", "/"));
}

/** The YAML front matter of an agent file, or null when it cannot be read; {} when there is none. */
function markdownFrontMatter(text: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return {};
  try {
    const parsed = (lazyYaml().parse(match[1]) as unknown) ?? {};
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseLoose(text: string): unknown {
  if (!text.trim()) return null;
  const parsed = parseJsonc(text);
  return parsed.ok ? parsed.value : null;
}

/** The auto rules (see openCodeAutoEnvironment); insertion order matters, the last matching rule wins. */
export function openCodeAutoPermission(allowShell: boolean): Record<string, Action | Record<string, Action>> {
  return {
    read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: "allow",
    bash: allowShell ? "allow" : "ask"
  };
}

/**
 * OpenCode asks before a tool touches a path outside its project folder (external_directory), comparing strings.
 * Its project folder is the one it reads back from the system, spelled as on disk (NFD for Finder-made names on
 * macOS), while the prompt it got usually spells the same folder in NFC. This run allows exactly that folder in its
 * other spellings; nothing else is widened, and a folder whose name has one spelling (ASCII) changes nothing.
 */
export function openCodeProjectFolderEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  folder: string
): Record<string, string> {
  const spellings = otherSpellings(folder);
  if (spellings.length === 0) return {};
  const config = parseInlineConfig(environment[OPENCODE_CONFIG_CONTENT]);
  const permission = config.permission;
  // Everything is allowed already (YOLO), or the person's own inline config decides with a single word.
  if (permission === "allow" || typeof permission === "string") return {};
  const current = objectField(permission, "permission");
  const external = current.external_directory;
  if (external === "allow") return {};
  const patterns = typeof external === "string" ? { "*": external } : objectField(external, "permission.external_directory");
  const allowed = Object.fromEntries(spellings.flatMap((spelling) => [[spelling, "allow"], [`${spelling}/**`, "allow"]]));
  return {
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify({
      ...config,
      permission: { ...current, external_directory: { ...patterns, ...allowed } }
    })
  };
}

function parseInlineConfig(raw: string | undefined): OpenCodeConfig {
  if (!raw || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OPENCODE_CONFIG_CONTENT must contain valid JSON before CanvasTTY can extend it.");
  }
  if (!isObject(parsed)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must contain a JSON object before CanvasTTY can extend it.");
  }
  return parsed;
}

function objectField(value: unknown, name: string): OpenCodeConfig {
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw new Error(`OpenCode inline config field ${name} must be an object.`);
  }
  return value;
}

function allowBrowserTools(permission: unknown): OpenCodeConfig {
  if (permission === undefined) return { [`${MCP_SERVER_NAME}_*`]: "allow" };
  if (permission === "allow") return { "*": "allow", [`${MCP_SERVER_NAME}_*`]: "allow" };
  if (permission === "ask" || permission === "deny") {
    return { "*": permission, [`${MCP_SERVER_NAME}_*`]: "allow" };
  }
  return {
    ...objectField(permission, "permission"),
    [`${MCP_SERVER_NAME}_*`]: "allow"
  };
}

function isObject(value: unknown): value is OpenCodeConfig {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
