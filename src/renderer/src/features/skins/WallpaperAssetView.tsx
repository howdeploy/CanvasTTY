import { SkinMediaView } from "./SkinMediaView";
import { useWallpaper } from "./useWallpaper";
import type { WallpaperId } from "../../../../shared/contracts";
export default function WallpaperAssetView({ id, className, paused = false, clock = false }: { id?: WallpaperId | null; className?: string; paused?: boolean; clock?: boolean }): React.JSX.Element | null {
  const asset = useWallpaper(id);
  if (!asset) return null;
  const { recipe } = asset.summary;
  return <span className={className} style={{ display: "block", width: "100%", height: "100%" }} data-wallpaper-format={asset.summary.media.format} data-wallpaper-animated={asset.summary.media.animated}> <SkinMediaView src={asset.src} media={asset.summary.media} paused={paused} className="wallpaper-view"
    style={{ "--wallpaper-fit": recipe.fit, "--wallpaper-position": `${recipe.x}% ${recipe.y}%`, imageRendering: recipe.pixelated ? "pixelated" : "auto" } as React.CSSProperties} />{clock && <span style={{ position: "absolute", inset: 0, background: `rgb(0 0 0 / ${recipe.dim})` }} />}</span>;
}
