# ADR: Additive Marquee Selection on Empty Canvas

**Date:** 2026-09-13
**Scope / Component:** empty-canvas pointer navigation, multi-window selection, and group movement
**Risk/Strictness Profile:** Production
**Status:** Accepted

**Main intake clarification (2026-09-15):** the rationale and original validation below are
source-branch history. Selection code already accepted through PR #47 is separate from the
pending attention feature in PR #37. See the
[main intake amendment](./ADR-20260913-selective-intake-from-v121.md#main-intake-amendment-2026-09-15).

**Amends:** [ADR: Use Intent-Aware Canvas Navigation](./ADR-20260808-intent-aware-canvas-navigation.md)
**Amended by:** [ADR: Marquee Selection and Group Drag Cover Every Window Type](./ADR-20260914-marquee-and-group-drag-cover-every-window-type.md)
**Implementation:** [`useCanvasPointerNavigation.ts`](../../src/renderer/src/features/workspace/useCanvasPointerNavigation.ts), [`WorkspaceCanvas.tsx`](../../src/renderer/src/features/workspace/WorkspaceCanvas.tsx), and [`.canvas-marquee`](../../src/renderer/src/styles/app.css)
**Evidence updated 2026-09-14:** the `data-session-id` source contract this record claims under
Validation and Confidence is not asserted by the suite — commit `d044985` removed that assertion from
[`tests/canvas-selection-gestures.test.mjs`](../../tests/canvas-selection-gestures.test.mjs), and the
amending record replaces it with the layer-id contract. The claim below is left as the historical
record.

## Context and Problem Statement

The canvas now needs to move several windows as one group. Upstream has exactly one selection at a
time (`activeSessionId`), and the accepted navigation ADR deliberately keeps logical focus and
selection separate while stating that it "does not restrict future multi-select" (Invariant 11).

Any multi-select gesture has to coexist with the invariant that record declares
(Invariant 2): **blank-canvas primary drag always pans.** Pan on empty canvas is the oldest and
most used navigation gesture, and a marquee that stole the plain drag would break it. The canvas
already consumes `Meta`/`Ctrl` (wheel-only capture) and `Alt` (full navigation override) by
default, so a new gesture must not collide with those either.

## Amendment Relation

This record **amends** [ADR-20260808-intent-aware-canvas-navigation](./ADR-20260808-intent-aware-canvas-navigation.md).
It does not supersede it. That record's rationale, settings migration, ownership table, and intent
classifier remain in force unchanged, and its Invariant 2 is the constraint this decision is built
around rather than a clause it replaces. This record adds one gesture and the selection state that
gesture produces; the earlier record's Invariant 11 explicitly anticipated it.

## Decision Drivers

- Blank-canvas primary drag must keep panning, with no modifier, no threshold change, and no
  behavior change for existing users.
- The gesture must be additive: it may not take a chord that wheel capture, the full navigation
  override, or an action shortcut already owns.
- A press that does not travel must stay a plain click, so focus assignment and click-through are
  untouched.
- Focus and selection stay independent; multi-select must not become a second focus model.
- Moving a selection must not double-apply a card's own drag.

## Options Considered

### Make plain empty-canvas drag a marquee and pan only with a modifier

This is the conventional desktop model, but it inverts the existing gesture: every current user's
plain drag would start selecting instead of panning. It also directly contradicts the accepted
navigation ADR's Invariant 2. Rejected.

### Reuse the full navigation override chord for marquee

`Alt` already owns wheel and pointer drag for navigation. Overloading it would make the same press
mean "pan" or "select" depending on prior state and would give the override two owners. Rejected.

### Derive multi-select from the existing single selection plus modifier-clicks on cards

Modifier-click builds a selection one window at a time and cannot express "everything in this
region", which is the actual need on a populated canvas. It also puts another gesture on the cards,
where drag already owns window movement. Rejected.

### `Shift`+drag on empty canvas, exclusive of the other modifiers

`Shift` is not part of either default navigation binding, so it can be additive. Requiring
`Shift` with no `Alt`, `Ctrl`, or `Meta` keeps all three overrides intact and makes the gesture
unambiguous. Selected.

## Decision Outcome

### Gesture contract

Pointer down on the capture path resolves in this order:

1. Middle button or an active navigation mouse binding starts a pan.
2. Primary button on a terminal card that is part of a selection larger than one starts a group
   drag.
3. Primary button on empty canvas (no terminal card, no interactive widget target):
   - `Shift` held and `Alt`, `Ctrl`, and `Meta` not held starts a marquee;
   - otherwise the marquee selection is cleared and the event falls through to the ordinary
     primary-drag pan.
4. Otherwise the existing override behavior applies.

The modifier exclusivity is what preserves the additive property:

| Press on empty canvas | Result |
|---|---|
| Primary drag | Pan, exactly as before |
| `Shift`+drag | Marquee selection |
| `Alt`+drag (`Shift` also held or not) | Full-navigation pan, unchanged |

### Marquee and selection

The marquee rect is the axis-aligned rectangle between press and current pointer position, rendered
as an absolutely positioned overlay with `pointer-events: none`, and converted to world space to
test intersection with rendered session bounds. Every intersecting window joins the selection; an
empty intersection clears it.

A press that does not travel past the existing canvas drag threshold goes to the ordinary click
path with no selection change and no click suppression. A travelled marquee suppresses the
follow-up click so the press cannot also focus or activate whatever is under the pointer.

Dragging any window that is part of a multi-window selection moves the whole selection by one
delta. The pressed card's own drag does not also run, so the movement is applied once. The group
preview is transient pointer state; the committed bounds are written through the normal
`onSessionBoundsChange` path.

Selection from the marquee is set-like and presentation-only: it does not change logical input
focus, the camera, the PTY, or any persisted session field.

## Invariants

1. Blank-canvas primary drag pans; this record does not weaken the navigation ADR's Invariant 2.
2. The marquee requires `Shift` with no `Alt`, `Ctrl`, or `Meta`.
3. Focus and selection remain independent; multi-select does not focus windows.
4. A press without travel is a plain click and changes neither selection nor focus.
5. A travelled marquee suppresses exactly one follow-up click.
6. A group drag applies one delta to every selected window; the pressed card does not apply a second.
7. No pointer gesture introduces a keyboard chord, a persisted setting, or a PTY-visible event.

## Consequences and Mitigations

- Multi-window movement is available without changing any existing navigation gesture.
- Windows can now be selected outside the single active session. Surfaces that still key off the
  single active session (focus, title bar, palette targeting) are unaffected by design; the
  selection is additional state, not a replacement focus model.
- Group movement commits bounds for every member, so a large selection writes more bounds per drop.
  Movement is previewed transiently and committed once on pointer up, which keeps that bounded.
- `Shift` is now consumed for this gesture on empty canvas. Empty-canvas `Shift`+drag previously
  fell through to a pan; users who relied on that have the unmodified plain drag and the `Alt`
  override.

## Validation and Confidence

The gesture resolution, modifier exclusivity, threshold behavior, world-space intersection, click
suppression, and single-delta group movement are all fixed in unit coverage over the pointer
controller, and the marquee overlay is a pure function of pointer state.

Confidence is high: the decision reuses the existing drag threshold, camera geometry, and bounds
commit path, and adds no new persisted state. The residual risk is gesture discoverability, which
is a hint-surface concern (the canvas help already lists `Shift + drag`) rather than a contract
risk.

The decision is falsified if a plain empty-canvas primary drag stops panning, if a marquee press
also focuses what it covers, if a group drag applies two deltas, or if a non-shift drag can start a
marquee.

## References

- [ADR: Use Intent-Aware Canvas Navigation](./ADR-20260808-intent-aware-canvas-navigation.md)
- [`useCanvasPointerNavigation.ts`](../../src/renderer/src/features/workspace/useCanvasPointerNavigation.ts)
- [`WorkspaceCanvas.tsx`](../../src/renderer/src/features/workspace/WorkspaceCanvas.tsx)
