# Runtime plugins

[English](plugins.md) · [Русский](plugins.ru.md) · [简体中文](plugins.zh-CN.md) · [Docs home](README.md)

CanvasTTY runtime plugins are installed from an HTTPS GitHub repository. A plugin can contribute sandboxed web surfaces and can optionally declare agent hook scripts and long-lived services. Web contributions run without Node.js. Agent hooks and services are native code: a separate, explicit trust boundary that stays off until the user enables each hook in **Settings → Agents → Hooks** and each plugin's services in **Settings → Agents → Extension native code**.

## Trust model

Installing a plugin is equivalent to allowing third-party browser code to run locally. CanvasTTY reduces that trust surface, but cannot make unknown code trustworthy:

- CanvasTTY downloads only the default-branch tar archive for a GitHub repository root URL and never runs `npm install`, build hooks, native modules, or repository scripts during install/update.
- The package must contain no symlinks and is limited to 500 files or directories / 25 MB. Individual served assets are limited to 8 MB.
- A plugin frame has an opaque sandbox origin, no access to the parent DOM, no `window.canvasTTY`, and no Node.js API.
- The separate-window preload exposes no Node primitives. It forwards the same SDK messages through an identity-checked IPC handler.
- Every privileged SDK method is gated by a manifest permission. Permissions are shown before the user confirms installation.
- Sandboxed web contributions never receive provider credentials, PTY buffers, working directories, raw provider responses, or filesystem access.
- Disabling or uninstalling a plugin immediately stops serving its assets and closes its separate windows.
- Declared services follow the same rule as hooks, per plugin: install never starts them, and update, module changes, disabling, or a changed entry file revokes the confirmation. Services run out of process; no plugin code runs in the CanvasTTY main process.
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

An end-to-end sandboxed web-surface example (without a privileged hook) lives in [`examples/plugins/studio-kit`](../examples/plugins/studio-kit). A minimal service with a canvas app that calls it lives in [`examples/plugins/service-echo`](../examples/plugins/service-echo). A launch contributor lives in [`examples/plugins/launch-env`](../examples/plugins/launch-env), and a launch policy in [`examples/plugins/yolo-guard`](../examples/plugins/yolo-guard). A session environment (git worktree) lives in [`examples/plugins/env-worktree`](../examples/plugins/env-worktree). A decision service lives in [`examples/plugins/deny-rm`](../examples/plugins/deny-rm). An agent tool, a card action and session events live in [`examples/plugins/collect-demo`](../examples/plugins/collect-demo).
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

### Services (apiVersion 2)

A manifest with `"apiVersion": 2` may declare up to 8 `services`. Version 1 manifests stay valid; only `services` needs version 2.

```json
"services": [
  { "id": "echo", "title": "Echo", "description": "Echoes requests.", "entry": "services/echo.mjs" }
]
```

A service has a stable `id`, a `title`, an optional `description` and `module`, and an `entry` ending in `.js`, `.mjs`, or `.cjs`. The entry must be a bundled single file (for example built with esbuild): the installer runs no build and no `npm install`, and Electron and node-pty are not available to it. In a modular plugin the entry must be integrity-declared by its `module`, or by `coreFiles` when it has none, exactly like hook entries. When the user trusts the plugin's native code, CanvasTTY records the entry's SHA-256 and checks it again before every start; a changed file is never run and the confirmation is revoked on the next launch.

