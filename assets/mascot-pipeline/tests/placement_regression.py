"""Distinguish placement drift from unchanged-source translation using real art."""
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent.parent / 'examples'
case = json.loads((root / 'placement-regression/case.json').read_text())
paths = {'aligned': root / 'motion-library/set-c/atlas-0.webp',
         'unaligned': root / 'placement-regression/unaligned.webp'}
rows = {}
cw, ch = case['cell']
for kind, path in paths.items():
    assert hashlib.sha256(path.read_bytes()).hexdigest() == case[f'{kind}_sha256']
    atlas = Image.open(path).convert('RGBA')
    rows[kind] = []
    for record in case['regions']:
        i = record['index']
        x, y = i % case['cols'] * cw, i // case['cols'] * ch
        cell = atlas.crop((x, y, x + cw, y + ch))
        left, top, right, bottom = record[f'{kind}_region']
        alpha = np.asarray(cell.getchannel('A'))[top:bottom, left:right]
        visible = np.where(alpha > case['alpha_threshold'])[0]
        assert len(visible), f'no visible footwear at cell {i}'
        rows[kind].append(int(visible.max() + top))
assert max(rows['aligned']) - min(rows['aligned']) <= case['aligned_max_range_px']
assert max(rows['unaligned']) - min(rows['unaligned']) >= case['unaligned_min_range_px']
assert rows['aligned'] != rows['unaligned']
print(f'Placement regression passed: aligned rows {min(rows["aligned"])}–{max(rows["aligned"])}; '
      f'unaligned rows {min(rows["unaligned"])}–{max(rows["unaligned"])}. Artistic review remains separate.')
