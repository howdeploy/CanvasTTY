#!/usr/bin/env python3
"""Assemble real authored frames into a looping GIF/APNG/WebP; no model or network calls."""
import argparse
import io
from pathlib import Path
import re

from media_probe import dimensions, probe, write_json


def encode(frames, output, fps=10):
    from PIL import Image
    destination = Path(output)
    suffix = destination.suffix.lower()
    if destination.exists():
        raise FileExistsError(destination)
    if suffix not in ('.gif', '.apng', '.webp') or fps not in (5, 10, 20):
        raise ValueError('Use GIF/APNG/WebP at 5/10/20 fps')
    if len(frames) < 2 or any(frame.size != frames[0].size for frame in frames):
        raise ValueError('At least two equally sized frames are required')
    dimensions(*frames[0].size)
    if frames[0].width * frames[0].height * len(frames) > 96_000_000:
        raise ValueError('Animation exceeds the 96 MP encoding budget')
    rendered = []
    palette = None
    if suffix == '.gif':
        # One palette for the entire loop prevents stationary art from shimmering as
        # independently quantized frames choose different colors. Sample all phases.
        samples = Image.new('RGB', (192, 128 * len(frames)))
        for index, frame in enumerate(frames):
            samples.paste(frame.convert('RGB').resize((192, 128), Image.Resampling.NEAREST), (0, index * 128))
        palette = samples.quantize(colors=255)
        colors = palette.getpalette()
        colors = colors[:765] + colors[:3]
        palette.putpalette(colors)
    for frame in frames:
        frame = frame.convert('RGBA')
        if suffix == '.gif':
            # Reserve palette index 255 for transparency. Soft alpha requires APNG/WebP.
            alpha = frame.getchannel('A')
            paletted = frame.convert('RGB').quantize(palette=palette, dither=Image.Dither.NONE)
            paletted = paletted.point(lambda index: 0 if index == 255 else index)
            paletted.paste(255, mask=alpha.point(lambda a: 255 if a < 128 else 0))
            paletted.info['transparency'] = 255
            rendered.append(paletted)
        else:
            rendered.append(frame)
    buffer = io.BytesIO()
    options = dict(save_all=True, append_images=rendered[1:], duration=1000 // fps, loop=0)
    if suffix == '.gif':
        # Keep the previous frame only when the alpha mask is identical. Pillow can
        # then encode unchanged pixels as transparent deltas, without ghost trails.
        mask = rendered[0].point(lambda index: 255 if index == 255 else 0).tobytes()
        stable_alpha = all(frame.point(lambda index: 255 if index == 255 else 0).tobytes() == mask for frame in rendered[1:])
        rendered[0].save(buffer, format='GIF', transparency=255, disposal=1 if stable_alpha else 2,
                         optimize=stable_alpha, **options)
    elif suffix == '.apng':
        rendered[0].save(buffer, format='PNG', disposal=0, blend=0, **options)
    else:
        rendered[0].save(buffer, format='WEBP', lossless=True, method=4, **options)
    if buffer.tell() > 20 * 1024 * 1024:
        raise ValueError('Encoded image exceeds 20 MiB')
    with destination.open('xb') as stream:
        stream.write(buffer.getvalue())
    try:
        return probe(destination, require_live=True)
    except Exception:
        destination.unlink()
        raise


def load_frames(source, columns=None, rows=None, count=None):
    from PIL import Image
    path = Path(source)
    if path.is_dir():
        if any(value is not None for value in (columns, rows, count)):
            raise ValueError('Grid arguments apply only to a sprite sheet')
        files = sorted(path.iterdir())
        if not files or any(not p.is_file() or not re.fullmatch(r'frame-\d{4}\.png', p.name) for p in files):
            raise ValueError('Directory must contain only frame-0000.png, frame-0001.png, ...')
        if [p.name for p in files] != [f'frame-{i:04}.png' for i in range(len(files))]:
            raise ValueError('Frame numbering must start at zero without gaps')
        frames = []
        pixels = 0
        for file in files:
            with Image.open(file) as image:
                dimensions(*image.size)
                pixels += image.width * image.height
                if pixels > 96_000_000 or getattr(image, 'n_frames', 1) != 1 or image.format != 'PNG':
                    raise ValueError('Use still PNG frames, at most 96 MP total')
                frames.append(image.convert('RGBA'))
        return frames
    if any(type(value) is not int or value <= 0 for value in (columns, rows)):
        raise ValueError('Sprite sheet requires positive --columns and --rows')
    if count is None:
        count = columns * rows
    if type(count) is not int or not 2 <= count <= columns * rows:
        raise ValueError('Invalid sprite frame count')
    with Image.open(path) as image:
        dimensions(*image.size)
        if image.width % columns or image.height % rows or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('Still sprite sheet dimensions must divide evenly by the grid')
        w, h = image.width // columns, image.height // rows
        if not w or not h:
            raise ValueError('Empty sprite cells')
        return [image.crop((i % columns * w, i // columns * h, (i % columns + 1) * w, (i // columns + 1) * h)).convert('RGBA') for i in range(count)]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source'); p.add_argument('output'); p.add_argument('--columns', type=int)
    p.add_argument('--rows', type=int); p.add_argument('--count', type=int)
    p.add_argument('--fps', type=int, choices=[5, 10, 20], default=10); p.add_argument('--receipt')
    a = p.parse_args()
    if a.receipt and Path(a.receipt).exists():
        raise FileExistsError(a.receipt)
    info = encode(load_frames(a.source, a.columns, a.rows, a.count), a.output, a.fps)
    if a.receipt:
        write_json(a.receipt, info)
    print(f"Created {a.output}: {info['frames']} decoded frames, {info['durationMs']} ms, {info['bytes']} bytes")


if __name__ == '__main__':
    main()
