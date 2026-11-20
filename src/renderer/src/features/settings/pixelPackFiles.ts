import type { PixelSkinSlot } from "../../../../shared/contracts";

export function pixelPackSlotForFilename(filename: string): PixelSkinSlot | null {
  const stem = filename.toLowerCase().replace(/\.(png|apng|gif|webp|mp4|webm)$/, "").replace(/[\s-]+/g, "_");
  if (stem === "background" || stem.endsWith("_background")) return "background";
  const match = /(?:^|_)(minimal|l1|detailed|l2|master)_(idle|working|completed|complete|done)$/.exec(stem);
  if (!match) return null;
  const level = match[1] === "l1" ? "minimal" : match[1] === "l2" ? "detailed" : match[1];
  const state = match[2] === "done" || match[2] === "complete" ? "completed" : match[2];
  return `${level}_${state}` as PixelSkinSlot;
}
