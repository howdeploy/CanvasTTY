#!/usr/bin/env python3
"""Package a user's local media and framing recipe. Python standard library only."""
import argparse
import base64
import json
import math
from pathlib import Path
from media_probe import dimensions


def pack(source, output, name, width, height, recipe):
    dimensions(width, height)
    path = Path(source)
    if path.suffix.lower() not in ('.png', '.apng', '.gif', '.webp', '.mp4', '.webm'):
        raise ValueError('Supported: PNG/APNG, GIF, WebP, MP4, WebM')
    limit = 80 if path.suffix.lower() in ('.mp4', '.webm') else 20
    if not path.is_file() or not 0 < path.stat().st_size <= limit * 1024 * 1024:
        raise ValueError(f'Media must be a regular file <= {limit} MiB')
    if not name.strip() or len(name) > 100:
        raise ValueError('Name: 1–100 characters')
    if set(recipe) != {'fit', 'x', 'y', 'dim', 'clockFont', 'width', 'height', 'pixelated'}:
        raise ValueError('Invalid recipe fields')
    if type(recipe['pixelated']) is not bool or any(type(recipe[k]) not in (int, float) or not math.isfinite(recipe[k]) for k in ('x', 'y', 'dim')):
        raise ValueError('Recipe requires finite numbers and a boolean pixelated')
    if recipe['fit'] not in ('cover', 'contain') or not 0 <= recipe['x'] <= 100 or not 0 <= recipe['y'] <= 100:
        raise ValueError('Invalid framing')
    if not 0 <= recipe['dim'] <= .9 or recipe['clockFont'] not in ('mono', 'sans', 'serif', 'pixel'):
        raise ValueError('Invalid clock style')
    dimensions(recipe['width'], recipe['height'])
    payload = dict(schemaVersion=1, kind='canvastty-wallpaper', name=name.strip(), recipe=recipe,
                   source=dict(file='media' + path.suffix.lower(), width=width, height=height,
                               base64=base64.b64encode(path.read_bytes()).decode('ascii')))
    destination = Path(output)
    # Never replace an existing source or package silently.
    with destination.open('x', encoding='utf-8') as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    print(f'Created {destination} ({destination.stat().st_size} bytes). App import still needs decoding/preview.')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source'); p.add_argument('output'); p.add_argument('--name', required=True)
    p.add_argument('--source-width', type=int); p.add_argument('--source-height', type=int)
    p.add_argument('--verify', action='store_true', help='Decode image frames (Pillow) or inspect video (ffprobe), infer dimensions')
    p.add_argument('--require-live', action='store_true', help='Require distinct image frames and an infinite loop; implies --verify')
    p.add_argument('--width', type=int, default=1920); p.add_argument('--height', type=int, default=1080)
    p.add_argument('--fit', choices=['cover', 'contain'], default='cover')
    p.add_argument('--x', type=float, default=50); p.add_argument('--y', type=float, default=50)
    p.add_argument('--pixelated', action='store_true'); p.add_argument('--dim', type=float, default=.35)
    p.add_argument('--clock-font', choices=['mono', 'sans', 'serif', 'pixel'], default='mono')
    a = p.parse_args()
    if a.verify or a.require_live:
        from media_probe import probe
        info = probe(a.source, require_live=a.require_live)
        for given, actual in ((a.source_width, info['width']), (a.source_height, info['height'])):
            if given is not None and given != actual:
                p.error('Declared source dimensions do not match decoded media')
        a.source_width, a.source_height = info['width'], info['height']
    elif a.source_width is None or a.source_height is None:
        p.error('Use --verify, or provide both --source-width and --source-height for byte packaging only')
    pack(a.source, a.output, a.name, a.source_width, a.source_height,
         dict(fit=a.fit, x=a.x, y=a.y, width=a.width, height=a.height,
              pixelated=a.pixelated, clockFont=a.clock_font, dim=a.dim))


if __name__ == '__main__':
    main()
