"""Regression checks for fixed-scene pixel animation and irregular skin masks."""
from pathlib import Path
import tempfile
import unittest
try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None


@unittest.skipUnless(Image, 'Install Pillow for pixel-scene checks')
class PixelSceneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        base = Image.new('RGBA', (16, 16), (28, 16, 52, 255))
        ImageDraw.Draw(base).rectangle((0, 0, 3, 3), fill=(0, 0, 0, 0))
        base.save(self.root / 'base.png')
        # Odd-sized atlas exercises proportional cell boundaries.
        atlas = Image.new('RGBA', (9, 5))
        for y in range(2):
            for x in range(4):
                color = (100 + x * 35, 35 + y * 130, 10, 255)
                atlas.paste(color, (round(x*9/4), round(y*5/2), round((x+1)*9/4), round((y+1)*5/2)))
        atlas.save(self.root / 'atlas.png')
        self.config = dict(base='base.png', atlas='atlas.png', atlasGrid=[4, 2],
                           logicalSize=[16, 16], outputSize=[32, 32], frames=8,
                           sprites=[dict(rect=[4, 4, 3, 3], hold=2)])

    def tearDown(self):
        self.temp.cleanup()

    def test_held_authored_poses_leave_every_other_pixel_fixed(self):
        from compose_pixel_scene import render_scene
        frames = render_scene(self.config, self.root)
        self.assertEqual(frames[0].tobytes(), frames[1].tobytes())
        self.assertNotEqual(frames[1].tobytes(), frames[2].tobytes())
        with Image.open(self.root / 'base.png') as source:
            expected = source.resize((32, 32), Image.Resampling.NEAREST)
        for frame in frames:
            for y in range(32):
                for x in range(32):
                    if not (8 <= x < 14 and 8 <= y < 14):
                        self.assertEqual(frame.getpixel((x, y)), expected.getpixel((x, y)))
                    self.assertEqual(frame.getpixel((x, y)), frame.getpixel((x//2*2, y//2*2)))

    def test_effects_cannot_fill_outer_transparency_or_aperture(self):
        from compose_pixel_scene import render_scene
        self.config.update(preserveAlpha=True, aperture=dict(left=25, right=25, top=25, bottom=25),
                           sprites=[dict(rect=[0, 0, 16, 16], hold=1)])
        frames = render_scene(self.config, self.root)
        with Image.open(self.root / 'base.png') as source:
            alpha = source.getchannel('A')
        alpha.paste(0, (4, 4, 12, 12))
        expected = alpha.resize((32, 32), Image.Resampling.NEAREST).tobytes()
        for frame in frames:
            self.assertEqual(frame.getchannel('A').tobytes(), expected)

    def test_noninteger_scale_rejected(self):
        from compose_pixel_scene import render_scene
        self.config['outputSize'] = [33, 32]
        with self.assertRaises(ValueError):
            render_scene(self.config, self.root)

    def test_lava_moves_down_in_pixel_steps_but_cold_rails_and_exclusions_stay_fixed(self):
        from compose_pixel_scene import render_scene
        source = Image.new('RGBA', (16, 16), (20, 10, 35, 255))
        for y in range(2, 14):
            for x in range(4, 12):
                source.putpixel((x, y), (170+(y%4)*20, 80, 12, 255))
        source.save(self.root / 'base.png')
        self.config.update(frames=16, sprites=[], flows=[dict(
            polygon=[[2, 2], [13, 2], [13, 13], [2, 13]], period=4, hold=2,
            strength=1, excludeRects=[[4, 7, 8, 1]])])
        frames = render_scene(self.config, self.root)
        self.assertEqual(frames[0].tobytes(), frames[1].tobytes())
        self.assertEqual(frames[0].tobytes(), frames[8].tobytes())
        # The next pose moves a sample exactly one logical pixel downward.
        self.assertEqual(frames[0].getpixel((12, 6)), frames[2].getpixel((12, 8)))
        self.assertNotEqual(frames[0].getpixel((12, 8)), frames[2].getpixel((12, 8)))
        for frame in frames:
            for y in range(16):
                for x in range(16):
                    if x < 4 or x >= 12 or y < 2 or y >= 14 or y == 7:
                        self.assertEqual(frame.getpixel((x*2, y*2)), source.getpixel((x, y)))

    def test_flow_with_unclosed_period_is_rejected(self):
        from compose_pixel_scene import render_scene
        source = Image.new('RGBA', (16, 16), (200, 90, 10, 255))
        source.save(self.root / 'base.png')
        self.config['flows'] = [dict(polygon=[[2, 2], [13, 2], [13, 13], [2, 13]], period=3, hold=2)]
        with self.assertRaisesRegex(ValueError, 'period must divide'):
            render_scene(self.config, self.root)

    def test_authored_fire_keeps_cold_grate_and_excluded_bars_fixed(self):
        from compose_pixel_scene import render_scene
        source = Image.new('RGBA', (16, 16), (220, 100, 15, 255))
        ImageDraw.Draw(source).rectangle((4, 4, 6, 6), fill=(40, 40, 60, 255))
        source.save(self.root / 'base.png')
        self.config['sprites'] = [dict(rect=[2, 2, 12, 12], hold=2, hotOnly=True, excludeRects=[[8, 2, 2, 12]])]
        frames = render_scene(self.config, self.root)
        for frame in frames:
            for y in range(2, 14):
                for x in range(2, 14):
                    if (4 <= x <= 6 and 4 <= y <= 6) or 8 <= x < 10:
                        self.assertEqual(frame.getpixel((x*2, y*2)), source.getpixel((x, y)))
        self.assertNotEqual(frames[0].getpixel((6, 6)), source.getpixel((3, 3)))
