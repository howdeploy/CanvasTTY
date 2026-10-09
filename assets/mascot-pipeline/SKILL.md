---
name: canvastty-sprite-character
description: Create or improve an animated CanvasTTY mascot from a PNG or JPEG image, with image preparation, bundled motion examples, a live CanvasTTY browser preview, frame repair, scale review and approved installation.
---

# CanvasTTY mascot pipeline

This is the complete single-page workflow. The portable pipeline and installed skill contain the same instructions, scripts, templates and motion examples. Read this page in full; no other Markdown page is required. Executable helpers and image/data assets remain separate files. All instructions are English; speak to the user and label the mascot menu in their language.

## 1. Start the chat and show the workspace

CanvasTTY accepts one PNG or JPG/JPEG, with or without a background, containing visible character pixels. Preserve a PNG unchanged as `references/character.png`; preserve original JPEG bytes as `references/character.jpg` and create the working `references/character.png` with corrected EXIF orientation and lossless PNG encoding of the decoded pixels. This encoding conversion does not redraw the character or remove its background. A background is accepted at intake, but animation frames must have real transparency. Reject corrupt, empty or unsupported input, not an opaque reference. Intake checks the actual PNG/JPEG format, a 20 MB limit and dimensions from 32 through 4096 pixels before launching.

Find a Python 3.10+ executable that imports Pillow and NumPy before starting generation. Use the host-supplied quoted executable and pipeline paths. For standalone intake, run `scripts/prepare_input.py --image <upload.png-or-jpg> --project <new-project>` once. Do not run it again when the host has already prepared the working reference. Never overwrite an existing project.

The CanvasTTY creation button explicitly starts the user's own Codex terminal in YOLO/bypass mode, with full file/command access and no approval prompts. Reuse the host's existing YOLO profile and browser integration; do not change unrelated global agent settings. The launch flag is `--dangerously-bypass-approvals-and-sandbox`. Pass the initial prompt before the variadic `--image <path>` argument so prompt text is not parsed as extra image paths. Attach exactly the uploaded image initially; load motion examples later when relevant. Full access does not replace creative choices, appearance approval or installation approval.

At the beginning of the session, connect to CanvasTTY's browser and keep the work visible there throughout creation. The host starts `scripts/serve_preview.py <project> --port 0` on loopback, opens its reported URL and supplies it to the chat. This workbench shows uploaded/prepared references, generated frames and the current built player; it refreshes as files change. Reuse the same tab. Before declaring browser control unavailable, discover the specialized `canvastty_browser` connector and its `browser_list_tabs`, `browser_observe`, `browser_activate_tab`, `browser_reload` and `browser_screenshot` tools. An empty general CUA inventory does not prove the CanvasTTY connector is unavailable. A new connector tab should use `engine: chromium` to be visible. Read the installed tool schemas before calling them.

If the server stopped after an interruption, restart the supplied helper on a free port, read its URL, then navigate the existing CanvasTTY tab. Keep the process alive for the work session; bind only to `127.0.0.1`. The server serves only project images and plugin assets, not the entire user directory. Report unavailable browser access honestly; do not silently use an unrelated external browser. Keep preview availability separate from approval of what it shows.

## 2. First question and mandatory source preparation

Before asking for a name/action or generating art, ask in the user's language:

> Which appearance should we use? 1. Keep the uploaded character's appearance and prepare it for animation. 2. Change its appearance first, review the result, then animate the approved version.

Do not prescribe a body shape. For option 2, ask what to keep/change. Both options include the following mandatory preparation pass for JPEG photos and PNG drawings, including when the upload already has transparency. Explain that it creates a clean full-body 2D animation reference, preserves the uploaded identity and requires approval. JPEG-to-PNG intake conversion does not satisfy this image-generation step. Preserve the original and save the generated result separately as `references/prepared-character.png`. Resolve an ambiguous main subject before generation. Inspect the local reference before editing it, and use the available image-generation/editing tool with transparent output enabled.

Use this preparation prompt, plus only the user's explicitly requested appearance changes:

```text
Use the attached image as the reference for the main character. If the character
is cropped, complete the missing body parts to full height. Preserve the
recognizable appearance, proportions, facial expression, hairstyle, pose of the
visible body parts, colors, clothing and accessories. Continue missing details
logically from what is visible; do not add arbitrary elements.

Redraw the character as a high-quality, detailed 2D illustration. Correct defects
in the source drawing: unclear contours, incorrect anatomy, merged details and
untidy shadows. Clearly separate hair, face, clothing and accessories. If glasses
are present, preserve their original shape, size and position. Draw both lenses,
the frame, bridge and temples clearly so they do not merge with the hair. Give
all other existing accessories the same careful treatment.

Show one complete character from crown to feet, with a small margin around it.
The legs are straight and uncrossed; both feet rest evenly on the same horizontal
line as if standing on a flat surface. No extra limbs or fingers.

Remove the entire background, other characters and extraneous objects. Keep only
the main character on a genuinely transparent PNG background with an alpha
channel. No halo, drawn floor, cast shadow, text or frame.
```

