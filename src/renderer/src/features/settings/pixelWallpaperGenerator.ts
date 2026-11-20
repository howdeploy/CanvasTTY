/** Seeded local pixel scenery. No network, model or user file is needed. */
export async function generatePixelWallpaper(seed: number, palette: "night" | "forest" | "sunset", width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  const colors = { night: ["#111827", "#22294b", "#454571", "#8ee3e8"], forest: ["#102c2c", "#1b4b40", "#39765d", "#c3d995"], sunset: ["#361d47", "#71385b", "#bd6268", "#ffce99"] }[palette];
  let state = seed >>> 0;
  const random = (): number => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const unit = Math.max(1, Math.round(width / 320));
  ctx.fillStyle = colors[0]; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = colors[3];
  for (let i = 0; i < 90; i++) ctx.fillRect(Math.floor(random() * width / unit) * unit, Math.floor(random() * height * 0.6 / unit) * unit, unit, unit);
  ctx.fillRect(Math.round(width * 0.72 / unit) * unit, Math.round(height * 0.16 / unit) * unit, 18 * unit, 18 * unit);
  for (let layer = 0; layer < 3; layer++) {
    ctx.fillStyle = colors[layer === 2 ? 0 : layer + 1];
    let y = height * (0.45 + layer * 0.15);
    for (let x = 0; x < width; x += unit * 4) {
      y = Math.max(height * 0.25, Math.min(height * 0.9, y + (random() - 0.49) * unit * 12));
      ctx.fillRect(x, Math.round(y / unit) * unit, unit * 4, height);
    }
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG generation failed.")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
