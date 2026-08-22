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
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  APPROVED_BROWSER_TOOL_NAMES,
  MCP_SERVER_NAME,
  canonicalStringify
} from "../../../agent-browser/tool-catalog.mjs";
import { AGENT_BROWSER_ENV, type AgentProvider } from "./protocol.ts";
import {
  HermesTemporaryConfiguration,
  resolveHermesHomeDirectory
} from "../hermesConfig.ts";
import { openCodeBrowserEnvironment } from "../openCodeConfig.ts";
import {
  providerChildProcessLaunch,
  type AvailableProviderCli,
  type ProviderCliRegistry,
  type ProviderCliResolution
} from "../providerCliRegistry.ts";

const KIMI_RULE_PATTERN = `mcp__${MCP_SERVER_NAME}__*`;
const CLAUDE_RULE_PATTERN = `mcp__${MCP_SERVER_NAME}__*`;
const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIRECTORY_MODE = 0o700;
const ALLOWED_HELPER_ENVIRONMENT_KEYS = new Set(["ELECTRON_RUN_AS_NODE"]);
const RESERVED_AGENT_ENVIRONMENT_PATTERN = /^CANVASTTY_AGENT_/i;

export interface StdioHelperLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface PreparedProviderLaunch {
  args: string[];
  environment: Record<string, string>;
  releaseConfiguration(): void;
}

export interface ProviderLaunchOptions {
  helper: StdioHelperLaunch;
  providerClis: ProviderCliRegistry;
  hermesHomeDirectory?: string;
  kimiHomeDirectory?: string;
  runtimeDirectory: string;
  probeKimiPerRunConfig?: (cli: AvailableProviderCli) => boolean;
  environment?: Readonly<Record<string, string | undefined>>;
}

interface ConfigurationLockHooks {
  beforeReclaim?(path: string, nonce: string): void;
  beforeRelease?(path: string, nonce: string): void;
}

export class ProviderLaunchAdapters {
  private readonly options: ProviderLaunchOptions;
  private readonly providerClis: ProviderCliRegistry;
  private readonly hermesHomeDirectory: string;
  private readonly kimiHomeDirectory: string;
  private readonly kimiCli: ProviderCliResolution;
  private readonly probe: (cli: AvailableProviderCli) => boolean;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private kimiSupportsPerRunConfig: boolean | null = null;
  private kimiConfiguration: KimiTemporaryConfiguration | null = null;
  private kimiConfigurationUsers = 0;
  private hermesConfiguration: HermesTemporaryConfiguration | null = null;
  private hermesConfigurationUsers = 0;

  constructor(options: ProviderLaunchOptions) {
    validateStdioHelperLaunch(options.helper);
    this.options = options;
    this.providerClis = options.providerClis;
    this.hermesHomeDirectory = options.hermesHomeDirectory ?? resolveHermesHomeDirectory();
    this.kimiHomeDirectory = validateKimiHomeDirectory(
      options.kimiHomeDirectory ?? join(homedir(), ".kimi-code")
    );
    this.kimiCli = options.providerClis.get("kimi");
    this.probe = options.probeKimiPerRunConfig ?? probeKimiPerRunMcpConfig;
    this.environment = options.environment ?? process.env;
  }

  prepare(provider: AgentProvider, connectionId: string): PreparedProviderLaunch {
    const providerCli = this.providerClis.get(provider);
    if (providerCli.state === "unavailable") throw new Error(providerCli.diagnostic);
    if (provider === "claude") {
      return {
        args: claudeMcpArgs(this.options.helper),
        environment: {},
        releaseConfiguration() {}
      };
    }
    if (provider === "codex") {
      return {
        args: codexMcpArgs(this.options.helper),
        environment: {},
        releaseConfiguration() {}
      };
    }
    if (provider === "opencode") {
      return {
        args: [],
        environment: openCodeBrowserEnvironment(this.options.helper, this.environment),
        releaseConfiguration() {}
      };
    }
    if (provider === "hermes") {
      return {
        args: [],
        environment: {},
        releaseConfiguration: this.acquireHermesConfiguration()
      };
    }
    return this.prepareKimi(connectionId);
  }

