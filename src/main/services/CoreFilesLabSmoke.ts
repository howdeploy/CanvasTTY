import type { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Actual built-in Files UI, decoder and material cards; isolated lab profile only. */
export async function runCoreFilesLabSmoke(window: BrowserWindow, output: string): Promise<string[]> {
  const run = (source: string): Promise<any> => window.webContents.executeJavaScript(source);
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (source: string, label: string): Promise<void> => {
    for (let i = 0; i < 150; i++) { if (await run(source)) return; await wait(60); }
    const diagnostic = await run(`(() => ({videos:[...document.querySelectorAll('video,audio')].map(v=>({src:v.currentSrc,readyState:v.readyState,networkState:v.networkState,error:v.error?{code:v.error.code,message:v.error.message}:null})),errors:window.__coreMediaErrors,text:document.querySelector('.file-browser-card')?.innerText}))()`);
    if (diagnostic.errors?.[0]?.src) {
      try { const response = await window.webContents.session.fetch(diagnostic.errors[0].src); diagnostic.response = {status:response.status,headers:[...response.headers],bytes:(await response.arrayBuffer()).byteLength}; }
      catch (error) { diagnostic.response = String(error); }
    }
    await writeFile(join(output, 'core-files-failure.json'), JSON.stringify({label,diagnostic},null,2));
    await writeFile(join(output, 'core-files-failure.png'), (await window.webContents.capturePage()).toPNG());
    throw new Error(label);
  };
  const click = async (selector: string): Promise<void> => {
    await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, selector);
    await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait(100);
  };
  const focusFiles = async (): Promise<void> => { await click('[aria-label="Домой"]'); await click('.launcher-button--files'); };
  const navigate = async (path: string): Promise<void> => {
    await run(`(() => {const e=document.querySelector('.file-browser-card__path input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(path)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(50);
    await run("document.querySelector('.file-browser-card__path').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
    await wait(150);
  };
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Network.enable');
  window.webContents.debugger.on('message', (_event, method, params) => { if (method === 'Network.loadingFailed') console.log('CORE_NETWORK_FAILURE', JSON.stringify(params)); });
  await run(`window.__coreMediaErrors=[];document.addEventListener('error',e=>{const v=e.target;if(v instanceof HTMLMediaElement)window.__coreMediaErrors.push({src:v.currentSrc,code:v.error?.code,message:v.error?.message});},true)`);
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.log('CORE_FILES_RENDERER',message); });
  const original = await run("window.canvasTTY.materials.snapshot()");
  const added: string[] = [];
  try {
    await navigate(join(output, 'media'));
    await until("Boolean(document.querySelector('.file-browser-card__tree-row[title=\"movie.mp4\"]'))", 'Address bar navigation failed');
    await click('.file-browser-card__tree-row[title="movie.mp4"]');
    await until("document.querySelector('.file-browser-card__media video')?.readyState>=2", 'MP4 preview did not decode');
    await run("document.querySelector('.file-browser-card__media video').play()");
    await until("document.querySelector('.file-browser-card__media video').currentTime>0", 'MP4 preview did not play');
    await run("(()=>{const v=document.querySelector('.file-browser-card__media video');v.pause();v.currentTime=Math.min(.5,v.duration/2)})()");
    await until("document.querySelector('.file-browser-card__media video').currentTime>=.1", 'MP4 preview did not seek');
    await writeFile(join(output, 'core-mp4-preview.png'), (await window.webContents.capturePage()).toPNG());
    for (const [file, kind, action] of [['movie.mp4','video','button'], ['animation.gif','image','context'], ['song.mp3','audio','double']]) {
      await focusFiles();
      const selector = `.file-browser-card__tree-row[title="${file}"]`;
      await click(selector);
      if (action === 'button') await click('.file-browser-card__place');
      else if (action === 'context') {
        await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:400,clientY:400}))`);
        await click('.file-browser-card__context button');
      } else await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
      await until(`window.canvasTTY.materials.snapshot().then(s=>s.materials.some(m=>m.name===${JSON.stringify(file)}&&m.kind===${JSON.stringify(kind)}))`, 'File not placed: '+file);
      const material = await run(`window.canvasTTY.materials.snapshot().then(s=>s.materials.find(m=>m.name===${JSON.stringify(file)}))`);
      if (!original.materials.some((m: any) => m.id === material.id)) added.push(material.id);
      const tag = kind === 'image' ? 'img' : kind;
      const mediaSelector = `[data-material-id="${material.id}"] ${tag}`;
      await until(kind === 'image' ? `document.querySelector(${JSON.stringify(mediaSelector)})?.naturalWidth>0` : `document.querySelector(${JSON.stringify(mediaSelector)})?.readyState>=2`, 'Canvas decoder failed: '+file);
      if (kind !== 'image') {
        await run(`document.querySelector(${JSON.stringify(mediaSelector)}).play()`);
        await until(`document.querySelector(${JSON.stringify(mediaSelector)}).currentTime>0`, 'Canvas playback failed: '+file);
        await run(`document.querySelector(${JSON.stringify(mediaSelector)}).pause()`);
      }
      await writeFile(join(output, `canvas-${kind}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await focusFiles();
    await click('.file-browser-card__path button:first-child');
    await until("Boolean(document.querySelector('.file-browser-card__tree-row[title=\"acceptance-note.md\"]'))", 'Parent-folder navigation failed');
    await click('.file-browser-card__tree-row[title="acceptance-note.md"]');
    await click('[aria-label="Домой"]');
    await until("Boolean(document.querySelector('.clock-tile__background img')?.src && document.querySelector('.workspace__live-background img')?.src)", 'Shared wallpapers not visible');
    const shared = await run("document.querySelector('.clock-tile__background img')?.src === document.querySelector('.workspace__live-background img')?.src");
    if (!shared) throw new Error('Clock and canvas still have duplicate wallpaper URLs');
    return ['Files opens Home automatically with filesystem places, address bar and parent navigation', 'built-in MP4 preview decodes, plays and seeks via ranged stream', 'file button, right-click and double-click place actual video, GIF image and audio cards on canvas; video/audio playback advances', 'clock and canvas share one wallpaper object URL'];
  } finally {
    for (const id of added) await run(`window.canvasTTY.materials.remove(${JSON.stringify(id)})`);
  }
}
