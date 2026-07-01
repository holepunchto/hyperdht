const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const c = require('compact-encoding')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const m = require('./lib/messages')
const SocketPool = require('./lib/socket-pool')
const Persistent = require('./lib/persistent')
const Router = require('./lib/router')
const Cache = require('xache')
const Server = require('./lib/server')
const connect = require('./lib/connect')
const { FIREWALL, BOOTSTRAP_NODES, KNOWN_NODES, COMMANDS } = require('./lib/constants')
const { hash, createKeyPair } = require('./lib/crypto')
const RawStreamSet = require('./lib/raw-stream-set')
const ConnectionPool = require('./lib/connection-pool')
const { STREAM_NOT_CONNECTED } = require('./lib/errors')

const DEFAULTS = {
  ...DHT.DEFAULTS,
  connectionKeepAlive: 5000,
  randomPunchInterval: 20000
}

/**
 * Options for creating a HyperDHT node.
 * @typedef {Object} HyperDHTOptions
 * @property {Array<string>} [bootstrap] - Bootstrap server addresses (`'host:port'`). Defaults to the Holepunch public bootstrap nodes.
 * @property {{publicKey: Buffer, secretKey: Buffer}} [keyPair] - Default key pair used for `server.listen()` and `connect()`.
 * @property {number|false} [connectionKeepAlive=5000] - Keep-alive interval in ms for all opened sockets. Set `false` to disable.
 * @property {number} [randomPunchInterval=20000] - Minimum ms between random holepunches.
 */

/**
 * Options for `node.createServer()`.
 * @typedef {Object} CreateServerOptions
 * @property {function(Buffer, object): boolean} [firewall] - Called with `(remotePublicKey, remoteHandshakePayload)`. Return `true` to block, `false` to allow.
 * @property {function(number, number, Array, Array): boolean} [holepunch] - Called before holepunching begins. Return `false` to abort.
 * @property {Buffer|Array<Buffer>|function(): Buffer|null} [relayThrough] - Optionally relay through a specific peer — pass a public key (Buffer), an array of public keys to pick from, or a function returning one.
 * @property {number} [relayKeepAlive=5000] - Keep-alive interval in ms for the relay socket.
 */

/**
 * Options for `node.connect()`.
 * @typedef {Object} ConnectOptions
 * @property {Array<{host: string, port: number}>} [nodes] - Known DHT nodes close to the remote — speeds up connecting.
 * @property {Array<{host: string, port: number}>} [relayAddresses] - Relay server addresses to hole-punch through when a direct connection cannot be established.
 * @property {{publicKey: Buffer, secretKey: Buffer}} [keyPair] - Key pair to use for this connection. Defaults to `node.defaultKeyPair`.
 * @property {Buffer|Array<Buffer>|function(): Buffer|null} [relayThrough] - Optionally relay through a specific peer — pass a public key (Buffer), an array of public keys to pick from, or a function returning one.
 */

/**
 * Options for `node.mutableGet()`.
 * @typedef {Object} MutableGetOptions
 * @property {number} [seq=0] - Only return values whose `seq` is >= this number.
 * @property {boolean} [latest=true] - If `true`, scan the whole query and return the highest `seq` seen.
 * @property {function(object): boolean} [refresh] - Called with the latest result; return `true` to re-store it, extending its TTL.
 */

/**
 * Options for `node.mutablePut()`.
 * @typedef {Object} MutablePutOptions
 * @property {number} [seq=0] - Sequence number for this value. Must be greater than the current stored `seq` to overwrite.
 * @property {function(number, Buffer, object): Promise<Buffer>} [signMutable] - Custom signing function. Defaults to the built-in Ed25519 signer.
 */