  recoverKimiConfiguration(): void {
    KimiTemporaryConfiguration.recover(this.kimiHomeDirectory);
  }

  recoverHermesConfiguration(): void {
    HermesTemporaryConfiguration.recover(this.hermesHomeDirectory);
  }

  private acquireHermesConfiguration(): () => void {
    if (!this.hermesConfiguration) {
      this.hermesConfiguration = HermesTemporaryConfiguration.begin({
        homeDirectory: this.hermesHomeDirectory,
        helper: this.options.helper
      });
    }
    this.hermesConfigurationUsers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.hermesConfigurationUsers -= 1;
      if (this.hermesConfigurationUsers !== 0) return;
      const configuration = this.hermesConfiguration;
      this.hermesConfiguration = null;
      configuration?.cleanup();
    };
  }

  private prepareKimi(connectionId: string): PreparedProviderLaunch {
    if (this.kimiCli.state === "unavailable") throw new Error(this.kimiCli.diagnostic);
    if (this.kimiSupportsPerRunConfig === null) {
      this.kimiSupportsPerRunConfig = this.probe(this.kimiCli);
      KimiTemporaryConfiguration.recover(this.kimiHomeDirectory);
    }
    const supportsPerRun = this.kimiSupportsPerRunConfig;
    const releaseShared = this.acquireKimiConfiguration(!supportsPerRun);
    let perRunPath: string | null = null;

    try {
      const args: string[] = [];
      if (supportsPerRun) {
        mkdirSync(this.options.runtimeDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
        chmodSync(this.options.runtimeDirectory, CONFIG_DIRECTORY_MODE);
        perRunPath = join(this.options.runtimeDirectory, `kimi-mcp-${safeId(connectionId)}.json`);
        atomicWrite(perRunPath, `${JSON.stringify(mcpDocument(this.options.helper), null, 2)}\n`);
        args.push("--mcp-config-file", perRunPath);
      }
      let released = false;
      return {
        args,
        environment: {},
        releaseConfiguration: () => {
          if (released) return;
          released = true;
          if (perRunPath) unlinkIfExists(perRunPath);
          releaseShared();
        }
      };
    } catch (error) {
      if (perRunPath) unlinkIfExists(perRunPath);
      releaseShared();
      throw error;
    }
  }

  private acquireKimiConfiguration(includeMcpEntry: boolean): () => void {
    if (!this.kimiConfiguration) {
      this.kimiConfiguration = KimiTemporaryConfiguration.begin({
        homeDirectory: this.kimiHomeDirectory,
        helper: this.options.helper,
        includeMcpEntry
      });
    } else if (this.kimiConfiguration.includeMcpEntry !== includeMcpEntry) {
      throw new Error("Kimi MCP capability changed while temporary configuration is active.");
    }
    this.kimiConfigurationUsers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.kimiConfigurationUsers -= 1;
      if (this.kimiConfigurationUsers !== 0) return;
      const configuration = this.kimiConfiguration;
      this.kimiConfiguration = null;
      configuration?.cleanup();
    };
  }
}

export function claudeMcpArgs(helper: StdioHelperLaunch): string[] {
  validateStdioHelperLaunch(helper);
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: helper.command,
        args: helper.args,
        ...(helper.env && Object.keys(helper.env).length > 0 ? { env: helper.env } : {})
      }
    }
  };
  return [
    "--mcp-config",
    canonicalStringify(config),
    "--allowedTools",
    CLAUDE_RULE_PATTERN
  ];
}

export function codexMcpArgs(helper: StdioHelperLaunch): string[] {
  validateStdioHelperLaunch(helper);
  const prefix = `mcp_servers.${MCP_SERVER_NAME}`;
  const table = [
    `command=${tomlString(helper.command)}`,
    `args=${tomlStringArray(helper.args)}`,
    `env=${tomlStringTable(helper.env ?? {})}`,
    `env_vars=${tomlStringArray(Object.values(AGENT_BROWSER_ENV))}`,
    "enabled=true",
    "required=true",
    'default_tools_approval_mode="approve"',
    `enabled_tools=${tomlStringArray([...APPROVED_BROWSER_TOOL_NAMES])}`,
    "disabled_tools=[]"
  ].join(",");
  return ["-c", `${prefix}={${table}}`];
}

