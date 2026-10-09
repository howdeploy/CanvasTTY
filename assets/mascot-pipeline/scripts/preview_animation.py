"""Create a contact sheet and timed demonstration from the current built atlases.

Usage: python preview_animation.py path/to/character.json --action wave
The demonstration includes idle, entry, repeated main cycles and exit. Looping the
demonstration repeats its entrance; the live player's selected mode does not.
"""

import argparse
import json
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw

from build_sprite import load_config
from finalize_mascot import verify_build


def main(config_path, action, cycles=2, height=520):
    config_path = Path(config_path).resolve()
    config = load_config(config_path)
    report = verify_build(config_path)
    plugin = Path(config['plugin_dir'])
    text = (plugin / 'frames.js').read_text(encoding='utf-8').strip()
    sprite = json.loads(text.removeprefix('window.SPRITE = ').removesuffix(';'))
    if action not in sprite['deck'] or action not in sprite['clips']:
        raise ValueError('action must be an existing selectable action')
    if cycles < 1 or height < 32:
        raise ValueError('cycles must be positive and preview height at least 32')
    clips = sprite['clips']
    phases = [('idle', clips.get('idle', [])), ('entry', clips.get(f'{action}:in', []))]
    phases.extend((f'loop {i + 1}', clips[action]) for i in range(cycles))
    phases.extend([('exit', clips.get(f'{action}:out', [])), ('idle', clips.get('idle', []))])
    cw, ch = sprite['cell']
    display_size = (max(1, round(cw * height / ch)), height)
    atlases, frames, thumbnails, durations = {}, [], [], []
    for phase, sequence in phases:
        for index, seconds in sequence:
            sheet, local = divmod(index, sprite['perSheet'])
            if sheet not in atlases:
                atlases[sheet] = Image.open(plugin / sprite['sheets'][sheet]['file']).convert('RGBA')
            x, y = local % sprite['cols'] * cw, local // sprite['cols'] * ch
            frame = atlases[sheet].crop((x, y, x + cw, y + ch))
            frame = frame.convert('RGBa').resize(display_size, Image.Resampling.LANCZOS).convert('RGBA')
            frames.append(frame)
            durations.append(max(1, round(seconds * 1000)))
            if not phase.startswith('loop ') or phase == 'loop 1':
                tile = Image.new('RGBA', frame.size, (60, 55, 72, 255))
                tile.alpha_composite(frame)
                tile = tile.convert('RGB')
                tile.thumbnail((160, 220))
                labeled = Image.new('RGB', (tile.width, tile.height + 66), (30, 28, 36))
                labeled.paste(tile, (0, 66))
                name = sprite.get('frameNames', [str(i) for i in range(len(report['frames']))])[index]
                label = f'{phase} / cell {index} / {seconds:.2f}s\n' + '\n'.join(textwrap.wrap(name, 23))
                ImageDraw.Draw(labeled).text((3, 3), label, fill='white')
                thumbnails.append(labeled)
    destination = config_path.parent / 'previews'
    destination.mkdir(exist_ok=True)
    animated = destination / f'{action}.webp'
    frames[0].save(animated, save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, lossless=True, method=4)
    columns = min(6, len(thumbnails))
    cell_w = max(tile.width for tile in thumbnails)
    cell_h = max(tile.height for tile in thumbnails)
    sheet = Image.new('RGB', (columns * cell_w, 36 + ((len(thumbnails) + columns - 1) // columns) * cell_h), (30, 28, 36))
    ImageDraw.Draw(sheet).text((3, 3), f'Build {report["build_id"]} / {action}\nOrdered atlas cells at one shared scale', fill='white')
    for index, tile in enumerate(thumbnails):
        sheet.paste(tile, (index % columns * cell_w, 36 + index // columns * cell_h))
    contact = destination / f'{action}-sheet.png'
    sheet.save(contact)
    print(f'Build {report["build_id"]}; action {action}; {len(frames)} demo steps; {sum(durations) / 1000:.3f}s')
    scene = [step for key in (f'{action}:in', action, f'{action}:out') for step in clips.get(key, [])]
    print(f'Whole-scene unique drawings: {len({step[0] for step in scene})}')
    for key in (f'{action}:in', action, f'{action}:out'):
        print(f'{key}: {report["clips"].get(key, {"unique_drawings": 0, "playback_steps": 0, "seconds": 0})}')
    print(f'Animated preview: {animated}')
    print(f'Contact sheet: {contact}')
    print('This finite demo repeats entry and exit when its file loops. Verify live menu switching separately.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config')
    parser.add_argument('--action', required=True)
    parser.add_argument('--cycles', type=int, default=2)
    parser.add_argument('--height', type=int, default=520)
    args = parser.parse_args()
    main(args.config, args.action, args.cycles, args.height)
