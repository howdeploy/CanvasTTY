import {randomBytes} from 'node:crypto';
import type { DuoTrace } from './DuoDiagnostics.ts';
import DHT, {type NoiseSocket,type DhtServer} from 'hyperdht';
export interface PeerInvite {version:3;hostKey:string;guestSeed:string;key:string}
export interface PeerRoute {mode:'direct';remoteHost:string;remotePort:number}
const MAX_FRAME=2*1024*1024;
interface Frame {id:string;packet?:unknown;rejected?:boolean}
interface Pending {resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}
/** Bounded RPC over one authenticated Noise connection. Commands are never retried. */
class PeerChannel {
  private buffer=Buffer.alloc(0);
  private pending=new Map<string,Pending>();
  private inFlight=0;
  readonly socket:NoiseSocket;
  private readonly trace?:DuoTrace;
  constructor(socket:NoiseSocket, privateReceive?: (packet:unknown)=>Promise<unknown>, trace?:DuoTrace){
    this.trace=trace;
    this.socket=socket;
    socket.on('error',(error:Error)=>{trace?.('socket-error',error);this.fail();});socket.on('close',()=>{trace?.('socket-closed');this.fail();});
    socket.on('data',(chunk:Buffer)=>{
      this.buffer=Buffer.concat([this.buffer,chunk]);
      let end:number;
      while((end=this.buffer.indexOf(10))>=0){
        if(end>=MAX_FRAME){socket.destroy(new Error('Duo packet too large.'));return;}
        const bytes=this.buffer.subarray(0,end);this.buffer=this.buffer.subarray(end+1);
        try{
          const frame=JSON.parse(bytes.toString('utf8')) as Frame;
          if(!frame||!/^[a-f0-9]{32}$/.test(frame.id))throw new Error('Invalid Duo frame.');
          if(privateReceive){
            if(++this.inFlight>8)throw new Error('Too many Duo requests.');
            // Responses carry request IDs, so independent reads may complete
            // out of order. The authenticated service orders mutations itself.
            void (async()=>{
              try{let result:Frame;try{result={id:frame.id,packet:await privateReceive(frame.packet)};}catch{result={id:frame.id,rejected:true};}this.send(result);}
              finally{this.inFlight--;}
            })().catch(()=>socket.destroy());
          }else{
            const p=this.pending.get(frame.id);if(!p)continue;
            this.pending.delete(frame.id);clearTimeout(p.timer);
            if(frame.rejected)p.reject(new Error('Duo invitation rejected or expired.'));else p.resolve(frame.packet);
          }
        }catch{socket.destroy(new Error('Invalid Duo frame.'));return;}
      }
      if(this.buffer.length>=MAX_FRAME)socket.destroy(new Error('Duo packet too large.'));
    });
  }
  private send(frame:Frame):void {const data=JSON.stringify(frame)+'\n';if(Buffer.byteLength(data)>MAX_FRAME||this.socket.destroyed)throw new Error('Duo connection closed.');this.socket.write(data);}
  request(packet:unknown):Promise<unknown>{
    if(this.pending.size>=8)return Promise.reject(new Error('Duo connection busy.'));
    const id=randomBytes(16).toString('hex');
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);const error=new Error('Duo request timed out; delivery is uncertain.');this.trace?.('rpc-timeout',error);reject(error);},15000);
      this.pending.set(id,{resolve,reject,timer});try{this.send({id,packet});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  private fail():void {for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Duo peer disconnected.'));}this.pending.clear();this.buffer=Buffer.alloc(0);}
  close():void{this.fail();this.socket.destroy();}
}
async function deadline<T>(promise:Promise<T>,ms:number):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cannot establish a direct Duo connection on this network.')),ms);})]);}finally{if(timer)clearTimeout(timer);}}
export class DuoPeerTransport {
  private node:DHT;
  private server:DhtServer|null=null;
  private channel:PeerChannel|null=null;
  private closed=false;
  private constructor(options:Record<string,unknown>={}, trace?:DuoTrace){this.node=new DHT(options);this.node.on('error',(error:Error)=>trace?.('dht-error',error));}
  static async host(key:string,receive:(packet:unknown)=>Promise<unknown>,disconnected:()=>void,options:Record<string,unknown>={},trace?:DuoTrace):Promise<{transport:DuoPeerTransport;invite:PeerInvite}>{
    const transport=new DuoPeerTransport(options,trace),hostPair=DHT.keyPair(),guestSeed=randomBytes(32),guestPair=DHT.keyPair(guestSeed);
    transport.server=transport.node.createServer({relayThrough:null,shareLocalAddress:options.shareLocalAddress!==false,firewall:(remote:Buffer)=>!remote.equals(guestPair.publicKey)||Boolean(transport.channel)},socket=>{
      if(transport.closed||transport.channel){socket.destroy();return;}
      const channel=new PeerChannel(socket,receive,trace);trace?.('encrypted-open');transport.channel=channel;
      socket.once('close',()=>{if(transport.channel!==channel)return;transport.channel=null;if(!transport.closed)disconnected();});
    });
    try{trace?.('listen-start');await deadline(transport.server.listen(hostPair),30000);trace?.('listening');return{transport,invite:{version:3,hostKey:hostPair.publicKey.toString('hex'),guestSeed:guestSeed.toString('base64url'),key}};}
    catch(error){trace?.('transport-failed',error);await transport.stop();throw error;}
  }
  static async join(invite:PeerInvite,options:Record<string,unknown>={},signal?:AbortSignal,trace?:DuoTrace):Promise<DuoPeerTransport>{
    const transport=new DuoPeerTransport(options,trace);
    if(signal?.aborted){await transport.stop();throw Error('Duo connection cancelled.');}
    trace?.('connect-start');
    const socket=transport.node.connect(Buffer.from(invite.hostKey,'hex'),{keyPair:DHT.keyPair(Buffer.from(invite.guestSeed,'base64url')),relayThrough:null,localConnection:options.localConnection!==false});
    // Handle errors immediately, including before open, to avoid process-wide errors.
    transport.channel=new PeerChannel(socket,undefined,trace);
    const cancel=()=>{socket.destroy(new Error('Duo connection cancelled.'));};
    signal?.addEventListener('abort',cancel,{once:true});
    try{await deadline(new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);socket.once('close',()=>reject(new Error('Duo peer disconnected.')));}),45000);trace?.('encrypted-open');return transport;}
    catch(error){trace?.('transport-failed',error);await transport.stop();throw error;}
    finally{signal?.removeEventListener('abort',cancel);}
  }
  get route():PeerRoute|undefined{const raw=this.channel?.socket.rawStream;return raw?{mode:'direct',remoteHost:raw.remoteHost,remotePort:raw.remotePort}:undefined;}
  get connected():boolean{return !this.closed && Boolean(this.channel && !this.channel.socket.destroyed);}
  request(packet:unknown):Promise<unknown>{if(!this.channel)return Promise.reject(new Error('Duo is disconnected.'));return this.channel.request(packet);}
  async stop():Promise<void>{if(this.closed)return;this.closed=true;this.channel?.close();this.channel=null;await this.node.destroy();}
}
