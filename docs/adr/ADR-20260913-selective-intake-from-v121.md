# ADR: Selective Intake from the v1.2.1 Line

**Date:** 2026-09-13
**Scope / Component:** merge strategy between the upstream line and the v1.2.1 feature line
**Risk/Strictness Profile:** Production
**Status:** Accepted
**Related:** [ADR: Keep Provider Lifecycle Owned by the Upstream Runtime](./ADR-20260913-provider-lifecycle-owned-by-upstream.md), [ADR: Additive Marquee Selection on Empty Canvas](./ADR-20260913-shift-drag-marquee-selection.md), [ADR: Keep `runAsNode` Enabled in Packaged Builds](./ADR-20260913-packaged-fuses-keep-run-as-node.md)
**Implementation:** the merged tree itself; see the ported and dropped inventories below

## Context and Problem Statement

Two lines diverged from the same origin. The upstream line continued to v1.5.1 and owns the
provider runtime, terminal session persistence, plugin packaging hardening, and the canvas command
palette. Our v1.2.1 line carries a set of canvas and safety features that upstream does not have,
plus a number of parallel implementations of things upstream already owns.

The question is not "how do we merge" but "what is the smallest useful intake": which v1.2.1
features are worth porting into the upstream tree, and which of them are only duplicates of an
existing upstream owner.

## Decision Drivers

- Every merged feature must have exactly one owner in the resulting tree.
- A duplicated owner is a defect, not a feature: two implementations of one responsibility diverge
  silently and both keep paying maintenance.
- The intake must be verifiable feature by feature, so a dropped item can be reconsidered on its
  own merits later.
- A runtime rewrite is a different class of change than a feature port and must be justified by its
  own measurements, not by the merge.

## Options Considered

### Merge the v1.2.1 branch wholesale

This brings every v1.2.1 feature in one operation, but it also brings our session-restore store,
our provider channel, our approval dialog, our command palette, our per-task session scope, and our
plugin manifest checks alongside the upstream equivalents. That produces two writers for session
persistence, provider lifecycle, approvals, palette state, and manifest validation. Rejected.

### Port every v1.2.1 item individually, including the duplicates

Item-by-item porting is the right granularity, but including the duplicates only moves the
collision into the merged tree. Porting a duplicate still leaves the reconciliation work and the
second implementation. Rejected.

### Port the disjoint features only, and drop every item that already has an upstream owner

Take the features that add capability upstream lacks; leave each dropped responsibility with its
existing upstream implementation. Selected.

### Also port the Tauri runtime rewrite from the fork

The fork pursued a Tauri 2 + WebView2 runtime on the hypothesis of a large idle-memory saving. Its
own measurements do not support the port: the expected saving was recorded as a hypothesis, and the
corrected release idle measurement in the fork's ADR-001 amendment (2026-08-14) is
WebView2 494 MB + core 75 MB + app 24 MB ≈ 593 MB, which did not confirm the expected saving
(WebView2 remains Chromium, like Electron). A runtime rewrite is also not a feature port: it
replaces the owner of every native surface at once. Rejected.

## Decision Outcome

### Ported

| Item | What was taken |
|---|---|
| Default-session permission denial | Main denies browser permission requests, checks, and device permissions on the default session; the built-in browser keeps its own partition policy |
| Packaged hardening | Node-options and CLI-inspect fuses closed, embedded asar integrity validation requested where Electron implements it (macOS 16+, Windows 30+); see the fuse ADR for the `runAsNode` exception |
| Secret-scan precision | Identifier-embedded key prefixes no longer produce false positives |
| Renderer crash recovery | Main logs the reason and exit code and reloads the application surface instead of leaving a blank window; terminal services and live sessions keep running across the recovery |
| Scrollback search | `Ctrl+Shift+F` in a focused terminal card opens an in-card search row; Escape returns focus so keystrokes never leak into the PTY |
| Fit to content | Canvas control and palette command framing the HOME zone and every window, clamped to the existing zoom range; no keyboard chord |
| Directional focus | `Alt+Arrow` moves focus to the nearest window strictly ahead in that direction |
| Provider titles | A non-customized card header shows the title the provider sets through OSC 0/2, falling back to the path display; display only |
| Palette path search | Palette entries match on the session path in addition to label and provider |
| Inspect to agent | Browser card Inspect control observes up to 20 elements and lists all of them, so every observed element is reachable; one structured line written into the newest running agent session, with stale references refused and awaiting-decision sessions skipped |
| Attention queue | HOME queue of sessions needing approval or failed, derived only from session snapshots |
| Attention notification | Persistent attention ring and one OS notification per genuine transition into approval or failure; repeated snapshots and already-seen restore-time failures stay silent, while a failure the user triggers by restarting notifies; persisted setting |
| Visibility-gated output | Cards below the summary threshold stop receiving streamed output; the missed output is replayed once on return, and a stretch longer than the bounded history is reported instead of looking continuous |
| Focused-card WebGL | One WebGL context, only for the focused terminal card, with DOM-renderer fallback |
| Marquee selection | `Shift`+drag on empty canvas selects intersecting terminal cards; see the marquee ADR |
| Self-update surface | One settings row with explicit idle, checking, download, ready, and unavailable states |

