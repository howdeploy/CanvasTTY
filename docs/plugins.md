# Runtime plugins

[English](plugins.md) · [Русский](plugins.ru.md) · [简体中文](plugins.zh-CN.md) · [Docs home](README.md)

CanvasTTY runtime plugins are installed from an HTTPS GitHub repository. A plugin can contribute sandboxed web surfaces and can optionally declare agent hook scripts. Web contributions run without Node.js. Agent hooks are a separate, explicit trust boundary and stay disabled until the user enables each hook in **Settings → Agents → Hooks**.

## Trust model

Installing a plugin is equivalent to allowing third-party browser code to run locally. CanvasTTY reduces that trust surface, but cannot make unknown code trustworthy:

- CanvasTTY downloads only the default-branch tar archive for a GitHub repository root URL and never runs `npm install`, build hooks, native modules, or repository scripts during install/update.
- The package must contain no symlinks and is limited to 500 files or directories / 25 MB. Individual served assets are limited to 8 MB.
- A plugin frame has an opaque sandbox origin, no access to the parent DOM, no `window.canvasTTY`, and no Node.js API.
- The separate-window preload exposes no Node primitives. It forwards the same SDK messages through an identity-checked IPC handler.
- Every privileged SDK method is gated by a manifest permission. Permissions are shown before the user confirms installation.
- Sandboxed web contributions never receive provider credentials, PTY buffers, working directories, raw provider responses, or filesystem access.
- Disabling or uninstalling a plugin immediately stops serving its assets and closes its separate windows.
- Declared agent hooks are never enabled by install, update, or module changes. Enabling one is equivalent to running that repository's JavaScript as a native application with the current user's OS privileges, access to the provider event payload, and potential access to user-readable configuration or credentials. Updating the plugin, replacing modules, or disabling the plugin revokes every enabled hook so changed code must be trusted again.

CanvasTTY does not embed arbitrary native OS windows. A `window` contribution is a sandboxed CanvasTTY-owned `BrowserWindow`. Native reparenting is not portable or reliable across Wayland, macOS, Windows, DPI modes, popups, and GPU surfaces.

## Package layout

The repository root must contain `canvastty.plugin.json`. Entries are relative static HTML files; inline scripts are blocked by the plugin Content Security Policy.

```text
canvastty.plugin.json
shared/plugin.css
widgets/status.html
widgets/status.js
apps/notes.html
apps/notes.js
windows/focus.html
windows/focus.js
hooks/audit.mjs
```

An end-to-end sandboxed web-surface example (without a privileged hook) lives in [`examples/plugins/studio-kit`](../examples/plugins/studio-kit).
Editor tooling can use the [manifest JSON Schema](canvastty-plugin.schema.json) and [SDK TypeScript declarations](plugin-api.d.ts).

## Manifest v1

```json
{
  "apiVersion": 1,
  "id": "com.example.studio-kit",
  "name": "Studio Kit",
  "version": "1.0.0",
  "description": "Small CanvasTTY surfaces backed by real host state.",
  "permissions": ["storage", "secrets", "sessions:read", "launcher:open"],
  "hooks": [
    {
      "id": "audit",
      "title": "Local audit log",
      "description": "Writes selected agent lifecycle events to a user-managed log.",
      "entry": "hooks/audit.mjs",
      "providers": ["codex", "claude", "kimi"],
      "events": ["session-start", "permission-request", "session-end"]
    }
  ],
  "settingsContribution": "notes",
  "contributions": [
    {
      "id": "session-status",
      "kind": "home-widget",
      "title": "Session status",
      "entry": "widgets/status.html",
      "defaultSize": { "columns": 4, "rows": 2 }
    },
    {
      "id": "notes",
      "kind": "canvas-app",
      "title": "Notes",
      "entry": "apps/notes.html",
      "defaultSize": { "width": 680, "height": 440 },
      "minSize": { "width": 320, "height": 180 }
    },
    {
      "id": "focus",
      "kind": "window",
      "title": "Focus",
      "entry": "windows/focus.html",
      "defaultSize": { "width": 900, "height": 620 }
    }
  ]
}
```

