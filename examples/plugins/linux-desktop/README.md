# Linux Desktop — development example

This canvas-app uses the existing `desktop:embed` SDK with CanvasTTY's separate
Linux implementation. It lists the current user's local X11/XWayland windows;
the person selects a window, embeds it, then returns it without stopping its app.
The Windows Codex Desktop example and Windows backend are unchanged.

Both CanvasTTY and the selected application must use X11 (including XWayland in
a Wayland session). Start CanvasTTY with `--ozone-platform=x11`; Electron apps
being selected need the same flag. Native Wayland surfaces are unsupported and
are not represented as fake X11 candidates. The helper uses the system
`/usr/bin/python3`, `libX11.so.6`, and `libXfixes.so.3` with XFixes 2 support;
it installs no packages.

The toolbar follows the host's skin and compensates for canvas zoom. A Linux-only
`desktop-appearance` host message supplies skin colors, font and frame scale;
`request("desktopWindows.layout", { insetTop })` reserves its measured height.
The native viewport starts below this responsive header. Linux desktop cards
follow the browser card's layout/camera updates and reuse its main-process
viewport normalization and clipping functions. Partially offscreen content is
cropped by the helper container; the application keeps its full viewport size
and receives an offset inside the clip, like the browser's child view. Pending
geometry reports collapse to the latest rectangle. Moving a card does not remap
or resize its client unless visibility, clipping offsets or dimensions change.
The workspace supplies the browser's global visibility gate, HUD rectangles
and canvas layer order. XFixes bounding/input regions exclude the minimap,
controls and higher cards, leaving them visible and clickable. Global dialogs,
context menus, launchers and fullscreen terminals hide the native surface.
Native clicks also focus/raise the owning card through the host focus controller.
Window selection uses an inline, height-limited list with arrow keys and Escape;
it does not create an operating-system select popup. Selecting an item does not
embed it until the person presses **Embed window**. Keyboard
focus is transferred on a sampled actual click inside the native viewport;
extremely short clicks may be missed by the initial bounded polling approach.
Application-owned dialogs, GPU rendering and fractional/mixed-monitor scaling
still need manual acceptance. Foreign X11 pixels are not part of Chromium's DOM
screenshots or streaming output.

The X11 viewport is owned by the helper and parented inside CanvasTTY's actual
native window. Its coordinates are local to CanvasTTY, so desktop moves and
monitor offsets do not reposition it independently. The helper verifies this
parentage before moving the foreign client and reads back its local geometry.
Normal close, renderer teardown and SIGTERM/SIGINT wait for restoration first;
repeated close requests cannot skip an in-flight restoration. The save-set
protects helper disconnection, but abrupt destruction of Electron's own X11
window can still destroy its foreign children and lose unsaved application data.

The main process retains permission checks, card ownership, expiring single-use
selection IDs and the existing three-second lease. The X11 helper independently
checks the local process owner and window PID, bounds and parent identity. It
restores the original size, position, border and saved EWMH state on detach, EOF,
or orderly host exit. XFixes' root save-set also reparents/maps clients after
helper disconnection while the host remains alive. No process launch, process termination, arbitrary command,
or desktop-wide input API is exposed to plugins.

The standalone plugin is published at
[howdeploy/canvastty-plugin-linux-desktop](https://github.com/howdeploy/canvastty-plugin-linux-desktop),
with an [experimental v0.1.0 release](https://github.com/howdeploy/canvastty-plugin-linux-desktop/releases/tag/v0.1.0).
Use that repository root URL for GitHub installation, not the CanvasTTY repository
or this subdirectory. A compatible Linux host build is still required; installing
the plugin does not add the native backend to stock beta2.

This directory remains the host's development example. The existing DEV profile
has a separately seeded, initially disabled local copy; it is not automatically
replaced by publishing the standalone repository.

Implementation references:

- [Electron Linux/Wayland limitations](https://www.electronjs.org/docs/latest/api/browser-window#platform-notices)
- [Xlib window reparenting and save-sets](https://xorg.freedesktop.org/archive/current/doc/libX11/libX11/libX11.html)

No runtime acceptance, compilation or automated tests are claimed by this file.
