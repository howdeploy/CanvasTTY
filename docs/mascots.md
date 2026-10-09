# Animated mascots

Settings > Mascots creates an animated canvas character from a PNG or JPEG image. CanvasTTY opens a new Codex CLI session with one image and the bundled workflow, then opens a local browser workbench for the generated drawings and animations. Creation is interactive: the user approves the character design, chooses actions, reviews the result, and separately approves installation.

## Requirements

- An installed, authenticated Codex CLI. CanvasTTY does not install it or provide an image-generation subscription.
- Image-generation/editing tools available to the Codex session, plus CanvasTTY's agent browser connector for live inspection. Missing generation or browser capability must be reported; file creation is not a substitute for visual review.
- Python 3.10+ with Pillow and NumPy. `CANVASTTY_MASCOT_PYTHON` can point to a Python executable in a virtual environment. Otherwise the host checks installed Python candidates, including the optional Codex desktop runtime.
- One PNG or JPG/JPEG, with or without a background, up to 20 MB and between 32 and 4096 pixels per dimension. Intake validates decoded image content, not only the filename.

The creation dialog explains that its button starts Codex in YOLO/bypass with full file and command access. Existing provider-specific acknowledgement is retained. Starting creation also enables agent browser access when it is disabled. This workflow does not silently change the normal launch profile for other sessions.

### Linux setup

The mascot code uses Node path/process APIs, Python scripts and the existing Linux Codex launcher. It does not run a Windows executable or require a Windows profile. The pipeline is copied into Linux application resources by the shared packaging configuration. CanvasTTY's existing OS isolation and provider protections remain in effect; a requested bypass profile is not a claim that Linux containment is disabled.

From a source checkout, prepare a Python environment without modifying the distribution's system Python:

```sh
python3 -m venv "$HOME/.local/share/canvastty-mascot-venv"
"$HOME/.local/share/canvastty-mascot-venv/bin/python" -m pip install -r assets/mascot-pipeline/requirements.txt
export CANVASTTY_MASCOT_PYTHON="$HOME/.local/share/canvastty-mascot-venv/bin/python"
npm run dev
```

Install the distribution's Python/venv support if `python3 -m venv` is unavailable. There is no dependency on a particular distribution's package manager. Follow the repository's normal Node/Go/development requirements and install/authenticate Codex CLI separately.

For a packaged Linux application, install Pillow and NumPy into the same environment and launch the application with `CANVASTTY_MASCOT_PYTHON` set. A desktop shortcut must inherit that variable if the interpreter cannot otherwise be found. AppImage/deb are the host application's existing release formats; this feature does not ship a separate Windows launcher or a new Linux installer.

The existing Ubuntu `verify` CI job exercises application tests/type-check/build, including the new mascot host/launch/card regressions. The new Ubuntu `mascot-pipeline` job exercises PNG/JPEG intake, the browser preview server, atlas/review/draft/final contracts and real-art placement. Neither substitutes for a live generation session on the maintainer's distribution.

## User workflow

1. Open Settings > Mascots > Create mascot and choose or drop the source image.
2. Codex reads the bundled workflow. Choose whether to retain or revise the appearance. Both choices include a full-body 2D preparation pass and removal of any background; approve the prepared drawing before animation.
3. Choose a name and actions from suggested examples, or describe a custom action, pose, object interaction or scene. Keep the complete requested phase plan, even when only a draft is ready.
4. Watch the source drawings and current built player in the CanvasTTY browser. Review face/emotion changes, identity, material colors, hair silhouette, props, effects and motion. Body and object scale, support contact and neighboring frames are checked before and after atlas placement.
5. Review the identified build. Final approval and permission to install are separate decisions. An explicitly accepted draft can be installed with disclosed defects and deferred phases without pretending the complete animation is finished.
6. CanvasTTY verifies the handoff, registers the local plugin, and opens or updates its transparent canvas card. Select animations from its menu, drag the character, resize proportionally, or close it. The corner and close control appear on hover; touch retains a visible resize corner. Zooming out keeps the mascot rendering instead of replacing it with a generic summary card.

PNG input bytes are preserved. JPEG input bytes are preserved separately, while the working PNG is normalized for EXIF orientation without a generative redraw. Preparation and generated drawings are saved separately; intake conversion alone does not satisfy character preparation.

