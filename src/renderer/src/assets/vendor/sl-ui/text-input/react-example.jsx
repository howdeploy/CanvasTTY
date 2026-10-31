'use client';
import {useState} from 'react';
import Component from './Component.jsx';
// Demo only. Replace handlers with your real application operations.
function wait(signal){return new Promise((resolve,reject)=>{if(signal?.aborted){reject(new DOMException('Canceled','AbortError'));return;}const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},700);function abort(){clearTimeout(timer);reject(new DOMException('Canceled','AbortError'));}signal?.addEventListener('abort',abort,{once:true});});}

export default function Example(){
 const [message,setMessage]=useState("Local demonstration. No server data is changed.");
 return <><Component callbacks={{}} onError={error=>setMessage(error.message)}/><p role="status">{message}</p></>;
}
