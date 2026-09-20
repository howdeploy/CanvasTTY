# Built-in browser and audit log

[English](browser.md) · [Русский](browser.ru.md) · [简体中文](browser.zh-CN.md) · [Docs home](README.md)

CanvasTTY `1.0.2` exposes its built-in browser from HOME as a trusted canvas application. It uses sandboxed Electron `WebContentsView` tabs and one persistent Chromium profile; it is not a runtime-plugin capability.

## Open and use the browser

1. Open **Browser** on HOME to create a Browser card. Repeat to open another independent card; each has its own tab bar and active page.
2. Use the trusted tab bar and address field for HTTP(S) navigation or search. Back, forward, reload, new-tab, close-tab, and close-all controls stay outside the remote page.
3. Move or resize the card like a terminal. Zooming out below semantic scale replaces the native page with a stable summary; at live scale the page keeps rendering while the camera or card moves.
4. Clicking the live page selects it and restores keyboard focus. The configured single/double-click mode controls only camera focusing. **Settings → Controls → Focus on hover** applies the same delay to terminals and the browser. Clicking empty canvas clears the active application.
5. The downloads panel shows recent progress. JavaScript alert/confirm/prompt dialogs are suspended until the trusted CanvasTTY dialog answers them.

Moving, resizing or hiding one Browser card does not affect the others. Card positions and their separate tab sets restore after restart. Existing single-card layouts migrate to the default card. Hiding a Browser card does not close its tabs. **Close all** removes the tabs after confirmation. **Settings → Browser → Restore tabs** controls whether safe URLs return after restart.

## Browser settings

| Setting | Behavior |
|:--|:--|
| **Agent access** | Allows CanvasTTY-launched Claude Code, Codex, Kimi, OpenCode, and Hermes sessions to use the typed browser tool surface; enabled by default |
| **Agent indicators** | Shows trusted-chrome badges after an agent actually uses a browser command and cursors only after a real pointer position exists; enabled by default |
| **Restore tabs** | Persists tab order, active tab, and safe restore URLs; enabled by default |
| **Downloads** | Shows up to six recent downloads and their local progress/status |
| **Browser activity** | Shows the ten most recent in-memory human/agent command results; the runtime buffer is capped at 1,000 events and resets when the app restarts |
| **Clear browser data** | Closes tabs and removes the restored-tab state, site storage, cache, HTTP auth cache, staged uploads, and the current download list |

Clearing browser data does **not** delete the persistent audit log described below.

## Agent access

Only agent sessions launched by CanvasTTY receive a per-launch browser connection. The main process passes a one-use bootstrap capability through the child environment to a bundled stdio MCP helper. Claude and Codex receive per-run CLI arguments, OpenCode receives a launch-only `OPENCODE_CONFIG_CONTENT` MCP entry, Kimi uses a per-run file or recoverable temporary configuration, and Hermes receives a recoverable temporary `mcp_servers.canvastty_browser` entry whose capability fields reference the child environment. Successful authentication rotates the capability to a session-scoped reconnect capability held only in helper memory; duplicate bootstrap authentication is accepted only while the same launch is already connected, and all access is revoked when its PTY ends. Linux/macOS use a current-user Unix socket; Windows uses a bundled native named-pipe host with a DACL for the exact current-user SID. Connecting and sending heartbeats does not mark an agent as active in the browser; presence begins with its first browser command.

The tool surface covers tabs, navigation, observation/read, screenshot, click/hover/type/select/press, scroll/drag, waits, dialogs, downloads, and the calling agent's activity. It does not expose cookies, saved passwords, authorization headers, local/session storage, arbitrary JavaScript, filesystem or shell access, raw CDP, a TCP listener, or a remote-debugging port.

Agent mutations are ordered FIFO per tab, deduplicated by request ID, revision-checked before side effects, rate-limited, bounded by timeouts, and blocked when their required audit attempt cannot be written. Reads can run concurrently; different tabs keep independent mutation lanes.

