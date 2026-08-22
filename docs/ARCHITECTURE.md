# Architecture

[English](ARCHITECTURE.md) · [Русский](ARCHITECTURE.ru.md) · [简体中文](ARCHITECTURE.zh-CN.md)

## Process boundaries

CanvasTTY follows Electron's three-layer model:

```text
React renderer
    │ typed window.canvasTTY API
    ▼
preload bridge (contextBridge)
    │ allow-listed IPC channels
    ▼
Electron main process
    ├── SettingsStore  → validated, atomic JSON persistence
    ├── TerminalManager → node-pty lifecycle, bounded scrollback, and output batching
    ├── LimitsService  → sanitized provider-limit adapters and cache
    ├── PluginManager  → GitHub install, manifest validation, assets, permissions, storage
    ├── PluginSecretsService → OS-backed encrypted plugin credentials with fail-closed availability
    ├── PluginMediaService → user-granted music folders, ranged audio streams, playlist files
    ├── BrowserService → tabs, shared persistent profile, downloads, presence, WebContentsView lifecycle
    │   ├── BrowserStore / BrowserPolicyService / BrowserAuditStore
    │   ├── BrowserCore / BrowserCommandDispatcher / BrowserAutomationService
    │   └── AgentGateway → authenticated UDS/named pipe for the bundled stdio MCP helper
    ├── canvastty-plugin:// → CSP-constrained static plugin resources
    ├── canvastty-media:// → permission-checked local audio streams
    └── native dialogs/window controls
```

- `src/shared/contracts.ts` is the single public contract between processes. Add or change cross-process data here first.
- `src/preload/index.ts` exposes only the typed capabilities the renderer needs. Node integration stays disabled; context isolation and sandbox stay enabled.
- `src/main/ipc/registerIpc.ts` owns native side effects and validates access to persisted media.
- `src/main/services/TerminalManager.ts` is the source of truth for live session state and PTY buffers. It keeps scrollback in a bounded chunk buffer and coalesces PTY data into 16ms IPC batches so clear/redraw sequences reach xterm together. A new PTY is `idle`; process exit provides only `done` or `failed`. An exited PTY may be restarted under the same session ID while preserving its card, bounds, title, and scrollback. `working` and `needs_approval` are accepted only as typed provider lifecycle signals, never inferred from PTY existence or terminal text.
- `src/main/services/LimitsService.ts` reads Codex through the installed CLI's app-server protocol and Claude, Kimi, OpenCode Go, and Grok Build through their provider usage or billing endpoints. Provider credentials are read only inside the trusted main process, sent only to the matching provider over HTTPS, and never logged or exposed over IPC. The service owns timeout, structural normalization, caching, stale fallback, and subprocess cleanup; raw provider responses never cross IPC.
- `src/main/services/SettingsStore.ts` normalizes every update and persists through a serialized atomic write.
- `src/main/services/PluginManager.ts` installs ready-to-run static repositories without executing package scripts, rejects symlinks and oversized packages, persists the enabled registry, serves only contained package files, and enforces per-plugin permissions/storage quotas.
- `src/main/services/PluginSecretsService.ts` serializes per-plugin secret writes, encrypts the complete bounded payload through Electron `safeStorage`, rejects plaintext-only backends, and removes each encrypted file on uninstall.
- `src/main/services/PluginMediaService.ts` persists per-plugin grants only after a native folder choice, hides absolute paths, skips symlinks, and serves contained audio with HTTP Range semantics. Playlist reads stay inside granted libraries; writes are bounded and atomic under the library's `Playlists/` directory.
- `src/main/services/BrowserService.ts` is the only owner of the built-in browser's `WebContentsView` tabs and shared persistent partition. Remote pages have no preload or Node access, keep context isolation and sandbox enabled, and cannot request hardware, location, notification, clipboard-read, certificate-bypass, or external-protocol capabilities. HTTP(S) popups are adopted as internal tabs; other schemes are rejected.
- `src/main/services/browser/` contains the browser kernel. `BrowserStore` atomically persists only tab order, active tab, and safe restore URLs. `BrowserPolicyService` centralizes URL, permission, download, and upload rules; validated uploads are copied through an already-open no-follow file descriptor into private staging before Chromium sees them. `BrowserAutomationService` attaches Electron's internal debugger to the existing live tab without a remote-debugging port. `BrowserCommandDispatcher` adds revisions, revision-bound refs, mutation request deduplication, per-tab FIFO mutation lanes, bounded concurrency, typed errors, and redacted fail-closed audit for agent mutations.
- `src/main/services/agent-browser/` exposes the kernel only through an authenticated user-local Unix socket (`0600`) or Windows named pipe. The Windows pipe is created by the bundled native host with a protected DACL containing only the exact current-user SID and rejects remote clients. Each agent PTY receives a one-use bootstrap capability through its child environment. A successful authentication rotates it to a session-scoped reconnect capability held only in helper memory; duplicate bootstrap authentication is accepted only while the same `connectionId` is already live, and every capability is revoked when the PTY ends. The bundled stdio MCP helper is the only protocol adapter; no TCP listener, cookie/storage endpoint, arbitrary evaluation tool, or raw CDP surface exists.
- `TerminalManager` injects the MCP helper per launch without leaving permanent provider configuration. Claude Code and Codex receive CLI arguments; OpenCode receives a merged launch-only `OPENCODE_CONFIG_CONTENT` entry plus one scoped browser-tool permission; Kimi uses its per-run MCP configuration when supported. Older Kimi versions receive a compare-and-swap temporary CanvasTTY entry and one exact permission rule with an atomic recovery journal. Hermes receives a temporary `mcp_servers.canvastty_browser` entry in `HERMES_HOME/config.yaml` (defaulting to `~/.hermes/config.yaml` on POSIX or `%LOCALAPPDATA%\hermes\config.yaml` on Windows); sensitive capability values stay as child-environment placeholders. Temporary Kimi and Hermes configuration remains until the final owning PTY session ends, then exact original bytes are restored when safe. A journal repairs an interrupted Hermes launch at the next CanvasTTY startup, while compare-and-swap checks preserve concurrent user edits. Unrelated MCP entries, credentials, and file/shell permissions are preserved. OpenCode YOLO is a launch-only inline override, and Hermes YOLO passes its native `--yolo` flag; neither changes persistent permission settings.
- `src/main/services/providerCliRegistry.ts` is the single owner of provider CLI discovery. During main-process startup it creates one immutable snapshot for Codex, Claude, Kimi, OpenCode, Hermes, and Grok Build by checking smoke-only overrides, the inherited `PATH`, platform defaults, and known per-user/provider directories in that order. Available entries retain an absolute executable, launcher kind, and supplemented child `PATH`; POSIX entries must be executable files and Windows entries must be supported native or batch launchers. `TerminalManager`, `LimitsService`, agent-browser probes, and provider smoke tests consume that same snapshot and never repeat command lookup. Missing entries produce a failed session with copyable checked-path diagnostics before PTY or temporary browser configuration creation, and the matching HOME limit stays `cli-not-found`. CanvasTTY never reads shell startup scripts, and installing or moving a CLI requires restarting the app.