Lifecycle: every service of an enabled, trusted plugin runs as its own process (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`) with the plugin folder as its working directory. The environment is minimal: `PATH`, `HOME`, user, shell, locale, temp and XDG folders, `SSH_AUTH_SOCK`, and the Windows system folders. Provider keys, tokens, `NODE_OPTIONS`, and every `CANVASTTY_*` variable are removed. A service that exits unexpectedly restarts after 1, 2, 4, 8, then 16 s; after more than 5 unexpected exits in 10 minutes it stays failed until its trust is confirmed again. Disabling, uninstalling, updating, changing modules, revoking trust, or quitting CanvasTTY stops it: first a `canvastty.shutdown` notification and closed stdin, then `SIGTERM`, then `SIGKILL`. `<userData>/plugin-data/<pluginId>` is created for the service and removed on uninstall. Its stderr, non-protocol stdout, `log` calls, and lifecycle events go to a bounded per-plugin log (the last 300 entries) shown under the plugin in **Settings → Agents → Extension native code**.

Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout, at most 1 MB per message in each direction. A larger message from the host is refused; a larger line from the service is dropped and logged. The host first sends a notification:

```json
{"jsonrpc":"2.0","method":"canvastty.initialize","params":{"apiVersion":2,"pluginId":"com.example.service-echo","serviceId":"echo","dataDir":"…/plugin-data/com.example.service-echo","locale":"en","hostVersion":"1.7.0"}}
```

At app start, services are started only after every host API they may call (`sessions.*`, `cards.setBadge`, `secrets.get`, …) is ready, and before saved cards are restored: a service can call them as soon as it gets `canvastty.initialize`, and one that subscribes to session events then receives the restored cards as events or in the `sessions.subscribe` snapshot.

Requests from the plugin's own surfaces arrive with the method and params chosen by the surface; method names starting with `canvastty.` are reserved for the host. Answer with `{"jsonrpc":"2.0","id":…,"result":…}` or `{"jsonrpc":"2.0","id":…,"error":{"code":-32000,"message":"…"}}`. A request unanswered within 15 s fails with a timeout error, as does a request while the service is stopped, restarting, or failed; at most 64 requests wait at once per service.

A service may call back this host API (the base that later extension points add to; anything else is answered with error `-32601`):

| Method | Kind | Gate | Result |
|:--|:--|:--|:--|
| `log` `{ level?: "info" \| "warn" \| "error", message }` | request or notification | none | Adds a line to the plugin log |
| `storage.get` `{ key }` | request | `storage` permission | The same isolated 64 KB storage as `host.storage.get` |
| `storage.set` `{ key, value }` | request | `storage` permission | Writes it and notifies the plugin's surfaces |
| `event` `{ event, data }` | notification | none | Delivered to this plugin's live surfaces through `host.service.onEvent` |
| `redaction.register` `{ values }` | request | none | Up to 32 strings (4096 characters each, 8 or more to count) that CanvasTTY masks in every text one agent reads from another; kept in memory only |
| `secrets.get` `{ key }` | request | `secrets` permission | The plugin's own secret (the same store as `host.secrets`), or `null`. The value is then masked like `redaction.register` values. For keys a service needs itself (an API key for a model it calls); never send one back to a surface |
| `sessions.subscribe` / `sessions.list` / `sessions.unsubscribe` | request | `sessions:events` | Card events and the open cards (see [Session events](#session-events-and-plugin-owned-cards-sessions)) |
| `sessions.create` | request | `sessions:launch` | Starts a card the plugin owns |
| `sessions.send` / `sessions.stop` | request | `sessions:control` | Only for cards the plugin started |
| `cards.setBadge` `{ sessionId, badge }` | request | `cards:decorate` | A short plain-text badge on any card (see [Card badges and actions](#card-badges-and-actions-cardsdecorate)) |

The host binds every call to the service's own plugin; a service cannot name another plugin or read another plugin's secrets, and reaches sessions only through the `sessions:*` permissions below. The example [`service-echo`](../examples/plugins/service-echo) saves a token from its page with `host.secrets.set` and its service reads it with `secrets.get`, answering only whether one is set.

UI channel: sandboxed surfaces call their own plugin's services, and only those:

```js
const reply = await host.service.request("echo", "echo", { text: "hi" });
host.service.onEvent(({ serviceId, event, data }) => { /* … */ });
```

The permission is implicit when the plugin declares a service. The host relays opaque JSON and never adds credentials. A request to a service that is not running (not trusted yet, disabled, restarting, failed) or that times out rejects with an error.

### Launch contributors (`launch:contribute`)

One service per plugin may add a `launch` block. Its fields appear in the agent launcher under **Advanced** once the plugin's native code is trusted; the person turns the plugin on for one launch with **Use _plugin name_** and sets its fields. Only launches where the person chose the plugin, and restarts and restores of those cards, ask the plugin anything.

```json
"permissions": ["launch:contribute"],
"services": [{
  "id": "launcher", "title": "Launch env", "entry": "services/launcher.mjs",
  "launch": {
    "appliesTo": ["claude"],
    "fields": [
      { "key": "enabled", "label": "Add the variable", "kind": "boolean", "default": true },
      { "key": "greeting", "label": "Value", "kind": "text", "default": "hello", "maxLength": 60 },
      { "key": "mode", "label": "Mode", "kind": "select", "default": "plain",
        "options": [{ "value": "plain", "label": "Plain" }, { "value": "loud", "label": "Loud" }] }
    ]
  }
}]
```

Up to 8 fields; `kind` is `boolean`, `select` (1–16 options) or `text` (at most 200 characters, or `maxLength`). `appliesTo` lists agent providers; omitted means every agent. The chosen values are checked against the fields, saved in the card's session record (at most 4 KB per plugin), and reused on restart and restore. They are not secret: put keys in the plugin's `secrets`, never in a field.

A `select` with `"optionsFrom": "service"` also lists choices the service offers, such as its own accounts. When the launcher opens, CanvasTTY asks the service `canvastty.launch.options` `{ provider, fields: [keys] }` and waits at most 3 s; the answer `{ "<key>": [{ value, label }] }` adds up to 64 choices per field after the declared ones (which stay required and are all the launcher shows when the service does not answer). Because such a list can change after a card was saved, its value is accepted as any text up to 200 characters without control characters, and `canvastty.launch.prepare` must check it and refuse a value it no longer knows.

Orchestrators pass the same values to `spawn_agent` as `launchOptions` (`{ "<pluginId>": { "<key>": value } }`), checked exactly like the launcher's, but only to a plugin whose `launch` declares `"delegable": true` (its options are safe for an agent to choose; without it only the person chooses them, and `list_providers` does not list them); a plugin tool can hand them out (for example the account it picked). Whatever a contribution adds is checked the same way for every launch: no permission, sandbox, hook or bypass flags, and no configuration the CLI reads that sets approvals (an OpenCode `OPENCODE_CONFIG` file or `OPENCODE_CONFIG_DIR`, `OPENCODE_PERMISSION`, Kimi's `--config`/`--config-file`); a file CanvasTTY cannot read and check is refused. While a child's launch waits for its plugins (launch options, a launch policy, an environment), `spawn_agent` answers only after its `prompt` reached the started agent, and `send_to_agent` waits the same way. A refused, failed or cancelled launch fails the call with the reason and the session id (the card stays); the text is dropped, never kept for a later restart. The control CLI answers `NOT_READY` for such a card.

Before the agent starts, the host sends the service a `canvastty.launch.prepare` request, which surfaces cannot send:

```json
{"sessionId":"…","provider":"claude","profile":"normal","role":"agent","cwd":"/project","restoring":false,"resume":false,"options":{"enabled":true,"greeting":"hello","mode":"plain"},"chosen":true,"environment":null}
```

The answer is `null` (nothing to add) or an object with any of:

| Key | Limit | Effect |
|:--|:--|:--|
| `env` `{ NAME: value }` | 32 names, 8 KB per value | Added to the agent's environment |
| `secretEnv` `{ NAME: secretKey }` | 16 names; needs `secrets` | The host reads the plugin's own secret in the main process and sets it. The value never reaches the service or any UI, and is masked as `<redacted:secret>` in text other agents and the control CLI read from this card (observe, result, screen, failure details) |
| `args` `[string]` | 32, 1024 characters each, no control characters | Appended after CanvasTTY's own arguments, before the resume selection |
| `files` `[{ relPath, content }]` | 16 files, 256 KB, plain relative paths | Written to a private folder for this run, removed when the process exits; `{launchFiles}` in `env` values and `args` becomes that folder |
| `thirdPartyModel` `true` | — | The agent runs on another model than its vendor's (an API or Ollama account). Profile `auto` then runs as accept-edits for this launch, and the card says so. A launch policy may set it too: it only ever makes a launch stricter |
| `refuse` `{ reason }` | 240 characters | The card is not started and shows the reason |

Rules the host enforces, none of which is ever skipped:

- Several chosen plugins are asked side by side and merged in plugin-id order. Two plugins setting the same name, or a plugin setting a name CanvasTTY sets for this launch, refuses the launch and names them. Names starting with `CANVASTTY_`, `ELECTRON_`, `DYLD_` or `LD_`, and `NODE_OPTIONS`, `PATH`, `TERM`, `COLORTERM`, are reserved.
- Arguments that bypass approvals or pick a conversation (every provider's YOLO flag, `--permission-mode`, `--sandbox`, `--resume`, `--continue`, `--session`, and the like) are refused: the profile and the restore rules stay the person's and the core's. This is not a sandbox; trusted native code already runs as you.
- Claude Code applies only its last `--settings`, so a plugin's inline `--settings` JSON is merged into CanvasTTY's own (objects such as `env` key by key, hook lists appended); one that sets `permissions`, `hooks`, `disableAllHooks`, `sandbox`, `defaultMode` or `apiKeyHelper` is refused. Both `--settings <json>` and `--settings=<json>` are checked; a settings file is accepted only as one of the contribution's own launch files (`{launchFiles}/…`), which CanvasTTY reads, checks the same way and passes inline; any other file path is refused. `--bare`, `--safe-mode`, `--allowedTools`, `--permission-prompt-tool` and `--permission-prompts` are CanvasTTY's too.
- No answer within 5 s, an error, an invalid answer, a missing secret, or a plugin that is disabled, removed or no longer trusted refuses the launch with the reason on the card. The agent is never started without a contribution the person chose. A restored card whose plugin is unavailable comes back stopped with that reason and keeps its record until the plugin returns or the card is closed.
- A plain terminal takes no launch options.

**Launch profiles.** `profile` is `normal` (the default), `yolo`, or `auto`. `auto` exists only for agents whose CLI has a native auto mode, checked against each CLI's `--help`: Codex `--approve-for-me` (its own reviewer, in its `workspace-write` sandbox), Claude Code `--permission-mode auto` with its sandbox (`{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":false}}` merged into the one `--settings`), and Grok `--permission-mode auto` (no Grok sandbox is relied on). Base protection and decision services keep answering in front of it (Codex, Claude Code). When any contributor answers `thirdPartyModel: true`, `auto` becomes the CLI's accept-edits mode in the same sandbox (Codex `--sandbox workspace-write --ask-for-approval on-request`, Claude Code and Grok `--permission-mode acceptEdits`): the native reviewer would be that same model, and a weak model's own classifier is not a safety boundary.

**Trusted folder.** A subagent on this computer whose folder is the one the person chose for its top-level agent, or inside it, gets `"trustedFolder"`: that folder's real path. CanvasTTY itself answers Codex's "Trust this folder?" for it with a per-run `-c projects=…` override (nothing is written to `~/.codex`); a plugin that keeps the agent's own config home (an account's `CLAUDE_CONFIG_DIR`, say) may mark the folder trusted there. Codex also gets per-run trust for the hooks CanvasTTY itself adds (`-c hooks.state=…`), so it does not stop at "Hooks need review"; a project's or the person's own hooks still ask. Plugins cannot pass `-c hooks…`.

**Launch policies.** With `"policy": true` the service is also asked before every launch of the agents it applies to (create, restart, restore) where the person did not choose it, with `"chosen": false` and empty `options`. Such an answer may only be `null` or `refuse`; anything else, no answer within 5 s, or an error refuses the launch, so a policy never lets a launch through by failing. Every `canvastty.launch.prepare` also carries `"environment"`: `{ pluginId, kind }` of the card's environment, or `null` on this computer. A policy with no `fields` is not shown in the launcher. Revoking the plugin's native code trust removes its policy.

```json
"launch": { "policy": true, "fields": [] }
```

The full examples are [`examples/plugins/launch-env`](../examples/plugins/launch-env) (options) and [`examples/plugins/yolo-guard`](../examples/plugins/yolo-guard) (a policy that refuses YOLO outside an environment).

### Session environments (`environment:provide`)

An environment is where a card runs: a git worktree, a container, a remote host. A plugin may list up to 8 `environments` kinds, on one service or split over several (for example one service per module); each kind is unique in the plugin and answered by the service that lists it. Once the plugin's native code is trusted, the launcher's **Advanced** section shows **Where** (default **This computer**) with each kind that applies to the provider, and its optional `fields` (same kinds and limits as launch fields). While a kind applies to terminals, **Open terminal** opens the same launcher (folder and Where) instead of opening at once.

```json
"permissions": ["environment:provide"],
"services": [{
  "id": "worktree", "title": "Git worktree", "entry": "services/worktree.mjs",
  "environments": [{
    "kind": "worktree", "label": "Git worktree",
    "description": "A branch in its own folder",
    "appliesTo": ["terminal", "claude"],
    "fields": [{ "key": "branch", "label": "Branch", "kind": "text", "default": "", "maxLength": 80 }],
    "keeps": { "launch": true }
  }]
}]
```

`keeps` declares what of CanvasTTY's protection reaches the agent there: `launch` (the launch's arguments and environment reach the agent unchanged, so CanvasTTY's hooks and the profile's per-run settings work), `isolated` (the agent does not run on this computer's files: a container or a remote host) and `confines` (the environment itself confines the agent to the project). Undeclared means no: any profile but normal is refused without `launch`, and the card says that base protection does not reach the agent there. An `isolated` environment is not wrapped in CanvasTTY's agent isolation again (the card names the environment's own boundary); any other runs inside it, with the environment's folder as the project.

Checkpoint restoration also refuses repositories when the current index or saved checkpoint contains submodules: parent-repository snapshots do not preserve dirty or untracked data inside nested repositories. Safeguard and restore that state with Git separately; CanvasTTY does not recursively delete or reset submodules.

Checkpoint restoration cannot suspend an isolated agent by pausing its local SSH/container wrapper. CanvasTTY refuses restoration for related isolated launches, including after the wrapper exits; that exit does not establish remote workload termination. The host remembers the isolation declaration and project scope used by successful launches in the saved host-only card record, independently of later plugin changes or app restarts. Legacy placed cards without this evidence, and malformed evidence, are treated as unknown isolation scope and refuse restoration. These guards cover tracked host sessions, not untracked external workloads.

CanvasTTY keeps the card, the PTY, the saved record and the restore order; the service answers five host-only requests (surfaces cannot send them):

| Request | Params | Answer | Budget |
|:--|:--|:--|:--|
| `canvastty.environment.prepare` | `sessionId, kind, provider, cwd, options` | `{ ref, label, cwd? }` or `{ refuse: { reason } }`. `ref` is opaque JSON of at most 4 KB saved with the card; `label` (80 characters) is the badge; `cwd` (an existing absolute folder) becomes the card's folder | 15 s |
| `canvastty.environment.wrap` | `sessionId, kind, ref, provider, command, args, env, secretEnvNames, cwd` | `{ command, args, env?, secretEnv?, cwd? }` or `{ refuse }` | 5 s |
| `canvastty.environment.resume` | `sessionId, kind, ref` | `{ ok: true }` or `{ stopped: { reason } }` | 10 s |
| `canvastty.environment.release` | `sessionId, kind, ref, keepData, reason` (`closed` or `quit`) | ignored | 10 s |
| `canvastty.environment.describe` | `sessionId, kind, ref` | `{ label, detail? }` for the card badge and its tooltip | 3 s |

- `prepare` runs once, when the card first starts. `wrap` runs before every start (create, restart, restore) and turns what the host would spawn into what runs inside the environment, for example `ssh -tt host …`, `docker exec -it …`, or the same program in another folder. The host still spawns it with node-pty, so scrollback, status and orchestration work unchanged.
- `wrap` output is checked: `command` must be an absolute path to an executable file or a bare program name that the host resolves on `PATH`; a command line, a relative path or shell syntax is refused, and nothing runs through a shell. `args` is an array (256 items, 8 KB each, no NUL). `env` and `secretEnv` follow the launch-contributor rules: reserved names are refused, and so is any name CanvasTTY or a launch option already sets for this launch. `secretEnv` values come from the plugin's own secrets (needs `secrets`) and are masked like launch secrets.
- `wrap` receives the launch's own variables (from CanvasTTY and chosen launch options) without reserved `CANVASTTY_*` names and without secret values; `secretEnvNames` lists names whose values the spawned process gets from the host, so a wrapper can forward them by name (`docker exec -e NAME`).
- Restore resumes every saved environment first, then starts parents before children. If the plugin is disabled, removed or untrusted, or `resume` answers `stopped`, the card comes back stopped with the reason and keeps its record; Restart asks `resume` again. A card is never started locally instead, and a timeout or error refuses, never falls back.
- Until `prepare` succeeds, the card's saved record keeps the launcher's choice (plugin, kind, options) instead of a ref. If the app quits while `prepare` runs, the card comes back stopped with that reason and nothing is prepared or started until the person restarts it, which prepares again with the same options; a failed `prepare` is kept the same way. An answer to `prepare` that arrives after its card was closed or restarted, or after the app began quitting, is never used or saved: the host calls `release` with `keepData: false` and `reason: "closed"` right away, as long as it is still running.
- Closing a card in an environment asks once, "Keep environment data?", then calls `release` with the answer. Quitting releases nothing (the environment comes back with the card); with saving off, quitting calls `release` with `keepData: true` and `reason: "quit"` so compute can stop. The plugin keeps no session list of its own and has no restore logic.

The full example is [`examples/plugins/env-worktree`](../examples/plugins/env-worktree): `prepare` runs `git worktree add` in a folder under the plugin's data directory, `wrap` sets the folder, `resume` checks it still exists, `describe` shows the current branch, and `release` removes the worktree (and the branch it created) unless you keep it.

### Decision hooks (`decision:provide`)

Before a local agent's shell command or file write runs, CanvasTTY can ask a plugin: deny, ask the person, or allow. One service per plugin may declare `decide`:

```json
"permissions": ["decision:provide"],
"services": [{
  "id": "guard", "title": "rm -rf guard", "entry": "services/guard.mjs",
  "decide": { "events": ["pre-tool"], "appliesTo": ["claude", "codex"], "timeoutMs": 3000 }
}]
```

`pre-tool` is every shell and file-writing tool call, before it runs and in every permission mode, YOLO included: Claude Code, Codex and Qwen Code through their `PreToolUse` hook, OpenCode through CanvasTTY's OpenCode plugin (`tool.execute.before`). `appliesTo` limits the agents; all four when omitted. The host sends `canvastty.decide` (host-only) and waits at most `timeoutMs` (1000 to 60000; 3000 when omitted). The agent's call waits as long, so ask for more only when the answer needs it (for example a local model reading the command); CanvasTTY sizes each card's hook for the longest budget of the services that apply when the card starts, and a service trusted later gets no more than its card allows. The request carries the budget as `budgetMs`:

```ts
interface DecisionRequest {
  event: "pre-tool";
  sessionId: string; provider: string; role: "agent" | "orchestrator" | "subagent";
  cwd: string;                 // the card's working folder
  agentCwd: string | null;     // the agent's current folder, when its CLI reports it
  tool: { name: string; kind: "shell" | "edit" | "other"; command: string | null; paths: string[] };
  input: unknown;              // the tool input as the agent sent it; null when over 40 KB (truncated)
  truncated: boolean;
  budgetMs: number;            // how long CanvasTTY waits for this answer
}
// answer: { verdict: "deny" | "ask" | "allow", reason?: string } or null for no opinion
```

How answers combine, in this order:

1. **Base protection** (below) runs first; its deny is final and plugins are not asked.
2. Any plugin's `deny` wins. The model reads `CanvasTTY plugin "<name>" blocked this tool call (<reason>)`, so write the reason as what to do instead.
3. Else any `ask`: Claude Code asks the person for this call, whatever its permission mode. A timeout, an error, a stopped service or an unreadable answer counts as `ask`, never as allow.
4. Else an `allow` counts only from a plugin the person let allow: a second confirmation, **May allow agent actions**, under the plugin in **Settings → Agents → Extension native code**, revoked with its native code trust. Claude Code then runs the call without its own prompt; OpenCode's prompt for that call is answered `once`. An allow never applies to input that was too large to send whole.
5. Else nothing: the agent goes on exactly as it would without CanvasTTY.

Codex and Qwen Code take only a deny from this hook: for them `ask` and `allow` leave the decision to the CLI's own permission mode. Remote and container sessions are not covered (their hook cannot reach this computer). The hook is installed for agents started while base protection is on or a decision plugin applies, so a plugin trusted later covers new cards only. A CLI runs the call when its hook crashes, so this is a guard, not a sandbox.

The full example is [`examples/plugins/deny-rm`](../examples/plugins/deny-rm): it denies `rm -rf` of anything at the top of the working folder (`rm -rf *`, `rm -rf src`) and has no opinion on everything else. It declares `timeoutMs: 5000` to show the field; it answers at once.

### Agent tools (`tools:agents`)

A service may offer up to 16 `tools` to agents. They appear in the `canvastty_agents` MCP server as `<pluginId>__<name>` (dots in the plugin id become `_`, so `com.example.tools` + `lookup` is `com_example_tools__lookup`; Anthropic and OpenAI allow only letters, digits, `_` and `-` in tool names, at most 64 characters, and a longer name keeps the start of the id plus a short hash), next to CanvasTTY's own orchestration tools, and count as CanvasTTY's own tools: base protection does not check them (it checks shells and file writes only).

```json
"permissions": ["tools:agents"],
"services": [{
  "id": "collect", "title": "Diff stat", "entry": "services/collect.mjs",
  "tools": [{
    "name": "diffstat",
    "description": "git diff --stat of your own folder, or of one of your subagents' folders.",
    "inputSchema": { "type": "object", "properties": { "sessionId": { "type": "string" } }, "additionalProperties": false },
    "roles": ["orchestrator"]
  }]
}]
```

- `name` is `[a-z][a-z0-9_]{0,39}` and unique in the plugin; `inputSchema` is a JSON Schema whose top level is `type: "object"` (at most 8 KB); `roles` lists `orchestrator`, `agent` and/or `subagent`.
- Only sessions whose role is listed see a tool, and only while the plugin's native code is trusted and the service runs. The list is read when the agent starts, so a plugin trusted later reaches new cards. Orchestrators get the bridge as before; an `agent` or `subagent` card gets it only when a plugin tool lists its role, and then sees only plugin tools, never the core orchestration tools. Plugin tools reach Claude Code, Codex, Qwen Code and OpenCode; Kimi and Hermes share one configuration file between cards and keep the core tools only.
- A call reaches the service as `canvastty.tools.call` (host-only) with `{ tool, callerSessionId, caller, input }`, where `caller` is the calling card's summary (the same shape as session events). The host checks `input` first: an object, required keys, top-level property types, no extra keys when `additionalProperties` is `false`; deeper checks are the plugin's.
- Answer `{ content, isError? }`: `content` is text, or any JSON (sent as JSON text). The answer is masked by the redaction registry and cut to 32 K characters; no answer in 15 s, an error or a stopped service is an error result for the agent, never anything more. The caller id is all the host vouches for: a tool that acts on other sessions must check them itself (the example accepts only the caller's own subagents).

### Session events and plugin-owned cards (`sessions:*`)

`canvastty.activity` is a separate host-only integration for the enabled, native-code-trusted Assistant service installed from a canonical Assistant repository. `sessions:events` does not grant activity access. Tool equality fingerprints sent to that service are host-secret HMAC values scoped to the card and fingerprint kind; they are not plain hashes of tool input or output. Install provenance is checked on each delivery.
OpenCode tool outcomes use its direct `tool.execute.after` hook and terminal `message.part.updated` tool states, correlated with a root-turn `tool.execute.before` call. Duplicate, child-session and obsolete completions are ignored. Shell nonzero exit codes are errors; missing exit status remains unknown. Separately trusted native `after-tool` hooks keep their provider-payload permission: the direct callback supplies `{ input, output }`, and a tool-part completion supplies its provider event. This does not grant `sessions:events` subscribers access to those payloads.
Kimi core hooks report `PostToolUse` and `PostToolUseFailure`; Hermes reports `post_tool_call`, independently of native plugin hooks. Kimi's `tool_output` is an opaque `str(ret)` that can also represent a tool error: its class stays `unknown`, while an explicit failure event reports `error`. It supplies no verified changed-path evidence. Hermes shell-hook `extra` carries the result, explicit outcome status and stable turn ID; result text is never interpreted as a status.



A service with `sessions:events` calls `sessions.subscribe` `{ ownedOnly? }` (again after every start). The answer lists the open cards; after that the host sends `canvastty.sessions.event` notifications:

```ts
interface PluginSessionEvent {
  type: "created" | "restored" | "status" | "exited" | "closed";
  owned: boolean;              // this plugin started the card
  session: {
    id: string; provider: string; role: "agent" | "orchestrator" | "subagent"; parentSessionId?: string;
    title: string; status: string; exitCode: number | null; startedAt: number;
    cwd: string;               // the folder the person chose
    workingDirectory: string;  // where it actually runs (a worktree environment moves it)
    environment?: { pluginId: string; kind: string; label: string; ref: unknown };
  };
  screen?: string;             // only with sessions:read-screen, on status and exited
}
```

Events carry metadata only. With `sessions:read-screen` (the consent text says this is private data), `status` and `exited` events add the last 4000 characters of the card's output as plain text, masked by the redaction registry. `sessions.list` returns the same summaries on demand.

Control follows the agent-control gateway's model: the service is one controller and owns only what it created. Ownership is saved with the card's session record, so a restored card still belongs to the plugin that started it.

| Request | Gate | Effect |
|:--|:--|:--|
| `sessions.create` `{ provider, cwd, profile?, title?, launchOptions?, environment? }` | `sessions:launch` | Starts an `agent` card through the normal launch pipeline (launch options and environments included; a refusal shows on the card). The card is visible and never takes focus. At most 16 per plugin. Answer `{ sessionId }` |
| `sessions.send` `{ sessionId, text, submit? }` | `sessions:control` | Types the text (Enter unless `submit: false`) into a card this plugin started. A card whose launch its plugins still prepare gets it once that launch started; `sent` is false when the launch did not start (the text is dropped) |
| `sessions.stop` `{ sessionId }` | `sessions:control` | Closes a card this plugin started; its environment data is kept |

A foreign or unknown id gets the same error, so a plugin cannot probe other cards. There is no delete and no screen-reading control call.

### Card badges and actions (`cards:decorate`)

A service with `cards:decorate` can put a badge on any card and declare up to 8 `cardActions`:

```json
"permissions": ["cards:decorate"],
"services": [{
  "id": "collect", "title": "Diff stat", "entry": "services/collect.mjs",
  "cardActions": [{ "id": "show-changes", "title": "Show changes", "when": { "environmentKinds": ["worktree"] } }]
}]
```

- `cards.setBadge` `{ sessionId, badge: { text, tone?, tooltip? } | null }`: `text` is at most 24 characters, `tone` is `neutral` (default), `info`, `warn` or `error`, `tooltip` at most 200 characters; `null` removes the plugin's badge. At most 4 plugin badges per card. Badges are plain text, masked like agent text, and disappear with the card or when the plugin's trust is revoked.
- An action shows in the card's options menu on every card its `when` matches: `providers`, `environmentKinds` (any plugin's environment; a card outside an environment never matches) and `roles`, each optional; every listed key must match. Choosing it sends `canvastty.cards.invoke` `{ actionId, sessionId, session }` (host-only; `session` is the summary above) and waits at most 15 s. Answer `{ message?, tone? }`: the message (plain text, at most 2000 characters, masked) is shown as a toast on the card. A timeout or error shows an error toast.
- No HTML anywhere: badges, titles and messages are rendered as text.

The full example is [`examples/plugins/collect-demo`](../examples/plugins/collect-demo): the card action **Show changes** on cards in the `worktree` environment (from `env-worktree`) shows `git diff --stat` of the worktree and sets a "N changed" badge, and the tool `collect-demo__diffstat` gives orchestrators the same for their own folder or a subagent's, which it learns about from session events.

### Browser engines (`browser:engine`)

A service may run another browser engine for agents' background tabs, for example a headless engine that reads pages with far less CPU and memory than Chromium. It declares one `browserEngine`:

```json
"permissions": ["browser:engine"],
"services": [{
  "id": "engine", "title": "Engine", "entry": "services/engine.mjs",
  "browserEngine": { "id": "lightpanda", "title": "Lightpanda", "layout": false }
}]
```

- `id` is what agents pass as `engine` to `browser_new_tab` (`[a-z0-9][a-z0-9._-]*`, at most 64 characters, never `auto` or `chromium`, unique within the plugin). `layout` says the engine lays pages out for real; without it (the default) observation skips element geometry and clicks and hovers go through the DOM (`element.click()`), so an engine with synthetic boxes still works.
- For each tab the host calls `canvastty.browserEngine.openTab` `{ engineId, tabId }` (host-only, 20 s) and expects `{ webSocketUrl }`: a `ws://` CDP endpoint on `127.0.0.1`, `[::1]` or `localhost` with a port, anything else is refused. The core opens its own connection there, creates the page with `Target.createTarget` and drives it over a flat session, one connection per tab. `canvastty.browserEngine.closeTab` `{ engineId, tabId }` (a notification) says the tab is gone, so the service can stop its process when idle. The service starts, supervises and stops the engine process itself.
- The core owns the policy. Only an agent's new tab may use an engine: with `engine: "auto"` (the default) the first running engine, or the one it names. A tab the person opens, and `engine: "chromium"`, always get Chromium. An engine tab is never shown: the person or an agent showing it moves it to Chromium first. The engine gets no cookies, no browser profile and no credentials, only the URL; the tab's page starts empty.
- Fallback: the tab moves to Chromium under the same tab id (next document revision, refs stale) when a screenshot, a drag or a download is asked for, the page looks like a bot wall (a challenge title or text, a `/cdn-cgi/challenge-platform/` request, a 403, 429 or 503 document), the text is far too thin for the page's size, the engine lacks a CDP method (`-32601`), or the engine disconnects. The agent's result carries a `notice`; an action on an element ref answers `STALE_REF` with `details.movedToChromium`. A site that failed this way goes straight to Chromium for the rest of the session. If `openTab` fails, the tab opens in Chromium and `auto` skips that engine for a minute.

### Base protection and redaction (core)

Two safety parts are built in and need no plugin:

- **Base protection** (Settings → Agents, on by default; the person can turn it off) denies, through the same hook, sudo and other elevation, piping downloaded or generated text into a shell, download-and-run, disk and format commands, fork bombs, and writing or deleting outside the working folder: the home folder, other projects and `/tmp` included, and deleting the working folder itself. An agent's own plan and memory folders (`~/.claude/plans`, `~/.claude/projects/<project>/memory`, and the same inside the run's `CLAUDE_CONFIG_DIR`) are not "outside". It also denies any use of CanvasTTY's own private data (from the app's userData folder: the agent-control token and descriptor, the gateways' connection records and sockets, the secret stores, account homes; and the control/runtime socket folders under the temporary folder), by any program, interpreter one-liners and socket clients included; the reason points the model at an **Orchestrator** launch and the `canvastty_agents` tools. The bundled control CLI may name its descriptor. It only ever denies; each reason tells the model what to do instead (a write to `/tmp` suggests a scratch folder inside the project).
- **Secret redaction**: every text CanvasTTY hands from one agent to another (`observe_agent`, `wait_for_agent`, `get_agent_result`, the control CLI's `screen`, `result` and failure details) is masked: provider keys CanvasTTY holds, launch `secretEnv` values, values a service registered with `redaction.register`, also when the terminal wrapped them over lines, plus common key shapes (`sk-…`, GitHub, Slack, AWS, Google, JWT, `Bearer …`, `"apiKey": "…"`, PEM private keys, long random runs). Plugin tool answers, `screen` in session events, card badges and card action messages are masked the same way.

host.onStorageChange(listener) notifies every live contribution of the same plugin — canvases, HOME widgets, and separate windows — of writes made through host.storage.set, avoiding polling when a plugin coordinates several surfaces.

## Permissions

| Permission | SDK capability | Data boundary |
|:--|:--|:--|
| `storage` | `storage.get`, `storage.set` | Isolated JSON storage, 64 KB per plugin |
| `secrets` | `secrets.get`, `secrets.set`, `secrets.delete`; a service's `secrets.get` | String secrets encrypted with Electron `safeStorage`; fails closed when protected OS storage is unavailable. A trusted service reads its own plugin's secrets only |
| `sessions:read` | `sessions.list` | ID, provider, title, status, start time, exit code only |
| `launch:contribute` | A service's `launch` block and `canvastty.launch.prepare` | Can add environment variables, arguments and files to agents the person starts with its option; with `policy`, can refuse any agent launch |
| `environment:provide` | A service's `environments` and `canvastty.environment.*` | Can create a place for cards the person starts in its environment and change the command, arguments, variables and folder they run with there |
| `decision:provide` | A service's `decide` and `canvastty.decide` | Sees agents' commands and file writes (with their input) before they run and can block them or ask the person; allowing needs a second confirmation |
| `tools:agents` | A service's `tools` and `canvastty.tools.call` | Offers tools to agents of the listed roles; receives their arguments and the calling card's summary |
| `sessions:events` | `sessions.subscribe`, `sessions.list` | Card metadata: provider, role, parent, title, status, folders, environment ref; no screen text |
| `sessions:read-screen` | `screen` in status and exit events | The end of every card's output (masked): private data |
| `sessions:launch` | `sessions.create` | Starts visible agent cards through the normal launch |
| `sessions:control` | `sessions.send`, `sessions.stop` | Types into and closes only the cards the plugin started |
| `cards:decorate` | `cards.setBadge`, a service's `cardActions`, `canvastty.cards.invoke` | Plain-text badges on cards and actions in their menu |
| `browser:engine` | A service's `browserEngine` and `canvastty.browserEngine.*` | Receives the URLs of agents' background tabs and serves them from its own engine; no cookies, profile or credentials |
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

Supported methods are `host.getContext`, `storage.*`, `secrets.*`, `sessions.list`, `limits.get`, `launcher.open`, `canvas.open`, `external.open`, `browser.open`, `window.open`, `media.*`, `playlists.*`, `hermesHud.*`, and `service.request` (see [Services](#services-apiversion-2)). `canvas.open` opens or focuses a `canvas-app` contribution from the same plugin, placing it beside the requesting canvas card when possible. `browser.open` completes only after the workspace creates or focuses its Browser card and navigates it once; it accepts normalized HTTP(S) URLs only (not free-text searches, `file:`, `data:`, `javascript:`, `about:`, or credentialed URLs). `window.open` may target only a `window` contribution declared by the same plugin. `hermesHud.open` and `hermesHud.close` use a fixed Hermes control contract; plugins cannot choose an executable, arguments, or PID.

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

### Visibility

A canvas app keeps running while its card is not drawn: zoomed out to a summary, hidden while HOME is being edited, panned off-screen, or with the window minimized. The host does not reload the frame; it suspends it the way a browser suspends a background tab. While suspended, `document.visibilityState` is `"hidden"` (and `visibilitychange` fires on each change), timers (`setTimeout`, `setInterval`) wake at most once a second, and `requestAnimationFrame` callbacks wait until the card is shown again. DOM, JavaScript state, network requests, audio and workers are untouched.

```js
host.onVisibilityChange((state) => {
  if (state === "hidden") pausePolling();
  else resumePolling();
});
const current = host.visibility(); // "visible" | "hidden"
```

Plain `document.addEventListener("visibilitychange", …)` works too, without the SDK. The host message behind it is `{ source: "canvastty-host", type: "visibility", state: "visible" | "hidden" }`; plugins do not need to handle it themselves.

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