class HyperDHT extends DHT {
  /**
   * Create a new DHT node.
   * @param {HyperDHTOptions} [opts]
   * @example
   * {
   *   // Optionally overwrite the default bootstrap servers, just need to be an array of any known dht node(s)
   *   // Defaults to Pear.config.dht.bootstrap in a Pear app or ['88.99.3.86@node1.hyperdht.org:49737', '142.93.90.113@node2.hyperdht.org:49737', '138.68.147.8@node3.hyperdht.org:49737'] elsewhere
   *   // Supports suggested-IP to avoid DNS calls: [suggested-IP@]<host>:<port>
   *   bootstrap: ['host:port'],
   *   keyPair, // set the default key pair to use for server.listen and connect
   *   connectionKeepAlive, // set a default keep-alive (in ms) on all opened sockets. Defaults to 5000. Set false to turn off (advanced usage).
   *   randomPunchInterval: 20000 // set a default time for interval between punches (in ms). Defaults to 20000.
   *
   * }
   */
  constructor(opts = {}) {
    const port = opts.port || 49737
    const bootstrap = opts.bootstrap || BOOTSTRAP_NODES
    const nodes = opts.nodes || KNOWN_NODES

    super({ ...opts, port, bootstrap, nodes, filterNode })

    const { router, relayAddresses, persistent } = defaultCacheOpts(opts)

    this.defaultKeyPair = opts.keyPair || createKeyPair(opts.seed)
    this.listening = new Set()
    this.connectionKeepAlive =
      opts.connectionKeepAlive === false
        ? 0
        : opts.connectionKeepAlive || DEFAULTS.connectionKeepAlive

    // stats is inherited from dht-rpc so fwd the ones from there
    this.stats = {
      punches: { consistent: 0, random: 0, open: 0 },
      relaying: { attempts: 0, successes: 0, aborts: 0 },
      ...this.stats
    }
    this.rawStreams = new RawStreamSet(this)
    this.plugins = new Map()

    this._router = new Router(this, router)
    this._socketPool = new SocketPool(this, opts.host || '0.0.0.0')
    this._persistent = null
    this._validatedLocalAddresses = new Map()
    this._relayAddressesCache = new Cache(relayAddresses)

    this._deferRandomPunch = !!opts.deferRandomPunch
    this._lastRandomPunch = this._deferRandomPunch ? Date.now() : 0
    this._connectable = true
    this._randomPunchInterval = opts.randomPunchInterval || DEFAULTS.randomPunchInterval // min 20s between random punches...
    this._randomPunches = 0
    this._randomPunchLimit = 1 // set to one for extra safety for now

    this.once('persistent', () => {
      this._persistent = new Persistent(this, persistent)
      for (const plugin of this.plugins.values()) plugin.onpersistent()
    })

    this.on('network-change', () => {
      for (const server of this.listening) server.refresh()
    })

    this.on('network-update', () => {
      if (!this.online) return
      for (const server of this.listening) server.notifyOnline()
    })
  }

  static DEFAULTS = DEFAULTS

  /**
   * Connect to a remote server. Similar to `createServer` this performs UDP
   * holepunching for P2P connectivity.
   * @param {Buffer|string} remotePublicKey - Public key of the server to connect to (Buffer, hex string, or z-base32 string).
   * @param {ConnectOptions} [opts]
   * @returns {NoiseSecretStream} An encrypted duplex stream — use `socket.on('open', ...)` to know when it is ready.
   * @example
   * {
   *   nodes: [...], // optional array of close dht nodes to speed up connecting
   *   keyPair // optional key pair to use when connection (defaults to node.defaultKeyPair)
   * }
   */
  connect(remotePublicKey, opts) {
    return connect(this, remotePublicKey, opts)
  }

  /**
   * Create a new server for accepting incoming encrypted P2P connections.
   * @param {CreateServerOptions} [opts]
   * @param {function(NoiseSecretStream): void} [onconnection] - Shorthand listener for the `'connection'` event.
   * @returns {Server} A server object — call `server.listen(keyPair)` to start accepting connections.
   * @example
   * {
   *   firewall (remotePublicKey, remoteHandshakePayload) {
   *     // validate if you want a connection from remotePublicKey
   *     // if you do return false, else return true
   *     // remoteHandshakePayload contains their ip and some more info
   *     return true
   *   }
   * }
   */
  createServer(opts, onconnection) {
    if (typeof opts === 'function') return this.createServer({}, opts)
    if (opts && opts.onconnection) onconnection = opts.onconnection
    const s = new Server(this, opts)
    if (onconnection) s.on('connection', onconnection)
    return s
  }

  pool() {
    return new ConnectionPool(this)
  }

  async resume({ log = noop } = {}) {
    if (this._deferRandomPunch) this._lastRandomPunch = Date.now()
    await super.resume({ log })
    const resuming = []
    for (const server of this.listening) resuming.push(server.resume())
    log('Resuming hyperdht servers')
    await Promise.allSettled(resuming)
    log('Done, hyperdht fully resumed')
  }