export function probeKimiPerRunMcpConfig(cli: AvailableProviderCli): boolean {
  const launch = providerChildProcessLaunch(cli, ["--help"]);
  const result = spawnSync(launch.command, launch.args, {
    encoding: "utf8",
    env: { ...process.env, ...launch.environment },
    timeout: 3_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  });
  if (result.error || result.status !== 0) return false;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes("--mcp-config-file");
}

export function recoverKimiConfigurationOnStartup(
  kimiHomeDirectory = join(homedir(), ".kimi-code")
): void {
  KimiTemporaryConfiguration.recover(kimiHomeDirectory);
}

export function resolveKimiHomeDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configured = environment.KIMI_CODE_HOME;
  const directory = configured && configured.trim().length > 0
    ? configured
    : join(homedir(), ".kimi-code");
  return validateKimiHomeDirectory(directory);
}

function validateKimiHomeDirectory(directory: string): string {
  if (!isAbsolute(directory)) {
    throw new Error("KIMI_CODE_HOME must be an absolute path.");
  }

  let existingPath = directory;
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) {
      throw new Error("KIMI_CODE_HOME has no accessible parent directory.");
    }
    existingPath = parent;
  }
  if (!statSync(existingPath).isDirectory()) {
    throw new Error("KIMI_CODE_HOME must resolve beneath a directory.");
  }
  accessSync(existingPath, constants.W_OK);
  return directory;
}

interface KimiTemporaryConfigurationOptions {
  homeDirectory: string;
  helper: StdioHelperLaunch;
  includeMcpEntry: boolean;
  lockHooks?: ConfigurationLockHooks;
}

interface RecoveryJournal {
  version: 1;
  ownershipId: string;
  includeMcpEntry: boolean;
  mcpEntryHash: string;
  mcpOriginalHash: string | null;
  mcpMutatedHash: string | null;
  configOriginalHash: string | null;
  configMutatedHash: string;
  backupDirectory: string;
}

export class KimiTemporaryConfiguration {
  readonly includeMcpEntry: boolean;
  private readonly paths: ReturnType<typeof kimiPaths>;
  private readonly journal: RecoveryJournal;
  private cleaned = false;

  private constructor(paths: ReturnType<typeof kimiPaths>, journal: RecoveryJournal) {
    this.paths = paths;
    this.journal = journal;
    this.includeMcpEntry = journal.includeMcpEntry;
  }

