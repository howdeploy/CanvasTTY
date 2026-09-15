# ADR: Preserve Native Browser Wheel Continuity

**Date:** 2026-08-08
**Scope / Component:** native Browser wheel ownership, cross-surface hit testing, frozen rendering, and pointer routing
**Risk/Strictness Profile:** Production
**Status:** Accepted

**Main intake clarification (2026-09-15):** the historical macOS/Windows observations below do
not establish Linux acceptance. The maintainer reports resize, scaling, movement, and clipping
regressions in the combined Linux DEV build; see the
[PR #34 review](https://github.com/howdeploy/CanvasTTY/pull/34#pullrequestreview-5209192918) and
[PR #40 follow-up](https://github.com/howdeploy/CanvasTTY/pull/40#issuecomment-5679224145).
This documentation intake does not resolve those defects or claim new interactive validation.

**Related:** [ADR: Use Intent-Aware Canvas Navigation](./ADR-20260808-intent-aware-canvas-navigation.md)
**Implementation:** [`BrowserCanvasGestureController`](../../src/main/services/browser/BrowserCanvasGestureController.ts), [`BrowserCanvasPointerRouter`](../../src/main/services/browser/BrowserCanvasPointerRouter.ts), [`BrowserCanvasFreeze`](../../src/main/services/browser/BrowserCanvasFreeze.ts), [`BrowserCanvasSinkViewport`](../../src/main/services/browser/BrowserCanvasSinkViewport.ts), [`browser` preload](../../src/preload/browser.ts), and [`BrowserCard`](../../src/renderer/src/features/browser/BrowserCard.tsx)

## Context and Problem Statement

The canvas lives in the owner renderer while a live Browser page lives in a child Electron
`WebContentsView`. These are separate native input and composition surfaces. Correctly classifying
an event as page- or canvas-owned does not make an operating-system wheel sequence move safely
between those surfaces.

Live macOS testing established two boundary failures:

1. An owner-renderer pan stopped when the moving native Browser rectangle reached the stationary
   cursor. The child view became the hit-test target before owner DOM could observe another event.
2. A canvas-owned gesture beginning inside an unfocused Browser relayed one event, then stalled
   when the native view was hidden. macOS retained the active sequence against the original
   `WebContentsView` rather than retargeting it to the owner renderer.

Keeping only a 4 DIP parent clip preserved the target but did not reliably clip the child visual;
the Browser appeared as a detached static rectangle. Page CSS opacity replaced it with a black
native compositor surface and required a restoration acknowledgement race. Shrinking the actual
child fixed composition but changed the page viewport, causing responsive reflow and resize side
effects. Electron device emulation is needed to decouple the physical hit-test surface from the
page's logical viewport.

The solution must decide ownership synchronously, latch it through momentum, preserve the original
native target when a Browser-origin canvas sequence needs it, remove broad native hit testing, and
keep the Browser card visually coherent while it moves or zooms.

## Decision Drivers

- Focused Browser plain scroll must remain page-owned in Off or released-Key mode.
- Pinch-shaped `Ctrl/Meta` wheel and every policy-selected canvas gesture must be cancellable before
  page delivery.
- Ownership may not change mid-sequence because focus, modifiers, frame target, or override state
  changes.
- Canvas gestures must remain continuous in both Browser-to-canvas and canvas-to-Browser
  directions.
- The same `WebContentsView` target must survive Browser-origin momentum without retaining a
  full-size stale hit region or changing page layout.
- Placeholder/summary transitions must not terminate a still-active canvas gesture.
- Click, selection, context menu, focus, and full-navigation pointer ownership must remain defined
  while the native surface is substituted.
- The workaround must apply to wheel-class input without trackpad detection.

## Options Considered

### Always make Browser wheel canvas-owned

This avoids a focus policy but prevents ordinary scrolling in a focused page. It was implemented
and then rejected after live use showed the page could no longer scroll naturally.

### Cancel native wheel only in `before-mouse-event` or `input-event`

Electron's main-process notifications did not reliably prevent Chromium page scroll for the
observed macOS path. Cancellation and relay also risked coming from different events. Rejected.

### Hide the native view and rely on retargeting

This solves owner-origin entry but Browser-origin momentum remained bound to the hidden target and
stopped after one event. Rejected.

### Keep a full-size child inside a small parent clip

Input continuity worked, but live composition showed the child outside the expected parent bounds
as a detached Browser rectangle. Parent clipping was not a sufficient visual boundary. Rejected.

### Conceal the native page with opacity or a restoration acknowledgement

CSS opacity controlled document pixels, not the complete native compositor, producing a black
rectangle. The asynchronous acknowledgement introduced a race without solving hit testing.
Rejected.

### Render unfocused Browser pages permanently as screenshots

This removes native hit testing during canvas use but requires continuous GPU readback, encoding,
freshness policy, memory, and activation transitions for all unfocused browsing. The defect is
sequence-local, so the permanent cost and interaction model are disproportionate. Rejected.

### Patch Electron or install a platform event tap

This could control scroll targeting below the application layer but creates a platform-specific
runtime fork and ongoing upgrade burden. It remains a fallback only if the bounded native-sink
contract fails on a supported platform. Rejected for the current implementation.

### Use synchronous preload arbitration plus a frozen frame and emulated 4 DIP native sink

The frame that can cancel page delivery chooses the owner once. Canvas-owned sequences replace the
moving native visual with a local screenshot. Browser-origin sequences keep the exact child target
in a cursor-local physical sink while device emulation preserves its original logical viewport.
Owner-origin sequences remove the child before it crosses the pointer. Selected.

## Decision Outcome

### Synchronous focus-aware ownership

A self-contained registered `frame` preload installs a trusted, non-passive capture listener. On
the first wheel after 250 ms idle it synchronously requests `page | canvas` from main, caches the
decision and generation, and sends later sequence updates asynchronously. Top frame and nested
iframe events share the tab-scoped decision.

| Initial live-page condition | Owner |
|---|---|
| `Ctrl/Meta` wheel or pinch-shaped input | Canvas |
| Full navigation override active | Canvas |
| Wheel capture On | Canvas |
| Wheel capture Key and binding active | Canvas |
| Browser not logically focused | Canvas |
| Browser focused, Off | Page |
| Browser focused, Key with binding released | Page |

Page-owned input is not cancelled or relayed. Canvas-owned input is synchronously cancelled in
the frame and relayed exactly once after validation. Malformed or stale payloads fail closed. The
preload remains self-contained so its registered sandbox entry does not depend on a bundler shared
chunk; a contract test fixes its local idle value to the main-process 250 ms constant.

Logical Browser focus is assigned by native pointer down or delayed hover and is cleared by click
outside widgets or Browser lifecycle removal. Selection remains separate. Placeholder/summary
content has no live page and remains canvas-owned.

### Bidirectional sequence continuity

For a Browser-origin canvas sequence, main performs the following before returning from the
synchronous ownership request:

1. Start the tab-scoped owner sequence at an owner-DIP point.
2. Preserve the page's current logical viewport with Electron device emulation.
3. Capture or reuse the active tab's frozen frame.
4. Resize the physical native target to a 4 DIP cursor-local sink.
5. Show the frozen frame in the moving Browser card while the same native target continues to
   receive the sequence through the frame preload.

For a sequence starting in the owner renderer, the renderer synchronously arms main before
applying camera intent. As soon as the moving Browser bounds, expanded by a 4 DIP guard, would
cover the cursor, the collision latches and main removes the native surface from hit testing before
applying intersecting bounds. Subsequent wheel reaches the owner DOM frozen surface. Both paths
share the same 250 ms idle boundary and lifecycle reset.

The first frame is captured locally from the active tab. Captures are coalesced and generation-
guarded; stale tab results are discarded. JPEG quality is 70 with a 1.5 MiB limit and progressive
downscaling. Capture failure reuses the previous frame for that tab or the normal viewport
background. Active freeze does not recapture for every camera or bounds update; one deferred
refresh runs after native restoration.

Viewport state is explicit:

```ts
type BrowserViewportSurface = "native" | "placeholder" | "hidden";
```

`native -> placeholder` does not end an active canvas sequence or restore the native view under
the cursor. Only `hidden` and real lifecycle boundaries reset immediately. Resets cover blur,
owner hide/close, tab switch, navigation, crash, tab destruction, Browser close, and service
disposal.

Restoration clears pointer relays, removes the sink decision, synchronizes normal native layout,
restores device emulation, and only then deactivates the DOM frozen frame. This ordering prevents
an empty visual gap and leaves one effective hit surface.

### Pointer and cursor routing

Full-navigation Browser drag is cancelled before normal Browser focus and remains canvas-owned
through mouse up/cancel even if the binding is released. `grab` and latched `grabbing` cursor state
are generation-guarded inside Browser content.

While a frozen frame is standing in for a page, ordinary click, selection, and context-menu input
is forwarded as one complete native pointer sequence to the Browser. While the cursor-local sink
is active, a new pointer sequence is resolved to the restored Browser or owner based on current
geometry and remains on that target through completion. Full navigation always takes precedence
and leaves pointer input on the canvas.

The public wheel relay is intentionally compact:

```ts
interface BrowserCanvasWheelEvent {
  tabId: string;
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}
```

Capture mode, focus, and override state are authoritative in main and are not repeated in each
relay payload.

## Invariants

1. A wheel owner is selected once per 250 ms sequence and does not change mid-sequence.
2. Page-owned input is neither cancelled nor relayed; canvas-owned input is cancelled before page
   delivery and relayed at most once.
3. Browser-origin canvas momentum keeps the original native target in a 4 DIP sink while its
   logical viewport remains unchanged.
4. Owner-origin canvas momentum removes the broad native hit target before it covers the cursor.
5. The frozen representation follows current canvas geometry; the sink remains cursor-local.
6. Placeholder transitions do not end a sequence; real hidden/lifecycle transitions do.
7. Full-navigation pointer ownership dominates wheel-only policy and frozen/sink forwarding.
8. Mouse wheel, trackpad, pinch, and Magic Mouse use the same wheel-class mechanism without
   physical-device inference.
9. Cached frame and asynchronous cursor/capture work cannot outlive their generation or tab.

## Consequences and Mitigations

- Canvas pan and zoom remain continuous across a native Browser boundary in both directions.
- A focused Browser retains native plain-wheel page scrolling under Off or released Key.
- During a canvas-owned Browser-origin sequence, the visual page is a frozen frame for at most the
  idle interval after the last event. This is the accepted tradeoff for stable native targeting.
- The 4 DIP native sink and device emulation add Electron-specific state. Dedicated controllers
  isolate this from tab/navigation/download orchestration and are unit-tested through narrow host
  ports.
- `BrowserService` remains the Electron lifecycle composition root because tab identity, native
  view mounting, navigation, downloads, and session policy share one `WebContents` lifecycle; it
  delegates all canvas sequence, freeze, pointer, and cursor state to the dedicated controllers.
- Screenshot capture has bounded CPU, GPU readback, encoding, and memory work and is not a
  permanent rendering mode.
- If a future Electron version changes child-view hit testing, device emulation, or registered
  frame preloads, the integration smoke and live boundary matrix must be rerun before removing the
  workaround.

## Validation and Confidence

Unit tests cover focus/capture ownership, 250 ms latch, stale generation, coordinate conversion,
both axes and modifiers, collision geometry in every direction, 4 DIP guard and sink, capture
fallback, viewport preservation, restoration order, pointer/cursor lifecycle, placeholder
transitions, and all lifecycle resets. The Electron smoke is the required integration boundary for
registered preload installation, real `sendInputEvent`, page `scrollY`, canvas relay, nested
frames, freeze IPC, and non-empty capture.

Live macOS testing confirmed the final causal chain and result: focused page scroll works;
Browser-to-canvas and canvas-to-Browser pan remain continuous; pinch/Command-scroll zoom remains
canvas-owned; and zoom through the placeholder threshold does not terminate the sequence. This is
high confidence for macOS. The integration smoke boundary now also passes on Windows: the focus-aware
physical wheel assertion in `npm run smoke:browser` requires a focused Browser in `off` capture to
scroll the page under a plain wheel with zero canvas relays, and requires both a `Ctrl`-modified
wheel and a wheel sent while the Browser is unfocused to stay canvas-owned. CI runs that smoke only
on ubuntu, so this was its first Windows execution. An independent live Windows run using genuine OS
wheel input reproduced the same three directions from outside the process: a focused-Browser plain
wheel moved the page (`scrollY` 0 -> 478.5) with the canvas camera transform unchanged, a wheel over
empty canvas changed the camera, and a wheel over an unfocused Browser card changed the camera with
the page untouched. Windows confidence is therefore raised only for plain-wheel page ownership and
the modified-wheel path under a focused or unfocused Browser. Precision touchpad and pen input,
nested iframes, momentum latching, and the 4 DIP sink were not separately exercised on Windows, and
Linux/libinput likewise has no live release matrix, so those paths remain medium confidence until
that matrix is completed.

The decision is falsified if a canvas-owned sequence stops at a native boundary, a page-owned
sequence changes canvas camera, a native sink changes page layout or scroll state, a stale frame
appears for another tab, or native and frozen surfaces are simultaneously absent after reset.

## Evidence Updates

**2026-09-14 — the 250 ms contract-test claim is unsupported.** The Decision Outcome above states
that "a contract test fixes its local idle value to the main-process 250 ms constant". No such test
exists: a search across all 101 files in `tests/` finds no reference to `preload/browser` or to any
preload-side wheel idle constant, and the only pinned idle value is the main-process one,
`BROWSER_CANVAS_WHEEL_IDLE_MS` at `tests/browser-canvas-freeze.test.mjs:20`. The preload literal was
therefore unpinned and could drift from the main-process constant with no failing test. The value is
now carried instead of duplicated: the main-process ownership reply includes `idleMs`
(`BrowserCanvasWheel.ts`), and `src/preload/browser.ts` mirrors it from that reply, asking main per
event when a reply carries no usable value. The paragraph above is left as the historical record.

## References

- [Electron registered preload scripts](https://www.electronjs.org/docs/latest/api/session#sesregisterpreloadscriptpreload)
- [Electron `ipcRenderer.sendSync`](https://www.electronjs.org/docs/latest/api/ipc-renderer#ipcrenderersendsyncchannel-args)
- [Electron issue #32751](https://github.com/electron/electron/issues/32751)
- [Electron 43.2.0 macOS native hit testing](https://github.com/electron/electron/blob/v43.2.0/shell/browser/native_window_mac.mm#L111-L148)
