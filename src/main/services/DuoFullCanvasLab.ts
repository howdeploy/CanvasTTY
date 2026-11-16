/** File-driven packaged acceptance harness, guarded by the existing explicit local-lab startup flag. */
import {app,webContents,type BrowserWindow} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {IPC} from '../../shared/contracts';
export async function runDuoFullCanvasLab(window:BrowserWindow,output:string,uploadFiles?:(paths:unknown)=>Promise<string>):Promise<void>{
  const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  const run=(script:string)=>window.webContents.executeJavaScript(script,true);
  while(!await run("Boolean(document.querySelector('.duo-launch')&&!document.querySelector('.loading-screen'))"))await wait(200);
  window.show();
  await writeFile(join(output,'ready.json'),JSON.stringify({pid:process.pid,platform:process.platform,version:app.getVersion(),exe:app.getPath('exe'),profile:app.getPath('userData')}));
  let seen=0;
  while(!window.isDestroyed()){
    let request:any;try{request=JSON.parse(await readFile(join(output,'request.json'),'utf8'));}catch{await wait(100);continue;}
    if(!Number.isInteger(request.seq)||request.seq<=seen){await wait(100);continue;}seen=request.seq;
    try{
      let result:unknown=null;
      if(request.script)result=await run(request.script);
      if(request.fileDropPaths){if(!uploadFiles)throw Error('File transfer lab capability unavailable');result=await uploadFiles(request.fileDropPaths);}
      if(request.reload){await new Promise<void>(resolve=>{window.webContents.once('did-finish-load',()=>resolve());window.webContents.reload();});await wait(300);result=true;}
      if(request.settings){result=await run(`window.canvasTTY.settings.update(${JSON.stringify(request.settings)})`);window.webContents.send(IPC.settingsChanged,result);}
      if(request.events){
        window.focus();window.webContents.focus();await wait(150);
        for(const event of request.events){window.webContents.sendInputEvent(event as Parameters<typeof window.webContents.sendInputEvent>[0]);await wait(request.eventDelay??45);}
      }
      if(request.insertText)await window.webContents.insertText(request.insertText);
      if(request.browserScript){
        const page=webContents.getAllWebContents().find(c=>c.getURL().startsWith(request.browserUrl));
        if(!page)throw Error('Owned browser fixture is not open');result=await page.executeJavaScript(request.browserScript,true);
      }
      if(request.capture){await wait(250);await writeFile(join(output,request.capture+'.png'),(await window.webContents.capturePage()).toPNG());}
      await writeFile(join(output,'response.json'),JSON.stringify({seq:seen,ok:true,result}));
    }catch(e){await writeFile(join(output,'response.json'),JSON.stringify({seq:seen,ok:false,error:String(e)}));}
  }
}
