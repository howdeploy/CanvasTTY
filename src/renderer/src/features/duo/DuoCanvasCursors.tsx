import { useEffect } from "react";
import type { CameraStore } from "../workspace/cameraStore";
import { useCameraSelector } from "../workspace/cameraStore";
import { duoWorkspace, useDuoWorkspace } from "./duoWorkspaceRuntime";

/** Remote pointer positions are card-relative; each participant keeps their own camera. */
export function DuoCanvasCursors({camera}:{camera:CameraStore}): React.JSX.Element {
  const view = useDuoWorkspace();
  const position = useCameraSelector(camera, value => value);
  useEffect(() => {
    let last = 0;
    const move = (event: PointerEvent): void => {
      const current = duoWorkspace.get();
      if (!current.connected || Date.now()-last<450) return;
      if(current.reply?.state.documentSync){
        const element=document.querySelector('.workspace');
        if(!element||!(event.target instanceof Node)||!element.contains(event.target))return;
        const r=element.getBoundingClientRect(),c=camera.get();last=Date.now();
        void duoWorkspace.command({action:'cursor',cardId:'canvas',x:(event.clientX-r.left-c.x)/c.zoom,y:(event.clientY-r.top-c.y)/c.zoom}).catch(()=>undefined);return;
      }
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.terminal-card[data-session-id]') : null;
      const cardId = target?.dataset.sessionId;
      if (!target || !cardId) return;
      const bounds=target.getBoundingClientRect(); if(!bounds.width||!bounds.height)return;
      last=Date.now();
      void duoWorkspace.command({action:'cursor',cardId,x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))}).catch(()=>undefined);
    };
    window.addEventListener('pointermove',move,{passive:true});
    return()=>window.removeEventListener('pointermove',move);
  },[camera]);
  const author=view.reply?.state.role==='host'?'host':'guest';
  return <>{view.connected && view.reply?.snapshot?.cursors.filter(c=>c.author!==author&&Date.now()-c.at<5000).map(cursor=>{
    const card=view.reply?.snapshot?.cards.find(c=>c.id===cursor.cardId);if(!card&&cursor.cardId!=='canvas')return null;
    const x=card?card.position.x+cursor.x*card.size.width:cursor.x,y=card?card.position.y+cursor.y*card.size.height:cursor.y;
    return <span className="duo-canvas-cursor" key={cursor.author} style={{left:position.x+x*position.zoom,top:position.y+y*position.zoom}}>↖ {cursor.author==='host'?'Хост':'Гость'}</span>;
  })}</>;
}
