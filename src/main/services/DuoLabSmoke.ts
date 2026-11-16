/** Explicit two-machine acceptance in disposable profiles; never touches existing sessions. */
import { app, type BrowserWindow } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { parseDuoInvite } from "./CanvasDuoService";
export async function runDuoLabSmoke(window: BrowserWindow, output: string,uploadFiles?:(paths:unknown)=>Promise<string>): Promise<void> {
  if (!isAbsolute(output)) throw new Error("Absolute Duo lab directory required");
  await mkdir(output, { recursive: true });
  const config = JSON.parse((await readFile(join(output, "config.json"), "utf8")).replace(/^\uFEFF/, ""));
  if(config.role==='full-control'){
    const {runDuoFullCanvasLab}=await import('./DuoFullCanvasLab');await runDuoFullCanvasLab(window,output,uploadFiles);return;
  }
  if (config.role === "workspace-host" || config.role === "workspace-guest" || config.role === "workspace-probe") {
    const { runDuoWorkspaceLab } = await import("./DuoWorkspaceLab");
    await runDuoWorkspaceLab(window, output, config);
    return;
  }
  if (config.role === "walkthrough") {
    const { runDuoWalkthrough } = await import("./DuoWalkthroughLab");
    await runDuoWalkthrough(window, output, config.invite);
    return;
  }
  const run = (source: string): Promise<any> => window.webContents.executeJavaScript(source, true);
  const api = (command: any): Promise<any> => run(`window.canvasTTY.duo.command(${JSON.stringify(command)})`);
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn: () => Promise<any>, label: string, seconds = 40): Promise<any> => {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) { const result = await fn(); if (result) return result; await wait(200); }
    throw new Error(label);
  };
  const click = async (selector: string): Promise<void> => {
    await until(() => run(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`), "Missing control: " + selector);
    await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait(100);
  };
  const fill = async (selector: string, value: string): Promise<void> => {
    await until(() => run(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), 'Missing input');
    await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(100);
  };
  const submit = async (selector: string): Promise<void> => { await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`); await wait(100); };
  const capture = async (name: string): Promise<void> => { await writeFile(join(output, name + '.png'), (await window.webContents.capturePage()).toPNG()); };
  const checks: string[] = [], created: string[] = [];
  let connection: unknown;
  const terminal = (name: string, ...args: any[]): Promise<any> => run(`window.canvasTTY.terminal.${name}(${args.map(a => JSON.stringify(a)).join(',')})`);
  const comment = async (text: string): Promise<void> => { await fill('.duo-comments + form input', text); await submit('.duo-comments + form'); };
  let exitCode = 0;
  try {
    await until(() => run("Boolean(window.canvasTTY?.duo && document.querySelector('.duo-launch'))"), 'Duo did not load');
    if (!(await run("Boolean(document.querySelector('.duo-panel'))"))) await click('.duo-launch');
    if (config.role === 'host') {
      for (const name of ['Duo shared acceptance', 'Duo private acceptance']) {
        const session = await terminal('create', { provider: 'terminal', profile: 'normal', cwd: output, position: { x: 2400 + created.length * 900, y: 40 } });
        created.push(session.id); await terminal('rename', session.id, name);
      }
      const cardId = created[0];
      await terminal('input', created[1], process.platform === 'win32' ? 'echo DO_NOT_SHARE_CANVAS_PRIVATE\r' : "printf 'DO_NOT_SHARE_CANVAS_PRIVATE\\n'\r");
      await terminal('input', cardId, process.platform === 'win32' ? 'echo DUO_HOST_READY\r' : "printf 'DUO_HOST_READY\\n'\r");
      await until(() => run("document.querySelectorAll('.duo-choice').length===2"), 'Host cards not listed');
      await run(`(()=>{const row=[...document.querySelectorAll('.duo-choice')].find(e=>e.textContent.includes('Duo shared acceptance'));row.querySelector('input').click()})()`);
      if (config.transport === 'lan') await api({action:'host',transport:'lan',selected:[cardId],controlled:[]}); else await click('.duo-setup > button');
      const state = await until(async()=>{const s=(await api({action:'state'})).state;return s.role==='host'&&s.invites.length?s:null;},'Host invitation did not become ready');
      const invite = state.invites.find((code: string) => (() => { const v = parseDuoInvite(code); return v.version === 3 || v.host === config.address; })());
      if (!invite) throw new Error('Requested network interface unavailable');
      await writeFile(join(output, 'invitation.json'), JSON.stringify({ invite, cardId, command: process.platform === 'win32' ? 'powershell.exe -NoProfile -EncodedCommand ' + Buffer.from("[Console]::WriteLine('DUO_CROSS_DEVICE_OK')", 'utf16le').toString('base64') : "printf '\\104\\125\\117\\137\\103\\122\\117\\123\\123\\137\\104\\105\\126\\111\\103\\105\\137\\117\\113\\n'" }), { mode: 0o600 });
      const hasComment = async (text: string): Promise<boolean> => (await api({action:'snapshot'})).snapshot.comments.some((c: any) => c.author === 'guest' && c.text === text);
      await until(() => hasComment('GUEST_READY'), 'Guest did not join', 180);
      const initial = await api({action:'snapshot'});connection=initial.state.connection;
      if (!initial.state.peer || !initial.snapshot.cursors.some((c: any) => c.author === 'guest')) throw new Error('Guest cursor missing');
      checks.push('peer client joined; only selected card shared; read-only input denied; guest comment and cursor arrived');
      const grant = async (): Promise<void> => { if (!(await run("document.querySelector('.duo-setup').open"))) await click('.duo-setup > summary'); await run("(()=>{const row=[...document.querySelectorAll('.duo-choice')].find(e=>e.textContent.includes('Duo shared acceptance'));const e=row.querySelectorAll('input')[1];if(!e.checked)e.click()})()"); await click('.duo-setup > button'); };
      await grant();
      await until(async () => (await api({action:'snapshot'})).snapshot.cards[0]?.text?.includes('DUO_CROSS_DEVICE_OK'), 'Guest command did not reach actual host PTY');
      checks.push('explicit UI input grant; real remote command executed in host PTY and output returned');
      await capture('host-connected');
      await until(() => hasComment('REJOINED'), 'Guest did not reconnect');
      if ((await api({action:'state'})).state.controlled.length) throw new Error('Reconnect inherited input permission');
      await until(() => run("(()=>{const row=[...document.querySelectorAll('.duo-choice')].find(e=>e.textContent.includes('Duo shared acceptance'));return !row.querySelectorAll('input')[1].checked})()"), 'Host permission checkbox remained stale');
      checks.push('disconnect/rejoin releases guest slot, clears input permission and updates host checkbox');
      await grant();
      await until(() => hasComment('GRANT_OBSERVED'), 'Guest did not see renewed grant');
      await run("(()=>{const row=[...document.querySelectorAll('.duo-choice')].find(e=>e.textContent.includes('Duo shared acceptance'));row.querySelectorAll('input')[1].click()})()");
      await click('.duo-setup > button');
      await until(() => hasComment('REVOKED_OK'), 'Input revocation not observed');
      await click('.duo-stop');
      checks.push('live grant revocation blocks input; host Stop closes network listener');
    } else if (config.role === 'guest') {
      if(config.deepLink){await until(()=>run(`document.querySelector('.duo-join input')?.value===${JSON.stringify(config.invite)}`),'Deep link did not populate connection panel');checks.push('cold-start deep link opens Duo and fills invitation without joining automatically');}
      await fill('.duo-join input', config.invite); await submit('.duo-join');
      await until(() => run("document.querySelector('.duo-card pre')?.textContent.includes('DUO_HOST_READY')"), 'Guest UI did not show host terminal');
      const snapshot = await api({action:'snapshot'});connection=snapshot.state.connection;
      if (snapshot.snapshot.cards.length !== 1 || snapshot.snapshot.cards[0].id !== config.cardId || JSON.stringify(snapshot.snapshot).includes('DO_NOT_SHARE_CANVAS_PRIVATE')) throw new Error('Private card boundary failed');
      const denied = async (): Promise<void> => { let blocked = false; try { await api({action:'input',cardId:config.cardId,text:'UNAUTHORIZED\r'}); } catch { blocked=true; } if (!blocked) throw new Error('Unauthorized input accepted'); };
      await denied();
      await run("(()=>{const e=document.querySelector('.duo-screen');const r=e.getBoundingClientRect();e.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.x+r.width*.3,clientY:r.y+r.height*.4}))})()");
      await comment('GUEST_READY');
      await until(() => run("Boolean(document.querySelector('.duo-input input[maxlength=\"4000\"]'))"), 'Host input grant did not reach UI');
      if(config.backgroundSmoke){await click('.duo-panel > header button');await wait(17000);await click('.duo-launch');await until(()=>run("Boolean(document.querySelector('input[maxlength=\"4000\"]'))"),'Closing panel lost active input grant');checks.push('connection and grant survive closing Duo panel for 17 seconds');}
      await fill('.duo-input input[maxlength="4000"]', config.command); await submit('form:has(input[maxlength="4000"])');
      await until(() => run("document.querySelector('.duo-card pre')?.textContent.includes('DUO_CROSS_DEVICE_OK')"), 'Remote shell output did not return to UI');
      await capture('guest-connected');
      checks.push('actual guest React panel shows selected host terminal, command roundtrip, comments and cursor');
      await click('.duo-stop');
      await until(() => run("Boolean(document.querySelector('.duo-join'))"), 'Guest did not disconnect');
      await fill('.duo-join input', config.invite); await submit('.duo-join');
      await until(() => run("Boolean(document.querySelector('.duo-card pre'))"), 'Guest did not reconnect');
      await denied(); await comment('REJOINED');
      await until(() => run("Boolean(document.querySelector('input[maxlength=\"4000\"]'))"), 'Renewed grant missing');
      await comment('GRANT_OBSERVED');
      await until(() => run("!document.querySelector('input[maxlength=\"4000\"]')"), 'Revoked input still visible');
      await denied(); await comment('REVOKED_OK');
      await until(async () => { try { await api({action:'snapshot'}); return false; } catch { return true; } }, 'Revoked host still reachable');
      checks.push('reconnect has no inherited grant; live revocation removes input control and rejects API input; host Stop disconnects guest');
    } else throw new Error('Unknown Duo lab role');
    await writeFile(join(output,'verification.json'), JSON.stringify({ result:'passed', role:config.role, platform:process.platform, version:app.getVersion(), packaged:app.isPackaged, connection, profile:app.getPath('userData'),checks },null,2));
    console.log('CANVASTTY_DUO_LAB_OK',config.role);
  } catch (error) {
    exitCode=1; await capture('failure').catch(()=>undefined);
    await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error)},null,2));
    console.error('CANVASTTY_DUO_LAB_FAILED',String(error));
  } finally {
    await api({action:'stop'}).catch(()=>undefined);
    for (const id of created) await terminal('dispose',id).catch(()=>undefined);
    app.exit(exitCode);
  }
}
