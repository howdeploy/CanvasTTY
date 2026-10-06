import { readFile } from "node:fs/promises";
import { nativeImage } from "electron";
import type { Size } from "../../../shared/contracts";
import type { HandoffImageOps } from "./HandoffService.ts";
import { clampRect, drawOutline, outlineThickness, type PixelRect } from "./imageRegions.ts";

const OUTLINE = [0xf0, 0x2a, 0xf0, 0xff] as const;
const MAX_PIXELS = 40_000_000;
const DRAWABLE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

export const electronImageOps: HandoffImageOps = {
  canDraw(mimeType, natural) {
    return DRAWABLE_TYPES.has(mimeType) && natural.width > 0 && natural.height > 0 && natural.width * natural.height <= MAX_PIXELS;
  },
  async marked(source, rect, natural) {
    const image = await decode(source, natural);
    if (!image) return null;
    const size = image.getSize();
    const bitmap = Buffer.from(image.toBitmap());
    drawOutline(bitmap, size, scaleRect(rect, natural, size), outlineThickness(size), OUTLINE);
    return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height }).toPNG();
  },
  async crop(source, rect, natural) {
    const image = await decode(source, natural);
    if (!image) return null;
    return image.crop(scaleRect(rect, natural, image.getSize())).toPNG();
  }
};

async function decode(source: string, natural: Size): Promise<Electron.NativeImage | null> {
  if (!(natural.width > 0) || !(natural.height > 0) || natural.width * natural.height > MAX_PIXELS) return null;
  const image = nativeImage.createFromBuffer(await readFile(source));
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width * size.height > MAX_PIXELS) return null;
  const rotated = size.width !== size.height && size.width === natural.height && size.height === natural.width;
  return rotated ? null : image;
}

function scaleRect(rect: PixelRect, natural: Size, size: Size): PixelRect {
  if (natural.width === size.width && natural.height === size.height) return rect;
  const scaleX = size.width / natural.width;
  const scaleY = size.height / natural.height;
  return clampRect({
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY))
  }, size);
}
