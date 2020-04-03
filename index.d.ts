import { Readable, PassThrough } from 'stream'
/** Set this to Hypersign once Hypersign has typings */
import { Hypersign, KeyPair } from '@hyperswarm/hypersign'
// declare const Hypersign: any;
/** Set this to dht-rpc once dht-rpc has typings */
declare const DhtRpc: any;

export declare interface Peer {
  host: string;
  port: number;
  length?: number
}

export declare namespace messages {
  export interface PeersInput {
    buffer: boolean;
    encodingLength: any;
    encode: any;
    decode: any;
  }
  export interface PeersOutput {
    buffer: boolean;
    encodingLength: any;
    encode: any;
    decode: any;
  }
  export interface Mutable {
    buffer: boolean;
    encodingLength: any;
    encode: any;
    decode: any;
  }
}
export declare namespace peers {
  export interface ipv4 {
    decodeAll(buf: Buffer): Array<Peer> | null
    encode(peer: Peer):Buffer | null
  }
  export interface ipv4WithLength {
    decodeAll(buf: Buffer): Array<Peer> | null
    encode(peer: Peer):Buffer | null
  }
  export interface local {
    decodeAll(prefix:string, buf?: Buffer): Array<Peer> | null
    encode(peer: Peer):Buffer | null
  }
  /** Parses the passed Buffer as a binary IPv4 address and return it as a string */
  export function getIp( buf:Buffer, offset:number ):string
  /** Assigns a binary representation of the given IPv4 address to the buffer at the given offset */
  export function setIp( buf:Buffer, offset:number, ip:string):void
}

export declare namespace Stores {
  export class ImmutableStore {
    constructor(dht: HyperDHT, store: any);
    dht: HyperDHT;
    store: any;
    prefix: string;
    get(key: Buffer, cb: ( err:Error, value:Buffer, info: { id:Buffer } ) => void ): PassThrough;
    put(value: Buffer, cb: ( err:Error, key: Buffer ) => void ): PassThrough;
    private _command(): {
      update({ target, value }: {
        target: any;
        value: any;
      }, cb: any): void;
      query({ target }: {
        target: any;
      }, cb: any): void;
    };
  }

  export interface MutableOptions {
    /** use node.mutable.keypair to generate this. */
    keypair:KeyPair
    /** a buffer holding an ed25519 signature corresponding to public key. This can be supplied instead of a secret key which can be useful for offline signing. If signature is supplied keypair must only contain a publicKey and no secretKey. */
    signature?:Buffer
    /** default 0, a number which should be increased every time put is passed a new value for the same keypair */
    seq?:number
    /** default undefined, a buffer <= 64 bytes. If supplied it will salt the signature used to verify mutable values. */
    salt?:Buffer
  }

  export class MutableStore extends Hypersign {
      constructor(dht: HyperDHT, store: any);
      dht: HyperDHT;
      store: any;
      prefix: string;
      get(key: any, opts?: MutableOptions, cb?: ( err:Error, result: { value:Buffer, signature:Buffer, seq:number, salt:Buffer }) => void ): PassThrough;
      put(value: any, opts: any, cb: ( err:Error, result: { key:Buffer, signature:Buffer, seq:number, salt:Buffer }) => void ): PassThrough;
      private _command(): {
        valueEncoding: {
          buffer: boolean;
          encodingLength: any;
          encode: any;
          decode: any;
        };
        update(input: any, cb: any): void;
        query({ target, value }: {
          target: any;
          value: any;
        }, cb: any): void;
      };
  }
}


export declare interface HyperDHTOptions {
  /** Optionally overwrite the default bootstrap servers */
  bootstrap?: Array<string>
  /** If you are a shortlived client or don't want to host data join as an ephemeral node. (defaults to false) */
  ephemeral?: boolean
  /** if set to true, the adaptive option will cause the node to become non-ephemeral after the node has shown to be long-lived (defaults to false) */
  adaptive?: boolean
  /** time until a peer is dropped */
  maxAge?:number
}

export declare interface LookupOptions {
  /**  Optionally set your public port. This will make other peers no echo back yourself */
  port?: number
  /**  Optionally look for LAN addresses as well by passing in your own. Will also exclude yourself from the results. Only LAN addresses announced on the same public IP and sharing the first two parts (192.168) will be included. */
  localAddress?: {
    host: string,
    port: number
  }
  /** Optionally include the announced data length for each peer. */
  includeLength?:boolean
}

export declare interface AnnounceOptions extends LookupOptions {
  /** Optionally announce your local data length as well. */
  length?: number
}

declare function _exports(opts?: HyperDHTOptions): HyperDHT;
export default _exports;

export declare class HyperDHT extends DhtRpc {
  constructor( opts?: HyperDHTOptions )
  private _peers: any;
  private _store: any;
  private _adaptiveTimeout: any;
  mutable: Stores.MutableStore;
  immutable: Stores.ImmutableStore;
  /** Look for peers in the DHT on the given topic. Topic should be a 32 byte buffer (normally a hash of something). */
  lookup(topic: Buffer, opts: LookupOptions, cb: () => void ): Readable;
  /** Announce a port to the dht. */
  announce(topic: Buffer, opts: AnnounceOptions, cb: () => void ): Readable;
  /** Unannounce a port. Takes the same options as announce. */
  unannounce(topic: Buffer, opts: AnnounceOptions, cb: () => void ): void;
  private _onpeers(query: any, cb: any): any;
}
