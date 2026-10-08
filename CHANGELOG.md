# Changelog

[English](CHANGELOG.md) · [Русский](CHANGELOG.ru.md) · [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

- Added a rich file viewer to the **Files** card: Markdown files (`.md`, `.markdown`, `.mdown`, `.mkd`) render as formatted GitHub-Flavored Markdown with headings, lists, task lists, tables, blockquotes, horizontal rules, inline code, and fenced code blocks with syntax highlighting, recognized code files are syntax-highlighted by the language detected from their extension while unknown languages stay plain monospaced text, all rendered content is sanitized so raw HTML, scripts, event-handler attributes, and dangerous link schemes never render, `http(s)` links open in the app's built-in browser with other schemes inert, only embedded `data:` images show while remote or relative sources fall back to alt text or a placeholder without a network request, and text and code files above the rich-rendering size threshold fall back to plain text with a notice.
- Added a read-only **Files** canvas card and reader: open it from the empty-canvas context menu or the `Cmd/Ctrl+K` palette, root it at a live terminal session working directory or a folder picked in a native dialog, browse a directory tree that loads on demand, and read text/code as selectable monospace (bounded at 2 MB with a truncation marker and total size) or supported images (bounded at 25 MB) with explicit binary, unsupported, and too-large states. Quick open searches file names inside the active root, each card's root, bounds, open file, and expanded folders persist and restore with an unavailable state when the root is gone, and a new main-process `FileAccessService` enforces `realpath` containment so every listing, read, and search uses relative paths strictly inside registered roots with no write, rename, or delete capability.

## 1.7.1

- Added built-in stable-release updates with explicit download and installation, active-session shutdown confirmation, and signed Sparkle updates on macOS. Install this first updater-enabled release manually; later compatible releases can be installed from the app.
- Added rotating application diagnostics and user-initiated problem reports, with one optional PNG/JPEG attachment, a preview, and a report reference. Reports exclude terminal output and keyboard input; there is no automatic upload.
- Moved the current keyboard preset's shortcut reference into a separate canvas overlay and restored `Ctrl+Shift+C` for the Linux preset's terminal copy action.
- Fixed the minimap camera outline at maximum zoom-out. Moved glasses, local-network settings, and the Web companion into compact cards under **External integrations**, below **Controls**.

### What you'll notice after updating

A/B against 1.7.0 in the initial whole-stack measurement on one Apple Silicon Mac: interleaved runs, 3 each, medians, stub agent CLIs (real CLIs add their own cost on top).

| | 1.7.0 | Initial run | Change |
|:--|--:|--:|--:|
| Memory, 10 OpenCode agents + orchestrator (RSS) | 1,762 MB | 1,103 MB | −37 % |
| Helper per agent card (RSS) | 60 MB | 6 MB | −90 % |
| Claude Code permission check, per tool call | 165 ms | 23 ms | −86 % |
| Renderer CPU time while 5 terminals print 256 KB/s for 30 s | 3.16 s | 1.92 s | −39 % |
| React components rendered per pan/zoom step | 73 | 2 | −97 % |
| First interactive frame, 3 restored terminals | 511 ms | 434 ms | −15 % |
| App / zip (macOS arm64) | 376 / 195 MB | 259 / 121 MB | −31 % / −38 % |

A reported hidden-terminal fixture result compares painting while hidden with `visibility:hidden` against suspended screen painting with `display:none`: renderer CPU was 1.880710 s before and 1.773396 s after, about 5.7% less in total across all five cards, including the final resume. Both variants process identical complete output and preserve terminal state; full-stream parsing remains enabled; CPU savings from lossy ring-only replay are not a valid optimization target. The fixture ran on an Apple Silicon Mac with installed xterm 6 and Electron: 5 cards, 10 s, 1,024 Ki UTF-16 units/s per card, median of 3 interleaved pairs. This is renderer CPU only; it excludes the app main process, PTY/IPC, and WebGL, and does not establish whole-app or live-provider performance or a Linux/Windows speedup. The result was not independently remeasured during review.

Plugin cards nobody can see are paused with their state kept, hidden browser tabs are throttled, and subagents no longer ask the person about every action when their orchestrator runs in Auto.

### Changes

- **Browser engines for agents' background tabs.** A plugin can contribute a lighter browser engine (`browser:engine`, see [plugins](docs/plugins.md#browser-engines-browserengine)); `browser_new_tab` takes `engine` (`auto` by default, `chromium`, or the engine's id). With an engine installed and running, an agent's new tab opens in it in the background and the person's active tab stays; the person's own tabs always use Chromium. Engines without real layout get clicks by DOM. The tab moves to Chromium under the same tab id, with a `notice` for the agent, for screenshots, drags, downloads, bot walls, text too thin for the page, a missing CDP method, a crashed engine, or when it is shown, and the site is remembered for the session. Commands without a tab id go to the tab the agent opened last. The engine gets no cookies or profile. Example engine: the separate `canvastty-plugin-lightpanda`. Screenshots of background tabs work while the Browser card is off-screen.
- **Launch modes.** Auto is now the default. Manual, Accept edits, Plan and Bypass (YOLO) are offered only where the CLI has them: Accept edits and Plan for Claude Code, Codex, Grok and OpenCode, Plan also for Cursor; Auto for a CLI without an auto mode of its own is its approval bypass and exists only inside agent isolation. Bypass is acknowledged once per CLI, checked in the main process and never given to a subagent.
- **Delegation rules.** A subagent never gets more than its orchestrator (plan < manual < accept edits < auto, never Bypass), works only inside its orchestrator's project folder, and stays within the depth (2) and live-subagent (8) limits the person sets in Settings → Agents. A decision plugin's "ask" is a deny with the reason for CLIs that cannot ask.
- **Agent isolation.** An OS layer (macOS `sandbox-exec`, Linux bubblewrap) around subagents, plugin-started agents and every agent not in Manual: writes only in the project, the launch's temporary folder and the CLI's own folders; keys, other CLIs' credentials and CanvasTTY's tokens unreadable; fails closed. Windows has no layer yet, so subagents run in Manual there; so they do on Linux where bubblewrap cannot create a user namespace (Ubuntu 24.04's AppArmor restriction), with the reason on the card and [how to allow it](docs/installing-and-security.md#linux-when-bubblewrap-cannot-start). Turning it off is the person's opt-in.
- **Git audit.** After an isolated session ends, CanvasTTY checks the repositories it touched for git settings and files that would run programs outside isolation and offers **Neutralize** or **Keep as is**.
- **Native agent helper.** `canvastty-helper` (Go) runs the MCP servers, the permission gate and the lifecycle hook on macOS and Linux; Windows keeps the JavaScript helpers by default and `CANVASTTY_HELPERS=node` forces them. Building from source needs Go 1.21 or newer for it (`npm run build:helpers`); without Go the JavaScript helpers are used.
- **Performance.** Only what the main process and preload load is packaged, built-in skins ship as AVIF; the canvas camera lives outside React; off-screen DOM terminals are not rebuilt on scroll; summary and HOME-hidden terminal screens stop painting and defer selection redraws, while their parsers still receive complete output in bounded pieces so terminal state and history stay exact; the window loads while services start and Settings loads on demand; hidden native browser tabs, plugin frames nobody can see and closed Settings stop polling.
- **Fixes.** Two bug sweeps: orchestration tools recover after an early gateway race, a browser action is not repeated after a reconnect, a restarted agent no longer returns the previous conversation's answer, every open card is saved (not just the first 64), the 32-session cap holds under concurrent creates, oversized screenshots become a note, and `git worktree add` against another repository is judged as a write.
- `get_agent_result` and `wait_for_agent` now return an OpenCode or Codex subagent's final reply as `answer` instead of leaving the orchestrator a raw tail of a full-screen TUI. OpenCode's reply is read by CanvasTTY's plugin from the session's last assistant message when the turn ends (`session.idle`), Codex's from its Stop hook; at most 4,096 characters with the end kept, masked like other agent output, kept in memory only and cleared when the next turn starts. Only subagents capture it; ordinary cards do not. `get_agent_result` also reports `status` (idle once the turn ended; `state` stays running while the CLI is open).
- Subagents no longer ask the person about every step when their orchestrator runs in auto. `spawn_agent` takes an optional `profile` (`auto`, `normal`, `acceptEdits` or `plan`); without it a subagent gets its orchestrator's profile (an auto its CLI lacks becomes normal, and a YOLO orchestrator's subagents run in auto or normal: YOLO needs an isolated environment `spawn_agent` cannot pick). The answer (`profile`, `profileInherited`), `list_agents` and the card show the profile it got. The control CLI's `create --profile` stays the equivalent for its workers.
- OpenCode now has an **Auto** launch profile. OpenCode has no auto flag, so it is a per-run `OPENCODE_CONFIG_CONTENT` under `agent.build`, OpenCode's default agent (appended after the person's own rules, nothing written to `~/.config/opencode`): reads, searches and edits in the project run without asking (`.env` files still ask), shell commands too but only while base protection is on and its guard runs in that OpenCode (otherwise they ask as before), and paths outside the project ask as before. The card shows **auto** as for the other agents.
- `spawn_agent` and the control CLI's `create` take an optional `model` (the CLI's own `--model` for that run: OpenCode `provider/model`, Codex, Claude, Qwen, Kimi alias, Grok, OMP, Pi, Cursor) and `effort` (Codex, Claude, Grok). Both are checked per provider with the reason in the refusal, kept on restart and restore, and never written to the CLI's configuration; an orchestrator told to use a model now runs its subagents on it instead of the CLI's default. `list_providers` shows each provider's model format and effort levels, and for OpenCode the models `opencode models` lists (read in the background with a 5 s timeout and cached; the tool never waits for it). An OpenCode model that list does not contain is refused before launch with up to five closest ids, since OpenCode would otherwise stop with only "Unexpected server error"; a subagent that exits anyway shows the last lines of its screen as `exitLines` in `wait_for_agent`, `observe_agent` and `get_agent_result`.
- A project folder whose name has two Unicode spellings (Cyrillic «й», accented letters; Finder stores the decomposed one) now launches in the spelling the disk uses, whatever spelling `spawn_agent`, the control CLI or a plugin passed, so a CLI no longer treats its own project as a foreign folder (OpenCode asked «Access external directory …» for every file). Agents also get `PWD` set to their folder instead of the app's, and OpenCode is allowed that exact folder in its other spelling for the run; nothing else is widened and ASCII paths launch as before.
- Orchestrators get two new `canvastty_agents` tools. `list_providers` lists the agents CanvasTTY can launch as subagents: the exact `spawn_agent.provider` id, name, whether its CLI is installed, sign-in state from the last usage check (`ok`, `signed_out`, `expired` or `unknown`; nothing is read or fetched for it), subagent and orchestrator support, and plugin launch options with the plugin tool that picks them (such as `list_routes`); the control CLI has the same list as `providers`. `wait_for_agent` (`timeoutSeconds` up to 600) waits until a subagent is idle, needs the person, exits or goes quiet, or the time is up, and returns its status and masked output tail; it only waits for the orchestrator's own subagents and stops when the call is canceled. `spawn_agent` now lists the known provider ids and refuses an unknown one with a pointer to `list_providers` instead of a generic failure. The tool descriptions, the MCP instructions, the orchestrator skill and the refusal messages give the workflow `list_providers` → `spawn_agent` → `wait_for_agent` → `get_agent_result` and tell agents not to search the filesystem for agent CLIs or their configuration.
- Panning and zooming the canvas no longer re-render the application: the camera is kept outside React state and moves the scene directly, so a pan renders only the minimap (and the browser card, whose page follows it) instead of 50–110 components per pointer or wheel event, and cards render only when they cross the summary or WebGL zoom thresholds. Terminal cards that draw on DOM (off-screen, or beyond the WebGL pool) are no longer rebuilt row by row on every scroll of their output; in the earlier off-screen-output fixture this halved renderer CPU. Nothing changes on screen.
- Added an opt-in browser Web companion via Tailscale Serve HTTPS: loopback-only desktop listener, explicit HTTPS origin and session grants, six-digit desktop-approved pairing, packaged mobile web assets, and revocation. Its desktop-matched visual language uses an attention-first Sessions menu on narrow screens (select a session for detail) and side-by-side list/detail on wider screens. No Android app, public Funnel exposure, remote filesystem, or desktop-browser controls.
- Added an optional Android USB path for Web companion testing without a phone VPN: `adb reverse tcp:3481 tcp:3481` exposes the loopback-only listener to the phone at `http://127.0.0.1:3481/mobile/`. Exact-origin/secure-context checks, desktop-approved encrypted pairing, session grants, and revocation remain in force; USB debugging should be disabled and its authorization revoked afterward. Connection errors use transport-neutral wording across LAN, HTTPS, and USB.