If the browser view has zero width or height, `browser_observe` returns `VIEWPORT_UNAVAILABLE` instead of a misleading empty list of controls. `browser_screenshot` returns the same retryable error for an empty capture. Bring the Browser card into view, then observe or capture again; reopening the tab is unnecessary. `browser_read_page` can still read document text while no drawable view is available.
A human can also hand one observed element to an agent from the card itself. The **Inspect element** control in the trusted navigation bar observes the active page once through the same typed browser command path agents use (`browser_observe`, limit 20) and lists all of them, so every observed element is reachable: each row shows the element's accessible name, falling back to its role and then to its reference, above `role · reference`. **Send to agent** writes exactly one line into the newest running agent session — never a terminal, never an exited session, and never a session awaiting a decision: `[Browser inspect] <url|url=none> untrustedWebContent=true label="<name|role|reference>" ref=<reference> bounds=<x,y WxH|unknown> documentRevision=<revision>`, terminated with a carriage return. The URL carries no credentials, query string, or fragment, and page-supplied text is flattened and JSON-quoted under `untrustedWebContent=true`, so the page cannot inject a second line or a forged tail. A reference whose tab or document revision no longer matches the active tab is refused with a visible failure in the panel and nothing is sent; with no running agent session the panel says so and also sends nothing. Opening the panel hides the native page while it is open, so the list is never drawn beneath the live view, and the card's existing structure, panels, and controllers are unchanged.

## Parallel agents

Use `browser_new_window` to create a dedicated card, then include its returned `browserId` on every tool call. `browser_list_windows` lists card IDs and ownership; `browser_activate_window` selects an available card for the calling agent only. An agent cannot read or control another agent's claimed card by supplying its browser or tab ID. The user can still interact with all cards. Claims are released after a disconnected agent's in-flight requests finish; cards remain available and claims do not persist across an app restart.

Tab selection, viewport reporting, downloads and canvas input are routed to the addressed card. Commands in different cards can run concurrently. Browser cards share the existing Chromium login/cookie profile, so they are not account or website-session isolation. Clearing browser data remains a workspace-wide action.

`browser_list_tabs` is scoped to the agent's selected card and returns an empty snapshot before a card is selected. `browser_new_tab` can create a dedicated card on first use. Existing plugins continue opening URLs through the user's current card; the HOME Browser action creates an additional card. The workspace supports up to 16 cards, each retaining the existing tab limit.

## Website and file boundaries

- Remote pages run sandboxed with context isolation and no Node.js or CanvasTTY preload.
- Top-level navigation is limited to canonical HTTP(S) URLs. HTTP(S) popups become internal tabs; privileged/external schemes are rejected.
- Hardware, geolocation, notifications, clipboard read, insecure certificate bypass, webviews, client certificates, and HTTP-auth prompts are denied.
- Downloads go to a CanvasTTY-managed directory below the user's Downloads folder. Uploads must pass path, file-count, and total-size checks and are copied through a no-follow descriptor into private staging before Chromium receives them.
- Website data can still leave the computer through the website itself. CanvasTTY's local-only boundary is not a privacy promise made on behalf of visited sites.

## Activity feed and persistent audit log

The Settings activity feed is a short-lived operational view. Separately, the main process appends JSONL audit records to:

```text
<Electron userData>/browser/audit/browser-audit.jsonl
```

The active file is created with mode `0600`. Records include actor/provider/session identifiers, operation, attempt/result phase, tab ID, origin without query or fragment, document revisions, duration, outcome/error code, and hashes linking the chain. The log deliberately redacts typed values, page text, screenshots/base64, credentials, authorization/cookie fields, passwords, secrets, tokens, and API keys.

The active file rotates at 100 MB. Rotated files remain chained; files older than 30 days are pruned when the store initializes or rotates. Existing files are verified when the store opens, and an invalid chain makes subsequent appends fail. If an agent mutation's pre-action record cannot be stored, the agent receives `AUDIT_UNAVAILABLE` and the mutation side effect is not executed.

There is no remote log collector or CanvasTTY-operated telemetry endpoint. The **Clear browser data** button leaves audit evidence intact. To remove it manually, fully quit CanvasTTY first and delete the whole `userData/browser/audit` directory, understanding that this permanently discards the local audit history.

For implementation ownership, read [Architecture](ARCHITECTURE.md). For canvas and interaction invariants, read the [UI contract](UI_CONTRACT.md). For installation paths and other local data, read [Installing, releases, and local data](installing-and-security.md).
