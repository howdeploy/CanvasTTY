"""Original procedural pixel art for the local Home demo. Python stdlib + FFmpeg, no downloads."""
import math, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'resources/home'
OUT.mkdir(parents=True, exist_ok=True)

def render(kind):
    w,h=(96,96) if kind=='avatar' else (240,135)
    command=['/opt/homebrew/bin/ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24','-video_size',f'{w}x{h}','-framerate','12','-i','pipe:0','-filter_complex','[0:v]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none','-loop','0',str(OUT/f'{kind}.gif')]
    process=subprocess.Popen(command,stdin=subprocess.PIPE)
    for frame in range(48):
        t=frame/48*math.tau
        base=(20,37,49) if kind=='avatar' else (16,30,45)
        data=bytearray(bytes(base)*(w*h))
        def rect(x,y,ww,hh,color):
            for yy in range(max(0,int(y)),min(h,int(y+hh))):
                for xx in range(max(0,int(x)),min(w,int(x+ww))):
                    p=(yy*w+xx)*3;data[p:p+3]=bytes(color)
        if kind=='avatar':
            for x in range(0,96,8):rect(x,0,1,96,(25,46,57))
            for y in range(0,96,8):rect(0,y,96,1,(25,46,57))
            bob=round(math.sin(t)*3)
            # Amber orbital sparks make motion obvious even in a small avatar.
            for k in range(4):
                a=t+k*math.tau/4;rect(46+math.cos(a)*37,46+math.sin(a)*37,4,4,(244,183,85))
            rect(29,78,38,3,(10,24,33))
            rect(24,32+bob,48,36,(101,199,174));rect(29,26+bob,10,8,(101,199,174));rect(57,26+bob,10,8,(101,199,174))
            rect(28,38+bob,40,21,(22,52,61))
            blink=frame in (18,19)
            rect(35,45+bob,6,2 if blink else 7,(197,245,179));rect(55,45+bob,6,2 if blink else 7,(197,245,179))
            rect(43,55+bob,10,2,(244,183,85))
            rect(32,68+bob,10,6,(69,146,135));rect(54,68+bob,10,6,(69,146,135))
            rect(18,47+bob,6,14,(69,146,135));rect(72,43+bob-round(math.sin(t)*6),6,14,(244,183,85))
        else:
            for y in range(0,h,9):rect(0,y,w,1,(21,36,52))
            for x in range(0,w,12):rect(x,0,1,h,(21,36,52))
            for k in range(30):
                x=(k*43+13)%w;y=(k*23+7)%88
                c=(124,174,180) if math.sin(t+k)>0 else (53,81,101)
                rect(x,y,1 if k%3 else 2,1 if k%3 else 2,c)
            rect(186,19,19,19,(241,212,145));rect(181,24,29,9,(241,212,145));rect(195,17,16,15,(16,30,45))
            for k in range(3):
                x=((frame*1.5+k*90)%330)-70;y=57+k*13
                rect(x,y,42,5,(40,65,80));rect(x+8,y-4,26,5,(40,65,80))
            for k in range(20):
                x=k*14;hh=16+(k*7)%17;rect(x,h-hh,12,hh,(25,51,62))
                if k%3:rect(x+3,h-hh+5,3,3,(225,168,83))
            x=int(frame/48*300)-30;y=24+int(frame/48*22)
            for k in range(10):rect(x-k*2,y-k//3,2,1,(45+k*12,74+k*10,88+k*6))
            rect(x,y,3,2,(220,239,204))
        process.stdin.write(data)
    process.stdin.close()
    if process.wait()!=0:raise RuntimeError('FFmpeg GIF export failed')
    print(OUT/f'{kind}.gif')
for kind in ('avatar','clock'):render(kind)
