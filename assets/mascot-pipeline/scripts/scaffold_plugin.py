"""Create a CanvasTTY mascot plugin from one character.json config.

Usage: python scaffold_plugin.py path/to/character.json
The destination must be empty; existing plugin files are never overwritten.
"""

import json
import re
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / 'templates' / 'plugin'


def main(config_path):
    config_path = Path(config_path).resolve()
    config = json.loads(config_path.read_text(encoding='utf-8'))
    mascot_id = config['id']
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', mascot_id) or mascot_id == 'host':
        raise ValueError('id must use lowercase letters, digits and single hyphens')
    name = config['name'].strip()
    if not name:
        raise ValueError('name must not be empty')
    destination = (config_path.parent / config['plugin_dir']).resolve()
    if destination.exists() and any(destination.iterdir()):
        raise ValueError(f'plugin directory is not empty: {destination}')
    values = {
        '__ID__': mascot_id,
        '__NAME__': name,
        '__DESCRIPTION__': config.get('description', f'Animated {name} mascot for CanvasTTY'),
    }
    for source in TEMPLATE.rglob('*'):
        if not source.is_file():
            continue
        target = destination / source.relative_to(TEMPLATE)
        target.parent.mkdir(parents=True, exist_ok=True)
        content = source.read_text(encoding='utf-8')
        for key, value in values.items():
            replacement = json.dumps(value, ensure_ascii=False)[1:-1] if source.suffix == '.json' else value
            content = content.replace(key, replacement)
        if source.suffix == '.json':
            json.loads(content)
        target.write_text(content, encoding='utf-8')
    print(f'plugin scaffold: {destination}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
