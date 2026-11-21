import React from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas2DSkinView } from '../../../src/renderer/src/features/skins/Canvas2DSkinView';
import { SkinMediaView } from '../../../src/renderer/src/features/skins/SkinMediaView';
import '../../../src/renderer/src/styles/pixelTerminalSkins.css';
import './style.css';
import { inspectSkinMedia, SKIN_MEDIA_MIME } from '../../../src/shared/skinMedia';
const bridge = (window as any).presetFixture;
window.canvasTTY = { pixelSkins: bridge, window: (window as any).fixtureWindowState } as any;
const packs = await bridge.list();
let visiblePack = packs[0];
const root = createRoot(document.getElementById('root')!);
let detail: any = 'detailed', status: any = 'working', paused = false, offscreen = false;
let comparison = false;
const urls = new Map<string, string>();
for (const pack of packs) {
  const bytes = await bridge.readAsset(pack.id, 'background');
  urls.set(pack.id, URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: SKIN_MEDIA_MIME[inspectSkinMedia(new Uint8Array(bytes)).format] })));
}
function render() {
  root.render(<main className={comparison ? 'comparison' : undefined} style={{ transform: offscreen ? 'translateY(2000px)' : undefined }}>
    <h1>CanvasTTY 2.0 <small>Live terminal presets</small></h1>
    <p>{detail} · {status} · decoded live media · isolated renderer check</p>
    {(comparison
      ? ['minimal','detailed','master'].flatMap(detail => ['idle','working','done'].map(status => ({pack: visiblePack, detail, status})))
      : [{pack: visiblePack, detail, status}]).map(({pack, detail, status}: any, index: number) => { const aperture = pack.apertures[detail]; return <article key={`${pack.id}/${detail}/${status}`}>
      <h2>{pack.name} · {detail} · {status.toUpperCase()}</h2>
      <div id={String(index + 1)} className="terminal-card" data-pixel-skin="true" data-border-skin={pack.id}>
        <div className="wallpaper"><SkinMediaView src={urls.get(pack.id)!} media={pack.media.background} paused={paused}/></div>
        <Canvas2DSkinView theme={pack.id} status={status} width={1200} height={800} detail={detail} surfaceBounds={{ left: 1200 * aperture.left / 100, right: 1200 * (1-aperture.right/100), top: 800 * aperture.top / 100, bottom: 800 * (1-aperture.bottom/100) }} paused={paused}/>
        <pre style={{left:`${1200*aperture.left/100}px`,right:`${1200*aperture.right/100}px`,top:`${800*aperture.top/100}px`,bottom:`${800*aperture.bottom/100}px`}}>$ canvas build{'\n'}✓ Transparent terminal aperture{'\n'}✓ Your output stays readable{'\n\n'}Ready for your next idea.</pre>
      </div>
    </article>; })}
  </main>);
}
render();
Object.assign(window, { presetProbe: {
  packIds() { return packs.map((pack: { id: string }) => pack.id); },
  set(next: any) { visiblePack = packs.find((pack: { id: string }) => pack.id === next.packId) ?? visiblePack; detail = next.detail ?? detail; status = next.status ?? status; paused = next.paused ?? paused; offscreen = next.offscreen ?? offscreen; comparison = next.comparison ?? comparison; render(); },
  async verifyApertures() {
    let decoded = 0;
    for (const pack of packs) for (const detail of ['minimal','detailed','master']) for (const state of ['idle','working','completed']) {
      const bytes = new Uint8Array(await bridge.readAsset(pack.id, `${detail}_${state}`));
      const Decoder = (window as any).ImageDecoder;
      const decoder = new Decoder({ data: bytes, type: SKIN_MEDIA_MIME[inspectSkinMedia(bytes).format], preferAnimation: true });
      await decoder.tracks.ready;
      const count = decoder.tracks.selectedTrack.frameCount;
      if (count < 2) throw new Error('Expected real animation frames');
      const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 1024;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      for (let frameIndex = 0; frameIndex < count; frameIndex++) {
        const { image } = await decoder.decode({ frameIndex });
        context.clearRect(0,0,1536,1024); context.drawImage(image,0,0); image.close();
        const aperture = pack.apertures[detail];
        const left = Math.ceil(1536 * aperture.left / 100), top = Math.ceil(1024 * aperture.top / 100);
        const right = Math.floor(1536 * (1 - aperture.right / 100)), bottom = Math.floor(1024 * (1 - aperture.bottom / 100));
        const pixels = context.getImageData(left, top, right-left, bottom-top).data;
        for (let p = 3; p < pixels.length; p += 4) if (pixels[p] !== 0) throw new Error(`${pack.name}/${detail}/${state} obstructs the terminal`);
        decoded++;
      }
      decoder.close();
    }
    return decoded;
  }
} });