For an upright human character, the requested straight, uncrossed legs override the source leg pose; preserve other visible pose details. For a nonhuman design without human legs/feet, apply the equivalent stable support pose instead of inventing human anatomy. Keep worn accessories; remove unrelated scene objects. If removing an integral held object would change identity, clarify it. A later action can introduce its own props.

Show the prepared full-resolution PNG in the workbench and chat. Check alpha, outline clarity, anatomy, glasses/accessories and retained design details. Ask for explicit approval; revise until approved or stop if the user rejects preparation. Do not silently substitute the original for the required pass. Save the approved result as `references/approved-character.png`. Use it to create/show the canonical idle frame for approval; the prepared image itself may become that frame if it already meets canvas and support requirements. Do not generate an action from an unapproved design.

## 3. Establish the canonical reference and offer actions

The accepted canonical frame fixes identity, physical scale, camera, palette, material and lighting. Reject blur, stains and unclear details here before producing many frames. Record visible invariants in one project `action-brief.md`: face structure, iris/pupil, obscured features, hair part/locks/ends/tone, skin marks, clothing colors/prints, fabric translucency, legwear, shoe shape/reflections, accessories and proportions. Keep redesign variants separate; the old upload never overrides a later approved design.

Ask for a display name if missing. Then proactively offer a short, varied set of actions in the user's language rather than only asking an empty question. For example:

> What should we animate next? We can make dancing, playing a handheld game,
> working at a laptop, smoking, listening to music, or drinking from a can.
> Or describe your own action, pose or scene, including objects, emotions and
> effects. For example: sitting on a cushion and coding on a laptop.

Offer other relevant library patterns over subsequent rounds: resting/breathing and blinking, cheering, sadness, surprise, looking around, using a phone, taking a selfie, waving at the camera, yawning/stretching, dozing, a playful effect, eating a snack, hugging a plush object, tucking hair and waving. Adapt to the actual character and user; these are suggestions, not a mandatory catalog. After each completed action, offer a few unfinished choices plus a custom scene and “finish.” Do not create all suggested actions without selection.

## 4. Use the bundled successful motion library

Actual past sprite drawings are bundled in `examples/motion-library/`. They are visual motion evidence, not new character identity or a promise that every depicted detail is flawless. File names and metadata are neutral; no private paths, account details, original project IDs or named source mascots are required.

- `set-a/motion.json` and its atlases contain the completed 152-drawing source set: dance, idle, cheer, sad, alert, phone, selfie, wavecam, sleepy, doze, look, smoke, energy, rainbow, game, snack, music, plush, laptop, tuck, wave and available entry/exit clips.
- `set-b/motion.json` contains 39 drawings: idle, seated-laptop staging (12 entrance drawings and a 12-drawing working cycle), and smoking (one entrance drawing, 12 main-cycle drawings over 3.55 seconds, and one exit drawing). The smoking sequence includes the corrected eighth main-cycle drawing, preserving its 0.20-second timing and neighboring grip continuity. The supplied reversed laptop exit is a structural example that must be checked for the new object's state. These completed sequences guide movement, facial acting, effects and prop contact; they do not exempt new frames from review.
- `set-c/motion.json` contains 16 drawings from a separately approved laptop scene: retrieval, bending/squatting/seating, opening, typing, thinking, idea reaction and exit. Its aligned atlas is the exact approved artwork. `examples/placement-regression/` contains an unaligned reconstruction from the same unchanged source drawings and a neutral diagnostic case. It is a placement failure example, never a positive motion reference. `python tests/placement_regression.py` distinguishes the drifting footwear rows from the aligned one-pixel range. Those regions, thresholds and tolerances apply only to this example; stable support does not prove correct anatomy, prop geometry or expressions. The reconstruction is not represented as an archived rejected package. No personal project paths, names or account IDs are required.
- The artwork was supplied by the project owner as workflow examples. Inclusion does not establish a new blanket license or ownership of depicted characters. Do not relabel it as public-domain/MIT artwork or publish invented attribution/permission claims. Example art stays out of each newly generated mascot plugin.

Extract full-resolution reference frames and a timing/contact sheet using:

```text
python scripts/reference_frames.py --set set-a --action smoke --output <project>/motion-reference/smoke
python scripts/reference_frames.py --set set-b --action laptop:in --output <project>/motion-reference/seated-entry
python scripts/reference_frames.py --set set-b --action smoke --output <project>/motion-reference/alternate-smoke
```

Use a new empty output directory. The script crops existing atlas cells without redrawing them. Inspect the sequence sheet, then the relevant original-sized frames. The timing JSON preserves order/repetition. Do not attach every library image to the chat or every generation.

