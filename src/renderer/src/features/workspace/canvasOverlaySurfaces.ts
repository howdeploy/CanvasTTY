import { preloadedSurface } from "../../lib/preloadedSurface";

// The command palette and the canvas context menu exist only while they are open, so their code is not part of the
// startup bundle: the canvas preloads both once it is idle, and an open before that loads its chunk at once.
export const canvasContextMenuSurface = preloadedSurface(() => import("./CanvasContextMenu").then((module) => module.CanvasContextMenu));
export const canvasCommandPaletteSurface = preloadedSurface(() => import("./CanvasCommandPalette").then((module) => module.CanvasCommandPalette));