Plugin and contribution IDs are stable persistence keys. Do not rename them after publishing. Plugin versions use semantic version text. `settingsContribution` optionally references one `canvas-app`; CanvasTTY shows a dedicated **Settings** action for it in the Extensions menu. Every installed `home-widget` also appears beside the built-in widgets in **Settings → Appearance → HOME composition**, where it is added or removed. `minSize` is optional for `canvas-app` and `window` contributions, must not exceed `defaultSize`, and may be as small as 240 × 140 pixels. Older manifests keep the 320 × 220 host minimum. HOME starts with a spacious 16 × 12 logical grid while preserving the original 12 × 8 composition. The editor can resize its visible boundary up to 48 × 36 without shrinking cell dimensions, and adding a widget grows the boundary automatically when needed. Canvas apps use world-space pixels and participate in the same snapping system as terminal cards.

`platforms` is optional; when present it must include `"canvastty"` or direct install/update is rejected. `minHostVersion` is informational: the showcase marks plugins that target a newer host, but it does not block installation. This lets separately packaged release builds keep using compatible source packages without treating older minimum versions as mismatches.

### Optional modules

A modular manifest declares integrity-checked coreFiles plus up to 16 optional modules. Every file entry contains path, exact bytes, and a SHA-256 digest. CanvasTTY downloads only the manifest for inspection, shows checkboxes, per-module size and permissions, then downloads only the core and selected module files. Changing the selection later replaces the installed package atomically and removes deselected files. A contribution may set module to disappear when that module is not installed.

Module file integrity (exact byte counts and SHA-256 digests) is verified against the hashes declared in the plugin manifest, and the manifest itself is fetched from GitHub over TLS without a separate signature. The trust anchor is therefore the plugin's GitHub repository: a compromised repository can ship a new manifest with matching hashes.

### Optional agent hooks

`hooks` declares up to 16 JavaScript entries. A hook has a stable `id`, a display `title`, an `entry` ending in `.js`, `.mjs`, or `.cjs`, one or more agent `providers`, and one or more semantic `events`: `session-start`, `prompt-submit`, `permission-request`, `permission-result`, `after-tool`, `stop`, or `session-end`. Providers that do not expose a requested semantic event simply do not invoke that event. In a modular plugin, a hook entry must be integrity-declared by its optional `module`, or by `coreFiles` when the hook has no module. A non-modular package must contain the validated entry path.

A hook-only plugin uses an empty `contributions` array and a non-empty `hooks` array. Installation only copies and validates the file. The user must inspect the repository and complete a separate trust confirmation in **Settings → Agents → Hooks**. CanvasTTY's host-owned registry is consulted for every invocation, so disabling a hook prevents subsequent invocations even when the provider session is still running. Enabling a newly installed hook may require a new or restarted agent session when that provider's launch-time hook bridge is not already present.

Provider-native hook review remains in force. For example, Codex may additionally ask the user to review the launch-time CanvasTTY bridge in its own `/hooks` flow. CanvasTTY does not pass Codex's global `--dangerously-bypass-hook-trust` flag; enabling a plugin hook in CanvasTTY never weakens trust checks for unrelated provider hooks.

The script runs as a separate process with the plugin directory as its working directory. It receives one JSON object on stdin:

```ts
interface CanvasTTYAgentHookInput {
  apiVersion: 1;
  pluginId: string;
  hookId: string;
  terminalSessionId: string;
  provider: "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok";
  event: "session-start" | "prompt-submit" | "permission-request" | "permission-result" | "after-tool" | "stop" | "session-end";
  providerEvent: string;
  payload: unknown;
}
```

Hook stdout/stderr is discarded, execution is time-bounded, and CanvasTTY's internal runtime/browser capability tokens are removed from the child environment. This is isolation from host internals, not a sandbox: the hook still has the user's normal filesystem and process privileges.

host.onStorageChange(listener) notifies every live contribution of the same plugin — canvases, HOME widgets, and separate windows — of writes made through host.storage.set, avoiding polling when a plugin coordinates several surfaces.

## Permissions

