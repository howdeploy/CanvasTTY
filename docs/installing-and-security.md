# Installing, releases, and local data

[English](installing-and-security.md) · [Русский](installing-and-security.ru.md) · [简体中文](installing-and-security.zh-CN.md) · [Docs home](README.md)

## Application updates

The first release with built-in updating must be installed manually. Later updates come from stable `howdeploy/CanvasTTY` releases. macOS retains ad-hoc application signing and uses Sparkle's separate Ed25519 archive signature. Publishing an update requires a signed appcast and the release owner's private signing key.

The release owner must configure `SPARKLE_PUBLIC_ED_KEY` as a GitHub Actions variable and `SPARKLE_EDDSA_PRIVATE_KEY` as a secret in `howdeploy/CanvasTTY`. Both are base64 encoded 32-byte Ed25519 values from one Sparkle key pair. The private key must stay outside the repository. CI checks the pair, embeds the public key in the macOS app, signs `appcast.xml` and the ZIP, and checks the stable tag and complete artifact set before publishing. A release cannot be produced without the owner's keys.

Pull-request macOS packaging uses a public test key when the owner's variable is unavailable; these CI packages are not release artifacts. Before a stable release is published, the release job also verifies that update metadata names, sizes, and SHA-512 hashes match the assembled files.

### Maintainer setup for Sparkle signing (once)

On a trusted Mac, use the pinned Sparkle 2.10.0 tools and an installed, authenticated GitHub CLI (`gh`). `generate_keys` stores the private key in the login Keychain; `--account` keeps the CanvasTTY key separate from keys for other organizations. Keep a secure backup of this key. Reuse the same pair for later releases: an app already shipped with its public key cannot verify updates signed by a different key without a planned key rotation or a manual reinstall.

```bash
npm ci
npm run build:mac-updater
gh auth status
artifacts/sparkle/distribution/bin/generate_keys --account howdeploy.CanvasTTY
gh variable set SPARKLE_PUBLIC_ED_KEY --repo howdeploy/CanvasTTY \
  --body "$(artifacts/sparkle/distribution/bin/generate_keys --account howdeploy.CanvasTTY -p)"
(
  umask 077
  key_dir="$(mktemp -d)"
  trap 'rm -f "$key_dir/private.key"; rmdir "$key_dir"' EXIT
  artifacts/sparkle/distribution/bin/generate_keys --account howdeploy.CanvasTTY -x "$key_dir/private.key"
  gh secret set SPARKLE_EDDSA_PRIVATE_KEY --app actions --repo howdeploy/CanvasTTY < "$key_dir/private.key"
)
```

After merging the update PR, run this once before creating the first release tag, using a GitHub account allowed to manage Actions variables and secrets in `howdeploy/CanvasTTY`. The exported seed is kept only in the temporary file during the upload; never commit it or use the public test key for a release. Check that both names appear under **Settings → Secrets and variables → Actions**. The release job verifies that the secret and variable form one pair before it signs the Mac update. Merging the PR does not publish a release; a `vX.Y.Z` tag does. Manual `workflow_dispatch` builds packages without publishing a release.

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

The native agent helper `canvastty-helper` (Go, standard library only, no cgo) is built for the target by `npm run build:helpers` and packaged as `resources/helpers`. It runs the agents' MCP servers and hooks on macOS and Linux; Windows keeps the bundled JavaScript helpers by default, and `CANVASTTY_HELPERS=node` forces them anywhere.

## Local user data

| Data | Location and lifetime |
|:--|:--|
| CanvasTTY settings | Electron's per-user `userData` directory (`~/.config/canvastty` on typical Linux desktops, `%APPDATA%\canvastty` on Windows, `~/Library/Application Support/canvastty` on macOS) |
| Provider credentials | The local credential store owned by the installed Codex, Claude, Qwen Code, Kimi, OpenCode, Hermes, or Grok Build CLI; CanvasTTY does not copy it |
| Temporary provider browser bridge | Kimi fallback and Hermes MCP entries are journaled, scoped to owning CanvasTTY sessions, and restored on final PTY exit or recovered after an interrupted launch; capability secrets are never written as literals |
| PTY scrollback | Bounded main-process memory for the live app session; not saved in the repository |
| Home media | The user's original local file; settings retain only its local path |
| Runtime plugins | Static packages and the enabled registry below `userData/plugins`; isolated JSON storage below `userData/plugin-storage` is capped at 64 KB per plugin and removed on uninstall |
| Plugin secrets | Encrypted blobs below `userData/plugin-secrets`; plaintext is available only to the owning enabled plugin through permission-gated calls, storage fails closed without protected OS encryption, and the file is removed on uninstall |
| Plugin media grants | `userData/plugin-media-libraries.json`; stores the absolute paths of folders explicitly selected by the user and removes a plugin's grants on uninstall |
| Plugin playlists | A plugin with confirmed write permission may create bounded files only below the selected library's `Playlists/` directory |
| Built-in browser profile | Cookies, cache, and site storage in the persistent `canvastty-browser` Electron partition; the browser is available from HOME in `1.0.2` |
| Browser restore state | Safe HTTP(S) tab URLs, tab order, and active-tab ID in `userData/browser-state.json`; disabled/cleared when tab restore is turned off |
| Browser audit log | Redacted hash-chain JSONL below `userData/browser/audit`; the active file rotates at 100 MB and rotated files older than 30 days are pruned during store initialization or rotation |
| Application diagnostics | Four rotating 1 MiB JSONL event files below `userData/logs`; a user may explicitly send recent logs and selected runtime metadata with a complaint to the configured HTTPS collector. No automatic upload; setup and contents are described in [diagnostics](diagnostics.md) |

