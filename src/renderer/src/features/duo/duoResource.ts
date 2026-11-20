/** The host exposes a bounded, explicit resource API, never arbitrary renderer IPC. */
export async function duoResource<T>(channel:string,args:unknown[]=[]):Promise<T>{
  let reply=await window.canvasTTY.duo.command({action:'resource',channel,args});
  let result=reply.snapshot?.result as {value?:T;chunk?:string;data?:string;total?:number;offset?:number}|undefined;
  if(!result?.chunk)return result?.value as T;
  const id=result.chunk,total=result.total;
  if(!Number.isSafeInteger(total)||total!>32*1024*1024||typeof result.data!=='string')throw Error('Invalid shared resource.');
  let text=result.data;
  while(text.length<total!){
    reply=await window.canvasTTY.duo.command({action:'resource',channel:'chunk',args:[id,text.length]});
    result=reply.snapshot?.result as typeof result;
    if(result?.chunk!==id||result.offset!==text.length||!result.data||text.length+result.data.length>total!)throw Error('Invalid shared resource chunk.');
    text+=result.data;
  }
  return JSON.parse(text) as T;
}
