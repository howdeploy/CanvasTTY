# Getting started

[English](getting-started.md) · [Русский](getting-started.ru.md) · [简体中文](getting-started.zh-CN.md) · [Docs home](README.md)

## Requirements

- Node.js and npm.
- A native compiler toolchain supported by `node-pty` on your platform.
- A graphical desktop session capable of running Electron.
- Optional: Go 1.21 or newer, to build the native agent helper (`npm run build:helpers`, also run by `npm run build`). Without it the app uses its JavaScript helpers.
- Optional on Linux: bubblewrap (`bwrap`) for agent isolation.
- Optional agent CLIs — `codex`, `claude`, `qwen`, `kimi`, `opencode`, `hermes`, `grok`, `omp`, or `pi` — installed and available in `PATH` for the launchers you intend to use.

Agents settings links to official installation instructions and can check again after installation. CanvasTTY does not install or authenticate agent CLIs for you. Complete each provider's own login flow before expecting its sessions or subscription limits to work.

## Install and run

```bash
npm install
npm run dev
```

`npm install` also prepares Electron and rebuilds the native `node-pty` module. The development command starts the real Electron application, not a browser-only mock.

## First session

1. Open **Terminal** on Home to start a shell immediately in the last project directory.
2. Open **Codex**, **Claude**, **Kimi**, **OpenCode**, **Hermes**, or **Grok Build** to choose a project folder and launch mode (Auto by default) for that fixed provider.
3. Open **Browser** on Home to create or restore the built-in browser card. Agent sessions launched by CanvasTTY can use its open tabs while **Settings → Browser → Agent access** is enabled.
4. Move or resize the live terminal and browser on the same canvas.
5. Zoom out to use semantic summaries as navigation targets; zoom back in to interact with xterm or the native browser page.
6. Return to Home to inspect real sessions, connected browser agents, and any provider quota windows that their adapters expose.

