# Changelog

## Unreleased

- Fixed the main window never appearing when the renderer paints before `loadURL` resolves; the `ready-to-show` listener is now attached before loading.
- Added RTS-style edge panning (off by default; enable in Settings): the camera drifts while the pointer rests near a viewport edge over empty canvas and pauses over interactive surfaces.
- Added Settings controls for edge panning (toggle and speed) and wheel zoom sensitivity.
- Added an optional session name to the launch flow; Terminal now launches through the same Focus Card as agents.
- Added browser cards: canvas cards with an address bar that load web pages next to terminal sessions.

## 0.8.2 — public preview

- Publish only end-user installers from release jobs, excluding unpacked build directories.
- Give Windows NSIS and portable executables distinct artifact names.

## 0.8.1 — public preview

- Made repository and documentation security checks portable across LF/CRLF checkouts and Windows drive paths.
- No application behavior changed from the `0.8.0` preview candidate.

## 0.8.0 — public preview

- Spatial canvas for live local PTY and AI-agent CLI sessions.
- Fixed Home zone with launchers, sessions, clock, media, and source-backed provider limits.
- Movable, resizable, snapping terminal cards with semantic zoom navigation.
- Electron process isolation with typed, allow-listed IPC and local-only settings.
- Multilingual repository entry points and documentation in English, Russian, and Simplified Chinese.
- Reproducible Linux, Windows, and macOS packaging through GitHub Actions.
- Repository secret audit and strict package-content allowlist.

Known preview constraints: runtime widget plugins are not implemented; Windows and macOS behavior still needs broader real-device validation; release packages are not code-signed or notarized.
