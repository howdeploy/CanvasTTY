"""Moving parts traced in the 800-unit coordinate system of the approved paintings."""
from math import cos, pi, sin
import cv2
import numpy as np


def excursion(index, keys):
    """Ease between authored light levels, including the return at the loop seam."""
    for (a, u), (b, v) in zip(keys, keys[1:]):
        if a <= index <= b:
            return u + (v-u) * (.5-.5*cos(pi*(index-a)/(b-a)))
    return 0.


class Patch:
    def __init__(self, painting, bounds):
        self.scale = painting.scale
        self.rect = painting.rect(bounds)
        self.rgb = painting.art[self.rect].copy()
        self.y, self.x = np.indices(self.rgb.shape[:2], dtype=np.float32)
        self.left, self.top = self.rect[1].start, self.rect[0].start
        self.x = (self.x + self.left) / self.scale
        self.y = (self.y + self.top) / self.scale

    def polygon(self, points):
        mask = np.zeros(self.rgb.shape[:2], np.uint8)
        points = np.rint(np.array(points)*self.scale - [self.left,self.top]).astype(np.int32)
        cv2.fillPoly(mask, [points], 255, lineType=cv2.LINE_AA)
        return mask.astype(np.float32)/255

    def ellipse(self, x, y, rx, ry):
        return np.clip(1-((self.x-x)/rx)**2-((self.y-y)/ry)**2,0,1)

    def mix(self, frame, image, mask):
        dest = frame[self.rect]
        alpha = mask[:,:,None]
        dest[:] = np.rint(dest*(1-alpha)+image*alpha).clip(0,255).astype(np.uint8)


class HangingSprite(Patch):
    """Reveal only narrow strips behind a silhouette. The suspension point stays fixed."""
    def __init__(self, painting, bounds, outline, pivot, travel, cloth=False):
        super().__init__(painting, bounds)
        self.alpha = self.polygon(outline)
        self.pivot, self.travel, self.cloth = pivot, travel, cloth
        # Only a few edge pixels are ever uncovered. Fill them from outside the
        # silhouette; leave the original pixels behind the opaque interior alone.
        inside = np.uint8(self.alpha>0)*255
        self.back = cv2.inpaint(self.rgb, inside, round(3*self.scale), cv2.INPAINT_TELEA)
        self.sprite = self.rgb.astype(np.float32)*self.alpha[:,:,None]
        self.length = max(y for _,y in outline)-pivot[1]

    def draw(self, frame, phase):
        ox, oy = self.pivot
        if self.cloth:
            depth = np.clip((self.y-oy)/self.length,0,1)**1.65
            dx = self.travel*depth*(.68*np.sin(phase-depth*1.8)+.32*np.sin(phase*2+self.x*.08))
            dy = depth*.9*np.cos(phase+(self.x-ox)*.09)
            sx, sy = self.x-dx, self.y-dy
        else:
            angle = self.travel*(.82*sin(phase)+.18*sin(2*phase))
            sx = ox+(self.x-ox)*cos(angle)+(self.y-oy)*sin(angle)
            sy = oy-(self.x-ox)*sin(angle)+(self.y-oy)*cos(angle)
        mx = (sx*self.scale-self.left).astype(np.float32)
        my = (sy*self.scale-self.top).astype(np.float32)
        alpha = cv2.remap(self.alpha,mx,my,cv2.INTER_LINEAR)
        sprite = cv2.remap(self.sprite,mx,my,cv2.INTER_LINEAR)
        dest = frame[self.rect]
        back = np.where(self.alpha[:,:,None]>0,self.back,dest)
        dest[:] = np.clip(sprite+back*(1-alpha[:,:,None]),0,255).astype(np.uint8)