  static begin(options: KimiTemporaryConfigurationOptions): KimiTemporaryConfiguration {
    validateStdioHelperLaunch(options.helper);
    mkdirSync(options.homeDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
    const paths = kimiPaths(options.homeDirectory);
    const lock = acquireLock(paths.lock, options.lockHooks);
    try {
      this.recoverLocked(paths);
      const ownershipId = randomUUID();
      const entry = mcpEntry(options.helper);
      const mcpOriginal = options.includeMcpEntry ? readOptional(paths.mcp) : null;
      const configOriginal = readOptional(paths.config);
      let mcpMutated: string | null = null;
      if (options.includeMcpEntry) {
        const document = mcpOriginal === null ? {} : parseJsonObject(mcpOriginal, paths.mcp);
        const servers = asMcpServers(document);
        if (MCP_SERVER_NAME in servers) {
          throw new Error(`Kimi MCP server name ${MCP_SERVER_NAME} is already configured.`);
        }
        mcpMutated = `${JSON.stringify({
          ...document,
          mcpServers: { ...servers, [MCP_SERVER_NAME]: entry }
        }, null, 2)}\n`;
      }
      const configBase = configOriginal ?? "";
      const configSeparator = configBase.length === 0 || configBase.endsWith("\n") ? "" : "\n";
      const configMutated = `${configBase}${configSeparator}${permissionRuleBlock(ownershipId)}`;
      const backupDirectory = join(paths.backupRoot, ownershipId);
      mkdirSync(backupDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
      chmodSync(backupDirectory, CONFIG_DIRECTORY_MODE);
      if (options.includeMcpEntry && mcpOriginal !== null) {
        backup(paths.mcp, join(backupDirectory, "mcp.json"));
      }
      if (configOriginal !== null) backup(paths.config, join(backupDirectory, "config.toml"));

      const journal: RecoveryJournal = {
        version: 1,
        ownershipId,
        includeMcpEntry: options.includeMcpEntry,
        mcpEntryHash: hashCanonical(entry),
        mcpOriginalHash: mcpOriginal === null ? null : hashText(mcpOriginal),
        mcpMutatedHash: mcpMutated === null ? null : hashText(mcpMutated),
        configOriginalHash: configOriginal === null ? null : hashText(configOriginal),
        configMutatedHash: hashText(configMutated),
        backupDirectory
      };
      atomicWrite(paths.journal, `${canonicalStringify(journal)}\n`);

      if (mcpMutated !== null) writeExactWithCas(paths.mcp, mcpOriginal, mcpMutated);
      writeExactWithCas(paths.config, configOriginal, configMutated);
      return new KimiTemporaryConfiguration(paths, journal);
    } catch (error) {
      try {
        this.recoverLocked(paths);
      } catch {
        // Keep the recovery journal and backups for the next safe startup.
      }
      throw error;
    } finally {
      try {
        options.lockHooks?.beforeRelease?.(paths.lock, lock.nonce);
      } catch (error) {
        releaseLock(paths.lock, lock);
        throw error;
      }
      releaseLock(paths.lock, lock);
    }
  }

  static recover(homeDirectory: string): void {
    if (!existsSync(homeDirectory)) return;
    const paths = kimiPaths(homeDirectory);
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
      cleanupOwnedChanges(this.paths, this.journal);
      removeRecoveryArtifacts(this.paths, this.journal);
      this.cleaned = true;
    } finally {
      releaseLock(this.paths.lock, lock);
    }
  }

  private static recoverLocked(paths: ReturnType<typeof kimiPaths>): void {
    const raw = readOptional(paths.journal);
    if (raw === null) return;
    const journal = parseJournal(raw, paths);
    cleanupOwnedChanges(paths, journal);
    removeRecoveryArtifacts(paths, journal);
  }
}

function mcpDocument(helper: StdioHelperLaunch): Record<string, unknown> {
  return { mcpServers: { [MCP_SERVER_NAME]: mcpEntry(helper) } };
}

function mcpEntry(helper: StdioHelperLaunch): Record<string, unknown> {
  return {
    transport: "stdio",
    command: helper.command,
    args: helper.args,
    ...(helper.env && Object.keys(helper.env).length > 0 ? { env: helper.env } : {}),
    enabled: true,
    enabledTools: [...APPROVED_BROWSER_TOOL_NAMES]
  };
}

function permissionRuleBlock(ownershipId: string): string {
  return [
    `# CanvasTTY temporary browser permission begin: ${ownershipId}`,
    "[[permission.rules]]",
    'decision = "allow"',
    'scope = "user"',
    `pattern = ${tomlString(KIMI_RULE_PATTERN)}`,
    'reason = "Temporary CanvasTTY browser tools for this launched agent"',
    `# CanvasTTY temporary browser permission end: ${ownershipId}`,
    ""
  ].join("\n");
}

function cleanupOwnedChanges(paths: ReturnType<typeof kimiPaths>, journal: RecoveryJournal): void {
  const configBeforeCleanup = readOptional(paths.config);
  if (
    configBeforeCleanup !== null
    && hashText(configBeforeCleanup) !== journal.configMutatedHash
  ) {
    // Validate ownership markers before changing mcp.json. If the marker block is
    // partial or ambiguous, retain every recovery artifact for manual recovery.
    removeOwnedRuleBlock(configBeforeCleanup, journal.ownershipId);
  }
  if (journal.includeMcpEntry && existsSync(paths.mcp)) {
    const current = readOptional(paths.mcp);
    if (current !== null && journal.mcpMutatedHash && hashText(current) === journal.mcpMutatedHash) {
      restoreOriginal(paths.mcp, journal.mcpOriginalHash, join(journal.backupDirectory, "mcp.json"));
    } else {
      mutateJsonWithCas(paths.mcp, (document) => {
        const servers = asMcpServers(document);
        const owned = servers[MCP_SERVER_NAME];
        if (owned === undefined || hashCanonical(owned) !== journal.mcpEntryHash) return document;
        const nextServers = { ...servers };
        delete nextServers[MCP_SERVER_NAME];
        return { ...document, mcpServers: nextServers };
      });
    }
  }
  if (existsSync(paths.config)) {
    const current = readOptional(paths.config);
    if (current !== null && hashText(current) === journal.configMutatedHash) {
      restoreOriginal(paths.config, journal.configOriginalHash, join(journal.backupDirectory, "config.toml"));
    } else {
      mutateTextWithCas(paths.config, (value) => removeOwnedRuleBlock(value, journal.ownershipId));
    }
  }
}

function removeOwnedRuleBlock(value: string, ownershipId: string): string {
  const begin = `# CanvasTTY temporary browser permission begin: ${ownershipId}`;
  const end = `# CanvasTTY temporary browser permission end: ${ownershipId}`;
  const starts = findAllOccurrences(value, begin);
  const ends = findAllOccurrences(value, end);
  if (starts.length === 0 && ends.length === 0) return value;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0] + begin.length) {
    throw new Error("CanvasTTY Kimi permission markers are incomplete or ambiguous.");
  }
  const start = starts[0];
  const endStart = ends[0];
  const endLine = value.indexOf("\n", endStart + end.length);
  return `${value.slice(0, start)}${value.slice(endLine === -1 ? value.length : endLine + 1)}`;
}

