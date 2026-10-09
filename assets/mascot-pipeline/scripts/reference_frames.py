"""Extract original-sized motion examples from the bundled reference atlases.

Usage: python reference_frames.py --set set-a --action smoke --output PROJECT/motion-reference
The output is motion evidence, never the new mascot's identity reference.
"""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw


def main(set_name, action, output):
    root = Path(__file__).resolve().parent.parent / 'examples' / 'motion-library'
    source = root / set_name
    if source.resolve().parent != root.resolve():
        raise ValueError('invalid reference set')
    data = json.loads((source / 'motion.json').read_text(encoding='utf-8'))
    if action not in data['clips']:
        raise ValueError(f'unknown action; available: {list(data["clips"])}')
    output = Path(output)
    if output.exists() and any(output.iterdir()):
        raise ValueError('choose an empty output directory to preserve existing references')
    output.mkdir(parents=True, exist_ok=True)
    cw, ch = data['cell']
    atlases, thumbnails = {}, []
    sequence = data['clips'][action]
    for index, seconds in sequence:
        sheet, local = divmod(index, data['perSheet'])
        if sheet not in atlases:
            atlases[sheet] = Image.open(source / data['sheets'][sheet]['file']).convert('RGBA')
        x, y = local % data['cols'] * cw, local // data['cols'] * ch
        frame = atlases[sheet].crop((x, y, x + cw, y + ch))
        frame.save(output / f'frame-{index:03d}.png')
        tile = Image.new('RGBA', frame.size, (65, 62, 72, 255))
        tile.alpha_composite(frame)
        tile = tile.convert('RGB')
        tile.thumbnail((180, 260))
        ImageDraw.Draw(tile).text((4, 4), f'{index} / {seconds:g}s', fill='white')
        thumbnails.append(tile)
    cols = min(6, len(thumbnails))
    width, height = max(t.width for t in thumbnails), max(t.height for t in thumbnails)
    contact = Image.new('RGB', (cols * width, ((len(thumbnails) + cols - 1) // cols) * height), (30, 28, 36))
    for i, tile in enumerate(thumbnails):
        contact.paste(tile, (i % cols * width, i // cols * height))
    contact.save(output / 'sequence.jpg', quality=95)
    (output / 'timing.json').write_text(json.dumps(sequence, indent=2) + '\n', encoding='utf-8')
    print(f'{set_name}/{action}: {len(set(i for i, _ in sequence))} unique drawings, '
          f'{len(sequence)} steps, {sum(t for _, t in sequence):.3f}s')
    print(output / 'sequence.jpg')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--set', required=True)
    parser.add_argument('--action', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    main(args.set, args.action, args.output)
