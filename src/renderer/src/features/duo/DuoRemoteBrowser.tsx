import {useEffect,useRef,useState} from 'react';
import type {DuoSurfaceInput} from '../../../../shared/duoSurface';
import {duoKeyCode} from '../../../../shared/duoSurface';
import {duoResource} from './duoResource';
import {useDuoWorkspace} from './duoWorkspaceRuntime';

/** Only the page is remote. Its card, camera, navigation controls and focus are local. */
export function DuoRemoteBrowser({tabId,visible}:{tabId:string;visible:boolean}):React.JSX.Element{
  const view=useDuoWorkspace(),allowed=Boolean(view.connected&&view.reply?.state.manage);
  const [image,setImage]=useState(''),[error,setError]=useState('');
  const root=useRef<HTMLDivElement>(null),input=useRef<DuoSurfaceInput[]>([]),sending=useRef(false),lastMove=useRef(0);
  const owner=useRef({tabId,workspace:view.reply?.state.workspaceId,allowed});owner.current={tabId,workspace:view.reply?.state.workspaceId,allowed};
  const send=(events:DuoSurfaceInput[]):void=>{
    if(!allowed)return;
    for(const event of events){
      const previous=input.current.at(-1);
      if(event.type==='mouseMove'&&previous?.type==='mouseMove')input.current[input.current.length-1]=event;
      else if(event.type==='text'&&previous?.type==='text'&&previous.text.length+event.text.length<=4096)previous.text+=event.text;
      else input.current.push(event);
    }
    if(input.current.length>256){input.current=[{type:'release'}];setError('Ввод слишком быстрый для соединения. Повторите последнюю операцию.');}
    if(sending.current)return;sending.current=true;
    const workspace=owner.current.workspace;
    void(async()=>{
      try{while(input.current.length){
        if(!owner.current.allowed||owner.current.tabId!==tabId||owner.current.workspace!==workspace){input.current=[];break;}
        await duoResource('browser-input',[tabId,input.current.splice(0,32)]);
      }}catch(e){input.current=[];setError(String(e));}
      finally{sending.current=false;}
    })();
  };
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    const frame=async():Promise<void>=>{
      if(!visible||document.hidden){timer=setTimeout(()=>void frame(),700);return;}
      try{const result=await duoResource<{tabId:string;image:string}>('browser-frame');
        if(!disposed&&result.tabId===tabId&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(result.image)&&result.image.length<=400_000){setImage(result.image);setError('');}
      }catch(e){if(!disposed)setError(String(e));}
      if(!disposed)timer=setTimeout(()=>void frame(),450);
    };
    void frame();return()=>{disposed=true;clearTimeout(timer);input.current=[];};
  },[tabId,visible,view.reply?.state.workspaceId]);
  const modifiers=(e:{shiftKey:boolean;ctrlKey:boolean;altKey:boolean;metaKey:boolean}):string[]=>[
    ...(e.shiftKey?['shift']:[]),...(e.ctrlKey?['control']:[]),...(e.altKey?['alt']:[]),...(e.metaKey?['meta']:[])
  ];
  const pointer=(e:React.PointerEvent<HTMLDivElement>,type:'mouseMove'|'mouseDown'|'mouseUp'):void=>{
    if(e.button===1||e.altKey)return; // Canvas pan remains a local gesture.
    e.preventDefault();e.stopPropagation();if(!allowed)return;
    if(type==='mouseMove'&&Date.now()-lastMove.current<80)return;lastMove.current=Date.now();
    if(type==='mouseDown'){root.current?.focus();e.currentTarget.setPointerCapture(e.pointerId);}
    const r=e.currentTarget.getBoundingClientRect();if(!r.width||!r.height)return;
    send([{type,x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height)),button:e.button===2?'right':'left',buttons:e.buttons,clickCount:1,modifiers:modifiers(e)}]);
    if(type==='mouseUp'&&e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return <div ref={root} tabIndex={0} className="duo-remote-browser" aria-label="Общая страница браузера" contentEditable={allowed} suppressContentEditableWarning
    onBeforeInput={e=>{e.preventDefault();const text=(e.nativeEvent as InputEvent).data;if(text)send([{type:'text',text:text.slice(0,4096)}]);}}
    onCompositionEnd={e=>{if(e.data)send([{type:'text',text:e.data.slice(0,4096)}]);}}
    style={{position:'absolute',inset:0,outline:'none',overflow:'hidden',background:'#17191c'}}
    onPointerDown={e=>pointer(e,'mouseDown')} onPointerMove={e=>pointer(e,'mouseMove')} onPointerUp={e=>pointer(e,'mouseUp')}
    onContextMenu={e=>e.preventDefault()} onBlur={()=>send([{type:'release'}])}
    onWheel={e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();send([{type:'mouseWheel',x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height,deltaX:Math.max(-2000,Math.min(2000,-e.deltaX)),deltaY:Math.max(-2000,Math.min(2000,-e.deltaY)),modifiers:modifiers(e)}]);}}
    onKeyDown={e=>{if(!allowed||e.nativeEvent.isComposing)return;e.stopPropagation();if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v')return;e.preventDefault();if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)send([{type:'text',text:e.key}]);else if(duoKeyCode(e.key))send([{type:'keyDown',key:e.key,modifiers:modifiers(e)}]);}}
    onKeyUp={e=>{e.stopPropagation();if(e.nativeEvent.isComposing)return;if(duoKeyCode(e.key)&&!(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey))send([{type:'keyUp',key:e.key,modifiers:modifiers(e)}]);}}
    onPaste={e=>{e.preventDefault();e.stopPropagation();const text=e.clipboardData.getData('text/plain');if(text)send([{type:'text',text:text.slice(0,4096)}]);}}>
    {image&&<img src={image} alt="" draggable={false} style={{width:'100%',height:'100%',pointerEvents:'none'}}/>}
    {error&&<small role="status" style={{position:'absolute',bottom:8,left:8,background:'#17191c',color:'#fff'}}>{error}</small>}
  </div>;
}
