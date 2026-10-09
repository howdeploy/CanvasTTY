"""Validate an input PNG/JPEG and create a fresh mascot project workspace.

Usage: python scripts/prepare_input.py --image IMAGE.png|IMAGE.jpg --project PROJECT_DIR
The destination must not contain files; existing work is never overwritten.
"""

import argparse
import shutil
from pathlib import Path

from PIL import Image, ImageOps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--project", type=Path, required=True)
    args = parser.parse_args()

    source = args.image.expanduser().resolve(strict=True)
    project = args.project.expanduser().resolve()
    if project.exists() and any(project.iterdir()):
        raise ValueError(f"project directory is not empty: {project}")
    if source.stat().st_size > 20 * 1024 * 1024:
        raise ValueError("choose a PNG or JPEG up to 20 MB")
    with Image.open(source) as image:
        image_format = image.format
        if image_format not in ("PNG", "JPEG"):
            raise ValueError("the reference must be a PNG or JPEG file")
        prepared = ImageOps.exif_transpose(image).convert("RGBA") if image_format == "JPEG" else image.convert("RGBA")
        alpha = prepared.getchannel("A")
        minimum, maximum = alpha.getextrema()
        if maximum == 0:
            raise ValueError("the image has no visible character pixels")
        dimensions = prepared.size
        if not all(32 <= dimension <= 4096 for dimension in dimensions):
            raise ValueError("image dimensions must be between 32 and 4096 pixels")

    references = project / "references"
    frames = project / "frames"
    references.mkdir(parents=True, exist_ok=True)
    frames.mkdir(parents=True, exist_ok=True)
    target = references / "character.png"
    original = references / ("character.jpg" if image_format == "JPEG" else "character.png")
    shutil.copy2(source, original)
    if image_format == "JPEG":
        prepared.save(target, format="PNG")
    print(f"original: {original}")
    print(f"reference: {target}")
    print(f"dimensions: {dimensions[0]}x{dimensions[1]}")
    print(f"background removal required: {minimum == 255}")
    print(f"frames: {frames}")


if __name__ == "__main__":
    main()
