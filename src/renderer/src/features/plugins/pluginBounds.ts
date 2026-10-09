import type { SessionBounds, Size } from "../../../../shared/contracts";
import type { ResizeDirection } from "../workspace/snap";

export function constrainPluginResize(
  bounds: SessionBounds,
  direction: ResizeDirection,
  minSize: Size = { width: 320, height: 220 }
): SessionBounds {
  const right = bounds.position.x + bounds.size.width;
  const bottom = bounds.position.y + bounds.size.height;
  const width = clamp(bounds.size.width, minSize.width, 1_600);
  const height = clamp(bounds.size.height, minSize.height, 1_100);
  return {
    position: {
      x: direction.includes("w") ? right - width : bounds.position.x,
      y: direction.includes("n") ? bottom - height : bounds.position.y
    },
    size: { width, height }
  };
}

export function constrainMascotResize(
  bounds: SessionBounds,
  direction: ResizeDirection,
  startSize: Size,
  aspectRatio: number,
  minSize: Size = { width: 128, height: 140 }
): SessionBounds {
  const horizontal = direction === "e" || direction === "w"
    || (direction.length === 2
      && Math.abs(bounds.size.width - startSize.width) / aspectRatio
        > Math.abs(bounds.size.height - startSize.height));
  const requestedHeight = horizontal ? bounds.size.width / aspectRatio : bounds.size.height;
  const height = Math.round(clamp(
    requestedHeight,
    Math.max(minSize.height, minSize.width / aspectRatio),
    Math.min(1_100, 1_600 / aspectRatio)
  ));
  const width = Math.round(height * aspectRatio);
  const right = bounds.position.x + bounds.size.width;
  const bottom = bounds.position.y + bounds.size.height;
  return {
    position: {
      x: direction.includes("w") ? right - width : bounds.position.x,
      y: direction.includes("n") ? bottom - height : bounds.position.y
    },
    size: { width, height }
  };
}

export function fitMascotBounds(bounds: SessionBounds, aspectRatio: number): SessionBounds {
  const fitted = constrainMascotResize(bounds, "s", bounds.size, aspectRatio);
  return {
    position: { x: bounds.position.x + (bounds.size.width - fitted.size.width) / 2, y: fitted.position.y },
    size: fitted.size
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
