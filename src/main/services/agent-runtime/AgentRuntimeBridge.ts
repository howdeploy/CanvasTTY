import { randomUUID } from "node:crypto";
import type { ProviderId } from "../../../shared/contracts.ts";
import { dirname, isAbsolute, join } from "node:path";
import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV,
  CAPTURE_RESULT_ENV
} from "../../../agent-runtime/runtime-protocol.mjs";
import type { RuntimeGateway, RuntimeLifecycleState } from "./RuntimeGateway.ts";
import {
  ProviderRuntimeLaunchAdapters,
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
}

export interface PreparedAgentRuntimePtyLaunch {
  args: string[];
  environment: Record<string, string>;
  /** The decision hook was installed (the provider has one and the gateway runs). */
  decisions?: boolean;
  /** Claude's lifecycle hooks go over HTTP to the gateway (otherwise through the command helper). */
  httpHooks?: boolean;
  cleanup(): void;
}

export interface AgentRuntimeLaunchCoordinator {
  prepareLaunch(input: PrepareAgentRuntimeLaunchInput): PreparedAgentRuntimePtyLaunch;
  currentStatus(terminalSessionId: string): RuntimeLifecycleState | null;
  readableRuntimePaths?(): readonly string[];
}

export interface AgentRuntimeBridgeOptions extends ProviderRuntimeLaunchOptions {
  recoverOnStart?: boolean;
  /** Host-only invalidation of turn-scoped authority on launch replacement, cleanup or hook revocation. */
  onTurnAuthorityChanged?(sessionId: string): void;
  coreHooksEnabled?: boolean;
  /** Whether a launch of this agent needs the decision hook (base protection on, or a decision plugin applies). */
  wantsDecisions?(provider: Exclude<ProviderId, "terminal">): boolean;
  /** The longest decision budget for this agent (ms); the session's gate deadlines are sized from it. */
  decisionBudgetMs?(provider: Exclude<ProviderId, "terminal">): number;
  /** Whether a Claude launch may use HTTP lifecycle hooks; without it every launch uses the command helper. */
  claudeHttpHooks?(facts: ClaudeHttpLaunchFacts): ClaudeHttpVerdict;
}

export class AgentRuntimeBridge implements AgentRuntimeLaunchCoordinator {
  private readonly runtimeReadPaths: readonly string[];
  private readonly gateway: RuntimeGateway;
  private readonly providers: ProviderRuntimeLaunchAdapters;
  /** Running sessions and whether each got the decision hook. */
  /** Live launches by card id; the entry object is the launch identity a late cleanup checks against. */
  private readonly activeSessions = new Map<string, { decisions: boolean; captureResult: boolean; turnCompletion: boolean; identity: string }>();
  private coreHooksEnabled: boolean;
  private readonly onTurnAuthorityChanged: AgentRuntimeBridgeOptions["onTurnAuthorityChanged"];
  private readonly wantsDecisions: AgentRuntimeBridgeOptions["wantsDecisions"];
  private readonly decisionBudgetMs: AgentRuntimeBridgeOptions["decisionBudgetMs"];
  private readonly claudeHttpHooks: AgentRuntimeBridgeOptions["claudeHttpHooks"];

  constructor(gateway: RuntimeGateway, options: AgentRuntimeBridgeOptions) {
    this.gateway = gateway;
    this.onTurnAuthorityChanged = options.onTurnAuthorityChanged;
    this.wantsDecisions = options.wantsDecisions;
    this.decisionBudgetMs = options.decisionBudgetMs;
    this.claudeHttpHooks = options.claudeHttpHooks;
    this.providers = new ProviderRuntimeLaunchAdapters(options);
    // File grants, never the containing source tree: a reviewer may review CanvasTTY itself.
    const helpers = [options.helper, ...(options.permissionGate ? [options.permissionGate] : []),
      ...(options.pluginHooks ? [options.pluginHooks.runner] : [])];
    const runtimeFiles = ["hook-helper.mjs", "permission-gate.mjs", "runtime-client.mjs", "runtime-protocol.mjs",
      "ndjson.mjs", "path-inside.mjs", "opencode-plugin.mjs", "opencode-final-answer.mjs", "opencode-decisions.mjs", "omp-extension.mjs",
      "plugin-hook-runner.mjs", "plugin-hook-dispatch.mjs"];
    this.runtimeReadPaths = Object.freeze([...new Set([
      ...helpers.flatMap(helper => [helper.command, ...helper.args.filter(isAbsolute)]),
      ...runtimeFiles.map(file => join(dirname(options.openCodePluginPath), file))])]);
    this.coreHooksEnabled = options.coreHooksEnabled !== false;
    if (options.recoverOnStart) this.providers.recoverConfigurations();
  }