For a known action, select its matching sequence and study phases, joint chains, contact, expression changes, effect origin and rhythm. For smoking, examine raise -> contact -> inhale -> move away -> exhale/cloud -> disperse -> ash tap, including the loop closure. Do not reduce the action to moving a hand. For seated work, examine reaching/holding -> lowering into the seat -> opening the laptop -> typing, thinking, reacting and recovering; check that its physical size stays consistent throughout.

For a new action without a direct example, decompose it into known movement components. Combine a relevant reaching motion, seating transition, grip/contact, expression beat and effect progression. Explain which source frames guide each component; assemble a coherent new staging before adding intermediates. If a component has no suitable example, create and approve a few new key poses rather than pretending a match exists. The new accepted poses become local motion references. Do not copy the source character's face, clothes, palette, body proportions or unrequested props.

Assign explicit roles in each generation prompt:

1. Approved new character/canonical frame: identity, material, camera and physical scale; highest priority.
2. Accepted neighboring poses of that same new character: continuity and trajectory.
3. Selected library frames: motion/contact/emotion/effect pattern only.

Attach only the few images relevant to that beat, within actual tool limits. Preserve identity anchors first if image slots are limited. Inspect local images before using them. Never generate a chain based only on the last generated frame; that compounds drift. A useful example can improve the first attempt but does not remove review.

## 5. Plan the action and its mandatory phases

Record the user's actual action, required phases and intended impression before generation. Use simple entry, main cycle and exit; note active limbs, body supports, prop shape/size/state and reference roles. Additional drawings connect accepted poses rather than introducing unnecessary choreography. Clarify whether a requested count covers the whole scene or only its main loop.

For every required phase, record: phase ID, intended pose/expression, shoulder/elbow/wrist and palm orientation, prop state/contact, effect origin/progression, target clip, frame names and intended timing. Keep a brief phase matrix in `action-brief.md` and the machine-readable mapping in `character.json`:

Before generation, write a facial beat map for anticipation -> effort/action -> contact -> reaction -> recovery: gaze, eyelid openness, brow shape and mouth state for each key pose. Facial identity (eye design, proportions, distinctive features) is fixed; the canonical frame's sleepy eyelids, O-shaped mouth or other momentary emotion is not. Specify the next expression explicitly rather than repeatedly asking for the canonical face. Record each persistent prop's fixed geometry and states, including grip, contact surface, hinge/pivot and occlusion. Inspect both visible and hidden limb chains in every active pose; a third hand or a hand without a connected arm is a rejection.

```json
"required_phases": {
  "smoke": [
    {"id": "inhale", "clip": "smoke", "frames": ["smoke-contact"]},
    {"id": "exhale", "clip": "smoke", "frames": ["smoke-exhale"]},
    {"id": "ash-tap", "clip": "smoke", "frames": ["smoke-ash"]},
    {"id": "recovery", "clip": "smoke", "frames": ["smoke-recover"]}
  ]
}
```

This is an illustration; create real drawings and a complete mapping for the requested action. A repeatable phase belongs in the main clip when the user expects to see it every cycle. Entrance/exit frames do not count as missing main-loop content. The required phase list must retain the user's request. Never delete a phase because generation was difficult; changing scope needs an explicit user decision. A general “looks fine” does not retroactively authorize a silently omitted requirement.

Start with compatible key poses, often three to six when suitable. Show a rough entry and main loop in the browser before producing many in-betweens. Mark drafts clearly. Correct incompatible anchors first. For each missing drawing, name its predecessor, successor and purpose: bridge, contact, accent or recovery. Numbering alone does not define playback order.

## 6. Mandatory body AND object scale gate

Run this gate after canonical approval, after every generated or repaired frame, after the key-pose set and before building/reviewing any completed action. Repeat it on the built atlas playback before approval. PNG dimensions alone are insufficient.

1. Confirm the common source canvas and camera. Compare the canonical and neighboring drawings at exactly one display scale; never auto-fit each image independently.
2. Compare physical head size, torso width/length and relevant limb segments. Record actual landmark measurements in the brief for suspect frames and the visual reason for any change. Sitting lowers the head; bending and foreshortening change projected measurements. Do not force all heads to the same height or impose one pixel ratio on different perspectives.
3. Track real support contacts (feet, seated hips, hands) and trajectories. Distinguish whole-image translation from a wrongly enlarged body. Matching feet alone does not fix a changed head/body size. Smoke, symbols, hair and falling objects are not floor markers.
4. Compare every prop from its first appearance through entrance, main loop and exit: phones, cups, cans, cigarettes, toys, tools, furniture, weapons, laptops and any custom object. Record proportions relative to the same hand/body landmarks. A closed laptop behind the back must not become physically larger when opened on the lap; this is one example of the rule for all objects. Perspective changes projected geometry, not the object's actual dimensions. Check fixed proportions, joints/hinges and correct overlaps; no duplicate edges, floating contacts or unexplained growth. A planned physical change, such as inflation or unfolding, must be explicitly staged rather than treated as accidental drift.
5. Compare previous -> current -> next and the last -> first seam, using contact sheets/overlays as diagnostic views. A global size jump fails the gate even when the individual drawing looks good. Record a concrete scale/prop review result, not merely “same resolution.”
6. Repair the responsible layer before continuing: a source proportion error needs regeneration/targeted redraw; a translation needs a justified whole-image offset; wrong atlas addressing needs a build/player fix. Never independently stretch a frame to fill its bounding box or splice body parts to conceal the mismatch.

