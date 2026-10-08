# Native agent orchestration from the CLI

CanvasTTY can expose an opt-in local control endpoint so an orchestrator can create native Codex windows, send tasks, observe lifecycle, read results and interrupt its own turns without taking the user's mouse, keyboard, clipboard or focus.

## Orchestrator sessions: the canvastty_agents tools

A session launched from the desktop with the **Orchestrator** role gets the `canvastty_agents` MCP server. Its tools, in the order an orchestrator uses them:

| Tool | What it does |
| --- | --- |
| `list_providers` | The agent providers CanvasTTY can launch as subagents: `id` (the exact `spawn_agent.provider` value), `name`, `installed`/`available` (from the provider CLI registry resolved at startup or on a recheck), `signIn` (`ok`, `signed_out`, `expired` or `unknown`, from the last usage-limits read; it never starts a read and never reads credentials), `subagent` and `orchestrator` support, `model` (whether the CLI takes one, its format, and for OpenCode the models a cached `opencode models` listing reported: run in the background with a 5 s timeout, refreshed after 10 minutes, never awaited) and `efforts`, and plugin launch options (`launchOptions`, plus `launchOptionTools` such as an accounts plugin's `list_routes`). Fast: cached state only, no network calls. |
| `spawn_agent` | Launches a subagent (profile: see below). `provider` must be a `list_providers` id (the schema lists them); an unknown one is refused with `INVALID_REQUEST` naming `list_providers`. Optional `model` goes to the CLI's own `--model` for that run (OpenCode `provider/model`; Codex, Claude, Qwen, Kimi alias, Grok, OMP, Pi, Cursor; Hermes, MiniMax, Devin and Antigravity take none) and optional `effort` to its reasoning effort (Codex `-c model_reasoning_effort`, Claude `--effort`, Grok `--reasoning-effort`). Both are checked per provider, kept on restart and restore, and never written to the CLI's configuration. If the person names a model, the orchestrator passes it as `model`. An OpenCode model its own `opencode models` list does not contain is refused before launch with up to five closest listed ids (OpenCode would otherwise stop with only "Unexpected server error"); when that list cannot be read, the model is passed as given. A subagent that exits anyway reports the last lines of its screen as `exitLines` in `wait_for_agent`, `observe_agent` and `get_agent_result`. |
| `wait_for_agent` | `{ sessionId, timeoutSeconds ≤ 100 }` (default 55; OpenCode caps each call at 50 seconds). A timeout returns progress while the agent continues; call again to keep waiting. Pending reviews do not extend this deadline. Returns when the subagent is `idle` (after a prompt: only once a turn that started after the latest delivered prompt has ended, so the CLI's startup idle does not count), `needs_approval`, `done`/`failed` (exited), `quiet` (reports no status and its screen stopped changing), `closed`, or on `timeout`, with `status`, `exitCode`, `waitedMs` and the masked terminal tail (masked before it is cut). Only this orchestrator's own subagents; it stops at once when the call is canceled or the orchestrator disconnects. |
| `get_agent_result`, `observe_agent` | `get_agent_result`: `answer`, the final reply of the subagent's last turn as the agent itself reported it (Codex through its Stop hook, OpenCode through CanvasTTY's plugin reading the session's last assistant message at `session.idle`; at most 4,096 characters with the end kept, masked, in memory only and cleared when the next turn starts), plus `status`, the exit state and the masked terminal tail. Other providers have no `answer`: their tail is raw screen output. An unfinished review returns `review.status: "pending"` immediately; call `get_agent_result` later for its outcome. `observe_agent`: the current status and tail. |
| `send_to_agent`, `cancel_agent`, `list_agents` | Follow-up prompts, disposing a subagent, listing this session's subagents. |
| `retry_agent` | Restarts one failed or quiet subagent with its original prompt, profile, model and folder plus a short masked failure tail; at most two retries per original agent. |
| `ask_user` | A question for the person (up to 8 options or free text) that waits for the person's answer; eligible questions also reach the paired phone. |
| `list_tasks`, `claim_task`, `update_task`, `complete_task` | The task board of this orchestration tree. Claiming is atomic and waits for dependencies; only the owner or the root orchestrator completes a task, and only the root reassigns tasks or changes dependencies. |
| `get_task_budget` | The tree's limits, usage and remaining budget. Agents can read it; only the person changes it. |
| `list_orchestration_templates`, `apply_orchestration_template` | Built-in flows and the project's `.canvastty/flows/*.yaml`. A project flow's instructions are returned only after the person has approved its current content. |
| `request_secret`, `run_secret_request` | Ask the person for one configured provider key, then send typed HTTPS API requests with it. The key is never returned to the agent. |

### Subagent profiles

`spawn_agent` takes an optional `profile`: `auto`, `normal` (manual: the CLI asks the person as usual), `acceptEdits` or `plan`, where the subagent's CLI has it (`list_providers` lists each provider's `profiles`). A subagent never gets more than its orchestrator (plan < normal < acceptEdits < auto) and never YOLO; asking for more is refused with the reason. Without `profile` it gets its orchestrator's profile, or the next lower one its CLI has, so a person who runs the orchestrator in auto is not asked about every step of its subagents. A YOLO orchestrator's subagents run in auto at most. The answer and the card show the profile the subagent actually got (`profile`, `profileInherited`).

### OpenCode auto

OpenCode has no auto flag, so its auto profile is a per-run `OPENCODE_CONFIG_CONTENT` (nothing is written to `~/.config/opencode`). The rules go under `agent.build`, OpenCode's default agent, which OpenCode appends after the top-level rules (the last matching rule wins), so the person's own rules for every other tool stay as they are:

- `read`, `glob`, `grep`, `list`: allowed, except `.env` files, which still ask (OpenCode's own default).
- `edit` (OpenCode's edit, write and patch tools): allowed.
- `bash`: allowed only while CanvasTTY's base protection is on and its guard runs in that OpenCode, so hard denies still deny before OpenCode's own check. With base protection off (or no guard), auto still asks before every shell command: it never grants more than the person chose. This is decided at launch; restart the card after changing base protection.
- `external_directory` is untouched: anything outside the project folder asks as before (each tool checks it first).
- The person's own deny and ask rules for these tools (global and project `opencode.json(c)`, `OPENCODE_CONFIG`, the inline config) are appended after the auto rules, so they still win: auto never allows what the person denied or wanted to be asked about.

A launch contributor that puts OpenCode on another model keeps `bash` asking, like accept-edits for the other CLIs.

The control CLI's `create --profile auto|normal|acceptEdits|plan|yolo` is the equivalent for its workers (from the person's own terminal it defaults to YOLO, which needs the person's acknowledgement for that CLI).

The workflow is `list_providers` → `spawn_agent` (one per part) → `wait_for_agent` → `get_agent_result`. Agents should not explore the filesystem for agent CLIs or their configuration; the MCP server's instructions, the tool descriptions and the refusal messages say so.

The control CLI below is a separate surface for automation; `providers` is its equivalent of `list_providers`.

## Teams, budgets and review

`spawn_agent` also takes `review: true`, which starts a separate reviewer in Plan once the worker's turn ends and adds its verdict to the result (if no reviewer can start, the result says so), and `isolate: "worktree"`, which runs the subagent in its own git worktree from an environments plugin. A subagent started without `model` can have its model and effort chosen by a trusted plugin with `model:route`, only among the candidates `list_providers` reports; the card shows the choice and its reason.

The person sets time, token and cost limits for a task tree in the orchestrator card's details. At 80 % the card warns; at the limit the tree gets no new input or subagents and its POSIX process groups, and every descendant found by parent process at that moment (including ones that started their own session), are paused until the person raises or clears the limit. A process already re-parented away before the pause cannot be attributed, and Windows only blocks new input and launches; it cannot pause running work. Usage a CLI does not report counts as no data.

Each card's details show a masked timeline of hook events, usage by model, account and task, a Markdown report, git checkpoints taken before each turn (restore asks for confirmation and keeps untracked files), notification settings, secret grants and the project's network policy.

## Delegation rules

The core applies these to every way an agent can start another one: `spawn_agent`, an orchestrator's control connection (`create` below), a saved subagent that is restored, and a restart. No agent-facing tool can change them.

| Rule | What it guarantees |
| --- | --- |
| Profile ceiling | A subagent's profile is at most its orchestrator's, never YOLO. A saved subagent whose record says more is restored with its orchestrator's ceiling. |
| Project folder | A subagent's `cwd` must be the folder the person chose for the agent it descends from, or a folder inside it, compared as real paths in both Unicode spellings (NFC and NFD name the same folder on macOS). `/`, the home folder or another project is refused: "A subagent works only inside this project's folder …". A relative `cwd` is taken from the orchestrator's folder. |
| Limits | At most `orchestrationMaxDepth` levels of subagents below the agent the person started (2 by default) and `orchestrationMaxSubagents` live subagents in one orchestration, all levels together (8 by default). Only the person sets them, in Settings → Agents. Exited subagents do not count. |
| Plugin launch options | `launchOptions` from an orchestrator reach only plugins that declared `launch.delegable: true`; everything a plugin contributes still passes the core-owned flag and configuration checks (no permission, sandbox, hook or bypass flags, no OpenCode/Kimi configuration that sets approvals). |
| YOLO | Enforced in the main process: only for a CLI the person acknowledged YOLO for in the launcher, never for a subagent, never from an orchestrator's control connection; a plugin with `sessions:launch` needs the same acknowledgement. |
| Isolation | Every subagent and every agent a plugin starts runs inside agent isolation (below) when it is on; where there is no layer, a subagent runs in normal (it asks) and its card says why. |
| No settings | The `canvastty_agents` tools and an orchestrator's control connection cannot change settings, base protection, profiles, plugin trust or isolation. |

## Agent isolation

Settings → Agents → Agent isolation (on by default) wraps an agent's whole process tree (the CLI, its commands, its MCP servers and hooks) in an operating-system layer. It applies to every subagent, every agent a plugin starts, and every agent in a profile other than normal (manual), whoever launched it. Inside it:

- files can be written only in the project folder (both spellings), the launch's own temporary folder (`TMPDIR`), the CLI's own state, configuration and cache folders, and the npm/bun caches; the project's git hooks and an existing repository's git config, and the CLI's own permission settings files (`~/.codex/config.toml`, `~/.claude/settings.json`, OpenCode's config) are not writable;
- SSH, cloud and package-registry credentials, other CLIs' folders (their credentials) and CanvasTTY's own tokens, secret stores, account homes and launch files are unreadable, except what this launch was handed (its own control connection, its account home);
- no other process can be signalled, no app opened through Launch Services, no Apple events sent (osascript driving Terminal), no preferences written through cfprefsd, no launchd job submitted, and Unix sockets reach only DNS, syslog, the launch's own folder and CanvasTTY's token-checked gateways (not Docker, tmux or an SSH agent);
- network and the keychain's services work as before: the CLI reaches its provider and reads its own sign-in.

The agent gets `CANVASTTY_ISOLATION` explaining the rule, so "Operation not permitted" outside it is understood rather than worked around. macOS uses `sandbox-exec` with a profile generated per launch; Linux uses bubblewrap (`bwrap`) when it is installed (read-only root, the same writable folders, empty tmpfs over what may not be read, its own PID namespace, the user runtime folder hidden). Windows has no layer yet. Where there is no layer (Windows, Linux without bubblewrap) a subagent runs in normal (it asks) and a CLI without an auto mode of its own gets no auto; the card shows the reason. Turning isolation off is the person's opt-in: subagents then keep their profile without the layer. The layer fails closed: when it cannot be set up the launch is refused with the reason, never started without it.

Nested sandboxes: macOS refuses to start a sandbox inside another one (`sandbox_apply: Operation not permitted`, measured with `codex sandbox` inside the layer). Inside the layer the CLIs' own sandboxes are therefore switched off and the layer contains their commands instead, while their approval behaviour stays: Claude Code gets its permission mode without its sandbox block; Codex gets `--sandbox danger-full-access --ask-for-approval on-request` plus, in auto, the reviewer `--approve-for-me` uses (`-c approvals_reviewer="auto_review"`; `--approve-for-me` itself cannot be combined with `--sandbox`), never its bypass flag. Commands therefore run at once instead of failing first. In plan the layer keeps the project read-only. Outside the layer each CLI keeps its own sandbox. Files are at least as protected as by the CLIs' sandboxes, reads more; network is the difference: the CLIs' sandboxes block it for commands, the layer does not.

Claude Code keeps its sign-in in the macOS login keychain and rewrites that file when it refreshes the sign-in (the Security framework writes a temporary sibling and renames it over the keychain, inside the process). A Claude launch inside the layer may therefore write that one file (`~/Library/Keychains/login.keychain-db` and its temporary siblings), so a refreshed sign-in is saved and later sessions keep working. Reading other keychain items is still decided by each item's access list (and the keychain prompt), not by the layer; the tradeoff is that such an agent could damage or replace the login keychain file itself. No other CLI and no other file in that folder is writable.

After an isolated session ends, is closed or is restored after a quit, CanvasTTY audits the repositories under its folder whose git folder changed: config keys and files git would execute outside the layer (`core.hooksPath`, filter and diff drivers, `fsmonitor`, `!` aliases, hooks, `info/attributes`) are listed in a notice, and the person can neutralize them or keep them. See [Installing and security](installing-and-security.md#agent-protection-layers).

## Plugin environments

A plugin environment declares in its manifest what it keeps (`keeps`): `launch` (the launch's arguments and environment reach the agent unchanged, so CanvasTTY's hooks and the profile's per-run settings work there), `isolated` (it does not run on this computer's files: a container or a remote host) and `confines`. Without `launch`, any profile but normal is refused and the card says that base protection and CanvasTTY's hooks do not reach the agent there. An `isolated` environment is not wrapped again (its own boundary applies; the card says so); a local one (a worktree) runs inside the layer with the worktree as its project.

## Enable and connect

Turn on Settings → Agents → "Agent orchestration endpoint" (`agentControlEnabled`, off by default; it starts and stops the endpoint without a restart). A session launched from the desktop with the **Orchestrator** role receives `CANVASTTY_CONTROL_CONNECTION` (its own control connection, below) and `CANVASTTY_CONTROL_CLI` (the bundled CLI path) in its environment; ordinary sessions never do. For CI smoke, start the app with `--agent-control` or set `CANVASTTY_AGENT_CONTROL=1` for that invocation to force the endpoint on regardless of the setting. From a source checkout:

```sh
CANVASTTY_AGENT_CONTROL=1 npm run dev
```

This does not modify global settings or enable a network listener. A currently running app without this flag must be restarted by its user before the endpoint is available. Agent lifecycle hooks must be enabled in CanvasTTY.

The app prints `CANVASTTY_AGENT_CONTROL_READY` with its connection descriptor path. The CLI discovers the normal `canvastty/agent-control/connection.json` under the platform's application-data directory. For another user-data directory, pass `--connection <path>` or set `CANVASTTY_CONTROL_CONNECTION`.

Use `npm run control -- <arguments>` or `node scripts/canvastty-control.mjs <arguments>` in the repository. Packaged builds include the same script at `resources/agent-control/canvastty-control.mjs` and the skill at `resources/agent/orchestrator/SKILL.md`. The CLI needs a Node version compatible with the repository. CanvasTTY does not install Codex.

## An orchestrator's control connection

A session launched with the Orchestrator role gets its own control connection (`CANVASTTY_CONTROL_CONNECTION` names a descriptor in a folder of its own), never the app-wide one, which stays the person's. Through it `create` makes a subagent of that orchestrator under every delegation rule above (without `--profile` it gets the orchestrator's profile), the other commands see only what it created, and theme or settings commands are refused. Closing or restarting the orchestrator withdraws the connection.

Run `execution-targets` on this scoped connection to list the person-approved destinations permitted for the task. When `enabled` is true, pass a returned ID to `create --execution-target <id>`; omission and IDs outside that task's allowed targets are refused. Discovery is read-only, accepts no session selector, and reflects current approvals. Agents cannot edit approvals or select an implicit default.

## Workflow

```sh
node scripts/canvastty-control.mjs providers
node scripts/canvastty-control.mjs create --provider codex --cwd /absolute/project --title "Parser fix" --yolo
node scripts/canvastty-control.mjs screen SESSION_ID
node scripts/canvastty-control.mjs send SESSION_ID --prompt-file task.md
node scripts/canvastty-control.mjs status SESSION_ID
node scripts/canvastty-control.mjs result SESSION_ID --after 0
node scripts/canvastty-control.mjs interrupt SESSION_ID
```

Output is JSON; `--json` is accepted explicitly too. `providers` lists the agents CanvasTTY can create workers for (the same entries as `list_providers`, without plugin launch options); an unknown `--provider` is refused with a pointer to it. `create --model <id> --effort <level>` sets the worker's model and reasoning effort like `spawn_agent`. Save the returned session ID. For each send, use its returned `resultRevisionBefore` as `result --after`, rather than repeatedly using zero.

From the person's own terminal, `create` defaults to **YOLO** and passes Codex's real `--dangerously-bypass-approvals-and-sandbox` flag, only for a CLI the person acknowledged YOLO for in the launcher (otherwise it is refused with that reason); inside agent isolation (below) YOLO still cannot write outside the project. Workers can edit files and run tests. Their global settings are unchanged. Specify `--profile normal` to use the ordinary provider configuration instead, or `--profile auto` (Codex, Claude Code, Grok) for the CLI's own auto mode inside its sandbox (see [Launch contributors](plugins.md#launch-contributors-launchcontribute)). Scope tasks and external actions explicitly: full access is not filesystem isolation. A control API with no deletion command does not prevent a full-access model from deleting files. Base protection (Settings → Agents, on by default) still refuses elevation, pipes into a shell, disk commands, and writes or deletes outside the working folder before the tool call runs, YOLO included; it is a guard through the agent's own hook, not a sandbox. Screens, results and failure details returned to a controller are masked for known keys and common key shapes.

The backend uses `TerminalManager` and the existing native provider path. `cwd`, title and profile apply at creation. YOLO is retained by ordinary native restart/restore. Creation does not activate a canvas window or request UI focus.

The default private controller file is next to the connection descriptor. Use a separate `--client-file <path>` for independent orchestrators, and use the same file on each command belonging to one orchestration. It is a credential, not an artifact to commit or share.

## States and results

- `status` returns the native session state plus the controller-submitted turn, if any.
- Before its first prompt a ready provider can still report `unavailable`; inspect `screen`. Startup/authentication/trust menus require resolution before tasks. Task delivery never doubles as menu confirmation.
- `send` accepts at most 16,000 characters of task text. It rejects slash commands, terminal control sequences and input while a submitted turn is active. It does not offer automatic permission approval.
- An accepted send means text was written to the PTY. It is not a completed task.
- A result becomes fresh only after a corresponding working-to-idle lifecycle transition. Provider turn IDs, when present, reject stale completion signals.
- `resultRevision` counts completed observations. A previous completed answer is kept separate from the active turn. `result --after N` returns `fresh: false` until a newer result exists.
- Only controlled Codex sessions opt into the Stop hook's final-message capture. Text is bounded to 4,096 UTF-16 code units, with a `truncated` flag. Ordinary sessions continue reporting lifecycle without capturing their answers.
- `no_result` means a turn became idle without a final-message payload. Inspect files and screen; do not report success from that state alone.
- `interrupt` returns `stopped: false` because Ctrl-C delivery is only a request. Confirm the resulting lifecycle before proceeding.

Human changes to an owned window still matter. Do not submit work while someone is editing its composer. The first version recognizes the Codex empty composer, not arbitrary provider TUIs.

For a visible numbered menu, `screen` returns `interaction.options`, the selected option and a screen revision. After inspecting the choices and confirming the action is within the task's authorization, use `choose SESSION_ID --choice N --revision HASH`. To close an idle menu that explicitly offers Escape, use `dismiss SESSION_ID --revision HASH`. Both commands reject a changed screen, act only on the owned PTY and return delivery receipts; inspect the next screen to confirm the outcome. They do not automatically approve anything.

Codex may show **Hooks need review** on first launch or after the bundled lifecycle helpers change. Review the listed commands before trusting them through the observed menu. This is a separate startup step from selecting YOLO and is never dismissed by submitting a task. Controlled launches disable Codex's terminal animations for stable composer detection; ordinary sessions keep their configuration.

## Retry and ownership

Each CLI response or request failure includes its request ID. After an ambiguous transport failure, inspect status and retry identical input with `--request-id <same-id>`. Reusing an ID for different input fails. Definite validation refusals remain associated with that ID; after correcting the cause, use a new ID.

Receipts are retained for the app instance, with a 4,096-mutation limit instead of silently evicting deduplication records. At most 32 controlled sessions are held at once. Closing an owned window releases its live slot. The API has no close/delete command.

Controllers can access only sessions they created. Manually opened windows and other controllers' sessions cannot be read or controlled. A native restart changes the session generation and invalidates its old grant. An app restart rotates the control instance and token; use a new client file. Restored canvas windows are not automatically adopted by a new controller.

## Local transport

Unix uses a mode-0600 socket in a private temporary directory. Windows reuses the existing current-user-only named-pipe host. Discovery and controller credentials are private files; tokens are not command-line arguments or returned in CLI output. No TCP, remote debugging, renderer evaluation or browser session credentials are used.

This is a local-user trust boundary, not protection against another process already able to read that user's private credential files. Do not expose the descriptor, token or client file to plugins, other accounts or public repositories. API results and screens can contain the controlled task's private data.

## Validation

```sh
npm test
npm run typecheck
npm run build
node scripts/smoke-agent-control.mjs --live --cwd /already/trusted/test-directory --artifacts /private/acceptance-directory
```

The opt-in live smoke uses the actual CLI client, native PTY, installed Codex and authenticated lifecycle/result hooks. It asks Codex to create and edit one uniquely named proof file, independently verifies its bytes, and retains evidence. It never launches or controls the user's desktop window. It uses the existing Codex authentication and consumes provider usage. Platform claims require a run on that platform; Unix unit tests do not prove Windows behavior.

The smoke prints its session ID and private connection/client paths at startup. If a startup menu blocks it, inspect that session with the CLI using those paths and resolve only reviewed, authorized choices. The smoke waits up to two minutes for a ready composer; it does not silently trust hooks or approve permissions.
