#!/usr/bin/env node
// Fresh homes and hidden real Electron windows; no real accounts, keychain, plugins or paid agents.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const self = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const metricBoundary = 'built main entry import to first stable frame';
assert.equal(process.platform, 'darwin', 'The startup optimization benchmark is macOS-only.');
const temporaryRoot = '/private/tmp';

if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)('electron');
  const samples = [];
  for (let run = 0; run < 3; run++) {
    const fixture = await mkdtemp(join(temporaryRoot, 'ctty-boot-'));
    try {
      await mkdir(join(fixture, 'home')); await mkdir(join(fixture, 'project')); await mkdir(join(fixture, 'empty-bin'));
      // Electron treats a directory as an app, so main points only at this controlled harness.
      await writeFile(join(fixture, 'package.json'), JSON.stringify({type:'module', main:self}));
      const env = {HOME:join(fixture,'home'), USERPROFILE:join(fixture,'home'), PATH:join(fixture,'empty-bin'),
        TMPDIR:temporaryRoot, LANG:'en_US.UTF-8', SHELL:'/bin/sh', CTTY_BOOT_FIXTURE:fixture,
        CANVASTTY_USER_DATA_DIR:join(fixture,'data')};
      const log = await new Promise((resolveOutput, reject) => {
        const child = spawn(electron, [fixture], {cwd:repo, env, stdio:['ignore','pipe','pipe']});
        let output = '';
        let timedOut = false;
        let spawnError = null;
        const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL');}, 35_000);
        child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { output += part; });
        child.once('error', error => {spawnError = error;});
        child.once('close', code => {
          clearTimeout(timer);
          if (timedOut) reject(Error('startup fixture timed out'));
          else if (spawnError) reject(spawnError);
          else if (code === 0) resolveOutput(output);
          else reject(Error(output));
        });
      });
      const match = /^CTTY_BOOT_RESULT (.+)$/mu.exec(log);
      assert.ok(match, log);
      samples.push(JSON.parse(match[1]));
      process.stderr.write(`startup run ${run+1}/3: ${samples.at(-1).first_stable_frame_ms} ms\n`);
    } finally { await rm(fixture, {recursive:true, force:true}); }
  }
  const median = key => samples.map(row=>row[key]).sort((a,b)=>a-b)[1];
  process.stdout.write(JSON.stringify({correctness:true, metric_boundary:metricBoundary,
    first_stable_frame_ms:median('first_stable_frame_ms'),
    terminal_ready_ms:median('terminal_ready_ms'), samples},null,2)+'\n');
} else {
  const electron = await import('electron');
  const { registerHooks } = await import('node:module');
  const fixture = process.env.CTTY_BOOT_FIXTURE;
  assert.ok(fixture && fixture.startsWith(temporaryRoot + '/'));
  const main = pathToFileURL(join(repo,'out/main/')).href;
  const shim = pathToFileURL(join(repo,'scripts/bench-runtime/app/hidden-electron.mjs')).href;
  const noKeychain = pathToFileURL(join(repo,'scripts/bench-runtime/app/no-keychain.mjs')).href;
  registerHooks({resolve(specifier,context,next){
    if(context.parentURL?.startsWith(main)) {
      if(specifier==='electron') return {url:shim,format:'module',shortCircuit:true};
      if(specifier==='node:child_process'||specifier==='child_process')return {url:noKeychain,format:'module',shortCircuit:true};
    }
    return next(specifier,context);
  }});
  electron.app.commandLine.appendSwitch('use-mock-keychain'); electron.app.dock?.hide();
  electron.app.setPath('userData',join(fixture,'data'));
  const began = Date.now();
  let started = false;
  electron.app.on('browser-window-created',(_event,window)=>{
    if(started)return; started=true;
    const errors=[];
    window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
    void (async()=>{
      try {
        const read = code => window.webContents.executeJavaScript(code,true).catch(()=>null);
        let marks;
        for(let retry=0;retry<500;retry++) {
          marks=await read('window.__canvasTTYBootMarks');
          if(marks?.some(row=>row.name==='firstStableFrame'))break;
          await sleep(20);
        }
        const first=marks?.find(row=>row.name==='firstStableFrame'); assert.ok(first,'first stable frame was not reached');
        const requestStarted=Date.now();
        const project=join(fixture,'project');
        const session=await read(`window.canvasTTY.terminal.create({provider:'terminal',profile:'normal',cwd:${JSON.stringify(project)},position:{x:0,y:0},size:{width:720,height:400}})`);
        assert.ok(session?.id,'fixture shell creation failed');
        await read(`window.canvasTTY.terminal.input(${JSON.stringify(session.id)}, 'echo CTTY_BOOT_READY\\r')`);
        let ready=false;
        for(let retry=0;retry<500;retry++) {
          ready=await read(`Boolean(document.querySelector('[data-session-id="${session.id}"] .xterm-screen')) && window.canvasTTY.terminal.readBuffer(${JSON.stringify(session.id)}).then(row=>row.buffer.includes('CTTY_BOOT_READY'))`);
          if(ready)break;
          await sleep(20);
        }
        assert.ok(ready,'terminal chunk or fixture shell did not become ready');
        assert.equal(window.isVisible(),false); assert.equal(window.isFocused(),false);
        assert.deepEqual(errors,[],'renderer console errors');
        await read(`window.canvasTTY.terminal.dispose(${JSON.stringify(session.id)})`);
        console.log('CTTY_BOOT_RESULT '+JSON.stringify({metric_boundary:metricBoundary,
          first_stable_frame_ms:first.epochMs-began,terminal_ready_ms:Date.now()-requestStarted,marks}));
        electron.app.quit();
      } catch(error) { console.error(error.stack ?? error);electron.app.exit(1); }
    })();
  });
  await import(pathToFileURL(join(repo,'out/main/index.js')));
}
