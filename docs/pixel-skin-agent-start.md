# Create a CanvasTTY pixel theme with an agent

This is the starting point for an agent with no prior CanvasTTY context. Give the agent [the design-kit repository](https://github.com/teo-nex/CanvasTTY-design-for-agents) or [its offline ZIP](https://github.com/teo-nex/CanvasTTY-design-for-agents/raw/refs/heads/main/CanvasTTY_Agent_Theme_Kit_v1.zip), plus a visual reference. The deliverable is a separate **install ZIP**, not the source-kit ZIP. Read [the full pack specification](pixel-skin-packs.ru.md) and confirm the current contract in `src/main/services/PixelSkinPackRegistry.ts` before generating art.

## Inputs and output

- Input: a visual reference or a written art direction, plus optional theme name. The reference is not a ready-to-import frame unless it satisfies the requirements below.
- Output: one ZIP containing **exactly ten final PNG files**. The nine frame files are `minimal_idle.png`, `minimal_working.png`, `minimal_completed.png`, `detailed_idle.png`, `detailed_working.png`, `detailed_completed.png`, `master_idle.png`, `master_working.png`, and `master_completed.png`. The tenth is `background.png`.
- A single containing folder is permitted, but there must be exactly one file for each name. Do not include drafts, alternate versions, nested source/output copies, instructions, or `apertures.json` in the install ZIP. A separate source kit is optional.
- Use `completed`, **not** `done`, in filenames. Completed covers a finished agent turn, whether it succeeded or failed.

## Live themes

For live themes the same ten roles can use PNG/APNG/GIF/WebP frames and a PNG/APNG/GIF/WebP/MP4/WebM wallpaper. Replace the extension, keep the exact role stem, and include only one file per role. Never put video in a frame slot. Keep a transparent aperture throughout the animation. See [the live-theme contract](pixel-skin-packs.ru.md#живые-темы-фон-и-рамки) for limits, codec guidance and motion behavior. The static ten-PNG instructions below remain the baseline for static themes.

## Artwork contract

1. Make all nine frames 1536 x 1024 px, PNG RGBA, on the same 3:2 canvas. Keep exterior geometry fixed across levels and states. Do not shift, crop, or rotate the frame between states.
2. The terminal output is live UI underneath the art. Leave a transparent central opening large enough for readable text. Do not bake terminal text, a black terminal panel, the cursor, title, controls, or screenshots into the image. Keep the top-right button plaque clear for native search and close buttons.
3. `minimal` is restrained; `detailed` adds visible decoration; `master` is a distinct, richer F4 view. Every level has three **visually distinguishable** states: calm `idle`, active `working`, and resolved `completed`. Maintain identical geometry within a level. Do not represent state solely with a barely visible dot or a tiny color change.
4. `background.png` is separate wallpaper for the canvas. It is not a replacement for the transparent terminal opening. Do not duplicate it under source and output paths in the install ZIP.
5. For each level report `left`, `right`, `top`, and `bottom` aperture insets as percentages of the full 1536 x 1024 frame. Check that all three states of that level use the same safe opening. The user can enter these values in the import dialog; an agent can pass them in a separate `apertures.json` via `skin-install --apertures`. Do not assume the ZIP auto-configures apertures.

## Build and verify

1. Inspect the reference and decide the level/state differences before rendering. Generate or edit the art, then examine all ten final images at their actual resolution. Inspect a contact sheet too, to catch geometry drift and indistinguishable states.
2. Package only the final ten PNGs. Validate the archive from the repository root:

   ```sh
   node scripts/validate-pixel-skin-zip.mjs /absolute/path/theme-install.zip
   ```

   This invokes the same ZIP importer as CanvasTTY in an isolated temporary profile. It checks the exact file set and new-theme frame dimensions. A successful structural check does **not** prove the art looks good.
3. Compare the nine frames overlaid, check the transparent opening and button plaque, and preview with live terminal text in CanvasTTY when possible. Report any visual check that could not be done.
4. Deliver the install ZIP, a small preview/contact sheet, the three aperture presets, and a concise description of what changes in each state. Say whether the theme was actually installed and tested in the app; do not infer that from ZIP validation.

For agent-driven installation in a running CanvasTTY instance, see [the local Agent Control commands](pixel-skin-packs.ru.md#установка-агентом). Installing or changing a theme affects the current user's app; verify the target instance and preserve other installed themes.

### Самостоятельные обои и Home (встроенный Live Engine)

Для обоев Canvas, аватарки Home и фона часов больше не требуется пакет из десяти рамок. В «Фоны и живые обои → Мастерская обоев и Home» пользователь загружает PNG/APNG/GIF/WebP/MP4/WebM, видит реальное разрешение, настраивает cover/contain и фокус кадра, сохраняет фон в библиотеку и выбирает назначение. GIF также поддержан в рамках.

Оригинал копируется в профиль, параметры сохраняются отдельно, экспорт `.ctwallpaper` переносит всё вместе. Файл UTF-8 JSON: `schemaVersion:1`, `kind:"canvastty-wallpaper"`, `name`, `recipe:{fit,x,y,width,height,pixelated,clockFont,dim}`, `source:{file,width,height,base64}`. В `source` содержится исходное медиа; путь `file` не открывается. Изображения до 20 МиБ, видео до 80 МиБ; файл пакета до 113 МиБ; до 8192 px по стороне и 36 Мп. Размер `recipe` задаёт холст превью/генератора, не перекодирует видео.

Для часов доступны mono/sans/serif/pixel и затемнение фона; время и дата рисуются приложением. Встроенный процедурный генератор создаёт статичный PNG с seed и палитрой. Обновлённый набор [CanvasTTY-design-for-agents](https://github.com/teo-nex/CanvasTTY-design-for-agents) содержит LIVE_ENGINE.md, шаблоны заданий и инструменты упаковки/генерации GIF. Новые материалы требуют публикации обновлённой версии набора и сборки приложения с Live Engine; не подразумевайте их наличие в старом установленном клиенте.

Из соответствующего исходного дерева CanvasTTY:

```sh
node scripts/canvastty-control.mjs wallpaper-list
node scripts/canvastty-control.mjs wallpaper-install --package /absolute/path/clock.ctwallpaper --target clock
node scripts/canvastty-control.mjs wallpaper-select wallpaper:UUID --target canvas
```

Используется подключение владельца. Агентское подключение остаётся без права менять оформление приложения. Проверка генератора/упаковщика и импортёра не заменяет декодирование и визуальную проверку в Electron. В настройках мастерской копируется задание с фактическими параметрами кадра, холста и часов.

### Live authoring tools (kit v3, local preparation)

The updated local `design-engine/` adds `tools/encode_animation.py` for real authored PNG frames / sprite sheets, optional masked glow in `tools/animate_artwork.py`, `tools/pack_wallpaper.py --require-live` for independent wallpaper, and `tools/pack_terminal_theme.py --apertures apertures.json --require-live --receipt theme-check.json` for frame packs. These decode every image frame, reject flat or finite-loop live images, and verify transparent openings. Glow is a local brightness effect, not generated object motion. GIF has palette/binary-alpha limits; APNG/WebP preserve richer art. The v3 source kit is not an installable skin ZIP. Validate against the target Live Engine checkout, then check visual quality and playback in Electron. Public framework publication is a separate release step.

For matching Live Engine builds, see `design-engine/LIVE_ENGINE.md`: animated roles are supported, and `pack_terminal_theme.py --controls controls.json` can embed optional `layout.json` with measured apertures and button plaques. Use authored held poses on a fixed pixel grid for calm animation. Leave transparent outer space for ornaments protruding beyond the main rails; verify control placement at several sizes in the actual app. The ten-PNG rules above describe the legacy static format.
