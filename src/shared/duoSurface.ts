/** Remote presentation of the *same* host renderer, never a second local canvas. */
export interface DuoSurfaceRect { x: number; y: number; width: number; height: number }
export interface DuoSurfaceLayer extends DuoSurfaceRect { image: string }
export interface DuoSurfaceFrame {
  id: string;
  at: number;
  viewport: DuoSurfaceRect;
  image: string;
  layers: DuoSurfaceLayer[];
}
export type DuoSurfaceInput =
  | {type:'mouseMove'|'mouseDown'|'mouseUp';x:number;y:number;button?:'left'|'middle'|'right';buttons?:number;clickCount?:number;modifiers?:string[]}
  | {type:'mouseWheel';x:number;y:number;deltaX:number;deltaY:number;modifiers?:string[]}
  | {type:'keyDown'|'keyUp';key:string;modifiers?:string[]}
  | {type:'text';text:string}
  | {type:'release'};
export interface DuoSurfacePort {
  capture(): Promise<DuoSurfaceFrame>;
  input(frameId:string,events:DuoSurfaceInput[],authorized?:()=>boolean):Promise<void>;
  action?(action:"terminal"|"note"|"home",authorized?:()=>boolean):Promise<void>;
  release():void;
}
const MODIFIERS=new Set(['shift','control','alt','meta']);
/** Validate the entire batch before delivering any input. No arbitrary Electron event objects. */
export function validSurfaceInputs(events:unknown):events is DuoSurfaceInput[] {
  if(!Array.isArray(events)||!events.length||events.length>32)return false;
  const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=100_000;
  return events.every(e=>{
    if(!e||typeof e!=='object')return false;
    if(e.modifiers!==undefined&&(!Array.isArray(e.modifiers)||e.modifiers.length>4||!e.modifiers.every((m:unknown)=>typeof m==='string'&&MODIFIERS.has(m))))return false;
    if(e.type==='release')return true;
    if(e.type==='text')return typeof e.text==='string'&&e.text.length>0&&e.text.length<=4096;
    if(e.type==='keyDown'||e.type==='keyUp')return typeof e.key==='string'&&duoKeyCode(e.key)!==null;
    if(!finite(e.x)||!finite(e.y)||e.x<0||e.y<0||e.x>1||e.y>1)return false;
    if(e.type==='mouseWheel')return finite(e.deltaX)&&finite(e.deltaY)&&Math.abs(e.deltaX)<=2000&&Math.abs(e.deltaY)<=2000;
    return ['mouseDown','mouseUp','mouseMove'].includes(e.type)&&(e.button===undefined||['left','middle','right'].includes(e.button))&&(e.buttons===undefined||Number.isInteger(e.buttons)&&e.buttons>=0&&e.buttons<=7)&&(e.clickCount===undefined||Number.isInteger(e.clickCount)&&e.clickCount>=1&&e.clickCount<=3);
  });
}
export function validSurfaceFrame(frame:unknown):frame is DuoSurfaceFrame {
  const f=frame as DuoSurfaceFrame;
  const image=(v:unknown):boolean=>typeof v==='string'&&v.length<=400_000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(v);
  const rect=(r:DuoSurfaceRect):boolean=>!!r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0;
  return !!f&&typeof f.id==='string'&&/^[\w-]{1,80}$/.test(f.id)&&Number.isFinite(f.at)&&rect(f.viewport)&&f.viewport.width<=16384&&f.viewport.height<=16384&&image(f.image)&&Array.isArray(f.layers)&&f.layers.length<=1&&f.layers.every(l=>rect(l)&&l.x>=0&&l.y>=0&&l.x+l.width<=1.001&&l.y+l.height<=1.001&&image(l.image));
}

export function duoKeyCode(key:string):string|null{
 const names:Record<string,string>={Enter:'Return',Escape:'Escape',Backspace:'Backspace',Delete:'Delete',Tab:'Tab',ArrowLeft:'Left',ArrowRight:'Right',ArrowUp:'Up',ArrowDown:'Down',Home:'Home',End:'End',PageUp:'PageUp',PageDown:'PageDown',Shift:'Shift',Control:'Control',Alt:'Alt',Meta:'Meta',' ':'Space',Insert:'Insert',CapsLock:'CapsLock'};
 return names[key]??(/^(F([1-9]|1[0-9]|2[0-4])|[!-~])$/.test(key)?key:null);
}
