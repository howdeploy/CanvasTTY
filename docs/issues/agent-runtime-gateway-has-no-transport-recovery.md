# Agent runtime gateway has no transport recovery

## Locator

`src/main/services/agent-runtime/RuntimeGateway.ts` (`start`, `close`), wiring in
`src/main/index.ts:286-298`; shared host artifact `WindowsPipeHostTransport`.

## Context

`AgentGateway` (the browser gateway) and `RuntimeGateway` (agent lifecycle hooks) both spawn the same
native host executable and relay client connections through `WindowsPipeHostTransport`. During
verification of the browser-gateway recovery work, the two were measured side by side by killing the
host process of each.

## Observed behaviour

- **Browser gateway (`AgentGateway`).** A killed host is replaced by a genuinely new process
  (measured PIDs `6940 → 21356 → 20592 → 4044` across three cycles), and a session launch succeeds
  after every recovery. Retries are bounded by `MAX_TRANSPORT_RESTART_ATTEMPTS = 3` with 500/1000/2000
  ms backoff; after exhaustion the endpoint stays null, no timer survives, and the application keeps
  running.
- **Runtime gateway (`RuntimeGateway`).** A killed host is **permanent**. Measured: after the host was
  killed, no replacement process appeared, the host count stayed at 0, and every subsequent session
  launch failed with `Agent runtime gateway must be started before launching agents.`
  (`RuntimeGateway.ts:131-133`). Recovery required restarting the application. `RuntimeGateway.start()`
  installs no `fatal` listener on its transport and contains no retry path, so nothing observes the
  failure and nothing re-raises the endpoint.

## Root cause

`RuntimeGateway` was never given the transport lifecycle that `AgentGateway` received: it creates a
`WindowsPipeHostTransport`, awaits `start()`, and stores the endpoint, without subscribing to the
transport's `fatal` event or holding a bounded restart policy. The failure therefore leaves
`endpoint = null` with no code that could restore it.

## Deferral reason

The accepted decision behind the current change named the agent/browser gateway ("restart the gateway
as a whole"); extending the same treatment to the lifecycle-hooks gateway changes the recovery
semantics of a second subsystem and needs its own decision, so it stays outside this change's radius.

## Recommended direction

Give `RuntimeGateway` the same bounded recovery the browser gateway has: subscribe to the transport's
`fatal` event, bring the transport to a closed state, then re-create it through the same factory with
a bounded attempt count and backoff; cancel pending retries on `close()` and on the enabled toggle;
report the distinct "restarting" state while retries are in flight instead of the generic
"must be started" error. Prefer sharing one implementation with `AgentGateway` rather than duplicating
the retry policy in a second place.

## Resume condition

Resume when host-process loss on Windows must not require an application restart for agent lifecycle
hooks, or when the two gateways are unified. Behaviour to preserve: a real host failure must still be
observable, retries must stay bounded, and no attempt may outlive `close()`.

## Verification boundary

Kill the runtime-gateway host process while a session that reports lifecycle is running; expect a new
host PID, a successful session launch afterwards, no accumulating host processes or timers after
exhaustion, and an application that stays responsive. Measuring host PIDs and `process` timer counts
is sufficient; a dialog-free, clean-exit application is not affected by this work.
