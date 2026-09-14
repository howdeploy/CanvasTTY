# ADR: Use Intent-Aware Canvas Navigation

**Date:** 2026-08-08
**Scope / Component:** canvas input, widget ownership, navigation settings, shortcuts, and embedded surfaces
**Risk/Strictness Profile:** Production
**Status:** Accepted
**Related:** [ADR: Preserve Native Browser Wheel Continuity](./ADR-20260808-native-browser-wheel-continuity.md)
**Amended by:** [ADR: Additive Marquee Selection on Empty Canvas](./ADR-20260913-shift-drag-marquee-selection.md)
**Implementation:** [`canvasNavigation`](../../src/shared/canvasNavigation.ts), [`SettingsStore`](../../src/main/services/SettingsStore.ts), [`CanvasNavigationOverride`](../../src/main/services/CanvasNavigationOverride.ts), and [`WorkspaceCanvas`](../../src/renderer/src/features/workspace/WorkspaceCanvas.tsx)

## Context and Problem Statement

CanvasTTY historically interpreted canvas-owned `wheel` input as zoom and ignored `deltaX`.
That preserves a conventional mouse-wheel zoom workflow, but turns two-finger trackpad scroll into
zoom, loses diagonal movement, and does not distinguish pinch-shaped input.

Neither DOM `WheelEvent` nor Electron `MouseWheelInputEvent` identifies a physical trackpad
reliably. Fractional deltas, event frequency, horizontal movement, and precision flags also occur
with Magic Mouse and high-resolution wheels. The contract therefore has to classify observable
intent rather than infer a device.

The canvas also contains independently interactive DOM, xterm, plugin iframe, and native Browser
surfaces. Selection cannot define wheel ownership: focus is single-valued while future selection
may be multi-valued, and decorative widgets must not become wheel sinks. Users additionally need
to distinguish temporary wheel-only capture from a full navigation override that also owns drag.

## Decision Drivers

- New profiles need two-axis scroll-to-pan and pinch-to-zoom behavior.
- Existing profiles must keep their saved mouse-wheel zoom direction, sensitivity, and legacy
  over-widget behavior.
- One focusable input widget may interrupt canvas wheel navigation; non-focusable and unfocused
  widgets may not.
- Wheel-only capture and full wheel/pointer capture need independent bindings and visible scope.
- Ownership must be decided before calling `preventDefault()`.
- Equivalent input from DOM, xterm, plugin, and native Browser paths must reach one classifier.
- The design must not depend on physical-device detection.

## Options Considered

### Keep every canvas wheel event as zoom

This preserves the old implementation but cannot provide two-axis trackpad pan and discards
horizontal intent. Rejected.

### Detect mouse versus trackpad

This could choose a device-specific profile automatically, but the available fields describe an
event stream rather than hardware. Misclassification would change behavior during a gesture and
would not be portable across Chromium platforms. Rejected.

### Keep permanent and temporary wheel capture as separate toggles

An Always toggle plus a temporary shortcut can both be active and describe overlapping policy.
`Off / On / Key` are mutually exclusive forms of the same wheel-only ownership choice. Rejected.

### Derive ownership from selection or every widget under the pointer

Selection does not cover every embedded input surface and must remain free to become
multi-valued. Raw hit testing makes action-only widgets wheel sinks. Rejected.

### Classify intent, use explicit logical focus, and separate wheel-only from full override

Ordinary scroll pans for new profiles; modifier/pinch input zooms; a persisted setting restores
ordinary wheel zoom. A single logical focus and the `Off / On / Key` mode determine whether a
focused widget keeps wheel input. A separate held binding owns wheel and pointer navigation.
Selected.

## Decision Outcome

### Settings and migration

The runtime contract is:

```ts
useScrollWheelToZoom: boolean;
canvasWheelCaptureMode: "off" | "always" | "key";
canvasWheelOverride: string | null;
canvasNavigationOverride: string | null;
```

Fresh profiles use scroll-to-pan, Key capture, `Meta` on macOS or `Ctrl` on Windows/Linux for the
wheel-only binding, and `Alt` for full navigation. The UI renders `Alt` as Option on macOS.
`canvasWheelOverride` remains stored while the mode is Off or On so returning to Key restores the
binding.

