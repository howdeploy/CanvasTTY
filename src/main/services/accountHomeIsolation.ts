import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ProviderId } from "../../shared/contracts.ts";

/** The Accounts service id is fixed by the host; plugin replies cannot nominate a private-data exception. */
export const ACCOUNTS_PLUGIN_ID = "canvastty-accounts";

/** The account a launch is billed to: an empty or "none" selection means the provider's own default sign-in. */
export function selectedAccountId(options: Readonly<Record<string, unknown>> | undefined): string {
  const values = options?.[ACCOUNTS_PLUGIN_ID];
  const selected = values && typeof values === "object" ? (values as Record<string, unknown>).account : undefined;
  return typeof selected === "string" && selected !== "" && selected !== "none" ? selected : "default";
}

/**
 * Returns a candidate account home only for the host's Accounts launch contributor and matching CLI provider.
 * The data directory is populated by PluginManager, never by plugin RPC. Filesystem links and existence are checked
 * again immediately before the operating-system sandbox is built.
 */
export function selectedAccountHome(
  provider: ProviderId,
  pluginId: string,
  dataDir: string | undefined,
  selectedAccountId: unknown,
  contributedEnv: Readonly<Record<string, string>>
): string | undefined {
  if (pluginId !== ACCOUNTS_PLUGIN_ID || !dataDir || !isAbsolute(dataDir)) return undefined;
  if (typeof selectedAccountId !== "string" || !selectedAccountId || selectedAccountId === "none") return undefined;
  const variable = provider === "codex" ? "CODEX_HOME" : provider === "claude" ? "CLAUDE_CONFIG_DIR" : undefined;
  if (!variable) return undefined;
  const value = contributedEnv[variable];
  if (!value || !isAbsolute(value)) return undefined;

  const accountData = resolve(dataDir);
  const homes = join(accountData, "homes");
  const selected = resolve(value);
  const prefix = `${provider}-`;
  if (basename(accountData) !== ACCOUNTS_PLUGIN_ID || basename(dirname(accountData)) !== "plugin-data"
    || selected !== value || dirname(selected) !== homes || basename(selected) !== `${prefix}${selectedAccountId}`) return undefined;
  return selected;
}

/**
 * Checks the candidate against this app's own private data directory at wrap time. The plugin-data directory,
 * Accounts directory, homes directory and selected child must all be real directories, not symlinks.
 */
export function validateSelectedAccountHome(userDataPath: string, provider: ProviderId, candidate: string): string {
  if (provider !== "codex" && provider !== "claude") {
    throw new Error("Only the Accounts Codex or Claude home can be reopened by isolation. The agent was not started.");
  }
  const userData = resolve(userDataPath);
  const realUserData = realpathSync.native(userData);
  const pluginData = join(userData, "plugin-data");
  const accountsData = join(pluginData, ACCOUNTS_PLUGIN_ID);
  const homes = join(accountsData, "homes");
  const selected = resolve(candidate);
  const prefix = `${provider}-`;
  if (!isAbsolute(candidate) || candidate !== selected || dirname(selected) !== homes
    || !basename(selected).startsWith(prefix) || basename(selected).length <= prefix.length) {
    throw new Error("The selected Accounts CLI home must be a direct child for this provider. The agent was not started.");
  }

  const expected = [
    [pluginData, join(realUserData, "plugin-data")],
    [accountsData, join(realUserData, "plugin-data", ACCOUNTS_PLUGIN_ID)],
    [homes, join(realUserData, "plugin-data", ACCOUNTS_PLUGIN_ID, "homes")],
    [selected, join(realUserData, "plugin-data", ACCOUNTS_PLUGIN_ID, "homes", basename(selected))]
  ] as const;
  try {
    for (const [path, canonical] of expected) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== canonical) {
        throw new Error("not a real directory");
      }
    }
  } catch {
    throw new Error("The selected Accounts CLI home is missing or crosses a symbolic link. The agent was not started.");
  }
  return expected.at(-1)![1];
}