class AirshipMechanism:
    """A fixed engine housing, a rotor in its own plane and a separate dial hand."""

    def __init__(self, painting):
        self.prepare_rotor(painting)
        self.prepare_gauge(painting)
        self.lamp = Patch(painting,(645,112,697,181))

    def prepare_rotor(self, painting):
        p = self.rotor = Patch(painting,(525,22,710,172))
        # Tracing coordinates on the 925 x 750 detail view. Keep the complete
        # casing, front bearing, suspension ropes and lantern in front of the rotor.
        def contour(vertices):
            return p.polygon([(525+x/5,22+y/5) for x,y in vertices])
        aperture = contour([(137,392),(134,334),(145,282),(167,234),(188,213),
            (353,154),(460,126),(592,91),(622,85),(655,112),(685,146),
            (707,192),(723,240),(733,281),(733,366),(724,431),(704,490),
            (672,548),(627,603),(573,642),(517,662),(460,674),(400,675),
            (339,667),(275,647),(220,614),(181,574),(151,526),(138,471)])
        hub = contour([(316,367),(320,345),(333,327),(351,316),(378,311),
            (402,314),(423,329),(436,350),(442,375),(438,393),(428,415),
            (413,428),(392,435),(367,434),(344,423),(328,407),(319,389)])
        rope = contour([(480,750),(468,747),(676,313),(686,317)])
        rope += contour([(530,750),(544,750),(707,335),(698,334)])
        lamp = contour([(674,281),(697,272),(748,273),(804,287),(925,305),
            (925,346),(803,328),(758,312),(750,349),(765,358),(767,389),
            (751,405),(750,420),(757,430),(749,448),(778,461),(807,496),
            (835,519),(832,539),(818,548),(824,699),(844,715),(841,750),
            (619,750),(621,708),(628,697),(630,549),(616,539),(618,521),
            (638,505),(663,474),(681,459),(697,451),(692,434),(707,423),
            (704,403),(691,392),(689,368),(710,353),(707,317),(678,315)])
        # The lines emerge below the rotor. Above those points the original
        # painting shows the blade in front of the line.
        rope *= np.clip((p.y-109.5)/3,0,1)
        self.opening = aperture*(1-hub)*(1-np.clip(rope+lamp,0,1))
        # Digitized tips and the shaft determine the projective transform of
        # the wheel. Each new blade is cut exclusively from real wood.
        angles = np.radians([90,150,210,270,330,30])
        disc = np.vstack([np.column_stack((np.cos(angles),np.sin(angles))),[0,0]])
        tips = np.float32([(337,661),(141,449),(262,110),(643,130),(743,379),(562,635),(370,370)])
        self.projection,_ = cv2.findHomography(disc,tips,0)
        # Center the projection precisely on the bearing even for a stylized drawing.
        self.projection[:2] += (np.array([372,369])-self.projection[:2,2])[:,None]*self.projection[2]
        to_patch = np.array([[p.scale/5,0,525*p.scale-p.left],
                             [0,p.scale/5,22*p.scale-p.top],[0,0,1]])
        self.projection = to_patch @ self.projection
        self.inverse = np.linalg.inv(self.projection)
        blade = contour([(349,428),(362,429),(385,430),(390,443),(398,627),
            (395,664),(390,670),(367,667),(337,662),(304,653),(276,641),
            (279,622),(300,564),(322,501)])
        # Extend the blade a few pixels under the hub, so it is attached at all angles.
        root = contour([(349,428),(360,396),(384,397),(390,442),(382,448),(345,446)])
        self.blade = np.maximum(blade,root)
        color = p.rgb.astype(np.float32)
        color[root>.5] = np.median(color[(blade>.9)&(p.y<115)],axis=0)
        self.wood = color*self.blade[:,:,None]
        # Recover the radial housing behind the six painted blades. Only these
        # silhouettes are replaced. Gaps retain the original motor and ironwork.
        silhouettes = [
            [(344,426),(393,429),(405,675),(332,667),(269,647)],
            [(129,391),(327,367),(345,405),(145,516),(129,506)],
            [(227,180),(353,149),(385,319),(340,336)],
            [(399,321),(587,85),(617,79),(668,128),(689,183),(431,351)],
            [(431,349),(715,312),(790,312),(798,454),(694,450),(430,396)],
            [(468,467),(492,444),(650,602),(594,647),(531,659)]]
        blade_pixels = np.maximum.reduce([contour(v) for v in silhouettes])
        blade_pixels=cv2.dilate(blade_pixels,np.ones((3,3),np.uint8))*self.opening
        yy,xx=np.indices(p.rgb.shape[:2],dtype=np.float32)
        plane=cv2.perspectiveTransform(np.dstack((xx,yy)),self.inverse)
        radius=np.hypot(plane[:,:,0],plane[:,:,1])
        theta=np.arctan2(plane[:,:,1],plane[:,:,0])
        # The unobstructed lower gap is a source of iron texture at each radius.
        r=np.clip(radius,.31,.98)
        sx=(525+(373+r*(96+18*np.sin(2*theta)))/5)*p.scale-p.left
        sy=(22+(369+r*285)/5)*p.scale-p.top
        iron=cv2.remap(p.rgb,sx.astype(np.float32),sy.astype(np.float32),cv2.INTER_LINEAR)
        distance=cv2.distanceTransform(np.uint8(blade_pixels<.01),cv2.DIST_L2,5)
        restore=np.clip(distance/(10*p.scale),0,1)
        matte=(1-restore*.78)*self.opening
        self.housing=np.rint(p.rgb*(1-matte[:,:,None])+iron*matte[:,:,None]).astype(np.uint8)
        self.illumination=.80+.20*np.cos(theta+2.8)

    def prepare_gauge(self, painting):
        g=self.gauge=Patch(painting,(714,181,756,225))
        cx,cy=734.8,201.9
        dx,dy=g.x-cx,g.y-cy
        along=-dx*.64+dy*.77
        across=dx*.77+dy*.64
        # Separate the numeral at the old pointer's tip. Only the shaft up
        # to the inner scale is erased; degree marks and ink stay on the plate.
        shaft=(along>=0)&(along<11.15)&(np.abs(across)<2.05)
        weight=(along<0)&(along>-9.7)&(np.abs(across)<2.45)
        old=(shaft|weight|(dx*dx+dy*dy<3.4**2)).astype(np.uint8)
        old=cv2.dilate(old,np.ones((3,3),np.uint8))
        # The lower-left numeral touches the old tip. Sample blank enamel
        # laterally at the same height to prevent dark numeral ink bleeding in.
        self.dial=g.rgb.copy()
        color=g.rgb.astype(np.float32)
        enamel=(dx*dx+dy*dy<14**2)&(old==0)&(color[:,:,0]>217)&(color[:,:,1]>138)
        surface=np.dstack((np.ones_like(dx),dx,dy,dx*dx,dy*dy,dx*dy))
        coefficients=np.linalg.lstsq(surface[enamel],color[enamel],rcond=None)[0]
        restored=np.rint(surface@coefficients).clip(0,255).astype(np.uint8)
        join=(along>10)&(along<12)&(np.abs(across)<.8)
        self.dial[(old>0)|join]=restored[(old>0)|join]
        self.pin=g.ellipse(cx,cy,2.65,2.65)
        self.pin=np.clip(self.pin*5,0,1)
        self.pointer=g.polygon([(cx-.61,cy-.35),(cx+.73,cy+.45),(cx-6.6,cy+8.2)])
        self.weight=g.polygon([(cx-.5,cy-.8),(cx+1.4,cy+.35),(cx+6.2,cy-5.2),
                               (cx+6.1,cy-6.65),(cx+5.5,cy-7.1),(cx+4.55,cy-6.55)])
        self.hand_alpha=np.maximum(self.pointer,self.weight)
        # Highlight and enamel patina on the counterweight come from the original.
        self.hand_color=np.array([48,31,23])*self.pointer[:,:,None]
        self.hand_color=np.maximum(self.hand_color,
                                   np.minimum(g.rgb,[101,71,47])*self.weight[:,:,None])
        self.pivot=(cx*g.scale-g.left,cy*g.scale-g.top)

    def draw(self, frame, phase, index):
        p=self.rotor
        base=self.housing.astype(np.float32)
        size=(p.rgb.shape[1],p.rgb.shape[0])
        for i in range(6):
            angle=i*pi/3+phase/3
            c,s=cos(angle),sin(angle)
            rotation=np.array([[c,-s,0],[s,c,0],[0,0,1]])
            matrix=self.projection@rotation@self.inverse
            alpha=cv2.warpPerspective(self.blade,matrix,size)*self.opening
            wood=cv2.warpPerspective(self.wood,matrix,size)
            base=base*(1-alpha[:,:,None])+wood*(self.opening*self.illumination)[:,:,None]
        frame[p.rect]=np.rint(base).clip(0,255).astype(np.uint8)
        g=self.gauge
        size=(g.rgb.shape[1],g.rgb.shape[0])
        matrix=cv2.getRotationMatrix2D(self.pivot,20*sin(phase)+3*sin(2*phase),1)
        alpha=cv2.warpAffine(self.hand_alpha,matrix,size)[:,:,None]
        dial=self.dial*(1-alpha)+cv2.warpAffine(self.hand_color,matrix,size)
        pin=self.pin[:,:,None]
        frame[g.rect]=np.rint(dial*(1-pin)+g.rgb*pin).astype(np.uint8)
        lamp=self.lamp
        amount=excursion(index,[(0,0),(12,.08),(18,.53),(21,.25),(25,.58),(31,.05),(48,0),(60,0)])
        lamp.mix(frame,lamp.rgb*np.array([.46,.34,.38]),amount*lamp.ellipse(670,145,23,31)**.58)


