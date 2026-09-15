# ADR: Keep Provider Lifecycle Owned by the Upstream Runtime

**Date:** 2026-09-13
**Scope / Component:** agent session status, approval handling, provider integration, and the preload contract
**Risk/Strictness Profile:** Production
**Status:** Accepted

**Main intake clarification (2026-09-15):** references below to attention queues and OS
notifications describe the source branch; those features remain pending in PRs #35 and #37.
The existing upstream lifecycle owner is retained. See the
[main intake amendment](./ADR-20260913-selective-intake-from-v121.md#main-intake-amendment-2026-09-15).

**Related:** [ADR: Selective Intake from the v1.2.1 Line](./ADR-20260913-selective-intake-from-v121.md)
**Implementation:** [`providerLifecycle.ts`](../../src/main/services/providerLifecycle.ts), [`TerminalManager`](../../src/main/services/TerminalManager.ts), [`agent-runtime/`](../../src/main/services/agent-runtime/), [`LimitsService`](../../src/main/services/LimitsService.ts), and [`contracts.ts`](../../src/shared/contracts.ts)

## Context and Problem Statement

The merged line derives agent status from signals the providers themselves emit. `TerminalManager`
is the single writer of `SessionMetadata.status`: a plain terminal starts `idle`, an agent starts
`unavailable`, and the status moves to `idle`, `working`, or `needs_approval` only when a
machine-readable signal arrives. Two mechanisms feed that writer: generated provider hooks plus the
OpenCode event plugin (`agent-runtime/`, delivered through the runtime gateway), and, for Claude and
Qwen, an OSC 0/2 title parser (`providerLifecycle.ts`). Every snapshot carries a main-owned
monotonic `revision`.

Our v1.2.1 line carried a second, self-made lifecycle source alongside this one: a
`ProviderChannelAdapter` that spoke JSON-RPC to `codex app-server`, mapped `turn/started` and
similar notifications onto session status, and delivered structured approval requests into an
in-app `ApprovalDialog` that replied over its own IPC pair. The same channel was also the only
producer of a per-session token-usage event.

The question is whether that parallel channel is ported into the merged line, or whether lifecycle
stays exclusively owned by the upstream runtime.

## Decision Drivers

- Session status must have exactly one producer. The renderer reconciles snapshots by session ID,
  so two producers of one session's status can emit contradictory states for the same revision.
- Approvals must reach the process that owns the prompt. The provider CLI owns its approval gate
  inside the PTY; the merged line has no transport that carries an approval reply in the opposite
  direction.
- Observed status may not depend on provider cooperation beyond what the shipped CLIs already
  emit, and must not require a provider-specific protocol per provider.
- A number shown in the UI must have a source. Per-session token accounting has no such source in
  this line.

## Options Considered

### Port the v1.2.1 provider channel as a second lifecycle source

This restores structured lifecycle events for Codex, but makes `codex app-server` on one side and
the provider hooks / OSC parser on the other side two writers of the same `SessionStatus`. Each
would need arbitration rules for interleaving, restarts, and out-of-order delivery, and the
resulting status would depend on which source won. Rejected.

### Add a first-class in-app approval channel

Approval buttons on a card require a request to reach the renderer and a decision to travel back
into the provider process. The shared contract has no approval request or reply type, so the
transport would have to be designed, authenticated, and reconciled against the provider's own
prompt state. A synthetic reply that is not a real keystroke also cannot be verified against the
CLI's actual prompt. Rejected.

### Extend the existing Codex app-server connection into a lifecycle source

`LimitsService` already reads Codex quota through the installed CLI's app-server protocol. Reusing
that connection for lifecycle would give one protocol two owners with different failure semantics
(quota reads are cacheable; status is not), and would cover exactly one provider. Rejected.

### Keep observing the upstream runtime and answer approvals in the terminal

The upstream runtime remains the only producer of session status. The desktop renders that status
— attention ring, attention queue, OS notification — and never writes it. Approvals are answered
where the prompt is, in the terminal. Selected.

## Decision Outcome

Session status is produced only by the upstream runtime paths:

| Provider | Signal source |
|---|---|
| Claude, Codex, Qwen, Kimi, Hermes, Grok Build | Generated provider hooks over the runtime gateway (`agent-runtime/ProviderRuntimeLaunch.ts`) |
| OpenCode | The OpenCode event plugin, which reports the same fixed status enum |
| Claude, Qwen | Additionally the OSC 0/2 title prefix parsed in `providerLifecycle.ts` |
| Plain terminal | Process exit code; the session is `idle` while running |

`TerminalManager` writes `SessionMetadata.status` and increments `revision` on every emitted
snapshot. No renderer call sets a status, and no second channel is ported.

Approvals are answered in the terminal. The card shows that a session needs approval and offers
focus and notification, but not a decision control. The status contract stays the fixed enum

```ts
type SessionStatus = "idle" | "working" | "needs_approval" | "unavailable" | "done" | "failed";
```

Per-session token accounting is not implemented and is not approximated from scrollback, title
text, or the limit adapters. The dropped channel was its only producer, so the merged line has no
source for it at all.

## Invariants

1. Exactly one component writes session status: `TerminalManager`.
2. A renderer surface may present status and derive attention state from it, but never sets it.
3. No approval request or reply crosses the preload bridge.
4. `SessionStatus` remains the fixed enum; provider-specific states are mapped into it by the
   owning adapter.
5. A status transition is emitted only when the value actually changes.
6. Provider-limit reads remain read-only and are never used as a lifecycle or accounting source.

## Consequences and Mitigations

- `working` and `needs_approval` come from the upstream runtime. A provider that emits no
  machine-readable signal leaves its session `unavailable` rather than guessed at.
- Approval replies are answered in the terminal. Users cannot approve or deny from the canvas, and
  the keyboard is the only reply path. This is the accepted tradeoff for keeping the provider's
  own prompt authoritative.
- Per-session token accounting has no source in this line and stays unimplemented.
  `TODO:` name the owning protocol and the exact fields before any per-session token number is
  shown in the UI.
- Any future in-app approval UI requires its own transport decision and its own ADR; it must not be
  added as an implicit extension of the status channel.
- Attention features (ring, queue, notification) are pure derivations of the status stream, so they
  survive a change of provider as long as the enum is honoured.

## Validation and Confidence

This decision removes code rather than adding it, so its boundary is verified by absence: the
shared contract contains no approval request or reply type, `TerminalManager` is the only writer of
`SessionMetadata.status`, and no `turn/started` handler exists in the merged tree. Status
transition behavior is covered by the upstream runtime tests.

Confidence is high for the status-observation boundary. Confidence is medium for the approval path:
answering in the terminal is correct today because the provider CLIs own their prompts, but it has
not been exercised against every provider's interactive approval flow.

The decision is falsified if two components can write one session's status, if an approval reply
reaches a provider outside its PTY, or if a per-session token number appears without a named
protocol behind it.

## References

- [Architecture](../ARCHITECTURE.md)
- [`TerminalManager`](../../src/main/services/TerminalManager.ts)
- [`providerLifecycle.ts`](../../src/main/services/providerLifecycle.ts)
- [`LimitsService`](../../src/main/services/LimitsService.ts)
