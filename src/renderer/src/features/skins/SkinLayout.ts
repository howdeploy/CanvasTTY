import type { SkinRect, TiledFrame } from "./skinSchema";
import type { PixelSkinThemeId } from "./skinCatalog";
import type { PixelSkinDetailLevel } from "./skinCatalog";
import type { PixelSkinAperture, PixelSkinControlPlaque, PixelSkinPreferredDetail, PixelTerminalBorderSkinId } from "../../../../shared/contracts";

export interface SkinDrawOperation { source: SkinRect; destination: SkinRect }
export type SkinDetailLevel = PixelSkinDetailLevel;

export interface PixelSkinSurfaceBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PixelSkinSurfaceInsetProfile {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PixelSkinControlLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  buttonSize: number;
  fontSize: number;
}

export interface PixelSkinArtworkBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type PlaqueRect = readonly [x: number, y: number, width: number, height: number];

const CONTROL_PLAQUES: Record<string, Record<"minimal" | "detailed" | "master", PlaqueRect>> = {
  sakura: { minimal: [72.5, 7.3, 16, 3.5], detailed: [70.5, 9.1, 16, 4.6], master: [69.4, 9.1, 17.9, 5.3] },
  matrix: { minimal: [75, 7.9, 17, 4], detailed: [75, 7.9, 17, 4], master: [75.5, 6.1, 16.5, 4.6] },
  "forest-cabin": { minimal: [77.4, 9.5, 16, 3.8], detailed: [76.5, 9.3, 15.5, 5.2], master: [76, 14.5, 16.5, 6.1] },
  "gold-black": { minimal: [79, 10, 14, 3.4], detailed: [79, 9.9, 14.2, 3.8], master: [75, 9.2, 13, 3.8] },
  cat: { minimal: [74, 10, 19, 3.9], detailed: [70, 9.3, 23.5, 4.7], master: [69.2, 9.4, 24.9, 5] },
  "gothic-eclipse": { minimal: [77.8, 7.5, 14.5, 6], detailed: [77.8, 7.5, 14.5, 6], master: [77.8, 7.5, 14.5, 6] }
};

// Source-space bounds of the visible art, including a few pixels of breathing room.
// The generated PNG sheets have uneven transparent margins that must not become card geometry.
const ART_BOUNDS: Record<PixelSkinThemeId, Record<"minimal" | "detailed" | "master", readonly [number, number, number, number]>> = {
  sakura: { minimal: [28, 66, 1507, 950], detailed: [23, 71, 1509, 921], master: [9, 5, 1527, 971] },
  matrix: { minimal: [32, 69, 1504, 911], detailed: [25, 64, 1510, 919], master: [10, 37, 1526, 939] },
  "forest-cabin": { minimal: [35, 84, 1500, 934], detailed: [21, 66, 1518, 881], master: [0, 3, 1536, 1002] },
  "gold-black": { minimal: [19, 78, 1516, 931], detailed: [0, 54, 1536, 968], master: [4, 35, 1536, 968] },
  cat: { minimal: [29, 85, 1506, 887], detailed: [18, 59, 1523, 892], master: [13, 47, 1525, 941] },
  "gothic-eclipse": { minimal: [0, 0, 1536, 1024], detailed: [0, 0, 1536, 1024], master: [0, 0, 1536, 1024] }
};

export function pixelSkinArtworkBounds(
  theme: PixelSkinThemeId | PixelTerminalBorderSkinId,
  detail: SkinDetailLevel
): PixelSkinArtworkBounds {
  const source = ART_BOUNDS[theme as PixelSkinThemeId]?.[detail];
  if (!source) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: source[0] / 1536,
    y: source[1] / 1024,
    width: (source[2] - source[0]) / 1536,
    height: (source[3] - source[1]) / 1024
  };
}

function mapArtworkX(percent: number, bounds: PixelSkinArtworkBounds, width: number): number {
  return width * (percent / 100 - bounds.x) / bounds.width;
}

function mapArtworkY(percent: number, bounds: PixelSkinArtworkBounds, height: number): number {
  return height * (percent / 100 - bounds.y) / bounds.height;
}