function findAllOccurrences(value: string, pattern: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (offset <= value.length - pattern.length) {
    const found = value.indexOf(pattern, offset);
    if (found === -1) break;
    offsets.push(found);
    offset = found + pattern.length;
  }
  return offsets;
}

function restoreOriginal(path: string, originalHash: string | null, backupPath: string): void {
  if (originalHash === null) {
    unlinkIfExists(path);
    return;
  }
  const backupContent = readOptional(backupPath);
  if (backupContent === null || hashText(backupContent) !== originalHash) {
    throw new Error("CanvasTTY Kimi configuration backup is unavailable or invalid.");
  }
  atomicWrite(path, backupContent, existingMode(path));
}

function removeRecoveryArtifacts(paths: ReturnType<typeof kimiPaths>, journal: RecoveryJournal): void {
  unlinkIfExists(paths.journal);
  unlinkIfExists(join(journal.backupDirectory, "mcp.json"));
  unlinkIfExists(join(journal.backupDirectory, "config.toml"));
  removeEmptyDirectory(journal.backupDirectory);
  removeEmptyDirectory(paths.backupRoot);
}

function mutateJsonWithCas(
  path: string,
  transform: (document: Record<string, unknown>) => Record<string, unknown>
): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = readOptional(path);
    const document = before === null ? {} : parseJsonObject(before, path);
    const next = transform(document);
    if (next === document) return;
    if (readOptional(path) !== before) continue;
    atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`, existingMode(path));
    return;
  }
  throw new Error(`Kimi configuration changed concurrently: ${path}`);
}

function mutateTextWithCas(path: string, transform: (current: string) => string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = readOptional(path) ?? "";
    const next = transform(before);
    if (next === before) return;
    const current = readOptional(path) ?? "";
    if (current !== before) continue;
    atomicWrite(path, next, existingMode(path));
    return;
  }
  throw new Error(`Kimi configuration changed concurrently: ${path}`);
}

function writeExactWithCas(path: string, expected: string | null, next: string): void {
  if (readOptional(path) !== expected) throw new Error(`Kimi configuration changed concurrently: ${path}`);
  atomicWrite(path, next, existingMode(path));
}

function asMcpServers(document: Record<string, unknown>): Record<string, unknown> {
  if (!("mcpServers" in document)) return {};
  const servers = document.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("Kimi mcp.json has an invalid mcpServers object.");
  }
  return servers as Record<string, unknown>;
}

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Kimi JSON configuration is invalid: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Kimi JSON configuration must be an object: ${path}`);
  }
  return value as Record<string, unknown>;
}

