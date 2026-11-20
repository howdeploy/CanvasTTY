/** Opt-in probe of the actual sandboxed plugin, real codecs and its separate window. */
import { BrowserWindow, type WebFrameMain } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function runFileExplorerLabSmoke(window: BrowserWindow, output: string): Promise<string[]> {
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  let frame: WebFrameMain | undefined;
  for (let i=0;i<100;i++) { frame = window.webContents.mainFrame.framesInSubtree.find(f => f.url.includes('com.canvastty.file-explorer')); if (frame && await frame.executeJavaScript("Boolean(document.querySelector('.entry'))")) break; await wait(100); }
  if (!frame) throw new Error('Files iframe not loaded');
  const run = (source: string): Promise<any> => frame!.executeJavaScript(source);
  const until = async (source: string): Promise<void> => {
    for (let i=0;i<100;i++) { if (await run(source)) return; await wait(75); }
    throw new Error('Files probe timed out: ' + source);
  };
  for (const name of ['photo.jpg','animation.gif','movie.mp4','song.mp3']) {
    await until(`Boolean(document.querySelector('.entry[data-path="${name}"]'))`);
    await run(`document.querySelector('.entry[data-path="${name}"]').click()`);
    const image = /jpg|gif/.test(name);
    await until(image ? "Boolean(document.querySelector('.media-stage img')?.naturalWidth)" : "Boolean(document.querySelector('.media-stage audio,.media-stage video')?.readyState>=2)");
    if (!image) {
      await run("document.querySelector('.media-stage audio,.media-stage video').play()");
      await until("document.querySelector('.media-stage audio,.media-stage video').currentTime>0");
      await run("document.querySelector('.media-stage audio,.media-stage video').pause()");
    }
    if (name === 'animation.gif') {
      const rect = await run("(() => {const r=document.querySelector('.media-stage img').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
      const iframe = await window.webContents.executeJavaScript("(() => {const e=[...document.querySelectorAll('iframe.plugin-frame')].find(e=>e.title.includes('Canvas Files')); const r=e.getBoundingClientRect();return {x:r.x,y:r.y,scale:r.width/e.clientWidth}})()");
      const bounds = { x: Math.ceil(iframe.x+rect.x*iframe.scale), y: Math.ceil(iframe.y+rect.y*iframe.scale), width: Math.max(1,Math.floor(rect.width*iframe.scale)-2), height: Math.max(1,Math.floor(rect.height*iframe.scale)-2) };
      const first = (await window.webContents.capturePage(bounds)).toBitmap(); let animated=false;
      for(let i=0;i<24;i++){ await wait(125); if (!first.equals((await window.webContents.capturePage(bounds)).toBitmap())) {animated=true;break;} }
      if (!animated) throw new Error('Explorer GIF pixels did not animate');
    }
  }
  // A real plugin drag payload resolves through the main-process grant to a shell-quoted path.
  const token = await run("(() => {const d=new DataTransfer(); document.querySelector('.entry[data-path=\"song.mp3\"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:d})); return d.getData('application/x-canvastty-file')})()");
  const path = await window.webContents.executeJavaScript(`window.canvasTTY.plugins.fileDropText(${JSON.stringify(token)})`);
  if (typeof path!=='string' || !path.includes('song.mp3') || /[\r\n]/.test(path)) throw new Error('Explorer drag path failed');
  const terminal = await window.webContents.executeJavaScript(`window.canvasTTY.terminal.create(${JSON.stringify({provider:"terminal",profile:"normal",cwd:output,position:{x:2400,y:100}})})`);
  try {
    const selector = `[data-session-id="${terminal.id}"]`;
    for(let i=0;i<100;i++){ if(await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)})?.querySelector('.xterm'))`)) break; await wait(75); }
    await wait(300);
    await window.webContents.executeJavaScript(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Drop target not rendered');const d=new DataTransfer();d.setData('application/x-canvastty-file',${JSON.stringify(token)});e.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d}));return true})()`);
    let pasted=false;
    for(let i=0;i<100;i++){ const b=await window.webContents.executeJavaScript(`window.canvasTTY.terminal.readBuffer(${JSON.stringify(terminal.id)})`); if(b.buffer.includes('song.mp3')){pasted=true;break;} await wait(75); }
    if(!pasted) throw new Error('Drop did not arrive in the real terminal PTY');
    // Clear the input line; the dropped path is never submitted as a command.
    await window.webContents.executeJavaScript(`window.canvasTTY.terminal.input(${JSON.stringify(terminal.id)},"\u0015");true`);
  } finally { await window.webContents.executeJavaScript(`window.canvasTTY.terminal.dispose(${JSON.stringify(terminal.id)})`); }
  await run("document.querySelector('.preview-head button').click()");
  let preview: BrowserWindow | undefined;
  for (let i=0;i<100;i++) {
    preview = BrowserWindow.getAllWindows().find(w => w!==window && w.webContents.mainFrame.framesInSubtree.some(f=>f.url.includes('com.canvastty.file-explorer') && f.url.includes('preview.html')));
    if(preview) break; await wait(75);
  }
  if (!preview) throw new Error('Separate preview window missing');
  try {
    const child = preview.webContents.mainFrame.framesInSubtree.find(f => f.url.includes('preview.html'))!;
    for (let i=0;i<100;i++){ if(await child.executeJavaScript("Boolean(document.querySelector('audio')?.readyState>=2)")) break; await wait(75); }
    await child.executeJavaScript("document.querySelector('audio').play()");
    for(let i=0;i<100;i++){if(await child.executeJavaScript("document.querySelector('audio').currentTime>0"))break;await wait(75);}
    if(!(await child.executeJavaScript("document.querySelector('audio').currentTime>0"))) throw new Error('Separate preview audio did not play');
    await writeFile(join(output,'file-preview-window.png'), (await preview.webContents.capturePage()).toPNG());
  } finally { preview.close(); }
  await writeFile(join(output,'file-explorer.png'), (await window.webContents.capturePage()).toPNG());
  return ['packaged Files: actual JPG/GIF decode and GIF animation, MP4/MP3 playback advances, drag reaches actual terminal PTY without submission, separate audio preview plays'];
}
