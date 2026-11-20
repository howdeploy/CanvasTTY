#!/usr/bin/env python3
"""Animate supplied still art with a periodic masked glow. Local effect, not AI object animation."""
import argparse
import math
from pathlib import Path

from media_probe import dimensions, probe, write_json
from encode_animation import encode


def animate(source, output, seconds=3, fps=10, strength=.10, mask=None):
    from PIL import Image, ImageEnhance
    destination = Path(output)
    if destination.suffix.lower() not in ('.gif', '.apng', '.webp'):
        raise ValueError('Output must be GIF, APNG or WebP')
    if destination.exists():
        raise FileExistsError(destination)
    if fps not in (5, 10, 20) or type(seconds) not in (int, float) or not math.isfinite(seconds) or not 1 <= seconds <= 12:
        raise ValueError('Use 5/10/20 fps and 1–12 seconds')
    if type(strength) not in (int, float) or not math.isfinite(strength) or not .01 <= strength <= .18:
        raise ValueError('Glow strength must be 0.01–0.18')
    info = probe(source)
    if info.get('frames') != 1:
        raise ValueError('Use a still image as the source; existing animation must not be flattened')
    with Image.open(source) as image:
        art = image.convert('RGBA')
    dimensions(*art.size)
    count = round(seconds * fps)
    if art.width * art.height * count > 96_000_000:
        raise ValueError('Generation exceeds 96 MP; reduce duration, fps or artwork dimensions')
    if mask:
        with Image.open(mask) as image:
            if image.size != art.size or getattr(image, 'n_frames', 1) != 1:
                raise ValueError('Effect mask must be a still image of the same size as the art')
            effect_mask = image.convert('L')
    else:
        effect_mask = Image.new('L', art.size, 255)
    # Alpha is copied unchanged in every frame: the terminal opening never moves or fills in.
    alpha = art.getchannel('A')
    frames = []
    for index in range(count):
        exposure = 1 + strength * math.sin(2 * math.pi * index / count)
        shifted = ImageEnhance.Brightness(art.convert('RGB')).enhance(exposure).convert('RGBA')
        frame = Image.composite(shifted, art, effect_mask); frame.putalpha(alpha)
        frames.append(frame)
    result = encode(frames, destination, fps)
    result.update(generator='periodic-masked-glow-v1', sourceSha256=info['sha256'],
                  requestedFps=fps, strength=strength)
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source'); p.add_argument('output'); p.add_argument('--mask')
    p.add_argument('--seconds', type=float, default=3); p.add_argument('--fps', type=int, choices=[5, 10, 20], default=10)
    p.add_argument('--strength', type=float, default=.10); p.add_argument('--receipt')
    a = p.parse_args()
    if a.receipt and Path(a.receipt).exists():
        raise FileExistsError(a.receipt)
    result = animate(a.source, a.output, a.seconds, a.fps, a.strength, a.mask)
    if a.receipt:
        write_json(a.receipt, result)
    print(f"Created {a.output}: {result['frames']} decoded frames, {result['durationMs']} ms, {result['bytes']} bytes")


if __name__ == '__main__':
    main()
