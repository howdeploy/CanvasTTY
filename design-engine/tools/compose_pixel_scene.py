#!/usr/bin/env python3
"""Composite authored sprite frames on a fixed pixel grid. No warping, interpolation or global pulse."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw, ImageChops
from pixel_motion_layers import prepare_layers, apply_layers
from encode_animation import encode
from media_probe import write_json


def render_scene(config, root, phase=0):
    logical = tuple(config['logicalSize'])
    output = tuple(config['outputSize'])
    if any(type(x) is not int or x <= 0 for x in (*logical, *output)):
        raise ValueError('Positive integer scene dimensions required')
    if output[0] % logical[0] or output[1] % logical[1] or output[0] // logical[0] != output[1] // logical[1]:
        raise ValueError('Output must be a uniform integer pixel scale')
    with Image.open(root / config['base']) as image:
        base = ImageOps.fit(image.convert('RGBA'), logical, method=Image.Resampling.NEAREST)
    if 'aperture' in config:
        a = config['aperture']
        base.paste((0, 0, 0, 0), (round(logical[0]*a['left']/100), round(logical[1]*a['top']/100),
                                 round(logical[0]*(1-a['right']/100)), round(logical[1]*(1-a['bottom']/100))))
    with Image.open(root / config['atlas']) as image:
        atlas = image.convert('RGBA')
    columns, rows = config['atlasGrid']
    # Generated atlases can have odd dimensions; proportional cuts retain every pixel.
    if type(columns) is not int or type(rows) is not int or not 1 <= columns*rows <= 60 or columns < 1 or rows < 1:
        raise ValueError('Invalid atlas grid')
    poses = [atlas.crop((round(x*atlas.width/columns), round(y*atlas.height/rows),
                         round((x+1)*atlas.width/columns), round((y+1)*atlas.height/rows)))
             for y in range(rows) for x in range(columns)]
    count = config.get('frames', 32)
    if not 8 <= count <= 60 or output[0] * output[1] * count > 96_000_000:
        raise ValueError('Use 8–60 frames within the 96 MP budget')
    sprite_masks = []
    for sprite in config.get('sprites', []):
        x, y, w, h = sprite['rect']
        mask = Image.new('L', (w, h), 255)
        if sprite.get('hotOnly', False):
            mask.putdata([255 if a and r > 140 and r > g*1.14 and g > b*1.3 else 0
                          for r, g, b, a in base.crop((x, y, x+w, y+h)).getdata()])
        draw = ImageDraw.Draw(mask)
        for ex, ey, ew, eh in sprite.get('excludeRects', []):
            draw.rectangle((ex-x, ey-y, ex+ew-1-x, ey+eh-1-y), fill=0)
        sprite_masks.append(mask)
    prepared = prepare_layers(base, config)
    frames = []
    # Every frame starts from the SAME base. Only explicit local sprite cells change.
    for index in range(count):
        frame = base.copy()
        apply_layers(frame, base, prepared, config, index, phase)
        for sprite, mask in zip(config.get('sprites', []), sprite_masks):
            x, y, w, h = sprite['rect']
            pose = (index // sprite.get('hold', 4) + phase + sprite.get('phase', 0)) % len(poses)
            stamp = poses[pose].resize((w, h), Image.Resampling.NEAREST)
            stamp.putalpha(ImageChops.multiply(stamp.getchannel('A'), mask))
            frame.alpha_composite(stamp, (x, y))
        draw = ImageDraw.Draw(frame)
        for particle in config.get('embers', []):
            # Authored integer path, discrete dim/orange/gold palette. No sinusoid.
            path = particle['path']
            point = path[(index // particle.get('hold', 2) + phase + particle.get('phase', 0)) % len(path)]
            if point is not None:
                x, y = point
                draw.rectangle((x, y, x+1, y+1), fill=tuple(particle.get('color', [240, 149, 47, 255])))
        # Skin effects never add alpha outside the supplied irregular silhouette or in the text opening.
        if config.get('preserveAlpha', False):
            frame.putalpha(base.getchannel('A'))
        frames.append(frame.resize(output, Image.Resampling.NEAREST))
    return frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scene'); parser.add_argument('output'); parser.add_argument('--receipt')
    args = parser.parse_args()
    path = Path(args.scene)
    config = json.loads(path.read_text())
    result = encode(render_scene(config, path.parent), args.output, config.get('fps', 5))
    result['method'] = 'authored sprite poses; fixed pixel grid; nearest-neighbor integer scale'
    if args.receipt:
        write_json(args.receipt, result)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
