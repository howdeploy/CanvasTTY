"""Composite looping foreground elements on registered, rain- and smoke-free plates.

Positions are measured on an 800-unit-wide artboard. A frame always starts from
the same RGB plate. Only isolated sprites may move; glass and masonry are never
used as displacement textures.
"""
from math import cos, pi, sin, tau
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from scene_details import AirshipMechanism, DeskLights, NoodleShop

FRAMES = 60
CROPS = {
    'kisa-nocturne': ((152, 32, 338, 218), (285, 42, 516, 172)),
    'steampunk-airship': ((549, 62, 797, 310), (288, 142, 750, 403)),
    'brutalist-monolith': ((420, 40, 756, 376), (272, 119, 794, 413)),
    'cyberpunk-noodle-bar': ((393, 43, 635, 285), (360, 60, 788, 301)),
}


class Painting:
    def __init__(self, slug, source):
        self.slug = slug
        self.width, self.height = (1920, 784) if slug == 'kisa-nocturne' else (1536, 864)
        self.scale = self.width / 800
        image = Image.open(source).convert('RGB')
        if abs(image.width / image.height - self.width / self.height) > .02:
            raise ValueError(f'Incorrect clean plate dimensions for {slug}')
        self.art = np.array(image.resize((self.width, self.height), Image.Resampling.LANCZOS))
        if slug == 'steampunk-airship':
            self.prepare_sky()
            self.mechanism = AirshipMechanism(self)
        if slug == 'kisa-nocturne':
            self.desk = DeskLights(self)
            self.prepare_cat()
            ratio = self.width / image.width
            blink = Image.open(Path(source).with_name('kisa-blink.png')).convert('RGBA')
            self.eyelid = np.array(blink.resize(tuple(round(n*ratio) for n in blink.size), Image.Resampling.LANCZOS))
            self.eye_origin = (round(608*ratio), round(240*ratio))
        rng = np.random.default_rng(73)
        noodle = slug == 'cyberpunk-noodle-bar'
        self.drops = []
        if noodle:
            self.shop = NoodleShop(self)
            # Left curb and outer edge of the opposite sidewalk converge at
            # the far end. Sample in projection so distant streaks stay dense.
            for count, near, far in [(90,267,294),(110,294,348),(162,348,449)]:
                for _ in range(count):
                    y = rng.uniform(near,far)
                    left = np.interp(y,[267,280,303,346,449],[337,212,133,0,0])
                    right = np.interp(y,[267,302,337,350,449],[352,358,349,347,495])
                    depth = (y-267)/182
                    x = rng.uniform(left+2,right-2)
                    self.drops.append((x,y,rng.random(),int(rng.integers(3,6)),depth))
        else:
            for _ in range(190):
                x = rng.uniform(1,799)
                y = rng.uniform(365,449)
                self.drops.append((x,y,rng.random(),int(rng.integers(3,6)),rng.uniform(.58,1)))

    def rect(self, box):
        x0, y0, x1, y1 = (round(n*self.scale) for n in box)
        return np.s_[y0:y1, x0:x1]

    def prepare_sky(self):
        # The matte follows the ship and the deck. Distance from foreground
        # silhouettes eases wind to zero, keeping rigging and the sun registered.
        self.sky_rect = self.rect((0, 0, 800, 349))
        sky = np.zeros(self.art[self.sky_rect].shape[:2], np.uint8)
        outline = [(0,0),(356,0),(388,20),(424,32),(439,40),(468,52),
                   (499,63),(505,80),(506,105),(519,121),(543,130),(557,147),
                   (579,161),(607,169),(619,170),(548,303),(526,348),(0,348)]
        def points(coords):
            return np.rint(np.array(coords)*self.scale).astype(np.int32)
        cv2.fillPoly(sky,[points(outline)],255)
        # The rail rises towards the vanishing point on the right.
        cv2.fillPoly(sky,[points([(0,337),(94,326),(228,314),(370,308),
                                  (490,302),(550,299),(550,350),(0,350)])],0)
        # Sky continues past the ropes to the boiler.
        cv2.fillPoly(sky,[points([(619,171),(645,176),(650,190),(661,201),
                                  (681,202),(681,209),(654,211),(644,225),
                                  (644,249),(630,249),(629,301),(555,300)])],255)
        for start,end in [((623,168),(540,321)),((642,168),(583,318))]:
            cv2.line(sky,tuple(points([start])[0]),tuple(points([end])[0]),0,round(4*self.scale))
        # The sun remains a stationary light source. Its falloff is radial.
        cv2.ellipse(sky,tuple(points([(89,225)])[0]),tuple(points([(38,27)])[0]),
                    0,0,360,0,-1)
        distance = cv2.distanceTransform(sky,cv2.DIST_L2,5)/self.scale
        u = np.clip(distance/18,0,1)
        self.wind = u*u*(3-2*u)
        self.sky_y,self.sky_x = np.indices(sky.shape,dtype=np.float32)

    def sky(self, frame, phase):
        # Whole painted sky drifts by native pixels. Each integer position is
        # held until the next pixel step, as in the rest of the pixel animation.
        offset = round(5*sin(phase))
        if offset:
            frame[self.sky_rect] = cv2.remap(self.art[self.sky_rect],
                self.sky_x-offset*self.wind,self.sky_y,cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_REFLECT_101)

    def prepare_cat(self):
        # The bright line at the top of the cat's back gives an exact silhouette.
        # Both ear tips, the head and the tail are outside this torso patch.
        self.cat_rect = self.rect((625, 273, 679, 309))
        body = self.art[self.cat_rect]
        h, w = body.shape[:2]
        ridge = np.argmax(body[:round(h*.72)].max(2) > 150, axis=0)
        valid = (body[:round(h*.72)].max(2) > 150).any(0)
        mask = ((np.arange(h)[:, None] >= ridge) & valid).astype(np.float32)
        side = np.sin(np.linspace(0, pi, w))**2
        self.cat_mask = mask
        self.cat_rise = (side[None, :]*np.clip((h-1-np.arange(h)[:, None])/(h*.52), 0, 1)).astype(np.float32)

    def cat(self, frame, phase):
        body = self.art[self.cat_rect]
        h, w = body.shape[:2]
        y, x = np.indices((h, w), dtype=np.float32)
        sy = y + 1.35*self.scale*(.5-.5*cos(2*phase))*self.cat_rise
        mask = cv2.remap(self.cat_mask, x, sy, cv2.INTER_LINEAR)[:, :, None]
        color = cv2.remap(body*self.cat_mask[:, :, None], x, sy, cv2.INTER_LINEAR)
        frame[self.cat_rect] = np.uint8(np.clip(color + body*(1-mask), 0, 255))

    def plume(self, frame, origin, width, height, phase, tint, exhale=False):
        # Density is evaluated on a transparent patch. Background pixels remain
        # registered even where a translucent wisp passes in front of a window bar.
        ox, oy = origin
        rect = self.rect((ox-width*.50, oy-height-2, ox+width*1.25, oy+2))
        patch = frame[rect]
        y, x = np.indices(patch.shape[:2], dtype=np.float32)
        x = x/self.scale - width*.5
        y = height+2-y/self.scale
        if exhale:
            t = x/width
            distance = y - height*(.15*t + .84*t*t) - 1.9*np.sin(9*t-phase)*t
            gate = np.clip(np.sin(phase-.25-2*t)*1.55, 0, 1)
        else:
            t = y/height
            distance = x - width*t*(.22+.17*np.sin(8*t-phase)+.12*np.sin(13*t-2*phase))
            gate = .82 + .18*np.sin(13*t-2*phase)
        u = np.clip(t, 0, 1)
        sigma = (.4 + (1.9 if exhale else 2.8)*u)*(1+.23*np.sin(12*u-phase))
        strand = np.exp(-.5*(distance/sigma)**2)
        haze = np.exp(-.5*((distance-1.8*u)/(2.4*sigma))**2)
        density = (.41*strand+.13*haze)*np.minimum(1, u*21)*(1-u)**.6*gate
        alpha = density[:, :, None]
        frame[rect] = np.uint8(patch*(1-alpha)+np.array(tint)*alpha)

    def glow(self, frame, box, phase, color, strength):
        rect = self.rect(box)
        patch = frame[rect]
        y, x = np.indices(patch.shape[:2], dtype=np.float32)
        h, w = x.shape
        falloff = np.clip(1-((2*x/w-1)**2+(2*y/h-1)**2), 0, 1)**2
        light = strength*(.5+.5*cos(phase))*falloff[:, :, None]
        frame[rect] = np.uint8(np.clip(patch+np.array(color)*light, 0, 255))

    def rain(self, frame, index):
        wet = frame.copy()
        alley = self.slug == 'cyberpunk-noodle-bar'
        for x, y, start, cycles, depth in self.drops:
            phase = (index/FRAMES*cycles+start) % 1
            if phase < .68:
                height = 100+312*depth if alley else 465
                lift = (.68-phase)/.68*height
                px = x+lift*(.034 if alley else .105)
                py = y-lift
                if py < -2 or (alley and px>390 and py<338):
                    continue
                p = round(px*self.scale), round(py*self.scale)
                if alley:
                    length = round(3+13*depth)
                    ground = frame[p[1],p[0]].astype(float) if p[1]>=0 else np.zeros(3)
                    ink = tuple(np.rint(ground+(np.array([162,178,211])-ground)*(.45+.40*depth)).astype(int).tolist())
                else:
                    length,ink = round(11*depth),(146,154,174)
                cv2.line(wet,(p[0]+int(not alley),p[1]-length),p,ink,1,cv2.LINE_AA)
            else:
                age = (phase-.68)/.32
                cx, cy = round(x*self.scale), round(y*self.scale)
                c = frame[cy, cx].astype(float)
                scale = .22+.78*depth if alley else depth
                ink = tuple(np.rint(c + (210-c)*(.72*(1-age)*scale)).astype(int).tolist())
                r = (1+10*age)*scale*self.scale
                cv2.ellipse(wet,(cx,cy),(round(r),max(1,round((.12+.11*depth if alley else .23)*r))),0,0,360,ink,1,cv2.LINE_AA)
        cv2.addWeighted(frame, .62, wet, .38, 0, dst=frame)

    def render(self, index):
        phase = tau * index / FRAMES
        frame = self.art.copy()
        if self.slug == 'steampunk-airship':
            self.sky(frame, phase)
            self.mechanism.draw(frame, phase, index)
        elif self.slug == 'kisa-nocturne':
            self.cat(frame, phase)
            opacity = {39: .35, 40: 1., 41: .48}.get(index % FRAMES, 0)
            if opacity:
                x, y = self.eye_origin
                h, w = self.eyelid.shape[:2]
                patch = frame[y:y+h, x:x+w]
                alpha = self.eyelid[:, :, 3:4]*(opacity/255)
                patch[:] = self.eyelid[:, :, :3]*alpha + patch*(1-alpha)
            self.plume(frame, (369, 145), 19, 45, phase, (207, 184, 215))
            self.plume(frame, (306, 135), 40, 15, phase, (193, 171, 204), exhale=True)
            self.desk.draw(frame,index)
        else:
            self.rain(frame, index)
            if self.slug == 'cyberpunk-noodle-bar':
                self.plume(frame, (662, 264), 20, 49, phase, (232, 189, 180))
                self.shop.draw(frame,phase,index)
            else:
                self.glow(frame, (484, 250, 526, 315), phase, (22, 20, 16), .42)
        return Image.fromarray(frame)
