# Native desktop windows in canvas plugins (Windows, experimental)

The `desktop:embed` permission lets a **canvas-app** plugin list desktop window
titles and process names, select an already running window and embed it in its own
card. It does not launch executables, accept command lines or terminate processes.
HOME widgets may open their plugin's canvas contribution; separate plugin windows
cannot embed desktop applications. The Codex Desktop reference package is in
[`examples/plugins/codex-desktop`](../examples/plugins/codex-desktop).

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
chrome. Because Chromium cannot composite HTML above a foreign HWND, the whole
native surface hides when another card, host menu/modal or semantic summary
covers it. Offscreen and minimized viewports also hide. The host sends a heartbeat;
three seconds without it releases the window rather than leaving an orphan.

Closing a card, disabling the plugin, reloading/crashing the renderer or normally
closing the main window restores the native parent, styles and window placement.
The helper also watches Electron's process and restores on EOF or parent death.
Abrupt OS termination or an unresponsive third-party app cannot be guaranteed to
restore correctly; this is experimental OS integration, not process isolation.

## Implementation and compatibility

`DesktopWindowService` owns capabilities and the line protocol. The trusted
PowerShell helper compiles the packaged `WindowHost.cs` against Windows Forms;
no compiler, npm install or native plugin script is needed at runtime. Its small
native host uses Win32 `SetParent`, `WS_CHILD`, viewport clipping and a message
loop; it restores the original `WINDOWPLACEMENT` and styles on release. PowerShell
runs hidden, with a process-local execution policy. No system execution policy is
changed. On non-Windows hosts methods reject with a clear unsupported error.

Windows 10/11 and Windows PowerShell 5.1 with .NET Framework are required. Apps
must use the same user, elevation and DPI-awareness mode. Differing DPI modes are
rejected before reparenting, because Windows may otherwise reset the child
process's DPI awareness. See Microsoft's
[SetParent documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent).
GPU surfaces, app-owned dialogs and applications that reject parenting remain
compatibility limits. A successful generic-window smoke test does not establish
compatibility with every Codex/ChatGPT release.
Chromium-only screenshots and streaming integrations may omit foreign HWND content.

## Checks

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