Existing profiles without `useScrollWheelToZoom` migrate to `true`. The legacy
`zoomOverApplications` key exists only at the `SettingsStore` persistence boundary:

| Saved state without the new mode | Migrated mode |
|---|---|
| `zoomOverApplications=true` | `always` |
| `zoomOverApplications=false` and valid binding | `key` |
| `zoomOverApplications=false` without binding | `off` |
| Legacy key absent | Current `key` default; legacy key remains absent |
| Invalid or action-conflicting Key binding | `off`; action shortcuts remain unchanged |

An explicit mode change starts compatibility writes: `always` writes the legacy value `true`;
`off` and `key` write `false`. Normalized settings are written to a temporary file and atomically
renamed.

### Binding contract

Both overrides accept modifier-only or modifier-based chords such as `Meta`, `Ctrl+Alt`, and
`Alt+Space`; a bare ordinary key is invalid. Extra held modifiers do not deactivate a configured
binding. Letters and digits are normalized from physical codes so layout changes do not alter a
saved chord.

Modifier-only bindings do not conflict with action shortcuts and do not reserve ordinary keys.
A chord containing an ordinary key is checked against action shortcuts and reserves that key only
after its modifier prefix is held. The two override bindings may be identical; the UI warns that
full navigation dominates because it also owns drag.

Shortcut capture suspends both existing bindings, commits a modifier-plus-key chord on the
ordinary key's `keydown`, retains a modifier-only chord until `keyup`, cancels on Escape, and uses
a synchronous commit guard before asynchronous persistence. Blur, destroyed contents, binding
changes, and capture suspension reset held state. Electron menu shortcuts remain available for
standalone Meta/Ctrl/Shift; standalone Alt and ordinary-key chords use menu suppression where
needed to observe their complete transition without a stuck override.

### Logical focus and ownership

Logical input focus is independent from selection. Click assigns focus only to an opt-in focusable
widget. Hover transfers it only after the configured delay. Leaving a widget cancels a pending
transfer but does not clear assigned focus. Clicking a non-focusable widget preserves focus; only
a click outside all widgets clears it. Terminals, native Browser, plugin iframe/canvas surfaces,
and actually scrollable HOME lists opt in. This leaves selection free to become multi-valued.

| Location and condition | Wheel/pinch owner | Primary drag owner |
|---|---|---|
| Empty canvas | Canvas | Canvas |
| Non-focusable or unfocused widget | Canvas | Widget unless normal canvas hit testing applies |
| Widget publishing `data-canvas-wheel-priority="local"` (the HOME session list) | Widget, focused or not | Widget unless normal canvas hit testing applies |
| Focused widget, Off | Widget | Widget |
| Focused widget, On | Canvas | Widget |
| Focused widget, Key released | Widget | Widget |
| Focused widget, Key held | Canvas | Widget |
| Any widget, full override held | Canvas | Canvas |

The native Browser follows this policy at a synchronous preload boundary and then applies the
continuity mechanism in the related ADR. Placeholder/summary content is not a live page and is
always canvas-owned.

Full-override drag is latched through pointer up or cancel even if the chord is released. Its
follow-up click is consumed regardless of movement threshold so the underlying widget cannot
focus, select, close, or activate. Ordinary canvas drag retains its existing threshold behavior.

### Intent classifier

All canvas-owned wheel paths use the same shared classifier:

1. `ctrlKey || metaKey` performs focal zoom with
   `clamp(exp(-deltaY / 100), 0.75, 1.25)`.
2. Otherwise, `useScrollWheelToZoom=true` performs historical wheel zoom using
   `invertCanvasWheel` and `zoomSensitivity`.
3. Otherwise, input pans in screen space with `camera.x -= deltaX` and
   `camera.y -= deltaY`.

Pan inversion changes both axes. Shift does not invent an axis remap. DOM line deltas use 16 CSS
pixels and page deltas use the current viewport. Pan deltas are accumulated once per animation
frame without application inertia; pending pan is flushed before zoom to preserve event order.
Modifier/pinch zoom intentionally ignores wheel inversion and sensitivity. Zoom remains anchored
at the event's client coordinates and bounded by the existing camera limits.

