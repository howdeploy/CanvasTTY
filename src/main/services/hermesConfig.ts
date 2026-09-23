import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { parseDocument } from "yaml";
import {
  ORCHESTRATION_MCP_SERVER_NAME,
  ORCHESTRATION_TOOL_NAMES
} from "../../agent-browser/orchestration-catalog.mjs";
import {
  APPROVED_BROWSER_TOOL_NAMES,
  MCP_SERVER_NAME,
  canonicalStringify
} from "../../agent-browser/tool-catalog.mjs";
import { AGENT_BROWSER_ENV } from "./agent-browser/protocol.ts";
import { ORCHESTRATION_ENV } from "./agent-browser/orchestration-protocol.ts";

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIRECTORY_MODE = 0o700;
const MAX_LOCK_FILE_BYTES = 4 * 1024;
const MAX_STALE_LOCK_RETRIES = 3;
const ALLOWED_HELPER_ENVIRONMENT_KEYS = new Set(["ELECTRON_RUN_AS_NODE"]);
const RESERVED_AGENT_ENVIRONMENT_PATTERN = /^CANVASTTY_AGENT_/i;

export interface HermesStdioHelperLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface HermesTemporaryConfigurationOptions {
  homeDirectory: string;
  helper: HermesStdioHelperLaunch;
  browser?: boolean;
  /** Optional second MCP server (canvastty_agents) written next to the browser one. */
  orchestrationHelper?: HermesStdioHelperLaunch;
}

interface HermesRecoveryJournal {
  version: 1;
  ownershipId: string;
  entryHash: string;
  browserEntry?: boolean;
  /** Absent in journals written before orchestration support; never undefined when set. */
  orchestrationEntryHash?: string;
  configOriginalHash: string | null;
  configMutatedHash: string;
  mcpServersOriginallyPresent: boolean;
  backupDirectory: string;
}

interface ConfigurationLock {
  descriptor: number;
  nonce: string;
  device: number;
  inode: number;
}

interface ConfigurationLockFile {
  version: 1;
  pid: number;
  createdAt: number;
  nonce: string;
}

interface ExistingConfigurationLock {
  value: ConfigurationLockFile;
  raw: string;
  device: number;
  inode: number;
}

export class HermesTemporaryConfiguration {
  readonly hasOrchestrationEntry: boolean;
  readonly hasBrowserEntry: boolean;
  private readonly paths: ReturnType<typeof hermesPaths>;
  private readonly journal: HermesRecoveryJournal;
  private cleaned = false;

  private constructor(
    paths: ReturnType<typeof hermesPaths>,
    journal: HermesRecoveryJournal
  ) {
    this.paths = paths;
    this.journal = journal;
    this.hasBrowserEntry = journal.browserEntry !== false;
    this.hasOrchestrationEntry = journal.orchestrationEntryHash !== undefined;
  }

