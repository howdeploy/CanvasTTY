#!/usr/bin/env python3
"""Build a built-in live theme from its original illustration and localized motion."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo

from encode_animation import encode
from media_probe import write_json
from pack_wallpaper import pack as pack_wallpaper
from theme_scenes import FRAMES, CROPS, Painting
from PIL import Image


def build(slug, source_art, output, assets, terminal_pack=None):
    original = assets / f'{slug}-profile'
    manifest = json.loads((original / 'preset.json').read_text())
    profile = output / original.name
    profile.mkdir(parents=True)
    painting = Painting(slug, source_art)
    def crop(image, box, size):
        return image.crop(tuple(round(k*painting.scale) for k in box)).resize(size, Image.Resampling.LANCZOS)
    avatar, clock = CROPS[slug]
    canvas = [painting.render(frame) for frame in range(FRAMES)]
    slots = (
        ('canvas', canvas),
        ('avatar', [crop(image, avatar, (320, 320)) for image in canvas]),
        ('clock', [crop(image, clock, (480, 270)) for image in canvas]),
    )
    wallpapers = {}
    for slot, images in slots:
        gif = output / (f'{slot}.webp' if slot == 'canvas' else f'{slot}.gif')
        wallpapers[slot] = encode(images, gif)
        entry = manifest['wallpapers'][slot]
        package = profile / entry['file']
        source = json.loads((original / entry['file']).read_text())
        width, height = images[0].size
        recipe = dict(source['recipe'], width=width, height=height, pixelated=False, fit="cover")
        if slot == "canvas":
            # Reserve the focal subject (or impact area) inside the ultrawide crop.
            recipe.update({"kisa-nocturne": dict(x=55, y=50, dim=0),
                           "steampunk-airship": dict(y=25),
                           "brutalist-monolith": dict(y=75),
                           "cyberpunk-noodle-bar": dict(y=42)}[slug])
        pack_wallpaper(gif, package, source['name'], width, height, recipe)
        entry['sha256'] = hashlib.sha256(package.read_bytes()).hexdigest()

    # The same canvas is also offered by the built-in pixel pack in Canvas background
    # settings. Keep all terminal frames and their layout verbatim.
    manifest['settings']['canvasBackgroundFit'] = 'cover'
    archive = output / 'live-terminal-presets' / (slug + '.zip')
    archive.parent.mkdir()
    with ZipFile(terminal_pack or assets / 'live-terminal-presets' / archive.name) as source, ZipFile(archive, 'x') as target:
        background = next(name for name in source.namelist() if Path(name).stem == 'background')
        for entry in source.infolist():
            if entry.filename == background:
                replacement = ZipInfo('background.webp', entry.date_time)
                replacement.external_attr = entry.external_attr
                target.writestr(replacement, (output / 'canvas.webp').read_bytes())
            else:
                target.writestr(entry, source.read(entry))
    manifest['terminals']['sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
    write_json(profile / 'preset.json', manifest)
    write_json(output / 'verification.json', wallpapers)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('theme', choices=CROPS)
    parser.add_argument('source', type=Path, nargs='?', help='Optional registered clean plate')
    parser.add_argument('output', type=Path)
    parser.add_argument('--terminal-pack', type=Path)
    args = parser.parse_args()
    engine = Path(__file__).resolve().parents[1]
    source = args.source or engine / 'art' / 'clean-plates' / (args.theme + '.png')
    build(args.theme, source, args.output, engine.parent / 'assets', args.terminal_pack)
