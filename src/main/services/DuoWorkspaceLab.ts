/** Packaged two-machine acceptance, explicitly enabled in a disposable lab profile. */
import { app, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function runDuoWorkspaceLab(window: BrowserWindow, output: string, config: {role:string;invite?:string}): Promise<void> {
  const run = (source: string): Promise<any> => window.webContents.executeJavaScript(source, true);
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (source: string, label: string, seconds = 90): Promise<any> => {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) { const value = await run(source); if (value) return value; await wait(180); }
    throw new Error(label);
  };
  const click = async (selector: string): Promise<void> => {
    await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, "Missing " + selector);
    await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait(150);
  };
  const fill = async (selector: string, value: string): Promise<void> => {
    await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`);await wait(120);
  };
  const submitComment = async (text: string): Promise<void> => {
    await fill('input[aria-label="Общий комментарий"]',text);
    await click('.duo-shared-comments form button');
    await until(`document.querySelector('.duo-shared-comments')?.textContent.includes(${JSON.stringify(text)})`,"Comment not rendered");
  };
  const capture = async (name: string): Promise<void> => {
    await run("document.querySelectorAll('input').forEach(e=>{if(e.value.startsWith('canvasduo://'))e.type='password'})");
    await wait(200);
    await writeFile(join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());
  };
  const api = (command: any): Promise<any> => run(`window.canvasTTY.duo.command(${JSON.stringify(command)})`);
  const terminal = (name: string,...args: any[]):Promise<any> => run(`window.canvasTTY.terminal.${name}(${args.map(a=>JSON.stringify(a)).join(',')})`);
  const drag = async (id: string, dx: number, dy: number): Promise<void> => {
    window.focus(); window.webContents.focus(); await wait(200);
    await run("window.__duoPointerEvents=[]; if(!window.__duoPointerProbe){window.__duoPointerProbe=true;for(const type of ['pointerdown','pointermove','pointerup'])window.addEventListener(type,e=>{window.__duoPointerEvents.push({type:e.type,x:e.clientX,y:e.clientY,buttons:e.buttons,target:e.target.className});if(window.__duoPointerEvents.length>24)window.__duoPointerEvents.shift()},true)}");
    const point = await run(`(()=>{const e=document.querySelector('[data-session-id="${id}"] .terminal-card__header');if(!e)throw Error('Card header not rendered');const r=e.getBoundingClientRect();return{x:Math.round(r.left+Math.min(150,r.width/3)),y:Math.round(r.top+r.height/2)}})()`);
    window.webContents.sendInputEvent({type:'mouseMove',...point});
    window.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1,modifiers:['leftbuttondown']});
    await wait(80);
    for(let i=1;i<=8;i++){window.webContents.sendInputEvent({type:'mouseMove',x:point.x+Math.round(dx*i/8),y:point.y+Math.round(dy*i/8),button:'left',modifiers:['leftbuttondown']});await wait(35);}
    window.webContents.sendInputEvent({type:'mouseUp',x:point.x+dx,y:point.y+dy,button:'left',clickCount:1});await wait(700);
    await writeFile(join(output,'last-pointer-diagnostic.json'),JSON.stringify({id,point,dx,dy,events:await run('window.__duoPointerEvents'),metrics:await run('({innerWidth,innerHeight,dpr:devicePixelRatio,focus:document.hasFocus()})')},null,2));
  };
  const checks: string[] = [];
  const report: Record<string,any>={platform:process.platform,pid:process.pid,exe:app.getPath('exe'),profile:app.getPath('userData'),version:app.getVersion(),packaged:app.isPackaged,role:config.role,capture:'BrowserWindow.webContents.capturePage',checks};
  try {
    await until("Boolean(window.canvasTTY?.duo && document.querySelector('.duo-launch'))",'App not ready');window.show();
    if(config.role==='workspace-probe') {
      const created=await terminal('create',{provider:'terminal',profile:'normal',cwd:output,position:{x:80,y:80},title:'Owned drag probe'});
      await until(`Boolean(document.querySelector('[data-session-id="${created.id}"] .terminal-card__header'))`,'Probe card not rendered');
      await drag(created.id,75,70);
      const after=(await terminal('list')).find((c:any)=>c.id===created.id);
      report.before=created;report.after=after;
      if(after.position.x===created.position.x&&after.position.y===created.position.y)throw Error('Native drag probe did not change actual bounds');
      checks.push('Trusted Chromium pointer events moved actual TerminalManager card');report.result='passed';
      await capture('01-drag-probe');
    } else if(config.role==='workspace-host') {
      const shared=await terminal('create',{provider:'terminal',profile:'normal',cwd:output,position:{x:80,y:80},title:'Duo · общий терминал Mac'});
      const privateCard=await terminal('create',{provider:'terminal',profile:'normal',cwd:output,position:{x:2000,y:80},title:'PRIVATE — не передаётся'});
      report.sharedId=shared.id;report.privateId=privateCard.id;
      await terminal('input',shared.id,"printf '\\033[32mDUO_HOST_READY\\033[0m\\n'\r");
      await click('.duo-launch');
      await click('.duo-sharing-scope button:nth-child(2)');
      await until("document.querySelectorAll('.duo-choice').length===2",'Host selection not loaded');
      await run(`(()=>{const row=[...document.querySelectorAll('.duo-choice')].find(e=>e.textContent.includes('общий терминал Mac'));row.querySelector('input').click();row.querySelectorAll('input')[1].click();document.querySelector('.duo-manage input').click()})()`);
      await click('.duo-setup > button');
      await until("Boolean(document.querySelector('.duo-workspace-hud'))",'Shared workspace not shown');
      const state=(await api({action:'state'})).state;
      await writeFile(join(output,'invitation.json'),JSON.stringify({invite:state.invites[0],sharedId:shared.id}),{mode:0o600});
      await capture('01-mac-waiting');
      await until("document.querySelector('.duo-shared-comments')?.textContent.includes('WINDOWS_JOINED')",'Guest comment not rendered',300);
      await capture('02-mac-guest-comment');checks.push('Windows comment rendered on main Mac canvas');
      await until("document.querySelectorAll('.terminal-card').length===2",'Guest terminal not on host main canvas');
      const snapshot=(await api({action:'snapshot'})).snapshot;
      const guestCard=snapshot.cards.find((c:any)=>c.id!==shared.id);
      if(!guestCard || guestCard.id===privateCard.id)throw Error('Wrong shared card IDs');
      report.guestCreatedId=guestCard.id;report.workspaceId=snapshot.workspaceId;
      await until(`window.canvasTTY.terminal.readBuffer(${JSON.stringify(guestCard.id)}).then(o=>o.buffer.includes('DUO_REAL_PTY_FROM_WINDOWS'))`,'Guest keyboard did not reach host PTY');
      checks.push('Guest-created card is a real Mac PTY; Windows xterm keyboard reached it');
      await fill('.duo-shared-comments select',guestCard.id);
      await submitComment('MAC_SEES_SHARED_TERMINAL');
      await capture('03-mac-shared-terminal');
      await until(`window.canvasTTY.terminal.list().then(s=>s.some(c=>c.id===${JSON.stringify(guestCard.id)}&&c.title==='Windows → общий Mac'))`,'Guest rename not applied');
      const before=snapshot.cards.find((c:any)=>c.id===guestCard.id);
      await until(`window.canvasTTY.terminal.list().then(s=>{const c=s.find(c=>c.id===${JSON.stringify(guestCard.id)});return c&&c.position.y!==${before.position.y}})`,'Guest drag not applied');
      report.guestMovedBounds=(await terminal('list')).find((c:any)=>c.id===guestCard.id);
      checks.push('Guest rename and native mouse drag updated actual host card');
      // Move the original host card, which is in this host camera viewport.
      await drag(shared.id,60,55);
      report.hostMovedBounds=(await terminal('list')).find((c:any)=>c.id===shared.id);
      if(report.hostMovedBounds.position.x===shared.position.x&&report.hostMovedBounds.position.y===shared.position.y)throw Error('Host drag did not move card');
      await submitComment('MAC_MOVED_HOST_CARD');
      await until("document.querySelector('.duo-shared-comments')?.textContent.includes('WINDOWS_SAW_HOST_MOVE')",'Host move not seen on Windows');
      await capture('04-mac-bidirectional');
      checks.push('Host native mouse drag was observed on Windows');
      report.result='passed';report.leftOpen=true;
    } else {
      if(!config.invite?.startsWith('canvasduo://'))throw Error('Fresh invitation missing');
      await click('.duo-launch');await fill('.duo-join input',config.invite);await click('.duo-join button');
      await until("Boolean(document.querySelector('.duo-workspace-hud')&&document.querySelector('.terminal-card .xterm'))",'Remote xterm card did not render',90);
      if(await run("Boolean(document.querySelector('.duo-panel'))"))throw Error('Still in modal instead of shared canvas');
      let snapshot=(await api({action:'snapshot'})).snapshot;report.workspaceId=snapshot.workspaceId;report.sharedId=snapshot.cards[0].id;
      if(snapshot.cards.length!==1 || JSON.stringify(snapshot).includes('PRIVATE —'))throw Error('Private card leaked');
      await capture('01-windows-real-shared-canvas');
      await submitComment('WINDOWS_JOINED');
      await click('.duo-workspace-hud > button');
      await until("document.querySelectorAll('.terminal-card').length===2",'Guest create did not render shared card');
      snapshot=(await api({action:'snapshot'})).snapshot;
      const created=snapshot.cards.find((c:any)=>c.id!==report.sharedId);report.guestCreatedId=created?.id;
      if(!created)throw Error('No host confirmation of created card');
      const locals=await terminal('list');if(locals.some((c:any)=>c.id===created.id))throw Error('Guest accidentally created a local PTY');
      checks.push('Main-canvas button created host card; no Windows PTY was created');
      // Real xterm receives keyboard through Chromium, no direct input RPC in this check.
      await run(`document.querySelector('[data-session-id="${created.id}"] .xterm-helper-textarea').focus()`);
      await window.webContents.insertText("printf '\\104\\125\\117\\137\\122\\105\\101\\114\\137\\120\\124\\131\\137\\106\\122\\117\\115\\137\\127\\111\\116\\104\\117\\127\\123\\n'");
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      await until(`window.canvasTTY.duo.command({action:'snapshot'}).then(r=>r.snapshot.cards.some(c=>c.id===${JSON.stringify(created.id)}&&c.text.includes('DUO_REAL_PTY_FROM_WINDOWS')))`,'Remote command output missing');
      await fill('.duo-shared-comments select',created.id);
      await until("document.querySelector('.duo-shared-comments')?.textContent.includes('MAC_SEES_SHARED_TERMINAL')",'Mac comment not rendered');
      await capture('02-windows-live-host-pty');checks.push('Remote ANSI output and Mac reply rendered in real Windows client');
      await api({action:'rename',cardId:created.id,text:'Windows → общий Mac'});
      await wait(1200);await drag(created.id,-70,65);
      await until("document.querySelector('.duo-shared-comments')?.textContent.includes('MAC_MOVED_HOST_CARD')",'Mac drag not completed');
      const final=(await api({action:'snapshot'})).snapshot;
      const moved=final.cards.find((c:any)=>c.id===report.sharedId);
      if(moved.position.x===80&&moved.position.y===80)throw Error('Windows retained old host geometry');
      report.hostMovedBounds=moved;await submitComment('WINDOWS_SAW_HOST_MOVE');
      await capture('03-windows-bidirectional');checks.push('Host geometry update rendered and guest comment returned');
      report.result='passed';report.leftOpen=true;
    }
    if(config.role!=='workspace-probe'){report.final=(await api({action:'snapshot'})).snapshot;report.connection=(await api({action:'state'})).state.connection;}
  }catch(error){report.result='failed';report.error=String(error).replace(/canvasduo:\/\/\S+/g,'[redacted]');await capture('99-failure').catch(()=>undefined);}
  report.finishedAt=new Date().toISOString();
  await writeFile(join(output,'verification.json'),JSON.stringify(report,null,2));
}
