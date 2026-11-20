#!/usr/bin/env python3
"""Create a seeded pixel sky PNG or seamless animated GIF. Requires Pillow, no model/API."""
import argparse
import math
import random
from pathlib import Path
from PIL import Image, ImageDraw

PALETTES = {'night': ('#101827', '#253251', '#49628a', '#a4dde6'),
            'forest': ('#102c2c', '#1b4b40', '#39765d', '#c3d995'),
            'sunset': ('#361d47', '#71385b', '#bd6268', '#ffce99')}


def generate(output, width=960, height=320, seed=42, palette='night', animated=True):
    if not 16 <= width <= 4096 or not 16 <= height <= 4096 or width * height > 8_000_000:
        raise ValueError('Generator canvas must be 16–4096 px per side, up to 8 MP')
    destination = Path(output)
    if destination.exists():
        raise FileExistsError(destination)
    if animated and width * height * 24 > 60_000_000:
        raise ValueError('Animated generator: use a smaller canvas (e.g. 960 × 320)')
    if destination.suffix.lower() != ('.gif' if animated else '.png'):
        raise ValueError('Use .gif for animation or .png with --still')
    rng = random.Random(seed)
    w, h = max(16, width // 4), max(16, height // 4)
    colors = PALETTES[palette]
    stars = [(rng.randrange(w), rng.randrange(max(1, h // 2)), rng.random() * math.tau) for _ in range(60)]
    hills = []
    for layer in range(3):
        y = h * (.50 + layer * .12)
        ridge = []
        for x in range(0, w, 2):
            y = max(h * .4, min(h * .9, y + rng.uniform(-2, 2)))
            ridge.append((x, int(y)))
        hills.append(ridge)
    frames = []
    for i in range(24 if animated else 1):
        phase = i * math.tau / 24
        image = Image.new('RGB', (w, h), colors[0]); draw = ImageDraw.Draw(image)
        for x, y, offset in stars:
            # A gentle, periodic intensity change; no abrupt blinking.
            strength = .75 + .15 * math.sin(phase + offset)
            rgb = tuple(int(int(colors[3][j:j+2], 16) * strength) for j in (1, 3, 5))
            draw.point((x, y), fill=rgb)
        draw.rectangle((int(w*.76), int(h*.14), int(w*.76)+7, int(h*.14)+7), fill=colors[3])
        for layer, ridge in enumerate(hills):
            draw.polygon(ridge + [(w, h), (0, h)], fill=colors[layer + 1 if layer < 2 else 0])
        # Leave the central clock area quiet and free of baked-in digits.
        frames.append(image.resize((width, height), Image.Resampling.NEAREST))
    if animated:
        frames[0].save(destination, save_all=True, append_images=frames[1:], duration=125, loop=0, optimize=False, disposal=2)
    else:
        frames[0].save(destination)
    print(f'Created {destination}: {width}x{height}, seed={seed}, frames={len(frames)}')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('output'); p.add_argument('--width', type=int, default=960); p.add_argument('--height', type=int, default=320)
    p.add_argument('--seed', type=int, default=42); p.add_argument('--palette', choices=PALETTES, default='night'); p.add_argument('--still', action='store_true')
    a = p.parse_args(); generate(a.output, a.width, a.height, a.seed, a.palette, not a.still)
