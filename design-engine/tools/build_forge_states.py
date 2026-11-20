#!/usr/bin/env python3
"""Author readable Living Forge states on the existing fixed pixel grid.

Input is the approved Forge scene directory (roles/, scenes/, Volcanic-Forge/).
No new artwork generation, camera movement, resampling tween or network calls.
"""
import argparse
import copy
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from compose_pixel_scene import render_scene
from encode_animation import encode
from media_probe import write_json
from pack_terminal_theme import LEVELS, STATES, pack

COLORS = {'idle': (193, 150, 101), 'working': (255, 208, 101), 'completed': (116, 235, 194)}
LETTERS = {
    'I': ['111', '010', '010', '010', '111'],
    'D': ['110', '101', '101', '101', '110'],
    'L': ['100', '100', '100', '100', '111'],
    'E': ['111', '100', '110', '100', '111'],
    'W': ['10001', '10001', '10101', '10101', '01010'],
    'O': ['111', '101', '101', '101', '111'],
    'R': ['110', '101', '110', '101', '101'],
    'K': ['101', '101', '110', '101', '101'],
    'N': ['1001', '1101', '1011', '1001', '1001'],
    'G': ['111', '100', '101', '101', '111'],
}


def text(draw, word, center, y, color):
    width = sum(len(LETTERS[c][0]) + 1 for c in word) * 2 - 2
    x = center - width // 2
    for char in word:
        for row, line in enumerate(LETTERS[char]):
            for column, value in enumerate(line):
                if value == '1':
                    draw.rectangle((x + column*2, y + row*2, x + column*2 + 1, y + row*2 + 1), fill=color)
        x += (len(LETTERS[char][0]) + 1) * 2


def decorate(frame, state, index, config, level):
    # All edits happen at logical resolution, then expand to exact 2x2 pixels.
    logical = frame.resize((768, 512), Image.Resampling.NEAREST)
    pixels = np.asarray(logical).copy()
    r, g, b, alpha = [pixels[:, :, channel].astype(float) for channel in range(4)]
    # Only molten channels and furnace cells change temperature. Gold hardware,
    # rocks and chains keep their painted highlights in every state.
    mask = Image.new('L', logical.size)
    md = ImageDraw.Draw(mask)
    for flow in config['flows']:
        md.polygon([tuple(p) for p in flow['polygon']], fill=255)
        for x, y, w, h in flow.get('excludeRects', []):
            md.rectangle((x, y, x+w-1, y+h-1), fill=0)
    for sprite in config['sprites']:
        x, y, w, h = sprite['rect']
        md.rectangle((x, y, x+w-1, y+h-1), fill=255)
        for x, y, w, h in sprite.get('excludeRects', []):
            md.rectangle((x, y, x+w-1, y+h-1), fill=0)
    hot = (alpha > 0) & (np.asarray(mask) > 0) & (r > 120) & (r > g*1.1) & (g > b*1.2)
    if state != 'working':
        light = np.maximum(r, g)
        factors = (.52, .34, .24) if state == 'idle' else (.34, .78, .66)
        for channel, factor in enumerate(factors):
            pixels[:, :, channel][hot] = (light[hot]*factor).astype('uint8')
    logical = Image.fromarray(pixels)
    draw = ImageDraw.Draw(logical)
    color = COLORS[state]
    # A permanent, large state seal; readable even with animations paused.
    # Inlay the seal inside the existing ornate crest, retaining its silhouette.
    shield = [(365, 43), (403, 43), (403, 70), (384, 82), (365, 70)]
    draw.polygon(shield, fill=(43, 24, 33), outline=(146, 92, 53), width=2)
    if state == 'idle':
        for x in (372, 390):
            draw.rectangle((x, 49, x+6, 69), fill=color)
    elif state == 'working':
        # Four discrete hammer poses. Only the tool and impact sparks move.
        drop = (0, 0, 2, 5, 5, 2)[(index//2) % 6]
        draw.rectangle((379, 55+drop, 384, 68+drop), fill=(161, 102, 58))
        draw.rectangle((369, 46+drop, 395, 55+drop), fill=color)
        draw.rectangle((371, 46+drop, 395, 48+drop), fill=(255, 241, 183))
        draw.rectangle((373, 74, 395, 76), fill=(139, 101, 80))
        if drop == 5:
            for x, y in [(368, 66), (399, 65), (397, 70)]:
                draw.rectangle((x, y, x+2, y+2), fill=color)
    else:
        draw.line([(369, 60), (379, 70), (399, 49)], fill=(24, 82, 69), width=8)
        draw.line([(369, 57), (379, 67), (399, 46)], fill=color, width=5)
    # Engraved footer plaque is part of the frame, entirely outside the terminal.
    word = {'idle': 'IDLE', 'working': 'WORKING', 'completed': 'DONE'}[state]
    draw.polygon([(311, 439), (432, 439), (438, 445), (438, 462), (432, 468), (311, 468), (305, 462), (305, 445)], fill=(30, 22, 29), outline=(123, 82, 52), width=2)
    draw.line([(312, 442), (431, 442)], fill=color, width=2)
    text(draw, word, 372, 449, color)
    return logical.resize(frame.size, Image.Resampling.NEAREST)


def build(source, output):
    output.mkdir(parents=True, exist_ok=False)
    roles = output/'roles'; roles.mkdir()
    checks = output/'checks'; checks.mkdir()
    exports = output/'Living-Forge'; exports.mkdir()
    apertures = json.loads((source/'Volcanic-Forge/apertures.json').read_text())
    controls = json.loads((source/'Volcanic-Forge/controls.json').read_text())
    first_frames = {}
    for level in LEVELS:
        for state in STATES:
            name = f'{level}_{state}'
            config = copy.deepcopy(json.loads((source/'scenes'/f'{name}.json').read_text()))
            for sprite in config['sprites']:
                sprite['hold'] = {'idle': 3, 'working': 1, 'completed': 3}[state]
            for flow in config['flows']:
                flow['strength'] = {'idle': .3, 'working': .7, 'completed': .35}[state]
            frames = [decorate(f, state, i, config, level) for i, f in enumerate(render_scene(config, source/'scenes'))]
            first_frames[name] = frames[0]
            receipt = encode(frames, roles/f'{name}.gif', 10)
            write_json(checks/f'{name}.json', receipt)
            print(name, receipt['bytes'], flush=True)
    shutil.copyfile(source/'roles/background.gif', roles/'background.gif')
    result = pack(roles, exports/'Living-Forge-terminals.zip', apertures, require_live=True, controls=controls)
    write_json(checks/'theme.json', result)
    # Identical-time static comparison catches phase-only variants from the old preset.
    comparison = []
    for level in LEVELS:
        for left, right in [('idle', 'working'), ('working', 'completed'), ('idle', 'completed')]:
            a, b = [np.asarray(first_frames[f'{level}_{state}']) for state in (left, right)]
            visible = (a[:, :, 3] > 0) | (b[:, :, 3] > 0)
            distinct = np.max(np.abs(a[:, :, :3].astype(int)-b[:, :, :3].astype(int)), axis=2) > 25
            fraction = float(distinct[visible].mean())
            assert fraction > .025, (level, left, right, fraction)
            comparison.append(dict(level=level, states=[left, right], visiblyDifferentFraction=fraction))
    write_json(checks/'state-contrast.json', dict(result='passed', pausedFrameComparison=comparison, order=['IDLE', 'WORKING', 'DONE']))
    for name, frame in first_frames.items():
        frame.save(checks/f'{name}.png')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.source.resolve(), args.output.resolve())))
