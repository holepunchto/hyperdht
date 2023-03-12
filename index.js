const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const c = require('compact-encoding')
const b4a = require('b4a')
const m = require('./lib/messages')
const SocketPool = require('./lib/socket-pool')
const Persistent = require('./lib/persistent')
const Router = require('./lib/router')
const Server = require('./lib/server')
const connect = require('./lib/connect')
const { FIREWALL, BOOTSTRAP_NODES, COMMANDS } = require('./lib/constants')
const { hash, createKeyPair } = require('./lib/crypto')
const RawStreamSet = require('./lib/raw-stream-set')
const { STREAM_NOT_CONNECTED } = require('./lib/errors')

const maxSize = 65536
const maxAge = 20 * 60 * 1000

class HyperDHT extends DHT {
  constructor (opts = {}) {
    const port = opts.port || 49737
    const bootstrap = opts.bootstrap || BOOTSTRAP_NODES

    super({ ...opts, port, bootstrap, addNode })

    const cacheOpts = {
      maxSize: opts.maxSize || maxSize,
      maxAge: opts.maxAge || maxAge
    }

    this.defaultKeyPair = opts.keyPair || createKeyPair(opts.seed)
    this.listening = new Set()

    this._router = new Router(this, cacheOpts)
    this._socketPool = new SocketPool(this, opts.host || '0.0.0.0')
    this._rawStreams = new RawStreamSet(this)
    this._persistent = null

    this._debugStream = (opts.debug && opts.debug.stream) || null
    this._debugHandshakeLatency = toRange((opts.debug && opts.debug.handshake && opts.debug.handshake.latency) || 0)

    this.once('persistent', () => {
      this._persistent = new Persistent(this, cacheOpts)
    })

    this.on('network-change', () => {
      for (const server of this.listening) server.refresh()
    })
  }

  connect (remotePublicKey, opts) {
    return connect(this, remotePublicKey, opts)
  }

  createServer (opts, onconnection) {
    if (typeof opts === 'function') return this.createServer({}, opts)
    if (opts && opts.onconnection) onconnection = opts.onconnection
    const s = new Server(this, opts)
    if (onconnection) s.on('connection', onconnection)
    return s
  }

  async destroy ({ force } = {}) {
    if (!force) {
      const closing = []
      for (const server of this.listening) closing.push(server.close())
      await Promise.allSettled(closing)
    }
    this._router.destroy()
    if (this._persistent) this._persistent.destroy()
    await this._rawStreams.destroy()
    await this._socketPool.destroy()
    await super.destroy()
  }

  findPeer (publicKey, opts = {}) {
    const target = opts.hash === false ? publicKey : hash(publicKey)
    opts = { ...opts, map: mapFindPeer }
    return this.query({ target, command: COMMANDS.FIND_PEER, value: null }, opts)
  }

  lookup (target, opts = {}) {
    opts = { ...opts, map: mapLookup }
    return this.query({ target, command: COMMANDS.LOOKUP, value: null }, opts)
  }

  lookupAndUnannounce (target, keyPair, opts = {}) {
    const unannounces = []
    const dht = this
    const userCommit = opts.commit || noop
    const signUnannounce = opts.signUnannounce || Persistent.signUnannounce

    if (this._persistent !== null) { // unlink self
      this._persistent.unannounce(target, keyPair.publicKey)
    }

    opts = { ...opts, map, commit }
    return this.query({ target, command: COMMANDS.LOOKUP, value: null }, opts)

    async function commit (reply, dht, query) {
      await Promise.all(unannounces) // can never fail, caught below
      return userCommit(reply, dht, query)
    }

    function map (reply) {
      const data = mapLookup(reply)

      if (!data || !data.token) return data

      let found = data.peers.length >= 20
      for (let i = 0; !found && i < data.peers.length; i++) {
        found = b4a.equals(data.peers[i].publicKey, keyPair.publicKey)
      }

      if (!found) return data

      unannounces.push(
        dht._requestUnannounce(
          keyPair,
          dht,
          target,
          data.token,
          data.from,
          signUnannounce
        ).catch(noop)
      )

      return data
    }
  }

  unannounce (target, keyPair, opts = {}) {
    return this.lookupAndUnannounce(target, keyPair, opts).finished()
  }

  announce (target, keyPair, relayAddresses, opts = {}) {
    const signAnnounce = opts.signAnnounce || Persistent.signAnnounce

    opts = { ...opts, commit }

    return opts.clear
      ? this.lookupAndUnannounce(target, keyPair, opts)
      : this.lookup(target, opts)

    function commit (reply, dht) {
      return dht._requestAnnounce(
        keyPair,
        dht,
        target,
        reply.token,
        reply.from,
        relayAddresses,
        signAnnounce
      )
    }
  }