| Permission | SDK capability | Data boundary |
|:--|:--|:--|
| `storage` | `storage.get`, `storage.set` | Isolated JSON storage, 64 KB per plugin |
| `secrets` | `secrets.get`, `secrets.set`, `secrets.delete` | String secrets encrypted with Electron `safeStorage`; fails closed when protected OS storage is unavailable |
| `sessions:read` | `sessions.list` | ID, provider, title, status, start time, exit code only |
| `limits:read` | `limits.get` | The same sanitized `LimitsSnapshot` used by HOME |
| `launcher:open` | `launcher.open` | Opens the built-in provider Focus Card or terminal action; it does not bypass user launch choices |
| `external:open` | `external.open` | Opens only an explicit HTTP(S) URL through the OS |
| `browser:open` | `browser.open` | Opens only an explicit HTTP(S) URL in CanvasTTY's embedded Browser card and its shared browser session, including localhost |
| `media:library` | `media.*` | User-selected music folders only; absolute paths are never exposed and audio is served through seekable `canvastty-media://` streams |
| `playlists:read` | `playlists.list`, `playlists.read` | Reads `.m3u`, `.m3u8`, and `.pls` in a granted music folder plus `.json` under its `Playlists/` directory, up to 4 MB each |
| `playlists:write` | `playlists.write` | Atomically writes a named playlist into the granted folder's `Playlists/` directory, up to 4 MB |
| `hermes:hud` | `hermesHud.*` | Starts the installed Hermes Desktop in its real HUD mode, reads its live runtime state, or asks the app to quit; no arbitrary command or process API is exposed |
| `network` | browser `fetch` | Allows HTTPS and loopback requests in the plugin CSP; no CanvasTTY credentials are attached |

Declaring a permission does not expose a generic IPC channel. Unknown methods and permissions are rejected.

## SDK

Load the host SDK as an external script:

```html
<script src='canvastty-plugin://host/sdk.js'></script>
<script src='./index.js'></script>
```

The SDK creates `window.CanvasTTYPlugin`:

```js
const host = window.CanvasTTYPlugin;

host.onContext(({ appearance, contribution }) => {
  document.documentElement.dataset.palette = appearance.palette;
  document.title = contribution.title;
});

const sessions = await host.request("sessions.list");
await host.storage.set("draft", { text: "Local to this plugin" });
const draft = await host.storage.get("draft");
await host.secrets.set("oauth-token", token);
const restoredToken = await host.secrets.get("oauth-token");
await host.request("launcher.open", { provider: "codex" });
await host.canvas.open("notes");
await host.request("window.open", { contributionId: "focus" });
await host.request("browser.open", { url: "http://localhost:9210" });
const hermes = await host.hermesHud.getState();
if (hermes.state === "stopped") await host.hermesHud.open();
if (hermes.state === "running") await host.hermesHud.close();

const library = await host.media.pickLibrary();
if (library) {
  const audio = document.querySelector("audio");
  const tracks = await host.media.scanLibrary(library.id);
  if (audio) audio.src = tracks[0]?.streamUrl ?? "";
  const playlists = await host.playlists.list(library.id);
  const text = playlists[0] ? await host.playlists.read(library.id, playlists[0].id) : "";
  await host.playlists.write(library.id, "favorites.m3u8", text || "#EXTM3U\n");
}
```

Supported methods are `host.getContext`, `storage.*`, `secrets.*`, `sessions.list`, `limits.get`, `launcher.open`, `canvas.open`, `external.open`, `browser.open`, `window.open`, `media.*`, `playlists.*`, and `hermesHud.*`. `canvas.open` opens or focuses a `canvas-app` contribution from the same plugin, placing it beside the requesting canvas card when possible. `browser.open` completes only after the workspace creates or focuses its Browser card and navigates it once; it accepts normalized HTTP(S) URLs only (not free-text searches, `file:`, `data:`, `javascript:`, `about:`, or credentialed URLs). `window.open` may target only a `window` contribution declared by the same plugin. `hermesHud.open` and `hermesHud.close` use a fixed Hermes control contract; plugins cannot choose an executable, arguments, or PID.

Use `storage` for non-sensitive JSON preferences and `secrets` only for credentials such as OAuth tokens or API keys. Secrets are string-only, limited to 32 keys / 16 KB per value / 64 KB per plugin, removed on uninstall, and never fall back to plaintext storage. A secret call fails explicitly when the operating system cannot provide protected encryption.

Music-library grants persist across restarts and can be listed or revoked by the owning plugin. Scans skip symlinks and return relative paths, metadata, and opaque stream URLs rather than the absolute library root. Uninstalling the plugin revokes all of its grants. Playlist contents are returned as authored and are intentionally format-neutral, so a player may use standard M3U/PLS or its own JSON schema; an imported playlist may itself contain absolute paths.

### Building a full player plugin

A local-library player normally declares:

```json
"permissions": ["storage", "media:library", "playlists:read", "playlists:write"]
```

Add `network` only for remote catalogs, radio, artwork, or streams; add `external:open` only for explicit links opened in the system browser; and add `browser:open` only for explicit HTTP(S) pages intended for CanvasTTY's shared embedded browser. `storage` is intended for player preferences, favorites, queue state, and other small JSON metadata; audio files remain in user-selected folders.

