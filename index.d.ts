// Type declarations for the holepunchto/hyperdht public API.

/**
 * Options
 */
export interface HyperDHTOptions {
  bootstrap?: any;
  /** set the default key pair to use for server.listen and connect */
  keyPair?: any;
  /** set a default keep-alive (in ms) on all opened sockets. Defaults to 5000. Set false to turn off (advanced usage). */
  connectionKeepAlive?: any;
  /** set a default time for interval between punches (in ms). Defaults to 20000. */
  randomPunchInterval?: any;
}

/**
 * Options
 */
export interface HyperDHTConnectOptions {
  /** optional array of close dht nodes to speed up connecting */
  nodes?: any;
  /** optional key pair to use when connection (defaults to node.defaultKeyPair) */
  keyPair?: any;
}

export interface HyperDHTLookupOptions {
  from?: any;
  to?: any;
  peers?: any;
}

export class HyperDHT {
  /**
   * Create a new DHT node.
   * @param opts - Options
   */
  constructor(opts?: HyperDHTOptions);

  static DEFAULTS: any;

  /**
   * Connect to a remote server. Similar to `createServer` this performs UDP holepunching for P2P connectivity.
   * @param opts - Options
   */
  connect(remotePublicKey: any, opts?: HyperDHTConnectOptions): any;

  /**
   * Create a new server for accepting incoming encrypted P2P connections.
   * @param opts - Options
   */
  createServer(opts?: any, onconnection?: any): any;

  pool(): any;

  resume(options?: any): Promise<void>;

  suspend(options?: any): Promise<void>;

  /**
   * Fully destroy this DHT node.
   */
  destroy(options?: any): Promise<void>;

  validateLocalAddresses(addresses: any): Promise<void>;

  findPeer(publicKey: any, opts?: any): any;

  /**
   * Look for peers in the DHT on the given topic. Topic should be a 32 byte buffer (normally a hash of something).
   * @param target - Topic should be a 32 byte buffer (normally a hash of something).
   */
  lookup(target: any, opts?: HyperDHTLookupOptions): any;

  lookupAndUnannounce(target: any, keyPair: any, opts?: any): any;

  /**
   * Unannounce a key-pair.
   */
  unannounce(target: any, keyPair: any, opts?: any): any;

  /**
   * Announce that you are listening on a key-pair to the DHT under a specific topic.
   */
  announce(target: any, keyPair: any, relayAddresses?: any, opts?: any): any;

  /**
   * Fetch an immutable value from the DHT. When successful, it returns the value corresponding to the hash.
   */
  immutableGet(target: any, opts?: any): Promise<void>;

  /**
   * Store an immutable value in the DHT. When successful, the hash of the value is returned.
   */
  immutablePut(value: any, opts?: any): Promise<void>;

  /**
   * Fetch a mutable value from the DHT.
   */
  mutableGet(publicKey: any, opts?: any): Promise<void>;

  /**
   * Store a mutable value in the DHT.
   */
  mutablePut(keyPair: any, value: any, opts?: any): Promise<void>;

  onrequest(req: any): any;

  static keyPair(seed: any): any;

  static hash(data: any): any;

  static connectRawStream(encryptedStream: any, rawStream: any, remoteId: any): any;

  createRawStream(opts: any): any;

  register(name: any, plugin: any): any;

  defaultKeyPair: any;

  listening: any;

  connectionKeepAlive: any;

  stats: any;

  rawStreams: any;

  plugins: any;

  /**
   * Use this method to generate the required keypair for DHT operations.
   * @returns Returns an object with `{publicKey, secretKey}`.
   */
  keyPair(seed?: any): any;

  /**
   * If you want to run your own Hyperswarm network use this method to easily create a bootstrap node.
   */
  bootstrapper(port: any, host: any, options?: any): any;

  /**
   * Make the server listen on a keyPair. To connect to this server use keyPair.publicKey as the connect address.
   */
  listen(keyPair: any): Promise<void>;

  /**
   * Refresh the server, causing it to reannounce its address. This is automatically called on network changes.
   */
  refresh(): any;

  /**
   * You can also get this info from `node.remoteAddress()` minus the public key.
   * @returns Returns an object containing the address of the server:
   */
  address(): any;

  /**
   * Stop listening.
   */
  close(): Promise<void>;

  /**
   * The public key of the remote peer.
   */
  remotePublicKey(): any;

  /**
   * The public key of the local socket.
   */
  publicKey(): any;

  /**
   * Emitted when a new encrypted connection has passed the firewall check.
   * @param socket - `socket` is a [NoiseSecretStream](https://github.com/holepunchto/hyperswarm-secret-stream) instance.
   */
  on(event: 'connection', listener: (...args: any[]) => void): this;
  /**
   * Emitted when the server is fully listening on a keyPair.
   */
  on(event: 'listening', listener: (...args: any[]) => void): this;
  /**
   * Emitted when the server is fully closed.
   */
  on(event: 'close', listener: (...args: any[]) => void): this;
  /**
   * Emitted when the encrypted connection has been fully established with the server.
   */
  on(event: 'open', listener: (...args: any[]) => void): this;
}

export default HyperDHT;
