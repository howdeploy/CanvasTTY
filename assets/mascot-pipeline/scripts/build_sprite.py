"""Build sprite sheets and animation data for a CanvasTTY mascot plugin.

Usage: python build_sprite.py path/to/character.json
Paths in character.json are relative to that file. Run qa_frames.py first.
"""
import json
import hashlib
import math
import os
import re
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def load_config(path):
    with open(path, encoding='utf-8') as f:
        c = json.load(f)
    root = Path(path).resolve().parent
    for key in ('frames_dir', 'plugin_dir'):
        if key not in c:
            raise ValueError(f'missing {key} in {path}')
        c[key] = str((root / c[key]).resolve())
    c.setdefault('scale', 1)
    c.setdefault('cols', 6)
    c.setdefault('pad_bottom', 48)
    c.setdefault('margin_x', 40)
    c.setdefault('shadow', False)
    c.setdefault('transition_sec', 0.18)
    c.setdefault('airborne', [])
    c.setdefault('ground_anchors', {})
    if not c.get('clips'):
        raise ValueError('character.json needs at least one clip')
    for key in ('scale', 'cols', 'rows_per_sheet'):
        value = c.get(key, 5)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f'{key} must be a positive integer')
    return c


def expand(seq):
    """Clip entries are [frame, seconds] or {"seq": [[frame, seconds], ...], "times": n}."""
    out = []
    for item in seq:
        if isinstance(item, dict):
            times = item.get('times', 1)
            if not isinstance(times, int) or isinstance(times, bool) or times < 1:
                raise ValueError('sequence times must be a positive integer')
            out += expand(item['seq']) * times
        else:
            name, duration = item[0], float(item[1])
            if not re.fullmatch(r'[a-z0-9][a-z0-9._-]*', name) or not math.isfinite(duration) or duration <= 0:
                raise ValueError(f'invalid frame name or duration: {item}')
            out.append((name, duration))
    return out


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def frame_path(directory, name):
    for suffix in ('-fixed.png', '.png'):
        path = Path(directory) / f'{name}{suffix}'
        if path.is_file():
            return path
    return None


def resolve_clips(c):
    """QA, build and handoff must refer to the same explicit and legacy clips."""
    clips = {name: expand(seq) for name, seq in c['clips'].items()}
    breath = c.get('breath')
    if breath:
        frames = [(n, float(breath.get('sec', 0.45))) for n in breath['frames']]
        half = len(frames) // 2
        blink = [(breath['blink'], 0.12)] if breath.get('blink') else []
        clips['idle'] = expand(frames[:half] + blink + frames[half:])
    elif c.get('idle'):
        clips['idle'] = expand(c['idle'])
    for action in list(clips):
        if action != 'idle' and ':' not in action:
            for suffix, prefix in (('in', 'to'), ('out', 'from')):
                name = f'{prefix}-{action}'
                if frame_path(c['frames_dir'], name):
                    clips.setdefault(f'{action}:{suffix}', expand([[name, c['transition_sec']]]))
    if any(not sequence for sequence in clips.values()):
        raise ValueError('every clip must contain at least one frame')
    return clips


