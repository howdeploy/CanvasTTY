# CanvasTTY Pixel Theme Contract

A pixel theme has ten PNGs: three terminal sizes (`minimal`, `detailed`,
`master`) times three visual states (`idle`, `working`, `completed`), plus one
workspace `background`. PNGs are inert local images, not CSS or scripts.

## Import in CanvasTTY

Open Settings > Appearance > Terminal borders > Create pixel theme. Give the
theme a name, drop one PNG on each labeled slot, and press Create theme. The
Add PNGs button also accepts all ten files at once when their names end in:

```
minimal_idle.png       minimal_working.png       minimal_completed.png
detailed_idle.png      detailed_working.png      detailed_completed.png
master_idle.png        master_working.png        master_completed.png
background.png
```

A theme prefix is allowed, for example `my_theme_master_done.png`. Legacy
`l1`/`l2` map to minimal/detailed, and `done`/`complete` map to completed.
Files with other names can still be assigned manually. ZIP extraction is not
needed; select the ten PNGs together after generating them.

All nine terminal PNGs must have identical dimensions. The authoring target is
1536x1024 (3:2), matching the fixed 1200x800 logical terminal card. Every PNG must be
320-4096 pixels wide and 200-4096 pixels high, and at most 20 MiB; the whole pack is at most
150 MiB. A static background may have different dimensions. The importer
validates the package and copies it atomically into
`userData/pixel-skins/<id>/`. A rejected package is not installed.

The three aperture tabs in the importer set a separate usable terminal opening
for minimal, detailed, and master, as percentages of frame width/height. Keep
the opening free of important art;
the engine draws the frame beneath a transparent xterm surface, so the artwork
remains visible around the real terminal content. The title, search,
close/restart controls, and PTY stay real
UI, never pixels baked into the image. Leave button artwork and labels out of
the PNG. Reserve a blank control plaque near the top right of every frame,
starting around 73% of image width and 7% of image height, at least 18% wide
and 6% high. The live search, restart, and close buttons are placed there. The
terminal card has a fixed 1200x800 logical size; canvas zoom scales the whole
card without changing the selected art or layout.

## Runtime behavior

- Settings choose minimal or detailed at every zoom level. F4 toggles master
  only for the active terminal; a second F4 returns it to the selected level.
- `working` comes from the provider lifecycle, not terminal text. A provider
  `Stop`, `StopFailure`, or `StopCancelled` hook, or a process `done`/`failed`
  status, selects `completed`. A plain return to `idle` does not. The next
  working turn clears the completed art.
- The frame canvas is noninteractive and below the transparent xterm surface.
  The terminal, title, and controls remain interactive.
- Built-in and imported workspace backgrounds use the workspace element below
  the title bar as their positioning area (`background-attachment: scroll`).
  The camera transforms only the child scene: panning and canvas zoom do not
  move or scale the background. Resizing the window or entering fullscreen
  changes the workspace bounds, and CSS resizes the background with them.
  Every window uses `cover`, filling this area while preserving the image's
  aspect ratio, including ultrawide and all-monitor fullscreen windows.
  Cropping at the edges is intentional; no special fit mode is selected by
  display count or aspect ratio. Terminal PNGs are static; no tiny procedural
  Sakura animation is added.

Five built-in themes ship: Sakura, Matrix, Forest Cabin, Gold & Black, and Cat.
Each has three detail levels and completed art. Gold & Black minimal working
currently uses its idle PNG with an activity marker on the top rail; imported
themes require a distinct PNG for every slot.

The built-in art is shipped as AVIF (4:4:4, 1536x1024) to keep the app small;
`node scripts/encode-skin-art.mjs <file.png>...` encodes a new frame or background
with the same settings. Imported themes stay PNG.

## App API

The isolated renderer bridge exposes `window.canvasTTY.pixelSkins.list()`,
`install(request)`, `readAsset(id, slot)`, and `onChanged(listener)`. `install`
accepts `{ name, apertures, files }`, where `files` maps the ten slot names
above to `Uint8Array` PNG bytes. It returns a summary with all three aperture
profiles; set
`settings.terminalBorderSkin` to that ID to activate it. The same validation
and storage are used by the UI. This is an in-app API, not a network endpoint.

## Checks

Run `npm run typecheck`, `npm test`, and `npm run build`. Visual acceptance
still requires an isolated Electron dev profile: inspect each level and state,
type and select text in the live terminal, use search/close, change
zoom, press F4 twice, and verify no artwork or controls cover the output.