The primary `BrowserWindow` is created and shown with a lightweight local startup page before settings, plugins, media, and IPC services initialize. Successful initialization replaces that page with the trusted renderer; bootstrap failures replace it with a visible error page and retain a native-dialog fallback. The main process holds Electron's single-instance lock and restores/focuses the existing window when another launch is attempted.

Runtime plugin code is never imported into main or the trusted renderer bundle. HOME widgets and canvas apps run in sandboxed iframes with an opaque origin. Separate plugin windows use a dedicated narrow preload which forwards the same message SDK through an IPC handler that verifies the actual `canvastty-plugin://<id>/<entry>` sender URL. Arbitrary native OS windows are not embedded.

Plugin music access is capability-based rather than generic filesystem access. Media scans return library IDs, relative paths, metadata, and `canvastty-media://` stream URLs; raw playlist text remains the only format-neutral file content exposed. A media URL is resolved only for the owning enabled plugin and only beneath a previously selected library root. Removing a plugin revokes its persisted folder grants.

The built-in browser is split across surfaces: `BrowserCard` renders trusted window chrome, tabs, navigation, agent badges, downloads, dialogs, and canvas geometry, while `BrowserService` positions the active native view over the measured viewport. The native view remains live while the card or camera moves and receives frame-coalesced geometry updates; it is hidden only during semantic summary, HOME editing, or trusted modal surfaces. Fractional renderer bounds expand to enclosing device-independent pixels, and the active tab view is reparented only when the active tab actually changes. A typed pointer bridge reports native-page click and hover activity back to canvas selection and explicitly restores native page focus without preventing page input. A transparent trusted mouse-passthrough window draws optional live agent cursors above the native view; Wayland uses an isolated-world fallback. A connection or heartbeat alone never creates presence: badges appear only after an actual browser command, and cursors appear only after a real pointer position exists.

Renderer IPC and the agent gateway call the same `BrowserCore.execute(actor, command, signal)` boundary. Reads may run concurrently. Mutations are ordered FIFO per tab while different tabs remain independent; a repeated mutation request ID returns the recorded result. Navigation and document changes advance the revision, so stale accessibility refs fail before side effects. Agent activity is recorded as a redacted append-only hash chain: typed/page text, screenshots, URL query/fragment, credentials, headers, cookies, and tokens are not stored.

## Renderer boundaries

`App.tsx` is the orchestration boundary. It loads settings/sessions, subscribes to main-process events, and coordinates dialogs and persistence. Feature components do not call unrelated feature APIs.

```text
App
├── WorkspaceCanvas        camera, pan, zoom, spatial composition
│   ├── HomeZone           persisted resizable grid, visible boundary, and edit gestures
│   │   ├── homeModel      pure derivation of limit/active-session rows
│   │   └── HomeMediaWidget independent pick/replace/remove control
│   ├── TerminalCard       one live xterm view, selection, rename, drag, resize, and snap behavior
│   ├── PluginCanvasCard   sandboxed plugin app with canvas bounds and semantic summary
│   └── BrowserCard        trusted browser chrome and canvas geometry for the native WebContentsView
├── AgentLaunchDialog      fixed provider + folder + profile + launch
└── SettingsPanel          General, Appearance, Controls, Browser, and Plugins
    └── PluginSettingsSection install preview, permissions, registry, and contributions
```

