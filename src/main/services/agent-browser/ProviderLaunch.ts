import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import {
  APPROVED_BROWSER_TOOL_NAMES,
  MCP_SERVER_NAME,
  canonicalStringify
} from "../../../agent-browser/tool-catalog.mjs";
import { ORCHESTRATION_MCP_SERVER_NAME, ORCHESTRATION_TOOL_NAMES } from "../../../agent-browser/orchestration-catalog.mjs";
import { AGENT_BROWSER_ENV, type AgentProvider } from "./protocol.ts";
import {
  HermesTemporaryConfiguration,
  resolveHermesHomeDirectory
} from "../hermesConfig.ts";
import { openCodeBrowserEnvironment } from "../openCodeConfig.ts";
import {
  acquireConfigurationLock,
  atomicWrite,
  backupFile,
  existingMode,
  hashCanonical,
  hashText,
  readOptional,
  releaseConfigurationLock,
  removeEmptyDirectory,
  restoreFromBackup,
  unlinkIfExists,
  writeExactWithCas,
  type ConfigurationLockHooks
} from "../configOverlay.ts";
import {
  providerChildProcessLaunch,
  type AvailableProviderCli,
  type ProviderCliRegistry,
} from "../providerCliRegistry.ts";

const KIMI_RULE_PATTERN = `mcp__${MCP_SERVER_NAME}__*`;
const CLAUDE_RULE_PATTERN = `mcp__${MCP_SERVER_NAME}__*`;
const CONFIG_DIRECTORY_MODE = 0o700;
const KIMI_BACKUP_INVALID = "CanvasTTY Kimi configuration backup is unavailable or invalid.";
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
  /** Optional second MCP server (orchestration) injected into capable providers. */
  orchestrationHelper?: StdioHelperLaunch;
  providerClis: ProviderCliRegistry;
  hermesHomeDirectory?: string;
  kimiHomeDirectory?: string;
  runtimeDirectory: string;
  probeKimiPerRunConfig?: (cli: AvailableProviderCli) => boolean;
  /** The same probe off the main thread, for warmKimiProbe; defaults to the sync probe's answer when only that is given. */
  probeKimiPerRunConfigAsync?: (cli: AvailableProviderCli) => Promise<boolean>;
  environment?: Readonly<Record<string, string | undefined>>;
}

interface KimiLockHooks extends ConfigurationLockHooks {
  /** Test seam: runs before the lock is released at the end of a launch. */
  beforeRelease?(path: string, nonce: string): void;
}

