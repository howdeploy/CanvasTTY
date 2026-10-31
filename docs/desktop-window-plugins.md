# Native desktop windows in canvas plugins (Windows and Linux, experimental)

The `desktop:embed` permission lets a **canvas-app** plugin list desktop window
titles and process names, select an already running window and embed it in its own
card. It does not launch executables, accept command lines or terminate processes.
HOME widgets may open their plugin's canvas contribution; separate plugin windows
cannot embed desktop applications. The Codex Desktop reference package is in
[`examples/plugins/codex-desktop`](../examples/plugins/codex-desktop).
The Windows SDK and Codex Desktop reference package were contributed by
[@bbutterm in PR #182](https://github.com/howdeploy/CanvasTTY/pull/182).
Linux X11/XWayland support uses a separate backend and the
[`Linux Desktop` reference package](../examples/plugins/linux-desktop), also
published at [canvastty-plugin-linux-desktop](https://github.com/howdeploy/canvastty-plugin-linux-desktop).

```js
const host = window.CanvasTTYPlugin;
const windows = await host.desktopWindows.list();
// Render these choices and let the person pick one. Never persist the id.
await host.desktopWindows.attach(selectedId, 104);
await host.desktopWindows.status(); // { attached: true }
await host.desktopWindows.detach(); // restore the app, without terminating it
```

Keep all plugin controls inside the reserved `insetTop` CSS pixels (40–300,
default 64). The remaining iframe rectangle becomes the native viewport. Plugins
receive no HWND, PID, screen coordinates or parent-window handle. The trusted
renderer measures its iframe, handles canvas transforms and occlusion, and sends
only that rectangle to the main process. The main process validates the sender,
enabled plugin, declared permission, active canvas instance, dimensions and OS.
Selections are owner-bound, consumed once, expire after 60 seconds and are
invalidated when that card refreshes its list. At most eight windows are hosted.

The native window follows card movement and resize. Text reflows to the viewport;
canvas zoom does not raster-scale another application's UI. Native keyboard and
wheel events stay with the embedded app; canvas gestures remain on canvas/card
chrome. On Windows, the whole native surface hides when another card or host
overlay covers it. On Linux, the workspace's HUD rectangles and higher canvas
layers are excluded from both native painting and pointer input, keeping the
minimap and host controls visible and clickable. Global menus/modals, fullscreen
terminals, semantic summaries, offscreen and minimized viewports hide native
content. The host sends a heartbeat;
three seconds without it releases the window rather than leaving an orphan.

Closing a card, disabling the plugin, reloading/crashing the renderer or normally
closing the main window restores the native parent, styles and window placement.
The helper also watches Electron's process and restores on EOF or parent death.
Abrupt OS termination or an unresponsive third-party app cannot be guaranteed to
restore correctly; this is experimental OS integration, not process isolation.

## Implementation and compatibility

### Windows

`DesktopWindowService` owns capabilities and the line protocol. The trusted
PowerShell helper compiles the packaged `WindowHost.cs` against Windows Forms;
no compiler, npm install or native plugin script is needed at runtime. Its small
native host uses Win32 `SetParent`, `WS_CHILD`, viewport clipping and a message
loop; it restores the original `WINDOWPLACEMENT` and styles on release. PowerShell
runs hidden, with a process-local execution policy. No system execution policy is
changed. The Windows backend is unchanged from the contributor's implementation.

Windows 10/11 and Windows PowerShell 5.1 with .NET Framework are required. Apps
must use the same user, elevation and DPI-awareness mode. Differing DPI modes are
rejected before reparenting, because Windows may otherwise reset the child
process's DPI awareness. See Microsoft's
[SetParent documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent).
GPU surfaces, app-owned dialogs and applications that reject parenting remain
compatibility limits. A successful generic-window smoke test does not establish
compatibility with every Codex/ChatGPT release.
Chromium-only screenshots and streaming integrations may omit foreign HWND content.

### Linux

`LinuxDesktopWindowService` and `linuxDesktopWindowIpc` provide a separate
permission-checked adapter. The packaged helper uses system Python 3, libX11 and
libXfixes with XFixes 2; it runs no plugin scripts and installs no packages.
Both CanvasTTY and the selected app must use X11 or XWayland. Start Electron apps
with `--ozone-platform=x11` where needed. Native Wayland surfaces and macOS are
unsupported by this integration.

The helper-owned viewport is a native child of CanvasTTY. Parent-relative bounds
and the browser's viewport normalization/clipping functions keep placement inside
the host across canvas and desktop movement. Workspace visibility gates, HUD
measurements and layer order drive XFixes bounding/input regions. Native clicks
return to the canvas focus controller to raise the correct card. Linux controls
follow the host skin and compensate for canvas zoom; a Linux-only
`host.request("desktopWindows.layout", { insetTop })` reserves their measured
height, up to 4096 local CSS pixels.

Normal close, renderer teardown and SIGTERM/SIGINT wait for restoration before
destroying the owner. XFixes protects helper disconnection while the owner stays
alive. Abrupt destruction of Electron itself can destroy foreign child windows
and lose unsaved application data. Application-owned dialogs, GPU surfaces and
mixed-DPI configurations remain compatibility limits; Chromium-only captures may
omit foreign pixels. Click focus currently uses bounded polling and can miss
exceptionally short clicks.

## Checks

The following checks belong to the original Windows contribution:

```powershell
node --test tests/desktop-windows.test.mjs
powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts/smoke-desktop-windows.ps1
node scripts/smoke-desktop-plugin.mjs
npm run typecheck
npm run build
```

The native smoke creates offscreen fixture windows and checks real parenting,
resize, working native controls, hiding, live restoration and repeated detach.
It never reparents any of the person's existing windows. For manual acceptance,
use an isolated CanvasTTY profile, install the reference plugin, embed an idle
Codex window, pan/zoom, overlap it with another card, open Settings, minimize and
restore the host, then detach and confirm Codex still works on the desktop.

The repository owner manually exercised the Linux/XWayland integration in DEV
and confirmed the reported attachment, movement and HUD-layering behavior was
working. No additional automated or Windows runtime validation was performed
while preparing the combined integration.
