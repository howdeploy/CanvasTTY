# Native agent orchestration from the CLI

CanvasTTY can expose an opt-in local control endpoint so an orchestrator can create native Codex windows, send tasks, observe lifecycle, read results and interrupt its own turns without taking the user's mouse, keyboard, clipboard or focus.

## Enable and connect

Start the app with `--agent-control`, or set `CANVASTTY_AGENT_CONTROL=1` for that invocation. From a source checkout:

```sh
CANVASTTY_AGENT_CONTROL=1 npm run dev
```

This does not modify global settings or enable a network listener. A currently running app without this flag must be restarted by its user before the endpoint is available. Agent lifecycle hooks must be enabled in CanvasTTY.

The app prints `CANVASTTY_AGENT_CONTROL_READY` with its connection descriptor path. The CLI discovers the normal `canvastty/agent-control/connection.json` under the platform's application-data directory. For another user-data directory, pass `--connection <path>` or set `CANVASTTY_CONTROL_CONNECTION`.

Use `npm run control -- <arguments>` or `node scripts/canvastty-control.mjs <arguments>` in the repository. Packaged builds include the same script at `resources/agent-control/canvastty-control.mjs` and the skill at `resources/agent/orchestrator/SKILL.md`. The CLI needs a Node version compatible with the repository. CanvasTTY does not install Codex.

## Workflow

```sh
node scripts/canvastty-control.mjs create --provider codex --cwd /absolute/project --title "Parser fix" --yolo
node scripts/canvastty-control.mjs screen SESSION_ID
node scripts/canvastty-control.mjs send SESSION_ID --prompt-file task.md
node scripts/canvastty-control.mjs status SESSION_ID
node scripts/canvastty-control.mjs result SESSION_ID --after 0
node scripts/canvastty-control.mjs interrupt SESSION_ID
```

Output is JSON; `--json` is accepted explicitly too. Save the returned session ID. For each send, use its returned `resultRevisionBefore` as `result --after`, rather than repeatedly using zero.

`create` defaults to **YOLO** and passes Codex's real `--dangerously-bypass-approvals-and-sandbox` flag. Workers can edit files and run tests. Their global settings are unchanged. Specify `--profile normal` to use the ordinary provider configuration instead. Scope tasks and external actions explicitly: full access is not filesystem isolation. A control API with no deletion command does not prevent a full-access model from deleting files.

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
