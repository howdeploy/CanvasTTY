https://github.com/user-attachments/assets/444612f7-cda1-4fd6-8514-2f4fac9cc520

<p align="center">
  <a href="README.md"><strong>English</strong></a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<table>
  <tr>
    <td>
      <strong>Your terminals are places, not tabs.</strong><br>
      CanvasTTY is an Electron spatial desktop for real local PTYs and AI-agent CLI sessions. Keep a fixed Home zone, arrange live terminals on an infinite canvas, and see provider limits backed by real data sources.
    </td>
  </tr>
</table>

## Stack

| Desktop | Interface | Terminal | Providers |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi · OpenCode · Hermes · Grok Build |

The application interface currently supports English and Russian. This documentation is also available in Simplified Chinese.

## One canvas, real sessions

Launch a shell or agent in a project directory, move and resize its live terminal, zoom out to navigate semantically, and return to Home for sessions, limits, media, and launch shortcuts. CanvasTTY keeps PTY state in the trusted main process and exposes only typed, allow-listed capabilities to the renderer.

## Agents, orchestration and protection

Agents start in **Auto** by default: the CLI's own auto mode (Claude Code, Codex, Grok), CanvasTTY's per-run rules for OpenCode, or, for a CLI without one, its approval bypass only inside agent isolation. Manual, Accept edits, Plan and Bypass are offered only where the CLI has them; Bypass is acknowledged once per CLI and never handed to a subagent. Around every mode sit layers the person controls in Settings → Agents: base protection (hooks that refuse elevation, `curl | sh`, disk commands and writes outside the project before the tool call runs), delegation rules (a subagent never gets more than its orchestrator and stays in its project; 2 levels and 8 live subagents by default), and an OS isolation layer (macOS `sandbox-exec`, Linux bubblewrap; none on Windows yet, where subagents run in Manual). When an isolated session ends, CanvasTTY checks the repositories it touched for git settings that would run programs outside isolation and offers to neutralize them.

An **Orchestrator** session gets the `canvastty_agents` tools: `list_providers` (installed agents, sign-in state, models, efforts, profiles), `spawn_agent` with optional `model`, `effort` and `profile`, `wait_for_agent` (up to 100 s per call, capped at 50 s for OpenCode) and `get_agent_result`, which returns a Codex or OpenCode subagent's final reply as `answer` (up to 4,096 characters, masked). See [agent orchestration and isolation](docs/agent-orchestration.md) and [protection layers](docs/installing-and-security.md#agent-protection-layers).

Beyond single subagents, an orchestrator can follow a built-in or person-approved project flow, share a task board with its subagents (`list_tasks`, `claim_task`, `update_task`, `complete_task`), ask for a reviewer or a separate git worktree, retry a failed subagent (`retry_agent`), ask the person a question (`ask_user`) and, with the person's approval, use a provider key for typed API requests without seeing it (`request_secret`). The person sets time, token and cost budgets per task tree and a network policy per project; each card's details hold its timeline, usage, report and git checkpoints.

## Windows shells and provider CLIs

On Windows, the Terminal launcher uses the built-in Windows PowerShell with a clean `-NoLogo -NoProfile` session, then falls back to `pwsh` or `cmd.exe`. Codex, Claude, Qwen Code, Kimi, OpenCode, Hermes, and Grok Build are resolved to a concrete `.exe`, `.com`, `.cmd`, or `.bat` launcher from the user's `PATH` or standard per-user CLI directories before they are passed to `node-pty`/ConPTY.

CanvasTTY does not install provider CLIs. Missing agents remain in Agents settings with an official installation link. After installation, use Check again to refresh the available launchers and limit rows. The launch diagnostic lists checked paths if a CLI is still unavailable.

## Install

Download the latest release from [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases): AppImage/deb for Linux x86_64, installer/portable app for Windows x64, and dmg/zip for Apple Silicon macOS. macOS bundles are ad-hoc signed and verified but do not have a Developer ID signature or Apple notarization; Windows packages remain unsigned. Intel Mac builds are not included yet. Read [installing and local-data security](docs/installing-and-security.md).

Or run from source:

```bash
npm install
npm run dev
```

`npm run build` and packaging also build the native agent helper (`canvastty-helper`, Go ≥ 1.21, `npm run build:helpers`) that runs the MCP servers and hooks on macOS and Linux; without Go the app keeps its JavaScript helpers, which Windows uses by default.

## Docs

