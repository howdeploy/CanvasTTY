// Real app + PTY in a private macOS profile; never attaches to an existing session.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const electron=require('electron');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,message){for(let i=0;i<100;i++){if(await check())return;await sleep(100);}assert.fail(message);}
if(typeof electron==='string'){
  assert.equal(process.platform,'darwin');
  const root=await mkdtemp('/tmp/ctmac-');
  const env={...process.env};
  const artifacts=env.CANVASTTY_MAC_ARTIFACT_DIR;
  for(const key of Object.keys(env))if(key.startsWith('CANVASTTY_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
  env.CANVASTTY_USER_DATA_DIR=root;
  if(artifacts)env.CANVASTTY_MAC_ARTIFACT_DIR=artifacts;
  const child=spawn(electron,[fileURLToPath(import.meta.url),`--user-data-dir=${root}`],{env,stdio:'inherit'});
  const timer=setTimeout(()=>child.kill('SIGTERM'),240000);
  try{const code=await new Promise(r=>child.once('exit',r));assert.equal(code,0);}
  finally{clearTimeout(timer);await rm(root,{recursive:true,force:true});}
}else{
  void run().catch(e=>{console.error(e);electron.app.exit(1);});
}
async function run(){
 const {app,BrowserWindow}=electron;
 app.commandLine.appendSwitch('js-flags','--expose-gc');
 await import('../out/main/index.js');
 await app.whenReady();
 let win, ready=false;
 for(let i=0;i<300;i++){
  win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/renderer/'));
  if(win&&await win.webContents.executeJavaScript('Boolean(window.canvasTTY && document.querySelector(".workspace"))').catch(()=>false)){ready=true;break;}
  await sleep(100);
 }
 assert.ok(ready,'main app and sandbox preload loaded');
 const js=code=>win.webContents.executeJavaScript(code);
 const gpuBundle=require('esbuild').buildSync({stdin:{contents:`export {createAsciiGpuRenderer} from './asciiFrameGpu'; export {attachAsciiContextRecovery} from './asciiContextRecovery';`,resolveDir:fileURLToPath(new URL('../src/renderer/src/features/terminal',import.meta.url))},bundle:true,format:'iife',globalName:'macGpuTest',write:false}).outputFiles[0].text;
 const gpuRecovery=await js(`${gpuBundle};(async()=>{
   const canvas=new OffscreenCanvas(128,64), meta={cols:4,rows:2,ground:'#123456'};
   let renderer=macGpuTest.createAsciiGpuRenderer(canvas,meta),lost=0,restored=0;
   if(!renderer)throw new Error('WebGL2 is required for GPU recovery acceptance');
   const gl=canvas.getContext('webgl2'), extension=gl.getExtension('WEBGL_lose_context');
   const pixels=()=>{renderer('TEST\\nTEST');const data=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,data);return [...data];};
   const before=pixels();
   const detach=macGpuTest.attachAsciiContextRecovery(canvas,()=>{lost++;renderer=null;},()=>{renderer=macGpuTest.createAsciiGpuRenderer(canvas,meta);restored++;});
   for(let i=0;i<2;i++){
     extension.loseContext();
     const deadline=performance.now()+10000;
     while(lost<=i){if(performance.now()>deadline)throw new Error('context loss event timed out');await new Promise(r=>setTimeout(r,20));}
     extension.restoreContext();
     while(restored<=i){if(performance.now()>deadline)throw new Error('context restore event timed out');await new Promise(r=>setTimeout(r,20));}
   }
   const after=pixels();detach();extension.loseContext();
   return {lost,restored,before,after};
 })()`);
 assert.equal(gpuRecovery.lost,2);assert.equal(gpuRecovery.restored,2);
 assert.deepEqual(gpuRecovery.after,gpuRecovery.before,'restored GPU renderer redraws the same pixels');
 assert.deepEqual(gpuRecovery.before,[18,52,86,255]);
 console.log('MAC_GPU_RECOVERY_OK '+JSON.stringify(gpuRecovery));
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>'+req.url+'</title><h1>'+req.url+'</h1>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 for(const path of ['/first','/second'])await js(`window.canvasTTY.browser.openWindow(${JSON.stringify(origin)}+${JSON.stringify(path)})`);
 const extras=BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL().includes('browser-window.html'));
 assert.equal(extras.length,2,'two independent Mac browser windows');
 const states=await Promise.all(extras.map(w=>w.webContents.executeJavaScript('window.canvasTTY.browser.getState()')));
 assert.deepEqual(states.map(s=>new URL(s.tabs[0].url).pathname).sort(),['/first','/second']);
 assert.notEqual(states[0].tabs[0].id,states[1].tabs[0].id);
 await until(()=>electron.webContents.getAllWebContents().filter(w=>w.getURL().startsWith(origin)).length===2,'both browser pages loaded');
 const pages=electron.webContents.getAllWebContents().filter(w=>w.getURL().startsWith(origin));
 assert.equal(pages.length,2);
 const sessions=pages.map(w=>w.session);
 assert.deepEqual(sessions.map(s=>s.listenerCount('will-download')),[1,1]);
 extras[0].close();
 await sleep(300);
 assert.equal(extras[1].isDestroyed(),false,'closing one browser preserves the other');
 const still=await extras[1].webContents.executeJavaScript('window.canvasTTY.browser.getState()');
 assert.equal(still.tabs[0].url,states[1].tabs[0].url);
 await extras[1].webContents.executeJavaScript(`window.canvasTTY.browser.newTab(${JSON.stringify(origin+'/third')})`);
 const navigated=await extras[1].webContents.executeJavaScript('window.canvasTTY.browser.getState()');
 assert.equal(navigated.tabs.length,2);
 assert.ok(navigated.tabs.some(t=>new URL(t.url).pathname==='/third'));
 assert.deepEqual(await extras[1].webContents.executeJavaScript('Object.keys(window.canvasTTY)'),['browser'],'browser window has no terminal or settings bridge');
 extras[1].close();
 await sleep(500);
 assert.deepEqual(sessions.map(s=>s.listenerCount('will-download')),[0,0],'disposed browser sessions release callbacks');
 await new Promise(r=>server.close(r));
 console.log('MAC_MULTI_BROWSER_OK');
 win.setContentSize(3440,1440);
 await js(`window.canvasTTY.settings.update({canvasBackground:'gothic-eclipse',terminalBorderSkin:'gothic-eclipse',terminalBackground:'alpine-dawn'})`);
 // A real SettingsPanel applies its response locally. Reload to consume the saved profile here.
 win.webContents.reload();
 await until(()=>js(`document.querySelector('.workspace')?.dataset.themeBackground==='gothic-eclipse'`).catch(()=>false),'saved wallpaper loaded');
 const session=await js(`window.canvasTTY.terminal.create({provider:'terminal',profile:'normal',cwd:'/tmp',position:{x:200,y:200},title:'MAC-OWN-TEST'})`);
 const id=JSON.stringify(session.id);
 await sleep(1500);
 await js(`window.canvasTTY.terminal.input(${id},${JSON.stringify('bindkey -e; print -r -- CT_HISTORY_OK\r')})`);
 await sleep(500);
 await js(`document.querySelector('[data-session-id="'+${id}+'"] .xterm-helper-textarea')?.focus()`);
 // Some cards expose session ids on a different attribute; this profile owns the only terminal.
 await js(`document.querySelector('.xterm-helper-textarea').focus()`);
 const active=await js(`document.activeElement.className`);
 assert.match(active,/xterm/);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Up'});
 win.webContents.sendInputEvent({type:'keyUp',keyCode:'Up'});
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
 win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
 await sleep(600);
 const buffer=await js(`window.canvasTTY.terminal.readBuffer(${id})`);
 const historyOutputs=(buffer.buffer.match(/\r?\nCT_HISTORY_OK\r?\n/g)||[]).length;
 assert.ok(historyOutputs>=2,'ArrowUp recalls and Return executes the previous shell command');
 for(let i=0;i<5;i++)await js(`window.canvasTTY.terminal.create({provider:'terminal',profile:'normal',cwd:'/tmp',position:{x:${100+i*450},y:700},title:'MAC-RESUME-${i}'})`);
 await sleep(2000);
 win.webContents.debugger.attach('1.3');
 const heap=async()=>{await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');return (await win.webContents.debugger.sendCommand('Runtime.getHeapUsage')).usedSize;};
 const counters=async()=>({heap:await heap(),...await js(`({dom:document.getElementsByTagName('*').length,canvases:document.querySelectorAll('canvas').length})`)});
 const before=await counters();
 const wallpaper=await js(`({size:getComputedStyle(document.querySelector('.workspace')).backgroundSize,background:document.querySelector('.workspace').dataset.themeBackground})`);
 assert.equal(wallpaper.size,'cover');
 if(process.env.CANVASTTY_MAC_ARTIFACT_DIR)await writeFile(join(process.env.CANVASTTY_MAC_ARTIFACT_DIR,'wallpaper-wide.png'),(await win.webContents.capturePage()).toPNG());
 console.log('MAC_RESUME_START '+JSON.stringify({before,wallpaper}));
 const start=Date.now();
 // A bounded producer remains active during the 70-second hidden-window interval.
 const command="python3 -u -c 'import time; [(print(\"RESUME-%d \"%i + \"x\"*1000),time.sleep(.008)) for i in range(9000)]'\r";
 await js(`window.canvasTTY.terminal.input(${id},${JSON.stringify(command)})`);
 win.hide();
 await sleep(70000);
 const hidden=await js(`({visibility:document.visibilityState,heap:performance.memory?.usedJSHeapSize})`);
 const resumeAt=Date.now();
 win.show();
 const frames=await js(`new Promise(r=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>r(performance.now()-start)))})`);
 await sleep(4000);
 const after=await counters();
 const tail=await js(`window.canvasTTY.terminal.readBuffer(${id})`);
 const produced=Math.max(0,...Array.from(tail.buffer.matchAll(/RESUME-(\d+)/g),m=>Number(m[1])));
 assert.ok(produced>7000,'the producer stayed active while the window was hidden');
 const cycles=[];
 for(let i=0;i<5;i++){win.hide();await sleep(250);win.show();await sleep(500);cycles.push(await counters());}
 assert.ok(cycles.at(-1).heap < before.heap + 16*1024*1024,'bounded post-GC heap after repeated resume');
 assert.equal(cycles.at(-1).canvases,after.canvases,'canvas count does not grow on resume');
 win.webContents.debugger.detach();
 const receipt={multipleBrowsers:true,arrowHistory:true,gpuRecovery,produced,cycles,hiddenMs:resumeAt-start,hidden,resumeFramesMs:frames,resumeRoundtripMs:Date.now()-resumeAt,before,after};
 console.log('MAC_INPUT_RESUME_RECEIPT '+JSON.stringify(receipt));
 if(process.env.CANVASTTY_MAC_ARTIFACT_DIR)await writeFile(join(process.env.CANVASTTY_MAC_ARTIFACT_DIR,'macos-acceptance.json'),JSON.stringify(receipt,null,2));
 await js(`window.canvasTTY.terminal.input(${id},${JSON.stringify('\u0003')})`);
 await js(`window.canvasTTY.terminal.dispose(${id})`);
 app.quit();
}
