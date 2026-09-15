# Native Browser geometry validation

This complements the browser core smoke test with the actual React application,
preload, main-process services, visible `WebContentsView` children and OS pointer
delivery. A renderer-only screenshot or `webContents.sendInputEvent()` targeted
at the owner cannot establish that native child views leave DOM resize handles
clickable.

## Regression and scope

The accepted main at `dd27b8a9e5b655337af8f33fda1a5e9bd8f52381` places the
native page flush with the side and bottom edges of the Browser card. Those
regions also contain the 8 px edge and 12 px corner resize handles. Native views
intercept input above DOM stacking, including their rounded cutouts. The fix
reserves a 12 px side/bottom gutter for the complete corner targets.

The capture fixes address these cases:

- Apply native bounds and page zoom before requesting a new viewport capture.
- Invalidate captures started for a previous size/zoom, and refresh when a
  placeholder becomes a native page again.
- Defer capture while an offscreen card still has stale native bounds; refresh
  when it reappears, including position-only viewport changes.
- Keep the last complete frame throughout a canvas gesture. Do not start or
  commit captures which can observe the temporary 4 DIP wheel sink. Resume
  capture after native bounds and viewport emulation have been restored.

The renderer displays a freeze image only during its active native-page freeze.
A cached image is not displayed behind summary mode or other placeholder UI.
The freeze image intentionally scales with the card during a gesture; live page
layout resumes at the current viewport when the gesture ends.

## Running the visible test

Use a disposable desktop: this command moves the OS pointer, presses/releases
Alt and saves whole-desktop screenshots. It does not use the installed app or
existing website profiles. The loaded profile path and actual UI scale are asserted at runtime. New-card
navigation is redirected to the loopback fixture during setup. Reports and
random isolated profiles are retained.

```sh
npm ci
npm run build
CANVASTTY_GEOMETRY_DISPOSABLE_DESKTOP=1 \
CANVASTTY_GEOMETRY_BACKEND=x11 \
xvfb-run -a -s '-screen 0 1920x1080x24' \
sh -c 'openbox --config-file scripts/browser-geometry-openbox.xml > /tmp/geometry-openbox.log 2>&1 & npm run smoke:browser:geometry'
```

Linux requires Xvfb, Openbox, xdotool and ImageMagick. The Wayland workflow
additionally starts Weston with its X11 backend and runs Electron fullscreen with
`--ozone-platform=wayland`. This exercises an actual Wayland client in a nested
compositor; it is not GNOME/KDE or a physical Wayland seat. The disposable Openbox process reserves Alt for the
application; its window-move binding uses Super instead.

Windows uses User32 pointer/wheel events and a desktop screenshot. macOS builds
a small CoreGraphics input helper and uses `screencapture`. A desktop without
input/screen-capture permission must fail the delivery/image assertions; an
empty image or a missing trusted pointer event is not a pass.

The opt-in `Browser native geometry` workflow runs on pushes to the dedicated
`ci/browser-native-geometry` branch or by manual dispatch. Its baseline job
checks out the accepted main and overlays only the identical harness and its
guarded startup hook. It leaves the baseline Browser implementation and CSS
unchanged. The baseline has one card because multiple cards are the new feature.

## Recorded matrix

Every platform runs one/two cards at UI scale 1 and 1.25. The harness operates the
actual zoom controls through values above/below the summary threshold and
records the resulting zoom. All eight resize directions are exercised at the
initial, just-above-summary, summary, and enlarged zoom; intermediate steps
still check native geometry and desktop composition. Each visible target records
its trusted pointer event and measured size delta. A handle outside the
desktop or covered by a canvas overlay/another card is recorded as **untested**,
not passed. The test does not click through the minimap or hide product overlays.

Each `report.json` contains the commit, Electron version, platform/backend,
display dimensions and scale factors, individual pass/fail/untested cases,
native view and clipping-container bounds, page viewport/scroll offsets, and
capture-order failures. The PNGs contain the desktop composition, not just the
owner renderer. Cyan/magenta page fiducials guard against empty or owner-only
screenshots. These assertions do not replace inspection of the images.

Controlled service-level checks cover clipping, freeze/sink restoration and
page-scroll preservation after resize/zoom. Separate OS-input cases exercise
focused page scrolling, unfocused canvas scrolling and Alt navigation dragging.

## Manual acceptance still required

OS-synthesized input is distinct from physical device coverage. Before declaring
the full native-composition review complete, record each relevant combination:

| Desktop | Mouse | Touchpad, momentum/pinch | Additional coverage |
| --- | --- | --- | --- |
| Linux X11 | Pending | Pending | Window-manager configuration |
| Linux Wayland | Pending | Pending | GNOME/KDE and native seat, beyond nested Weston |
| Windows | Pending | Pending | Display scaling, mixed-DPI monitor transitions |
| macOS | Pending | Pending | Retina scaling, mixed-DPI monitor transitions |

Use a page with both scrollbars and repeat continuous card drag, every resize
edge/corner, canvas pan and zoom across the summary threshold with one/two
cards. Observe the native page, freeze image, scrollbar placement and clipping
throughout the gesture and after release. Repeat focused/unfocused scrolling
and the configured wheel/navigation overrides. Record OS, compositor, Electron
version, scale settings, device, commit and an image/video demonstrating the
result. Failed or unavailable combinations stay explicitly open.
