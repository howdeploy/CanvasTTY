#!/usr/bin/env python3
"""Validate and package exactly nine terminal frames and one background. Requires Pillow."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import zipfile

from media_probe import EXTENSIONS, probe, write_json

LEVELS = ('minimal', 'detailed', 'master')
STATES = ('idle', 'working', 'completed')
ROLES = tuple(f'{level}_{state}' for level in LEVELS for state in STATES) + ('background',)


def pack(source, output, apertures, require_live=False, controls=None):
    directory, destination = Path(source), Path(output)
    if destination.exists():
        raise FileExistsError(destination)
    if set(apertures) != set(LEVELS):
        raise ValueError('Supply an aperture for each of minimal, detailed, master')
    if controls is not None:
        if set(controls) != set(LEVELS):
            raise ValueError('Supply measured control plaques for all three levels')
        for rect in controls.values():
            if set(rect) != {'left', 'top', 'width', 'height'} or any(type(v) not in (int, float) or not math.isfinite(v) for v in rect.values()):
                raise ValueError('Invalid control plaque')
            if rect['left'] < 0 or rect['top'] < 0 or rect['width'] < 8 or rect['height'] < 2 or rect['left'] + rect['width'] > 100 or rect['top'] + rect['height'] > 100:
                raise ValueError('Control plaque must fit inside the artwork')
    # A strict leaf directory prevents accidentally shipping source art or personal files.
    files = list(directory.iterdir())
    roles = {}
    for path in files:
        if not path.is_file() or path.stem not in ROLES or path.suffix.lower() not in EXTENSIONS or path.stem in roles:
            raise ValueError(f'Unexpected or duplicate role: {path.name}')
        roles[path.stem] = path
    if set(roles) != set(ROLES):
        raise ValueError('Expected exactly nine frame roles and one background')
    receipt = {'kind': 'canvastty-terminal-theme-check', 'requireLive': require_live, 'apertures': apertures, 'controls': controls, 'media': {}}
    for role in ROLES:
        path = roles[role]
        frame = role != 'background'
        if frame and path.suffix.lower() in ('.mp4', '.webm'):
            raise ValueError('Video is supported only for background')
        item = probe(path, require_live=require_live, aperture=apertures[role.split('_')[0]] if frame else None)
        if frame and (item['width'], item['height']) != (1536, 1024):
            raise ValueError(f'{path.name}: frame must be exactly 1536x1024')
        receipt['media'][role] = item
    for level in LEVELS:
        signatures = {receipt['media'][f'{level}_{state}']['visualSha256'] for state in STATES}
        if len(signatures) != 3:
            raise ValueError(f'{level}: idle, working and completed must have different artwork')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for role in ROLES:
            path = roles[role]
            info = zipfile.ZipInfo(path.name, date_time=(2020, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
        if controls is not None:
            archive.writestr('layout.json', json.dumps(dict(schemaVersion=1, apertures=apertures, controls=controls), separators=(',', ':')))
    data = buffer.getvalue()
    if len(data) > 150 * 1024 * 1024:
        raise ValueError('Install ZIP exceeds 150 MiB')
    with destination.open('xb') as stream:
        stream.write(data)
    receipt.update(archive=destination.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                   verification='Decoded images and apertures checked. App import, motion seam and visual quality still require verification.')
    return receipt


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source'); p.add_argument('output'); p.add_argument('--apertures', required=True)
    p.add_argument('--require-live', action='store_true'); p.add_argument('--receipt')
    p.add_argument('--controls', help='JSON: measured left/top/width/height percentages for each detail level')
    a = p.parse_args()
    if a.receipt and Path(a.receipt).exists():
        raise FileExistsError(a.receipt)
    result = pack(a.source, a.output, json.loads(Path(a.apertures).read_text(encoding='utf-8')), a.require_live,
                  json.loads(Path(a.controls).read_text(encoding='utf-8')) if a.controls else None)
    if a.receipt:
        write_json(a.receipt, result)
    print(f"Created {a.output}: exactly ten roles, {result['bytes']} bytes, sha256={result['sha256']}")


if __name__ == '__main__':
    main()
