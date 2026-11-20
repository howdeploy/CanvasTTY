# CanvasTTY design engine for agents

Create artwork for the built-in CanvasTTY Canvas and Home: independent live wallpapers, GIF avatars, clock backgrounds/fonts and animated terminal frames.

CanvasTTY 2.0 combines this engine with Canvas Files. Build isolated test bundles with `npm run package:v2`.

Start with [AGENT_START.md](AGENT_START.md), then [LIVE_ENGINE.md](LIVE_ENGINE.md) for media, resolution, framing, portable files and agent parameters. [SPEC.ru.md](SPEC.ru.md) covers terminal geometry. The new contract requires a supporting Live Engine build; older releases still accept the original static PNG theme format.

- `tools/encode_animation.py`: assemble authored PNG frames or a sprite sheet into real looping GIF/APNG/WebP. Requires Pillow. No model or API calls.
- `tools/animate_emissive.py`: local visible hot-texture flow, rising sparks and status variants over detailed forge art (Pillow + NumPy); no model-generated video.
- `tools/prepare_lab_profile.mjs`: prepare a NEW isolated lab profile from a checksummed appearance manifest through production importers in a supporting CanvasTTY source checkout. Refuses existing profiles. This is not a native one-click profile importer.
- `tools/animate_artwork.py`: optional masked periodic glow on supplied still art. Preserves frame geometry; this is a local effect, not AI object animation.
- `tools/media_probe.py`: decode every image frame, check motion, loop, dimensions and transparent apertures. Video metadata inspection needs ffprobe; full video decoding remains an app check.
- `tools/pack_wallpaper.py --require-live`: infer real media dimensions and package an independent `.ctwallpaper`. Legacy byte-only packaging with explicit dimensions remains standard-library only.
- `tools/pack_terminal_theme.py`: validate and package exactly ten roles, with per-level aperture checks on every frame and a separate SHA-256 receipt.
- `tools/generate_pixel_wallpaper.py`: local seeded pixel-art PNG/GIF generator, requires Pillow. No model or API.
- `templates/`: ready-to-edit agent briefs for Canvas wallpaper, Home avatar and clocks.
- `tools/build_kit.py`: build the portable offline instructions/tools/templates/references ZIP. This is a source kit, not an app install package.
- `examples/Gothic_Eclipse_Install_v2.zip`: original static theme example, not a template to resubmit as new work.

Build the portable kit with `python3 tools/build_kit.py CanvasTTY_Agent_Theme_Kit_v3.zip` (refuses overwrite). Install independent wallpapers from the built-in appearance workshop; install full frame themes as a ZIP containing exactly nine state frames and one background. Never import the source kit itself into CanvasTTY.

The [40-concept sheet](references/CanvasTTY_40_Unique_Concepts.png) is optional inspiration. Validation proves only the checks it executes; report decoding, visual review and actual app installation separately.

See [the quick workflow](LIVE_ENGINE.md#сборка-анимации-из-концепта) and [the current release scope](RELEASE_PLAN.ru.md). The kit does not call a generation provider itself: agents supply art/frames from their chosen tool, then validate and package locally. Living Forge is the only new bundled preset.
