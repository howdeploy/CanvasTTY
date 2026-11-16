import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type AnimatedSkinMediaView from "./AnimatedSkinMediaView";

const MotionView = lazy(() => import("./AnimatedSkinMediaView"));

// Playback code loads only when a custom skin is rendered, preserving first-paint size.
export function SkinMediaView(props: ComponentProps<typeof AnimatedSkinMediaView>): React.JSX.Element {
  return <Suspense fallback={null}><MotionView {...props} /></Suspense>;
}
