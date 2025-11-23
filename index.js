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
const { decode } = require('hypercore-id-encoding')
const RawStreamSet = require('./lib/raw-stream-set')
const ConnectionPool = require('./lib/connection-pool')
const { STREAM_NOT_CONNECTED } = require('./lib/errors')

class HyperDHT extends DHT {
  constructor(opts = {}) {
    const port = opts.port || 49737
    const bootstrap = opts.bootstrap || BOOTSTRAP_NODES
    const nodes = opts.nodes || KNOWN_NODES

    super({ ...opts, port, bootstrap, nodes, filterNode })

    const { router, relayAddresses, nodeRTT, connectionCache, directConnectionCache, persistent } =
      defaultCacheOpts(opts)

    this.defaultKeyPair = opts.keyPair || createKeyPair(opts.seed)
    this.listening = new Set()
    this.connectionKeepAlive =
      opts.connectionKeepAlive === false ? 0 : opts.connectionKeepAlive || 5000

    // stats is inherited from dht-rpc so fwd the ones from there
    this.stats = {
      punches: { consistent: 0, random: 0, open: 0 },
      relaying: { attempts: 0, successes: 0, aborts: 0 },
      ...this.stats
    }
    this.rawStreams = new RawStreamSet(this)

    this._router = new Router(this, router)
    this._socketPool = new SocketPool(this, opts.host || '0.0.0.0')
    this._persistent = null
    this._validatedLocalAddresses = new Map()
    this._relayAddressesCache = new Cache(relayAddresses)

    this._nodeRTT = new Cache(nodeRTT)

    this._connectionCache = new Cache(connectionCache)

    this._directConnectionCache = new Cache(directConnectionCache)

    this._deferRandomPunch = !!opts.deferRandomPunch
    this._lastRandomPunch = this._deferRandomPunch ? Date.now() : 0
    this._connectable = true
    this._randomPunchInterval = opts.randomPunchInterval || 20000 // min 20s between random punches...
    this._randomPunches = 0
    this._randomPunchLimit = 1 // set to one for extra safety for now

    this.once('persistent', () => {
      this._persistent = new Persistent(this, persistent)
    })

    this.on('network-change', () => {
      for (const server of this.listening) server.refresh()
    })

    this.on('network-update', () => {
      if (!this.online) return
      for (const server of this.listening) server.notifyOnline()
    })

    this._rttWarmupInterval = null
    if (opts.preWarmRTT !== false) {
      this._startRTTWarmup()
    }

    this.parallelProbing = opts.parallelProbing !== false
  }

  _startRTTWarmup() {
    if (this._rttWarmupInterval) return

    this._rttWarmupInterval = setInterval(() => {
      if (this.destroyed || !this.online) return

      // Sample up to 10 random nodes for RTT measurement
      const nodes = []
      if (this.nodes && this.nodes.latest) {
        let count = 0
        for (let node = this.nodes.latest; node && count < 10; node = node.prev) {
          if (node.host && node.port) {
            nodes.push(node)
            count++
          }
        }
      }

      for (const node of nodes) {
        const key = `${node.host}:${node.port}`
        const stats = this._nodeRTT.get(key)
        const needsUpdate = !stats || Date.now() - stats.lastUpdate > 60000 // Update if older than 60s

        if (needsUpdate) {
          // Measure RTT in background (don't await)
          const startTime = process.hrtime.bigint()
          this.ping({ host: node.host, port: node.port }).then(
            () => {
              const endTime = process.hrtime.bigint()
              const rtt = Number(endTime - startTime) / 1_000_000
              if (rtt > 0 && rtt < 10000) {
                // Sanity check: RTT should be reasonable
                this.updateNodeRTT(node, rtt)
              }
            },
            () => {
              // Ignore ping failures in background warmup
            }
          )
        }
      }
    }, 30000) // Every 30 seconds
  }

  _stopRTTWarmup() {
    if (this._rttWarmupInterval) {
      clearInterval(this._rttWarmupInterval)
      this._rttWarmupInterval = null
    }
  }

  connect(remotePublicKey, opts) {
    return connect(this, decode(remotePublicKey), opts)
  }

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