class DeskLights:
    def __init__(self, painting):
        self.table = p = Patch(painting,(390,136,648,271))
        # The lampshade shadows the wall above it. The downward cone illuminates
        # the book spines, mug and desktop, while the monitor emits its own light.
        width = np.maximum(1,22+(p.y-157)*1.01)
        cone = np.clip(1-((p.x-517)/width)**2,0,1)*np.clip((p.y-148)/21,0,1)
        edge = np.clip((268-p.y)/12,0,1)
        monitor = p.polygon([(589,130),(646,124),(646,236),(580,238)])
        self.spill = cone*edge*(1-monitor)
        self.bulb = p.polygon([(489,152),(496,149),(508,149),(523,151),(540,157),
                               (550,164),(549,168),(539,170),(521,168),(504,164),(489,158)])
        self.neon = n = Patch(painting,(456,10,515,136))
        level = n.rgb.max(2).astype(np.float32)
        self.tubes = np.clip((level-65)/125,0,1)*n.polygon([(458,13),(511,14),(511,130),(459,134)])

    def draw(self, frame,index):
        p = self.table
        off = excursion(index,[(0,0),(12,0),(16,.45),(19,.32),(23,1),(30,1),(36,0),(60,0)])
        mask = np.maximum(self.bulb,self.spill*.83)
        p.mix(frame,p.rgb*np.array([.33,.34,.48]),off*mask)
        n = self.neon
        dip = excursion(index,[(0,0),(40,0),(43,.70),(46,.18),(49,.5),(53,0),(60,0)])
        n.mix(frame,n.rgb*np.array([.37,.29,.49]),dip*self.tubes)