/** Plaque bounds are measured from the artwork, in image percentages. */
export function pixelSkinControlLayout(
  theme: PixelSkinThemeId | PixelTerminalBorderSkinId,
  detail: SkinDetailLevel,
  width: number,
  height: number,
  plaque?: PixelSkinControlPlaque,
  buttonCount = 3
): PixelSkinControlLayout {
  const [x, y, plaqueWidth, plaqueHeight] = plaque
    ? [plaque.left, plaque.top, plaque.width, plaque.height]
    : CONTROL_PLAQUES[theme]?.[detail] ?? [73, 7, 18, 6];
  const art = pixelSkinArtworkBounds(theme, detail);
  const controlWidth = width * plaqueWidth / 100 / art.width;
  const controlHeight = height * plaqueHeight / 100 / art.height;
  const count = Math.max(1, Math.ceil(buttonCount));
  const buttonSize = Math.max(0, Math.min(22, controlHeight - 4, (controlWidth - 8 - 4 * (count - 1)) / count));
  return {
    left: mapArtworkX(x, art, width),
    top: mapArtworkY(y, art, height),
    width: controlWidth,
    height: controlHeight,
    buttonSize,
    fontSize: buttonSize * 0.7
  };
}

export function pixelSkinSurfaceInsetProfile(
  theme: PixelSkinThemeId | PixelTerminalBorderSkinId,
  detail: SkinDetailLevel,
  aperture?: PixelSkinAperture
): PixelSkinSurfaceInsetProfile {
  if (aperture) return aperture;
  if (theme === "matrix" && detail === "minimal") {
    return { left: 6, right: 6, top: 12, bottom: 16 };
  }
  if (theme === "sakura" && detail === "minimal") {
    return { left: 6, right: 6, top: 12, bottom: 16 };
  }
  if (theme === "sakura" && detail === "detailed") {
    return { left: 7, right: 7, top: 16, bottom: 27 };
  }
  if (theme === "forest-cabin" && detail === "detailed") {
    return { left: 7, right: 7, top: 14, bottom: 16 };
  }
  if (theme === "sakura" && detail === "master") {
    return { left: 12, right: 12, top: 16, bottom: 14 };
  }
  if (theme === "matrix" && detail === "master") {
    return { left: 7, right: 7, top: 15, bottom: 13 };
  }
  if (theme === "forest-cabin" && detail === "master") {
    return { left: 15, right: 16, top: 24, bottom: 22 };
  }
  if (theme === "gold-black" && detail === "master") {
    return { left: 12, right: 12, top: 16, bottom: 12 };
  }
  if (theme === "gothic-eclipse") {
    if (detail === "minimal") return { left: 10.5, right: 10.5, top: 22, bottom: 12 };
    if (detail === "detailed") return { left: 15, right: 16, top: 22, bottom: 12 };
    return { left: 17, right: 16, top: 23, bottom: 11 };
  }
  if (theme === "cat" && detail === "master") {
    return { left: 14.5, right: 8, top: 18.5, bottom: 20 };
  }
  if (theme === "cat" && detail === "detailed") {
    return { left: 8, right: 8, top: 18, bottom: 21 };
  }
  if (theme === "cat" && detail === "minimal") {
    return { left: 8.5, right: 8, top: 17, bottom: 21 };
  }
  if (detail === "detailed") return { left: 7, right: 7, top: 14, bottom: 12 };
  return { left: 6, right: 6, top: 12, bottom: 10 };
}

export function pixelSkinSurfaceBounds(
  theme: PixelSkinThemeId | PixelTerminalBorderSkinId,
  detail: SkinDetailLevel,
  width: number,
  height: number,
  _headerHeight = 26,
  aperture?: PixelSkinAperture
): PixelSkinSurfaceBounds {
  const profile = pixelSkinSurfaceInsetProfile(theme, detail, aperture);
  const art = pixelSkinArtworkBounds(theme, detail);
  return {
    left: mapArtworkX(profile.left, art, width),
    right: mapArtworkX(100 - profile.right, art, width),
    top: mapArtworkY(profile.top, art, height),
    bottom: mapArtworkY(100 - profile.bottom, art, height)
  };
}

export function skinDetailLevel(
  preferred: PixelSkinPreferredDetail,
  forceMasterDetail: boolean
): SkinDetailLevel {
  return forceMasterDetail ? "master" : preferred;
}

