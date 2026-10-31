import type { BrowserViewportClipBounds } from "./contracts.ts";
import type { DesktopWindowViewport } from "./desktopWindows.ts";

export interface LinuxDesktopWindowViewport extends DesktopWindowViewport {
  referenceWidth: number;
  referenceHeight: number;
  clipBounds: BrowserViewportClipBounds;
  occlusions: BrowserViewportClipBounds[];
}