def main(cfg_path):
    c = load_config(cfg_path)
    frames_dir, plugin_dir = c['frames_dir'], c['plugin_dir']
    if not os.path.isdir(frames_dir):
        raise ValueError(f'frames directory does not exist: {frames_dir}')
    if os.path.exists(plugin_dir) and os.path.samefile(frames_dir, plugin_dir):
        raise ValueError('frames_dir and plugin_dir must differ')

    def path_of(name):
        return frame_path(frames_dir, name)

    def read(name):
        # Soft effects and green artwork are data, not a guessed background.
        return np.asarray(Image.open(path_of(name)).convert('RGBA')).copy()

    # ---- clips ----
    clips = resolve_clips(c)
    unknown = set(c.get('deck', [])) - set(clips)
    if unknown:
        raise ValueError('deck refers to unknown actions: ' + ', '.join(sorted(unknown)))

    names, missing = [], []
    for seq in clips.values():
        for n, _ in seq:
            if path_of(n):
                if n not in names:
                    names.append(n)
            elif n not in missing:
                missing.append(n)
    if missing:
        raise ValueError('missing frames: ' + ', '.join(missing))
    if not names:
        raise ValueError('no frames found in ' + frames_dir)

    # ---- floor line from the base frame ----
    base = c.get('floor_frame') or names[0]
    if not path_of(base):
        raise ValueError(f'floor_frame is missing: {base}')
    base_pixels = read(base)
    if not np.any(base_pixels[..., 3]):
        raise ValueError(f'floor_frame is empty: {base}')
    floor = c.get('floor_y', int(np.where(base_pixels[..., 3] > 0)[0].max()))
    if not isinstance(floor, int) or not 0 <= floor < base_pixels.shape[0]:
        raise ValueError('floor_y must be a row inside the source canvas')
    if c['ground_anchors'] and 'floor_y' not in c:
        raise ValueError('explicit ground_anchors require an explicit floor_y')
    unknown_anchors = set(c['ground_anchors']) - set(names)
    if unknown_anchors:
        raise ValueError('ground_anchors refer to unused frames: ' + ', '.join(sorted(unknown_anchors)))

    raw, placements = {}, {}
    base_shape = base_pixels.shape
    for n in names:
        a = read(n)
        if a.shape != base_shape:
            raise ValueError(f'{n} has size {a.shape[1]}x{a.shape[0]}; expected {base_shape[1]}x{base_shape[0]}')
        if not np.any(a[..., 3]):
            raise ValueError(f'{n} is empty')
        if np.all(a[..., 3] > 0):
            raise ValueError(f'{n} has no fully transparent background pixels')
        shift = 0
        if n in c['ground_anchors'] and n not in c['airborne']:
            anchor = c['ground_anchors'][n]
            if not isinstance(anchor, int) or not 0 <= anchor < len(a):
                raise ValueError(f'invalid ground anchor for {n}')
            shift = floor - anchor
            visible_y = np.where(a[..., 3] > 0)[0]
            if visible_y.min() + shift < 0 or visible_y.max() + shift >= len(a):
                raise ValueError(f'ground translation clips visible art: {n}')
            moved = np.zeros_like(a)
            if shift >= 0:
                moved[shift:] = a[:len(a) - shift]
            else:
                moved[:shift] = a[-shift:]
            a = moved
        placements[n] = {'source': path_of(n).name, 'anchor': c['ground_anchors'].get(n),
                         'shift_y': shift, 'airborne': n in c['airborne']}
        raw[n] = np.vstack([a, np.zeros((c['pad_bottom'], a.shape[1], 4), np.uint8)])

    xs = np.concatenate([np.where(f[..., 3].any(0))[0] for f in raw.values()])
    width = next(iter(raw.values())).shape[1]
    x0 = max(0, xs.min() - c['margin_x']); x1 = min(width, xs.max() + 1 + c['margin_x'])
    s = c['scale']

    def with_shadow(a):
        img = Image.fromarray(a)
        if not c['shadow']:
            return img
        ys, cols = np.where(a[..., 3] > 0)
        lift = max(0, floor - ys.max())                              # how high the feet are above the floor
        feet = cols[ys > ys.max() - 60]
        cx = (feet.min() + feet.max()) / 2
        w = (feet.max() - feet.min()) * 1.15 * max(0.45, 1 - lift / 500)
        alpha = int(110 * max(0.3, 1 - lift / 400))
        layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse([cx - w / 2, floor - w * 0.07, cx + w / 2, floor + w * 0.07], fill=(0, 0, 0, alpha))
        layer = layer.filter(ImageFilter.GaussianBlur(8))
        layer.alpha_composite(img)
        return layer

    cells = {}
    for n, a in raw.items():
        img = with_shadow(a[:, x0:x1])
        w, h = img.size
        cells[n] = img if s == 1 else img.convert('RGBa').resize(
            (max(1, w // s), max(1, h // s)), Image.LANCZOS
        ).convert('RGBA')

    cw, ch = next(iter(cells.values())).size
    # Bound decoded surfaces as well as compressed file sizes.
    max_side = 4096
    if max(cw, ch) > max_side:
        raise ValueError('a sprite cell exceeds 4096 px; reduce padding or increase scale')
    cols = min(c['cols'], len(names), max_side // cw)
    rows_per_sheet = min(c.get('rows_per_sheet', 5), max_side // ch)
    per_sheet = cols * rows_per_sheet
    os.makedirs(plugin_dir, exist_ok=True)
    for old in os.listdir(plugin_dir):
        if old.startswith('sprite') and old.endswith('.webp'):
            os.remove(os.path.join(plugin_dir, old))
    sheets = []
    for start in range(0, len(names), per_sheet):
        chunk = names[start:start + per_sheet]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new('RGBA', (cw * cols, ch * rows), (0, 0, 0, 0))
        for i, n in enumerate(chunk):
            sheet.paste(cells[n], ((i % cols) * cw, (i // cols) * ch))
        file = f'sprite-{len(sheets)}.webp'
        sheet.save(os.path.join(plugin_dir, file), lossless=True, method=6)
        if os.path.getsize(os.path.join(plugin_dir, file)) > 8_000_000:
            raise ValueError(f'{file} exceeds CanvasTTY\'s 8 MB asset limit; lower rows_per_sheet or increase scale')
        sheets.append({'file': file, 'rows': rows})

    index = {n: i for i, n in enumerate(names)}
    table = {
        'cols': cols, 'perSheet': per_sheet, 'sheets': sheets, 'cell': [cw, ch],
        'clips': {k: [[index[n], d] for n, d in v if n in index] for k, v in clips.items()},
        'deck': c.get('deck', [k for k in c['clips'] if k != 'idle']),
        'labels': c.get('labels', {}), 'loops': c.get('loops', {}), 'follow': c.get('follow', {}),
        'frameNames': names,
    }
    sources = {n: {'source': path_of(n).name, 'sha256': digest(path_of(n))}
               for n in dict.fromkeys([*names, base])}
    config_hash = digest(cfg_path)
    table['clips'] = {k: v for k, v in table['clips'].items() if v}
    manifest_path = Path(plugin_dir) / 'canvastty.plugin.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest['name'] = c['name']
        manifest['description'] = c.get('description', f"Animated {c['name']} mascot for CanvasTTY")
        for contribution in manifest.get('contributions', []):
            if contribution.get('kind') == 'canvas-app':
                contribution['title'] = c['name']
                contribution['description'] = manifest['description']
                height = contribution['defaultSize']['height']
                contribution['defaultSize']['width'] = max(128, min(1600, round(height * cw / ch)))
                contribution['minSize']['width'] = 128
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    assets = {p.relative_to(plugin_dir).as_posix(): digest(p)
              for p in sorted(Path(plugin_dir).rglob('*')) if p.is_file() and p.name != 'frames.js'}
    table['buildId'] = hashlib.sha256((config_hash + json.dumps(sources, sort_keys=True)
                                      + json.dumps(assets, sort_keys=True)).encode()).hexdigest()[:16]
    with open(os.path.join(plugin_dir, 'frames.js'), 'w', encoding='utf-8') as f:
        f.write('window.SPRITE = ' + json.dumps(table, ensure_ascii=False) + ';\n')
    package_size = sum(path.stat().st_size for path in Path(plugin_dir).rglob('*') if path.is_file())
    if package_size > 25_000_000:
        raise ValueError('plugin exceeds CanvasTTY\'s 25 MB package limit; reduce frames or image size')

    report = {
        'build_id': table['buildId'], 'config_sha256': config_hash, 'frames': sources,
        'placement': {'source_canvas': [base_shape[1], base_shape[0]], 'crop_x': int(x0),
                      'crop_width': int(x1 - x0), 'padded_height': base_shape[0] + c['pad_bottom'],
                      'scale': s, 'cell': [cw, ch],
                      'floor_y': floor, 'frames': placements},
        'files': {p.relative_to(plugin_dir).as_posix(): digest(p)
                  for p in sorted(Path(plugin_dir).rglob('*')) if p.is_file()},
        'clips': {k: {'unique_drawings': len({n for n, _ in v}), 'playback_steps': len(v),
                      'seconds': round(sum(d for _, d in v), 6)} for k, v in clips.items()},
    }
    (Path(cfg_path).resolve().parent / 'build-report.json').write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8'
    )

    size_mb = sum(os.path.getsize(os.path.join(plugin_dir, s['file'])) for s in sheets) / 1e6
    print(f'frames {len(names)}  cell {cw}x{ch}  sheets {[(s["file"], s["rows"]) for s in sheets]}  {size_mb:.1f} MB  floor y={floor}')
    print('clips:', {k: len(v) for k, v in table['clips'].items() if ':' not in k})
    print('transitions:', sorted({k.split(':')[0] for k in table['clips'] if ':' in k}) or 'none')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
