"""Decode local artwork before packaging. Images need Pillow; video needs ffprobe."""
import hashlib
import json
import math
from pathlib import Path
import subprocess

IMAGE_EXTENSIONS = {'.png': 'PNG', '.apng': 'PNG', '.gif': 'GIF', '.webp': 'WEBP'}
EXTENSIONS = {*IMAGE_EXTENSIONS, '.mp4', '.webm'}


def dimensions(width, height):
    if (type(width) is not int or type(height) is not int or not 1 <= width <= 8192
            or not 1 <= height <= 8192 or width * height > 36_000_000):
        raise ValueError('Resolution must be integer pixels, <= 8192 per side and 36 MP')


def aperture_box(aperture, size):
    if set(aperture) != {'left', 'right', 'top', 'bottom'}:
        raise ValueError('Aperture requires left/right/top/bottom percentages')
    if any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v < 100 for v in aperture.values()):
        raise ValueError('Invalid aperture percentage')
    w, h = size
    box = (math.ceil(w * aperture['left'] / 100), math.ceil(h * aperture['top'] / 100),
           math.floor(w * (100 - aperture['right']) / 100), math.floor(h * (100 - aperture['bottom']) / 100))
    if box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError('Aperture has no area')
    return box


def probe(path, require_live=False, aperture=None):
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix not in EXTENSIONS or not path.is_file():
        raise ValueError('Expected a local PNG/APNG/GIF/WebP/MP4/WebM file')
    size = path.stat().st_size
    if not 0 < size <= (80 if suffix in ('.mp4', '.webm') else 20) * 1024 * 1024:
        raise ValueError('Media exceeds the 20 MiB image / 80 MiB video limit or is empty')
    result = {'file': path.name, 'bytes': size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    if suffix in IMAGE_EXTENSIONS:
        from PIL import Image
        with Image.open(path) as image:
            if image.format != IMAGE_EXTENSIONS[suffix]:
                raise ValueError('Media extension does not match decoded format')
            width, height = image.size
            dimensions(width, height)
            frames = getattr(image, 'n_frames', 1)
            if frames * width * height > 192_000_000:
                raise ValueError('Decoded animation exceeds the 192 MP inspection budget; shorten or downsize it')
            hashes, duration = set(), 0
            sequence = hashlib.sha256()
            # Read every composited frame, including disposal/transparency, not just a header.
            for index in range(frames):
                image.seek(index)
                rgba = image.convert('RGBA')
                if aperture and rgba.getchannel('A').crop(aperture_box(aperture, image.size)).getextrema() != (0, 0):
                    raise ValueError(f'{path.name}: terminal aperture is opaque in frame {index}')
                # RGB under fully transparent pixels is invisible and cannot prove live motion.
                visible = Image.new('RGBA', rgba.size)
                visible.paste(rgba, mask=rgba.getchannel('A').point(lambda a: 255 if a else 0))
                digest = hashlib.sha256(visible.tobytes()).digest()
                hashes.add(digest); sequence.update(digest)
                delay = image.info.get('duration', 0)
                duration += delay
                if require_live and (not isinstance(delay, (int, float)) or not math.isfinite(delay) or delay < 20):
                    raise ValueError(f'{path.name}: live frames require durations >= 20 ms')
            loop = image.info.get('loop')
            animated = frames > 1 and len(hashes) > 1
            if require_live and (not animated or loop != 0):
                raise ValueError(f'{path.name}: expected distinct animation frames and an infinite loop')
            result.update(format=image.format.lower(), width=width, height=height, frames=frames,
                          animated=animated, durationMs=duration, loop=loop, visualSha256=sequence.hexdigest())
    else:
        if aperture:
            raise ValueError('Video is only supported as wallpaper, never as a terminal frame')
        try:
            run = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path.resolve())],
                                 check=True, capture_output=True, text=True, timeout=30)
            data = json.loads(run.stdout)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
            raise ValueError('Video inspection requires a working ffprobe and a decodable video') from error
        streams = data.get('streams', [])
        videos = [s for s in streams if s.get('codec_type') == 'video' and not s.get('disposition', {}).get('attached_pic')]
        if len(videos) != 1 or any(s.get('codec_type') == 'audio' for s in streams):
            raise ValueError('Wallpaper must contain one silent video stream')
        video = videos[0]; width, height = video['width'], video['height']
        dimensions(width, height)
        codecs = ('h264',) if suffix == '.mp4' else ('vp8', 'vp9')
        container = data.get('format', {}).get('format_name', '')
        if video.get('codec_name') not in codecs or (suffix == '.mp4' and 'mp4' not in container) or (suffix == '.webm' and 'webm' not in container):
            raise ValueError('Use H.264 MP4 or VP8/VP9 WebM')
        seconds = float(video.get('duration') or data.get('format', {}).get('duration') or 0)
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError('Video duration is missing')
        result.update(format=suffix[1:], width=width, height=height, codec=video['codec_name'],
                      durationMs=round(seconds * 1000), animated=True,
                      inspection='ffprobe metadata; full video decoding and loop seam require app verification')
    return result


def write_json(path, payload):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