  static begin(options: HermesTemporaryConfigurationOptions): HermesTemporaryConfiguration {
    validateHelper(options.helper);
    if (options.orchestrationHelper) validateHelper(options.orchestrationHelper);
    mkdirSync(options.homeDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
    const paths = hermesPaths(options.homeDirectory);
    const lock = acquireLock(paths.lock);
    try {
      this.recoverLocked(paths);
      const ownershipId = randomUUID();
      const entry = options.browser !== false ? hermesMcpEntry(options.helper) : null;
      const orchestrationEntry = options.orchestrationHelper
        ? hermesOrchestrationEntry(options.orchestrationHelper)
        : null;
      const configOriginal = readOptional(paths.config);
      const { document, value } = parseHermesDocument(configOriginal ?? "", paths.config);
      const mcpServersOriginallyPresent = Object.hasOwn(value, "mcp_servers");
      const servers = mcpServers(value, paths.config);
      if (entry && MCP_SERVER_NAME in servers) {
        throw new Error(`Hermes MCP server name ${MCP_SERVER_NAME} is already configured.`);
      }
      if (orchestrationEntry && ORCHESTRATION_MCP_SERVER_NAME in servers) {
        throw new Error(`Hermes MCP server name ${ORCHESTRATION_MCP_SERVER_NAME} is already configured.`);
      }
      if (entry) document.setIn(["mcp_servers", MCP_SERVER_NAME], entry);
      if (orchestrationEntry) {
        document.setIn(["mcp_servers", ORCHESTRATION_MCP_SERVER_NAME], orchestrationEntry);
      }
      const configMutated = document.toString({ lineWidth: 0 });
      const backupDirectory = join(paths.backupRoot, ownershipId);
      mkdirSync(backupDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
      chmodSync(backupDirectory, CONFIG_DIRECTORY_MODE);
      if (configOriginal !== null) backup(paths.config, join(backupDirectory, "config.yaml"));

      const journal: HermesRecoveryJournal = {
        version: 1,
        ownershipId,
        entryHash: hashCanonical(entry),
        ...(options.browser === false ? { browserEntry: false } : {}),
        ...(orchestrationEntry ? { orchestrationEntryHash: hashCanonical(orchestrationEntry) } : {}),
        configOriginalHash: configOriginal === null ? null : hashText(configOriginal),
        configMutatedHash: hashText(configMutated),
        mcpServersOriginallyPresent,
        backupDirectory
      };
      atomicWrite(paths.journal, `${canonicalStringify(journal)}\n`);
      writeExactWithCas(paths.config, configOriginal, configMutated);
      return new HermesTemporaryConfiguration(paths, journal);
    } catch (error) {
      try {
        this.recoverLocked(paths);
      } catch {
        // Keep the journal and backup for the next safe startup recovery.
      }
      throw error;
    } finally {
      releaseLock(paths.lock, lock);
    }
  }

  static recover(homeDirectory: string): void {
    if (!existsSync(homeDirectory)) return;
    const paths = hermesPaths(homeDirectory);
    const lock = acquireLock(paths.lock);
    try {
      this.recoverLocked(paths);
    } finally {
      releaseLock(paths.lock, lock);
    }
  }

  cleanup(): void {
    if (this.cleaned) return;
    const lock = acquireLock(this.paths.lock);
    try {
      cleanupOwnedConfiguration(this.paths, this.journal);
      removeRecoveryArtifacts(this.paths, this.journal);
      this.cleaned = true;
    } finally {
      releaseLock(this.paths.lock, lock);
    }
  }

  private static recoverLocked(paths: ReturnType<typeof hermesPaths>): void {
    const raw = readOptional(paths.journal);
    if (raw === null) return;
    const journal = parseJournal(raw, paths);
    cleanupOwnedConfiguration(paths, journal);
    removeRecoveryArtifacts(paths, journal);
  }
}

export function recoverHermesConfigurationOnStartup(
  hermesHomeDirectory = resolveHermesHomeDirectory()
): void {
  HermesTemporaryConfiguration.recover(hermesHomeDirectory);
}

export function resolveHermesHomeDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome = homedir()
): string {
  const configured = environment.HERMES_HOME?.trim();
  const localAppData = environment.LOCALAPPDATA?.trim();
  const directory = configured
    || (platform === "win32"
      ? win32.join(localAppData || win32.join(userHome, "AppData", "Local"), "hermes")
      : join(userHome, ".hermes"));
  if (!isAbsolute(directory)) throw new Error("HERMES_HOME must be an absolute path.");

  let existingPath = directory;
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) throw new Error("HERMES_HOME has no accessible parent directory.");
    existingPath = parent;
  }
  if (!statSync(existingPath).isDirectory()) {
    throw new Error("HERMES_HOME must resolve beneath a directory.");
  }
  accessSync(existingPath, constants.W_OK);
  return directory;
}

export function hermesMcpEntry(helper: HermesStdioHelperLaunch): Record<string, unknown> {
  validateHelper(helper);
  const capabilityEnvironment = Object.fromEntries(
    Object.values(AGENT_BROWSER_ENV).map((key) => [key, `\${${key}}`])
  );
  return {
    command: helper.command,
    args: [...helper.args],
    env: { ...helper.env, ...capabilityEnvironment },
    enabled: true,
    trust: "full",
    tools: {
      include: [...APPROVED_BROWSER_TOOL_NAMES],
      resources: false,
      prompts: false
    }
  };
}

