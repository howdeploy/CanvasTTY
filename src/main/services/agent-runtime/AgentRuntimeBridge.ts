import type { ProviderId } from "../../../shared/contracts.ts";
import { dirname, join } from "node:path";
import type { AvailableProviderCli } from "../providerCliRegistry.ts";
import type { HelperLaunch } from "../agentHelpers.ts";
import { createShellCodexWrapper, shellCodexEnvironment } from "../shellCodexLaunch.ts";
import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV,
  CAPTURE_RESULT_ENV
} from "../../../agent-runtime/runtime-protocol.mjs";
import type { RuntimeGateway, RuntimeLifecycleState } from "./RuntimeGateway.ts";
import {
  ProviderRuntimeLaunchAdapters,
  codexLifecycleArgs,
  type ProviderRuntimeLaunchOptions
} from "./ProviderRuntimeLaunch.ts";
import type { ClaudeHttpLaunchFacts, ClaudeHttpVerdict } from "./ClaudeHttpHooks.ts";

export interface PrepareAgentRuntimeLaunchInput {
  terminalSessionId: string;
  provider: Exclude<ProviderId, "terminal">;
  cwd: string;
  captureResult?: boolean;
  /** Owner-issued, per-session answer-capture grant expiry (Unix milliseconds). */
  answerCaptureGrantExpiresAt?: number;
  /** Install the decision hook (base protection and plugin decisions); by default `wantsDecisions` says. */
  decisions?: boolean;
  /** Claude Code: what decides whether its lifecycle hooks may go over HTTP (see ClaudeHttpHooks.ts). */
  claudeHttp?: ClaudeHttpLaunchFacts;
  /** Grok/Kimi: the CLI home a launch contributor started the launch with (`accountHookHome`), for its status hooks. */
  accountHome?: string;
}

export interface PreparedAgentRuntimePtyLaunch {
  args: string[];
  environment: Record<string, string>;
  /** The decision hook was installed (the provider has one and the gateway runs). */
  decisions?: boolean;
  /** Claude's lifecycle hooks go over HTTP to the gateway (otherwise through the command helper). */
  httpHooks?: boolean;
  shellCodexWrapper?: string;
  cleanup(): void;
}

export interface AgentRuntimeLaunchCoordinator {
  prepareLaunch(input: PrepareAgentRuntimeLaunchInput): PreparedAgentRuntimePtyLaunch;
  currentStatus(terminalSessionId: string): RuntimeLifecycleState | null;
  prepareShellLaunch?(input: { terminalSessionId: string; cli: AvailableProviderCli; environment: Record<string, string> }): PreparedAgentRuntimePtyLaunch;
}

export interface AgentRuntimeBridgeOptions extends ProviderRuntimeLaunchOptions {
  shellCodexHelper?: HelperLaunch;
  recoverOnStart?: boolean;
  coreHooksEnabled?: boolean;
  /** Whether a launch of this agent needs the decision hook (base protection on, or a decision plugin applies). */
  wantsDecisions?(provider: Exclude<ProviderId, "terminal">): boolean;
  /** The longest decision budget for this agent (ms); the session's gate deadlines are sized from it. */
  decisionBudgetMs?(provider: Exclude<ProviderId, "terminal">): number;
  /** Whether a Claude launch may use HTTP lifecycle hooks; without it every launch uses the command helper. */
  claudeHttpHooks?(facts: ClaudeHttpLaunchFacts): ClaudeHttpVerdict;
}

export class AgentRuntimeBridge implements AgentRuntimeLaunchCoordinator {
  private readonly gateway: RuntimeGateway;
  private readonly providers: ProviderRuntimeLaunchAdapters;
  /** Running sessions and whether each got the decision hook. */
  /** Live launches by card id; the entry object is the launch identity a late cleanup checks against. */
  private readonly activeSessions = new Map<string, { decisions: boolean; trackIdentity?: boolean }>();
  private readonly options: AgentRuntimeBridgeOptions;
  private coreHooksEnabled: boolean;
  private readonly wantsDecisions: AgentRuntimeBridgeOptions["wantsDecisions"];
  private readonly decisionBudgetMs: AgentRuntimeBridgeOptions["decisionBudgetMs"];
  private readonly claudeHttpHooks: AgentRuntimeBridgeOptions["claudeHttpHooks"];

  constructor(gateway: RuntimeGateway, options: AgentRuntimeBridgeOptions) {
    this.options = options;
    this.gateway = gateway;
    this.wantsDecisions = options.wantsDecisions;
    this.decisionBudgetMs = options.decisionBudgetMs;
    this.claudeHttpHooks = options.claudeHttpHooks;
    this.providers = new ProviderRuntimeLaunchAdapters(options);
    this.coreHooksEnabled = options.coreHooksEnabled !== false;
    if (options.recoverOnStart) this.providers.recoverConfigurations();
  }

