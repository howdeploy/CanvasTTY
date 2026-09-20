# Installing, releases, and local data

[English](installing-and-security.md) · [Русский](installing-and-security.ru.md) · [简体中文](installing-and-security.zh-CN.md) · [Docs home](README.md)

## User-facing packages

Each `v*` tag starts native GitHub-hosted builds for all three operating systems:

| Platform | Artifacts | Notes |
|:--|:--|:--|
| Linux x86_64 | AppImage, deb | AppImage is a single-file package and requires a FUSE 2 compatibility library (`libfuse2t64` on Ubuntu 24.04); deb integrates with Debian-family desktops |
| Windows x64 | NSIS installer, portable executable | The installer allows choosing a directory and creates Start Menu/Desktop shortcuts |
| macOS arm64 (Apple Silicon) | dmg, zip | Both contain the graphical `.app` bundle; Intel/x64 builds are not included |

Download artifacts only from the repository's [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases) page. Starting with `1.2.4`, macOS bundles are ad-hoc signed and pass strict `codesign` verification before upload. This verifies bundle integrity but does not provide a Developer ID identity or Apple notarization, so Gatekeeper may require Finder → Open or Privacy & Security → Open Anyway. Windows packages remain unsigned and may trigger SmartScreen. macOS artifacts from `1.2.2` and `1.2.3` predate this signature fix; use `1.2.4` or later. Verify the release tag and artifact name before acknowledging any warning.

## What the distributable contains

`electron-builder.yml` uses an explicit allowlist: production bundles under `out/`, `package.json`, the MIT `LICENSE`, and required production dependencies. Source docs, `.env`, local agent/planning folders, logs, settings, credentials, and release workspace files are not copied into the packaged application.

`node-pty` is rebuilt on the matching GitHub runner, so Linux, Windows, and macOS packages receive a native module for their own operating system. A package from one OS is never relabeled as another OS build.

## Packaged binary hardening

`electron-builder.yml` applies Electron fuses to release builds; development builds are unaffected because fuses are applied at package time:

- `enableNodeOptionsEnvironmentVariable: false` — `NODE_OPTIONS` and `NODE_EXTRA_CA_CERTS` from the environment are ignored.
- `enableNodeCliInspectArguments: false` — `--inspect` arguments cannot open a debugger in the packaged app.
- `enableEmbeddedAsarIntegrityValidation: true` — the embedded asar hash is validated when `app.asar` is loaded, but Electron performs that check only on macOS 16 or newer and Windows 30 or newer, so the shipped Linux AppImage and deb targets carry the fuse without it.