| SDK call | Result and intended use |
|:--|:--|
| `host.media.pickLibrary()` | Opens the native directory picker and persists the grant; returns `{ id, name }` or `null` when cancelled |
| `host.media.listLibraries()` | Restores this plugin's granted libraries after a restart without exposing absolute paths |
| `host.media.scanLibrary(libraryId)` | Recursively returns up to 20,000 supported tracks with `id`, display name, relative path, size, MIME type, and `streamUrl` |
| `host.media.revokeLibrary(libraryId)` | Removes this plugin's grant for the selected folder |
| `host.playlists.list(libraryId)` | Lists up to 2,000 readable playlist files in the granted library |
| `host.playlists.read(libraryId, playlistId)` | Returns the original UTF-8 playlist text, up to 4 MB |
| `host.playlists.write(libraryId, name, content)` | Atomically writes `.m3u`, `.m3u8`, `.pls`, or `.json` under the library's `Playlists/` directory, up to 4 MB |

Scanned audio extensions are `.aac`, `.flac`, `.m4a`, `.mp3`, `.oga`, `.ogg`, `.opus`, `.wav`, and `.webm`. Assign `track.streamUrl` directly to an `<audio>` element; the host supports byte-range responses so duration probing and seeking work. A plugin with `media:library` may also `fetch(track.streamUrl)` when it needs the bytes for browser-side metadata parsing. The complete method overloads and result interfaces are in [`plugin-api.d.ts`](plugin-api.d.ts).

Recommended startup flow: call `listLibraries()`, ask for a folder with `pickLibrary()` only when none is granted, scan the chosen library, restore queue/preferences from `storage`, then list and parse playlists. Treat revoked or moved folders as an explicit unavailable state and let the user choose them again.

Context updates include the active CanvasTTY locale and palette. Plugins own their internal localization and styling; they should remain legible at the contribution's intended size and should not invent loading progress, sessions, status, limits, or telemetry.

## Install and manage

1. Publish the static package at the root of a public GitHub repository.
2. Open **Settings → Plugins**.
3. Paste `https://github.com/owner/repository` and choose **Inspect**.
4. Review the manifest and requested permissions, then confirm **Install**.
5. Enable/disable or uninstall the package from the same section. HOME widgets are added or removed beside the built-in widgets under **Appearance → HOME composition**. If the manifest declares `settingsContribution`, the plugin card also shows a dedicated **Settings** action.
6. Open **Settings → Appearance → HOME composition**, then choose **Edit HOME** to drag tiles, resize them, or pull the bottom-right HOME boundary. The Settings tile is retained as the recovery entry point; all other core and plugin tiles are optional.

The current installer intentionally rejects private repositories, GitHub `/tree/branch/subdirectory` links, and repositories that require a build step. Publish a ready-to-run static package at the repository root.

Browsing and searching the showcase work without an account through GitHub's public search API. Signing in is optional and only raises GitHub's search limits; when the anonymous limit is reached, CanvasTTY shows when to try again. The optional showcase sign-in uses GitHub's OAuth device flow. Build maintainers can [register an OAuth App and enable Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), then store its public client ID in the `CANVASTTY_GITHUB_CLIENT_ID` GitHub Actions repository variable. Official builds bake in that value when configured; local builds can use `GITHUB_OAUTH_CLIENT_ID` or `CANVASTTY_GITHUB_CLIENT_ID`, and either variable can also override the bundled value at runtime. No client secret is shipped or required. Sign-in opens GitHub in CanvasTTY's built-in Browser by default and offers the system browser as an explicit fallback. Without a client ID the UI reports that OAuth is unavailable, while direct repository inspection and installation continue to work. Signing out removes the encrypted local session; revoke the OAuth grant separately under [GitHub application settings](https://github.com/settings/applications) when needed.

## Author checklist

- Use only structured host data and explicit loading/unavailable/error states.
- Request the smallest permission set.
- Keep all scripts external; do not depend on inline script execution.
- Do not expect Node.js, filesystem paths, PTY history, provider tokens, or parent DOM access.
- Test the HOME widget at its smallest declared grid size and during canvas zoom.
- Test canvas apps in semantic summary mode below `0.5×`.
- Test the same SDK calls in both embedded and separate-window contributions.
- Run CanvasTTY's `npm test`, `npm run typecheck`, and `npm run build` when contributing an example or host change.
