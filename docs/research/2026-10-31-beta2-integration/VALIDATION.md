# Beta2 integration validation

Date: 2026-10-31 (Europe/Moscow). Agent: Codex.
Executable revision: `e6de5e90b56f0911b3ec9250de06b1bf943f1982` on
`integration/1.8.5-beta2-platform-fixes`.

## Local environment and fixes

Linux x64, Manjaro kernel `6.18.49-1-MANJARO`, Node `22.22.0`, npm `10.9.4`,
Electron `43.8.1`. The final root suite, Even G2 suite and production build used
a clean detached checkout of the revision above with a successful `npm ci`,
not the older linked node_modules.
This produced a fresh application bundle and native helper.

Two issues found during validation were fixed in the executable revision:

- VIEWPORT_UNAVAILABLE again says to retry after the person makes Browser
  visible, retaining semantic reading and the prohibition on desktop fallback.
  The existing assertion was retained; additional assertions cover that guidance.
- The secret-audit walker now excludes the already gitignored root `tmp` and
  `.tmp` scratch directories. A regression verifies that `src/tmp` remains
  scanned, alongside the generated gesture-build directory exclusions.

The initial sandboxed test attempt could not listen on local sockets (EPERM).
Socket, PTY and Chromium tests were run with the required execution permissions.
CanvasLink's initially missing Playwright/sharp and matching Chromium were
installed into an isolated temporary dependency/cache directory for its run.
The clean checkout subsequently installed its complete lockfile normally.

## Completed local checks

| Check | Result |
| --- | --- |
| Full root suite on the final clean checkout | 2630 total; **2620 passed, 0 failed, 10 skipped**, 304.878 s |
| CanvasLink contracts/UI suite | **118 passed, 0 failed, 0 skipped**, including touchCancel |
| Even G2 suite on Node 22 | **47 passed**, no failures or skips |
| Benchmark trial/cleanup contracts | Local file invocation passed; CI reports **4 passed** |
| Node/renderer typecheck | Passed, including the clean production build |
| Production build, companions and native helper | Passed |
| Secret audit, source plus built out/ | Passed |
| Production dependency audit | 0 known vulnerabilities |
| Packaged AppImage startup | Passed; rendered in 2480 ms, process exited successfully |
| Real Electron/xterm hidden-renderer/state smoke | Passed (CANVASTTY_HIDDEN_DOM_PROBE_OK) |
| Local MCP helper/one-time capability smoke | Passed (CANVASTTY_PROVIDER_SMOKE_READY) |
| Tracked native helper catalog | Unchanged by the build |

The ten root-suite skips cover macOS seatbelt cases, Windows-specific cases,
an operator-supplied disconnected AppImage mount and a local Ollama model.
They are not counted as successful platform/runtime checks. npm ci reported
five advisories in development/build dependencies; no dependencies were upgraded.

## Browser smoke limitation

The complete local real-browser smoke does **not** pass. With an isolated X11
display it times out at assertBrowserOriginPanCrossesBoundary, waiting for an
active freeze-frame event after the first Browser-origin wheel input. The same
command/environment and same assertion also fail on an unchanged checkout of
the beta2 base `df274cfb`. This demonstrates that the local failure is present
before this integration; it does not identify a product versus environment root
cause. The test was not weakened or skipped to obtain green results.
The same complete browser smoke subsequently passed in Ubuntu CI on the exact
integration revision (CANVASTTY_BROWSER_SMOKE_READY), as did packaged startup,
hidden terminal rendering and the MCP helper smoke there.

An earlier run inherited the host's Wayland hint despite Xvfb and failed focus
readiness. The successful packaged startup was repeated serially with an explicit
X11 hint; the running user installation/profile was not replaced.

## Cross-platform CI

Both dispatches target the same executable revision above:

- [Core CI 41140681248](https://github.com/howdeploy/CanvasTTY/actions/runs/41140681248):
  **completed successfully**, including all five jobs.
- [CanvasLink 41140683552](https://github.com/howdeploy/CanvasTTY/actions/runs/41140683552):
  **completed successfully**, contracts and Android debug build both successful.

| Core CI platform | Root tests | Build/runtime evidence |
| --- | --- | --- |
| Ubuntu Linux x64 | 2617 passed, 0 failed, 13 skipped | Native helper vetting for all release targets, AppImage/deb, packaged startup and all Electron/browser/helper smokes passed. |
| macOS arm64 | 2624 passed, 0 failed, 6 skipped | Gesture addon compiled; DMG and zip built; packaged CLI resolution, hidden terminal rendering and real-browser smoke passed. |
| Windows x64 | 2468 passed, 0 failed, 162 skipped | Native helper transport and pipe-host self-tests, typecheck, NSIS setup and portable exe packaging passed. |

Both mascot jobs also passed. Skips reflect platform/environment coverage rather
than additional passing tests. Windows CI does not perform an interactive GUI
acceptance run; physical trackpad gestures and release-owner signing/notarization
are not established by these automated builds. Windows/macOS installers were
built on the CI runners; the downloadable local candidates below are Linux only.

## Local Linux artifacts

Built in the clean `canvastty-beta2-integration-validation` checkout, under
`release/`; version remains `1.8.5-beta2`. These are integration candidates,
not a published release or an installed update.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| CanvasTTY-1.8.5-beta2-linux-x86_64.AppImage | 204305188 | `c50e2d4bc4156062d27bb28e736a9bf2d64df283c0859c4b6a3ad6fe34a563ad` |
| CanvasTTY-1.8.5-beta2-linux-amd64.deb | 176949204 | `fd2c34459342ec34f07ba36f952287425730319bafcfdfc2282006466b30d6ef` |

Raw logs remain outside the tracked repository in the local validation log
directory; they were not published because they contain machine-local paths.