  async suspend({ log = noop } = {}) {
    this._connectable = false // just so nothing gets connected during suspension
    const suspending = []
    for (const server of this.listening) suspending.push(server.suspend())
    log('Suspending all hyperdht servers')
    await Promise.allSettled(suspending)
    log('Done, clearing all raw streams')
    await this.rawStreams.clear()
    log('Done, suspending dht-rpc')
    await super.suspend({ log })
    log('Done, clearing raw streams again')
    await this.rawStreams.clear()
    log('Done, hyperdht fully suspended')
    this._connectable = true
  }

  /**
   * Fully destroy this DHT node.
   * @param {object} [options] - Pass `{ force: true }` to skip waiting for servers to unannounce before closing.
   * @returns {Promise<void>} Resolves when the node is fully shut down.
   * @example
   * await node.destroy()
   * // or, to skip graceful unannounce:
   * await node.destroy({ force: true })
   */
  async destroy({ force = false } = {}) {
    if (!force) {
      const closing = []
      for (const server of this.listening) closing.push(server.close())
      await Promise.allSettled(closing)
    }
    this._router.destroy()
    if (this._persistent) this._persistent.destroy()
    for (const plugin of this.plugins.values()) plugin.destroy()
    await this.rawStreams.clear()
    await this._socketPool.destroy()
    await super.destroy()
  }

  async validateLocalAddresses(addresses) {
    const list = []
    const socks = []
    const waiting = []

    for (const addr of addresses) {
      const { host } = addr

      if (this._validatedLocalAddresses.has(host)) {
        if (await this._validatedLocalAddresses.get(host)) {
          list.push(addr)
        }
        continue
      }

      const sock = this.udx.createSocket()
      try {
        sock.bind(0, host)
      } catch {
        this._validatedLocalAddresses.set(host, Promise.resolve(false))
        continue
      }

      socks.push(sock)

      // semi terrible heuristic until we proper fix local connections by racing them to the remote...
      const promise = new Promise((resolve) => {
        sock.on('message', () => resolve(true))
        setTimeout(() => resolve(false), 500)
        sock.trySend(b4a.alloc(1), sock.address().port, addr.host)
      })

      this._validatedLocalAddresses.set(host, promise)
      waiting.push(addr)
    }

    for (const addr of waiting) {
      const { host } = addr
      if (this._validatedLocalAddresses.has(host)) {
        if (await this._validatedLocalAddresses.get(host)) {
          list.push(addr)
        }
        continue
      }
    }

    for (const sock of socks) await sock.close()

    return list
  }

  findPeer(publicKey, opts = {}) {
    const target = opts.hash === false ? publicKey : hash(publicKey)
    opts = { ...opts, map: mapFindPeer }
    return this.query({ target, command: COMMANDS.FIND_PEER, value: null }, opts)
  }

  /**
   * Look for peers in the DHT on the given topic. Topic should be a 32 byte
   * buffer (normally a hash of something).
   * @param {Buffer} target
   * @param {object} [opts] - Options forwarded to `dht-rpc`.
   * @returns {QueryStream} An async-iterable query stream whose values are `{ from, to, peers }` objects.
   * @example
   * {
   *   // Who sent the response?
   *   from: { id, host, port },
   *   // What address they responded to (i.e. your address)
   *   to: { host, port },
   *   // List of peers announcing under this topic
   *   peers: [ { publicKey, nodes: [{ host, port }, ...] } ]
   * }
   */
  lookup(target, opts = {}) {
    opts = { ...opts, map: mapLookup }
    return this.query({ target, command: COMMANDS.LOOKUP, value: null }, opts)
  }

  lookupAndUnannounce(target, keyPair, opts = {}) {
    const unannounces = []
    const dht = this
    const userCommit = opts.commit || noop
    const signUnannounce = opts.signUnannounce || Persistent.signUnannounce

    if (this._persistent !== null) {
      // unlink self
      this._persistent.unannounce(target, keyPair.publicKey)
    }

    opts = { ...opts, map, commit }
    return this.query({ target, command: COMMANDS.LOOKUP, value: null }, opts)

    async function commit(reply, dht, query) {
      await Promise.all(unannounces) // can never fail, caught below
      return userCommit(reply, dht, query)
    }

    function map(reply) {
      const data = mapLookup(reply)

      if (!data || !data.token) return data

      let found = data.peers.length >= 20
      for (let i = 0; !found && i < data.peers.length; i++) {
        found = b4a.equals(data.peers[i].publicKey, keyPair.publicKey)
      }

      if (!found) return data

      if (!data.from.id) return data

      unannounces.push(
        dht
          ._requestUnannounce(keyPair, dht, target, data.token, data.from, signUnannounce)
          .catch(safetyCatch)
      )

      return data
    }
  }