class NoodleShop:
    def __init__(self, painting):
        self.lantern = HangingSprite(painting,(403,85,503,232),
            [(450,91),(457,93),(463,101),(467,103),(467,109),(476,115),(483,123),
             (489,137),(491,153),(491,186),(488,198),(482,208),(473,215),(466,217),
             (466,225),(441,227),(440,217),(431,214),(422,205),(418,196),
             (414,182),(414,145),(417,132),(424,120),(433,114),(437,111),
             (437,104),(442,102),(445,94)],(452,91),.038)
        self.curtains = []
        for left,right,top,bottom,tilt in [(526,576,135,208,4),(577,628,125,203,4),(631,690,115,198,6)]:
            outline = [(left+2,top),(right,top-9),(right-2,bottom-tilt),(left,bottom)]
            self.curtains.append(HangingSprite(painting,(left-5,top-12,right+5,bottom+4),
                                                 outline,(left,top-5),2.8,cloth=True))
        self.bulbs = [Patch(painting,(x-13,y-17,x+13,y+17)) for x,y in [(544,116),(603,102),(664,87)]]
        self.sign = p = Patch(painting,(698,59,767,129))
        rgb = p.rgb.astype(float)
        self.tubes = np.clip((rgb[:,:,0]+rgb[:,:,2] - 270)/150,0,1)
        self.tubes *= p.polygon([(700,71),(759,60),(765,108),(751,121),(704,125)])

    def draw(self, frame,phase,index):
        self.lantern.draw(frame,phase)
        for i,curtain in enumerate(self.curtains):
            curtain.draw(frame,phase+i*.55)
        for i,p in enumerate(self.bulbs):
            x,y = [(544,116),(603,102),(664,87)][i]
            dim = excursion((index+13*i)%60,[(0,0),(12,0),(16,.52),(20,.17),(23,.34),(28,0),(60,0)])
            p.mix(frame,p.rgb*np.array([.52,.39,.30]),dim*p.ellipse(x,y,11,13)**.55)
        p = self.sign
        dip = excursion(index,[(0,0),(35,0),(38,.55),(41,.15),(45,.41),(49,0),(60,0)])
        # A short local dropout rolls through the cat glyph only.
        band = np.exp(-((p.y-(64+(index-35)*4.3))/4)**2)
        p.mix(frame,p.rgb*np.array([.20,.18,.40]),dip*(.55+.45*band)*self.tubes)