// Same placeholder contract as the browser entry: Hermes resolves ${VAR} from
// its own environment when launching the server, so the per-session
// orchestration capability injected into the PTY environment reaches the
// helper without baking launch-specific values into the shared config.yaml.
export function hermesOrchestrationEntry(helper: HermesStdioHelperLaunch): Record<string, unknown> {
  validateHelper(helper);
  const orchestrationEnvironment = Object.fromEntries(
    Object.values(ORCHESTRATION_ENV).map((key) => [key, `\${${key}}`])
  );
  return {
    command: helper.command,
    args: [...helper.args],
    env: { ...helper.env, ...orchestrationEnvironment },
    enabled: true,
    trust: "full",
    tools: {
      include: [...ORCHESTRATION_TOOL_NAMES],
      resources: false,
      prompts: false
    }
  };
}

function cleanupOwnedConfiguration(
  paths: ReturnType<typeof hermesPaths>,
  journal: HermesRecoveryJournal
): void {
  const current = readOptional(paths.config);
  if (current === null) return;
  if (hashText(current) === journal.configMutatedHash) {
    restoreOriginal(
      paths.config,
      journal.configOriginalHash,
      join(journal.backupDirectory, "config.yaml")
    );
    return;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = readOptional(paths.config);
    if (before === null) return;
    const { document, value } = parseHermesDocument(before, paths.config);
    const servers = mcpServers(value, paths.config);
    const ownedEntries: Array<[string, string]> = journal.browserEntry === false ? [] : [[MCP_SERVER_NAME, journal.entryHash]];
    if (journal.orchestrationEntryHash) {
      ownedEntries.push([ORCHESTRATION_MCP_SERVER_NAME, journal.orchestrationEntryHash]);
    }
    let ownedCount = 0;
    for (const [name, expectedHash] of ownedEntries) {
      const owned = servers[name];
      if (owned === undefined) continue;
      if (hashCanonical(owned) !== expectedHash) {
        throw new Error("CanvasTTY Hermes MCP configuration ownership changed before cleanup.");
      }
      ownedCount += 1;
    }
    if (ownedCount === 0) return;
    for (const [name] of ownedEntries) {
      document.deleteIn(["mcp_servers", name]);
    }
    if (!journal.mcpServersOriginallyPresent && Object.keys(servers).length === ownedCount) {
      document.delete("mcp_servers");
    }
    const next = document.toString({ lineWidth: 0 });
    if (readOptional(paths.config) !== before) continue;
    atomicWrite(paths.config, next, existingMode(paths.config));
    return;
  }
  throw new Error(`Hermes configuration changed concurrently: ${paths.config}`);
}