  /**
   * Unannounce a key-pair.
   * @param {Buffer} target - 32-byte topic buffer previously used in `announce()`.
   * @param {{publicKey: Buffer, secretKey: Buffer}} keyPair - The Ed25519 key pair to unannounce.
   * @param {object} [opts] - Options forwarded to `dht-rpc`.
   * @returns {Promise<void>} Resolves when the unannounce query has completed.
   * @example
   * const topic = DHT.hash(Buffer.from('my-topic'))
   * await node.unannounce(topic, keyPair)
   */
  unannounce(target, keyPair, opts = {}) {
    return this.lookupAndUnannounce(target, keyPair, opts).finished()
  }

  /**
   * Announce that you are listening on a key-pair to the DHT under a specific
   * topic.
   * @param {Buffer} target - 32-byte topic buffer to announce under.
   * @param {{publicKey: Buffer, secretKey: Buffer}} keyPair - The Ed25519 key pair to announce with.
   * @param {Array<{host: string, port: number}>} [relayAddresses] - Up to 3 DHT relay node addresses to include in the announcement.
   * @param {object} [opts] - Options forwarded to `dht-rpc`.
   * @returns {QueryStream} An async-iterable query stream (same shape as `lookup()`).
   * @example
   * const topic = DHT.hash(Buffer.from('my-topic'))
   * const stream = node.announce(topic, keyPair)
   * await stream.finished()
   */
  announce(target, keyPair, relayAddresses, opts = {}) {
    const signAnnounce = opts.signAnnounce || Persistent.signAnnounce
    const bump = opts.bump || 0

    opts = { ...opts, commit }

    return opts.clear ? this.lookupAndUnannounce(target, keyPair, opts) : this.lookup(target, opts)

    function commit(reply, dht) {
      return dht._requestAnnounce(
        keyPair,
        dht,
        target,
        reply.token,
        reply.from,
        relayAddresses,
        signAnnounce,
        bump
      )
    }
  }

  /**
   * Fetch an immutable value from the DHT. When successful, it returns the value
   * corresponding to the hash.
   * @param {Buffer} target - 32-byte hash of the value to fetch (returned by `immutablePut()`).
   * @param {object} [opts] - Options forwarded to `dht-rpc`.
   * @returns {Promise<{token: Buffer, from: object, to: object, value: Buffer}|null>} The result node or `null` if not found.
   * @example
   * const result = await node.immutableGet(hash)
   * if (result) console.log(result.value.toString())
   */
  async immutableGet(target, opts = {}) {
    opts = { ...opts, map: mapImmutable }

    const query = this.query({ target, command: COMMANDS.IMMUTABLE_GET, value: null }, opts)
    const check = b4a.allocUnsafe(32)

    for await (const node of query) {
      const { value } = node
      sodium.crypto_generichash(check, value)
      if (b4a.equals(check, target)) return node
    }

    return null
  }

  /**
   * Store an immutable value in the DHT. When successful, the hash of the value
   * is returned.
   * @param {Buffer} value - The value to store (a Buffer).
   * @param {object} [opts] - Options forwarded to `dht-rpc`.
   * @returns {Promise<{hash: Buffer, closestNodes: Array<object>}>} Object with the 32-byte `hash` and the `closestNodes` that stored the value.
   * @example
   * const { hash } = await node.immutablePut(Buffer.from('hello world'))
   * const result = await node.immutableGet(hash)
   * console.log(result.value.toString()) // 'hello world'
   */
  async immutablePut(value, opts = {}) {
    const target = b4a.allocUnsafe(32)
    sodium.crypto_generichash(target, value)

    opts = {
      ...opts,
      map: mapImmutable,
      commit(reply, dht) {
        return dht.request(
          { token: reply.token, target, command: COMMANDS.IMMUTABLE_PUT, value },
          reply.from
        )
      }
    }

    const query = this.query({ target, command: COMMANDS.IMMUTABLE_GET, value: null }, opts)
    await query.finished()

    return { hash: target, closestNodes: query.closestNodes }
  }

