# Beta2 platform integration

Date: 2026-10-31 (Europe/Moscow). Agent: Codex.

Branch: `integration/1.8.5-beta2-platform-fixes`.
Base: `df274cfb144b2d46bbc3ab6a3b2d92c12549169e` on
`dev/1.8.5-beta2-optimization`. The base branch was not advanced.
The existing local fixes were preserved first as `cdcfb02e`; see
[their scope and limitations](../2026-10-31-windows-beta2/FIXES.md).

## Imported PRs

Each fetched PR head was merged independently with `--no-ff`, retaining its
original commits, authorship, tests and evidence. All seven merged without Git
conflicts. The fetched heads matched GitHub metadata at integration time.

| PR | Head | Integration merge | Purpose |
| --- | --- | --- | --- |
| [171](https://github.com/howdeploy/CanvasTTY/pull/171) | `572dde61` | `43ec3c2e` | Retain the macOS renderer/PTY consumer when the main window closes; restore it on Dock activation. |
| [172](https://github.com/howdeploy/CanvasTTY/pull/172) | `e379e210` | `817ca7c5` | Preserve saved tabs before lazy Browser runtime initialization. |
| [173](https://github.com/howdeploy/CanvasTTY/pull/173) | `2de2726b` | `8b6fccf4` | Hide the native Browser surface during terminal fullscreen. |
| [174](https://github.com/howdeploy/CanvasTTY/pull/174) | `ab862996` | `6a108bfa` | Prevent deferred page focus from stealing the address field's focus. |
| [175](https://github.com/howdeploy/CanvasTTY/pull/175) | `2c883ef4` | `728d019a` | Resolve local shell cwd for Files at selection time; reject superseded root operations. |
| [176](https://github.com/howdeploy/CanvasTTY/pull/176) | `f50fcdf3` | `674cf378` | Give the download count its own CSS target. |
| [178](https://github.com/howdeploy/CanvasTTY/pull/178) | `0780a8a1` | `c8697c05` | Add Browser history swipes, a HUD fade and a macOS native scroll-phase monitor. |

## Source comparison

- BrowserService retains both the earlier positive initial tab bounds and #172's
  initialization guard. #178 adds gesture ownership/lifecycle handling to that
  combined service. Hiding the Browser, losing focus, closing a tab or disposing
  the service cancels its native gesture; hidden-surface navigation is rejected.
- TerminalManager retains protocol input origin, manual-input protection and the
  guarded Claude hint behavior while adding #175's independent cwd lookup.
  The shared preload/IPC input contract and the file-open helper were preserved.
- #171's acknowledgement-test deadline change merged with the earlier delivery
  regression cases. This changes the successful scenario's budget while retaining
  the existing short-deadline failure coverage.
- #178's AppKit addon is loaded only on macOS; Linux/Windows use the idle fallback.
  Its build script is wired into normal build/dev and macOS packaging, and the
  required node-gyp dependency already exists in the base lockfile.
- The new generated addon directories were gitignored by #178, but the independent
  secret-audit walker does not read gitignore. Integration adds those same two
  generated directories to its existing native-build exclusions, avoiding scans
  of node-gyp's local path metadata. The source directories remain in scan scope.

## PR 172 CI clarification

The [author's clarification](https://github.com/howdeploy/CanvasTTY/pull/172#issuecomment-6534023741)
and [issue 177](https://github.com/howdeploy/CanvasTTY/issues/177) concern an
unchanged CanvasLink touch-cancellation test, not the tab-persistence patch.
The original contracts job saw `down` without the expected `up` after touchCancel.

At the user's request, only failed jobs in
[CanvasLink run 41129728295](https://github.com/howdeploy/CanvasTTY/actions/runs/41129728295)
were rerun. The new contracts job `124349686669` passed **118/118**, with no
failures or skips, including the previously failed test; typecheck also passed.
The workflow's final conclusion is success. Main CI run `41129728142` was already
successful. No test code or assertions were changed to obtain that result.
This supports intermittency; it does not identify the exact cancellation race.

## Verification limits and next checks

This integration was reviewed through PR descriptions/diffs and local production
callers, Git ancestry, platform guards, packaging paths and the resulting merge
history. The remote CI result above covers PR 172's original head, not this
combined branch. No local tests, typecheck, lint, build, browser, Electron or UI
checks were run; no application package was built or installed.

The combined branch still needs its own acceptance before release: staged prompt
delivery and manual-edit interruption; file opening on Linux/Windows/macOS; lazy
tab persistence; Browser fullscreen/address focus; Files root selection races;
macOS close/Dock/quit; and native gesture build/signing, release/momentum and
fallback behavior. #175 deliberately retains launch-directory semantics on
Windows, agent sessions, environment wrappers and stopped sessions. #178's PR
does not establish packaged DMG/signing or physical Windows/Linux acceptance.
The earlier reported duplicate greeting remains unlocalized.
