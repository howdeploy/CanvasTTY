import { attachAsciiContextRecovery } from "./asciiContextRecovery";
import type { AsciiPiece } from "../../../../shared/terminalBackground";
import { drawAsciiFrame } from "./asciiFrameCanvas";
import { createAsciiGpuRenderer } from "./asciiFrameGpu";
import { synchronizedBackgroundDelay, synchronizedBackgroundTime, type BackgroundSyncClock } from "./backgroundSyncClock.ts";
import type { AsciiFrameTransform } from "./asciiFrameBounds";

export type BackgroundWorkerMessage =
  | { type: "init"; canvas: OffscreenCanvas; scene: string; pixelRatio?: number }
  | { type: "resize"; width: number; height: number; pixelRatio?: number }
  | { type: "speed"; value: number }
  | { type: "transform"; value: AsciiFrameTransform }
  | { type: "synchronize"; clock: BackgroundSyncClock | null }
  | { type: "playing"; value: boolean };

let canvas: OffscreenCanvas;
let ctx: OffscreenCanvasRenderingContext2D | null;
let gpu: ReturnType<typeof createAsciiGpuRenderer>;
let piece: AsciiPiece;
let frame: ReturnType<AsciiPiece["default"]> | undefined;
let color: Uint8Array | undefined;
let text: string | undefined;
let pixelRatio = 1;
let playing = false, time = 0, last = 0;
let speed = 1;
let syncClock: BackgroundSyncClock | null = null;
let transform: AsciiFrameTransform = { scale: 100, offsetX: 0, offsetY: 0 };
let timer: ReturnType<typeof setTimeout> | undefined;
let contextLost = false;

function draw(advance = true): void {
  if (contextLost || !frame || (!ctx && !gpu)) return;
  try {
    if (advance || text === undefined) text = frame(time, { paper: false, color });
    if (gpu) gpu(text, color, pixelRatio, transform);
    else if (ctx) drawAsciiFrame(ctx, text, piece.meta, color, pixelRatio, transform);
  } catch {
    if (gpu) {
      gpu = null;
      ctx = canvas.getContext("2d", { alpha: false });
      if (ctx && text) drawAsciiFrame(ctx, text, piece.meta, color, pixelRatio, transform);
    }
  }
}

function advanceTime(now: number): void {
  if (syncClock) {
    time = (piece.meta.still ?? 0) + synchronizedBackgroundTime(syncClock, performance.timeOrigin + now, Math.min(piece.meta.fps || 12, 12));
  } else time += Math.min(Math.max((now - last) / 1000, 0), 0.5) * speed;
  last = now;
}

function tick(): void {
  timer = undefined;
  if (contextLost || !playing || !frame) return;
  const start = performance.now();
  advanceTime(start);
  draw();
  const cost = performance.now() - start;
  // Leave most of the worker's time free on slower machines.
  const delay = syncClock
    ? synchronizedBackgroundDelay(syncClock, performance.timeOrigin + performance.now(), Math.min(piece.meta.fps || 12, 12), cost * 3)
    : Math.max(1000 / Math.min(piece.meta.fps ?? 12, 12) - cost, cost * 3);
  timer = setTimeout(tick, delay);
}

function run(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!contextLost && playing && frame && piece.meta.fps !== 0) {
    last = performance.now();
    timer = setTimeout(tick, 0);
  }
}

self.onmessage = async ({ data }: MessageEvent<BackgroundWorkerMessage>): Promise<void> => {
  if (data.type === "init") {
    canvas = data.canvas;
    pixelRatio = data.pixelRatio ?? 1;
    try {
      piece = await import(`ascii.rest/pieces/${data.scene}`);
    } catch {
      try {
        piece = await import(`../../../../../node_modules/ascii.rest/dist/pieces/${data.scene}.js`);
      } catch (err) {
        if (typeof self.postMessage === "function") {
          self.postMessage({ type: "error", error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    }
    if (typeof canvas.addEventListener === "function") {
      attachAsciiContextRecovery(canvas, () => {
        contextLost = true;
        clearTimeout(timer);
        timer = undefined;
        gpu = null;
        ctx = null;
      }, () => {
        try {
          gpu = createAsciiGpuRenderer(canvas, piece.meta);
          if (!gpu) throw new Error("WebGL background restoration failed.");
          contextLost = false;
          draw(false);
          run();
        } catch (error) {
          self.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
        }
      });
    }
    try {
      gpu = createAsciiGpuRenderer(canvas, piece.meta);
    } catch {
      gpu = null;
    }
    ctx = gpu ? null : canvas.getContext("2d", { alpha: false });
    frame = piece.default({ ...piece.meta.options });
    color = piece.meta.palette ? new Uint8Array((piece.meta.cols ?? 80) * (piece.meta.rows ?? 24)) : undefined;
    time = piece.meta.still ?? 0;
    if (syncClock) advanceTime(performance.now());
    draw();
    run();
  } else if (data.type === "resize") {
    if (canvas.width === data.width && canvas.height === data.height && pixelRatio === (data.pixelRatio ?? 1)) return;
    pixelRatio = data.pixelRatio ?? 1;
    canvas.width = data.width;
    canvas.height = data.height;
    draw(false);
  } else if (data.type === "transform") {
    const finite = (value: number, fallback: number, min: number, max: number): number =>
      Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    const next = { scale: finite(data.value.scale, 100, 25, 300),
      offsetX: finite(data.value.offsetX, 0, -50, 50), offsetY: finite(data.value.offsetY, 0, -50, 50) };
    if (next.scale === transform.scale && next.offsetX === transform.offsetX && next.offsetY === transform.offsetY) return;
    transform = next;
    draw(false);
  } else if (data.type === "speed") {
    const next = Number.isFinite(data.value) ? Math.min(2, Math.max(0.25, data.value)) : 1;
    if (next === speed) return;
    if (playing && frame) advanceTime(performance.now());
    speed = next;
  } else if (data.type === "synchronize") {
    const next = data.clock;
    if (syncClock?.origin === next?.origin && syncClock?.time === next?.time && syncClock?.speed === next?.speed) return;
    syncClock = next;
    if (frame && syncClock) {
      advanceTime(performance.now());
      draw();
    }
    run();
  } else {
    if (playing === data.value) return;
    playing = data.value;
    run();
  }
};
