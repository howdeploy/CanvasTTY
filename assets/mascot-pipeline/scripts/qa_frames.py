"""Validate referenced mascot frames and create a contact sheet for visual review.

Usage: python qa_frames.py path/to/character.json
       python qa_frames.py path/to/character.json --approve "review notes"
Exit code 1 means a required frame is missing or a mechanical check failed.
Approval requires a separate full-size visual review; metrics cannot judge art quality.
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from build_sprite import frame_path, load_config, resolve_clips


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    pixels = np.asarray(Image.open(path).convert('RGBA')).copy()
    background = 'alpha' if np.any(pixels[..., 3] == 0) else 'OPAQUE'
    return pixels, background


def referenced_names(config):
    names = []
    for sequence in resolve_clips(config).values():
        names.extend(name for name, _ in sequence)
    names.append(config.get('floor_frame') or names[0])
    return list(dict.fromkeys(names))


def main(config_path):
    config_path = Path(config_path).resolve()
    config = load_config(config_path)
    directory = Path(config['frames_dir'])
    names = referenced_names(config)
    missing = [name for name in names if frame_path(directory, name) is None]
    if missing:
        if directory.is_dir():
            (directory / 'qa-report.json').write_text(
                json.dumps({'missing': missing, 'frames': [], 'visual_review_required': True}, indent=2) + '\n',
                encoding='utf-8',
            )
        raise ValueError('missing frames: ' + ', '.join(missing))

    floor_name = config.get('floor_frame') or names[0]
    reference, _ = load(frame_path(directory, floor_name))
    reference_y = np.where(reference[..., 3] > 0)[0]
    if not reference_y.size:
        raise ValueError(f'floor_frame is empty: {floor_name}')
    floor = int(reference_y.max())
    reference_ys, reference_xs = np.where(reference[..., 3] > 0)
    reference_width = int(reference_xs.max() - reference_xs.min() + 1)
    reference_height = int(reference_ys.max() - reference_ys.min() + 1)
    airborne = set(config.get('airborne', []))
    thumbnails = []
    failures = []
    records = []

    for name in names:
        source = frame_path(directory, name)
        pixels, background = load(source)
        issues = []
        visual_flags = []
        bounds = None
        size_ratio = None
        if pixels.shape != reference.shape:
            issues.append(f'SIZE {pixels.shape[1]}x{pixels.shape[0]}')
        if background == 'OPAQUE':
            issues.append('BG')
        alpha = pixels[..., 3]
        ys, xs = np.where(alpha > 0)
        if not ys.size:
            issues.append('EMPTY')
        else:
            height, width = alpha.shape
            bounds = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
            size_ratio = {
                'width': round((bounds[2] - bounds[0]) / reference_width, 3),
                'height': round((bounds[3] - bounds[1]) / reference_height, 3),
            }
            if abs(size_ratio['width'] - 1) > 0.01 or abs(size_ratio['height'] - 1) > 0.01:
                visual_flags.append('Compare figure scale with the base at full resolution; poses and props can change bounds.')
            if xs.min() <= 1 or xs.max() >= width - 2 or ys.min() <= 1 or ys.max() >= height - 2:
                issues.append('EDGE')
            offset = floor - int(ys.max())
            if name not in airborne and abs(offset) > 30:
                visual_flags.append(f'Visible bottom differs by {offset:+d}px; inspect body supports separately from effects/props. No automatic alignment is applied.')
        if issues:
            failures.append(f'{name}: {", ".join(issues)}')
        records.append({
            'name': name, 'source': source.name, 'sha256': digest(source),
            'bounds': bounds, 'size_ratio_to_base': size_ratio,
            'visual_flags': visual_flags, 'issues': issues,
        })
        print(f'{name}: {background}; {", ".join(issues) if issues else "OK"}')

        image = Image.fromarray(pixels)
        backing = Image.new('RGBA', image.size, (60, 55, 72, 255))
        backing.alpha_composite(image)
        thumb = backing.convert('RGB').resize((max(1, image.width // 6), max(1, image.height // 6)))
        ImageDraw.Draw(thumb).text((4, 4), name, fill=(255, 255, 0))
        thumbnails.append(thumb)

    columns = min(8, len(thumbnails))
    cell_w = max(image.width for image in thumbnails)
    cell_h = max(image.height for image in thumbnails)
    rows = (len(thumbnails) + columns - 1) // columns
    sheet = Image.new('RGB', (columns * cell_w, rows * cell_h), (30, 28, 36))
    for index, image in enumerate(thumbnails):
        sheet.paste(image, ((index % columns) * cell_w, (index // columns) * cell_h))
    sheet_path = directory / 'qa-sheet.png'
    sheet.save(sheet_path)
    report_path = directory / 'qa-report.json'
    report_path.write_text(
        json.dumps({
            'missing': [], 'frames': records, 'config_sha256': digest(config_path),
            'visual_review_required': True, 'visual_review': {'status': 'pending'},
        }, indent=2) + '\n',
        encoding='utf-8',
    )
    print(f'Visual review: {sheet_path}')
    print(f'Machine-readable report: {report_path}')
    if failures:
        raise ValueError('frame checks failed:\n' + '\n'.join(failures))
    print(f'Mechanical checks passed for {len(names)} frames. Inspect all frames at full size, then run --approve.')


def approve(config_path, notes):
    if len(notes.strip()) < 20:
        raise ValueError('record specific full-size visual review notes')
    config_path = Path(config_path).resolve()
    config = load_config(config_path)
    report_path = Path(config['frames_dir']) / 'qa-report.json'
    report = json.loads(report_path.read_text(encoding='utf-8'))
    if report.get('config_sha256') != digest(config_path) or report.get('missing'):
        raise ValueError('configuration changed or required frames are missing; rerun QA')
    records = report.get('frames') or []
    if not records or any(record.get('issues') for record in records):
        raise ValueError('mechanical QA has not passed')
    directory = Path(config['frames_dir'])
    for record in records:
        source = frame_path(directory, record['name'])
        if source is None or source.name != record['source'] or digest(source) != record['sha256']:
            raise ValueError(f"frame changed after QA: {record['name']}")
    report['visual_review'] = {'status': 'approved', 'notes': notes}
    report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'Visual review recorded: {report_path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config')
    parser.add_argument('--approve', metavar='NOTES', help='record a completed full-size visual review')
    args = parser.parse_args()
    if args.approve is not None:
        approve(args.config, args.approve)
    else:
        main(args.config)