export class ProviderLaunchAdapters {
  private readonly options: ProviderLaunchOptions;
  private readonly providerClis: ProviderCliRegistry;
  private readonly hermesHomeDirectory: string;
  private readonly kimiHomeDirectory: string;
  private kimiProbedExecutable: string | null = null;
  private readonly probe: (cli: AvailableProviderCli) => boolean;
  private readonly probeAsync: (cli: AvailableProviderCli) => Promise<boolean>;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private kimiSupportsPerRunConfig: boolean | null = null;
  /** A background probe's answer, used by the next Kimi launch of the same executable instead of a blocking probe. */
  private kimiWarmed: { executable: string; generation: number; result: boolean } | null = null;
  private kimiWarming: Promise<void> | null = null;
  private kimiGeneration = 0;
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
    this.environment = options.environment ?? process.env;
    // The probe runs Kimi with this adapter's environment (a fake HOME, an account's), never the app's own.
    this.probe = options.probeKimiPerRunConfig ?? ((cli) => probeKimiPerRunMcpConfig(cli, undefined, this.environment));
    const syncProbe = options.probeKimiPerRunConfig;
    this.probeAsync = options.probeKimiPerRunConfigAsync
      ?? (syncProbe ? async (cli) => syncProbe(cli) : (cli) => probeKimiPerRunMcpConfigAsync(cli, undefined, this.environment));
  }

  providerClisRefreshed(): void {
    this.kimiProbedExecutable = null;
    this.kimiSupportsPerRunConfig = null;
    this.kimiWarmed = null;
    this.kimiGeneration += 1;
  }

  /**
   * Asks the Kimi CLI whether it takes a per-run MCP config in the background (`kimi --help`, up to 3 s), so the
   * first Kimi launch finds the answer instead of blocking the main process on the same probe. A launch that
   * comes first still probes synchronously, exactly as before; a recheck of the CLIs discards the answer.
   */
  warmKimiProbe(): Promise<void> {
    const kimiCli = this.providerClis.get("kimi");
    if (kimiCli.state === "unavailable") return Promise.resolve();
    if (this.kimiSupportsPerRunConfig !== null && this.kimiProbedExecutable === kimiCli.executable) return Promise.resolve();
    const generation = this.kimiGeneration;
    if (this.kimiWarmed?.executable === kimiCli.executable && this.kimiWarmed.generation === generation) return Promise.resolve();
    if (this.kimiWarming) return this.kimiWarming;
    const warming = this.probeAsync(kimiCli)
      .then((result) => {
        if (generation === this.kimiGeneration) this.kimiWarmed = { executable: kimiCli.executable, generation, result };
      }, () => undefined)
      .finally(() => {
        if (this.kimiWarming === warming) this.kimiWarming = null;
      });
    this.kimiWarming = warming;
    return warming;
  }

  /**
   * `orchestrationTools`: the canvastty_agents tools this session may use (default: the core tools). `browser: false`
   * (browser access off) leaves canvastty_browser out, so only canvastty_agents is attached.
   */
  prepare(provider: AgentProvider, connectionId: string, options?: { orchestration?: boolean; orchestrationTools?: readonly string[]; browser?: boolean }): PreparedProviderLaunch {
    const providerCli = this.providerClis.get(provider);
    if (providerCli.state === "unavailable") throw new Error(providerCli.diagnostic);
    const orchestrationHelper = orchestrationHelperFor(this.options, options);
    if (orchestrationHelper) validateStdioHelperLaunch(orchestrationHelper);
    const browserHelper = options?.browser === false ? null : this.options.helper;
    if (!browserHelper && !orchestrationHelper) throw new Error("A provider launch needs at least one CanvasTTY MCP server.");
    if (provider === "claude") {
      return {
        args: claudeMcpArgs(browserHelper, orchestrationHelper),
        environment: {},
        releaseConfiguration() {}
      };
    }
    if (provider === "codex") {
      return {
        args: codexMcpArgs(browserHelper, orchestrationHelper, options?.orchestrationTools),
        environment: {},
        releaseConfiguration() {}
      };
    }
    if (provider === "qwen") {
      return {
        args: qwenMcpArgs(browserHelper, orchestrationHelper, options?.orchestrationTools),
        environment: {},
        releaseConfiguration() {}
      };
    }
    if (provider === "opencode") {
      return {
        args: [],
        environment: openCodeBrowserEnvironment(browserHelper, this.environment, orchestrationHelper),
        releaseConfiguration() {}
      };
    }
    if (provider === "hermes") {
      return {
        args: [],
        environment: {},
        releaseConfiguration: this.acquireHermesConfiguration(browserHelper, orchestrationHelper)
      };
    }
    return this.prepareKimi(connectionId, browserHelper, orchestrationHelper);
  }

  recoverKimiConfiguration(): void {
    KimiTemporaryConfiguration.recover(this.kimiHomeDirectory);
  }

  recoverHermesConfiguration(): void {
    HermesTemporaryConfiguration.recover(this.hermesHomeDirectory);
  }

  private acquireHermesConfiguration(browserHelper: StdioHelperLaunch | null, orchestrationHelper?: StdioHelperLaunch): () => void {
    const requiresOrchestration = orchestrationHelper !== undefined;
    if (!this.hermesConfiguration) {
      this.hermesConfiguration = HermesTemporaryConfiguration.begin({
        homeDirectory: this.hermesHomeDirectory,
        helper: browserHelper,
        ...(requiresOrchestration ? { orchestrationHelper } : {})
      });
    } else if (this.hermesConfiguration.hasBrowserEntry !== (browserHelper !== null)) {
      // Browser access changed while Hermes agents run on the shared config.yaml: never hand a launch the other set.
      throw new Error("Hermes browser access cannot change while a temporary Hermes configuration is active.");
    } else if (requiresOrchestration && !this.hermesConfiguration.hasOrchestrationEntry) {
      // The shared temporary config.yaml cannot be extended under active
      // launches. Failing loudly beats silently launching an orchestrator
      // without its canvastty_agents tools; the extra entry in the other
      // direction (orchestration config, plain launch) is harmless.
      throw new Error("Hermes MCP orchestration cannot be enabled while a temporary Hermes configuration is active.");
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

  private prepareKimi(connectionId: string, browserHelper: StdioHelperLaunch | null, orchestrationHelper?: StdioHelperLaunch): PreparedProviderLaunch {
    const kimiCli = this.providerClis.get("kimi");
    if (kimiCli.state === "unavailable") throw new Error(kimiCli.diagnostic);
    if (this.kimiProbedExecutable !== kimiCli.executable) {
      this.kimiSupportsPerRunConfig = null;
      this.kimiProbedExecutable = kimiCli.executable;
    }
    if (this.kimiSupportsPerRunConfig === null) {
      const warmed = this.kimiWarmed;
      this.kimiSupportsPerRunConfig = warmed && warmed.executable === kimiCli.executable && warmed.generation === this.kimiGeneration
        ? warmed.result
        : this.probe(kimiCli);
      KimiTemporaryConfiguration.recover(this.kimiHomeDirectory);
    }
    const supportsPerRun = this.kimiSupportsPerRunConfig;
    // The per-run document carries orchestration per launch, so the shared
    // fallback configuration only tracks it when mcp.json is actually mutated.
    const releaseShared = this.acquireKimiConfiguration(
      !supportsPerRun,
      browserHelper,
      supportsPerRun ? undefined : orchestrationHelper
    );
    let perRunPath: string | null = null;

    try {
      const args: string[] = [];
      if (supportsPerRun) {
        mkdirSync(this.options.runtimeDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
        chmodSync(this.options.runtimeDirectory, CONFIG_DIRECTORY_MODE);
        perRunPath = join(this.options.runtimeDirectory, `kimi-mcp-${safeId(connectionId)}.json`);
        atomicWrite(perRunPath, `${JSON.stringify(mcpDocument(browserHelper, orchestrationHelper), null, 2)}\n`);
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

  private acquireKimiConfiguration(
    includeMcpEntry: boolean,
    browserHelper: StdioHelperLaunch | null,
    orchestrationHelper?: StdioHelperLaunch
  ): () => void {
    const requiresOrchestration = includeMcpEntry && orchestrationHelper !== undefined;
    // The shared mcp.json carries the browser entry only while browser access is on.
    const includeBrowser = includeMcpEntry && browserHelper !== null;
    if (!this.kimiConfiguration) {
      this.kimiConfiguration = KimiTemporaryConfiguration.begin({
        homeDirectory: this.kimiHomeDirectory,
        helper: includeBrowser ? browserHelper : null,
        includeMcpEntry,
        ...(requiresOrchestration && orchestrationHelper ? { orchestrationHelper } : {})
      });
    } else if (this.kimiConfiguration.includeMcpEntry !== includeMcpEntry) {
      throw new Error("Kimi MCP capability changed while temporary configuration is active.");
    } else if (includeMcpEntry && this.kimiConfiguration.hasBrowserEntry !== includeBrowser) {
      throw new Error("Kimi browser access cannot change while a temporary Kimi configuration is active.");
    } else if (requiresOrchestration && !this.kimiConfiguration.hasOrchestrationEntry) {
      // Mirrors the Hermes guard: never silently drop the canvastty_agents
      // entry an orchestrator needs because a plain launch owns the config.
      throw new Error("Kimi MCP orchestration cannot be enabled while a temporary Kimi configuration is active.");
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

/** `helper` null: browser access is off, only canvastty_agents is attached (and no browser tools are allowed). */
export function claudeMcpArgs(helper: StdioHelperLaunch | null, orchestrationHelper?: StdioHelperLaunch): string[] {
  if (helper) validateStdioHelperLaunch(helper);
  if (orchestrationHelper) validateStdioHelperLaunch(orchestrationHelper);
  const config = {
    mcpServers: {
      ...(helper ? {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: helper.command,
          args: helper.args,
          ...(helper.env && Object.keys(helper.env).length > 0 ? { env: helper.env } : {})
        }
      } : {}),
      ...(orchestrationHelper ? orchestrationServerEntry(orchestrationHelper) : {})
    }
  };
  return [
    "--mcp-config",
    canonicalStringify(config),
    ...(helper ? ["--allowedTools", CLAUDE_RULE_PATTERN] : [])
  ];
}

export function codexMcpArgs(
  helper: StdioHelperLaunch | null,
  orchestrationHelper?: StdioHelperLaunch,
  orchestrationTools: readonly string[] = ORCHESTRATION_TOOL_NAMES
): string[] {
  if (helper) validateStdioHelperLaunch(helper);
  if (orchestrationHelper) validateStdioHelperLaunch(orchestrationHelper);
  const args: string[] = helper ? codexBrowserArgs(helper) : [];
  if (orchestrationHelper) {
    const orchestrationPrefix = `mcp_servers.${ORCHESTRATION_MCP_SERVER_NAME}`;
    const orchestrationTable = [
      `command=${tomlString(orchestrationHelper.command)}`,
      `args=${tomlStringArray(orchestrationHelper.args)}`,
      `env=${tomlStringTable(orchestrationHelper.env ?? {})}`,
      `env_vars=${tomlStringArray(["CANVASTTY_ORCHESTRATION_ADDRESS", "CANVASTTY_ORCHESTRATION_CAPABILITY", "CANVASTTY_TERMINAL_SESSION_ID", "CANVASTTY_ORCHESTRATION_CONNECTION_ID"])}`,
      "enabled=true",
      "required=false",
      'default_tools_approval_mode="approve"',
      // Coordination must be callable upfront; ranked discovery can omit an enabled tool even by exact name.
      'omit_tools_from=["deferred"]',
      `enabled_tools=${tomlStringArray([...orchestrationTools])}`,
      "disabled_tools=[]"
    ].join(",");
    args.push("-c", `${orchestrationPrefix}={${orchestrationTable}}`);
  }
  return args;
}

function codexBrowserArgs(helper: StdioHelperLaunch): string[] {
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

export function qwenMcpArgs(
  helper: StdioHelperLaunch | null,
  orchestrationHelper?: StdioHelperLaunch,
  orchestrationTools: readonly string[] = ORCHESTRATION_TOOL_NAMES
): string[] {
  if (helper) validateStdioHelperLaunch(helper);
  if (orchestrationHelper) validateStdioHelperLaunch(orchestrationHelper);
  const allowedTools = [
    ...(helper ? APPROVED_BROWSER_TOOL_NAMES.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool}`) : []),
    ...(orchestrationHelper ? orchestrationTools.map((tool: string) => `mcp__${ORCHESTRATION_MCP_SERVER_NAME}__${tool}`) : [])
  ].join(",");
  const config = {
    mcpServers: {
      ...(helper ? {
        [MCP_SERVER_NAME]: {
          command: helper.command,
          args: helper.args,
          ...(helper.env && Object.keys(helper.env).length > 0 ? { env: helper.env } : {}),
          includeTools: [...APPROVED_BROWSER_TOOL_NAMES]
        }
      } : {}),
      ...(orchestrationHelper ? orchestrationServerEntry(orchestrationHelper) : {})
    }
  };
  return [
    "--mcp-config",
    canonicalStringify(config),
    "--allowed-tools",
    allowedTools
  ];
}

function orchestrationHelperFor(
  options: ProviderLaunchOptions,
  request?: { orchestration?: boolean }
): StdioHelperLaunch | undefined {
  return request?.orchestration ? options.orchestrationHelper : undefined;
}

function orchestrationServerEntry(helper: StdioHelperLaunch): Record<string, unknown> {
  return {
    [ORCHESTRATION_MCP_SERVER_NAME]: {
      type: "stdio",
      command: helper.command,
      args: helper.args,
      ...(helper.env && Object.keys(helper.env).length > 0 ? { env: helper.env } : {})
    }
  };
}

export function probeKimiPerRunMcpConfig(
  cli: AvailableProviderCli,
  timeoutMs = 3_000,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  const launch = providerChildProcessLaunch(cli, ["--help"]);
  const result = spawnSync(launch.command, launch.args, {
    encoding: "utf8",
    env: { ...environment, ...launch.environment },
    timeout: timeoutMs,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  });
  if (result.error || result.status !== 0) return false;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes("--mcp-config-file");
}

/** probeKimiPerRunMcpConfig without blocking: the same command, limits and answer. */
export function probeKimiPerRunMcpConfigAsync(
  cli: AvailableProviderCli,
  timeoutMs = 3_000,
  environment: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const launch = providerChildProcessLaunch(cli, ["--help"]);
  return new Promise((resolve) => {
    execFile(launch.command, launch.args, {
      encoding: "utf8",
      env: { ...environment, ...launch.environment },
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    }, (error, stdout, stderr) => {
      resolve(!error && `${stdout ?? ""}\n${stderr ?? ""}`.includes("--mcp-config-file"));
    });
  });
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
  /** The canvastty_browser entry; null when browser access is off. */
  helper: StdioHelperLaunch | null;
  includeMcpEntry: boolean;
  /** Optional second MCP server (canvastty_agents) written next to the browser one. */
  orchestrationHelper?: StdioHelperLaunch;
  lockHooks?: KimiLockHooks;
}

interface RecoveryJournal {
  version: 1;
  ownershipId: string;
  includeMcpEntry: boolean;
  /** "" when mcp.json got no canvastty_browser entry (browser access off). */
  mcpEntryHash: string;
  /** Absent in journals written before orchestration support; never undefined when set. */
  orchestrationEntryHash?: string;
  mcpOriginalHash: string | null;
  mcpMutatedHash: string | null;
  configOriginalHash: string | null;
  configMutatedHash: string;
  backupDirectory: string;
}

export class KimiTemporaryConfiguration {
  readonly includeMcpEntry: boolean;
  readonly hasOrchestrationEntry: boolean;
  readonly hasBrowserEntry: boolean;
  private readonly paths: ReturnType<typeof kimiPaths>;
  private readonly journal: RecoveryJournal;
  private cleaned = false;

  private constructor(paths: ReturnType<typeof kimiPaths>, journal: RecoveryJournal) {
    this.paths = paths;
    this.journal = journal;
    this.includeMcpEntry = journal.includeMcpEntry;
    this.hasOrchestrationEntry = journal.orchestrationEntryHash !== undefined;
    this.hasBrowserEntry = journal.mcpEntryHash !== "";
  }

  static begin(options: KimiTemporaryConfigurationOptions): KimiTemporaryConfiguration {
    if (options.helper) validateStdioHelperLaunch(options.helper);
    if (options.orchestrationHelper) validateStdioHelperLaunch(options.orchestrationHelper);
    mkdirSync(options.homeDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
    const paths = kimiPaths(options.homeDirectory);
    const lock = acquireConfigurationLock(paths.lock, "Kimi", options.lockHooks);
    try {
      this.recoverLocked(paths);
      const ownershipId = randomUUID();
      const entry = options.helper ? mcpEntry(options.helper) : null;
      const orchestrationEntry = options.orchestrationHelper
        ? kimiOrchestrationEntry(options.orchestrationHelper)
        : null;
      const mcpOriginal = options.includeMcpEntry ? readOptional(paths.mcp) : null;
      const configOriginal = readOptional(paths.config);
      let mcpMutated: string | null = null;
      if (options.includeMcpEntry) {
        const document = mcpOriginal === null ? {} : parseJsonObject(mcpOriginal, paths.mcp);
        const servers = asMcpServers(document);
        if (entry && MCP_SERVER_NAME in servers) {
          throw new Error(`Kimi MCP server name ${MCP_SERVER_NAME} is already configured.`);
        }
        if (orchestrationEntry && ORCHESTRATION_MCP_SERVER_NAME in servers) {
          throw new Error(`Kimi MCP server name ${ORCHESTRATION_MCP_SERVER_NAME} is already configured.`);
        }
        mcpMutated = `${JSON.stringify({
          ...document,
          mcpServers: {
            ...servers,
            ...(entry ? { [MCP_SERVER_NAME]: entry } : {}),
            ...(orchestrationEntry ? { [ORCHESTRATION_MCP_SERVER_NAME]: orchestrationEntry } : {})
          }
        }, null, 2)}\n`;
      }
      const configBase = configOriginal ?? "";
      const configSeparator = configBase.length === 0 || configBase.endsWith("\n") ? "" : "\n";
      const configMutated = `${configBase}${configSeparator}${permissionRuleBlock(ownershipId)}`;
      const backupDirectory = join(paths.backupRoot, ownershipId);
      mkdirSync(backupDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
      chmodSync(backupDirectory, CONFIG_DIRECTORY_MODE);
      if (options.includeMcpEntry && mcpOriginal !== null) {
        backupFile(paths.mcp, join(backupDirectory, "mcp.json"));
      }
      if (configOriginal !== null) backupFile(paths.config, join(backupDirectory, "config.toml"));

      const journal: RecoveryJournal = {
        version: 1,
        ownershipId,
        includeMcpEntry: options.includeMcpEntry,
        mcpEntryHash: entry ? hashCanonical(entry) : "",
        ...(orchestrationEntry ? { orchestrationEntryHash: hashCanonical(orchestrationEntry) } : {}),
        mcpOriginalHash: mcpOriginal === null ? null : hashText(mcpOriginal),
        mcpMutatedHash: mcpMutated === null ? null : hashText(mcpMutated),
        configOriginalHash: configOriginal === null ? null : hashText(configOriginal),
        configMutatedHash: hashText(configMutated),
        backupDirectory
      };
      atomicWrite(paths.journal, `${canonicalStringify(journal)}\n`);

      if (mcpMutated !== null) writeExactWithCas(paths.mcp, mcpOriginal, mcpMutated, "Kimi");
      writeExactWithCas(paths.config, configOriginal, configMutated, "Kimi");
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
        releaseConfigurationLock(paths.lock, lock, "Kimi");
        throw error;
      }
      releaseConfigurationLock(paths.lock, lock, "Kimi");
    }
  }

  static recover(homeDirectory: string): void {
    if (!existsSync(homeDirectory)) return;
    const paths = kimiPaths(homeDirectory);
    const lock = acquireConfigurationLock(paths.lock, "Kimi");
    try {
      this.recoverLocked(paths);
    } finally {
      releaseConfigurationLock(paths.lock, lock, "Kimi");
    }
  }

  cleanup(): void {
    if (this.cleaned) return;
    const lock = acquireConfigurationLock(this.paths.lock, "Kimi");
    try {
      cleanupOwnedChanges(this.paths, this.journal);
      removeRecoveryArtifacts(this.paths, this.journal);
      this.cleaned = true;
    } finally {
      releaseConfigurationLock(this.paths.lock, lock, "Kimi");
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

function mcpDocument(helper: StdioHelperLaunch | null, orchestrationHelper?: StdioHelperLaunch): Record<string, unknown> {
  return {
    mcpServers: {
      ...(helper ? { [MCP_SERVER_NAME]: mcpEntry(helper) } : {}),
      ...(orchestrationHelper
        ? { [ORCHESTRATION_MCP_SERVER_NAME]: kimiOrchestrationEntry(orchestrationHelper) }
        : {})
    }
  };
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

// Kimi launches stdio MCP servers with the parent environment (the browser
// entry relies on the same inheritance for CANVASTTY_AGENT_*), so the
// orchestration variables reach the helper without being listed here.
function kimiOrchestrationEntry(helper: StdioHelperLaunch): Record<string, unknown> {
  return {
    transport: "stdio",
    command: helper.command,
    args: helper.args,
    ...(helper.env && Object.keys(helper.env).length > 0 ? { env: helper.env } : {}),
    enabled: true,
    enabledTools: [...ORCHESTRATION_TOOL_NAMES]
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
      restoreFromBackup(paths.mcp, journal.mcpOriginalHash, join(journal.backupDirectory, "mcp.json"), KIMI_BACKUP_INVALID);
    } else {
      mutateJsonWithCas(paths.mcp, (document) => {
        const servers = asMcpServers(document);
        const ownedEntries: Array<[string, string]> = journal.mcpEntryHash ? [[MCP_SERVER_NAME, journal.mcpEntryHash]] : [];
        if (journal.orchestrationEntryHash) {
          ownedEntries.push([ORCHESTRATION_MCP_SERVER_NAME, journal.orchestrationEntryHash]);
        }
        const nextServers = { ...servers };
        let removed = false;
        for (const [name, expectedHash] of ownedEntries) {
          const owned = servers[name];
          if (owned === undefined || hashCanonical(owned) !== expectedHash) continue;
          delete nextServers[name];
          removed = true;
        }
        if (!removed) return document;
        return { ...document, mcpServers: nextServers };
      });
    }
  }
  if (existsSync(paths.config)) {
    const current = readOptional(paths.config);
    if (current !== null && hashText(current) === journal.configMutatedHash) {
      restoreFromBackup(paths.config, journal.configOriginalHash, join(journal.backupDirectory, "config.toml"), KIMI_BACKUP_INVALID);
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
    || (value.orchestrationEntryHash !== undefined && typeof value.orchestrationEntryHash !== "string")
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