### Embedded surfaces and cursor

The workspace installs one non-passive capture listener. xterm's coordinate adapter exits before
processing canvas-owned wheel. Internal plugin HTML receives a host bridge that cancels and
relays wheel only when effective capture is active; messages are accepted only from the expected
frame source and after schema, coordinate, and finite-delta validation. During full override,
plugin frames become hit-test transparent so pointer capture begins in the workspace without
focusing the plugin.

Wheel-only capture never changes the cursor. Full navigation forces `grab` across workspace DOM,
xterm, plugin, and native Browser surfaces. A canvas-owned pointer gesture forces `grabbing` until
completion. Native Browser cursor CSS uses user origin, `!important`, and generation-guarded
insert/remove operations across navigation and destruction.

## Invariants

1. Production code does not infer a physical input-device identity.
2. Blank-canvas primary drag always pans.
3. New profiles pan on ordinary scroll; migrated profiles retain ordinary scroll zoom.
4. An absent legacy key stays absent and is not treated as explicit `false` or `true`.
5. Pinch and `Cmd/Ctrl + scroll` perform focal zoom whenever the canvas owns the event.
6. Wheel-only capture never owns pointer drag; full override owns wheel and drag.
7. Only the focused, focusable widget may interrupt canvas wheel input without an override.
   **Exception recorded 2026-09-14:** an element that publishes `data-canvas-wheel-priority="local"`
   owns the wheel with no focus precondition. `HomeZone.tsx:297` publishes that attribute on the HOME
   session list unconditionally, `isPriorityLocalCanvasWheelTarget` (`canvasWidgetFocus.ts:51-54`)
   reports such a target as focus-owned, and `useCanvasWheelNavigation.ts` feeds that result into
   `overFocusedWidget`, so the wheel over that list stays local even when nothing was focused. The
   UI contract records the same exception in its HOME session-list line (`docs/UI_CONTRACT.md:11`)
   and in its canvas wheel bullet. The priority-local row of the ownership table above carries this
   rule; the rows before it describe the focus-based policy this invariant states.
8. Ownership is decided before cancellation; camera pan may be frame-coalesced.
9. Pan preserves both axes and native momentum and adds no inertia.
10. Modifier-only bindings preserve ordinary application shortcuts.
11. Focus and selection remain independent; this decision does not restrict future multi-select.

## Consequences and Mitigations

- Trackpad navigation works without device heuristics and existing saved mouse profiles keep their
  behavior.
- New mouse-only profiles pan until the user enables ordinary wheel zoom; the Controls setting
  makes that choice explicit.
- Reserved ordinary-key chords cannot reach a focused widget while held. Modifier-only bindings,
  Disabled full override, and Off wheel mode remain available.
- Plugin and native Browser boundaries require trusted bridges, bounded payloads, and dedicated
  lifecycle handling. Their policy remains shared even though transport differs.
- Chromium-generated pinch and physical `Ctrl + wheel` are indistinguishable and intentionally
  map to the same zoom intent.

## Validation and Confidence

Unit coverage fixes the classifier order, delta modes, both axes, inversion, clamp, migration,
binding normalization, shortcut conflicts, focus ownership, xterm/plugin routing, pointer latch,
and menu-shortcut policy. Browser-specific integration is covered by the related ADR.

The intent and storage contracts have high confidence because they are pure, deterministic, and
covered at their I/O boundaries. Cross-platform gesture feel still requires the release matrix on
macOS, Windows Precision Touchpad, and Linux/libinput; this does not change the accepted device-
agnostic contract.

## Open Questions Outside This Decision

- A future best-effort Auto mode may be researched separately.
- `hasPreciseScrollingDeltas` is not used by this decision and is not a device identifier.

## References

- [W3C UI Events: Wheel Events](https://w3c.github.io/uievents/split/wheel-events.html)
- [Electron MouseWheelInputEvent](https://www.electronjs.org/docs/latest/api/structures/mouse-wheel-input-event)
- [Chromium touchpad pinch event queue](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/lkgr/components/input/touchpad_pinch_event_queue.cc)
- [Figma: Pan and zoom in FigJam](https://help.figma.com/hc/en-us/articles/1500004414582-Pan-and-zoom-in-FigJam)