/** Nine-slice rendering keeps ornate corners at a uniform scale while the rails absorb resize. */
export function layoutNineSliceFrame(
  frameWidth: number,
  frameHeight: number,
  width: number,
  height: number,
  cornerWidth = 220,
  cornerHeight = 220
): SkinDrawOperation[] {
  if (![frameWidth, frameHeight, width, height, cornerWidth, cornerHeight].every(Number.isFinite)
    || frameWidth <= 0 || frameHeight <= 0 || width <= 0 || height <= 0
    || cornerWidth <= 0 || cornerHeight <= 0) return [];

  const sourceCornerWidth = Math.min(cornerWidth, frameWidth / 2);
  const sourceCornerHeight = Math.min(cornerHeight, frameHeight / 2);
  const scale = Math.min(width / frameWidth, height / frameHeight);
  const destCornerWidth = sourceCornerWidth * scale;
  const destCornerHeight = sourceCornerHeight * scale;
  const middleSourceWidth = frameWidth - 2 * sourceCornerWidth;
  const middleSourceHeight = frameHeight - 2 * sourceCornerHeight;
  const middleDestWidth = width - 2 * destCornerWidth;
  const middleDestHeight = height - 2 * destCornerHeight;

  const operation = (source: SkinRect, destination: SkinRect): SkinDrawOperation => ({ source, destination });
  return [
    operation(
      { x: sourceCornerWidth, y: 0, width: middleSourceWidth, height: sourceCornerHeight },
      { x: destCornerWidth, y: 0, width: middleDestWidth, height: destCornerHeight }
    ),
    operation(
      { x: sourceCornerWidth, y: frameHeight - sourceCornerHeight, width: middleSourceWidth, height: sourceCornerHeight },
      { x: destCornerWidth, y: height - destCornerHeight, width: middleDestWidth, height: destCornerHeight }
    ),
    operation(
      { x: 0, y: sourceCornerHeight, width: sourceCornerWidth, height: middleSourceHeight },
      { x: 0, y: destCornerHeight, width: destCornerWidth, height: middleDestHeight }
    ),
    operation(
      { x: frameWidth - sourceCornerWidth, y: sourceCornerHeight, width: sourceCornerWidth, height: middleSourceHeight },
      { x: width - destCornerWidth, y: destCornerHeight, width: destCornerWidth, height: middleDestHeight }
    ),
    operation(
      { x: 0, y: 0, width: sourceCornerWidth, height: sourceCornerHeight },
      { x: 0, y: 0, width: destCornerWidth, height: destCornerHeight }
    ),
    operation(
      { x: frameWidth - sourceCornerWidth, y: 0, width: sourceCornerWidth, height: sourceCornerHeight },
      { x: width - destCornerWidth, y: 0, width: destCornerWidth, height: destCornerHeight }
    ),
    operation(
      { x: 0, y: frameHeight - sourceCornerHeight, width: sourceCornerWidth, height: sourceCornerHeight },
      { x: 0, y: height - destCornerHeight, width: destCornerWidth, height: destCornerHeight }
    ),
    operation(
      { x: frameWidth - sourceCornerWidth, y: frameHeight - sourceCornerHeight, width: sourceCornerWidth, height: sourceCornerHeight },
      { x: width - destCornerWidth, y: height - destCornerHeight, width: destCornerWidth, height: destCornerHeight }
    )
  ];
}

function pushTiles(
  operations: SkinDrawOperation[], source: SkinRect,
  start: number, end: number, fixed: number, tileLength: number, thickness: number,
  horizontal: boolean
): void {
  for (let offset = start; offset < end;) {
    const length = Math.min(tileLength, end - offset);
    const ratio = length / tileLength;
    operations.push(horizontal
      ? { source: { ...source, width: source.width * ratio }, destination: { x: offset, y: fixed, width: length, height: thickness } }
      : { source: { ...source, height: source.height * ratio }, destination: { x: fixed, y: offset, width: thickness, height: length } });
    offset += length;
  }
}

/** Corners keep their proportions; only repeated edge tiles absorb resize. */
export function layoutTiledFrame(frame: TiledFrame, width: number, height: number): SkinDrawOperation[] {
  if (width <= 0 || height <= 0) return [];
  const cornerWidth = Math.min(frame.cornerWidth, width / 2);
  const cornerHeight = Math.min(frame.cornerHeight, height / 2);
  const thickness = Math.min(frame.edgeThickness, cornerWidth, cornerHeight);
  const [top, right, bottom, left] = frame.edges;
  const [topOffset, rightOffset, bottomOffset, leftOffset] = frame.edgeOffsets;
  const operations: SkinDrawOperation[] = [];
  pushTiles(operations, top, cornerWidth, width - cornerWidth, topOffset, frame.tileLength, thickness, true);
  pushTiles(operations, bottom, cornerWidth, width - cornerWidth, height - bottomOffset, frame.tileLength, thickness, true);
  pushTiles(operations, left, cornerHeight, height - cornerHeight, leftOffset, frame.tileLength, thickness, false);
  pushTiles(operations, right, cornerHeight, height - cornerHeight, width - rightOffset, frame.tileLength, thickness, false);
  const positions: SkinRect[] = [
    { x: 0, y: 0, width: cornerWidth, height: cornerHeight },
    { x: width - cornerWidth, y: 0, width: cornerWidth, height: cornerHeight },
    { x: 0, y: height - cornerHeight, width: cornerWidth, height: cornerHeight },
    { x: width - cornerWidth, y: height - cornerHeight, width: cornerWidth, height: cornerHeight }
  ];
  frame.corners.forEach((source, index) => operations.push({ source, destination: positions[index] }));
  return operations;
}
