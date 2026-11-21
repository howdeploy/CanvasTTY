"""Verify the shipped loop against the registered art, including stationary regions."""
import base64
import io
import json
from pathlib import Path
import unittest

import numpy as np
from PIL import Image

ENGINE = Path(__file__).resolve().parents[1]
ASSETS = ENGINE.parent / 'assets'


class ThemeSceneTests(unittest.TestCase):
    def inspect_loop(self, theme, smoke=()):
        profile = ASSETS / (theme + '-profile')
        entry = json.loads((profile / 'preset.json').read_bytes())['wallpapers']['canvas']
        wallpaper = json.loads((profile / entry['file']).read_bytes())
        image = Image.open(io.BytesIO(base64.b64decode(wallpaper['source']['base64'])))
        self.assertEqual(image.n_frames, 60)
        self.assertEqual(image.info['loop'], 0)
        with Image.open(ENGINE / 'art' / 'clean-plates' / (theme + '.png')) as plate:
            original = np.asarray(plate.convert('RGB').resize(image.size, Image.Resampling.LANCZOS))
        low = np.full_like(original, 255)
        high = np.zeros_like(original)
        clear = np.zeros(original.shape[:2], dtype=np.uint8)
        for index in range(image.n_frames):
            image.seek(index)
            rgb = np.asarray(image.convert('RGB'))
            for box, tint in smoke:
                # Translucent smoke may tint any backdrop pixel. A translated
                # mullion or shelf cannot be explained by this alpha composite.
                base = self.region(original, box).astype(float)
                change = self.region(rgb, box).astype(float) - base
                axis = np.array(tint) - base
                alpha = (axis*change).sum(2) / np.maximum(1, (axis*axis).sum(2))
                residual = change - np.clip(alpha, 0, 1)[:, :, None]*axis
                self.assertLess(np.abs(residual).max(), 1.8, (theme, index, box))
            np.minimum(low, rgb, out=low)
            np.maximum(high, rgb, out=high)
            clear += np.all(rgb == original, axis=2)
        return (high-low).max(axis=2), clear

    def region(self, pixels, box):
        scale = pixels.shape[1] / 800
        left, top, right, bottom = [round(value*scale) for value in box]
        return pixels[top:bottom, left:right]

    def test_ear_tips_sun_and_solid_geometry_are_stationary(self):
        scenes = {
            'kisa-nocturne': (
                [(590, 271, 621, 293), (336, 62, 413, 79), (512, 21, 526, 82)],
                [(630, 275, 674, 298), (250, 100, 282, 115), (306, 122, 340, 136),
                 (470, 22, 503, 120), (502, 151, 541, 167), (468, 221, 527, 258)]),
            'steampunk-airship': (
                [(75, 215, 101, 235), (23, 338, 505, 421), (595, 94, 601, 98), (544, 59, 555, 63)],
                [(38, 52, 100, 83), (150, 80, 353, 104), (555, 85, 585, 112),
                 (724, 195, 741, 213), (657, 132, 684, 158)]),
        }
        for theme, (fixed, animated) in scenes.items():
            with self.subTest(theme=theme):
                smoke = [((306, 122, 340, 136), (193, 171, 204)),
                         ((363, 103, 383, 144), (207, 184, 215))] if theme == 'kisa-nocturne' else []
                spread, _ = self.inspect_loop(theme, smoke)
                for box in fixed:
                    self.assertEqual(self.region(spread, box).max(), 0, box)
                for box in animated:
                    self.assertGreater(np.count_nonzero(self.region(spread, box)>3), 10, box)

    def test_airship_cloud_field_and_dial_scale(self):
        profile = ASSETS / 'steampunk-airship-profile'
        entry = json.loads((profile/'preset.json').read_text())['wallpapers']['canvas']
        data = json.loads((profile/entry['file']).read_bytes())['source']['base64']
        image = Image.open(io.BytesIO(base64.b64decode(data)))
        original = np.asarray(image.convert('RGB'))
        scale = image.width/800
        # At peak wind both sides of the old patch edges must sample the same
        # continuous cloud field. Include the distant bank below the old boxes.
        image.seek(15)
        peak = np.asarray(image.convert('RGB'))
        for x,y in [(100,68),(255,52),(381,97),(448,143),(225,266),(415,270)]:
            x,y = round(x*scale),round(y*scale)
            self.assertTrue(np.array_equal(peak[y-3:y+4,x-8:x+9],
                                           original[y-3:y+4,x-13:x+4]))
        # Numerals surround a clean field. Within it all dark ink must belong
        # to the one connected hand and bearing, throughout the encoded loop.
        import cv2
        dial = self.region(original,(714,181,756,225))
        yy,xx = np.indices(dial.shape[:2])
        radius = np.hypot((xx+round(714*scale))/scale-734.8,
                          (yy+round(181*scale))/scale-201.9)
        for index in range(image.n_frames):
            image.seek(index)
            current = self.region(np.asarray(image.convert('RGB')),(714,181,756,225))
            self.assertTrue(np.array_equal(current[radius>12.5],dial[radius>12.5]),index)
            dark = np.uint8((current[:,:,0]<130)&(radius<10.5))
            count,_,areas,_ = cv2.connectedComponentsWithStats(dark)
            self.assertEqual(sum(areas[i,cv2.CC_STAT_AREA]>=3 for i in range(1,count)),1,index)

    def test_kisa_window_layers(self):
        path = ENGINE/'art'/'clean-plates'/'kisa-nocturne.png'
        image = np.asarray(Image.open(path).convert('RGB')).astype(float)
        left = np.median(self.region(image,(226,30,230,34)),axis=(0,1))
        right = np.median(self.region(image,(350,32,354,36)),axis=(0,1))
        self.assertLess(np.abs(left-right).max(),28)
        # Samples on the crescent itself, on opposite sides of a foreground blind.
        scale = image.shape[1]/800
        red = lambda x,y: image[round(y*scale),round(x*scale),0]
        self.assertLess(red(369,45.7),85)
        self.assertGreater(red(369,49),180)

    def test_kisa_blind_edges_continue_across_the_entire_moon_pane(self):
        # Each metal lip must stay on its projected straight line on both sides
        # of the moon. Check the exported wallpaper, including its final resize.
        profile = ASSETS / 'kisa-nocturne-profile'
        entry = json.loads((profile/'preset.json').read_text())['wallpapers']['canvas']
        package = json.loads((profile/entry['file']).read_bytes())
        with Image.open(io.BytesIO(base64.b64decode(package['source']['base64']))) as image:
            scale = image.width/800
            x = np.arange(round(348*scale), round(441*scale))
            upper = 31.62 + .214*(x/scale-356)
            lower = 66.52 + .136*(x/scale-356)
            for index in (0, 20, 40, 59):
                image.seek(index)
                red = np.asarray(image.convert('RGB'))[:,:,0]
                for level in (.25, .5, .75):
                    edge = upper + level*(lower-upper)
                    ridge = np.rint(edge*scale).astype(int)
                    face = np.rint((edge+1.8)*scale).astype(int)
                    self.assertGreater(red[ridge,x].min(), 85, (index, level))
                    self.assertLess(red[face,x].max(), 55, (index, level))

    def test_drops_and_impacts_reveal_clean_plate_each_cycle(self):
        for theme in ('cyberpunk-noodle-bar', 'brutalist-monolith'):
            with self.subTest(theme=theme):
                steam = [((655, 215, 675, 262), (232, 189, 180))] if theme == 'cyberpunk-noodle-bar' else []
                spread, clear = self.inspect_loop(theme, steam)
                for box in ((8, 40, 298, 262), (20, 394, 298, 445)):
                    self.assertGreater(self.region(clear, box).min(), 15, box)
                    self.assertGreater(np.count_nonzero(self.region(spread, box)>3), 500, box)
                if theme == 'cyberpunk-noodle-bar':
                    for box in [(331,269,349,278), (203,305,321,335), (346,410,405,438),
                                (418,158,484,206), (577,181,619,199), (534,105,551,126),
                                (706,71,755,119)]:
                        self.assertGreater(np.count_nonzero(self.region(spread,box)>3),50,box)
                    self.assertEqual(self.region(spread, (694, 183, 732, 210)).max(), 0)
                    self.assertGreater(np.count_nonzero(self.region(spread, (655, 215, 675, 262))>3), 100)


if __name__ == '__main__':
    unittest.main()
