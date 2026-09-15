# ADR: Marquee Selection and Group Drag Cover Every Window Type

**Date:** 2026-09-14
**Scope / Component:** empty-canvas marquee intersection, group drag membership, and window commit dispatch
**Risk/Strictness Profile:** Production
**Status:** Accepted

**Main intake clarification (2026-09-15):** the future-tense implementation notes and references
to an earlier Invariant 8 describe source-branch history, not the exact predecessor text imported
here. Upstream already has layer-based selection through PR #47; importing this record does not
accept the pending attention or independent-browser features. See the
[main intake amendment](./ADR-20260913-selective-intake-from-v121.md#main-intake-amendment-2026-09-15).

**Amends:** [ADR: Additive Marquee Selection on Empty Canvas](./ADR-20260913-shift-drag-marquee-selection.md)
**Implementation:** [`canvasSelectionGesture.ts`](../../src/renderer/src/features/workspace/canvasSelectionGesture.ts), [`useCanvasPointerNavigation.ts`](../../src/renderer/src/features/workspace/useCanvasPointerNavigation.ts), and [`WorkspaceCanvas.tsx`](../../src/renderer/src/features/workspace/WorkspaceCanvas.tsx)

## Context and Problem Statement

[ADR-20260913-shift-drag-marquee-selection](./ADR-20260913-shift-drag-marquee-selection.md) introduced
the marquee but deliberately scoped it to terminal cards. Its Invariant 8 states that the marquee
tests terminal-card bounds only and that plugin canvases, the built-in browser, and sticky notes are
never tested for intersection and never join the selection.

The canvas renders four kinds of window side by side, and the operator requires that a group be able
to move every kind of window. A marquee that visibly sweeps across a browser card and a sticky note
while selecting neither is a lying affordance on a canvas whose whole point is arranging windows
spatially. The record that fixes the terminal-only scope therefore has to be amended, not quietly
overridden in code.

The scope change is narrower than it looks, because the canvas already carries the identity and the
geometry the wider selection needs:

- each of the four card roots renders `data-canvas-layer-id` — `terminal:<id>`
  ([`TerminalCard.tsx:574`](../../src/renderer/src/features/terminal/TerminalCard.tsx)),
  `plugin:<id>`
  ([`PluginCanvasCard.tsx:190`](../../src/renderer/src/features/plugins/PluginCanvasCard.tsx)),
  `browser` ([`BrowserCard.tsx:457`](../../src/renderer/src/features/browser/BrowserCard.tsx)), and
  `note:<id>` ([`StickyNoteCard.tsx:204`](../../src/renderer/src/features/notes/StickyNoteCard.tsx));
- `boundsByLayer` in `WorkspaceCanvas.tsx` is already a `Map<layerId, SessionBounds>` over every
  rendered layer, so the bounds source needs no new plumbing;
- press classification, however, recognizes only `.terminal-card`, and the member commit uses a bare
  `translateBounds` over terminal sessions.

One asymmetry has to be resolved inside the selection owner rather than by changing a card:
`BrowserCard` commits bounds through a single-argument callback while the other three cards take
`(id, bounds)`. The unified commit therefore lives in `WorkspaceCanvas.commitGroupDrag`, which
already owns `settings.browserCanvas` and can dispatch by layer kind.

## Amendment Relation

This record **amends** [ADR-20260913-shift-drag-marquee-selection](./ADR-20260913-shift-drag-marquee-selection.md).
It does not supersede it. The gesture itself, its modifier exclusivity, the travel gate, the
transient preview, and the commit-once rule all survive unchanged. Exactly one clause is replaced:
that record's Invariant 8. Everything else in its Invariants list remains in force, and the
invariants restated below preserve its wording where nothing changed:

| Old invariant | Status here |
|---|---|
| 1. Blank-canvas primary drag pans | Survives as Invariant 3 |
| 2. Marquee requires `Shift` with no `Alt`/`Ctrl`/`Meta` | Survives as Invariant 4 |
| 3. Focus and selection remain independent | Survives as Invariant 5 |
| 4. A press without travel is a plain click | Survives as Invariant 6 |
| 5. A travelled marquee suppresses one follow-up click | Survives as Invariant 7 |
| 6. One delta per group drag; the pressed card does not apply a second | Survives as Invariant 8 |
| 7. No keyboard chord, persisted setting, or PTY-visible event | Survives as Invariant 9 |
| 8. The marquee tests terminal-card bounds only | **Replaced** by Invariant 2 |
| Validation (not an invariant): "the suite also asserts source contracts", including the terminal card's `data-session-id` | **Replaced** — commit `d044985` removed that assertion from the suite; card identity is the layer id (recorded 2026-09-14) |

Blank-canvas primary drag still pans, focus and selection are still independent, a press below the
shared drag threshold is still a click, and a group commit still happens once per gesture. The
navigation ADR's Invariant 2 is untouched by this record as well.

## Decision Drivers

- A group must be able to move every kind of window on the canvas, not terminals alone (operator
  decision).
- One identity has to serve marquee intersection, press classification, preview, and commit; a
  second per-type identity scheme would let the four stages disagree.
- No card component may change its bounds callback signature; the browser card's single-argument
  commit and the `(id, bounds)` commits of the other three stay as they are.
- Card controls must remain controls: widening membership must not turn the sticky-note editor or an
  interactive plugin surface into a group-drag anchor.
- The selection stays presentation-only and adds no persisted state, no new gesture, and no
  PTY-visible event.

## Options Considered

### Keep the terminal-only selection

This is the accepted record's current scope, and it is internally consistent. It is rejected because
it leaves three of four rendered window types immovable as a group while the marquee still visually
sweeps over them, and because the operator has explicitly required group movement of every window
type. Keeping it would also preserve the split `data-session-id` / `.terminal-card` card identity,
which cannot name a browser or a note at all.

### Select by a wrapping container instead of by bounds

Under this model a card joins the selection by belonging to a named group, region, or parent
element, and the marquee resolves membership through that container rather than by geometric
intersection. The canvas has no such nesting: all four card types are siblings inside one scene and
are positioned in world space, while regions are decorative labels with no ownership of the windows
drawn over them. Adopting a container model would mean restructuring the layer tree and making
marquee membership a function of a grouping concept users never created. Rejected.

### Test the rendered bounds of every layer, keyed by canvas layer id

`boundsByLayer` is already a map over every rendered layer, and every card root already publishes the
same layer id attribute. Intersection, membership, preview, and commit can all speak one identity
with no new geometry source and no new persisted field. Selected.

## Decision Outcome

### Layer identity

The selection is a `ReadonlySet<layerId>`, where a layer id is exactly what each card root publishes
in `data-canvas-layer-id`: `terminal:<sessionId>`, `plugin:<instanceId>`, `browser`, or
`note:<noteId>`. A pure `parseCanvasLayerId` maps a layer id to its kind and target id, and is the
single place that decodes the scheme. Card identity for press classification comes from
`target.closest("[data-canvas-layer-id]")`; the terminal-only `.terminal-card` selector and
`data-session-id` stop being the identity of record.

### Marquee intersection

`selectMarquee` iterates `boundsByLayer` instead of the rendered terminal sessions. Every layer whose
rendered bounds intersect the marquee rect in world space joins the selection; an empty intersection
clears it. All four window types are candidates, and the intersection test itself does not
special-case any of them.

### Press classification and controls

A press is a potential group drag when the pressed element resolves to a layer id that is part of a
selection larger than one, and the press is not on a card control. The control selector widens from
`button, input, .terminal-card__resize-handle` to `button, input, textarea,
.terminal-card__resize-handle`: `textarea` is required because the sticky-note editor is one, and a
note editor that became a drag anchor would both break text selection and make the note undraggable
from anywhere else. The resize handle class is already shared by all four cards, so no card markup
change is implied.

### Group drag, preview, and commit

A travelled group drag applies one rigid delta to every selected window; the pressed window does not
apply a second movement of its own. The transient preview is applied to all four card types, exactly
as the committed delta is, so a previewed group and a committed group occupy the same positions.
The commit is dispatched by layer kind inside `WorkspaceCanvas.commitGroupDrag`:

- `terminal:<id>` and `note:<id>` and `plugin:<id>` use their existing `(id, bounds)` callbacks;
- `browser` merges the moved position into `settings.browserCanvas`, changing position only.

The group commit reuses the snapping the per-card drag already performs, anchored on the pressed
window: only the anchor snaps, its snapped delta is applied rigidly to every member, and selection
members are excluded from the anchor's snap targets so a group cannot snap onto itself.

A browser card still drags only from its chrome: a press on the live page is a native view and never
reaches the workspace DOM, so a group drag cannot start from the page surface. This matches the
existing single-card behavior.

### Selection affordance

Every selected window shows a selected affordance, not just terminal cards. Terminal cards and the
browser card already render one; plugin canvases and sticky notes gain theirs. The marquee rect
overlay itself is unchanged.

## Invariants

1. Selection identity is the canvas layer id; terminal cards, plugin canvases, the built-in browser,
   and sticky notes are all candidates.
2. The marquee intersects the rendered bounds of every window type. Plugin canvases, the built-in
   browser, and sticky notes are tested for intersection and can join the selection. **This replaces
   the amended record's Invariant 8.**
3. Blank-canvas primary drag pans; this record does not weaken the navigation ADR's Invariant 2.
4. The marquee requires `Shift` with no `Alt`, `Ctrl`, or `Meta`.
5. Focus and selection remain independent; multi-select does not focus windows, does not change
   `activeSessionId`, and does not move the camera.
6. A press without travel is a plain click and changes neither selection nor focus.
7. A travelled marquee suppresses exactly one follow-up click.
8. A group drag applies one delta to every selected window; the pressed window does not apply a second.
9. No pointer gesture introduces a keyboard chord, a persisted setting, or a PTY-visible event.
10. A card control — a button, input, textarea, or resize handle — is never a group-drag anchor.

## Consequences and Mitigations

- Any window on the canvas can be selected by the marquee and moved as one group, and the selection
  now matches what the canvas visibly shows.
- The group commit writes one bounds value per member across four different persisted surfaces. A
  large selection therefore writes more settings per drop than before, and the settings store's
  atomic write queue serializes those writes. Movement stays previewed transiently and committed
  once per gesture, which is what bounds the cost.
- A browser selected in a group keeps its size: only its position moves.
- The widened control selector keeps textareas and inputs out of group drag. The cost is that a
  future interactive surface inside a card is excluded by default rather than by an explicit list.
- The anchor-only snapping rule means the preview during the gesture is unsnapped and the group
  settles onto the grid at pointer up, the same tradeoff the per-card drag already makes.
- Plugin canvases and sticky notes gain a selected affordance, which is a new visual surface for
  those two card types.

## Validation and Confidence

This record precedes the implementation; the code lands in the group-selection phase that follows it.
The coverage below is the contract that change must satisfy.

The pure gesture module gains direct tests for `parseCanvasLayerId` and for the commit dispatch by
layer kind, since both are the new decision surface. The existing
[`canvas-selection-gestures.test.mjs`](../../tests/canvas-selection-gestures.test.mjs) suite is
updated where it pins the terminal-only model: its cardinality-2/8/9/11 cases assert the
terminal-only intersection predicate, the literal `data-session-id`, the `closest(".terminal-card")`
source text, "selection never moves focus", and single-commit-on-travel. The last two assertions
survive as invariants 5 and 8 and keep failing if the selection starts moving focus or committing
twice; the first two are replaced by the layer-id contract.

Confidence is high for the identity and intersection model, because it reuses a bounds map that
already covers every rendered layer and an attribute every card root already publishes. Medium for
the group commit across four persisted surfaces, which no test drives end to end, and for the
selection affordances that plugin canvases and sticky notes do not yet have.

The decision is falsified if the marquee can pass over a plugin canvas, the browser, or a sticky note
without selecting it, if a group drag moves a member by a different delta than the anchor, if a
window joins a group while its size changes, or if a card control can start a group drag.

## References

- [ADR: Additive Marquee Selection on Empty Canvas](./ADR-20260913-shift-drag-marquee-selection.md)
- [ADR: Use Intent-Aware Canvas Navigation](./ADR-20260808-intent-aware-canvas-navigation.md)
- [`canvasSelectionGesture.ts`](../../src/renderer/src/features/workspace/canvasSelectionGesture.ts)
- [`WorkspaceCanvas.tsx`](../../src/renderer/src/features/workspace/WorkspaceCanvas.tsx)
- [`tests/canvas-selection-gestures.test.mjs`](../../tests/canvas-selection-gestures.test.mjs)
