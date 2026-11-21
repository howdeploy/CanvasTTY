import { useEffect, useRef } from "react";
import type { CameraStore } from "../workspace/cameraStore";
import { useCameraSelector } from "../workspace/cameraStore";
import { duoWorkspace, useDuoWorkspace } from "./duoWorkspaceRuntime";
import { DuoCursorMark } from "./DuoCursorMark";
import type { DuoCursorDesign } from "../../../../shared/canvasDuo";
import type { LocaleId } from "../../../../shared/contracts";

/** Remote pointer positions are card-relative; each participant keeps their own camera. */
export function DuoCanvasCursors({ camera, design, nickname, locale }: {
  camera: CameraStore;
  design?: DuoCursorDesign;
  nickname?: string;
  locale: LocaleId;
}): React.JSX.Element {
  const view = useDuoWorkspace();
  const localMark = useRef<HTMLSpanElement>(null);
  const position = useCameraSelector(camera, value => value);
  useEffect(() => {
    let last = 0, pending = false, disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: { x: number; y: number; workspaceId?: string } | undefined;
    function flush() {
      if (disposed || pending || timer || !latest) return;
      const wait = 130 - (performance.now() - last);
      if (wait > 0) { timer = setTimeout(() => { timer = undefined; flush(); }, wait); return; }
      const point = latest;
      latest = undefined;
      const state = duoWorkspace.get();
      if (!state.connected || state.reply?.state.workspaceId !== point.workspaceId) return;
      pending = true;
      last = performance.now();
      void duoWorkspace.command({action:'cursor',cardId:'canvas',x:point.x,y:point.y,design,nickname})
        .catch(() => {}).finally(() => { pending = false; flush(); });
    }
    const move = (event: PointerEvent): void => {
      const current = duoWorkspace.get();
      if (localMark.current) {
        const inside = event.target instanceof Element && !!event.target.closest(".workspace") && !event.target.closest("button,input,textarea,[role=dialog]");
        localMark.current.hidden = !inside;
        if (inside) localMark.current.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
      }
      if (!current.connected) return;
      if(current.reply?.state.documentSync){
        const element=document.querySelector('.workspace');
        if(!element||!(event.target instanceof Node)||!element.contains(event.target))return;
        const r=element.getBoundingClientRect(),c=camera.get();
        latest = { x:(event.clientX-r.left-c.x)/c.zoom, y:(event.clientY-r.top-c.y)/c.zoom, workspaceId:current.reply.state.workspaceId };
        flush(); return;
      }
      if (performance.now() - last < 400) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.terminal-card[data-session-id]') : null;
      const cardId = target?.dataset.sessionId;
      if (!target || !cardId) return;
      const bounds=target.getBoundingClientRect(); if(!bounds.width||!bounds.height)return;
      last=performance.now();
      void duoWorkspace.command({action:'cursor',cardId,x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height)),design,nickname}).catch(()=>undefined);
    };
    window.addEventListener('pointermove',move,{passive:true});
    const hide = () => { if (localMark.current) localMark.current.hidden = true; };
    document.addEventListener('pointerleave',hide);
    window.addEventListener('blur',hide);
    return()=>{ disposed = true; clearTimeout(timer); window.removeEventListener('pointermove',move); document.removeEventListener('pointerleave',hide); window.removeEventListener('blur',hide); };
  }, [camera, design, nickname]);
  const author=view.reply?.state.role==='host'?'host':'guest';
  const self = view.reply?.snapshot?.cursors.find(c => c.author === author);
  return <>{view.connected && <span className="duo-local-cursor" ref={localMark} hidden>
    <DuoCursorMark design={self?.design ?? design} author={author} nickname={self?.nickname ?? nickname} locale={locale} />
  </span>}{view.connected && view.reply?.snapshot?.cursors.filter(c=>c.author!==author&&Date.now()-c.at<5000).map(cursor=>{
    const card=view.reply?.snapshot?.cards.find(c=>c.id===cursor.cardId);if(!card&&cursor.cardId!=='canvas')return null;
    const x=card?card.position.x+cursor.x*card.size.width:cursor.x,y=card?card.position.y+cursor.y*card.size.height:cursor.y;
    return <span className="duo-canvas-cursor" key={cursor.author} style={{ left: position.x + x * position.zoom, top: position.y + y * position.zoom }}>
      <DuoCursorMark design={cursor.design} author={cursor.author} nickname={cursor.nickname} locale={locale} />
    </span>;
  })}</>;
}
