#!/usr/bin/env python3
"""Build one community theme from its approved 16:9 source art using Live Engine."""
import argparse
import hashlib
import json
import math
import random
from pathlib import Path
from zipfile import ZipFile

from PIL import Image, ImageDraw, ImageFilter, ImageOps

from encode_animation import encode
from media_probe import IMAGE_EXTENSIONS, write_json
from pack_terminal_theme import LEVELS, STATES, pack as pack_terminal
from pack_wallpaper import pack as pack_wallpaper

SIZE = (800, 450)
WALL_FRAMES = 48
NEAREST = Image.Resampling.NEAREST
THEMES = {
    'steampunk-airship': (7, 'Steampunk Airship', '#e8b975', '#795338', '#8be0d2', 'serif', (474, 27, 794, 347)),
    'brutalist-monolith': (8, 'Brutalist Monolith', '#b1bac4', '#505a66', '#f3cc77', 'mono', (429, 113, 749, 433)),
    'cyberpunk-noodle-bar': (9, 'Cyberpunk Noodle Bar', '#f5a3fd', '#80477d', '#79efdc', 'mono', (474, 25, 794, 345)),
}


def glow(layer, box, color, amount):
    """Light gently changes the source pixels under a fixed, feathered mask."""
    if amount <= 0:
        return
    x, y, radius_x, radius_y = box
    halo = Image.new('RGBA', (2 * radius_x, 2 * radius_y))
    pen = ImageDraw.Draw(halo)
    pen.ellipse((radius_x // 4, radius_y // 4, 2 * radius_x - radius_x // 4,
                 2 * radius_y - radius_y // 4), fill=(*color, int(amount)))
    layer.alpha_composite(halo.filter(ImageFilter.GaussianBlur(min(radius_x, radius_y) / 4)), (x - radius_x, y - radius_y))


def airship(art, frame):
    # Scroll the painted cloud bank itself. The staggered passes crossfade at the
    # loop boundary and the feathered mask keeps the deck and rigging stationary.
    phase = frame / WALL_FRAMES
    cloud_box = (0, 203, 574, 340)
    clouds = art.crop(cloud_box)
    mask = Image.new('L', clouds.size)
    ImageDraw.Draw(mask).polygon([(8, 40), (342, 30), (545, 21), (543, 79), (34, 108)], fill=228)
    mask = mask.filter(ImageFilter.GaussianBlur(15))
    first = int(32 * phase)
    second = int(32 * ((phase + .5) % 1))
    weights = math.sin(math.pi * phase) ** 2
    padded = ImageOps.expand(clouds, border=(32, 0, 0, 0))
    padded.paste(clouds.crop((0, 0, 32, clouds.height)).transpose(Image.Transpose.FLIP_LEFT_RIGHT), (0, 0))
    passes = [padded.crop((32 - shift, 0, 32 - shift + clouds.width, clouds.height)) for shift in (first, second)]
    art.paste(Image.blend(passes[1], passes[0], weights), cloud_box[:2], mask)
    lights = Image.new('RGBA', art.size)
    pulse = .5 + .5 * math.sin(phase * math.tau * 2)
    glow(lights, (673, 151, 29, 34), (255, 178, 66), 20 + 38 * pulse)
    # A brass gauge hand sweeps a few pixels across the dial.
    angle = -1.9 + .8 * math.sin(phase * math.tau)
    ImageDraw.Draw(lights).line(((735, 202), (735 + int(12 * math.cos(angle)), 202 + int(12 * math.sin(angle)))),
                               fill=(67, 34, 23, 218), width=2)
    art.alpha_composite(lights)


def rain(pen, frame, count, seed, color, drift):
    rng = random.Random(seed)
    for _ in range(count):
        start_x, start_y = rng.randrange(800), rng.randrange(480) - 15
        speed, length, alpha = rng.choice((480, 960)), rng.randint(4, 12), rng.randint(28, 90)
        y = (start_y + speed * frame // WALL_FRAMES) % 480 - 15
        x = (start_x - drift * y // 8) % 800
        pen.line((x, y, x - drift, y + length), fill=(*color, alpha))


def ripples(pen, frame, seed, count, color):
    rng = random.Random(seed)
    for _ in range(count):
        x, y, offset = rng.randint(4, 792), rng.randint(366, 447), rng.randrange(24)
        phase = ((frame + offset) % 24) / 24
        radius = 2 + int(14 * phase)
        pen.arc((x - radius, y - radius // 4, x + radius, y + radius // 4), 18, 340,
                fill=(*color, int(105 * math.sin(math.pi * phase))))


def monolith(art, frame):
    layer = Image.new('RGBA', art.size)
    pen = ImageDraw.Draw(layer)
    rain(pen, frame, 185, 13, (167, 188, 204), 3)
    ripples(pen, frame, 136, 21, (162, 183, 204))
    # Distant occupied rooms and their subtle reflections under the overhang.
    for i, (x, y) in enumerate(((521, 55), (551, 63), (637, 245))):
        amount = max(0, math.sin(math.tau * frame / WALL_FRAMES + i * 1.8))
        glow(layer, (x, y, 7, 13), (255, 232, 178), 52 * amount)
    art.alpha_composite(layer)


def noodle_bar(art, frame):
    layer = Image.new('RGBA', art.size)
    pen = ImageDraw.Draw(layer)
    rain(pen, frame, 130, 9, (187, 152, 216), 2)
    ripples(pen, frame, 91, 16, (166, 101, 203))
    angle = math.tau * frame / WALL_FRAMES
    for i, lamp in enumerate(((454, 157, 62, 76), (546, 119, 19, 23), (603, 102, 21, 24), (663, 88, 20, 25))):
        glow(layer, lamp, (255, 128, 52), 18 + 23 * (.5 + .5 * math.sin(angle * 2 + i)))
    glow(layer, (728, 92, 54, 58), (229, 86, 255), 18 + 28 * (.5 + .5 * math.sin(angle)))
    # Three pixel-stepped wisps rise out of the bowl and fade at the top.
    for i in range(3):
        phase = ((frame + i * 16) % WALL_FRAMES) / WALL_FRAMES
        x = 661 + int(8 * math.sin(math.tau * phase + i))
        y = 263 - int(50 * phase)
        opacity = int(128 * math.sin(math.pi * phase))
        pen.line([(x, y), (x + 4, y - 4), (x + 5, y - 8), (x + 1, y - 13)], fill=(241, 169, 199, opacity), width=2)
    art.alpha_composite(layer)


MOTION = dict(zip(THEMES, (airship, monolith, noodle_bar), strict=True))


def stage_terminal_frames(terminal_pack, destination):
    frame_roles = {f'{level}_{state}' for level in LEVELS for state in STATES}
    with ZipFile(terminal_pack) as archive:
        layout = json.loads(archive.read('layout.json'))
        for member in archive.infolist():
            path = Path(member.filename)
            if path.name == member.filename and path.stem in frame_roles and path.suffix.lower() in IMAGE_EXTENSIONS:
                with (destination / path.name).open('xb') as target:
                    target.write(archive.read(member))
    return layout['apertures'], layout['controls']


def build(slug, source, output, terminal_pack):
    index, name, accent, edge, success, font, crop = THEMES[slug]
    profile, files = output / f'{slug}-profile', output / 'frames'
    profile.mkdir(parents=True)
    files.mkdir()
    assets = output / 'live-terminal-presets'
    assets.mkdir()
    with Image.open(source) as image:
        base = ImageOps.fit(image.convert('RGBA'), SIZE, Image.Resampling.LANCZOS)
    canvas = []
    for frame in range(WALL_FRAMES):
        still = base.copy()
        MOTION[slug](still, frame)
        canvas.append(still)
    avatar = [frame.crop(crop).resize((256, 256), NEAREST) for frame in canvas]
    clock_box = (360, crop[1] + 20, 800, crop[1] + 270)
    clock = [frame.crop(clock_box).resize((352, 200), NEAREST) for frame in canvas]
    wall_info, wallpaper_entries = {}, {}
    for slot, frames in (('canvas', canvas), ('avatar', avatar), ('clock', clock)):
        gif = output / f'{slot}.gif'
        wall_info[slot] = encode(frames, gif)
        package = profile / f'{slug}-{slot}.ctwallpaper'
        pack_wallpaper(gif, package, f'{name} · {slot}', *frames[0].size,
                       dict(fit='cover', x=50, y=50, dim=.42 if slot == 'clock' else 0, clockFont=font,
                            width=frames[0].width, height=frames[0].height, pixelated=True))
        wallpaper_entries[slot] = dict(file=package.name, sha256=hashlib.sha256(package.read_bytes()).hexdigest())
    encode([frame.resize((400, 225), NEAREST) for frame in canvas], files / 'background.gif')
    apertures, controls = stage_terminal_frames(terminal_pack, files)
    archive = assets / f'{slug}.zip'
    terminal_info = pack_terminal(files, archive, apertures, require_live=True, controls=controls)
    pack_id = f'pixel:92020000-0000-4000-8000-{index:012d}'
    write_json(output / 'verification.json', dict(wallpapers=wall_info, terminals=terminal_info))
    write_json(profile / 'preset.json', dict(
        schemaVersion=1, kind='canvastty-appearance-preset', id=f'{slug}-v1', name=name, version='1.0.0',
        terminals=dict(file=f'../live-terminal-presets/{archive.name}', id=pack_id, sha256=terminal_info['sha256']),
        apertures=apertures, wallpapers=wallpaper_entries, settings=dict(
            palette='night', appSkin='midnight', canvasColor='night', pattern='none', canvasBackgroundFit='cover',
            canvasBackgroundPaused=False, terminalBackground='none', terminalSkinDetail='detailed', homeClockFont=font,
            homeAccentPreset='custom', homeAccentColors=dict(clock=accent, launcher=edge, browser=success,
                                                             settings=accent, media=edge))))
    canvas[0].convert('RGB').resize((400, 225), Image.Resampling.LANCZOS).save(profile / 'preview.png', optimize=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('theme', choices=THEMES)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--terminal-pack', type=Path, help='Approved frame ZIP. Defaults to the built-in theme pack.')
    args = parser.parse_args()
    bundled = Path(__file__).resolve().parents[2] / 'assets' / 'live-terminal-presets' / f'{args.theme}.zip'
    build(args.theme, args.source, args.output, args.terminal_pack or bundled)
