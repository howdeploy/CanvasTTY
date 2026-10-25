import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ProviderId } from "../../../shared/contracts.ts";
import { segmentsBelow, withoutTrailingSeparator } from "../accountHomes.ts";
import { PLUGIN_DATA_FOLDER, providerHomeVariables } from "./isolationPaths.ts";

/**
 * The CLI home a launch contributor handed this launch inside its own data folder: the value of the provider's own
 * home variable (providerHomeVariables: CODEX_HOME, CLAUDE_CONFIG_DIR, GROK_HOME, HERMES_HOME, KIMI_CODE_HOME,
 * KIMI_SHARE_DIR, KIMI_HOME, OPENCODE_CONFIG_DIR, QWEN_HOME; never HOME or XDG_*) when it is an exact absolute path strictly below the
 * contributor's data folder (a trailing separator is dropped: `homes/a/` is `homes/a`). `dataDir` comes from the
 * host's contributor record, never from the plugin's answer, so a plugin can only point at a folder of its own data,
 * and only the one the CLI is actually started with.
 */
export function contributedAccountHome(
  provider: ProviderId,
  dataDir: string | undefined,
  key: string,
  value: string
): string | undefined {
  if (!dataDir || !isAbsolute(dataDir) || !providerHomeVariables(provider).includes(key)) return undefined;
  const folder = withoutTrailingSeparator(value);
  if (!isAbsolute(folder) || resolve(folder) !== folder) return undefined;
  return segmentsBelow(resolve(dataDir), folder) ? folder : undefined;
}

/**
 * Checks a contributed account home again when the isolation layer is built. Nothing is reopened when the launch no
 * longer starts the CLI with it (an environment replaced the variable). Otherwise it must be a real folder strictly
 * inside one plugin's data folder, reached without a symbolic link at any step from `<userData>/plugin-data`: the
 * path to reopen is returned, and anything else throws (the launch is refused).
 */
export function validateAccountHome(
  userDataPath: string,
  provider: ProviderId,
  candidate: string,
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  const started = (value: string | undefined): boolean => typeof value === "string" && withoutTrailingSeparator(value) === candidate;
  if (!providerHomeVariables(provider).some((name) => started(env[name]))) return undefined;
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
    throw new Error("The selected account home must be an exact absolute folder.");
  }
  const pluginData = join(resolve(userDataPath), PLUGIN_DATA_FOLDER);
  const segments = segmentsBelow(pluginData, candidate);
  // <pluginId>/<at least one folder>: never all of plugin data, never a whole plugin's data folder.
  if (!segments || segments.length < 2) {
    throw new Error("The selected account home must be a folder inside one plugin's data.");
  }
  try {
    const canonicalRoot = join(realpathSync.native(resolve(userDataPath)), PLUGIN_DATA_FOLDER);
    let path = pluginData;
    let canonical = canonicalRoot;
    for (const segment of ["", ...segments]) {
      if (segment) {
        path = join(path, segment);
        canonical = join(canonical, segment);
      }
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== canonical) throw new Error("not a real folder");
    }
  } catch {
    throw new Error("The selected account home is missing or crosses a symbolic link.");
  }
  return candidate;
}
