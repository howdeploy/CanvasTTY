/** Isolated lab display only: actual plugin UI + unmodified system Zenity + XQueryTree. */
import { app, type BrowserWindow, type WebFrameMain } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function runLinuxDesktopLabSmoke(window: BrowserWindow, output: string): Promise<string[]> {
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const fixture = join(output, 'foreign-window.txt'); await writeFile(fixture, 'CanvasTTY actual packaged application acceptance\nUnmodified system Zenity.\n');
  const title = 'CanvasTTY alpha3 real foreign window';
  const child = spawn('/usr/bin/zenity', ['--text-info','--filename',fixture,'--title',title,'--width','640','--height','420'], { env: { ...process.env, GDK_BACKEND:'x11', NO_AT_BRIDGE:'1' }, stdio:'ignore' });
  const handle = window.getNativeWindowHandle();
  const parent = (handle.length>=8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
  const module = app.isPackaged ? join(process.resourcesPath,'desktop-apps-linux/window-host.py') : join(app.getAppPath(),'native/desktop-apps-linux/window-host.py');
  const python = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('probe',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
h=m.Host(int(sys.argv[2]),int(sys.argv[3]));w=int(sys.argv[5]) if sys.argv[5]!='0' else next((int(c['Handle']) for c in h.candidates() if c['Pid']==int(sys.argv[4])),0)
if not w: print('{}');sys.exit(0)
a=h.attributes(w);p,cs=h.children(w);chain=[p]
while chain[-1] and chain[-1]!=h.root and len(chain)<20: chain.append(h.children(chain[-1])[0])
print(json.dumps(dict(window=w,parent=p,chain=chain,width=a.width,height=a.height)))`;
  const inspect = (id=0): any => {
    const p=spawnSync('/usr/bin/python3',['-c',python,module,String(process.pid),parent,String(child.pid),String(id)],{encoding:'utf8',timeout:5000});
    if(p.status!==0) throw new Error('X11 inspection failed: '+p.stderr); return JSON.parse(p.stdout);
  };
  let frame: WebFrameMain | undefined, before: any, after: any, restored: any;
  const run = (source: string): Promise<any> => { if(!frame) throw new Error('App Windows iframe missing'); return frame.executeJavaScript(source); };
  const until = async (source: string): Promise<void> => { for(let i=0;i<100;i++){if(await run(source))return;await wait(100);}throw new Error('Desktop UI timeout: '+source); };
  try {
    for(let i=0;i<100;i++){before=inspect();if(before.window)break;await wait(100);}
    if(!before?.window) throw new Error('Real Zenity window not enumerated');
    for(let i=0;i<100;i++){frame=window.webContents.mainFrame.framesInSubtree.find(f=>f.url.includes('com.canvastty.app-windows'));if(frame && await frame.executeJavaScript("Boolean(document.querySelector('#refresh'))"))break;await wait(100);}
    await until("!document.querySelector('#refresh').disabled");
    await run("document.querySelector('#refresh').click()");
    await until(`Boolean([...document.querySelectorAll('.window-option')].find(e=>e.textContent.includes(${JSON.stringify(title)})))`);
    await run(`document.querySelector('#windows').click(); [...document.querySelectorAll('.window-option')].find(e=>e.textContent.includes(${JSON.stringify(title)})).click();document.querySelector('#attach').click()`);
    await until("document.body.dataset.attached==='true' && !document.querySelector('#detach').disabled");
    for(let i=0;i<60;i++){after=inspect(before.window);if(after.chain.includes(Number(parent)) && after.parent!==before.parent && after.width>10)break;await wait(100);}
    if(!after.chain.includes(Number(parent)) || after.parent===before.parent) throw new Error('Original foreign window is not a descendant of the actual Electron window');
    await writeFile(join(output,'native-ready.json'),JSON.stringify({window:before.window}));
    // Keep the real foreign window attached until an independent display observer
    // has captured the settled UI. capturePage alone omits native child windows.
    let observed=false;
    for(let i=0;i<100;i++){try{await access(join(output,'native-visibility.json'));observed=true;break;}catch{await wait(100);}}
    if(!observed) throw new Error('Independent native display capture did not complete');
    await writeFile(join(output,'app-windows.png'),(await window.webContents.capturePage()).toPNG());
    await run("document.querySelector('#detach').click()");
    await until("document.body.dataset.attached==='false'");
    restored=inspect(before.window);
    if(restored.parent!==before.parent || restored.width!==before.width || restored.height!==before.height || child.exitCode!==null) throw new Error('Foreign application was not safely restored');
    await writeFile(join(output,'native-app-window.json'),JSON.stringify({result:'passed',source:'/usr/bin/zenity (unmodified)',through:'packaged App Windows plugin UI',canvasXid:parent,before,embedded:after,restored,applicationAlive:true},null,2));
    return ['packaged Linux App Windows UI: real Zenity window reparented inside actual Electron XID; Detach restores parent and dimensions, application survives'];
  } finally {
    if(frame) await run("document.querySelector('#detach')?.click()").catch(()=>undefined);
    if(child.exitCode===null) child.kill();
  }
}
