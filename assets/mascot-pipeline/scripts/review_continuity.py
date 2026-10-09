"""Measure declared support regions in source AND atlas; flag neighbor changes.

Usage: python review_continuity.py PROJECT/character.json
Requires manually inspected continuity.json. Flags require visual decisions;
neither measurements nor absence of flags constitute artistic approval.
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from build_sprite import load_config, resolve_clips, digest, frame_path
from finalize_mascot import verify_build


def support_row(image, region, threshold):
    x0, y0, x1, y1 = region
    if not (0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height):
        raise ValueError('support region does not fit the inspected image after placement')
    alpha = np.asarray(image.getchannel('A'))[y0:y1, x0:x1]
    rows = np.where(alpha > threshold)[0]
    if not len(rows):
        raise ValueError('declared support region contains no alpha above its diagnostic threshold')
    return int(rows.max() + y0)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def measure(config_path):
    config_path = Path(config_path).resolve()
    config = load_config(config_path)
    build = verify_build(config_path)
    project = config_path.parent
    manifest_path = project / 'continuity.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    limits = manifest.get('limits', {})
    for key in ('support_px', 'landmark_px', 'size_fraction'):
        if not finite(limits.get(key)) or limits[key] < 0:
            raise ValueError(f'declare project-specific finite nonnegative {key}')
    sprite = json.loads((Path(config['plugin_dir']) / 'frames.js').read_text(encoding='utf-8')
                        .strip().removeprefix('window.SPRITE = ').removesuffix(';'))
    placement = build['placement']
    cw, ch = sprite['cell']
    sx, sy = cw / placement['crop_width'], ch / placement['padded_height']
    atlas_cache, records = {}, {}
    for name in sprite['frameNames']:
        entry = manifest.get('frames', {}).get(name, {})
        if entry.get('source_sha256') != build['frames'][name]['sha256']:
            raise ValueError(f'continuity annotation missing or stale: {name}')
        for field in ('anatomy', 'contact', 'face'):
            if not isinstance(entry.get(field), str) or not entry[field].strip():
                raise ValueError(f'missing inspected {field}: {name}')
        points, sizes = entry.get('landmarks', {}), entry.get('sizes', {})
        if not points or not sizes:
            raise ValueError(f'declare independent body/prop landmarks and sizes: {name}')
        if any(not isinstance(v, list) or len(v) != 2 or not all(finite(n) for n in v)
               for v in points.values()):
            raise ValueError(f'invalid source-coordinate landmarks: {name}')
        if any(not finite(v) or v <= 0 for v in sizes.values()):
            raise ValueError(f'invalid measured sizes: {name}')
        transform = placement['frames'][name]
        source = Image.open(frame_path(config['frames_dir'], name)).convert('RGBA')
        index = sprite['frameNames'].index(name)
        sheet, local = divmod(index, sprite['perSheet'])
        if sheet not in atlas_cache:
            atlas_cache[sheet] = Image.open(Path(config['plugin_dir']) / sprite['sheets'][sheet]['file']).convert('RGBA')
        x, y = local % sprite['cols'] * cw, local // sprite['cols'] * ch
        cell = atlas_cache[sheet].crop((x, y, x + cw, y + ch))
        supports = {}
        declared = entry.get('supports')
        if not isinstance(declared, list):
            raise ValueError(f'declare supports (empty only for an unsupported pose): {name}')
        if not declared and not str(entry.get('support_note', '')).strip():
            raise ValueError(f'explain absent support: {name}')
        for item in declared:
            key, region, threshold = item.get('name'), item.get('region'), item.get('alpha_threshold')
            if (not isinstance(key, str) or not key or key in supports or not isinstance(region, list)
                    or len(region) != 4 or any(not isinstance(v, int) or isinstance(v, bool) for v in region)
                    or not (0 <= region[0] < region[2] <= source.width and 0 <= region[1] < region[3] <= source.height)
                    or not isinstance(threshold, int) or isinstance(threshold, bool) or not 0 <= threshold < 255
                    or not isinstance(item.get('grounded'), bool)):
                raise ValueError(f'invalid visually defined support region: {name}')
            built_region = [max(0, math.floor((region[0] - placement['crop_x']) * sx)),
                            max(0, math.floor((region[1] + transform['shift_y']) * sy)),
                            min(cw, math.ceil((region[2] - placement['crop_x']) * sx)),
                            min(ch, math.ceil((region[3] + transform['shift_y']) * sy))]
            supports[key] = {'source_y': support_row(source, region, threshold),
                             'built_y': support_row(cell, built_region, threshold),
                             'grounded': item['grounded'] and not transform['airborne'],
                             'region': region, 'alpha_threshold': threshold}
        records[name] = {'source': transform['source'], 'shift_y': transform['shift_y'], 'supports': supports,
                         'landmarks': points,
                         'built_landmarks': {k: [(v[0] - placement['crop_x']) * sx,
                                                 (v[1] + transform['shift_y']) * sy] for k, v in points.items()},
                         'sizes': sizes, 'anatomy': entry['anatomy'], 'contact': entry['contact'], 'face': entry['face']}
    clips = resolve_clips(config)
    pairs = []
    for clip, seq in clips.items():
        pairs.extend((f'{clip}:{i}->{clip}:{i+1}', a[0], b[0]) for i, (a, b) in enumerate(zip(seq, seq[1:])))
        if ':' not in clip:
            pairs.append((f'{clip}:seam', seq[-1][0], seq[0][0]))
    for action in config.get('deck', []):
        ordered = [(k, clips[k]) for k in ('idle', f'{action}:in', action, f'{action}:out', 'idle') if k in clips]
        pairs.extend((f'{a[0]}:end->{b[0]}:start', a[1][-1][0], b[1][0][0]) for a, b in zip(ordered, ordered[1:]))
    flags = []
    for boundary, left, right in pairs:
        a, b = records[left], records[right]
        def flag(kind, key, value, limit):
            if value > limit:
                flags.append({'id': f'{boundary}/{kind}/{key}', 'previous': left, 'current': right,
                              'kind': kind, 'landmark': key, 'change': round(value, 4), 'limit': limit})
        for key in a['supports'].keys() & b['supports'].keys():
            aa, bb = a['supports'][key], b['supports'][key]
            if aa['grounded'] and bb['grounded']:
                # Report in source-pixel equivalents after inspecting the actual downsampled atlas.
                flag('support', key, abs(aa['built_y'] - bb['built_y']) / sy, limits['support_px'])
        for key in a['built_landmarks'].keys() & b['built_landmarks'].keys():
            aa, bb = a['built_landmarks'][key], b['built_landmarks'][key]
            flag('trajectory', key, math.hypot((aa[0]-bb[0])/sx, (aa[1]-bb[1])/sy), limits['landmark_px'])
        for key in a['sizes'].keys() & b['sizes'].keys():
            flag('size', key, abs(b['sizes'][key] / a['sizes'][key] - 1), limits['size_fraction'])
    report = {'build_id': build['build_id'], 'manifest_sha256': digest(manifest_path),
              'limits': limits, 'placement': placement, 'frames': records,
              'compared_boundaries': [p[0] for p in pairs], 'flags': flags}
    target = project / 'continuity-report.json'
    target.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'Build {build["build_id"]}: {len(records)} drawings, {len(pairs)} neighbor/boundary checks, {len(flags)} flags')
    print('Flags need visual decisions; this is not visual approval.')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config')
    measure(parser.parse_args().config)
