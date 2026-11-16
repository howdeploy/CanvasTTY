import { installAvatarSelection } from "../../../src/renderer/src/features/home/avatarMedia";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSettings } from "../../../src/shared/contracts";
import WallpaperWorkshop from "../../../src/renderer/src/features/settings/WallpaperWorkshop";
import ClockWidget from "../../../src/renderer/src/features/home/ClockWidget";
import { HomeMediaWidget } from "../../../src/renderer/src/features/home/HomeMediaWidget";
import { WallpaperView } from "../../../src/renderer/src/features/skins/WallpaperView";
import { DEFAULT_WALLPAPER_RECIPE } from "../../../src/shared/wallpaper";
import "../../../src/renderer/src/styles/app.css";
import "../../../src/renderer/src/styles/pixelTerminalSkins.css";
import gif from "../live-skins/clock.gif?url";
import video from "../live-skins/background.mp4?url";
import "./probe.css";
const initial = await window.canvasTTY.settings.get();
const root = createRoot(document.getElementById("root")!);
function App(): React.JSX.Element {
  const [settings, setSettings] = useState(initial);
  const change = async (patch: Partial<AppSettings>): Promise<void> => { setSettings(await window.canvasTTY.settings.update(patch)); };
  return <main><div className="probe-layout"><section className="probe-home">
    <h1>CanvasTTY · Home</h1>
    <div id="clock"><ClockWidget locale="ru" now={new Date("2026-10-30T12:34:00Z")} settings={settings} onChange={change} /></div>
    <div id="avatar"><HomeMediaWidget locale="ru" wallpaperId={settings.homeAvatarWallpaper} dataUrl={null} fit="cover" onRequestMedia={async () => {
      const bytes = new Uint8Array(await (await fetch(gif)).arrayBuffer());
      const saved = await installAvatarSelection({ path: "/fixture/avatar.gif", dataUrl: `data:image/gif;base64,${btoa(String.fromCharCode(...bytes))}` });
      await change({ homeAvatarWallpaper: saved.id, mediaPath: null });
    }} onRemoveMedia={() => change({ homeAvatarWallpaper: null })} /></div>
    <div id="canvas"><WallpaperView id={settings.canvasBackground.startsWith("wallpaper:") ? settings.canvasBackground as `wallpaper:${string}` : null} /></div>
  </section><WallpaperWorkshop settings={settings} onChange={change} /></div></main>;
}
root.render(<App />);
Object.assign(window, { wallpaperProbe: {
  async import(kind: "gif" | "video" | "package") {
    const bytes = new Uint8Array(await (await fetch(kind === "video" ? video : gif)).arrayBuffer());
    let file = new File([bytes], kind === "video" ? "My clip.mp4" : "My clock.gif");
    if (kind === "package") file = new File([JSON.stringify({ schemaVersion: 1, kind: "canvastty-wallpaper", name: "Portable clock", recipe: { ...DEFAULT_WALLPAPER_RECIPE, width: 1440, height: 480, clockFont: "pixel", x: 25, y: 75, dim: .5 }, source: { width: 960, height: 320, base64: btoa(String.fromCharCode(...bytes)) } })], "Clock.ctwallpaper");
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.querySelector<HTMLInputElement>('.wallpaper-workshop input[type="file"]')!;
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  },
  async clockBackground() {
    const bytes = await (await fetch(gif)).arrayBuffer();
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], "Clock.gif", { type: "image/gif" }));
    const input = document.querySelector<HTMLInputElement>('.clock-tile input[type=file]')!;
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  },
  button(text: string) { const button = [...document.querySelectorAll("button")].find(e => e.textContent === text); if (!button) throw new Error(`Missing button: ${text}`); button.click(); },
  select(label: string, value: string) { const element = [...document.querySelectorAll("label")].find(e => e.textContent?.startsWith(label))!.querySelector("select")!; element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); },
  input(selector: string, value: string) {
    const element = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  },
  showGenerator() { document.querySelector("details")!.open = true; }
} });
