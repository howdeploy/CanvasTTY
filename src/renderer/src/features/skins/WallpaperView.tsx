import { lazy, memo, Suspense } from "react";
import type { WallpaperId } from "../../../../shared/contracts";
const View = lazy(() => import("./WallpaperAssetView"));
export const WallpaperView = memo(function WallpaperView(props: { id?: WallpaperId | null; className?: string; paused?: boolean; clock?: boolean }): React.JSX.Element | null {
  if (!props.id) return null;
  return <Suspense fallback={null}><View {...props} /></Suspense>;
});