Minor file-size discrepancies can be corrected with transparent padding when the physical drawing scale already matches. The historical seated-laptop import accepted approximately one pixel of width/two of height difference and applied a small whole-image floor offset; those were project-specific values, not global tolerances. Preserve exact source pixels and check clipping. Use explicit ground anchors only for known grounded poses, keeping airborne frames elevated. Do not align the whole character using an effect below the feet.

Diagnose discontinuity before adding drawings. Inspect source -> explicit placement transform -> final atlas cell -> actual playback. A bridge cannot repair a whole drawing placed on a different floor. A progressive crown position is insufficient when footwear bounces. Track independent crown/face, shoulders, hips, footwear, hands and prop landmarks. For grounded poses, unexplained support movement fails review even when the head trajectory looks plausible. Preserve intended bending, sitting and facial acting; do not force constant crown height.

Define support regions visually around real footwear, hips or other contact. Record the region and a diagnostic alpha threshold suitable for that artwork; faint stray alpha, hair and effects are not support. Check every nonzero-alpha pixel separately for clipping safety. A diagnostic threshold must never remove soft artwork. If an explicit translation would clip, choose a feasible common floor or justified common transparent padding and rebuild. Never crop real art or disable the clipping guard.

After the key-pose build and after every final art/placement/order/timing change, maintain `continuity.json` and run `python scripts/review_continuity.py <project>/character.json`. Annotate every active drawing using the current source hash from `build-report.json`. Coordinates and lengths are measured in the common SOURCE canvas, not auto-fitted thumbnail pixels. Include at least independent body landmarks and body sizes, plus measured dimensions/hinge/grip landmarks for every visible persistent prop. Use stable measurement names across neighboring drawings. Explain occlusion rather than inventing hidden measurements. Example record (replace every value with actual inspected measurements):

```json
{
  "limits": {"support_px": 2, "landmark_px": 24, "size_fraction": 0.05},
  "frames": {
    "action-01": {
      "source_sha256": "<current source hash>",
      "supports": [{"name": "footwear", "region": [100, 800, 500, 960], "alpha_threshold": 128, "grounded": true}],
      "landmarks": {"face": [300, 180], "hips": [300, 580], "hand": [340, 520], "prop_hinge": [320, 540]},
      "sizes": {"head_width": 90, "torso_length": 260, "prop_base_width": 180},
      "anatomy": "<both limb chains, visible/occluded hands and fingers>",
      "contact": "<grip, support surface, pivot and overlaps>",
      "face": "<observed gaze, eyelids, brows, mouth and intended beat>"
    }
  }
}
```

The example limits, threshold and regions are not universal defaults. Choose and explain useful limits for the project's canvas, perspective and movement; do not inflate them to hide a defect. An unsupported pose uses `"supports": []` and a nonempty `support_note`. Airborne/lifted contacts must be marked appropriately. The helper measures source and actual atlas support edges in declared regions, records applied offsets, and flags neighbor/seam/boundary changes in support, landmark trajectory and measured sizes. Source annotations must be updated after source edits. The report does not detect anatomy, infer trustworthy measurements or prove artistic success. Its flags require a concrete observed explanation for intentional motion/perspective, or a repair and new report. Support-only success never substitutes for body, object and facial review.

## 7. Generate and repair exact beats

Keep one concise frame brief with output filename, source references and their roles, both neighboring poses, phase, duration, exact change, retained details and rejection criteria. Specify image-left/image-right. Good prompts constrain the movement while retaining expressive face/body motion.

```text
Create one complete transparent frame of the approved character.
Reference A fixes this character's identity, materials, colors and proportions.
Reference B fixes its canonical camera, physical scale and source canvas.
References C/D are accepted neighboring poses of this character.
Reference E, if provided, is a motion example only: do not copy its identity.
Beat: [one named phase and its progression from previous toward next].
Supports: [actual body contacts]. Active motion: [trajectory and landmarks].
Hand: [shoulder-elbow-wrist chain, palm side, grip, visible/occluded fingers].
Object: [count, shape, fixed physical size, state, contact and overlap].
Face: [gaze, eye/iris/pupil, brows, mouth, expression and progression].
Effect: [source, direction, development and disappearance, if requested].
Preserve [specific hair locks/tone, skin, clothing marks, fabric translucency,
shoe reflections, accessories, unchanged parts and lighting].
Keep the full character, prop and effect inside the common transparent canvas.
Reject [specific risks]. Do not add new hair, accessories or background.
```

