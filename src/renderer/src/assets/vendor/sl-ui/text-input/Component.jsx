import {forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useRef,useState} from 'react';
import {mountInto,variant} from './react-controller.mjs';

/** Source-preserving React integration. Widget DOM is client-rendered.
 * initialOptions are read on mount/resetKey changes; callbacks of the same
 * names may change without losing text, focus or current motion.
 */
const Component=forwardRef(function Component({initialOptions={},callbacks={},preview=false,resetKey=0,onReady,onError,className,style,...hostProps},ref){
 const host=useRef(null),controller=useRef(null),latest=useRef({callbacks,onReady,onError}),initial=useRef(initialOptions),[revision,setRevision]=useState(0),[phase,setPhase]=useState('pending');
 // Only committed props may reach the live imperative widget. A concurrent
 // render can suspend or be abandoned while the previous widget stays usable.
 // Layout publication also precedes the passive mount effect on every commit.
 useLayoutEffect(()=>{latest.current={callbacks,onReady,onError};initial.current=initialOptions;});
 const callbackNames=Object.keys(callbacks).sort().join('\0');
 useImperativeHandle(ref,()=>({
  reset(){if(typeof controller.current?.reset==='function')controller.current.reset();else setRevision(n=>n+1);},
  cancel(){controller.current?.cancel?.();},
  get state(){const state=controller.current?.state;return state===undefined?undefined:structuredClone(state);},
  get controller(){return controller.current;},
 }),[]);
 useEffect(()=>{
  let active=true;setPhase('pending');
  const names=callbackNames?callbackNames.split('\0'):[];
  const liveCallbacks=Object.fromEntries(names.map(name=>[name,(...args)=>{const fn=latest.current.callbacks[name];if(typeof fn!=='function')throw new TypeError(`Missing callback: ${name}`);return fn(...args);}]));
  try{
   const mounted=mountInto(host.current,{...initial.current,...liveCallbacks},{preview});controller.current=mounted;
   setPhase('ready');latest.current.onReady?.(mounted);
  }catch(error){if(active){setPhase('error');latest.current.onError?.(error);}}
  return()=>{active=false;const mounted=controller.current;controller.current=null;mounted?.destroy();};
 },[callbackNames,preview,resetKey,revision]);
 return <div {...hostProps} className={className} style={style} data-sl-react={variant} aria-busy={phase==='pending'}>
  <div ref={host}/>
  {phase==='pending'&&<span role="status">Loading component…</span>}
  {phase==='error'&&<span role="alert">Component could not start. Check its required callbacks.</span>}
 </div>;
});
export default Component;