  readableRuntimePaths(): readonly string[] { return this.runtimeReadPaths; }

  prepareLaunch(input: PrepareAgentRuntimeLaunchInput): PreparedAgentRuntimePtyLaunch {
    // The decision hook talks to the gateway over its own capability, with or without agent status hooks.
    const decisions = (input.decisions ?? this.wantsDecisions?.(input.provider) === true)
      && this.providers.decisionsSupported(input.provider);
    let budgetMs: number | undefined;
    try { budgetMs = decisions ? this.decisionBudgetMs?.(input.provider) : undefined; } catch { budgetMs = undefined; }
    const captureResult = input.captureResult === true;
    const capability = this.coreHooksEnabled || decisions || captureResult
      ? this.gateway.registerSession(
        input.terminalSessionId,
        input.provider,
        captureResult,
        isLiveGrant(input.answerCaptureGrantExpiresAt) ? input.answerCaptureGrantExpiresAt : undefined,
        decisions,
        budgetMs
      )
      : null;
    const httpHookBase = capability && this.coreHooksEnabled ? this.claudeHttpHookBase(input) : null;
    let prepared;
    try {
      prepared = this.providers.prepare(input.provider, input.terminalSessionId, this.coreHooksEnabled, decisions, budgetMs,
        httpHookBase ?? undefined, captureResult);
    } catch (error) {
      if (capability) this.gateway.revokeTerminalSession(input.terminalSessionId, capability.capabilityToken);
      this.turnAuthorityChanged(input.terminalSessionId); // Registration already replaced any preceding lease.
      throw error;
    }
    const launch = { decisions, captureResult, turnCompletion: prepared.turnCompletion === true, identity: randomUUID() };
    this.activeSessions.set(input.terminalSessionId, launch);
    this.turnAuthorityChanged(input.terminalSessionId);
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
        if (this.activeSessions.get(input.terminalSessionId) === launch) {
          this.activeSessions.delete(input.terminalSessionId);
          this.turnAuthorityChanged(input.terminalSessionId);
        }
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

  /** An epoch alone is insufficient: permission hooks may open one without any completion transport. */
  currentTurnIdentity(sessionId: string): string | null {
    const launch = this.activeSessions.get(sessionId);
    if (!this.coreHooksEnabled || !launch?.turnCompletion) return null;
    const epoch = this.gateway.currentTurnEpoch(sessionId);
    return epoch === null ? null : `${launch.identity}:${epoch}`;
  }

  private turnAuthorityChanged(sessionId: string): void {
    try { this.onTurnAuthorityChanged?.(sessionId); } catch { /* observers cannot break launch cleanup */ }
  }

  setCoreHooksEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.coreHooksEnabled === next) return;
    this.coreHooksEnabled = next;
    if (next) return;
    // Decisions and explicitly requested result capture are independent of lifecycle UI updates.
    for (const [terminalSessionId, launch] of this.activeSessions) {
      launch.turnCompletion = false; // Enabling UI later cannot install hooks in an already running launch.
      this.turnAuthorityChanged(terminalSessionId);
      if (!launch.decisions && !launch.captureResult) this.gateway.revokeTerminalSession(terminalSessionId);
    }
  }
}

function isLiveGrant(expiresAt: number | undefined): expiresAt is number {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > Date.now();
}