Exact `userData` paths may vary with OS configuration. CanvasTTY asks Electron for the correct per-user directory and never uses the source checkout as runtime storage.

## Credential boundary

Provider credentials are read only in the trusted main process when a source-backed quota request needs them. They are sent only to that provider's matching endpoint, are not logged, are not persisted by CanvasTTY, and never cross the typed preload bridge. Kimi's loopback usage token remains in process memory and its child stderr is discarded.

Sanitized percentages, window metadata, timestamps, and explicit unavailable reasons may cross IPC. Raw provider responses, bearer headers, cookies, and credential files may not. Runtime-plugin secrets are a separate opt-in boundary: they cross only the owning sandbox's request path when its manifest declares `secrets` and are encrypted at rest through Electron `safeStorage`.

## Agent protection layers

Agents work in their own mode; CanvasTTY's layers sit outside it as a quiet safety net that adds no prompts for ordinary work in the project and stops what is dangerous, with a short reason the agent can act on.

**Launch modes.** Auto (the default), Manual, Accept edits, Plan and Bypass, offered only where the CLI supports them. Auto is the CLI's own auto mode where it has one (Claude Code's classifier, Codex's reviewer, Grok's classifier), CanvasTTY's per-run rules for OpenCode (your own deny and ask rules still win), and for a CLI without one its approval bypass, only inside agent isolation. Bypass is the person's choice per CLI, acknowledged once, checked in the main process, never given to a subagent, and still inside the layers below. In Manual the CLI follows its own configuration; when that configuration skips approvals, the card says so.

| Layer | Guarantees | Does not guarantee |
| --- | --- | --- |
| The agent's own permission system | What its CLI promises in the chosen mode (Claude Code, Codex, OpenCode, Grok…). | Anything the CLI's own classifier or reviewer lets through. |
| Base protection (hooks) | Denies elevation, pipes into a shell, disk commands, fork bombs, writes and deletes outside the project and access to CanvasTTY's private data, before the tool call runs, for agents whose CLI has hooks (Claude Code, Codex, Qwen Code, OpenCode). A decision plugin's "ask" is shown by Claude Code; for a CLI that cannot ask it is a deny with the reason. | It reads commands; code that hides what it does, or a CLI without hooks, is not covered. It is a guard, not a sandbox. |
| Delegation rules | A subagent never gets more than its orchestrator (never YOLO), works only in its orchestrator's project folder, within the depth and count limits the person set; orchestrators get a control connection of their own; no agent-facing tool changes settings, protection, profiles, trust or isolation; plugin launch options from an agent only where the plugin declared them delegable. | What a plugin the person trusted does with its own permissions. |
| Agent isolation (OS layer) | On macOS (sandbox-exec) and Linux (bubblewrap), for subagents, plugin-started agents and every agent not in Manual: the whole process tree writes only in the project, its own temporary folder and its CLI's own folders; keys, other CLIs' credentials and CanvasTTY's tokens are unreadable. The layer blocks foreign processes, apps, Apple events, preference writes and launchd jobs. macOS blocks foreign Unix sockets; Linux hides the user runtime folder. Strict network modes also use Landlock to deny external Unix sockets except the exact runtime, orchestration and authorized proxy endpoints; local CLI sockets created inside the sandbox remain usable. A validated plugin worktree hides its private `plugin-data` parent and sibling worktrees while keeping its own files editable. The original task checkout remains readable and unwritable. Shared Git metadata stays read-only under isolation so an agent cannot change shared objects, references or index data; `git add` and `git commit` are unavailable inside the sandbox. The host environment collects file edits into a review for the user to accept. Plan has no Git metadata writes. Fails closed. | Network is unrestricted in open mode. Strict Linux network modes require the packaged native helper and Landlock ABI 9 or newer, enabled by the kernel. Unsupported kernels refuse strict launches with a reason; open mode retains the existing bubblewrap behavior. The CLI's own sandbox cannot run inside the layer on macOS, so it is switched off there (approvals unchanged). A Claude launch may rewrite the login keychain file to save a refreshed sign-in, so it could also damage that file (other items stay behind their own access lists). Windows has no layer yet: subagents run in Manual there unless the person turns isolation off. |
| Network policy | Per project: open, allowed domains (optionally provider APIs and package registries) or offline, applied when an agent starts and shown on its card. The policy lives in CanvasTTY's private data, so a project file or plugin cannot widen it; an extra HTTPS API domain is allowed only by the person in Settings. | It applies from the next agent start. Strict modes need the macOS sandbox, or on Linux the packaged helper and Landlock ABI 9; elsewhere a strict launch is refused. Plain SSH sessions are not covered. |
| Provider keys on request | An agent asks for one configured provider key with `request_secret`; the person allows it for 10 minutes, one turn or the session, and `run_secret_request` sends typed HTTPS requests with it. The key itself is never given to the agent, and a grant can be revoked in the card's details. | What the provider's API does with the requests the person approved. |