function parseJournal(raw: string, paths: ReturnType<typeof kimiPaths>): RecoveryJournal {
  const value = parseJsonObject(raw, "CanvasTTY recovery journal");
  if (
    value.version !== 1
    || typeof value.ownershipId !== "string"
    || typeof value.includeMcpEntry !== "boolean"
    || typeof value.mcpEntryHash !== "string"
    || (value.mcpMutatedHash !== null && typeof value.mcpMutatedHash !== "string")
    || typeof value.configMutatedHash !== "string"
    || typeof value.backupDirectory !== "string"
  ) throw new Error("CanvasTTY Kimi recovery journal is invalid.");
  if (!/^[0-9a-f-]{36}$/i.test(value.ownershipId)) {
    throw new Error("CanvasTTY Kimi recovery journal ownership is invalid.");
  }
  if (value.backupDirectory !== join(paths.backupRoot, value.ownershipId)) {
    throw new Error("CanvasTTY Kimi recovery journal backup path is invalid.");
  }
  return value as unknown as RecoveryJournal;
}

function kimiPaths(homeDirectory: string) {
  return {
    mcp: join(homeDirectory, "mcp.json"),
    config: join(homeDirectory, "config.toml"),
    lock: join(homeDirectory, ".canvastty-browser.lock"),
    journal: join(homeDirectory, ".canvastty-browser-recovery.json"),
    backupRoot: join(homeDirectory, ".canvastty-browser-backups")
  };
}

interface KimiConfigurationLock {
  descriptor: number;
  nonce: string;
  device: number;
  inode: number;
}

interface KimiConfigurationLockFile {
  version: 1;
  pid: number;
  createdAt: number;
  nonce: string;
}

interface ExistingKimiConfigurationLock {
  value: KimiConfigurationLockFile;
  raw: string;
  device: number;
  inode: number;
}

const MAX_LOCK_FILE_BYTES = 4 * 1024;
const MAX_STALE_LOCK_RETRIES = 3;

function acquireLock(path: string, hooks?: ConfigurationLockHooks): KimiConfigurationLock {
  for (let attempt = 0; attempt < MAX_STALE_LOCK_RETRIES; attempt += 1) {
    try {
      return createLock(path);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      const existing = readExistingLock(path);
      const state = lockOwnerState(existing.value.pid);
      if (state === "live") {
        throw new Error("Another CanvasTTY process is updating Kimi configuration.");
      }
      hooks?.beforeReclaim?.(path, existing.value.nonce);
      if (!unlinkDeadLock(path, existing)) continue;
    }
  }
  throw new Error("CanvasTTY could not acquire the Kimi configuration lock safely.");
}

function createLock(path: string): KimiConfigurationLock {
  let descriptor: number;
  descriptor = openSync(path, "wx", CONFIG_FILE_MODE);
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
    return {
      descriptor,
      nonce,
      device: identity.dev,
      inode: identity.ino
    };
  } catch (error) {
    closeSync(descriptor);
    // A failed write can leave an owned but unverifiable lock. Retaining it is
    // safer than unlinking a path that may have been replaced concurrently.
    throw error;
  }
}

