import { randomUUID } from 'node:crypto';
import { type BrowserWindow, type WebContents, type MouseInputEvent } from 'electron';
import {duoKeyCode} from '../../shared/duoSurface';
import type { DuoSurfaceFrame, DuoSurfaceInput, DuoSurfacePort, DuoSurfaceRect } from '../../shared/duoSurface';
import type { BrowserService } from './BrowserService';

/** Renderer-only sharing: no screen capture permission, OS input, cookie export or second workspace. */
export class DuoCanvasSurface implements DuoSurfacePort {
  private viewport: DuoSurfaceRect|null=null;
  private frameId='';
  private geometry='';
  private target:WebContents|null=null;
  private drag: {contents:WebContents;offsetX:number;offsetY:number;button:'left'|'middle'|'right'}|null=null;
  private keys=new Set<string>();
  private inputQueue:Promise<unknown>=Promise.resolve();
  private pending:Promise<DuoSurfaceFrame>|null=null;
  constructor(private owner:()=>BrowserWindow|null,private browser:BrowserService){}
  capture():Promise<DuoSurfaceFrame>{
    if(this.pending)return this.pending;
    const task=this.captureNow().finally(()=>{if(this.pending===task)this.pending=null;});
    this.pending=task;return task;
  }
  private async captureNow():Promise<DuoSurfaceFrame>{
    const owner=this.owner();if(!owner||owner.isDestroyed()||owner.isMinimized())throw Error('Хост свернул окно Canvas. Разверните его для совместной работы.');
    const css=await owner.webContents.executeJavaScript(`(()=>{if(document.querySelector('.duo-panel'))throw Error('Хост меняет доступ Duo');const e=document.querySelector('.app__content');if(!e)throw Error('Canvas not ready');const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const z=owner.webContents.getZoomFactor();
    const viewport={x:Math.round(css.x*z),y:Math.round(css.y*z),width:Math.floor(css.width*z),height:Math.floor(css.height*z)};
    if(viewport.width<1||viewport.height<1)throw Error('Canvas is not visible.');
    const geometry=JSON.stringify(viewport);
    if(geometry!==this.geometry){this.release();this.geometry=geometry;this.frameId=randomUUID();}
    this.viewport=viewport;
    let image=await owner.webContents.capturePage(viewport,{stayAwake:true,stayHidden:true});
    if(image.isEmpty())throw Error('Canvas capture unavailable.');
    // Bound both CPU and network cost independently of Retina scaling.
    if(image.getSize().width>1280)image=image.resize({width:1280,quality:'good'});
    const layers=await this.browser.duoCapture(viewport);
    return {id:this.frameId,at:Date.now(),viewport,image:duoJpeg(image),layers};
  }
  input(frameId:string,events:DuoSurfaceInput[],authorized=()=>true):Promise<void>{
    const task=this.inputQueue.catch(()=>undefined).then(()=>this.deliver(frameId,events,authorized));this.inputQueue=task;return task;
  }
  private async deliver(frameId:string,events:DuoSurfaceInput[],authorized:()=>boolean):Promise<void>{
    const owner=this.owner(),viewport=this.viewport;
    if(!owner||owner.isDestroyed()||owner.isMinimized()||!viewport||frameId!==this.frameId)throw Error('Canvas is hidden or its geometry changed. Wait for a fresh frame.');
    const z=owner.webContents.getZoomFactor();
    for(const event of events){
      if(!authorized())throw Error("Shared canvas control was revoked.");
      if(event.type==='release'){this.release();continue;}
      if(event.type==='text'||event.type==='keyDown'||event.type==='keyUp'){
        const target=this.target;
        if(!target||target.isDestroyed())throw Error('Click the shared canvas before typing.');
        // Never allow a guest to reconfigure the connection or click local window chrome.
        if(await this.blocked(owner))throw Error('Хост открыл панель доступа Duo. Управление приостановлено.');
        if(!authorized())throw Error('Shared canvas control was revoked.');
        if(event.type==='text')await target.insertText(event.text);
        else{
          const key=duoKeyCode(event.key);
          if(!key)throw Error('Unsupported keyboard key.');
          if(event.type==='keyDown')this.keys.add(key);else this.keys.delete(key);
          target.sendInputEvent({type:event.type,keyCode:key,modifiers:modifiers(event.modifiers)});
          // Electron's synthetic keyDown does not produce the character event that
          // Chromium uses for form submission and textarea newlines. xterm handles
          // Return on keyDown and suppresses its corresponding character normally.
          if(event.type==='keyDown'&&key==='Return'&&!event.modifiers?.some(m=>m==='control'||m==='meta'||m==='alt')){
            target.sendInputEvent({type:'char',keyCode:'\r',modifiers:modifiers(event.modifiers)});
          }
        }
        continue;
      }
      if(!("x" in event))continue;
      const x=Math.round(viewport.x+event.x*Math.max(0,viewport.width-1));
      const y=Math.round(viewport.y+event.y*Math.max(0,viewport.height-1));
      if(await this.blocked(owner,x/z,y/z))throw Error('Управление этим элементом недоступно гостю.');
      if(!authorized())throw Error("Shared canvas control was revoked.");
      const native=this.browser.duoInputTarget(x,y);
      const route=this.drag ?? native ?? {contents:owner.webContents,offsetX:0,offsetY:0};
      const target=route.contents;
      if(target.isDestroyed()){this.release();throw Error('Shared surface closed.');}
      if(event.type==='mouseDown'){
        this.target=target;owner.focus();target.focus();
        this.drag={...route,button:event.button??'left'};
      }
      const mods=modifiers(event.modifiers);
      const buttons=event.type==='mouseWheel'?0:event.buttons??(this.drag?1:0);
      if(buttons&1)mods.push('leftbuttondown');if(buttons&2)mods.push('rightbuttondown');if(buttons&4)mods.push('middlebuttondown');
      const base={x:x-route.offsetX,y:y-route.offsetY,modifiers:mods};
      // A frame can introduce a new native view under a stationary guest pointer.
      // Establish hover/enter on that target before the first trusted press.
      if(event.type==='mouseDown')target.sendInputEvent({type:'mouseMove',x:base.x,y:base.y,modifiers:modifiers(event.modifiers)});
      if(event.type==='mouseWheel')target.sendInputEvent({type:'mouseWheel',...base,deltaX:event.deltaX,deltaY:event.deltaY,canScroll:true});
      else target.sendInputEvent({type:event.type,...base,button:event.button??this.drag?.button??'left',clickCount:event.clickCount??1});
      if(event.type==='mouseUp')this.drag=null;
    }
  }
  async action(action:'terminal'|'note'|'home',authorized=()=>true):Promise<void>{
    const owner=this.owner();if(!owner||owner.isDestroyed()||await this.blocked(owner))throw Error('Canvas is not available.');
    if(!authorized())throw Error('Shared canvas control was revoked.');
    await owner.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('canvas-duo-action',{detail:${JSON.stringify(action)}}))`);
  }
  private async blocked(owner:BrowserWindow,x?:number,y?:number):Promise<boolean>{
    return owner.webContents.executeJavaScript(`(()=>{if(document.querySelector('.duo-panel'))return true;${x===undefined?'return false;':`const e=document.elementFromPoint(${x},${y});return !e||Boolean(e.closest('.duo-launch,.duo-workspace-hud,.titlebar'));`}})()`);
  }
  release():void{
    if(this.drag&&!this.drag.contents.isDestroyed()){
      this.drag.contents.sendInputEvent({type:'mouseUp',x:0,y:0,button:this.drag.button,clickCount:1});
    }
    if(this.target&&!this.target.isDestroyed())for(const key of this.keys)this.target.sendInputEvent({type:'keyUp',keyCode:key});
    this.drag=null;this.keys.clear();this.target=null;
  }
}
function modifiers(values:string[]=[]):NonNullable<MouseInputEvent['modifiers']>{return values.filter(v=>['shift','control','alt','meta'].includes(v)) as NonNullable<MouseInputEvent['modifiers']>;}
/** Keep the encrypted frame well below the 2 MiB transport ceiling even for noisy Retina media. */
export function duoJpeg(image:Electron.NativeImage):string{
  let data=image.toJPEG(64);
  while(data.length>100_000&&image.getSize().width>320){image=image.resize({width:Math.round(image.getSize().width*.8),quality:'good'});data=image.toJPEG(58);}
  return 'data:image/jpeg;base64,'+data.toString('base64');
}
