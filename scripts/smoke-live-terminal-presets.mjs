import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), electron = require('electron');
const repo = resolve(import.meta.dirname, '..');
if (typeof electron === 'string') {
  const temp = await mkdtemp(join(tmpdir(), 'ct-live-presets-'));
  try {
    const { build } = await import('vite'), { default: react } = await import('@vitejs/plugin-react');
    await build({ configFile: false, root: join(repo,'tests/fixtures/live-terminal-presets'), base: './', plugins: [react()], worker: { format: 'es' }, logLevel: 'error', build: { outDir: join(temp,'renderer'), target: 'esnext' } });
    const { build: bundle } = await import('esbuild');
    await bundle({ entryPoints: [join(repo,'src/main/services/PixelSkinPackRegistry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(temp,'registry.cjs'), packages: 'external', define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(repo,'package.json')).href) } });
    await bundle({ entryPoints: [join(repo,'src/main/windowState.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(temp,'state.cjs') });
    const output = resolve(process.argv[2] ?? join(repo,'../acceptance/live-terminal-presets'));
    await mkdir(output, { recursive: true });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [import.meta.filename,'--probe',temp,output,process.argv[3] ?? '',process.argv[4] ?? ''], { env, stdio: 'inherit' });
    const timer = setTimeout(()=>child.kill('SIGKILL'), 120_000);
    try { assert.equal(await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);}),0); }
    finally { clearTimeout(timer); }
  } finally { await rm(temp,{recursive:true,force:true}); }
} else void probe();
async function probe() {
  const { app, BrowserWindow, ipcMain } = electron;
  let registry, window;
  try {
    await app.whenReady();
    const index = process.argv.indexOf('--probe'), [temp, output, themePath, aperturesPath] = process.argv.slice(index+1,index+5);
    // Resolve dependencies from the project, never a global package location.
    const { PixelSkinPackRegistry } = require(join(temp,'registry.cjs'));
    registry = new PixelSkinPackRegistry(join(temp,'profile'), themePath ? undefined : join(repo,'assets/live-terminal-presets'));
    await registry.initialize();
    if (themePath) await registry.installZip(await readFile(themePath), 'External live theme', JSON.parse(await readFile(aperturesPath, 'utf8')));
    const expectedPacks = themePath ? 1 : JSON.parse(await readFile(join(repo,'assets/live-terminal-presets/catalog.json'),'utf8')).presets.length;
    assert.equal(registry.list().length, expectedPacks);
    ipcMain.handle('preset:list',()=>registry.list());
    ipcMain.handle('preset:read',(_event,id,slot)=>registry.readAsset(id,slot));
    window = new BrowserWindow({ width: 1440, height: 600, show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: join(repo,'tests/fixtures/live-terminal-presets/preload.cjs'), backgroundThrottling: false } });
    const { readWindowState, observeWindowState } = require(join(temp,'state.cjs'));
    ipcMain.handle('preset:window-get',()=>readWindowState(window));
    const stopObserving = observeWindowState(window,state=>window.webContents.send('preset:window-state',state));
    const errors = [];
    window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
    await window.loadFile(join(temp,'renderer/index.html')); window.showInactive();
    const run = source=>window.webContents.executeJavaScript(source);
    const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));
    for (let tries=0;tries<120;tries++){if(await run(`Boolean(window.presetProbe && document.querySelectorAll('.terminal-skin-media img').length===1 && [...document.querySelectorAll('.terminal-skin-media img')].every(i=>i.complete&&i.naturalWidth===1536))`))break;await delay(50);}
    assert.equal(await run("document.querySelectorAll('.terminal-skin-media img').length"),1);
    // GIF encoders coalesce identical poses into a longer frame. Check every
    // decoded frame; do not confuse authored time steps with stored GIF frames.
    const decoded = await run('window.presetProbe.verifyApertures()'); assert.ok(decoded >= 18 * expectedPacks);
    const checks = [themePath ? 'new engine ZIP imported by production registry in fresh profile' : 'fresh-profile production registry installs all catalog entries', `${decoded} Chromium-decoded animation frames have a fully transparent terminal aperture`];
    for (const detail of ['minimal','detailed','master']) for (const [state,status] of [['idle','idle'],['working','working'],['completed','done']]) {
      await run(`window.presetProbe.set(${JSON.stringify({detail,status})})`); await delay(350);
      const rect = await run("(()=>{const r=document.getElementById('1').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y)+12,width:Math.round(r.width),height:72}})()");
      const first = (await window.webContents.capturePage(rect)).toBitmap();
      let changed = false;
      for (let attempts = 0; attempts < 5 && !changed; attempts++) {
        await delay(375);
        changed = !first.equals((await window.webContents.capturePage(rect)).toBitmap());
      }
      assert.ok(changed, `${detail}/${state} border must move on screen`);
      await writeFile(join(output,`${detail}-${state}.png`),(await window.webContents.capturePage()).toPNG());
    }
    checks.push('all detail levels and session states render and animate in production React components');
    await run('window.presetProbe.set({paused:true})'); await delay(400);
    assert.equal(await run("document.querySelectorAll('.terminal-skin-media canvas').length"),1);
    const still=(await window.webContents.capturePage()).toBitmap(); await delay(500);
    assert.deepEqual(still,(await window.webContents.capturePage()).toBitmap());
    await run('window.presetProbe.set({paused:false})'); await delay(250);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]}); await delay(350);
    assert.equal(await run("document.querySelectorAll('.terminal-skin-media canvas').length"),1);
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    window.webContents.debugger.detach();
    await run('window.presetProbe.set({offscreen:true})'); await delay(350);
    assert.equal(await run("document.querySelectorAll('.terminal-skin-media canvas').length"),1);
    await run('window.presetProbe.set({offscreen:false})'); await delay(350);
    assert.equal(await run("document.querySelectorAll('.terminal-skin-media img').length"),1);
    window.hide(); await delay(500);
    assert.equal(await run("document.querySelectorAll('.terminal-skin-media canvas').length"),1);
    checks.push('pause freezes the actual compositor; system reduced-motion uses still frames');
    checks.push('offscreen cards and hidden window freeze animations; visible cards resume');
    // Keep an immediately readable nine-frame comparison for visual acceptance.
    window.setSize(1140, 850); window.showInactive();
    await run('window.presetProbe.set({comparison:true,paused:false})');
    for (let tries=0;tries<120;tries++) {
      if (await run("document.querySelectorAll('.terminal-skin-media img').length===9 && [...document.querySelectorAll('.terminal-skin-media img')].every(i=>i.complete&&i.naturalWidth===1536)")) break;
      await delay(50);
    }
    assert.equal(await run("document.querySelectorAll('.terminal-skin-media img').length"), 9);
    await delay(350);
    await writeFile(join(output,'state-grid.png'),(await window.webContents.capturePage()).toPNG());
    await run('window.presetProbe.set({paused:true})'); await delay(400);
    await writeFile(join(output,'state-grid-paused.png'),(await window.webContents.capturePage()).toPNG());
    checks.push('nine production skin views captured together, both moving and paused; columns idle, working, done');
    assert.deepEqual(errors,[]);
    await writeFile(join(output,'verification.json'),JSON.stringify({result:'passed',checks,decodedFrames:decoded,errors},null,2));
    console.log('LIVE_TERMINAL_PRESETS_OK'); stopObserving(); window.destroy(); app.exit(0);
  } catch(error){console.error(error);window?.destroy();app.exit(1);}
}