function readExistingLock(path: string): ExistingKimiConfigurationLock {
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
    if (hasErrorCode(error, "ENOENT")) {
      throw changedLockError();
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseLockFile(raw: string): KimiConfigurationLockFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidLockError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidLockError();
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 4
    || record.version !== 1
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.createdAt !== "number"
    || !Number.isFinite(record.createdAt)
    || typeof record.nonce !== "string"
    || !/^[0-9a-f]{32}$/iu.test(record.nonce)
  ) throw invalidLockError();
  return record as unknown as KimiConfigurationLockFile;
}

function lockOwnerState(pid: number): "live" | "dead" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (hasErrorCode(error, "EPERM")) return "live";
    if (hasErrorCode(error, "ESRCH")) return "dead";
    throw new Error("CanvasTTY Kimi configuration lock owner status is ambiguous.");
  }
}

function unlinkDeadLock(path: string, existing: ExistingKimiConfigurationLock): boolean {
  try {
    const current = readExistingLock(path);
    if (
      current.device !== existing.device
      || current.inode !== existing.inode
      || current.raw !== existing.raw
    ) throw changedLockError();
    // The path is reopened, read and identity-checked synchronously immediately
    // before unlink. A detected replacement is always retained.
    unlinkSync(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function invalidLockError(): Error {
  return new Error("CanvasTTY Kimi configuration lock is invalid or foreign.");
}

function changedLockError(): Error {
  return new Error("CanvasTTY Kimi configuration lock changed during stale recovery.");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function releaseLock(path: string, lock: KimiConfigurationLock): void {
  let descriptorClosed = false;
  try {
    assertLockOwnership(path, lock);
    closeSync(lock.descriptor);
    descriptorClosed = true;
    // Verify again immediately before unlinking so a replaced lock is retained.
    assertLockOwnership(path, lock);
    unlinkSync(path);
  } finally {
    if (!descriptorClosed) closeSync(lock.descriptor);
  }
}

function assertLockOwnership(path: string, lock: KimiConfigurationLock): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("CanvasTTY Kimi configuration lock ownership cannot be verified.");
  }
  const identity = statSync(path);
  if (
    !value
    || typeof value !== "object"
    || (value as { version?: unknown }).version !== 1
    || (value as { nonce?: unknown }).nonce !== lock.nonce
    || identity.dev !== lock.device
    || identity.ino !== lock.inode
  ) {
    throw new Error("CanvasTTY Kimi configuration lock ownership changed before release.");
  }
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
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return CONFIG_FILE_MODE;
    }
    throw error;
  }
}

function validateStdioHelperLaunch(helper: StdioHelperLaunch): void {
  if (!helper || typeof helper !== "object") {
    throw new Error("CanvasTTY browser helper configuration is invalid.");
  }
  if (typeof helper.command !== "string" || helper.command.length === 0) {
    throw new Error("CanvasTTY browser helper command is invalid.");
  }
  if (!Array.isArray(helper.args) || !helper.args.every((argument) => typeof argument === "string")) {
    throw new Error("CanvasTTY browser helper arguments are invalid.");
  }
  if (helper.env === undefined) return;
  if (!helper.env || typeof helper.env !== "object" || Array.isArray(helper.env)) {
    throw new Error("CanvasTTY browser helper environment is invalid.");
  }
  for (const key of Reflect.ownKeys(helper.env)) {
    if (typeof key !== "string") {
      throw new Error("CanvasTTY browser helper environment contains an invalid key.");
    }
    if (RESERVED_AGENT_ENVIRONMENT_PATTERN.test(key)) {
      throw new Error(`CanvasTTY browser helper environment cannot set reserved key: ${key}`);
    }
    if (!ALLOWED_HELPER_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(`CanvasTTY browser helper environment key is not allowed: ${key}`);
    }
    if (typeof helper.env[key] !== "string") {
      throw new Error(`CanvasTTY browser helper environment value is invalid: ${key}`);
    }
  }
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (
      !error
      || typeof error !== "object"
      || !("code" in error)
      || (error.code !== "ENOENT" && error.code !== "ENOTEMPTY")
    ) throw error;
  }
}

function hashCanonical(value: unknown): string {
  return hashText(canonicalStringify(value));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function tomlStringTable(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(",")}}`;
}

function safeId(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}