For an in-between, say exactly which part progresses how far between the accepted endpoints. Preserve grip/palm side unless the planned rotation changes them. For a repair, use the flawed frame for pose/composition, the canonical frame for identity/material and both neighbors for trajectory. Name only the defects to fix and preserve accepted features. Save a distinct replacement, inspect it, then change exact config references. If local repair damages anatomy/material, regenerate a coherent full frame from accepted anchors.

Check the complete shoulder -> elbow -> forearm -> wrist -> palm -> fingers -> object chain. Hidden fingers need not be drawn. Adapt anatomy checks to the actual human, stylized or nonhuman design. Check lips/fingers/knees/support contact and object occlusion across the entire action when a defect recurs.

Materials are invariants as well as colors: stable hair/skin/cloth patches must retain tone, texture, density and translucency. Natural reflections move with a pose; a global brightness shift, darker stockings or plastic-looking fabric is a defect. Check shoe highlights, iris/pupil and glasses as carefully as the hair. Preserve major hair locks, ends and length; no extra masses appearing near knees or elsewhere. Do not remove stains by flattening or blurring the whole material.

Every action needs a deliberate facial-performance plan: gaze, eyes, brows and mouth develop through anticipation, action, peak and recovery. Include suitable emotional-effect beats in the action brief, guided by the successful library examples: an idea glint, a thought symbol, a joy accent, rhythm marks or another fitting effect. Show the proposed effect in the key-pose preview; adapt to the user's requested tone and retain an explicit no-effects preference. Do not put every symbol in every frame or cover the face with effects. Effects support readable facial acting; a changed arm or animated symbols over an unintentionally frozen face do not satisfy an expressive scene. For a faceless character use its designed equivalents, such as eye lights, ears or posture. Stable supports do not mean a frozen body. Breathing, gaze, facial movement and appropriate follow-through remain alive.

Effects must have a physical or expressive source. Exhaled smoke starts at the mouth; an ember trail starts at the tip; ash separates from the tip and falls; a thought accent matches a visible facial beat. Preserve soft alpha. Check edges on light and dark backgrounds; invisible RGB under zero alpha is not a visible halo. Do not add an unrequested floor, shadow or effect.

After two unsuccessful attempts at the same defect, change the references, prompt or staging and explain what remains wrong. Do not repeat blindly, remove requested phases or finalize a defective action. Respect tool refusals/capability limits and never claim missing artwork exists.

## 8. Timing, counts and live review

Budget seconds for phases before assigning holds. A bridge is usually shorter than a readable contact or emotional peak, but no universal duration applies. Neighboring effect drawings share a phase budget; do not give each a long pause. Recalculate totals when adding frames. Coherent typing/breathing/sway mini-cycles may repeat, but repeated steps are not new drawings and cannot replace missing movement.

The completed 152-drawing reference provides these main-loop planning examples. Entrance/exit are excluded; counts are estimates, not automatic quality thresholds:

| Pattern | Unique drawings | Steps | Approximate seconds where measured |
| --- | ---: | ---: | ---: |
| Dance | 20 | 20 | 3.28 |
| Idle breathing/blink | 7 | 7 | 2.82 |
| Cheer | 2 | 6 | |
| Sad reaction | 2 | 2 | |
| Alert | 1 | 1 | |
| Phone | 2 | 4 | |
| Selfie | 2 | 3 | |
| Camera wave | 1 | 1 | |
| Yawn/stretch | 3 | 3 | |
| Doze/wake | 2 | 4 | |
| Look around | 3 | 3 | |
| Smoking | 12 | 12 | 3.55 |
| Drink from a can | 6 | 6 | 5.30 |
| Short effect | 6 | 12 | |
| Handheld game | 4 | 6 | |
| Snack | 11 | 12 | 2.90 |
| Music | 10 | 17 | 3.89 |
| Plush hug | 9 | 9 | 2.30 |
| Laptop | 15 | 19 | 4.29 |
| Hair tuck | 5 | 5 | |
| Brief wave | 1 | 1 | |

A one-drawing reaction is a held pose; add motion when animation is requested. Always report whole-scene drawings, main-loop drawings, repeated steps and seconds separately. A 12-drawing entrance plus 12-drawing main loop is 24 drawings if disjoint. Reusing the entrance for a physically valid reversed exit adds no new drawings. Never reverse irreversible consumption/spilling to invent an exit.

Keep generated frames visible in the browser as they arrive. After accepted key poses, intermediate fills, repairs and timing changes, rebuild the current action and observe it in that same browser. The workbench refreshes files/builds automatically; verify its displayed project/build ID and the selected action. Use `/plugin/index.html?action=<id>` for a direct player view if needed. After interruption, verify the loopback server still responds. Do not confuse an old installed canvas card with the preview.

