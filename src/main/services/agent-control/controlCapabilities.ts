import type { AgentProviderId, LaunchRole, ProviderId, SessionRole } from "../../../shared/contracts.ts";
import { AGENT_PROVIDERS } from "../../../shared/contracts.ts";

/**
 * Pure agent-control contract helpers, kept apart from the gateway so the
 * renderer-free parts of the contract can be unit-tested on every platform.
 */

/** Points a controlled shell at the live control descriptor (`connection.json`). */
export const CONTROL_CONNECTION_ENV = "CANVASTTY_CONTROL_CONNECTION";
/** Absolute path of the bundled `canvastty-control.mjs` CLI for that descriptor. */
export const CONTROL_CLI_ENV = "CANVASTTY_CONTROL_CLI";

/** Every agent provider the control endpoint can create workers for. */
export const CONTROL_PROVIDERS: readonly AgentProviderId[] = AGENT_PROVIDERS;

export interface ControlCapabilities {
  /** The worker reports a captured final answer through `result`. */
  result: boolean;
  /**
   * `screen` parses numbered menus that `choose`/`dismiss` can act on. An approval or permission prompt is the person's:
   * an orchestrator's own connection is refused it (NEEDS_PERSON).
   */
  menus: boolean;
}

/**
 * What the endpoint can honestly do for a worker of this provider. Result
 * capture rides the Codex Stop hook and menu parsing reads Codex's TUI, so
 * both are Codex-only; every other provider's `screen` text is the only
 * readiness evidence and its `result` completes as `no_result`.
 */
export function controlCapabilities(provider: ProviderId): ControlCapabilities {
  const codex = provider === "codex";
  return { result: codex, menus: codex };
}

export function isControlProvider(value: unknown): value is AgentProviderId {
  return typeof value === "string" && (CONTROL_PROVIDERS as readonly string[]).includes(value);
}

/** Normalizes a persisted or requested role; anything but an explicit orchestrator is an agent. */
export function launchRole(value: unknown): LaunchRole {
  return value === "orchestrator" ? "orchestrator" : "agent";
}

export function isLaunchRole(value: unknown): value is LaunchRole {
  return value === "agent" || value === "orchestrator";
}

export interface ControlConnection {
  /** Absolute path of the descriptor the gateway wrote at `start()` (the person's own automation). */
  connectionPath: string;
  /** Absolute path of the CLI script that reads that descriptor. */
  cliPath: string;
  /**
   * A private connection for one orchestrator session (AgentControlGateway.grantSession): what the session gets
   * instead of the app-wide descriptor. Null: the session gets none.
   */
  grant?: (sessionId: string) => string | null;
}

/**
 * Environment an orchestrator session receives so the bundled CLI works
 * without setup; ordinary sessions get nothing and inherit nothing (see
 * `terminalEnvironment`, which strips both variables from the parent).
 */
export function controlEnvironment(role: SessionRole, connection: ControlConnection | null, sessionId?: string): Record<string, string> {
  if (role !== "orchestrator" || !connection) return {};
  // An agent never gets the person's app-wide descriptor when the gateway can give it its own.
  const path = connection.grant ? (sessionId ? connection.grant(sessionId) : null) : connection.connectionPath;
  return path ? { [CONTROL_CONNECTION_ENV]: path, [CONTROL_CLI_ENV]: connection.cliPath } : {};
}