  /**
   * Fetch a mutable value from the DHT.
   * @param {Buffer} publicKey - Ed25519 public key of the key pair used to sign the value with `mutablePut()`.
   * @param {MutableGetOptions} [opts] - Fetch options.
   * @returns {Promise<{token: Buffer, from: object, to: object, seq: number, value: Buffer, signature: Buffer}|null>} The latest matching result, or `null` if not found.
   * @example
   * const result = await node.mutableGet(keyPair.publicKey)
   * if (result) console.log(result.value.toString(), 'seq:', result.seq)
   */
  async mutableGet(publicKey, opts = {}) {
    let refresh = opts.refresh || null
    let signed = null
    let result = null

    opts = { ...opts, map: mapMutable, commit: refresh ? commit : null }

    const target = b4a.allocUnsafe(32)
    sodium.crypto_generichash(target, publicKey)

    const userSeq = opts.seq || 0
    const query = this.query(
      { target, command: COMMANDS.MUTABLE_GET, value: c.encode(c.uint, userSeq) },
      opts
    )
    const latest = opts.latest !== false

    for await (const node of query) {
      if (result && node.seq <= result.seq) continue
      if (
        node.seq < userSeq ||
        !Persistent.verifyMutable(node.signature, node.seq, node.value, publicKey)
      )
        continue
      if (!latest) return node
      if (!result || node.seq > result.seq) result = node
    }

    return result

    function commit(reply, dht) {
      if (!signed && result && refresh) {
        if (refresh(result)) {
          signed = c.encode(m.mutablePutRequest, {
            publicKey,
            seq: result.seq,
            value: result.value,
            signature: result.signature
          })
        } else {
          refresh = null
        }
      }

      return signed
        ? dht.request(
            { token: reply.token, target, command: COMMANDS.MUTABLE_PUT, value: signed },
            reply.from
          )
        : Promise.resolve(null)
    }
  }

  /**
   * Store a mutable value in the DHT.
   * @param {{publicKey: Buffer, secretKey: Buffer}} keyPair - Ed25519 key pair used to sign the value.
   * @param {Buffer} value - The value to store (a Buffer).
   * @param {MutablePutOptions} [opts] - Put options.
   * @returns {Promise<{publicKey: Buffer, closestNodes: Array<object>, seq: number, signature: Buffer}>} The stored record metadata.
   * @example
   * const keyPair = DHT.keyPair()
   * const { seq } = await node.mutablePut(keyPair, Buffer.from('v1'), { seq: 0 })
   * console.log('stored at seq', seq)
   */
  async mutablePut(keyPair, value, opts = {}) {
    const signMutable = opts.signMutable || Persistent.signMutable

    const target = b4a.allocUnsafe(32)
    sodium.crypto_generichash(target, keyPair.publicKey)

    const seq = opts.seq || 0
    const signature = await signMutable(seq, value, keyPair)

    const signed = c.encode(m.mutablePutRequest, {
      publicKey: keyPair.publicKey,
      seq,
      value,
      signature
    })

    opts = {
      ...opts,
      map: mapMutable,
      commit(reply, dht) {
        return dht.request(
          { token: reply.token, target, command: COMMANDS.MUTABLE_PUT, value: signed },
          reply.from
        )
      }
    }

    // use seq = 0, for the query part here, as we don't care about the actual values
    const query = this.query(
      { target, command: COMMANDS.MUTABLE_GET, value: c.encode(c.uint, 0) },
      opts
    )
    await query.finished()

    return { publicKey: keyPair.publicKey, closestNodes: query.closestNodes, seq, signature }
  }

  onrequest(req) {
    switch (req.command) {
      case COMMANDS.PEER_HANDSHAKE: {
        this._router.onpeerhandshake(req)
        return true
      }
      case COMMANDS.PEER_HOLEPUNCH: {
        this._router.onpeerholepunch(req)
        return true
      }
    }

    if (this._persistent === null || this.id === null) return false

    switch (req.command) {
      case COMMANDS.FIND_PEER: {
        this._persistent.onfindpeer(req)
        return true
      }
      case COMMANDS.LOOKUP: {
        this._persistent.onlookup(req)
        return true
      }
      case COMMANDS.ANNOUNCE: {
        this._persistent.onannounce(req)
        return true
      }
      case COMMANDS.UNANNOUNCE: {
        this._persistent.onunannounce(req)
        return true
      }
      case COMMANDS.MUTABLE_PUT: {
        this._persistent.onmutableput(req)
        return true
      }
      case COMMANDS.MUTABLE_GET: {
        this._persistent.onmutableget(req)
        return true
      }
      case COMMANDS.IMMUTABLE_PUT: {
        this._persistent.onimmutableput(req)
        return true
      }
      case COMMANDS.IMMUTABLE_GET: {
        this._persistent.onimmutableget(req)
        return true
      }
      case COMMANDS.PLUGIN: {
        this._persistent.onplugin(req)
        return true
      }
    }

    return false
  }