function parseHermesDocument(raw: string, path: string) {
  let document = parseDocument(raw, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Hermes YAML configuration is invalid: ${path}`);
  }
  let value = document.toJS({ maxAliasCount: 100 }) as unknown;
  if (value === null || value === undefined) {
    value = {};
    document = parseDocument("{}\n", { strict: true, uniqueKeys: true });
  }
  if (!isRecord(value)) throw new Error(`Hermes YAML configuration must be an object: ${path}`);
  return { document, value };
}

function mcpServers(value: Record<string, unknown>, path: string): Record<string, unknown> {
  if (!("mcp_servers" in value)) return {};
  const servers = value.mcp_servers;
  if (!isRecord(servers)) {
    throw new Error(`Hermes YAML configuration has an invalid mcp_servers object: ${path}`);
  }
  return servers;
}

function parseJournal(
  raw: string,
  paths: ReturnType<typeof hermesPaths>
): HermesRecoveryJournal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("CanvasTTY Hermes recovery journal is invalid.");
  }
  if (
    !isRecord(value)
    || value.version !== 1
    || typeof value.ownershipId !== "string"
    || typeof value.entryHash !== "string"
    || (value.browserEntry !== undefined && typeof value.browserEntry !== "boolean")
    || (value.orchestrationEntryHash !== undefined && typeof value.orchestrationEntryHash !== "string")
    || (value.configOriginalHash !== null && typeof value.configOriginalHash !== "string")
    || typeof value.configMutatedHash !== "string"
    || typeof value.mcpServersOriginallyPresent !== "boolean"
    || typeof value.backupDirectory !== "string"
  ) throw new Error("CanvasTTY Hermes recovery journal is invalid.");
  if (!/^[0-9a-f-]{36}$/i.test(value.ownershipId)) {
    throw new Error("CanvasTTY Hermes recovery journal ownership is invalid.");
  }
  if (value.backupDirectory !== join(paths.backupRoot, value.ownershipId)) {
    throw new Error("CanvasTTY Hermes recovery journal backup path is invalid.");
  }
  return value as unknown as HermesRecoveryJournal;
}

function restoreOriginal(path: string, originalHash: string | null, backupPath: string): void {
  if (originalHash === null) {
    unlinkIfExists(path);
    return;
  }
  const backupContent = readOptional(backupPath);
  if (backupContent === null || hashText(backupContent) !== originalHash) {
    throw new Error("CanvasTTY Hermes configuration backup is unavailable or invalid.");
  }
  atomicWrite(path, backupContent, existingMode(path));
}

function removeRecoveryArtifacts(
  paths: ReturnType<typeof hermesPaths>,
  journal: HermesRecoveryJournal
): void {
  unlinkIfExists(paths.journal);
  unlinkIfExists(join(journal.backupDirectory, "config.yaml"));
  removeEmptyDirectory(journal.backupDirectory);
  removeEmptyDirectory(paths.backupRoot);
}

function hermesPaths(homeDirectory: string) {
  return {
    config: join(homeDirectory, "config.yaml"),
    lock: join(homeDirectory, ".canvastty-hermes-browser.lock"),
    journal: join(homeDirectory, ".canvastty-hermes-browser-recovery.json"),
    backupRoot: join(homeDirectory, ".canvastty-hermes-browser-backups")
  };
}

function acquireLock(path: string): ConfigurationLock {
  for (let attempt = 0; attempt < MAX_STALE_LOCK_RETRIES; attempt += 1) {
    try {
      return createLock(path);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      const existing = readExistingLock(path);
      if (lockOwnerState(existing.value.pid) === "live") {
        throw new Error("Another CanvasTTY process is updating Hermes configuration.");
      }
      if (!unlinkDeadLock(path, existing)) continue;
    }
  }
  throw new Error("CanvasTTY could not acquire the Hermes configuration lock safely.");
}

function createLock(path: string): ConfigurationLock {
  const descriptor = openSync(path, "wx", CONFIG_FILE_MODE);
  const identity = fstatSync(descriptor);
  const nonce = randomBytes(16).toString("hex");
  try {
    writeFileSync(descriptor, `${canonicalStringify({
      version: 1,
      pid: process.pid,
      createdAt: Date.now(),
      nonce
    })}\n`, "utf8");
    fsyncSync(descriptor);
    return { descriptor, nonce, device: identity.dev, inode: identity.ino };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readExistingLock(path: string): ExistingConfigurationLock {
  let descriptor: number | null = null;
  try {
    const pathIdentity = lstatSync(path);
    if (!pathIdentity.isFile() || pathIdentity.isSymbolicLink() || pathIdentity.size > MAX_LOCK_FILE_BYTES) {
      throw invalidLockError();
    }
    descriptor = openSync(path, "r");
    const descriptorIdentity = fstatSync(descriptor);
    if (
      !descriptorIdentity.isFile()
      || descriptorIdentity.size > MAX_LOCK_FILE_BYTES
      || descriptorIdentity.dev !== pathIdentity.dev
      || descriptorIdentity.ino !== pathIdentity.ino
    ) throw invalidLockError();
    const raw = readFileSync(descriptor, "utf8");
    const finalIdentity = lstatSync(path);
    if (
      !finalIdentity.isFile()
      || finalIdentity.isSymbolicLink()
      || finalIdentity.dev !== descriptorIdentity.dev
      || finalIdentity.ino !== descriptorIdentity.ino
    ) throw changedLockError();
    return {
      value: parseLockFile(raw),
      raw,
      device: descriptorIdentity.dev,
      inode: descriptorIdentity.ino
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw changedLockError();
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseLockFile(raw: string): ConfigurationLockFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidLockError();
  }
  if (!isRecord(value)) throw invalidLockError();
  if (
    Reflect.ownKeys(value).length !== 4
    || value.version !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.createdAt !== "number"
    || !Number.isFinite(value.createdAt)
    || typeof value.nonce !== "string"
    || !/^[0-9a-f]{32}$/iu.test(value.nonce)
  ) throw invalidLockError();
  return value as unknown as ConfigurationLockFile;
}

function lockOwnerState(pid: number): "live" | "dead" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (hasErrorCode(error, "EPERM")) return "live";
    if (hasErrorCode(error, "ESRCH")) return "dead";
    throw new Error("CanvasTTY Hermes configuration lock owner status is ambiguous.");
  }
}

function unlinkDeadLock(path: string, existing: ExistingConfigurationLock): boolean {
  try {
    const current = readExistingLock(path);
    if (
      current.device !== existing.device
      || current.inode !== existing.inode
      || current.raw !== existing.raw
    ) throw changedLockError();
    unlinkSync(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function releaseLock(path: string, lock: ConfigurationLock): void {
  let descriptorClosed = false;
  try {
    assertLockOwnership(path, lock);
    closeSync(lock.descriptor);
    descriptorClosed = true;
    assertLockOwnership(path, lock);
    unlinkSync(path);
  } finally {
    if (!descriptorClosed) closeSync(lock.descriptor);
  }
}

function assertLockOwnership(path: string, lock: ConfigurationLock): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("CanvasTTY Hermes configuration lock ownership cannot be verified.");
  }
  const identity = statSync(path);
  if (
    !isRecord(value)
    || value.version !== 1
    || value.nonce !== lock.nonce
    || identity.dev !== lock.device
    || identity.ino !== lock.inode
  ) throw new Error("CanvasTTY Hermes configuration lock ownership changed before release.");
}

function invalidLockError(): Error {
  return new Error("CanvasTTY Hermes configuration lock is invalid or foreign.");
}

function changedLockError(): Error {
  return new Error("CanvasTTY Hermes configuration lock changed during stale recovery.");
}

function writeExactWithCas(path: string, expected: string | null, next: string): void {
  if (readOptional(path) !== expected) throw new Error(`Hermes configuration changed concurrently: ${path}`);
  atomicWrite(path, next, existingMode(path));
}

function backup(source: string, destination: string): void {
  copyFileSync(source, destination);
  chmodSync(destination, CONFIG_FILE_MODE);
}

function atomicWrite(path: string, content: string, mode = CONFIG_FILE_MODE): void {
  mkdirSync(dirname(path), { recursive: true, mode: CONFIG_DIRECTORY_MODE });
  const temporary = `${path}.canvastty-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
  chmodSync(temporary, mode);
  try {
    renameSync(temporary, path);
    chmodSync(path, mode);
  } catch (error) {
    unlinkIfExists(temporary);
    throw error;
  }
}

function existingMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return CONFIG_FILE_MODE;
    throw error;
  }
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTEMPTY")) throw error;
  }
}

function validateHelper(helper: HermesStdioHelperLaunch): void {
  if (!helper || typeof helper !== "object" || !helper.command || !Array.isArray(helper.args)) {
    throw new Error("CanvasTTY browser helper configuration is invalid.");
  }
  if (!helper.args.every((argument) => typeof argument === "string")) {
    throw new Error("CanvasTTY browser helper arguments are invalid.");
  }
  if (helper.env === undefined) return;
  if (!isRecord(helper.env)) throw new Error("CanvasTTY browser helper environment is invalid.");
  for (const [key, value] of Object.entries(helper.env)) {
    if (RESERVED_AGENT_ENVIRONMENT_PATTERN.test(key)) {
      throw new Error(`CanvasTTY browser helper environment cannot set reserved key: ${key}`);
    }
    if (!ALLOWED_HELPER_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(`CanvasTTY browser helper environment key is not allowed: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`CanvasTTY browser helper environment value is invalid: ${key}`);
    }
  }
}

function hashCanonical(value: unknown): string {
  return hashText(canonicalStringify(value));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
