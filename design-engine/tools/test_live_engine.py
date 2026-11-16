"""Offline regression tests using real decoded media, not extension/header stubs."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None

from animate_artwork import animate
from encode_animation import encode, load_frames
from media_probe import probe, aperture_box
from pack_terminal_theme import pack as pack_theme, LEVELS, STATES
from pack_wallpaper import pack as pack_wallpaper


@unittest.skipUnless(Image, 'Install Pillow to run live media tests')
class LiveEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.art = self.root / 'source.png'
        self.image().save(self.art)

    def tearDown(self):
        self.temp.cleanup()

    def image(self, size=(192, 128), color=(80, 140, 200, 255)):
        image = Image.new('RGBA', size)
        ImageDraw.Draw(image).rectangle((0, 0, size[0]-1, size[1]-1), outline=color, width=max(5, size[0] // 16))
        return image

    def test_real_motion_all_formats_preserves_aperture_and_source(self):
        original = self.art.read_bytes()
        for extension in ('gif', 'apng', 'webp'):
            with self.subTest(extension=extension):
                path = self.root / f'live.{extension}'
                result = animate(self.art, path, seconds=1)
                self.assertTrue(result['animated']); self.assertGreater(result['frames'], 1)
                self.assertEqual(result['durationMs'], 1000)
                probe(path, require_live=True, aperture=dict(left=20, right=20, top=20, bottom=20))
                with self.assertRaises(FileExistsError):
                    animate(self.art, path)
        self.assertEqual(self.art.read_bytes(), original)

    def test_gif_shared_palette_keeps_stationary_colors_stable(self):
        frames = []
        for value in (30, 100, 220):
            frame = Image.new('RGBA', (192,128), (60,30,85,255))
            ImageDraw.Draw(frame).rectangle((0,0,80,80), fill=(255,value,15,255))
            frames.append(frame)
        path = self.root / 'palette.gif'; encode(frames,path)
        with Image.open(path) as animation:
            samples = []
            for index in range(animation.n_frames):
                animation.seek(index); samples.append(animation.convert('RGBA').getpixel((150,100)))
            self.assertEqual(len(set(samples)),1, 'Static masonry must not shimmer with per-frame color quantization')

    def test_gif_delta_encoding_retains_art_and_reduces_repeated_pixels(self):
        frames = []
        for index in range(12):
            frame = Image.new('RGBA', (192,128))
            pixels = frame.load()
            for y in range(128):
                for x in range(192):
                    v = ((x * 31 + y * 17 + x * y) % 8) * 32
                    pixels[x,y] = (v, v, v, 255)
            ImageDraw.Draw(frame).rectangle((70,50,120,90),fill=(0,0,0,0))
            pixels[index,0] = (255,0,0,255)
            frames.append(frame)
        path = self.root / 'delta.gif'; encode(frames,path)
        with Image.open(path) as animation:
            self.assertEqual(animation.n_frames,12)
            for index, expected in enumerate(frames):
                animation.seek(index); actual = animation.convert('RGBA')
                self.assertEqual(actual.getchannel('A').tobytes(),expected.getchannel('A').tobytes())
                self.assertEqual(actual.crop((0,0,70,128)).tobytes(),expected.crop((0,0,70,128)).tobytes())
        self.assertLess(path.stat().st_size,192*128*2,'Repeated artwork should be encoded once')

    def test_gif_moving_transparency_clears_previous_frame(self):
        frames = []
        for x in (0,60,120):
            frame = Image.new('RGBA',(192,128))
            ImageDraw.Draw(frame).rectangle((x,30,x+20,50),fill=(255,80,0,255))
            frames.append(frame)
        path = self.root / 'alpha.gif'; encode(frames,path)
        with Image.open(path) as animation:
            self.assertEqual(animation.n_frames,3)
            for index,expected in enumerate(frames):
                animation.seek(index)
                self.assertEqual(animation.convert('RGBA').getchannel('A').tobytes(),expected.getchannel('A').tobytes())

    @unittest.skipUnless(importlib.util.find_spec('numpy'), 'NumPy needed for emissive animation')
    def test_emissive_motion_preserves_unlit_art_and_aperture(self):
        from animate_emissive import render_frames
        image = Image.new('RGBA',(192,128),(60,30,85,255))
        ImageDraw.Draw(image).rectangle((0,0,25,127),fill=(255,180,20,255))
        image.save(self.art); source = self.art.read_bytes()
        frames, info = render_frames(self.art,12,'working',dict(left=20,right=20,top=20,bottom=20))
        self.assertEqual(len(frames),12)
        self.assertGreater(len({hashlib.sha256(frame.tobytes()).digest() for frame in frames}),1)
        for frame in frames:
            self.assertEqual(frame.getpixel((180,15)),(60,30,85,255))
            self.assertEqual(frame.getchannel('A').crop((40,30,150,95)).getextrema(),(0,0))
        self.assertEqual(self.art.read_bytes(),source)

    def test_mask_freezes_unselected_art_and_soft_alpha(self):
        image = self.image(color=(80, 140, 200, 100)); image.save(self.art)
        mask = Image.new('L', image.size); ImageDraw.Draw(mask).rectangle((0,0,95,127), fill=255)
        mask.save(self.root / 'mask.png')
        output = self.root / 'masked.apng'
        animate(self.art, output, seconds=1, mask=self.root / 'mask.png')
        with Image.open(output) as animation:
            for frame in range(animation.n_frames):
                animation.seek(frame); rgba = animation.convert('RGBA')
                self.assertEqual(rgba.getchannel('A').tobytes(), image.getchannel('A').tobytes())
                self.assertEqual(rgba.crop((100, 0, 192, 128)).tobytes(), image.crop((100, 0, 192, 128)).tobytes())

    def test_refuses_flat_live_animation_and_fake_media(self):
        with self.assertRaises(ValueError):
            encode([self.image(), self.image()], self.root / 'flat.gif')
        self.assertFalse((self.root / 'flat.gif').exists())
        fake = self.root / 'fake.gif'; fake.write_bytes(b'GIF89a-test')
        with self.assertRaises((ValueError, OSError)):
            probe(fake)
        live = self.root / 'live.gif'; animate(self.art, live, seconds=1)
        with self.assertRaises(ValueError):
            animate(live, self.root / 'flatten.gif')

    def test_authored_frames_and_sprite_sheet_keep_real_motion(self):
        folder = self.root / 'frames'; folder.mkdir()
        self.image(color=(20,100,180,255)).save(folder / 'frame-0000.png')
        self.image(color=(90,180,90,255)).save(folder / 'frame-0001.png')
        info = encode(load_frames(folder), self.root / 'frames.gif')
        self.assertEqual(info['frames'], 2)
        sheet = Image.new('RGBA', (384,128))
        sheet.paste(self.image(), (0,0)); sheet.paste(self.image(color=(180,80,20,255)), (192,0))
        sheet.save(self.root / 'sheet.png')
        self.assertEqual(len(load_frames(self.root / 'sheet.png', 2, 1)), 2)
        (folder / 'draft.txt').write_text('not a frame')
        with self.assertRaises(ValueError): load_frames(folder)
        with self.assertRaises(ValueError): load_frames(self.root / 'sheet.png', 5, 1)

    def test_probe_catches_opaque_later_frame_and_finite_loop(self):
        first = self.image(); second = self.image(color=(150,100,80,255))
        ImageDraw.Draw(second).point((96,64), fill=(1,1,1,255))
        path = self.root / 'bad.gif'; encode([first,second], path)
        with self.assertRaisesRegex(ValueError, 'frame 1'):
            probe(path, aperture=dict(left=20,right=20,top=20,bottom=20))
        path = self.root / 'finite.gif'
        first.save(path, save_all=True, append_images=[second], loop=1, duration=100)
        with self.assertRaisesRegex(ValueError, 'infinite loop'): probe(path, require_live=True)

    def test_wallpaper_cli_infers_dimensions_and_rejects_lies(self):
        live = self.root / 'live.gif'; animate(self.art, live, seconds=1)
        command = [sys.executable, str(Path(__file__).with_name('pack_wallpaper.py')), str(live), str(self.root / 'live.ctwallpaper'), '--name', 'Live test', '--require-live']
        subprocess.run(command, check=True, capture_output=True)
        data = json.loads((self.root / 'live.ctwallpaper').read_text())
        self.assertEqual((data['source']['width'], data['source']['height']), (192,128))
        command[3] = str(self.root / 'lie.ctwallpaper')
        failed = subprocess.run(command + ['--source-width', '2048'], capture_output=True)
        self.assertNotEqual(failed.returncode, 0); self.assertFalse((self.root / 'lie.ctwallpaper').exists())

    def test_recipe_rejects_nan_bool_and_fractional_pixels(self):
        recipe = dict(fit='cover',x=50,y=50,width=192,height=128,pixelated=False,dim=.35,clockFont='mono')
        for patch in (dict(x=float('nan')),dict(dim=True),dict(width=1.5),dict(pixelated='false')):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                pack_wallpaper(self.art,self.root/'bad.ctwallpaper','Bad',192,128,{**recipe,**patch})

    def theme_directory(self, live):
        directory = self.root / ('live' if live else 'static'); directory.mkdir()
        for level in LEVELS:
            for index, state in enumerate(STATES):
                first = self.image((1536,1024), (60+index*60,120,170,255))
                if live:
                    second = self.image((1536,1024), (70+index*60,150,190,255))
                    encode([first,second], directory / f'{level}_{state}.gif', fps=5)
                else:
                    first.save(directory / f'{level}_{state}.png')
        if live:
            encode([self.image(),self.image(color=(130,90,180,255))],directory/'background.gif',fps=5)
        else:
            self.image().save(directory / 'background.png')
        return directory

    def test_pack_static_and_live_exact_roles_reproducible(self):
        apertures = {level: dict(left=8,right=8,top=17,bottom=13) for level in LEVELS}
        for live in (False,True):
            with self.subTest(live=live):
                directory = self.theme_directory(live)
                one,two = self.root/f'{live}-one.zip',self.root/f'{live}-two.zip'
                info = pack_theme(directory,one,apertures,live)
                pack_theme(directory,two,apertures,live)
                self.assertEqual(one.read_bytes(),two.read_bytes())
                self.assertEqual(info['sha256'],hashlib.sha256(one.read_bytes()).hexdigest())
                with zipfile.ZipFile(one) as archive: self.assertEqual(len(archive.namelist()),10)
                with self.assertRaises(FileExistsError): pack_theme(directory,one,apertures,live)
                (directory/'source.txt').write_text('do not ship')
                with self.assertRaises(ValueError): pack_theme(directory,self.root/'extra.zip',apertures,live)


if __name__ == '__main__':
    unittest.main()