`runAsNode` is deliberately left enabled. Provider CLIs and the agent runtime spawn the bundled helpers as `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (the browser, agent-runtime, and plugin-hook helpers), so disabling the fuse would break the agent runtime in packaged builds. The consequence is explicit: the packaged binary can still be executed as a Node runtime by local code that already has the user's privileges. `onlyLoadAppFromAsar` is likewise left off: that fuse only narrows Electron's search order for application code, and the helpers are spawned as separate `ELECTRON_RUN_AS_NODE` child processes that load no application bundle, so they are unaffected either way. The real consequence of leaving it off is that the embedded asar integrity check can be bypassed through the app-code search path. Cookie encryption is intentionally not enabled: that fuse is a one-way transition, so a release that turned it on would make every later build without the key read the encrypted store as plaintext and corrupt the profile's cookies.

## Default session permissions

The default Electron session denies by default: permission requests and permission checks return `false`, and device permission requests are denied as well. The shell window and plugin windows therefore cannot obtain camera, microphone, geolocation, notification, or device access, and nothing is granted silently.

The built-in browser is not affected by that default: it runs in its own persistent `canvastty-browser` partition with its own policy object, which currently grants nothing: both the default session and the built-in browser deny every browser permission. The separate partition and its policy are where an exception would live, not the default session.

## Renderer crash recovery

If the renderer process is lost, the main process logs the reason and exit code and reloads the application surface instead of leaving the user in a blank window. Terminal services and sessions keep running across the recovery. A normal clean exit is not treated as a crash and does not trigger the reload. A lost utility or GPU child process is logged with its type and reason; the window itself recovers through the same path.

## Local-only user data

| Data | Location and lifetime |
|:--|:--|
| CanvasTTY settings | Electron's per-user `userData` directory (`~/.config/canvastty` on typical Linux desktops, `%APPDATA%\canvastty` on Windows, `~/Library/Application Support/canvastty` on macOS) |
| Provider credentials | The local credential store owned by the installed Codex, Claude, Qwen Code, Kimi, OpenCode, Hermes, or Grok Build CLI; CanvasTTY does not copy it |
| Temporary provider browser bridge | Kimi fallback and Hermes MCP entries are journaled, scoped to owning CanvasTTY sessions, and restored on final PTY exit or recovered after an interrupted launch; capability secrets are never written as literals. OMP and Pi receive no bridge and no injected MCP configuration |
| PTY scrollback | Bounded main-process memory for the live app session; not saved in the repository |
| Home media | The user's original local file; settings retain only its local path |
| Runtime plugins | Static packages and the enabled registry below `userData/plugins`; isolated JSON storage below `userData/plugin-storage` is capped at 64 KB per plugin and removed on uninstall |
| Plugin secrets | Encrypted blobs below `userData/plugin-secrets`; plaintext is available only to the owning enabled plugin through permission-gated calls, storage fails closed without protected OS encryption, and the file is removed on uninstall |
| Plugin media grants | `userData/plugin-media-libraries.json`; stores the absolute paths of folders explicitly selected by the user and removes a plugin's grants on uninstall |
| Plugin playlists | A plugin with confirmed write permission may create bounded files only below the selected library's `Playlists/` directory |
| Built-in browser profile | Cookies, cache, and site storage in the persistent `canvastty-browser` Electron partition; the browser is available from HOME in `1.0.2` |
| Browser restore state | Safe HTTP(S) tab URLs, tab order, and active-tab ID in `userData/browser-state.json`; disabled/cleared when tab restore is turned off |
| Browser audit log | Redacted hash-chain JSONL below `userData/browser/audit`; the active file rotates at 100 MB and rotated files older than 30 days are pruned during store initialization or rotation |
| Other logs | Local stdout/stderr only; CanvasTTY has no remote log collector or project-operated telemetry endpoint |

Exact `userData` paths may vary with OS configuration. CanvasTTY asks Electron for the correct per-user directory and never uses the source checkout as runtime storage.

## Credential boundary

Provider credentials are read only in the trusted main process when a source-backed quota request needs them. They are sent only to that provider's matching endpoint, are not logged, are not persisted by CanvasTTY, and never cross the typed preload bridge. Kimi's loopback usage token remains in process memory and its child stderr is discarded.

Sanitized percentages, window metadata, timestamps, and explicit unavailable reasons may cross IPC. Raw provider responses, bearer headers, cookies, and credential files may not. Runtime-plugin secrets are a separate opt-in boundary: they cross only the owning sandbox's request path when its manifest declares `secrets` and are encrypted at rest through Electron `safeStorage`.

OMP and Pi receive none of this: they are launched as plain CLI sessions, CanvasTTY reads no provider credentials for them, injects no MCP configuration into their environment, and creates no temporary provider browser bridge for them.

## Repository guards

```bash
npm run audit:secrets
npm test
```

The audit scans the repository source tree and the built `out/` bundle (when one exists) for high-confidence provider/cloud token formats, private-key blocks, hard-coded secret assignments, sensitive filenames, and personal absolute home paths, covering both POSIX `/home/...` and `/Users/...` forms and Windows drive-rooted profile paths. Key prefixes embedded inside a longer identifier are not reported: the `sk-ant-` and `sk-` patterns require that the prefix does not immediately follow an alphanumeric character, so identifier-like names such as `disk-…` or `task-…` no longer produce false positives while a real key still matches. Repository metadata names are excluded before file-type inspection, so both a normal-clone `.git/` directory and a linked-worktree `.git` file are ignored without weakening personal-path detection in publishable files. `.gitignore` excludes local agent context, planning data, env files, credentials, logs, settings, dependencies, and generated packages. CI runs the audit on the repository source tree before the build and again on the built `out/` bundle after it, before any installer is uploaded.

No scanner is perfect. Never commit a live secret “temporarily.” If one reaches Git history, revoke it first, then purge the history before making the repository public.

## Build packages locally

```bash
npm install
npm run package
```

`npm run package` creates an unpacked app for the current OS. Platform scripts create installers:

```bash
npm run package:linux
npm run package:win
npm run package:mac
```

Run each platform script on its matching operating system. Cross-compilation is not treated as proof of compatibility because `node-pty` is native.

## Release checklist

1. Confirm `package.json` and the tag use the same semantic version.
2. Run secret audit, tests, typecheck, production build, and a current-OS package build.
3. Inspect the real packaged app and verify the package-content allowlist.
4. Push `vX.Y.Z`; wait for all three GitHub Actions package jobs.
5. Treat the automatically created release as a prerelease until real-device checks pass on Linux, Windows, and macOS.

Browser storage, agent access, and audit retention are documented in [Built-in browser and audit log](browser.md). Security reports follow the repository [security policy](../SECURITY.md).
