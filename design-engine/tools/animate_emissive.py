#!/usr/bin/env python3
"""Local looping heat/flow/sparks animation over authored art. No model or network calls."""
import argparse
import json
import math
from pathlib import Path

from media_probe import aperture_box, probe, write_json
from encode_animation import encode


def render_frames(source, count=20, state='working', aperture=None, seed=15):
    import numpy as np
    from PIL import Image, ImageDraw
    if type(count) is not int or not 8 <= count <= 60 or state not in ('idle', 'working', 'completed'):
        raise ValueError('Use 8–60 frames and idle/working/completed')
    info = probe(source)
    if info.get('frames') != 1:
        raise ValueError('Source must be a still image; do not flatten authored animation')
    if info['width'] * info['height'] * count > 96_000_000:
        raise ValueError('Animation exceeds the 96 MP encoding budget')
    with Image.open(source) as image:
        original = image.convert('RGBA')
    if aperture:
        # Technical cutout, not art generation: make the declared terminal opening exact.
        box = aperture_box(aperture, original.size)
        original.paste((0, 0, 0, 0), box)
    pixels = np.asarray(original).copy()
    rgb = pixels[:, :, :3].astype(np.float32)
    alpha = pixels[:, :, 3]
    height, width = alpha.shape
    yy, xx = np.mgrid[:height, :width].astype(np.float32)
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    # Only orange/yellow fire and lava pixels move. Purple masonry and gear stay still.
    heat = np.clip((red - 115) / 75, 0, 1) * np.clip((red - blue - 55) / 90, 0, 1)
    heat *= np.clip((green - 45) / 85, 0, 1) * (alpha > 100)
    sources = np.argwhere((heat > .65) & (green > 100))
    rng = np.random.default_rng(seed)
    amount = {'idle': 40, 'working': 120, 'completed': 65}[state]
    particles = []
    if len(sources):
        for index in rng.choice(len(sources), amount):
            y, x = sources[index]
            particles.append((float(x), float(y), rng.random(), rng.uniform(height * .06, height * .19), rng.uniform(-width * .018, width * .018)))
    strength = {'idle': .70, 'working': 1.08, 'completed': .94}[state]
    frames = []
    for index in range(count):
        phase = index * math.tau / count
        # Advect detailed hot texture and travelling bright ribbons, rather than
        # barely pulsing an otherwise static image. All fields are periodic.
        dx = np.rint(5 * np.sin(2 * phase + yy / 19)).astype(np.int32)
        dy = np.rint(11 * np.cos(phase + xx / 31)).astype(np.int32)
        moved = rgb[np.clip(yy.astype(np.int32) + dy, 0, height - 1), np.clip(xx.astype(np.int32) + dx, 0, width - 1)]
        flow = rgb * .25 + moved * .75
        pulse = 1 + .24 * np.sin(3 * phase - yy / 15 + .7 * np.sin(xx / 21)) + .12 * np.sin(2 * phase + xx / 35 - yy / 29)
        flow *= (strength * pulse)[:, :, None]
        if state == 'completed':
            flow[:, :, 1] *= 1.12  # Resolved warm-gold furnace, no alien green status art.
        value = np.clip(rgb * (1 - heat[:, :, None]) + flow * heat[:, :, None], 0, 255).astype(np.uint8)
        rgba = np.dstack([value, alpha])
        frame = Image.fromarray(rgba)
        draw = ImageDraw.Draw(frame)
        for x, y, offset, rise, drift in particles:
            progress = (index / count + offset) % 1
            fade = math.sin(math.pi * progress) ** 2
            px, py = round(x + drift * math.sin(math.tau * progress)), round(y - rise * progress)
            if not (0 <= px < width and 0 <= py < height) or alpha[py, px] < 128 or fade < .15:
                continue
            # Fade in/out at the reset so the loop boundary has no pop.
            base = value[py, px]
            spark = tuple(int(base[c] * (1-fade) + (255, 190, 65)[c] * fade) for c in range(3)) + (int(alpha[py, px]),)
            draw.point((px, py), fill=spark)
            radius = max(1, round(width / 850))
            for ox, oy in [(1,0),(0,1),(0,-1),(-1,0),(0,-2),(0,-3)][:2 + radius * 2]:
                sx, sy = px + ox, py + oy
                if 0 <= sx < width and 0 <= sy < height and alpha[sy,sx] > 128:
                    draw.point((sx, sy), fill=spark)
        frames.append(frame)
    return frames, info


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source'); p.add_argument('output'); p.add_argument('--frames', type=int, default=20)
    p.add_argument('--fps', type=int, choices=[5, 10, 20], default=10)
    p.add_argument('--state', choices=['idle', 'working', 'completed'], default='working')
    p.add_argument('--seed', type=int, default=15); p.add_argument('--aperture', help='JSON file with left/right/top/bottom percentages')
    p.add_argument('--receipt')
    a = p.parse_args()
    if a.receipt and Path(a.receipt).exists():
        raise FileExistsError(a.receipt)
    aperture = json.loads(Path(a.aperture).read_text()) if a.aperture else None
    frames, source = render_frames(a.source, a.frames, a.state, aperture, a.seed)
    result = encode(frames, a.output, a.fps)
    if aperture:
        probe(a.output, require_live=True, aperture=aperture)
    result.update(effect='emissive-flow-v2', state=a.state, sourceSha256=source['sha256'], seed=a.seed,
                  provenance='AI/provider art supplied separately; local procedural motion, not model-generated video')
    if a.receipt:
        write_json(a.receipt, result)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
