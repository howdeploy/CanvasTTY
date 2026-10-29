# PR #170 integration into 1.8.5-beta2

Source: [teo-nex's PR #170](https://github.com/howdeploy/CanvasTTY/pull/170),
initially reviewed at `3fb2db1275a59129a0412d0ac345c31ed7ac739a`, then updated
through `a496a833714fc3d347c6842ce71748bb8ab8c7aa` on 2026-10-30.
The PR targets `release/1.8.5-beta`, the same beta.1 base as this worktree.
The existing optimization, keyboard, notification, launch-mode and platform fixes
are retained. This is a selective source integration, not a merge or publication.

## Compatibility decisions

| Area | Integration and platform behavior |
| --- | --- |
| Long socket paths | Keep beta2's shared `createUnixEndpoint`, private temporary-directory ownership and cleanup. Do not add the PR's separate macOS fallback. Windows keeps its current-user named pipes. |
| Workspace wallpaper | Keep beta2's shared proportional `cover` and workspace-relative `scroll` attachment, including ultrawide windows. Do not add a macOS-only CSS override. |
| Rename | The configured rename action works from the selected xterm on all platforms; ordinary fields and shortcut recorders keep their own input. |
| Fast gestures | Terminal, region and note drag/resize finalize from pointer-up coordinates. Marquee and group selection include release travel. Cancellation does not save synthetic release coordinates. Bounds acknowledgements do not overwrite an active gesture. These are shared pointer-event rules, not OS checks. |
| Note text | A late save acknowledgement cannot replace a newer dirty draft, including an edit back to the original text. Acknowledged clean notes still accept external updates. |
| Fullscreen terminals | One persistent portal host retains each TerminalCard/xterm across canvas/fullscreen transitions. Scrollback, selection and terminal modes are not reconstructed from the shorter main-process ring. The existing shared callback and surface-mount gates remain. |
| Output pressure | All platforms acknowledge absolute offsets after xterm's parser callback. The manager pauses its own PTY reader at 1,048,576 outstanding characters and resumes below 262,144. Hidden-card replay and observers retain their existing routing; receiving IPC alone does not grant credit. Invalid/stale credits cannot resume another PTY. |
| GPU/background resources | WebGL context restoration rebuilds the worker's GPU resources and respects playback state. Skin values that finish loading after cache eviction are disposed; an older load cannot evict a replacement. Shared behavior on all platforms. |
| Browser lifecycle | Disabling pausing queues a wake behind a pending freeze. Hidden/minimized owners hide their native surfaces; automation can still keep a tab unthrottled. Crashed tabs retain identity/URL for reload. Disposal removes download callbacks and replaces captured permission handlers with stateless deny handlers. |
| Settings files | Future-version files remain unchanged and reject writes; unreadable files also block writes. Invalid JSON/root values are moved to a unique backup before defaults may be saved. Existing normalization, explicit settings and serialized persistence remain. Shared on all platforms. |
| Plugin packages | Keep downloads bounded at 25 MiB, unpacked packages at 64 MiB, 500 entries and the existing per-asset/path validation. These limits are the same on all platforms. |
| Plugin install ownership | Reserve the destination exclusively and clean up only a destination owned by that attempt. Existing directories, files and symlinks are preserved. Windows copies into the empty reservation because directory replacement by rename is not portable; POSIX retains rename. |
| Closed PTYs | On macOS/Linux, a closed card whose exact PTY remains alive gets one SIGKILL escalation after the existing grace interval. Exit cancels it; other cards are not signalled. Windows retains node-pty/ConPTY termination. |
| Plugin service children | macOS/Linux services own detached process groups; shutdown/crash cleanup signals only that group. Windows retains its child-process termination path and receives no negative-PID signals. |
| Electron | Manifest, lockfile and common packaging config pin 43.8.1 for every OS. The [upstream TLS mitigation](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9) is not macOS-specific. No dependency installation was performed in the shared local node_modules. |

Separate native browser windows, their preload/IPC/UI, the additional esbuild
dependency, and the macOS UI smoke launcher are outside this bug-fix integration.
The existing single browser card remains the product behavior on every platform.

## Evidence and outstanding validation

The relevant PR regressions were adapted to common behavior rather than retaining
tests that require Linux/Windows to keep the old bugs. Coverage includes gestures,
save ordering, file/install ownership, parser credit, fullscreen host lifetime,
resource release, browser recovery and platform-specific process shutdown.
Existing startup and memoization assertions were updated for the shared card host.

The initial integration was source-only. A subsequent requested build and launch
completed with Electron 43.8.1; that running dev snapshot predates the paused-exit
follow-up below. It has not been rebuilt or restarted for this follow-up.

PR CI is evidence for the PR's tree, not this adapted worktree. At initial review,
its shared verify job and macOS CLI resolution passed, while Windows pipe-host
verification was still running. The macOS native/package job failed on cycle 58:
`a completed process must produce the actual command output`. Its settled file
descriptor count stayed at 23; that does not establish absence of other native
failures. Packaging steps were skipped after that failure. See the
[failed native job](https://github.com/howdeploy/CanvasTTY/actions/runs/40966627929/job/123772666589).
The follow-up below supersedes that CI result. Native macOS/Windows acceptance
and full combined-tree verification remain open.

## Paused-exit follow-up

Imported the two subsequent commits, `bc2c18626ff437ea8fed019cc8547a9ba5199b52`
and `a496a833714fc3d347c6842ce71748bb8ab8c7aa`, with one compatibility adaptation:
the exit-drain fix covers the shared Unix node-pty implementation because Linux
uses the same reader backpressure. Windows ConPTY is unchanged.

- A paused reader retains its unread tail after native process exit. Resume starts
  the existing 200 ms close fallback; another pause defers destruction again.
  Natural close cancels both the timer and deferred resume listener.
- Explicit kill resumes the reader before signalling, including an already-dead
  producer, so closing a card or quitting does not retain its paused exit watcher.
- The resource smoke child waits for acknowledgement of its actual output marker
  before exiting. Echoed acknowledgement text cannot substitute for command output.

Local evidence:

- All 54 targeted tests passed, with no skips: dependency TS/JS callbacks,
  manager close/restart/quit, parser credits, exit cleanup, native ownership
  harnesses and smoke-cycle output acknowledgement. Log:
  `tmp/dev-beta2/paused-exit-tests.log`.
- `patch-package --error-on-fail` successfully applied the complete patch to an
  isolated physical dependency copy. Log:
  `tmp/dev-beta2/paused-exit-patch-apply.log`.
- One real Linux PTY per variant, under Electron 43.8.1: the child exited while
  the reader was paused for 500 ms. Original node-pty delivered 1,048,576 of
  1,049,088 characters, losing the final 512; the patched copy delivered all
  1,049,088 before reporting exit. Logs:
  `tmp/dev-beta2/paused-exit-linux-original.log` and
  `tmp/dev-beta2/paused-exit-linux-fixed.log`.
- An initial dependency copy retained a symlink and temporarily modified the shared
  dev dependency. Its two files were restored byte-for-byte from saved originals
  before the valid comparison and repeated tests; the patched copy is now physical.
  The invalid first comparison was replaced by the runs recorded above.

All eight upstream checks at the updated head passed, including
[macOS native/package validation](https://github.com/howdeploy/CanvasTTY/actions/runs/40968484559/job/123778940447)
and [shared/platform checks](https://github.com/howdeploy/CanvasTTY/actions/runs/40968484644).
These results cover the contributor's tree. No native macOS/Windows run, GUI check,
new application build or dev restart was performed for this follow-up.