Review four distinct views: full-size source against canonical; previous/current/next at shared scale; close-ups of hands/props/materials/effects; actual built main loop at card size, separately from entry/exit. Watch at least two main loops. A finite demo containing entrance/loop/exit can conceal that the main loop only contains two drawings; show and report the main loop itself. A successful tool click, file count or green mechanical QA is not visual proof.

Cover EVERY built playback step deterministically. The workbench's Deterministic atlas review pauses on a named clip and zero-based step; Previous/Next and the step selector cannot skip short holds. It displays build ID, drawing name, duration, previous/current/next actual atlas cells at one shared scale, and the current source before placement. Support lines/offsets come from the current continuity report. Use `scene/<action>` to traverse idle, full entrance, two main loops, full exit and idle, including cross-clip boundaries. An individual clip wraps within itself, so inspect actual entrance/exit boundaries through the scene option. Also inspect full-size source and the live player; deterministic cells do not prove timing or the live runtime's clip selection. Capture real-time playback when available to compare with the ordered sheet; sparse screenshots alone cannot establish complete coverage. If capture is unavailable, report that limitation and still step through every frame and observe the full sequence live.

## 9. Build configuration and commands

Keep the upload, approved source, frames, reports and action brief outside `plugin/`. Start from `examples/character.example.json`, set the real ID/name, and use project-relative paths. Do not copy developer paths or example mascot IDs. Script paths below are relative to the pipeline; project paths belong to this user.

```text
python scripts/qa_frames.py <project>/character.json
python scripts/scaffold_plugin.py <project>/character.json
python scripts/build_sprite.py <project>/character.json
python scripts/preview_animation.py <project>/character.json --action <id>
python scripts/review_continuity.py <project>/character.json
```

Scaffold only an empty plugin directory. Preserve a customized existing player/page during updates. Rebuild after art, timing, order or metadata changes. Draft QA/build/preview is allowed without final approval.

- `clips` maps IDs to `[frame-name, seconds]` steps. Repeated mini-cycles use `{"seq": [["frame", 0.2]], "times": 3}`. Durations are finite positive seconds and repeat counts positive integers.
- `action:in`, `action`, `action:out` separate entry, main loop and exit. Prefer explicit clips. Legacy `to-action`/`from-action` frames are included by QA/build if present. `deck` lists selectable actions; `labels` uses the user's UI language. `loops` controls finite repeats in All actions, and `follow` optional related actions.
- The selected action enters once, repeats its main clip until changed, then exits at a compatible clip boundary. Latest selection during transitions wins. Same selection does not restart. Do not return to idle after every main cycle. Design shorter transitions if quicker switching is needed; do not cut into incompatible poses.
- `floor_frame` identifies the canonical reference, reviewed even outside playable clips. `scale: 1` preserves source detail. Larger positive integers downsample every drawing equally with premultiplied alpha. One common crop/scale retains the sequence's full extent.
- Coordinates/alpha are preserved by default. No automatic chroma key or alpha threshold removes soft smoke. Optional `floor_y` and `ground_anchors` supply actual grounded contact rows, for example `"floor_y": 900, "ground_anchors": {"wave-02": 897}` shifts that whole frame down three pixels. `airborne` frames are excluded. Clipping a translated drawing fails. No per-frame stretching/warping is allowed.
- `cols`, `rows_per_sheet`, `margin_x`, `pad_bottom` govern packing. Atlas sides are capped at 4096 pixels; oversized cells need less padding or a justified shared scale. Keep host size limits. Generated `shadow` defaults to false.
- `name-fixed.png` takes precedence over `name.png` for compatibility. QA/build reports record the exact resolved source. Prefer explicit replacement names and retain accepted originals.

`build-report.json` records config/source/package hashes, `build_id`, per-clip drawings/steps/seconds and source-canvas/crop/common-scale/per-frame placement transforms. `frames.js` provides index-to-name mapping; the player exposes the build ID (`document.documentElement.dataset.buildId`). The ID includes current source, config, runtime and atlas asset hashes. Changing art, placement, order, timing or package assets invalidates previous build-specific approval. Preview/finalization reject stale package evidence. The atlas-based WebP demonstration repeats the whole entry/cycles/exit when its file loops; the live player's selected mode has different, intentional behavior. The source PNG review remains separate. Ordered sheets show names, atlas indices, holds and build ID at a common scale; report entrance, main-loop and exit counts/seconds separately.

## 10. Approval and explicit installation

Preserve the user's complete agreed action/phase configuration as `character-full-plan.json` before reducing `character.json` for a partial delivery. Keep all requested actions and phase IDs in that full plan, including unfinished work. Update it only when the user explicitly changes scope, and record the reason in the brief. Never remove a squat, transition, object interaction or other requirement merely to make validation green. A new full-plan hash needs new build-specific user acceptance.