  async destroy({ force = false } = {}) {
    if (!force) {
      const closing = []
      for (const server of this.listening) closing.push(server.close())
      await Promise.allSettled(closing)
    }
    this._router.destroy()
    if (this._persistent) this._persistent.destroy()
    await this.rawStreams.clear()
    await this._socketPool.destroy()
    this._stopRTTWarmup()
    this._nodeRTT.clear()
    this._connectionCache.clear()
    this._directConnectionCache.clear()
    await super.destroy()
  }

  /**
   * Get RTT for a node (by address or node object)
   */
  getNodeRTT(node) {
    if (!node) return null
    const host = node.host || (node.address && node.address.host)
    const port = node.port || (node.address && node.address.port)
    if (!host || !port) return null

    const key = `${host}:${port}`
    const stats = this._nodeRTT.get(key)
    return stats ? stats.srtt : null
  }


  updateNodeRTT(node, rtt) {
    if (!node || !rtt || rtt <= 0) return

    const host = node.host || (node.address && node.address.host)
    const port = node.port || (node.address && node.address.port)
    if (!host || !port) return

    const key = `${host}:${port}`

    const alpha = 0.125 // Weight for SRTT
    const beta = 0.25 // Weight for RTTVAR

    if (!this._nodeRTT.has(key)) {
      // First measurement
      this._nodeRTT.set(key, {
        srtt: rtt,
        rttvar: rtt / 2, // Initial variance estimate
        samples: 1,
        lastUpdate: Date.now()
      })
    } else {
      const stats = this._nodeRTT.get(key)

      stats.rttvar = (1 - beta) * stats.rttvar + beta * Math.abs(stats.srtt - rtt)

      stats.srtt = (1 - alpha) * stats.srtt + alpha * rtt

      stats.samples++
      stats.lastUpdate = Date.now()
    }
  }


  sortNodesByRTT(nodes) {
    return nodes
      .map((node) => ({
        node,
        rtt: this.getNodeRTT(node) || Infinity
      }))
      .sort((a, b) => a.rtt - b.rtt)
      .map((item) => item.node)
  }

 
  getAverageRTT() {
    if (!this._nodeRTT) return null

    let totalRTT = 0
    let count = 0
    for (const stats of this._nodeRTT.values()) {
      if (stats.srtt && stats.srtt > 0) {
        totalRTT += stats.srtt
        count++
      }
    }

    return count > 0 ? totalRTT / count : null
  }

 
  getRTTBasedTimeout(baseTimeout = 10000, minMultiplier = 0.9, maxMultiplier = 1.5) {
    const avgRTT = this.getAverageRTT()
    if (!avgRTT) return baseTimeout

    // Only optimize timeout if we have very fast RTT (< 100ms)
    // For slower networks, keep the base timeout to avoid premature timeouts
    if (avgRTT < 100) {
      // For fast networks, use 10x RTT as timeout (very conservative)
      const rttBasedTimeout = avgRTT * 10
      const minTimeout = baseTimeout * minMultiplier
      const maxTimeout = baseTimeout * maxMultiplier
      return Math.max(minTimeout, Math.min(maxTimeout, rttBasedTimeout))
    }

    // For slower networks, don't reduce timeout - keep base
    return baseTimeout
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

  unannounce(target, keyPair, opts = {}) {
    return this.lookupAndUnannounce(target, keyPair, opts).finished()
  }

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
}

HyperDHT.BOOTSTRAP = BOOTSTRAP_NODES
HyperDHT.FIREWALL = FIREWALL

module.exports = HyperDHT

function mapLookup(node) {
  if (!node.value) return null

  const l = c.decode(m.lookupRawReply, node.value)

  try {
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
    nodeRTT: { maxSize: Math.min(maxSize, 2048), maxAge: 3600000 }, // 1 hour TTL
    connectionCache: { maxSize: Math.min(maxSize, 1024), maxAge: 60000 }, // 60s TTL
    directConnectionCache: { maxSize: Math.min(maxSize, 1024), maxAge: 300000 }, // 5 min TTL
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
