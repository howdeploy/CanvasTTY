"""Local pixel-flow layers; scenery, cold metal and per-object exclusions stay fixed."""
from PIL import Image, ImageChops, ImageDraw


def prepare_layers(base, config):
    prepared = []
    heat = Image.new('L', base.size)
    heat.putdata([255 if a and r > 140 and r > g*1.14 and g > b*1.3 else 0
                  for r, g, b, a in base.getdata()])
    for spec in config.get('flows', []):
        mask = Image.new('L', base.size)
        draw = ImageDraw.Draw(mask)
        draw.polygon([tuple(p) for p in spec['polygon']], fill=255)
        for x, y, w, h in spec.get('excludeRects', []):
            draw.rectangle((x, y, x+w-1, y+h-1), fill=0)
        if spec.get('hotOnly', True):
            mask = ImageChops.multiply(mask, heat)
        bounds = mask.getbbox()
        if not bounds:
            raise ValueError('Flow mask contains no drawable pixels')
        axis = spec.get('axis', 'y')
        if axis not in ('x', 'y'):
            raise ValueError('Flow axis must be x or y')
        period, hold = spec.get('period', 12), spec.get('hold', 2)
        if type(period) is not int or not 2 <= period <= 48 or type(hold) is not int or hold < 1:
            raise ValueError('Invalid pixel-flow cadence')
        if config.get('frames', 32) % (period*hold):
            raise ValueError('Flow period must divide the scene loop')
        # Repeat a short strip of the actual lava texture. An integer-period shift
        # closes the loop exactly, with no large reset or displaced shore/rail.
        x, y, r, b = bounds
        patch = base.crop(bounds)
        offset = spec.get('sampleOffset', 0)
        if axis == 'y':
            tile = base.crop((x, y+offset, r, y+offset+period))
        else:
            tile = base.crop((x+offset, y, x+offset+period, b))
        texture = Image.new('RGBA', (patch.width+period, patch.height+period))
        for at in range(0, (texture.height if axis == 'y' else texture.width), period):
            texture.paste(tile, (0, at) if axis == 'y' else (at, 0))
        prepared.append((spec, bounds, mask.crop(bounds), patch, texture))
    return prepared


def apply_layers(frame, base, prepared, config, index, phase):
    for spec, bounds, mask, original, texture in prepared:
        period = spec.get('period', 12)
        step = (index // spec.get('hold', 2) + phase + spec.get('phase', 0)) % period
        # Positive phase moves texture right/down. Pixel sampling only, no warp.
        shift = (period-step) % period
        x, y = (0, shift) if spec.get('axis', 'y') == 'y' else (shift, 0)
        advected = texture.crop((x, y, x+original.width, y+original.height))
        strength = spec.get('strength', .65)
        if not 0 < strength <= 1:
            raise ValueError('Flow strength must be in (0, 1]')
        # Original shading remains in the image; only the local moving texture is mixed.
        frame.paste(Image.blend(original, advected, strength), bounds[:2], mask)