| Start here | Build on CanvasTTY |
|:--|:--|
| [Documentation hub](docs/README.md) | [Widget authoring](docs/widget-authoring.md) |
| [Getting started](docs/getting-started.md) | [Metrics and telemetry](docs/metrics-and-telemetry.md) |
| [Built-in browser and audit log](docs/browser.md) | [Bundled agent browser skill](agent/browser/SKILL.md) |
| [Agent orchestration and isolation](docs/agent-orchestration.md) | [Bundled orchestration skill](agent/orchestrator/SKILL.md) |
| [Install, releases, and local data](docs/installing-and-security.md) | [Security policy](SECURITY.md) |
| [Architecture](docs/ARCHITECTURE.md) | [UI contract](docs/UI_CONTRACT.md) |
| [Runtime plugin authoring](docs/plugins.md) | [Typed plugin SDK](docs/plugin-api.d.ts) |
| [Changelog](CHANGELOG.md) | [MIT license](LICENSE) |

## Even G2 companion

The opt-in **Settings → Controls → Even G2** integration adapts CanvasTTY's terminal and AI-agent workflows to Even G2 glasses. Pair with six digits on the same local network, approve access on the computer, then read responses on the glasses HUD, dictate through local Nemotron speech recognition, and create, rename or close shared sessions. The companion includes a More agents picker and supports the desktop's provider list. Its source lives in `integrations/even-g2` and builds with the desktop. See [setup, distribution status and acceptance limits](docs/even-g2.md); a compatible public installer and Even Hub approval are still pending.

## Web companion

The opt-in [Web companion](docs/mobile-companion.md) shares selected sessions with Android, iOS, and desktop browsers through **Tailscale Serve HTTPS**, not Funnel. CanvasTTY binds its companion endpoint to `127.0.0.1:3481` in this mode; pair with a short-lived code and approve each browser on the desktop. Open **Settings → Controls → Web companion** for setup, grants, and revocation. End-to-end Tailscale Serve deployment on Windows, Linux, and macOS remains unverified.

## Runtime plugins

CanvasTTY includes a permissioned runtime for ready-to-run static GitHub packages: HOME widgets, canvas apps, and separate sandboxed windows. The host SDK now supports persistent user-selected music-library grants, seekable local audio streams, and bounded playlist import/export for full player plugins. See the [authoring and security guide](docs/plugins.md), [manifest schema](docs/canvastty-plugin.schema.json), and [TypeScript SDK declarations](docs/plugin-api.d.ts).

Plugin examples:

- [canvastty-plugin-hermes-hud](https://github.com/howdeploy/canvastty-plugin-hermes-hud) — from the CanvasTTY author: a HOME widget that starts and stops an installed Hermes Desktop in HUD mode and shows the confirmed live process state; it uses only the narrow `hermes:hud` permission.
- [canvastty-music](https://github.com/Alitryel/canvastty-music) — by [@Alitryel](https://github.com/Alitryel): a compact player for local audio folders and Yandex Music with a separate full-size library workspace, playlists, queues, and an optional animated pet.
- [canvastty-plugin-hermes-dashboard](https://github.com/4444cjtr/canvastty-plugin-hermes-dashboard) — by [@4444cjtr](https://github.com/4444cjtr): a HOME widget that checks whether the local Hermes Agent dashboard is running, starts it through a small loopback helper, and opens it inside CanvasTTY as an embedded browser card.

## Built-in agent browser

CanvasTTY includes a core browser rather than a plugin capability: trusted React chrome backed by sandboxed Electron `WebContentsView` tabs in one persistent Chromium profile. It is available from HOME, restores safe HTTP(S) tabs, keeps website credentials inside Chromium, manages downloads/uploads, and exposes typed browser actions to Claude Code, Codex, Kimi, OpenCode, and Hermes sessions launched by CanvasTTY.

The browser card participates in the same canvas selection, hover-focus, drag, resize, and semantic-zoom model as terminals. Settings controls agent access, tab restore, recent downloads/activity, and browser-data clearing. Agent access uses an authenticated local socket or named pipe and a bundled stdio MCP helper (native on macOS and Linux); it does not open a TCP or remote-debugging port and never exports cookies, passwords, auth headers, local storage, arbitrary JavaScript, or raw CDP.

Every browser command produces a redacted local activity record. Persistent JSONL audit files form a hash chain below Electron `userData/browser/audit`, rotate at 100 MB, and prune rotated files older than 30 days during store initialization or rotation. Typed/page text, screenshots, credentials, URL queries/fragments, headers, cookies, and tokens are not stored. See the [browser and audit-log guide](docs/browser.md) and [Architecture](docs/ARCHITECTURE.md).

## Quick checks

```bash
npm test
npm run test:even
npm run typecheck
npm run build
```

## Contributor acknowledgements

Thanks to [@kootik](https://github.com/kootik) for [PR #51](https://github.com/howdeploy/CanvasTTY/pull/51): integrating the open pull requests, resolving conflicts, addressing review findings, and improving agent orchestration. The original commits are preserved in the repository history; `.mailmap` associates their `s079891` author identity with kootik.

## License

CanvasTTY is released under the [MIT License](LICENSE).
