# ADR: Orchestration MCP Rides the Agent-Bridge Pattern, Gated by Session Role

**Date:** 2026-09-21
**Scope / Component:** heterogeneous subagents, agent bridge protocol, session hierarchy
**Risk/Strictness Profile:** Production (implementation pending)
**Status:** Accepted (core gateway landed; helper and per-provider config injection pending)

**Related:** [ADR: Declarative Provider CLI Command Definitions](./ADR-20260921-provider-cli-command-definitions.md)
**Implementation (landed prerequisites):** [`AgentControlService`](../../src/main/services/AgentControlService.ts), [`TerminalManager`](../../src/main/services/TerminalManager.ts) session roles, `PROVIDER_CAPABILITIES` in [`contracts.ts`](../../src/shared/contracts.ts)

## Context and Problem Statement

Roadmap Stage 2 delivers heterogeneous subagents: an orchestrator agent (Codex, Claude, any
provider) must be able to spawn, prompt, observe, and collect results from other providers'
sessions (`Codex → CanvasTTY → Cursor subagent`). B1–B3 landed the substrate — session roles
and parents, per-provider capability truth, and `AgentControlService` implementing
spawn/send/status/observe/result/cancel/children over ordinary terminal sessions.

What remains is the agent-facing surface: the orchestrator's CLI must discover an MCP server
offering `spawn_agent`, `send_to_agent`, `observe_agent`, `get_agent_result`, `cancel_agent`,
and `list_agents`. CanvasTTY already runs exactly one such pattern in production: the browser
bridge gives agent PTYs a stdio MCP helper (`src/agent-browser/mcp-helper.mjs`) that forwards
tool calls over an authenticated user-local socket/pipe to a main-process gateway, with
one-use bootstrap capabilities, session-scoped reconnect capabilities, heartbeats, payload
caps, and per-provider MCP config injection (`ProviderLaunch.ts`).

The decision is whether orchestration gets its own transport/protocol stack, or reuses the
agent-bridge architecture with a second tool surface.

## Decision Drivers

- An orchestrator PTY is the same trust boundary as a browser-capable agent PTY: untrusted
  model output driving tool calls, authenticated per session, revoked at PTY end.
- Two parallel socket protocols, capability schemes, and helper processes would double the
  security surface for no architectural gain.
- Only sessions the user (or a future UI) marks `role=orchestrator` may receive the surface;
  interactive sessions must not silently gain spawn powers.
- `AgentControlService` already enforces capability truth and the per-parent fan-out cap;
  the MCP layer must not bypass it with its own path to `TerminalManager`.
- Roadmap rule: no background processes when the feature is unused. An orchestrator-only
  surface means zero overhead for ordinary sessions.

## Options Considered

### A dedicated orchestration daemon (TCP port or resident helper)

Rejected: opens a listening port, survives outside the owning PTY's lifetime, and violates
the no-daemon/no-port invariants the browser bridge was hardened to avoid.

### Orchestrator drives TerminalManager directly over renderer IPC

Rejected: the orchestrator is a CLI process inside a PTY; it has no renderer access, and
exposing session control to arbitrary renderer origins would widen the surface for web
content and plugins.

## Decision Outcome

The orchestration MCP is a **second tool surface on the agent-bridge architecture**:

1. A new tool catalog (`agent_*` tools) served by the same stdio MCP helper pattern as
   `canvastty_browser`; the helper is a stateless protocol adapter.
2. The existing gateway gains an `orchestration` dispatch path routed to
   `AgentControlService`, which remains the only writer. Tool calls are scoped to the
   authenticated connection's `terminalSessionId`: `spawn_agent` parents to it, and
   `children`/`send`/`observe`/`result`/`cancel` accept only that connection's descendant
   sessions. No tool ever names an unrelated session.
3. Bootstrap capability injection happens at PTY launch exactly as the browser bridge does
   today (one-use, rotated to session-scoped, revoked at exit), but only for sessions whose
   metadata role is `orchestrator`.
4. Per-provider MCP config injection follows `ProviderLaunch.ts`'s existing adapters
   (CLI args for Claude/Codex/Qwen, inline config for OpenCode, owned temp entries for
   Kimi/Hermes), gated on the same role.
5. Fan-out and depth limits stay in `AgentControlService` (16 children per parent today;
   configurable budgets arrive with roadmap F1). The MCP layer adds no limits of its own.

## Consequences

- One transport, capability scheme, and helper codebase to audit; orchestration inherits
  the browser bridge's hardening (payload caps, heartbeats, exact-user pipes on Windows).
- The browser gateway's protocol version must be bumped when the catalog grows; helpers
  older than the protocol version keep working for browser tools.
- `PROVIDER_CAPABILITIES.send=false` providers cannot be spawned even by an orchestrator;
  the tool result must say so rather than degrade silently.

## Invariants

- Interactive sessions never receive orchestration capabilities.
- The authenticated connection's session id is the only parenting context; cross-session
  access is a protocol error, not a filter.
- `AgentControlService` is the sole mutation path; the gateway holds no session state.
- Disabled feature ⇒ zero helper processes, sockets, or injected MCP configuration.

## Test Plan (for the implementing PR)

- Gateway: role gating (interactive session's tool call rejected), scope enforcement
  (foreign session id rejected), capability lifecycle mirroring the browser bridge tests.
- End-to-end: spawn → send → observe → result over the real helper socket, cancel revokes.
- Provider launch: orchestrator config injected only for `role=orchestrator`; interactive
  launches byte-identical to before.