  prepareShellLaunch(input: { terminalSessionId: string; cli: AvailableProviderCli; environment: Record<string, string> }): PreparedAgentRuntimePtyLaunch {
    const helper = this.options.shellCodexHelper;
    if (!helper || helper.args.length !== 1) return { args: [], environment: {}, cleanup() {} };
    // Shell cards get identity observation only: no decisions, browser or orchestration capabilities.
    const capability = this.gateway.registerSession(input.terminalSessionId, "codex", false, undefined, false, undefined, true);
    const environment = {
      [AGENT_RUNTIME_ENV.address]: capability.address,
      [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
      [AGENT_RUNTIME_ENV.provider]: capability.provider,
      [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
    };
    let wrapper;
    try {
      wrapper = createShellCodexWrapper({
        directory: this.options.runtimeDirectory,
        helper,
        cli: input.cli,
        hooks: codexLifecycleArgs({ command: helper.command, args: [join(dirname(helper.args[0]!), "hook-helper.mjs")], env: helper.env }, this.options.platform),
        environment,
        platform: this.options.platform
      });
    } catch (error) {
      this.gateway.revokeTerminalSession(input.terminalSessionId, capability.capabilityToken);
      throw error;
    }
    const launch = { decisions: false, trackIdentity: true };
    this.activeSessions.set(input.terminalSessionId, launch);
    let cleaned = false;
    return {
      args: [],
      environment: shellCodexEnvironment(input.environment, wrapper.directory, this.options.platform),
      shellCodexWrapper: wrapper.wrapper,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        if (this.activeSessions.get(input.terminalSessionId) === launch) this.activeSessions.delete(input.terminalSessionId);
        try { wrapper.cleanup(); } finally { this.gateway.revokeTerminalSession(input.terminalSessionId, capability.capabilityToken); }
      }
    };
  }

  prepareLaunch(input: PrepareAgentRuntimeLaunchInput): PreparedAgentRuntimePtyLaunch {
    // The decision hook talks to the gateway over its own capability, with or without agent status hooks.
    const decisions = (input.decisions ?? this.wantsDecisions?.(input.provider) === true)
      && this.providers.decisionsSupported(input.provider);
    let budgetMs: number | undefined;
    try { budgetMs = decisions ? this.decisionBudgetMs?.(input.provider) : undefined; } catch { budgetMs = undefined; }
    const capability = this.coreHooksEnabled || decisions
      ? this.gateway.registerSession(
        input.terminalSessionId,
        input.provider,
        input.captureResult === true,
        isLiveGrant(input.answerCaptureGrantExpiresAt) ? input.answerCaptureGrantExpiresAt : undefined,
        decisions,
        budgetMs
      )
      : null;
    const httpHookBase = capability && this.coreHooksEnabled ? this.claudeHttpHookBase(input) : null;
    let prepared;
    try {
      prepared = this.providers.prepare(input.provider, input.terminalSessionId, this.coreHooksEnabled, decisions, budgetMs,
        httpHookBase ?? undefined, input.accountHome);
    } catch (error) {
      if (capability) this.gateway.revokeTerminalSession(input.terminalSessionId, capability.capabilityToken);
      throw error;
    }
    const launch = { decisions };
    this.activeSessions.set(input.terminalSessionId, launch);
    let cleaned = false;
    return {
      args: prepared.args,
      decisions,
      httpHooks: httpHookBase !== null,
      environment: {
        ...prepared.environment,
        ...(input.captureResult ? { [CAPTURE_RESULT_ENV]: "1" } : {}),
        ...(isLiveGrant(input.answerCaptureGrantExpiresAt) ? {
          [CAPTURE_ANSWER_ENV]: "1",
          [CAPTURE_ANSWER_EXPIRES_AT_ENV]: String(input.answerCaptureGrantExpiresAt)
        } : {}),
        ...(capability ? {
          [AGENT_RUNTIME_ENV.address]: capability.address,
          [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
          [AGENT_RUNTIME_ENV.provider]: capability.provider,
          [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
        } : {})
      },
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        // A relaunch under the same card id owns the entry and the lease now; leave both to it.
        if (this.activeSessions.get(input.terminalSessionId) === launch) this.activeSessions.delete(input.terminalSessionId);
        try {
          prepared.releaseConfiguration();
        } finally {
          if (capability) this.gateway.revokeTerminalSession(input.terminalSessionId, capability.capabilityToken);
        }
      }
    };
  }

  /** The gateway's HTTP hook URL when this Claude launch may use it; null keeps the command helper. */
  private claudeHttpHookBase(input: PrepareAgentRuntimeLaunchInput): string | null {
    if (input.provider !== "claude" || !input.claudeHttp || !this.claudeHttpHooks) return null;
    const base = this.gateway.httpHookBase;
    if (!base) return null;
    try {
      return this.claudeHttpHooks(input.claudeHttp).ok ? base : null;
    } catch {
      return null;
    }
  }

  currentStatus(terminalSessionId: string): RuntimeLifecycleState | null {
    return this.coreHooksEnabled ? this.gateway.currentStatus(terminalSessionId) : null;
  }

  setCoreHooksEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.coreHooksEnabled === next) return;
    this.coreHooksEnabled = next;
    if (next) return;
    // A session with the decision hook keeps its lease: its protection must not silently stop.
    for (const [terminalSessionId, { decisions, trackIdentity }] of this.activeSessions) {
      if (!decisions && !trackIdentity) this.gateway.revokeTerminalSession(terminalSessionId);
    }
  }
}

function isLiveGrant(expiresAt: number | undefined): expiresAt is number {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > Date.now();
}
