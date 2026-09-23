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

## Local-only user data

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
| Other logs | Local stdout/stderr only; CanvasTTY has no remote log collector or project-operated telemetry endpoint |

Exact `userData` paths may vary with OS configuration. CanvasTTY asks Electron for the correct per-user directory and never uses the source checkout as runtime storage.

## Credential boundary

Provider credentials are read only in the trusted main process when a source-backed quota request needs them. They are sent only to that provider's matching endpoint, are not logged, are not persisted by CanvasTTY, and never cross the typed preload bridge. Kimi's loopback usage token remains in process memory and its child stderr is discarded.

Sanitized percentages, window metadata, timestamps, and explicit unavailable reasons may cross IPC. Raw provider responses, bearer headers, cookies, and credential files may not. Runtime-plugin secrets are a separate opt-in boundary: they cross only the owning sandbox's request path when its manifest declares `secrets` and are encrypted at rest through Electron `safeStorage`.

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