Keep domain decisions in pure selectors such as `homeModel.ts`, orchestration in `App.tsx`, and rendering/local interaction in feature components. IPC calls belong in `App.tsx` or a feature that exclusively owns that capability.

## Session flow

1. Home requests a terminal or opens a provider-specific launch card.
2. `App` sends a typed `terminal:create` request.
3. `TerminalManager` validates the request, spawns the PTY, stores metadata and bounded chunked scrollback, then emits lifecycle events and 16ms-batched data events.
4. `App` reconciles lifecycle snapshots by session ID.
5. `TerminalCard` subscribes to its PTY stream, sends PTY input/grid resize events, and commits typed canvas bounds after a drag or edge resize.

`SessionMetadata` owns both world-space position and card size. `App` reconciles those bounds, while `TerminalCard` may hold transient pointer-move geometry until pointer-up. The main process validates and clamps committed sizes before emitting a session snapshot. Camera wheel handling is limited to empty canvas; interactive surfaces keep their native scroll/input ownership.

A live `TerminalCard` owns one xterm instance for the lifetime of its session ID. Palette changes update `terminal.options.theme` in place; title and settings changes must never dispose the terminal or its renderer-side scrollback. Window titles are updated as session metadata through `terminal:rename`. PTY input and resize events that race with process exit are contained at the main-process boundary and never surface as uncaught Electron errors.

Output batching is an IPC/rendering boundary, not a history boundary: every PTY chunk is appended to bounded scrollback immediately, while pending renderer output is flushed on the 16ms timer, before exit, and before disposal. Scrollback trimming advances through chunks instead of rebuilding the entire buffer for every write; snapshots join only the retained suffix.

Terminal pointer coordinates are converted from the canvas's visually transformed rectangle back to xterm layout coordinates before selection or wheel handling. Terminal and canvas wheel direction are normalized independently from persisted settings. Selected text is copied through the typed clipboard bridge with `Ctrl+C`, `Ctrl+Shift+C`, or `Cmd+C`; paste uses `Ctrl+Shift+V`, `Cmd+V`, or `Shift+Insert` and enters xterm through `Terminal.paste` rather than synthetic keystrokes. `Shift+Enter` sends the CSI-u modified Enter sequence directly to the PTY.

Application shortcuts are normalized in `SettingsStore`, matched in `App`, and rendered from the same persisted bindings in the canvas hint. `App` owns the exclusive selected canvas application and the selected terminal session used by window actions such as rename. `TerminalCard` owns xterm focus and only the inline editor; `BrowserService` owns native page focus. Pressing empty canvas clears either selection. Optional hover focus uses the same configured entry/exit delay for terminals and the built-in browser; focus-in/focus-out sequences produced by a terminal's programmatic transition are suppressed before PTY input so agent TUIs do not reset their history position.

Session counters, progress bars, and statuses must always derive from actual `SessionSnapshot` values. The UI must not synthesize telemetry.

## Provider-limit flow

1. `App` requests a sanitized `LimitsSnapshot` at bootstrap and every 60 seconds.
2. `LimitsService` deduplicates refreshes and keeps a 60-second cache.
3. Codex is queried through `codex app-server` using `account/rateLimits/read`. Claude, Kimi, OpenCode Go, and Grok Build use their read-only usage or billing endpoints with credentials already managed by each installed CLI. OpenCode Go contributes its real rolling, weekly, and monthly windows; Grok Build contributes its real shared billing period. Responses are structurally validated and reduced to percentage, window, and reset time.
4. If a refresh fails after a successful read, the last valid snapshot is returned as stale. Missing or unsupported adapters return an explicit unavailable reason, never `0%`.
5. Claude's weekly window exists only for a Claude.ai subscription session. API Usage Billing is reported as `subscription-required`, not as a fake quota. CanvasTTY never parses provider TUI screens.

## Extension points

- Add a provider in `ProviderId`, `providers.ts`, `TerminalManager.resolveLaunch`, the official provider asset map, and an optional safe limit adapter.
- Add a persisted setting to `AppSettings`, defaults/normalization in `SettingsStore`, and the owning feature only. Settings owns user-facing canvas controls and shortcuts; camera math and snapping geometry remain pure renderer concerns.
- Add a canvas entity as a separate feature component with an explicit position and callbacks; keep camera ownership in `WorkspaceCanvas`.
- Publish a runtime extension with `canvastty.plugin.json` API v1 and static HTML/CSS/JS entries. Contribution kinds are `home-widget`, `canvas-app`, and `window`; capability access is restricted to declared permissions. See [Runtime plugins](plugins.md).

Every extension should pass `npm run typecheck`, `npm run build`, and a real Electron interaction check.