  async immutableGet (target, opts = {}) {
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

  async immutablePut (value, opts = {}) {
    const target = b4a.allocUnsafe(32)
    sodium.crypto_generichash(target, value)

    opts = {
      ...opts,
      map: mapImmutable,
      commit (reply, dht) {
        return dht.request({ token: reply.token, target, command: COMMANDS.IMMUTABLE_PUT, value }, reply.from)
      }
    }

    const query = this.query({ target, command: COMMANDS.IMMUTABLE_GET, value: null }, opts)
    await query.finished()

    return { hash: target, closestNodes: query.closestNodes }
  }

  async mutableGet (publicKey, opts = {}) {
    let refresh = opts.refresh || null
    let signed = null
    let result = null

    opts = { ...opts, map: mapMutable, commit: refresh ? commit : null }

    const target = b4a.allocUnsafe(32)
    sodium.crypto_generichash(target, publicKey)

    const userSeq = opts.seq || 0
    const query = this.query({ target, command: COMMANDS.MUTABLE_GET, value: c.encode(c.uint, userSeq) }, opts)
    const latest = opts.latest !== false

    for await (const node of query) {
      if (result && node.seq <= result.seq) continue
      if (node.seq < userSeq || !Persistent.verifyMutable(node.signature, node.seq, node.value, publicKey)) continue
      if (!latest) return node
      if (!result || node.seq > result.seq) result = node
    }

    return result

    function commit (reply, dht) {
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

      return signed ? dht.request({ token: reply.token, target, command: COMMANDS.MUTABLE_PUT, value: signed }, reply.from) : Promise.resolve(null)
    }
  }

  async mutablePut (keyPair, value, opts = {}) {
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
      commit (reply, dht) {
        return dht.request({ token: reply.token, target, command: COMMANDS.MUTABLE_PUT, value: signed }, reply.from)
      }
    }

    // use seq = 0, for the query part here, as we don't care about the actual values
    const query = this.query({ target, command: COMMANDS.MUTABLE_GET, value: c.encode(c.uint, 0) }, opts)
    await query.finished()

    return { publicKey: keyPair.publicKey, closestNodes: query.closestNodes, seq, signature }
  }

  onrequest (req) {
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

    if (this._persistent === null) return false

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
    }

    return false
  }

  static keyPair (seed) {
    return createKeyPair(seed)
  }

  static hash (data) {
    return hash(data)
  }

  static connectRawStream (encryptedStream, rawStream, remoteId) {
    const stream = encryptedStream.rawStream

    if (!stream.connected) throw STREAM_NOT_CONNECTED()

    rawStream.connect(
      stream.socket,
      remoteId,
      stream.remotePort,
      stream.remoteHost
    )
  }

  createRawStream (opts) {
    return this._rawStreams.add(opts)
  }

  async _requestAnnounce (keyPair, dht, target, token, from, relayAddresses, sign) {
    const ann = {
      peer: {
        publicKey: keyPair.publicKey,
        relayAddresses: relayAddresses || []
      },
      refresh: null,
      signature: null
    }

    ann.signature = await sign(target, token, from.id, ann, keyPair)

    const value = c.encode(m.announce, ann)

    return dht.request({
      token,
      target,
      command: COMMANDS.ANNOUNCE,
      value
    }, from)
  }

  async _requestUnannounce (keyPair, dht, target, token, from, sign) {
    const unann = {
      peer: {
        publicKey: keyPair.publicKey,
        relayAddresses: []
      },
      signature: null
    }

    unann.signature = await sign(target, token, from.id, unann, keyPair)

    const value = c.encode(m.announce, unann)

    return dht.request({
      token,
      target,
      command: COMMANDS.UNANNOUNCE,
      value
    }, from)
  }
}

HyperDHT.BOOTSTRAP = BOOTSTRAP_NODES
HyperDHT.FIREWALL = FIREWALL

module.exports = HyperDHT

function mapLookup (node) {
  if (!node.value) return null

  try {
    return {
      token: node.token,
      from: node.from,
      to: node.to,
      peers: c.decode(m.peers, node.value)
    }
  } catch {
    return null
  }
}

function mapFindPeer (node) {
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

function mapImmutable (node) {
  if (!node.value) return null

  return {
    token: node.token,
    from: node.from,
    to: node.to,
    value: node.value
  }
}

function mapMutable (node) {
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

function noop () {}

function toRange (n) {
  if (!n) return null
  return typeof n === 'number' ? [n, n] : n
}

function addNode (node) {
  // always skip these testnet nodes that got mixed in by accident, until they get updated
  return !(node.port === 49738 && (node.host === '134.209.28.98' || node.host === '167.99.142.185')) &&
    !(node.port === 9400 && node.host === '35.233.47.252') && !(node.host === '150.136.142.116')
}
