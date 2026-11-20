#!/usr/bin/env python3
"""Build a reproducible offline agent source kit. This is not an installable skin ZIP."""
import argparse
import hashlib
import io
from pathlib import Path
import zipfile


def build(output):
    root = Path(__file__).resolve().parents[1]
    files = [root / name for name in ('README.md', 'AGENT_START.md', 'LIVE_ENGINE.md', 'SPEC.ru.md', 'RELEASE_PLAN.ru.md')]
    for folder in ('tools', 'templates', 'references', 'examples'):
        files.extend(path for path in (root / folder).rglob('*') if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc')
    if Path(output).exists():
        raise FileExistsError(output)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(files):
            entry = zipfile.ZipInfo(path.relative_to(root).as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes())
    data = buffer.getvalue()
    with Path(output).open('xb') as stream:
        stream.write(data)
    return {'file': str(output), 'files': len(files), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('output')
    print(build(p.parse_args().output))