  static keyPair(seed) {
    return createKeyPair(seed)
  }

  static hash(data) {
    return hash(data)
  }

  static connectRawStream(encryptedStream, rawStream, remoteId) {
    const stream = encryptedStream.rawStream

    if (!stream.connected) throw STREAM_NOT_CONNECTED()

    rawStream.connect(stream.socket, remoteId, stream.remotePort, stream.remoteHost)
  }

  createRawStream(opts) {
    return this.rawStreams.add(opts)
  }

  async _requestAnnounce(keyPair, dht, target, token, from, relayAddresses, sign, bump) {
    const ann = {
      peer: {
        publicKey: keyPair.publicKey,
        relayAddresses: relayAddresses || []
      },
      refresh: null,
      signature: null,
      bump
    }

    ann.signature = await sign(target, token, from.id, ann, keyPair)

    const value = c.encode(m.announce, ann)

    return dht.request(
      {
        token,
        target,
        command: COMMANDS.ANNOUNCE,
        value
      },
      from
    )
  }

  async _requestUnannounce(keyPair, dht, target, token, from, sign) {
    const unann = {
      peer: {
        publicKey: keyPair.publicKey,
        relayAddresses: []
      },
      signature: null
    }

    unann.signature = await sign(target, token, from.id, unann, keyPair)

    const value = c.encode(m.announce, unann)

    return dht.request(
      {
        token,
        target,
        command: COMMANDS.UNANNOUNCE,
        value
      },
      from
    )
  }

  register(name, plugin) {
    this.plugins.set(name, plugin)
    plugin.onregister(this)
  }
}

HyperDHT.BOOTSTRAP = BOOTSTRAP_NODES
HyperDHT.FIREWALL = FIREWALL

module.exports = HyperDHT

function mapLookup(node) {
  if (!node.value) return null

  try {
    const l = c.decode(m.lookupRawReply, node.value)

    return {
      token: node.token,
      from: node.from,
      to: node.to,
      peers: l.peers,
      bump: l.bump
    }
  } catch {
    return null
  }
}

function mapFindPeer(node) {
  if (!node.value) return null

  try {
    return {
      token: node.token,
      from: node.from,
      to: node.to,
      peer: c.decode(m.peer, node.value)
    }
  } catch {
    return null
  }
}

function mapImmutable(node) {
  if (!node.value) return null

  return {
    token: node.token,
    from: node.from,
    to: node.to,
    value: node.value
  }
}

function mapMutable(node) {
  if (!node.value) return null

  try {
    const { seq, value, signature } = c.decode(m.mutableGetResponse, node.value)

    return {
      token: node.token,
      from: node.from,
      to: node.to,
      seq,
      value,
      signature
    }
  } catch {
    return null
  }
}

function noop() {}

function filterNode(node) {
  // always skip these testnet nodes that got mixed in by accident, until they get updated
  return (
    !(node.port === 49738 && (node.host === '134.209.28.98' || node.host === '167.99.142.185')) &&
    !(node.port === 9400 && node.host === '35.233.47.252') &&
    !(node.host === '150.136.142.116')
  )
}

const defaultMaxSize = 65536
const defaultMaxAge = 20 * 60 * 1000 // 20 minutes

function defaultCacheOpts(opts) {
  const maxSize = opts.maxSize || defaultMaxSize
  const maxAge = opts.maxAge || defaultMaxAge

  return {
    router: {
      forwards: { maxSize, maxAge }
    },
    relayAddresses: { maxSize: Math.min(maxSize, 512), maxAge: 0 },
    persistent: {
      records: { maxSize, maxAge },
      refreshes: { maxSize, maxAge },
      mutables: {
        maxSize: (maxSize / 2) | 0,
        maxAge: opts.maxAge || 48 * 60 * 60 * 1000 // 48 hours
      },
      immutables: {
        maxSize: (maxSize / 2) | 0,
        maxAge: opts.maxAge || 48 * 60 * 60 * 1000 // 48 hours
      },
      bumps: { maxSize, maxAge }
    }
  }
}