After actual full-size and playback review, record a specific QA note:

```text
python scripts/qa_frames.py <project>/character.json --approve "<observed source, scale, neighbor, material, contact and motion findings>"
```

Create `review.json` for the exact current `build_id`. It must include `user_approved: true` only after the user approves that shown build; `checks` with nonempty observation notes for `source`, `scale`, `neighbors`, `materials_contact`, `effects`, `main_loop`, `boundaries`, `browser`; and `phases` mapping each action and each required phase ID to its observed result. Record why a check is inapplicable where genuinely so; do not fabricate an observation. Example structure:

```json
{
  "build_id": "<current build ID>",
  "user_approved": true,
  "installation_approved": false,
  "checks": {
    "source": "<full-resolution finding>",
    "scale": "<body, prop and support comparisons>",
    "neighbors": "<continuity and seam findings>",
    "materials_contact": "<material, grip and object findings>",
    "effects": "<source/progression/disappearance findings>",
    "main_loop": "<action, unique drawings, steps, seconds and observed repeats>",
    "boundaries": "<entry, exit and switching findings>",
    "browser": "<project, URL, build ID, selected action and visible result>"
  },
  "phases": {"<action>": {"<required-phase-id>": "<observed phase result>"}},
  "coverage": {"<clip>": {"steps": [0, 1, 2], "note": "<observed built steps and boundaries; list every actual index>"}},
  "playback": {"<action>": {"main_loops": 2, "entrance": true, "exit": true, "note": "<whole live sequence at card size; capture evidence or limitation>"}},
  "continuity_manifest_sha256": "<hash from current continuity-report.json>",
  "continuity_report_sha256": "<SHA-256 of the current continuity-report.json file>",
  "continuity_decisions": {"<reported flag ID>": "<observed reason this motion/perspective is intentional; otherwise repair>"},
  "unresolved": []
}
```

This structure records review evidence; filled text alone cannot prove artistic quality. Never autofill positive claims from mechanical QA. The finalizer checks mapped phase presence, review coverage, current hashes and build approval. Retain every user-required phase; deleting a requirement to pass validation is invalid.

Add `observations` for every key in `checks`. Each entry has `mode`, `evidence` (the actual inspected view/capture and finding), and `build_id` for `observed_current_build`. New source art, scale, neighboring steps, main-loop timing, boundaries and browser runtime are different observations; an unchanged atlas does not prove new timing or placement. `reused_unchanged_pixels` is allowed only for `source`, `materials_contact` or `effects`; record `previous_build_id`, the prior observation's evidence, and `source_sha256` mapping every source drawing claimed unchanged to its exact current hash. This reuses only that stated pixel evidence, never user approval or live playback. `unverified` is not final approval. The finalizer rejects missing/stale provenance, but it cannot establish whether an observation is truthful: actually inspect the views. Do not manufacture coverage notes or bulk-dismiss flags with generic descriptions of poses. When `character-full-plan.json` exists, include its exact `full_plan_sha256` in the review. Final delivery must retain every full-plan action/phase.

### Explicitly accepted draft delivery

If the user requests the current incomplete result for inspection, do not force it through final approval. Explain its exact build, missing phases and known defects first. Preserve the full plan and create separate `draft-review.json` with the same checks, provenance, coverage, phases, playback and continuity hashes as above, plus:

```json
{
  "build_id": "<current build ID>",
  "user_approved": false,
  "draft_approved": true,
  "installation_approved": true,
  "full_plan_sha256": "<SHA-256 of character-full-plan.json>",
  "deferred_phases": ["<action>/<missing-phase-id>"],
  "unresolved": ["<known visual defect or unverified check key>"],
  "limitations": ["<same missing phase ID>", "<same known defect or unverified check key>"]
}
```

Merge these fields into the complete evidence record, not a standalone minimal approval. `deferred_phases` lists every absent full-plan phase in full-plan action/phase order; `limitations` contains every deferred ID and every unresolved concern verbatim, with explanatory context where useful. `draft_approved` and `installation_approved` reflect the user's explicit acceptance of this identified draft and its disclosed limits. Keep `review.json` untouched; do not copy old approval into it. An unresolved continuity flag remains its exact flag ID in `unresolved` and `limitations`, rather than an invented positive decision. A check that cannot be observed uses provenance mode `unverified` and its check key in both lists; state why and what remains to inspect. Every available built step and live sequence must still be reviewed where accessible. Structural/source/package/hash QA remains mandatory; draft mode does not allow missing files, invalid geometry, stale builds or arbitrary runtime code.

If live playback itself cannot be observed, keep `main_loop` in both limitation lists and record that action's `playback` as `{"mode": "unverified", "note": "<why live playback is unavailable and what remains>"}`. Do not invent loops or transition observations. This exception applies only to a disclosed, user-accepted draft; final delivery still requires the real live sequence.