## Bundled workflow and examples

The canonical English workflow is [`assets/mascot-pipeline/SKILL.md`](../assets/mascot-pipeline/SKILL.md). It contains the complete creation, prompting, measurement, visual review, draft/final approval and delivery instructions on one page. The directory can also be copied intact as a standalone Codex skill; keep its scripts, templates and examples beside `SKILL.md`.

The portable bundle includes:

- PNG/JPEG intake, frame QA, plugin scaffolding, atlas building, contact-sheet/playback previews, continuity measurements, a loopback workbench and finalization scripts.
- A transparent sprite player with localized action labels, menu interaction outside the drag region, separate entrance/main/exit clips and current-build identification.
- Neutral example sets with 152, 39 and 16 drawings, including accepted object interactions, facial beats and effects. Examples guide motion and review; they must not replace the new user's character identity.
- A placement regression made from the same unchanged source art: an unaligned reconstruction compared with accepted aligned output.

Example atlases and the regression add approximately 46 MB to the source bundle before compression. They contain no personal project records, private paths or image metadata. The art serves as motion reference and test evidence; it is not a quality guarantee for future generation or a claim of ownership over depicted character designs or trademarks.

## Local project and installation contract

Projects live under `<userData>/mascots/<project-id>/`. Each project preserves its source, generated frames, `character.json`, full action plan, preview evidence, review records and built plugin. Packaged applications load the workflow from `resources/mascot-pipeline`; development loads `assets/mascot-pipeline`. The workbench binds to loopback and exposes only allowed image/player routes, not arbitrary project files.

`finalize_mascot.py` checks current source/config/package hashes, mechanical QA, required phases, continuity evidence, all-step coverage and observation provenance. Filled review text alone cannot establish artistic quality. Actual source/playback inspection and the user's build-specific approval remain necessary.

- Default finalization records `reviewed`, without requesting installation.
- `--install-approved` requests installation of a finally approved build.
- `--draft --install-approved` requests an explicitly accepted draft using separate `draft-review.json`, the preserved full plan, deferred phases and visible limitations. It must not claim final approval.

Only the finalizer writes the handoff. The host re-verifies it before calling the registered local-mascot installer. It accepts a single static canvas contribution without executable services, hooks or permissions, checks project containment and package assets, and retains the previous registered package under project revisions when updating the same project's plugin. An unknown unregistered destination is preserved and reported rather than overwritten. Do not copy files into the host plugin directory or edit its registry as an installation shortcut.

`ready_for_host` is a request, not proof that the runtime loaded the build. Distinguish the requested build, installed build, registration and observed runtime ID. A successful install alone does not prove drag/resize/menu/zoom behavior.

## Recovering an installation failure

Settings > Mascots shows the failure stage and short root cause, with **Open full log** and **Retry installation**. `installation-error.log` preserves the full command error, stdout and stderr/traceback. A corrected handoff is checked even after the project becomes `failed`; an unchanged rejected request is not retried every three seconds. Explicit retry also supports transient failures without restarting CanvasTTY or manually rewriting its project record. A failed update preserves the previous registered version.

The typed host API exposes `mascots.list()`, `retry(projectId)` and `openLog(projectId)` to the trusted renderer. Plugins do not receive this privileged API. The host records installation state; the actual iframe's current runtime build must be observed separately.

## Validation

From the repository root, using a Python environment with Pillow and NumPy:

```text
npm run typecheck
node --test tests/mascot-installation.test.mjs tests/plugin-bounds.test.mjs tests/plugin-manager.test.mjs tests/settings-normalizer.test.mjs tests/agent-runtime-provider-launch.test.mjs tests/terminal-launch.test.mjs
python -B assets/mascot-pipeline/tests/smoke_pipeline.py
python -B assets/mascot-pipeline/tests/placement_regression.py
```

CI runs the Python pipeline checks on Ubuntu and macOS separately from the application's existing checks. The Ubuntu application job also builds Linux installers, verifies the bundled mascot workflow and player, and smoke-tests the packaged AppImage. The macOS job verifies the same resources inside the packaged application before checking CLI resolution, terminal rendering and browser input. Synthetic tests verify contracts and source-to-atlas placement, not generative quality. Test the complete live creation and card interaction flow on each supported platform before release; a Windows preview run does not establish macOS or Linux UI acceptance.
