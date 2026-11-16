"""Run with: python3 -m unittest discover -s tools -p 'test_*.py'. Pillow tests skip if unavailable."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from pack_wallpaper import pack


class PackagingTests(unittest.TestCase):
    def test_round_trip_preserves_source_and_recipe_and_refuses_overwrite(self):
        recipe = dict(fit='cover', x=25, y=75, width=1440, height=480, pixelated=True, clockFont='pixel', dim=.4)
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder)/'source.gif', Path(folder)/'clock.ctwallpaper'
            source.write_bytes(base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'))
            pack(source, target, 'Clock', 1, 1, recipe)
            data = json.loads(target.read_text())
            self.assertEqual(data['recipe'], recipe)
            self.assertEqual(base64.b64decode(data['source']['base64']), source.read_bytes())
            self.assertEqual(data['source']['width'], 1)
            with self.assertRaises(FileExistsError):
                pack(source, target, 'Clock', 1, 1, recipe)
            with self.assertRaises(ValueError):
                pack(source, Path(folder)/'invalid.ctwallpaper', 'Clock', 99999, 320, recipe)


@unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow is optional for packaging')
class GeneratorTests(unittest.TestCase):
    def test_seeded_gif_dimensions_loop_and_motion(self):
        from generate_pixel_wallpaper import generate
        from PIL import Image
        with tempfile.TemporaryDirectory() as folder:
            first, second = Path(folder)/'one.gif', Path(folder)/'two.gif'
            generate(first, 192, 64, seed=42)
            generate(second, 192, 64, seed=42)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with Image.open(first) as image:
                self.assertEqual(image.size, (192, 64)); self.assertEqual(image.n_frames, 24)
                self.assertEqual(image.info['loop'], 0)
                image.seek(0); a = image.convert('RGB').tobytes()
                image.seek(6); b = image.convert('RGB').tobytes()
                self.assertNotEqual(a, b)


if __name__ == '__main__':
    unittest.main()