One-turn provider-key approval is available only when the current launch installed reliable turn-completion hooks and the host has observed its active turn. It is unavailable with lifecycle hooks disabled and for providers without a per-turn completion event (including the current Hermes integration). A new submitted task, hook disable, launch replacement or turn completion revokes the turn grant; enabling hooks later requires a new launch. Ten-minute and session approvals keep their separate lifetimes.

Allowed network domains include the root and dot-separated subdomains (`example.com` permits `api.example.com`, not `notexample.com` or `example.com.attacker.test`). An explicit `*.example.com` permits descendants only. DNS resolution must still produce a public address before the proxy connects.

Isolation keeps approval configuration read-only, including OpenCode's project and custom config files and its `agent`/`agents` directories. CLI state and caches remain writable. A moved CLI home is refused if its real path overlaps host credentials or private CanvasTTY data; a selected account folder below `account-homes` remains available. Credential exclusions use the host environment captured before launch contributions, even if the launch changes `HOME`.

For the existing Accounts plugin, the host derives one transient exception from its own plugin data directory and the exact selected account ID. Only that provider's `plugin-data/canvastty-accounts/homes/<provider>-<account>` subtree is reopened. The final sandbox wrapper rechecks every directory below userData for symlinks and canonical containment; the plugin cannot return an exception list. Parent data, sibling accounts and worktrees remain hidden, and the CLI's approval configuration remains write-protected.

OpenCode Auto inspects only regular local config files of at most 1 MiB. An existing source that cannot be inspected adds no Auto allowances. A launch contributor's uninspectable config is refused; only absent optional directory candidates are skipped. JSONC comments and trailing commas are parsed without changing quoted strings.

**Git audit.** When an isolated agent session ends, is closed or is restored after a quit, CanvasTTY checks the repositories under its folder whose git folder changed. If git would now run something outside isolation (a `core.hooksPath`, a filter or diff driver, `fsmonitor`, a hook file, `info/attributes`), a notice lists exactly what changed; **Neutralize** removes those keys and disables those files, **Keep as is** leaves them. It does not undo other file changes inside the project.

### Linux: when bubblewrap cannot start

Ubuntu 24.04 and later (and other distributions with `kernel.apparmor_restrict_unprivileged_userns=1`) let only programs with an AppArmor profile create unprivileged user namespaces, which bubblewrap needs. CanvasTTY checks this once (again a minute after a failure) and, when `bwrap` is installed but cannot start, treats it like a computer without an isolation layer: subagents and plugin-started agents run in Manual, and the card says why. To allow it, either give bubblewrap its own profile (recommended, it affects only `bwrap`):

```sh
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

or lift the restriction for every program with `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` (add the line to `/etc/sysctl.d/60-userns.conf` to keep it after a reboot). New launches use the layer within a minute; no restart is needed.

## Repository guards

```bash
npm run audit:secrets
npm test
```

The audit checks high-confidence provider/cloud token formats, private-key blocks, hard-coded secret assignments, sensitive filenames, and personal absolute home paths. Repository metadata names are excluded before file-type inspection, so both a normal-clone `.git/` directory and a linked-worktree `.git` file are ignored without weakening personal-path detection in publishable files. `.gitignore` excludes local agent context, planning data, env files, credentials, logs, settings, dependencies, and generated packages. CI runs the audit before build and every release job runs it again before packaging.

No scanner is perfect. Never commit a live secret “temporarily.” If one reaches Git history, revoke it first, then purge the history before making the repository public.

## Build packages locally

```bash
npm install
npm run package
```

The build needs Go 1.21 or newer for the native helper; without Go it prints a warning and the package ships only the JavaScript helpers (`CANVASTTY_REQUIRE_NATIVE_HELPERS=1` makes that an error, as in release builds).

`npm run package` creates an unpacked app for the current OS. Platform scripts create installers:

```bash
npm run package:linux
npm run package:win
npm run package:mac
```

Run each platform script on its matching operating system. Cross-compilation is not treated as proof of compatibility because `node-pty` is native.

## Release checklist

1. Confirm the Sparkle Actions variable and secret above are configured in `howdeploy/CanvasTTY`; do not generate a new pair for each release. Confirm `package.json` and the tag use the same semantic version.
2. Run secret audit, tests, typecheck, production build, and a current-OS package build.
3. Inspect the real packaged app and verify the package-content allowlist.
4. Complete real-device update checks with candidate packages on Linux, Windows, and macOS.
5. Push `vX.Y.Z`; wait for all three GitHub Actions package jobs. The workflow publishes the tag as a stable release after its artifact checks pass.

Browser storage, agent access, and audit retention are documented in [Built-in browser and audit log](browser.md). Security reports follow the repository [security policy](../SECURITY.md).
