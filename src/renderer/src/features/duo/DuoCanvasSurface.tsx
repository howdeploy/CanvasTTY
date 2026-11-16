import { useEffect, useRef, useState } from 'react';
import type { DuoSurfaceFrame, DuoSurfaceInput } from '../../../../shared/duoSurface';
import { useDuoWorkspace } from './duoWorkspaceRuntime';

/** The host's live Canvas. A guest gesture operates the original widget, never a local replica. */
export default function DuoCanvasSurface():React.JSX.Element {
  const view=useDuoWorkspace();
  const [frame,setFrame]=useState<DuoSurfaceFrame|null>(null);
  const [error,setError]=useState('');
  const latest=useRef(frame);latest.current=frame;
  const queue=useRef<DuoSurfaceInput[]>([]);
  const element=useRef<HTMLDivElement>(null);
  const shell=useRef<HTMLElement>(null);
  const [size,setSize]=useState({width:0,height:0});
  useEffect(()=>{const e=shell.current!;const observer=new ResizeObserver(()=>setSize({width:e.clientWidth,height:e.clientHeight}));observer.observe(e);return()=>observer.disconnect();},[]);
  const canControl=Boolean(view.connected&&view.reply?.state.manage);
  const enabled=useRef(canControl);enabled.current=canControl;
  const workspaceId=view.reply?.state.workspaceId;
  const send=(event:DuoSurfaceInput):void=>{
    if(!enabled.current||!latest.current)return;
    const last=queue.current.at(-1);
    if(event.type==='mouseMove'&&last?.type==='mouseMove')queue.current[queue.current.length-1]=event;
    else if(queue.current.length<128)queue.current.push(event);
    else {queue.current=[{type:'release'}];setError('Слишком быстрый ввод. Повторите действие.');}
  };
  useEffect(()=>{
    let disposed=false,frameTimer:ReturnType<typeof setTimeout>,inputTimer:ReturnType<typeof setTimeout>;
    const poll=async():Promise<void>=>{
      const started=performance.now();
      try{
        if(document.visibilityState==='visible'){
          const reply=await window.canvasTTY.duo.command({action:'surface'});
          if(!disposed&&reply.state.workspaceId===workspaceId&&reply.snapshot?.surface){setFrame(reply.snapshot.surface);setError('');}
        }
      }catch(e){if(!disposed)setError(String(e instanceof Error?e.message:e));}
      if(!disposed)frameTimer=setTimeout(()=>void poll(),Math.max(30,160-(performance.now()-started)));
    };
    const flush=async():Promise<void>=>{
      try{
        if(!enabled.current)queue.current=[];
        if(queue.current.length&&latest.current){
          const events=queue.current.splice(0,32);
          // Never retry ambiguous keyboard/mouse delivery.
          await window.canvasTTY.duo.command({action:'surface-input',frameId:latest.current.id,events});
        }
      }catch(e){queue.current=[];if(latest.current)void window.canvasTTY.duo.command({action:'surface-input',frameId:latest.current.id,events:[{type:'release'}]}).catch(()=>undefined);if(!disposed)setError(String(e instanceof Error?e.message:e));}
      if(!disposed)inputTimer=setTimeout(()=>void flush(),70);
    };
    const release=():void=>{queue.current=[];if(latest.current&&enabled.current)void window.canvasTTY.duo.command({action:'surface-input',frameId:latest.current.id,events:[{type:'release'}]}).catch(()=>undefined);};
    const visibility=():void=>{if(document.visibilityState==='hidden')release();};
    window.addEventListener('blur',release);document.addEventListener('visibilitychange',visibility);
    void poll();void flush();
    return()=>{disposed=true;clearTimeout(frameTimer);clearTimeout(inputTimer);release();window.removeEventListener('blur',release);document.removeEventListener('visibilitychange',visibility);};
  },[workspaceId]);
  const point=(e:{clientX:number;clientY:number}):{x:number;y:number}=>{
    const r=element.current!.getBoundingClientRect();
    return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};
  };
  const mods=(e:{shiftKey:boolean;ctrlKey:boolean;altKey:boolean;metaKey:boolean}):string[]=>[e.shiftKey?'shift':'',e.ctrlKey?'control':'',e.altKey?'alt':'',e.metaKey?'meta':''].filter(Boolean);
  const key=(e:React.KeyboardEvent,up:boolean):void=>{
    e.stopPropagation();if(!canControl)return;
    if(e.nativeEvent.isComposing)return;
    // Browser paste carries real text in onPaste, not a host clipboard shortcut.
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v')return;
    e.preventDefault();
    if(!up&&e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)send({type:'text',text:e.key});
    else if(e.key.length!==1||e.ctrlKey||e.metaKey||e.altKey)send({type:up?'keyUp':'keyDown',key:e.key,modifiers:mods(e)});
  };
  return <section ref={shell} className="duo-surface-shell" aria-label="Полный общий Canvas">
    <div className="duo-surface-hint" role="status">{canControl?'Общий Canvas · мышь и клавиатура управляют тем же холстом хозяина':'Общий Canvas · просмотр, управление разрешает хозяин'} · область просмотра общая</div>
    {!frame&&<p className="duo-surface-loading">{error||'Подключаем живой холст…'}</p>}
    {frame&&<div ref={element} className={`duo-surface${canControl?' duo-surface--control':''}`} tabIndex={0}
      style={{width:Math.min(size.width,size.height*frame.viewport.width/frame.viewport.height)||"100%",aspectRatio:`${frame.viewport.width} / ${frame.viewport.height}`}}
      contentEditable={canControl} suppressContentEditableWarning onBeforeInput={e=>{e.preventDefault();const text=(e.nativeEvent as InputEvent).data;if(text)send({type:"text",text});}}
      role="application" aria-label="Живой холст хозяина" onContextMenu={e=>e.preventDefault()}
      onPointerDown={e=>{e.preventDefault();e.stopPropagation();e.currentTarget.focus();if(canControl){e.currentTarget.setPointerCapture(e.pointerId);send({type:'mouseDown',...point(e),button:e.button===2?'right':e.button===1?'middle':'left',buttons:e.buttons,clickCount:e.detail||1,modifiers:mods(e)});}}}
      onPointerMove={e=>{e.stopPropagation();send({type:'mouseMove',...point(e),buttons:e.buttons,modifiers:mods(e)});}}
      onPointerUp={e=>{e.preventDefault();e.stopPropagation();send({type:'mouseUp',...point(e),button:e.button===2?'right':e.button===1?'middle':'left',buttons:e.buttons,modifiers:mods(e)});if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
      onPointerCancel={()=>send({type:'release'})}
      onWheel={e=>{e.preventDefault();e.stopPropagation();send({type:'mouseWheel',...point(e),deltaX:Math.max(-2000,Math.min(2000,-e.deltaX)),deltaY:Math.max(-2000,Math.min(2000,-e.deltaY)),modifiers:mods(e)});}}
      onKeyDown={e=>key(e,false)} onKeyUp={e=>key(e,true)}
      onCompositionEnd={e=>{if(e.data)send({type:'text',text:e.data});}}
      onPaste={e=>{e.preventDefault();e.stopPropagation();const text=e.clipboardData.getData('text/plain');if(text.length>4096)setError('Вставляйте текст порциями до 4096 символов.');else if(text)send({type:'text',text});}}
      onBlur={()=>send({type:'release'})}>
      <img className="duo-surface__base" src={frame.image} alt="" draggable={false}/>
      {frame.layers.map((layer,i)=><img className="duo-surface__layer" key={i} src={layer.image} alt="" draggable={false} style={{left:`${layer.x*100}%`,top:`${layer.y*100}%`,width:`${layer.width*100}%`,height:`${layer.height*100}%`}}/>)}
    </div>}
    {error&&frame&&<div className="duo-surface-error" role="alert">{error}</div>}
  </section>;
}
