# ADR: Selective Intake from the v1.2.1 Line

**Date:** 2026-09-13
**Scope / Component:** merge strategy between the upstream line and the v1.2.1 feature line
**Risk/Strictness Profile:** Production
**Status:** Accepted
**Related:** [ADR: Keep Provider Lifecycle Owned by the Upstream Runtime](./ADR-20260913-provider-lifecycle-owned-by-upstream.md), [ADR: Additive Marquee Selection on Empty Canvas](./ADR-20260913-shift-drag-marquee-selection.md), [ADR: Keep `runAsNode` Enabled in Packaged Builds](./ADR-20260913-packaged-fuses-keep-run-as-node.md)
**Implementation:** the merged tree itself; see the ported and dropped inventories below

**Main intake clarification (2026-09-15):** the original status, inventories, and validation
describe the contributor's source branch. They are not an inventory of shipped upstream features.
See the [main intake amendment](#main-intake-amendment-2026-09-15) for the acceptance boundary.

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
| Packaged hardening | Node-options and CLI-inspect fuses closed, embedded asar integrity validated; see the fuse ADR for the `runAsNode` exception |
| Secret-scan precision | Identifier-embedded key prefixes no longer produce false positives |
| Renderer crash recovery | Main logs the reason and reloads the startup surface instead of leaving a blank window; sessions and services stay alive |
| Scrollback search | `Ctrl+Shift+F` in a focused terminal card opens an in-card search row; Escape returns focus so keystrokes never leak into the PTY |
| Fit to content | Canvas control and palette command framing the HOME zone and every window, clamped to the existing zoom range; no keyboard chord |
| Directional focus | `Alt+Arrow` moves focus to the nearest window strictly ahead in that direction |
| Provider titles | A non-customized card header shows the title the provider sets through OSC 0/2, falling back to the path display; display only |
| Palette path search | Palette entries match on the session path in addition to label and provider |
| Inspect to agent | Browser card Inspect control plus one structured line written into the newest running agent session, with stale references refused |
| Attention queue | HOME queue of sessions needing approval or failed, derived only from session snapshots |
| Attention notification | Persistent attention ring and one OS notification per transition into approval or failure, with a persisted setting |
| Visibility-gated output | Cards below the summary threshold stop receiving streamed output; the missed suffix is replayed exactly once on return |
| Focused-card WebGL | One WebGL context, only for the focused terminal card, with DOM-renderer fallback |
| Marquee selection | `Shift`+drag on empty canvas selects intersecting windows; see the marquee ADR |
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

## Main intake amendment 2026-09-15

Upstream imports only the seven documentation changes from
[`cff22e20`](https://github.com/howdeploy/CanvasTTY/commit/cff22e20c10d502111b62ebd79110e3e0717a313)
in [PR #45](https://github.com/howdeploy/CanvasTTY/pull/45). The original record above remains
source-branch history. Importing its text does not approve the implementation commits underneath
that stacked PR, and its original validation claims do not establish upstream release coverage.

At this intake, upstream main is based on
[`dd27b8a`](https://github.com/howdeploy/CanvasTTY/commit/dd27b8a9e5b655337af8f33fda1a5e9bd8f52381),
which accepted the selected provider and behavior fixes from PRs #38–40 and #42–44 through
[PR #47](https://github.com/howdeploy/CanvasTTY/pull/47).

The following feature PRs remain outside main pending rework:

- [#32](https://github.com/howdeploy/CanvasTTY/pull/32): orchestration requires an explicit
  launch-menu option and support for every agent provider.
- [#34](https://github.com/howdeploy/CanvasTTY/pull/34): independent browser cards require
  resize, movement, and rendering corrections with platform-specific evidence.
- [#35](https://github.com/howdeploy/CanvasTTY/pull/35): app permissions, fuse changes, recovery,
  hidden-output gating, notifications, and self-update remain pending as a feature bundle.
- [#36](https://github.com/howdeploy/CanvasTTY/pull/36): terminal and workspace additions require
  title-editing, shortcut, and browser-integration rework.
- [#37](https://github.com/howdeploy/CanvasTTY/pull/37): attention UI requires settings for enabling
  it and choosing its position, plus scaling, contrast, and error-detail improvements. Some
  selection code already reached main with the accepted behavior fixes; this does not accept
  the remaining attention feature.
- [#41](https://github.com/howdeploy/CanvasTTY/pull/41): the two-row HOME launcher remains pending
  a solution for HOME sizing, scaling, and button usability.

[PR #46](https://github.com/howdeploy/CanvasTTY/pull/46), the README/documentation follow-up, is
excluded from this intake. The only dependency change accompanying these records is the separately
reviewed `js-yaml` override and lockfile pin to `4.3.2`; it remains a development dependency.
