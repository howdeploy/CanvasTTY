declare module 'hyperdht' {
  import {EventEmitter} from 'node:events';
  export interface KeyPair {publicKey:Buffer;secretKey:Buffer}
  export interface NoiseSocket extends EventEmitter {remotePublicKey:Buffer;connected:boolean;destroyed:boolean;rawStream:{remoteHost:string;remotePort:number;socket?:{host:string;port:number}}|null;write(data:Buffer|string):boolean;destroy(error?:Error):void}
  export interface DhtServer extends EventEmitter {listen(keyPair:KeyPair):Promise<void>;close():Promise<void>;publicKey:Buffer}
  export default class DHT extends EventEmitter {
    constructor(options?:Record<string,unknown>);
    static keyPair(seed?:Buffer):KeyPair;
    createServer(options:Record<string,unknown>,listener:(socket:NoiseSocket)=>void):DhtServer;
    connect(key:Buffer,options?:Record<string,unknown>):NoiseSocket;
    destroy():Promise<void>;
  }
}