Run `python scripts/finalize_mascot.py <project>/character.json --draft` to record an accepted draft without requesting installation; use `--draft --install-approved` only with that draft's separate installation consent. The host verifies the same mode with `--draft --verify-only --install-approved`. A draft handoff carries `delivery: draft` and visible `limitations`; it never means the complete animation is finally approved. Continue deferred work against the preserved full plan. Final delivery uses `review.json`, fresh current-build evidence and no unresolved concerns, without `--draft`.

`coverage` must list every zero-based step exactly once for every configured clip, including idle, full entrance and exit, not only unique drawings. `playback` records at least two actual repeating main loops per selectable action and full entrance/exit observation where present. Keep unresolved concerns visible while working; an approved final result requires an explicitly empty `unresolved` list. Every current continuity flag needs a substantive observed decision; do not use boilerplate to dismiss unexplained growth, support drift, disconnected limbs or impossible hinges. The finalizer rejects stale continuity annotations/reports and missing step coverage. Re-run QA after the final placement/config/source change, rebuild, measure the final atlas, then make new visual findings for that build. Never copy approval of an earlier draft forward.

Report machine checks, full-size art inspection, all-step/adjacent-frame inspection, live playback, user approval, host-installed ID and loaded runtime ID as separate facts. An observed `installedBuildId` confirms the host's installed package; it does not independently establish drag/resize/zoom/close or that an already open runtime loaded the same build. Check those separately when reporting them.

Run `python scripts/finalize_mascot.py <project>/character.json` to produce `status: reviewed`, which does not request installation. Then ask separately whether to install/replace this project/build on the canvas, unless the user has already explicitly authorized installation of this reviewed result. Show project identity and build ID. “Finish the animation” or appearance approval alone is not installation approval.

After the user's installation decision, set `installation_approved: true` for that build and run:

```text
python scripts/finalize_mascot.py <project>/character.json --install-approved
```

This writes `mascot-result.json` with `ready_for_host`, matching `buildId`, `installationApproved: true`, actions, plugin directory and transparent/resizable presentation. CanvasTTY verifies it, installs/replaces only the same project's package, saves the previous installed version, and reloads its card. An old `installedAt` must not prevent an approved update. Host validation uses `--verify-only --install-approved` without rewriting the requested result.

Use only this finalizer and CanvasTTY's registered local-mascot installer. Never write `ready_for_host` by hand, copy a package into the host's plugins directory, edit its registry, reset the project record on disk or rewrite packaged application files to bypass review. Package files alone do not register a plugin. An existing unregistered destination is preserved and reported as a collision; establish its owner and obtain approval for any archive/move before recovery. Do not overwrite an unknown directory.

After a rejection, inspect the project's `mascot-project.json`, `mascot-result.json` and `installation-error.log`. State the stage (creation, handoff, package/review validation, registration or card load), short root cause, requested build, installed build and registered plugin as separate facts. `window.canvasTTY.mascots.list()` in the trusted host renderer exposes these fields; do not attempt this host-only API from an untrusted plugin iframe. The full log retains stderr/traceback; do not rely on a truncated command prefix. Correct the underlying issue, regenerate a current approved handoff through the finalizer, and let the host retry the changed result even if the project was previously `failed`. An unchanged rejected result is not polled repeatedly. Use Settings > Mascots > Retry installation (or the trusted host's `mascots.retry(projectId)`) for an explicit retry, including transient failures, without restarting or editing in-memory state through disk. A retry queued during a check is handled on the following poll. Registry confirmation still does not prove the open card's runtime build; inspect that independently. If runtime/browser access is unavailable, report it as unverified rather than promising success.

`ready_for_host` is a request, not proof of installation. Confirm the loaded runtime build matches the reviewed build. Check the actual card's transparent background, drag by the character, menu interaction outside drag regions, proportional resizing down to small sizes, hover-only resize corner (available for touch), close button and visible mascot when zoomed out. The parent card belongs to CanvasTTY; iframe CSS cannot make the parent transparent. Report any unobserved host behavior as unverified. Do not patch application files as a generic mascot-creation fallback.

## 11. Continue safely and preserve the result

On resume, read the project brief, actual config, accepted references and current files. Verify preview server/build, then continue missing work. Do not rerun obsolete experiment scripts just because their filenames sound relevant. New art/order/timing/package changes invalidate dependent review and installation approval.

Keep one concise brief with source provenance, exact prompts/reference roles, accepted/rejected frames and reasons, phase order/timing, measurements for scale repairs, current preview and unresolved defects. Preserve original art and previous accepted versions. Do not modify this global skill during ordinary mascot creation; improvements belong to a separate user-requested task.

The result is complete only when the requested action set, scale gate, visual review and agreed delivery stage are complete. Known defects stay unresolved until rechecked. Technical QA cannot guarantee perfect generative output; it prevents structural errors while source/sequence/browser review decides whether the art works.
