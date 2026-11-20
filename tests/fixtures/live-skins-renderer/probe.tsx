import React from "react";
import { createRoot } from "react-dom/client";
import { SkinMediaView } from "../../../src/renderer/src/features/skins/SkinMediaView";
import { Canvas2DSkinView } from "../../../src/renderer/src/features/skins/Canvas2DSkinView";
import { PixelSkinPackCreator } from "../../../src/renderer/src/features/settings/PixelSkinPackCreator";
import { inspectSkinMedia, SKIN_MEDIA_MIME } from "../../../src/shared/skinMedia";
import "../../../src/renderer/src/styles/pixelTerminalSkins.css";
import "../../../src/renderer/src/styles/pixelSkinPackCreator.css";
import mp4 from "../live-skins/background.mp4?url";
import webm from "../live-skins/background.webm?url";
import webp from "../live-skins/frame.webp?url";
import apng from "../live-skins/frame.apng?url";
import "./probe.css";

const root = createRoot(document.getElementById("root")!);
const packId = "pixel:00000000-0000-4000-8000-000000000001";
const frame = new Uint8Array(await (await fetch(webp)).arrayBuffer());
const pngFrame = new Uint8Array(await (await fetch(apng)).arrayBuffer());
window.canvasTTY = { window: (window as any).fixtureWindowState, pixelSkins: {
  readAsset: async (_id, slot) => slot === "background" ? pngFrame : frame,
  list: async () => [],
}, clipboard: { writeText() {} } } as unknown as typeof window.canvasTTY;
const bounds = { left: 24, right: 296, top: 30, bottom: 174 };
let paused = false;
let offscreen = false;
function render(): void {
  root.render(<main style={{ transform: offscreen ? "translateY(2000px)" : undefined }}>
    <h1>CanvasTTY <small>Живые обои и рамки</small></h1>
    <section className="probe-wallpapers">
      <article><h2>MP4 · H.264</h2><div id="mp4"><SkinMediaView src={mp4} media={{ format: "mp4", animated: true }} paused={paused} className="skin-media-preview" /></div></article>
      <article><h2>WebM · VP9</h2><div id="webm"><SkinMediaView src={webm} media={{ format: "webm", animated: true }} paused={paused} className="skin-media-preview" /></div></article>
    </section>
    <section className="probe-frames">
      <article><h2>Анимированная рамка · WebP</h2><div id="frame" className="terminal-card" data-pixel-skin="true">
        <Canvas2DSkinView theme={packId} status="working" width={320} height={200} detail="minimal" surfaceBounds={bounds} paused={paused} />
        <pre className="probe-text">$ npm run build{"\n"}✓ Текст остаётся читаемым{"\n"}✓ Проём не перекрыт рамкой</pre>
      </div></article>
      <article><h2>APNG</h2><div id="apng"><SkinMediaView src={apng} media={{ format: "png", animated: true }} paused={paused} className="skin-media-preview" /></div></article>
    </section>
    <PixelSkinPackCreator locale="ru" onCreated={() => undefined} />
    <p>Проверка реальных компонентов в отдельном профиле Electron.</p>
  </main>);
}
render();
Object.assign(window, {
  skinProbe: {
    offscreen(value: boolean) { offscreen = value; render(); },
    pause(value: boolean) { paused = value; render(); },
    snapshot() { return [...document.querySelectorAll("video")].map(element => ({ currentTime: element.currentTime, paused: element.paused, muted: element.muted, loop: element.loop, readyState: element.readyState, error: element.error?.message })); },
    async decode() {
      for (const url of [webp, apng, mp4, webm]) {
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const info = inspectSkinMedia(bytes);
        if (!SKIN_MEDIA_MIME[info.format]) throw new Error("No MIME type");
      }
      return true;
    }
  }
});
