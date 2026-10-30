# Windows beta 2: source fixes

Date: 2026-10-31 (Europe/Moscow). Agent: Codex.

Initially prepared on `dev/1.8.5-beta2-optimization`, starting HEAD `df274cfb`,
and preserved in commit `cdcfb02e` on `integration/1.8.5-beta2-platform-fixes`.
This beta2 tree contains
the delivery/composer mechanisms present in the archive excerpts. The archive's
exact build commit has not been established.

Evidence: `CanvasTTY-debug-2026-10-30.zip`, SHA256
`0599f32be29aea415b79f3c94cd0712dc2b1711b376e4d7acd71e4b1649f8522`.
The earlier archive review is in
`canvastty-work/canvastty/docs/research/2026-10-31-windows-beta2/REVIEW.md`.

## Changes

- **File opening:** both terminal file links and mascot logs use a shared helper.
  Linux uses `shell.openExternal(pathToFileURL(validatedPath).href)` to avoid the
  dropped callback in Electron 43.8.1's Linux `OpenPath`/`XDGUtil` no-wait branch.
  Windows/macOS retain native paths, `shell.openPath` and its error handling.
  Sender/session/file validation remains in place. Primary source:
  [Electron 43.8.1 Linux implementation](https://github.com/electron/electron/blob/v43.8.1/shell/common/platform_util_linux.cc).
- **Delivery interrupted by terminal replies:** the renderer marks synchronous
  xterm replies to recognized queries as protocol input. That origin crosses the
  preload/IPC boundary and reaches TerminalManager's existing protocol path, so
  those replies do not increment manualInputRevision or cancel a staged paste.
  Keyboard, paste and explicit key handlers retain person origin. Classification
  requires a matching query/reply in the same parser turn; arbitrary escape input
  is not exempted. Unrecognized responses conservatively remain person input.
- **Claude readiness:** the archive's exact `Try "edit <filepath> to..."` hint can
  count as empty without dim styling only with native idle evidence, a cursor at
  the input start, no reserved paste and no unconsumed manual edits. Delivery and
  the native screen endpoint use the same guard. The archive does not contain
  cell attributes, so this is a guarded compatibility fix, not proof that missing
  dim styling caused that particular incident.
- **Browser viewport:** initial positive bounds now belong to the common runtime
  tab creation path, covering normal, restored and migrated Chromium tabs before
  their canvas card has a viewport. This removes the 0x0 initialization path that
  can cause VIEWPORT_UNAVAILABLE. It does not make hidden cards visible or promise
  that every hidden surface can produce screenshots.
- **Recovery instructions:** browser errors/skill and unsupported native-menu
  errors no longer direct an agent toward desktop automation as a fallback.
  Instructions do not revoke external provider CUA tool permissions.
- **Stable updates from beta:** the existing shared version parser compares
  numeric versions, allowing a stable release to replace its prerelease and
  excluding prerelease candidates and older stable versions. Both the controller
  and Sparkle's existing caller use this comparison.
- **UTF-8 hook input:** stdin uses Node's streaming UTF-8 decoder, preserving
  characters split between chunks. The existing input-size limit remains.

## Verification and remaining uncertainty

Source callers, installed xterm parser/reply implementations and the final diff
were read. Focused regression cases were added to existing tests for file-opening
IPC on all three platforms, query origin, delivery, the Claude hint, initial tab
layout and beta-to-stable version comparison; the IPC fixture was updated.

No tests, typecheck, lint, build, Electron/browser/UI checks or Windows/Wine runs
were executed. No package was built or installed. Cross-platform runtime behavior
still needs verification; the running application has not been patched.

The reported duplicate greeting remains unlocalized: the archive has one actual
user greeting record and repeated quoted history in guardian envelopes. Renderer
output already joins snapshot/live/replay streams by absolute offsets. This does
not disprove a display defect. No content-based deduplication was introduced,
because it could discard legitimate repeated terminal output.
