import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CodexAppServerClient, CodexAppServerError } from "./CodexAppServerClient.ts";
import type { ProviderCliRegistry } from "./providerCliRegistry.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Windows Codex uses the OS account home even when a Unix-like shell exports HOME. */
export function codexAppServerCwd(
  environment: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform
): string {
  const candidates = platform === "win32" ? [userInfo().homedir]
    : [environment.HOME, environment.CODEX_HOME, homedir(), userInfo().homedir];
  for (const directory of candidates) {
    if (!directory || !isAbsolute(directory)) continue;
    try { if (statSync(directory).isDirectory()) return directory; } catch { /* Try another verified directory. */ }
  }
  throw new Error("Codex app-server working directory is unavailable.");
}

/** Create before any sandbox starts so Linux can mount an unreadable directory over it. */
export async function prepareCodexTrustBackups(userDataPath: string): Promise<string> {
  const directory = join(userDataPath, "codex-config-backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

// New plugin profiles may not exist yet; resolve through their nearest existing ancestor.
async function canonicalConfigPath(file: string): Promise<string> {
  try { return await realpath(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(file);
    if (parent === file) throw error;
    return join(await canonicalConfigPath(parent), basename(file));
  }
}

function profileConfig(environment: Readonly<Record<string, string | undefined>>): string {
  const value = (name: string): string | undefined => process.platform === "win32"
    ? Object.entries(environment).reverse().find(([key]) => key.toUpperCase() === name)?.[1]
    : environment[name];
  // Codex's dirs::home_dir uses HOME on Unix and the OS account profile on Windows.
  const home = value("CODEX_HOME") || join(
    (process.platform === "win32" ? undefined : value("HOME")) || userInfo().homedir, ".codex"
  );
  if (!isAbsolute(home)) throw new Error("Codex profile path must be absolute.");
  return join(home, "config.toml");
}

/** Compare the actual config file, including explicit overrides and symlink aliases. */
export async function usesLocalCodexConfig(
  baseEnvironment: Readonly<Record<string, string | undefined>>,
  launchEnvironment: Readonly<Record<string, string | undefined>>
): Promise<boolean> {
  return await canonicalConfigPath(profileConfig(baseEnvironment))
    === await canonicalConfigPath(profileConfig(launchEnvironment));
}

/** One restore batch shares checks and stops retrying a broken local app-server. */
export function batchCodexRestoreTrust(check: (cwd: string) => Promise<void>): (cwd: string) => Promise<void> {
  const checks = new Map<string, Promise<void>>();
  let transportFailure: CodexAppServerError | undefined;
  return async (cwd) => {
    if (transportFailure) throw transportFailure;
    const key = await realpath(cwd);
    if (transportFailure) throw transportFailure;
    let pending = checks.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => check(cwd)).catch((error: unknown) => {
        if (error instanceof CodexAppServerError) transportFailure = error;
        throw error;
      });
      checks.set(key, pending);
    }
    return pending;
  };
}

// Canonical profile paths also coalesce launches made through symlinked CODEX_HOME aliases.
const profileTrustWrites = new Map<string, Promise<void>>();

async function serializeTrust(file: string, operation: () => Promise<void>): Promise<void> {
  const previous = profileTrustWrites.get(file) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  profileTrustWrites.set(file, current);
  try { await current; } finally {
    if (profileTrustWrites.get(file) === current) profileTrustWrites.delete(file);
  }
}

/** Host-only, called from person-authenticated IPC, never a terminal or agent gateway. */
export async function ensureCodexFolderTrust(options: {
  providerClis: ProviderCliRegistry;
  clientVersion: string;
  cwd: string;
  backupDirectory: string;
  confirm(folder: string): Promise<boolean>;
}): Promise<void> {
  const folder = await realpath(options.cwd);
  if (!(await stat(folder)).isDirectory()) throw new Error("Project folder is not a directory.");
  const cli = options.providerClis.get("codex");
  if (cli.state !== "available") throw new Error("Codex CLI is unavailable.");
  const environment = { ...process.env, ...cli.environment };
  const requestedFile = profileConfig(environment);
  const file = await canonicalConfigPath(requestedFile);
  await serializeTrust(file, async () => {
    // Codex requires an explicit CODEX_HOME to exist, including on the person's first launch.
    await mkdir(dirname(requestedFile), { recursive: true, mode: 0o700 });
    if (await canonicalConfigPath(requestedFile) !== file) throw new Error("Codex profile changed before trust could be read.");
    const client = new CodexAppServerClient(cli, options.clientVersion, 1_000, codexAppServerCwd(environment));
    try {
      // Do not load the new project's settings before the person has trusted it.
      const response = await client.call("config/read", { includeLayers: true });
      if (!record(response) || !Array.isArray(response.layers)) throw new Error("Codex returned no configuration layers.");
      let layer: Record<string, unknown> | undefined;
      for (const entry of response.layers) {
        if (record(entry) && record(entry.name) && entry.name.type === "user" && !entry.name.profile
          && typeof entry.name.file === "string" && isAbsolute(entry.name.file)
          && await canonicalConfigPath(entry.name.file) === file) {
          layer = entry;
          break;
        }
      }
      // Older app-servers serialize a layer as JSON, including "{}" for an empty profile.
      let config = layer?.config;
      if (typeof config === "string") {
        try { config = JSON.parse(config); } catch { config = null; }
      }
      if (!layer || !record(config) || typeof layer.version !== "string") {
        throw new Error("Codex user configuration could not be identified safely.");
      }
      const projects = config.projects;
      // Exact folder only: a new folder is never silently trusted because a sibling was accepted.
      if (record(projects) && record(projects[folder]) && projects[folder].trust_level === "trusted") return;
      if (!await options.confirm(folder)) throw new Error("Folder trust was not granted. Session was not started.");
      if (await realpath(options.cwd) !== folder) throw new Error("Project folder changed while awaiting trust.");
      if (await canonicalConfigPath(requestedFile) !== file) throw new Error("Codex profile changed while awaiting trust.");
      // Private, unique backup of the current file; Codex's version check refuses a concurrent edit.
      let original: Buffer | null;
      try { original = await readFile(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        original = null;
      }
      if (original !== null) {
        await mkdir(options.backupDirectory, { recursive: true, mode: 0o700 });
        await writeFile(join(options.backupDirectory, `${randomUUID()}.toml`), original, { flag: "wx", mode: 0o600 });
      }
      await client.call("config/batchWrite", {
        filePath: file,
        expectedVersion: layer.version,
        edits: [{ keyPath: `projects.${JSON.stringify(folder)}.trust_level`, value: "trusted", mergeStrategy: "upsert" }]
      });
    } finally {
      client.dispose();
    }
  });
}