## 1.7.0

- Fixed Windows orchestration startup by using the existing current-user-only pipe host, and recognized expanded Windows paths in private-data protection. The full Windows test suite now runs before PR merge as well as before release packaging.

- Added pixel terminal skins and agent-generated theme packs from PR #98, with independent Canvas backgrounds and terminal borders. Theme creation now includes inline instructions, labeled upload slots, an example, and explicit preview guidance. Canvas patterns appear before background selection and explain when an image overrides them.
- Restored readable terminal summary tiles when zoomed out, enabled Master artwork automatically for orchestrators, and restored edge/corner resizing for pixel skins without resetting manually chosen or restored sizes.
- Integrated PR #100: startup navigation race fixes, safe provider API-key pasting, recovery from uncaught renderer errors, and protection for CanvasTTY's private control data. PR #100 consolidates the earlier fixes from #96, #97, and #99.
- Updated the SAGE application icon, monochrome title-bar branding, and documentation assets. Fixed the launcher layout when Normal, Auto, and YOLO profiles are available, and made shutdown tolerant of closed stdout/stderr pipes.

- Base protection now also refuses any use of CanvasTTY's own private data by an agent's shell or file tool: reading, copying or encoding the agent-control token and descriptor, the gateways' connection records, the provider and plugin secret stores, account homes, the GitHub sign-in and prepared launch runs (by any program, interpreter one-liners and heredocs included), and connecting to CanvasTTY's control or runtime sockets (`curl --unix-socket`, `nc -U`, `socat`, a Python socket). The model is told calmly that agents cannot control CanvasTTY this way and to ask the person for an **Orchestrator** launch, which brings the `canvastty_agents` tools. The paths come from the app's own userData folder; the project, the app's settings, other sockets and the bundled control CLI are unaffected. The control endpoint now answers an unauthenticated or malformed request, and an HTTP request (a minimal 403), with the same guidance instead of a bare error, and closes the connection.
- Added an **Auto** launch profile for agents whose CLI has a native auto mode, next to Normal (still the default) and YOLO: Codex `--approve-for-me` (its own reviewer in its `workspace-write` sandbox), Claude Code `--permission-mode auto` with its sandbox (`sandbox.enabled`, `autoAllowBashIfSandboxed: false`, merged into the one `--settings`), Grok `--permission-mode auto`; also the control CLI's `create --profile auto` and plugin `sessions.create`. A launch contributor may answer `thirdPartyModel: true` (an API or Ollama account): Auto then runs as the CLI's accept-edits mode in the same sandbox, and the card shows **auto · edits**. Codex no longer stops at "Hooks need review" for the hooks CanvasTTY adds itself (per-run `-c hooks.state`, nothing written to `~/.codex`; plugins cannot pass `-c hooks…`), and a Codex subagent in (or below) the folder the person chose for its orchestrator is not asked to trust it again (per-run `-c projects`); plugins get that folder as `trustedFolder`. Claude Code's «✳» title now reads as idle: a hooked Claude card leaves `needs_approval` only through its hooks, or, when the person declined its prompt, a moment after the answer. Example: `examples/plugins/launch-env` (Local model profile).
- Added two launch points for account plugins. A launcher `select` may declare `"optionsFrom": "service"`: the launcher asks the service `canvastty.launch.options` (3 s) and lists up to 64 more choices after the declared ones, such as the plugin's own accounts; the saved value is then checked by the service when it prepares. Orchestrators may pass plugin launch options to `spawn_agent` as `launchOptions`, checked exactly like the launcher's. A plugin's inline Claude `--settings` is merged into CanvasTTY's own (Claude Code keeps only the last one, which dropped the lifecycle and decision hooks); approval and hook keys in it are refused. Example: `examples/plugins/launch-env` (Profile).
- Added plugin services (manifest apiVersion 2, `services`): bundled single-file JavaScript that runs as a supervised child process only after the separate per-plugin **Extension native code** confirmation in Settings → Agents (off by default, never granted by install, revoked by update, module change, disable, or a changed entry file). Services get a minimal environment without keys or CanvasTTY internals, speak JSON-RPC over stdio with 1 MB messages and 15 s timeouts, restart with backoff, stop on disable, uninstall, update and quit, and log to a bounded per-plugin log. Plugin surfaces call their own plugin's services through `host.service.request` and receive `host.service.onEvent`; services may call back `log`, own-plugin `storage` and `event`, and read their own plugin's secrets with `secrets.get` (needs `secrets`). Example: `examples/plugins/service-echo` (its service also reads a token the page saved).
- Added launch contributors (`launch:contribute`): a trusted plugin service can declare launcher options (boolean, select, text) shown under **Advanced** in the agent launcher. For launches where the person chose the plugin, and their restarts and restores, CanvasTTY asks the service to prepare the launch and adds its environment variables, secret variables resolved from the plugin's own secrets (masked in text other agents and the control CLI read), arguments and per-run files. Contributors merge in plugin-id order; a refusal, a 5 s timeout, a conflict, a reserved name or an approval/conversation argument refuses the launch with the reason on the card, and a restored card whose plugin is unavailable comes back stopped. The chosen values are saved with the session. A contributor may also declare `launch.policy`: it is then asked before every launch of its agents where the person did not choose it (`chosen: false`), may only refuse, and no answer refuses too. Examples: `examples/plugins/launch-env`, `examples/plugins/yolo-guard` (a launch policy).
- Added session environments (`environment:provide`): a trusted plugin service can offer places a card runs in (a git worktree, a container, a remote host), chosen under **Where** in the launcher's Advanced section; terminals get the same launcher while such an environment applies to them. The service prepares the place once, then wraps every start (validated: an absolute program path or a bare name resolved on PATH, never a shell string; launch-contributor env rules; plugin secrets masked) while CanvasTTY keeps spawning the PTY. The opaque ref is saved with the card; restore resumes environments first, then parents before children, and a missing, disabled or untrusted plugin, a stopped environment or a timeout brings the card back stopped with the reason, never run locally. Closing such a card asks once "Keep environment data?" and releases it accordingly. Launch contributors and policies are told the card's environment (`environment` in `canvastty.launch.prepare`). Example: `examples/plugins/env-worktree` (one git worktree per card).
- Added base protection and decision hooks. Base protection (Settings → Agents, on by default, the person can turn it off) refuses, before a local Claude Code, Codex, Qwen Code or OpenCode tool call runs (YOLO included), sudo and other elevation, curl | sh and download-and-run, disk and format commands, fork bombs, and writes or deletes outside the working folder (`/tmp` and the home folder included, and deleting the folder itself; the agent's own plan and memory folders excepted), telling the model what to do instead. A trusted plugin service can declare `decide` (`decision:provide`) and answer `canvastty.decide` with deny, ask or allow: base protection runs first, any deny wins, a timeout or error asks the person, and an allow counts only after a separate **May allow agent actions** confirmation. A service may declare `decide.timeoutMs` (1–60 s, 3 s by default): CanvasTTY waits that long, tells the service its `budgetMs`, and sizes each card's hook, helper and gateway deadlines at launch for the longest budget that applies (the default keeps today's deadlines). Example: `examples/plugins/deny-rm`. Every text one agent reads from another (`observe_agent`, `get_agent_result`, the control CLI's screen, result and failure details) is now masked for vault keys, launch secrets, values a service registers (`redaction.register`) or reads (`secrets.get`), keys wrapped over lines, and common key shapes.
- The decision hook now fails closed. While base protection is on or a decision plugin applies, a Claude Code, Codex, Qwen Code or OpenCode shell or file-writing call that CanvasTTY cannot check (the socket is missing or refused, no answer in time, an unreadable answer, the gateway's own failure where the CLI cannot ask, hook input it cannot read) is refused with "CanvasTTY safety check unavailable" instead of running unchecked. With base protection off and no decision plugin nothing changes, and answered calls take no extra time.
- Base protection now reads more command forms: a command after `do`, `then`, `else`, `if`, `while`, `until` or `!`; `env -i`/`-u`/`-C`/`-S`, `stdbuf`, `busybox`/`toybox` applets and `script -c` / `script file cmd`; `perl -i` and `ruby -i` in-place edits; `find -L`/`-H`/`-P`/`-O2`/`-f`; `cp`/`mv`/`install`/`ln -t DIR`; `tar -C DIR -x…` and `--directory=`; `unzip -o … -d DIR`; bundled `curl -fsSLo FILE`, `--output=`, `--output-dir` before or after `-O`/`-o` (a relative `-o` lands in it), the cookie jar, header dump, trace, `--stderr`, `--libcurl`, `--etag-save`, `--hsts`, `--alt-svc` and `-w '%output{FILE}'` files in every spelling, `wget -qO`/`-qP`, its log (`-o`/`-a`/`--output-file`/`--append-output`), `--save-cookies`, `--rejected-log` and `--warc-file`; `-o /dev/null` and `-D -` write no file and are no longer refused. Each is refused outside the project exactly like the plain command, a download run in the same command is download-and-run however its output flag is written, and the same forms inside the project stay allowed (`find -L dir -exec rm {} +` inside the project is no longer refused).
- Added plugin agent tools, session events and card badges and actions. A trusted service can offer `tools` (`tools:agents`) that appear in `canvastty_agents` as `<pluginId>__<tool>` (dots in the id as `_`, the tool-name shape Anthropic and OpenAI accept) for the session roles they list (orchestrator, agent, subagent; Claude Code, Codex, Qwen Code, OpenCode); calls carry the caller's session id, and answers are masked, capped at 32 K characters and 15 s. A service can subscribe to card events (`sessions:events`: created, restored, status, exited, closed, with folders and the environment ref; the end of the output only with `sessions:read-screen`, masked), start cards through the normal launch pipeline (`sessions:launch`), and type into or close only the cards it started (`sessions:control`; ownership is saved with the card, so it survives a restore). With `cards:decorate` it sets plain-text badges on cards and adds actions to the card menu of matching cards (provider, environment kind, role); the answer shows as a toast on the card. Example: `examples/plugins/collect-demo` (**Show changes** on worktree cards and `collect-demo__diffstat` for orchestrators).
- Reworked "Windows after restart" into one "Agent sessions after restart" model: **Don't save**, **Reopen windows** (new conversations), or **Continue conversations** (the old "on" migrates here). Claude Code and OpenCode now resume their own conversation by the id their lifecycle hook reported, as Codex does (`claude --resume`, `opencode --session`); two cards of one CLI in one folder no longer continue the same conversation. Finished agents come back stopped with Restart / Continue instead of rerunning, the card options menu has **Don't restore this card**, and session records (v2, read-compatible with v1) keep no scrollback, prompts or secrets.
- Made the agent orchestration endpoint an explicit setting (Settings → Agents → "Agent orchestration endpoint", `agentControlEnabled`, off by default; `--agent-control` / `CANVASTTY_AGENT_CONTROL=1` still force it on for one launch) that starts and stops the endpoint at runtime, and added an **Orchestrator** role to the launch dialog next to the normal/YOLO profile: the session keeps the provider you opened the dialog for, gets `CANVASTTY_CONTROL_CONNECTION` and `CANVASTTY_CONTROL_CLI` in its environment so the bundled CLI works without setup, shows an "Orchestrator" badge, keeps its role across restore, and the dialog offers to enable the endpoint first when it is off instead of enabling anything silently. The endpoint's `create` now accepts every agent provider (`codex, claude, qwen, kimi, opencode, hermes, grok, omp, pi`) and reports `capabilities { result, menus }` per worker on `create` and `list`: both are `true` for Codex only; other providers' `screen` has no menu interaction, `choose`/`dismiss` fail with `NOT_SUPPORTED`, `send` relies on the idle status alone, and `result` completes as `no_result`.
- Added a native Codex orchestration CLI (`agent-control/canvastty-control.mjs`, documented in `agent/orchestrator/SKILL.md`) behind `--agent-control` or `CANVASTTY_AGENT_CONTROL=1`: a local controller creates Codex sessions in a project directory, sends work, observes bounded terminal output against a screen revision, and collects the final answer. Each controller sees only the sessions it created, grants are bound to the session generation, mutation IDs are deduplicated, and only controlled sessions opt into authenticated Stop-hook result capture. No automatic approval or terminal deletion endpoint is included.
- Added the opt-in Even G2 companion (Settings → Controls → Even G2, with the Even App companion under `integrations/even-g2`): Bonjour discovery, short-lived SRP-6a pairing with a six-digit code and explicit device approval, encrypted local requests and audio, per-session grants, bounded terminal presentation on the glasses HUD, local speech recognition through the pinned transcribe.cpp helper (bundled on macOS only), and session creation through the existing desktop launcher. The final answer of a Codex turn reaches the companion only for sessions spawned while the companion is enabled: the runtime hook reports it under a separate per-session grant, bounded to 4000 characters, and the gateway refuses it for any other session.

- Denied browser and device permissions on the default session: permission requests, permission checks, and device handlers now refuse, so plugin windows and shells cannot obtain camera, microphone, geolocation, or notification access. The built-in browser keeps its own separate partition policy.
- Hardened packaged builds with Electron fuses that disable the `NODE_OPTIONS` environment variable and CLI inspect arguments and enable embedded asar integrity validation. `runAsNode` stays enabled on purpose because provider CLIs and the agent runtime spawn the bundled helpers through `ELECTRON_RUN_AS_NODE`; cookie encryption is not enabled because that transition is one-way.
- Added renderer crash recovery: if the renderer process is lost, the main process logs the reason and exit code and reloads the application surface instead of leaving a blank window, while terminal services and live sessions keep running across the recovery. Losing a utility or GPU child is logged.
- Added scrollback search: `Ctrl+Shift+F` in a focused terminal card opens an in-card search row with the input, match counter, previous/next, and close. `Enter` moves to the next match, `Shift+Enter` to the previous, and `Escape` closes the row and returns focus to the terminal so keystrokes never leak into the PTY. The row stays hidden in semantic summary mode.
- Cards now show the title the provider sets through OSC 0/2 while their title is not user-customized, falling back to the existing path display when the provider sets none. Renaming wins permanently, and the provider title is display-only: it is never written back and never persisted.
- Added a “Fit to content” canvas control that frames the HOME zone and every window with a margin inside the existing `0.2–1.35` zoom range; an empty canvas goes HOME instead. It is also offered in the canvas palette, and there is no keyboard chord for it.
- Added directional focus: `Alt+ArrowUp/Down/Left/Right` (`Option` on macOS) moves focus to the nearest window in that direction across terminal cards, the built-in browser, and plugin canvases, requiring the target to be strictly ahead with a perpendicular-distance tie-break. The gesture does not run while renaming or capturing a shortcut, and leaves `Ctrl+K` and `Ctrl+,` untouched.
- Added marquee selection: `Shift+drag` on empty canvas selects every terminal card it intersects (plugin canvases, the built-in browser, and sticky notes are not tested), and dragging any selected terminal moves the whole selection by the same delta, while a press that does not travel stays a plain click. Plain empty-canvas drag still pans the canvas exactly as before.
- Added the session path to canvas palette search alongside the label and provider, so a session entry is found by its working directory. No second palette and no new key binding.
- Added a HOME attention queue of sessions that need approval or have failed, derived only from session snapshots, always rendering its title row and an explicit empty state; clicking a row focuses that session. Failure details (trigger, popover, copy) were extracted into one shared implementation used by both the queue and the existing session rows.
- Added an attention ring on cards whose session needs approval or has failed, plus the “Notify when attention is needed” setting in Settings → General (on by default) that raises one OS notification on a genuine transition into needing approval or failing: repeated snapshots and already-seen restore-time failures stay silent, and a failure the user triggers by restarting also notifies. Toggling the setting persists.
- Cards now report whether they render live output: those in semantic summary mode (zoom below 0.5) stop receiving streamed output while their scrollback stays canonical and complete within the bounded history, and the missed output is replayed once when the card becomes visible again; if more output was produced while hidden than the bounded history holds, the oldest part of that stretch is gone and the replay says so instead of pretending the output is continuous.
- Terminal cards on screen draw with WebGL from a pool of 10 contexts (Chromium allows 16 per renderer process): the focused card first, then the cards covering the most screen, then the most recently used. Cards that leave the screen, zoom above 1× or go to summary mode give their context back, and changes from panning or zooming wait until the camera is still, so moving around does not rebuild contexts. Every other card keeps the DOM renderer, and a card whose context is lost falls back to it with its contents intact and stays there for a while. Palette and transparency rendering are unchanged.
- Panning the canvas with the wheel or trackpad now moves the already drawn scene on the compositor, as dragging it already did, instead of repainting every card on each frame; the scene is re-rasterized once the gesture stops.
- Added a self-update section in Settings → Updates with the honest states: idle, checking, update available with the version, downloading with the percent when known, ready to install, and unavailable for dev, offline, or error. Downloading and installing are explicit user actions, install-and-restart is offered only once the update is downloaded, and in development the row reports unavailable instead of throwing.
- Hardened the repository secret audit to ignore key prefixes embedded inside identifiers, so names such as `disk-…` or `task-…` no longer produce false positives while real keys still match.
- Added Cursor, MiniMax Code, Devin and Antigravity agents (PR #63).
- Added provider API keys, API profiles and agent-to-agent delegation through the orchestration MCP (PR #64).
- The plugin showcase works without a GitHub account; signing in is optional and only raises GitHub's limits (issue #22). The HOME clock shows the date (issue #53).
- The default session denies web permissions, a crashed renderer reloads, long agent answers keep their turn, and the secret audit also checks the built bundle (from PRs #35 and #51).
## 1.5.2

- Fixed terminal history jumping to the beginning when Codex clears and redraws its history after a card resize. Readers retain their relative scroll position, while terminals at the bottom continue following new output.
- Fixed deferred terminal sizing after an offscreen alternate-screen resize, preserving follow-output mode when the card returns to view.
- Includes the already merged OMP/Pi providers and agent transport, startup, plugin installation, canvas gesture, and browser fixes from PRs #33 and #47.
- Includes the Even G2 companion with local pairing and voice control from PR #50.
- Includes architecture decision documentation, the `js-yaml 4.3.2` pin, and build dependency updates from PRs #48 and #49.

## 1.5.1

- Fixed the HOME Terminal button passing a mouse event as canvas coordinates and failing with “Session position is invalid”.
- Added local file drag-and-drop into terminal cards. File paths are quoted for the host's default shell and pasted without submitting the command; filenames with spaces and Unicode are preserved.
- Fixed terminal history replay overlapping live output, scrollbar coordinates at canvas zoom, and scrollback/follow-output position during resize.
- Added the configurable radial quick launcher from PR #29. It is off by default and can be enabled under Settings → Agents → Quick launcher without losing the selected actions when disabled.
- Added a close button that deletes sticky notes (PR #30).
- Added project-path paste in agent launch dialogs and corrected GNOME clipboard metadata handling (PRs #27 and #31). Terminal links now offer a choice between the built-in and system browser (PR #28).
- Restored Claude Code usage tracking with credential-store selection fixes (PR #25).

## 1.5.0

- Replaced competing canvas right-click handlers with one context-sensitive dispatcher. Empty canvas, color regions, and sticky notes now expose their own actions; the configurable safe agent/terminal launcher is shared with the searchable `Cmd/Ctrl+K` command palette.
- Added sticky notes as first-class persistent canvas windows with editing, drag, eight-direction resize, snapping, deletion, deterministic region containment, and minimap markers. This work adapts and credits the original sticky-note and quick-launcher ideas from @TroopJostle's PR #23.
- Finished color-region movement: completely contained terminals, Browser/plugin windows, and notes follow continuously during region drag and persist once at release. Region targeting, magnetic snapping, and bounds rules no longer attach partially overlapping windows or teleport them after the gesture.
- Added ordinary click-to-front stacking for every canvas window. The native Browser surface now respects renderer-owned overlap, and launch dialogs are clamped before their first frame instead of flashing outside the application near the right edge.
- Redesigned Settings and all canvas menus around shared application tokens, official Lucide/provider assets, and one `0.85–1.25` UI-chrome scale. Palette changes recolor menus automatically without changing canvas zoom or terminal font size.
- Added independent General settings for saving color regions and sticky notes after exit. Disabling either keeps its live objects for the current run while omitting only that collection from the next-launch snapshot.
- Split minimap interaction into explicit Click and Drag modes. Drag now follows empty-canvas grab direction without an initial camera jump, while a stationary press in Drag mode performs no click navigation.

## 1.3.0

- Added opt-in terminal-window restoration. CanvasTTY persists only window identity, provider/profile, title, project folder, position, and size; agents resume through their native project-scoped continue mode, while PTY scrollback and capabilities remain ephemeral.
- Added named pastel Canvas regions from the empty-canvas context menu, plus an RTS-style camera-centred minimap. HOME and fixed-size window markers now move through a uniform projection without auto-fit distortion, and a HOME edge marker appears only after HOME has fully left the radar.
- Expanded Canvas navigation bindings to Mouse3/Mouse4/Mouse5, kept middle-button drag as the direct pan fallback, and corrected wheel ownership so terminal session lists and focused input surfaces scroll locally while explicit Canvas capture remains predictable.
- Fixed Grok Build's cropped initial TUI by waiting for the renderer-measured xterm grid on launch, restart, and restore. Terminal resize and palette changes preserve the active scrollback viewport.
- Added configurable whole-row agent status colors in Appearance: gray for idle/unavailable/finished states, sage green for working, and yellow for input-needed, with a monochrome alternative.
- Fixed Claude usage limits to read the current runtime user's OAuth credentials and perform the provider request when a token exists. Missing local credentials now mean sign-in is required instead of being misreported as a missing subscription.
- Prevented CanvasTTY from restoring, showing, or focusing its window because of a rejected second launch or background plugin/browser activity, avoiding unsolicited virtual-desktop switches.
- Added a concise Agents hook switch, expandable About FAQ, and explicit per-hook trust for optional plugin agent hooks. Plugin hooks remain disabled after install/update and run in an isolated process with CanvasTTY internal capabilities stripped.

## 1.2.8

- Added Qwen Code as a first-class launcher across HOME, Settings, CLI discovery, Normal/YOLO profiles, the plugin SDK, and the scoped built-in-browser MCP bridge, using the official Qwen mark and launch-only configuration.
- Added a Qwen row to HOME limit display and its settings. Because Qwen Code can use unrelated cloud or local model providers and exposes no universal quota-read protocol, CanvasTTY reports an explicit unavailable reason instead of inventing usage data.
- Replaced the generic open state for agent sessions with an authenticated local lifecycle gateway. Codex, Claude Code, Qwen Code, Kimi Code, OpenCode, Hermes, and Grok Build now report idle, working, and input-needed through provider hooks without forwarding prompt or response content; Claude/Qwen terminal-title markers remain a compatibility fallback.
- Fixed delayed bootstrap snapshots reverting an already observed agent lifecycle back to unavailable. Session metadata now carries a main-owned monotonic revision, and the renderer rejects stale status updates while preserving initial terminal output.
- Preserved the active terminal scrollback position when a card or application window is resized instead of jumping to the beginning of the session.
- Kept segmented-setting keyboard focus inside its selected button and restored spacing between the wheel/pinch capture selector and its conditional key editor.

## 1.2.7

- Added a permission-gated Hermes Desktop HUD bridge for plugins. The host exposes only status, open-in-HUD, and close operations through `hermes:hud`; plugins cannot choose an executable, arguments, or PID.

## 1.2.6

- Provider CLI executables are now resolved once at startup and reused by terminals, usage limits, and agent-browser flows through the same absolute launcher, with structured diagnostics for missing and non-executable commands.
- Failed HOME sessions now expose complete sanitized diagnostics on hover or keyboard focus, offer a Copy action, and explain silent exits with their exit code. The top-layer details popover preserves the three-row scroll viewport and the failed-session danger rail.
- Packaged macOS apps now discover Homebrew CLIs and the official per-user OpenCode install under `~/.opencode/bin` even when launched with Finder's minimal `PATH`.
- CI now packages the macOS app and exercises real minimal-`PATH` CLI resolution on every pull request and `main` update, in addition to the release-time smoke.

## 1.2.5

- Added OpenCode, Hermes, and Grok Build as first-class launchers on Linux, macOS, and Windows, with official provider marks, native per-launch YOLO behavior, Windows discovery, plugin SDK coverage, and scoped built-in browser MCP integration where supported.
- Added an independent **Agents** settings section: launcher visibility and HOME limit visibility are persisted separately, hidden launchers leave existing sessions untouched, and the HOME dock automatically redistributes visible buttons.
- Added source-backed OpenCode Go and Grok Build usage adapters alongside Codex, Claude, and Kimi. The five-row HOME limits tile now switches to compact, height-aware geometry so every countdown and usage rail stays inside its default bounds.
- Expanded Appearance with independent HOME accent presets/custom colors and Canvas background colors, plus diagonal and ring patterns. Canvas colors no longer recolor HOME widgets, and the Settings top strip remains visually separated from scrolling content.
- Fixed native Browser viewport clipping so embedded pages stay inside the usable workspace instead of covering application chrome, and added visible DEV/release build identity with normalized provider marks.

## 1.2.4

- macOS bundles are now explicitly ad-hoc signed with hardened runtime and notarization disabled for the free distribution path; the release workflow runs strict `codesign` verification before uploading artifacts.
- Updated installation guidance to explain that ad-hoc signing verifies bundle integrity but does not provide a Developer ID or notarization. macOS users should replace the pre-fix `1.2.2` and `1.2.3` artifacts with `1.2.4` or later.

## 1.2.3

- Added a GitHub-backed plugin showcase with complete pagination, metadata-first manifests, platform and host-version hints, update discovery, and OAuth Device Flow sign-in.
- Hardened plugin installation and updates with platform enforcement, atomic rollback, strict manifest validation, bounded metadata batches, trusted archive redirects, and protected OAuth persistence and IPC.
- Added the permission-gated plugin `browser.open` SDK method for normalized HTTP(S) URLs, routed through one awaitable broker that creates or reuses a single embedded Browser card and persists it before reporting success.

## 1.2.2

- Reworked canvas navigation: two-axis scrolling now pans the canvas by default, while pinch and `Cmd/Ctrl+scroll` perform focal-point zoom; the legacy scroll-to-zoom profile remains available in Settings, preserving its direction and sensitivity.
- Introduced logical widget input ownership: widgets capture the wheel after an explicit click or a configurable hover delay, keep focus until you click outside, and offer `Off / On / Key` capture modes; a separate hold binding temporarily captures full canvas navigation, including drag.
- Preserved gesture continuity across native Browser surfaces: page-vs-canvas ownership latches for 250 ms of wheel inactivity, pinch and `Cmd/Ctrl+scroll` always zoom the canvas, and a focused Browser page keeps scrolling natively when capture is disabled.

## 1.2.1

- Plugin canvas apps now open and refocus at native `1.0` scale, avoiding fractional-scale blur; their transparent iframe backdrop also removes the bright seam around rounded plugin windows.
- Terminal and Browser semantic summaries now reserve width before counter-scaling and keep their content centered, preventing icons and text from being clipped at distant canvas zoom levels.

## 1.2.0

- Added native macOS window chrome: a hidden title bar with traffic-light buttons, a compact brand bar, and correct native-fullscreen behavior; Linux and Windows keep the existing custom frame.
- Added OS-encrypted plugin secrets via Electron safeStorage (fail-closed when no system keyring is available) with per-call permission checks, quotas, change events, and uninstall cleanup.
- Plugins can now contribute a settings entry opened in a sandboxed frame, declare minimum canvas sizes, and open another canvas of the same plugin beside the current one.
- Plugin HOME widgets are listed beside built-in widgets in Appearance → HOME composition and can be added or removed like built-in ones, closing the 1.1.0 known gap; Settings → Plugins is scoped back to install/uninstall only.
- Added optional plugin modules: install-time selection, per-file SHA-256 and byte-count verification, atomic reconfiguration with rollback, and module-derived permissions applied consistently to SDK authorization and the plugin resource CSP.
- Plugin storage change events are now broadcast from the main process, so canvases, HOME widgets, and separate windows of the same plugin observe each other's writes.
- Hardened plugin downloads: redirects are pinned to `api.github.com` and `raw.githubusercontent.com`, and module downloads reuse the 1.1.0 retry/backoff.
- Documented the optional-module trust model: file integrity is anchored to the plugin manifest fetched from GitHub over TLS without a separate signature.

Known issue: installed plugins cannot be updated in place yet — uninstall and reinstall to pick up a newer version. An update action is planned.

## 1.1.0

- Scaled native browser pages to the canvas zoom via Chromium zoom factor (clamped 0.5–3), so browser content follows the canvas scale at any zoom.
- Reported browser viewport bounds synchronously and kept the native view visible during canvas panning, dragging, and resizing; this fixes the 1.0.2 issue where the native browser view could cover a non-maximized window and block canvas controls.
- Focused the browser tab's web contents on canvas pointer-down, so typing reaches the page without an extra click.
- Added a Settings toggle for browser agent presence indicators (on by default): presence badges/cursors no longer appear at authentication, cursors render as plain dots without names, and only agents that actually used the browser are shown.
- Retried GitHub plugin downloads up to three times with backoff on transient failures (timeouts, connection errors, HTTP 408/429/5xx, interrupted streams).
- Added terminal session restart: a restart button on exited cards and a `Ctrl+D` shortcut; PageUp/PageDown now page the scrollback in the normal buffer, and the terminal cursor is a block.
- Enabled wheel zoom over applications by default.
- Synchronized documentation in English, Russian, and Simplified Chinese.

Known issue: HOME layout customization is not finished for external plugins — plugin tiles cannot yet be placed or rearranged in the HOME layout editor. This gap is tracked for future work; contributions are welcome.

## 1.0.2

- Exposed the built-in browser from HOME as a movable, resizable canvas application with trusted tabs/navigation, downloads, site dialogs, safe tab restore, browser-data clearing, semantic summaries, and stable native-view geometry during camera/card motion.
- Added scoped browser automation for CanvasTTY-launched Claude Code, Codex, and Kimi sessions through a bundled stdio MCP helper and authenticated current-user Unix socket or protected Windows named pipe; no TCP listener, remote-debugging port, arbitrary JavaScript, cookie/storage API, or raw CDP surface is exposed.
- Added connected-agent badges/cursors, per-agent activity isolation, revision-bound element refs, per-tab FIFO mutations, request deduplication, bounded concurrency/rate limits/timeouts, dialog/download handling, and redacted screenshots that fail closed when sensitive regions cannot be resolved.
- Added a persistent redacted browser audit hash chain below Electron `userData/browser/audit`, 100 MB rotation, 30-day rotated-file retention, integrity checks, and fail-closed agent mutations when the required pre-action audit cannot be written.
- Integrated browser cards with terminal-equivalent canvas selection, click/hover focus, empty-canvas clearing, window actions, wheel zoom over applications, and a stable renderer surface while the native view is repositioned.
- Hardened the Windows agent transport with a bundled native named-pipe host restricted to the exact current-user SID and added real Electron/provider smoke coverage across the release pipeline.
- Fixed the repository secret audit for linked Git worktrees by ignoring repository metadata entry names before file-type inspection while preserving personal-path detection in publishable files.
- Synchronized browser, security, local-data, audit-log, and release documentation in English, Russian, and Simplified Chinese.

Known issue: if the main CanvasTTY window did not start maximized, opening Browser can make the native browser view cover the window and leave the canvas controls unusable. For this prerelease, start CanvasTTY maximized before opening Browser; a fix is planned for the next patch.

## 1.0.1

- Added `Shift+Enter` terminal line breaks without submitting the current prompt.
- Fixed terminal selection and keyboard focus: selecting a live card routes typing into xterm, while pressing empty canvas clears the selection and focus outline.
- Added optional focus-on-hover with slow (`500ms`), normal (`250ms`), and fast (`80ms`) enter/leave delays. Programmatic hover focus no longer forwards focus-report sequences into agent TUIs or jumps their history.
- Added independent terminal-scroll and canvas-zoom wheel direction settings. Terminal scrolling defaults to wheel-down moving down; canvas zoom retains its previous direction.
- Batched PTY output into 16ms renderer updates and replaced repeated scrollback string copies with a bounded chunk buffer, eliminating high-volume terminal flicker and reducing history resets under large output bursts.
- Made settings, plugin-registry, and media-grant write queues recover after transient filesystem errors, and aligned provider-client metadata with the packaged app version.
- Added complete Simplified Chinese runtime-plugin documentation, synchronized terminal-control guidance across English, Russian, and Chinese, and documented local plugin/media/browser data.
- Added the MIT License and localized security, changelog, architecture, and UI-contract documents.

## 1.0.0

- Added a lightweight local startup page that appears before settings, plugins, media, and IPC services initialize; bootstrap failures now surface as a visible error page with a native-dialog fallback instead of a blank window.
- Added Electron single-instance lock: a second launch restores and focuses the existing window.
- Remapped terminal pointer coordinates from the canvas's CSS-transformed rectangle back to xterm layout coordinates, so text selection, mouse reporting (vim, tmux), and wheel scrolling work at any canvas zoom.
- Reworked terminal clipboard shortcuts: copy with `Ctrl+C` (with selection), `Ctrl+Shift+C`, or `Cmd+C`; paste with `Ctrl+Shift+V`, `Cmd+V`, or `Shift+Insert` through `Terminal.paste`; shortcuts now match physical keys and work on non-Latin keyboard layouts.
- Added a packaged-app smoke harness (`CANVASTTY_SMOKE_TEST=1` prints `CANVASTTY_SMOKE_READY` after first paint) and wired it into the Linux release pipeline under `xvfb-run` with FUSE2.

## 0.9.99 — public preview

- Added a permissioned runtime plugin registry for ready-to-run static GitHub repositories.
- Added manifest v1 contributions for sandboxed HOME widgets, movable canvas apps, and separate CanvasTTY-owned windows.
- Added plugin preview/permission review, enable/disable/uninstall controls, isolated storage, CSP-constrained assets, and a shared host SDK.
- Added persistent user-granted music libraries, seekable local audio streams, and bounded playlist read/write APIs for full player plugins.
- Added a sandboxed built-in browser core scaffold with tabs, navigation, a persistent isolated profile, and canvas-card geometry; it is intentionally not exposed from HOME yet.
- Replaced the fixed HOME composition with a spacious persisted 16 × 12 layout and visual drag/resize editor while preserving the approved default arrangement.
- Added any-edge window and HOME-widget resizing, visible edit-only HOME boundaries, out-of-bounds draft placement, save validation, and edit-mode isolation from other canvas windows.
- Added runtime-plugin architecture/authoring documentation and a complete Studio Kit example package.

## 0.9.2 — public preview

- Made provider CLI discovery cross-platform: per-user CLI directories are now resolved on both Linux and Windows, so AppImage and Windows launches find existing `codex`, `claude`, and `kimi` installs.

## 0.9.1 — public preview

- Restored provider CLI discovery for graphical AppImage launches by supplementing the desktop-session `PATH` with existing per-user CLI directories, including Kimi's `~/.kimi-code/bin`.
- Prevented late terminal input and resize events from crashing the Electron main process when they race with PTY exit (`EBADFD`).

## 0.9.0 — public preview

- Fixed the main window never appearing when the renderer paints before `loadURL` resolves; the `ready-to-show` listener is now attached before loading.
- Added RTS-style edge panning (off by default; enable in Settings): the camera drifts while the pointer rests near a viewport edge over empty canvas and pauses over interactive surfaces.
- Added Settings controls for edge panning (toggle and speed) and wheel zoom sensitivity.
- Reorganized Settings into General, Appearance, and Controls sections.
- Added explicit Off, Single click, and Double click modes for terminal focus/zoom; automatic click focus is off by default.
- Added remappable application shortcuts with `Home` for the Home zone and `F2` for inline terminal-window rename, plus an optional live shortcut hint.
- Preserved PTY state and scrollback while changing palettes, patterns, settings, and custom window titles.
- Improved terminal clipboard shortcuts, edge resizing, semantic-zoom interaction, and multilingual documentation.

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