Launch modes are **Auto** (the default), **Manual**, **Accept edits**, **Plan** and **Bypass**, each offered only where that CLI supports it; the protection layers around them are described in [Installing and security](installing-and-security.md#agent-protection-layers). **Bypass** (YOLO) disables provider safety prompts where the provider supports such a mode, still subject to base protection and agent isolation when enabled. For OpenCode, CanvasTTY applies a launch-only inline `permission: "allow"` override while preserving the rest of the merged OpenCode configuration. Hermes receives its native `--yolo` flag, while Grok Build receives its native `--always-approve` flag for that launch. CanvasTTY asks you to acknowledge it once per CLI and never gives it to a subagent; use it only in a directory you are willing to let the agent modify.

Kimi 2.4+ offers four launch choices: Auto (Ask When Needed, `--yolo`), Manual,
Plan (`--plan`) and Bypass (Never Ask, `--auto`). It has no separate Accept edits
tier. Additional native choices include Cursor Read only (Ask), explicit Ask for
approval, OMP Remember approvals, Claude/Grok/Codex No prompts, and Devin
Autonomous with its own sandbox. Native settings and plugin-only modes
are not silently presented as startup flags. See the [per-agent mode matrix and
verification limits](agent-launch-modes.md), including Antigravity's version and
sandbox requirements.

## Animated terminal backgrounds

Choose a background in **Settings → Appearance → Terminal backgrounds**. To see the animation in OpenCode, you must select its system theme: enter `/theme` inside OpenCode and choose **system**. It uses the terminal's default background; regular OpenCode themes paint their own opaque background over the animation. See [OpenCode themes](https://docs.opencode.ai/docs/themes/).

For other TUI agents that paint their own screen background, choose the equivalent system-theme, terminal-default-background or transparency mode, where supported. This is needed to show the animated background, not to run the agent normally in CanvasTTY. Individual TUI panels, input fields and selections may retain their own backgrounds.

**Terminal backgrounds → Adjust → Text readability** adds a dark backdrop behind text. If it looks like dark strips over the animation, reduce **Darkness behind text** or turn readability off to compare. Clipped or missing parts of the glyphs themselves are not an expected effect.

## Terminal input and controls

- Press any live terminal card to select and focus it. Input focus is independent from selection, so future multi-selection can keep one unambiguous keyboard and wheel target.
- Click outside every widget to clear input focus. Clicking a decorative or action-only widget does not make it the wheel target.
- **Settings → Controls → Focus on hover** moves input focus after the pointer rests on a focusable widget for slow `500ms`, normal `250ms`, or fast `80ms`. Leaving only cancels a pending transfer; assigned focus remains and selection is unchanged. It is off by default.
- On a fresh profile, ordinary scroll over canvas, unfocused widgets, and non-focusable widgets pans on both axes; pinch and `Cmd/Ctrl + scroll` zoom around the pointer. A focused input widget keeps plain wheel/pinch in Off or released-Key mode. This includes a live Browser page, so it scrolls natively while focused; an unfocused Browser, On, an active Key binding, pinch, and `Cmd/Ctrl + scroll` route to the canvas. Browser summary/placeholder surfaces always route to the canvas. **Settings → Controls → Use scroll wheel to zoom** restores ordinary wheel zoom. Fresh profiles use Key with `Command` on macOS or `Ctrl` elsewhere. The separate full canvas navigation override defaults to `Option` on macOS and `Alt` elsewhere, accepts standalone Command/Ctrl, captures drag as well as wheel/pinch, and shows the hand cursor while held.
- Terminal scrolling and canvas navigation have independent wheel-direction settings. Canvas inversion applies to both pan axes and to ordinary wheel zoom.
- `Shift+Enter` sends a modified Enter sequence to insert a line break in compatible agent prompts without submitting. `Enter` keeps its normal PTY behavior.
- With terminal text selected, the default copy binding is `Ctrl+C` on Windows, `Ctrl+Shift+C` on Linux, and `Cmd+C` on macOS. Default paste is `Ctrl+Shift+V` on Windows/Linux and `Cmd+V` on macOS. These bindings can be changed in Settings. Plain `Ctrl+C` without a selection remains the PTY interrupt.

### Codex editor shortcuts

Send and newline shortcuts in **Settings → General → Keyboard shortcuts → Codex** apply to new or restarted Codex cards, including the ordinary CLI. Existing cards keep their launch bindings. CanvasTTY maps the selected physical shortcuts, including Command/Meta and non-Latin layouts, onto submit and newline. Terminal search, copy, paste and restart precede the generic modified-Enter fallback, so a freed Enter combination can be assigned to a terminal command.

Stock Codex receives launch-only `-c tui.keymap` overrides fixing submit to Enter and preserving the default newline aliases, including Shift+Enter. These overrides take precedence over the personal submit/newline bindings for this launch; `~/.codex/config.toml` is unchanged. Native Enter and Shift+Enter remain fallback keys when no configured CanvasTTY action claims them. Codex's hints may therefore show those keys instead of the recorded shortcut. Configuration is source-verified against Codex 0.163.0; older versions are unverified. These settings do not affect Codex started manually inside an ordinary shell card.

Stock Codex 0.163.0 has no configurable whole-draft select-all action: `Ctrl+A` normally moves to the beginning of the line. Recording a shortcut cannot add that action; whole-draft selection requires the compatible bundled frontend. Approvals, voice input and other native commands retain their own keymap.

## File links

Click a local file reference such as `src/main.ts:42:7` in terminal or agent output to open the file in the default application configured in your operating system. Absolute paths, quoted paths containing spaces, and local `file://` or `vscode://file/` hyperlinks are supported; relative paths use the terminal session's launch directory. The target must be an existing regular file.

Choose your preferred application through your operating system's file associations. CanvasTTY does not select an editor or pass line/column positions to the system application. HTTP(S) links continue to use the browser selected in Settings.

## Browser controls and activity

- The browser follows the same independent selection and input-focus rules as terminal cards. Native page hover transfers focus after the configured delay; leaving the page does not clear it. In Off or released-Key mode, that focus also lets plain wheel scroll the live page. Pinch and `Cmd/Ctrl + scroll` still zoom the canvas. A page can also scroll through scrollbar drag, keyboard input, or site controls.
- Use the trusted tab strip and navigation bar for HTTP(S) pages. Hiding the card preserves tabs; **Close all** removes them after confirmation.
- **Settings → Browser** controls agent access and tab restore and shows recent downloads and command activity.
- **Clear browser data** removes tabs, site data, cache, auth cache, staged uploads, and the current download list. It deliberately keeps the persistent redacted audit log.
- The audit log lives below Electron `userData/browser/audit`, rotates at 100 MB, and prunes rotated files older than 30 days during store initialization or rotation. Read [Built-in browser and audit log](browser.md) before handling or deleting it.

## Useful commands

| Command | Purpose |
|:--|:--|
| `npm run dev` | Start the Electron development build |
| `npm test` | Run the Node test suite |
| `npm run typecheck` | Type-check main/preload and renderer projects |
| `npm run build` | Build the native helper, type-check and create the production bundles |
| `npm run preview` | Launch the built application for a production-path check |

Before handing off a change, run the test, typecheck, and build commands, then inspect the affected flow in a real Electron window.

## Where local state lives

Settings are validated and persisted by the main-process `SettingsStore`. Live terminal state and bounded scrollback belong to `TerminalManager`; the renderer is not the source of truth for PTY history. Browser site data stays in its persistent Chromium partition, safe tab restore state stays in `userData/browser-state.json`, and the redacted hash-chain audit stays below `userData/browser/audit`. Provider credentials stay with the installed CLIs and trusted main-process adapters and are never returned over IPC.

For the exact boundaries, read [Architecture](ARCHITECTURE.md). For interaction and visual rules, read the [UI contract](UI_CONTRACT.md).

## Troubleshooting

### `node-pty` fails to build

Install the compiler, Python, and platform headers required by your operating system, then rerun `npm install`. Do not replace the native PTY with a fake terminal: real local processes are a core product constraint.

### A provider launches but limits are unavailable

A working CLI session and a readable subscription-quota API are separate capabilities. Inspect the reason exposed by CanvasTTY; sign in again if it reports an authentication problem. Claude's usage endpoint can return HTTP 429 even while the CLI works. CanvasTTY then waits for the retry deadline (five minutes when the server provides no usable delay) and keeps the last reading marked stale, if available. Refreshing the CLI list does not bypass that wait. Some account types do not provide a subscription window; the UI must show unavailable rather than `0%`.

### A terminal exists but is not marked working

CanvasTTY shows live `idle`/`working`/`needs_approval` for Codex, Claude Code, Qwen Code, Kimi Code, OpenCode, Hermes, and Grok Build from provider lifecycle hooks. An agent stays `unavailable` until its first machine-readable signal; terminal text and PTY existence are not activity telemetry.

Next: read the [browser and audit-log guide](browser.md), [author a widget](widget-authoring.md), or study [metrics and telemetry](metrics-and-telemetry.md).