### Dropped, with the existing upstream owner

| Dropped v1.2.1 item | Upstream owner |
|---|---|
| `SessionRestoreStore` | [`TerminalSessionStore`](../../src/main/services/TerminalSessionStore.ts) plus the `restoreTerminalSessions` setting, which persists window descriptors and relaunches agents through their provider's native continue mode |
| `ProviderChannelAdapter` and the approval dialog | The upstream provider runtime and its runtime gateway; approvals are answered in the terminal, as recorded in the provider-lifecycle ADR |
| `CommandPalette` | [`CanvasCommandPalette`](../../src/renderer/src/features/workspace/CanvasCommandPalette.tsx) |
| Plugin manifest hardening | `PluginManager` manifest validation, package inspection, symlink rejection, entry/byte limits, and package-root containment |
| Per-task session scope (`taskId`, worktree resolution) | No upstream owner exists: the upstream launch contract scopes a session by its working directory (`AgentLaunchRequest.cwd`) and has no task or worktree concept. Porting it would have introduced a new owner rather than merging into one |

## Invariants

1. No responsibility in the merged tree has two implementations.
2. A dropped item is dropped, not aliased: no stub, shim, or re-export keeps its name alive.
3. Ported features keep upstream's contracts at their shared boundaries rather than reintroducing
   v1.2.1 shapes.
4. The provenance of each ported or dropped item remains answerable from this record.

## Consequences and Mitigations

- The ported set is small relative to the v1.2.1 branch, and every dropped item except per-task
  session scope maps onto an implementation that already exists and is already tested upstream.
- Per-task session scope does not exist in the merged line. Sessions are scoped by working
  directory. Reintroducing task scoping later is a new feature with a new owner, not a restoration.
- Dropping our session-restore store means the merged line uses upstream's restore semantics
  (validated descriptors, relaunch through the provider's continue mode) rather than v1.2.1's.
- Dropping the approval dialog removes in-canvas approval replies; this is deliberate and is
  recorded separately.
- Because the intake was itemized, a dropped feature can be reconsidered alone without reopening
  the merge.

## Validation and Confidence

The inventory is verified against the merged tree: the dropped v1.2.1 names
(`SessionRestoreStore`, `ProviderChannelAdapter`, `ApprovalDialog`, `taskId`), and any worktree
resolution, have no occurrences in `src/`; the only palette identifier present is upstream's
`CanvasCommandPalette`. Each upstream owner named above is present with its responsibility intact,
and the ported features are verified feature by feature in the merged tree.

Confidence is high for the ownership claims, which are checked by absence and by the presence of
the upstream implementation. Confidence for the Tauri decision rests on the fork's own recorded
measurement; it is a measurement of idle memory on that fork's builds, not an independent
benchmark of this line.

The decision is falsified if any dropped responsibility turns out to have no working upstream
implementation, or if a ported feature leaves two owners behind.

## References

- [Architecture](../ARCHITECTURE.md)
- [ADR: Keep Provider Lifecycle Owned by the Upstream Runtime](./ADR-20260913-provider-lifecycle-owned-by-upstream.md)
- [ADR: Additive Marquee Selection on Empty Canvas](./ADR-20260913-shift-drag-marquee-selection.md)
- [ADR: Keep `runAsNode` Enabled in Packaged Builds](./ADR-20260913-packaged-fuses-keep-run-as-node.md)
