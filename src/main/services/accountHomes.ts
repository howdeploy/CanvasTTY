import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProviderId } from "../../shared/contracts.ts";

// Account homes: a CLI home a launch contributor starts Grok or Kimi with (an account of an account pool). Grok Build
// and Kimi Code read their hooks, and Kimi its MCP servers and permission rules, only from that home, so CanvasTTY's
// temporary overlays go there for such a launch. These are the rules for when a home counts as the launch's own.

/** The variable that moves the home whose configuration Grok Build / Kimi Code read. */
const ACCOUNT_HOME_VARIABLES: Readonly<Partial<Record<ProviderId, string>>> = { grok: "GROK_HOME", kimi: "KIMI_CODE_HOME" };

/** A folder path without trailing separators (`/a/b/` names the same folder as `/a/b`); a root stays as it is. */
export function withoutTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed === "" || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed;
}

/** The path segments of `path` strictly below `root`, or null when it is not strictly inside. */
function segmentsBelow(root: string, path: string): string[] | null {
  const rest = relative(root, path);
  if (rest === "" || rest.startsWith("..") || isAbsolute(rest)) return null;
  return rest.split(sep);
}

/**
 * The home a launch contribution started a Grok or Kimi launch with (its `GROK_HOME` / `KIMI_CODE_HOME`); undefined for
 * other providers or when the contribution leaves the home alone. `KIMI_SHARE_DIR` (the older kimi-cli) is not it.
 */
export function accountHookHome(provider: ProviderId, contributedEnvironment: Readonly<Record<string, string>> | undefined): string | undefined {
  const name = ACCOUNT_HOME_VARIABLES[provider];
  const value = name ? contributedEnvironment?.[name] : undefined;
  return typeof value === "string" && value.length > 0 ? withoutTrailingSeparator(value) : undefined;
}

/**
 * The account home one contributor handed a Grok/Kimi launch: `value` of the provider's home variable `key` when it is an
 * exact absolute path strictly inside that contributor's own data folder. `dataDir` is the host's record of the
 * contributor (`<userData>/plugin-data/<pluginId>`), never the plugin's answer, so a plugin can only name a folder of
 * its own data.
 */
export function contributedHookHome(provider: ProviderId, dataDir: string | undefined, key: string, value: string): string | undefined {
  if (!dataDir || !isAbsolute(dataDir) || ACCOUNT_HOME_VARIABLES[provider] !== key) return undefined;
  const folder = withoutTrailingSeparator(value);
  if (!isAbsolute(folder) || resolve(folder) !== folder) return undefined;
  return segmentsBelow(resolve(dataDir), folder) ? folder : undefined;
}

/**
 * The account home an overlay may be written into, or null for the default home (the launch is then exactly as before).
 * Only an exact absolute folder at least `<plugin>/<home>` deep inside `root` (`<userData>/plugin-data`), other than the
 * default home, counts. Inside the root every folder from the root down must be a real folder (a missing one is created,
 * private) and none of `written` (names in the home CanvasTTY writes) a symbolic link, or this throws and the launch is
 * refused: CanvasTTY never writes through a link into another place.
 */
export function ownedAccountHome(options: {
  root: string | undefined;
  candidate: string | undefined;
  defaultHome: string;
  written: readonly string[];
  label: string;
}): string | null {
  const { root, candidate } = options;
  if (!root || candidate === undefined) return null;
  const home = withoutTrailingSeparator(candidate);
  if (!isAbsolute(home) || resolve(home) !== home || home === options.defaultHome) return null;
  const segments = segmentsBelow(resolve(root), home);
  if (!segments || segments.length < 2) return null;
  try {
    let path = resolve(root);
    let canonical = realpathSync.native(path);
    for (const segment of ["", ...segments]) {
      if (segment) {
        path = join(path, segment);
        canonical = join(canonical, segment);
      }
      // A new account's home (or the folders above it in the plugin's data) may not exist yet: the CLI would create it
      // on its first run. One private folder at a time, never recursively, so no link is followed while creating it.
      if (segment && !exists(path)) mkdirSync(path, { mode: 0o700 });
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== canonical) throw new Error("not a real folder");
    }
  } catch {
    throw new Error(`The ${options.label} account home is missing or crosses a symbolic link; CanvasTTY did not write its configuration there.`);
  }
  for (const name of options.written) {
    let link = false;
    try {
      link = lstatSync(join(home, name)).isSymbolicLink();
    } catch {
      continue;
    }
    if (link) throw new Error(`The ${options.label} account home holds a symbolic link where CanvasTTY writes its configuration.`);
  }
  return home;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
