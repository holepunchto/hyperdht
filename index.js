const { EventEmitter } = require('events')
const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const cenc = require('compact-encoding')
const NoiseSecretStream = require('noise-secret-stream')
const Timer = require('./lib/timer')
const Holepuncher = require('./lib/holepuncher')
const messages = require('./lib/messages')
const NoiseState = require('./lib/noise')
const PersistentNode = require('./lib/persistent')
const {
  hash, noop, allowAll, mapImmutable,
  mapMutable, mapLookup, mapConnect,
  NS_HOLEPUNCH, NS_SIGNATURE
} = require('./lib/utilities')

const BOOTSTRAP_NODES = [
  { host: 'testnet1.hyperdht.org', port: 49736 },
  { host: 'testnet2.hyperdht.org', port: 49736 },
  { host: 'testnet3.hyperdht.org', port: 49736 }
]

const SERVER_TIMEOUT = 20000
const CLIENT_TIMEOUT = 25000

// PUT_VALUE_MAX_SIZE + packet overhead (i.e. the key etc.)
// should be less than the network MTU, normally 1400 bytes
const PUT_VALUE_MAX_SIZE = 1000

const BAD_ADDR = new Error('Relay and remote peer does not agree on their public address')
const NOT_HOLEPUNCHABLE = new Error('Both networks are not holepunchable')
const TIMEOUT = new Error('Holepunch attempt timed out')

module.exports = class HyperDHT extends DHT {
  constructor (opts = {}) {
    super({ bootstrap: BOOTSTRAP_NODES, ...opts })

    this.persistent = null
    this.defaultKeyPair = opts.keyPair || HyperDHT.keyPair(opts.seed)
    this.servers = new Set()

    this.on('request', this._ondhtrequest)
    this.on('persistent', this._ondhtpersistent)
  }

  destroy () {
    if (this.persistent !== null) this.persistent.destroy()
    super.destroy()
  }

  _ondhtpersistent () {
    this.persistent = new PersistentNode(this)
  }

  _ondhtrequest (req) {
    if (req.command === 'relay_connect') return this._onrelayconnect(req)
    if (req.command === 'relay_holepunch') return this._onrelayholepunch(req)

    if (this.persistent === null) {
      req.error(DHT.UNKNOWN_COMMAND)
      return
    }

    switch (req.command) {
      case 'lookup': return this.persistent.onlookup(req)
      case 'announce': return this.persistent.onannounce(req)
      case 'unannounce': return this.persistent.onunannounce(req)
      case 'connect': return this.persistent.onconnect(req)
      case 'holepunch': return this.persistent.onholepunch(req)
      case 'immutable_get': return this.persistent.onget(req, { mutable: false })
      case 'immutable_put': return this.persistent.onput(req, { mutable: false })
      case 'mutable_get': return this.persistent.onget(req, { mutable: true })
      case 'mutable_put': return this.persistent.onput(req, { mutable: true })
    }

    req.error(DHT.UNKNOWN_COMMAND)
  }

  _onrelayconnect (req) {
    for (const s of this.servers) {
      if (s.target.equals(req.target)) { // found session
        s.onconnect(req)
        return
      }
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  _onrelayholepunch (req) {
    if (!req.target || !req.value) return

    for (const s of this.servers) {
      if (s.target.equals(req.target)) {
        s.onholepunch(req)
        return
      }
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  connect (publicKey, opts) {
    return NoiseSecretStream.async(this.connectRaw(publicKey, opts))
  }

  async connectRaw (publicKey, opts = {}) {
    const remoteNoisePublicKey = Buffer.alloc(32)
    const noiseKeyPair = NoiseState.ed25519toCurve25519(opts.keyPair || (opts.secretKey ? opts : this.defaultKeyPair))

    sodium.crypto_sign_ed25519_pk_to_curve25519(remoteNoisePublicKey, publicKey)

    const target = hash(publicKey)
    const noise = new NoiseState(noiseKeyPair, remoteNoisePublicKey)

    await this.sampledNAT()

    const addr = this.remoteAddress()
    const holepunch = new Holepuncher(addr)
    const onmessage = this.onmessage.bind(this)

    const localPayload = holepunch.bind()
    const socket = holepunch.socket
    const timeout = setTimeout(ontimeout, CLIENT_TIMEOUT)

    // forward incoming messages to the dht
    socket.on('message', onmessage)

    localPayload.relayAuth = Buffer.allocUnsafe(32)

    sodium.randombytes_buf(localPayload.relayAuth)

    const value = cenc.encode(messages.connect, { noise: noise.send(localPayload), relayAuth: localPayload.relayAuth })
    const query = this.query(target, 'connect', value, { socket, nodes: opts.nodes, map: mapConnect })

    let error = null

    for await (const { from, token, connect } of query) {
      const payload = noise.recv(connect.noise, false)

      if (!payload) continue
      if (!payload.address.port) payload.address.port = connect.relayPort

      const relayAuth = Buffer.allocUnsafe(32)
      sodium.crypto_generichash(relayAuth, cenc.encode(messages.peerIPv4, payload.address), payload.relayAuth)
      holepunch.setRemoteNetwork(payload)

      if (!relayAuth.equals(connect.relayAuth) || payload.address.port !== connect.relayPort) {
        error = BAD_ADDR
        break
      }

      if (!holepunch.holepunchable) {
        error = NOT_HOLEPUNCHABLE
        break
      }

      sodium.crypto_generichash_batch(relayAuth, [noise.handshakeHash, payload.relayAuth], NS_HOLEPUNCH)

      await holepunch.openSessions()

      try {
        await Promise.race([this.request(target, 'holepunch', relayAuth, from, { socket, token }), holepunch.connected])
      } catch {
        break
      }

      socket.removeListener('message', onmessage)

      await holepunch.holepunch()
      const rawSocket = await holepunch.connected

      if (!rawSocket) {
        error = TIMEOUT
        break
      }

      clearTimeout(timeout)
      // [isInitiator, rawSocket, noise]
      return [true, rawSocket, noise]
    }

    clearTimeout(timeout)
    socket.removeListener('message', onmessage)
    holepunch.destroy()
    noise.destroy()

    if (!error) error = new Error('Could not connect to peer')

    throw error

    function ontimeout () {
      if (!error) error = TIMEOUT
      query.destroy()
      holepunch.destroy()
    }
  }

  async immutableGet (key, opts = {}) {
    if (Buffer.isBuffer(key) === false) throw new Error('key must be a buffer')
    const query = this.query(key, 'immutable_get', null, {
      closestNodes: opts.closestNodes,
      map: mapImmutable
    })
    const check = Buffer.allocUnsafe(32)
    for await (const node of query) {
      const { value } = node
      sodium.crypto_generichash(check, value)
      if (check.equals(key)) return node
    }
    throw Error('not found')
  }

  async immutablePut (value, opts = {}) {
    if (Buffer.isBuffer(value) === false) throw new Error('value must be a buffer')
    if (value.length > PUT_VALUE_MAX_SIZE) {
      throw new Error(`Value size must be <= ${PUT_VALUE_MAX_SIZE}`)
    }
    const key = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(key, value)
    const query = this.query(key, 'immutable_get', null, {
      closestNodes: opts.closestNodes,
      map: mapImmutable,
      commit (node, dht) {
        return dht.request(key, 'immutable_put', value, node.from, {
          token: node.token
        })
      }
    })
    await query.finished()
    return { key, closestNodes: query.closestNodes }
  }

  async mutableGet (key, { seq = 0, latest = true, closestNodes = [] } = {}) {
    if (Buffer.isBuffer(key) === false) throw new Error('key must be a buffer')
    if (typeof seq !== 'number') throw new Error('seq should be a number')
    const hash = Buffer.alloc(32)
    sodium.crypto_generichash(hash, key)
    const query = this.query(hash, 'mutable_get', cenc.encode(cenc.uint, seq), {
      closestNodes,
      map: mapMutable
    })
    const userSeq = seq
    let topSeq = seq
    let result = null
    for await (const node of query) {
      const { id, value, signature, seq: storedSeq, publicKey, ...meta } = node
      const signable = Buffer.allocUnsafe(32)
      sodium.crypto_generichash(signable, cenc.encode(messages.signable, { value, seq: storedSeq }), NS_SIGNATURE)
      if (storedSeq >= userSeq && sodium.crypto_sign_verify_detached(signature, signable, publicKey)) {
        if (latest === false) return { id, value, signature, seq: storedSeq, ...meta }
        if (storedSeq >= topSeq) {
          topSeq = storedSeq
          result = { id, value, signature, seq: storedSeq, ...meta }
        }
      }
    }
    return result
  }

  async mutablePut (value, opts = {}) {
    if (Buffer.isBuffer(value) === false) throw new Error('value must be a buffer')
    if (value.length > PUT_VALUE_MAX_SIZE) {
      throw new Error(`Value size must be <= ${PUT_VALUE_MAX_SIZE}`)
    }

    const { seq = 0, keyPair, closestNodes = [] } = opts
    if (typeof seq !== 'number') throw new Error('seq should be a number')
    if (!keyPair) throw new Error('keyPair is required')
    const { secretKey, publicKey } = keyPair
    if (Buffer.isBuffer(publicKey) === false) throw new Error('keyPair.publicKey is required')
    if (Buffer.isBuffer(secretKey) === false) throw new Error('keyPair.secretKey is required')

    const hash = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(hash, publicKey)
    const signable = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(signable, cenc.encode(messages.signable, { value, seq }), NS_SIGNATURE)
    const signature = Buffer.allocUnsafe(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(signature, signable, secretKey)

    const msg = cenc.encode(messages.mutable, {
      value, signature, seq, publicKey
    })
    const query = this.query(hash, 'mutable_get', cenc.encode(cenc.uint, seq), {
      map: mapMutable,
      closestNodes,
      commit (node, dht) {
        return dht.request(hash, 'mutable_put', msg, node.from, { token: node.token })
      }
    })
    await query.finished()
    return { signature, seq }
  }

  lookup (target, opts = {}) {
    opts = { ...opts, map: mapLookup }
    return this.query(target, 'lookup', null, opts)
  }

  lookupAndUnannounce (target, keyPair, opts = {}) {
    const unannounces = []
    const dht = this
    const userCommit = opts.commit || noop

    if (this.persistent !== null) { // unlink self
      this.persistent.unannounce(target, keyPair.publicKey)
    }

    opts = { ...opts, map, commit }
    return this.query(target, 'lookup', null, opts)

    async function commit (reply, dht, query) {
      while (unannounces.length) {
        try {
          await unannounces.pop()
        } catch {
          continue
        }
      }

      return userCommit(reply, dht, query)
    }

    function map (reply) {
      const data = mapLookup(reply)

      if (!data || !data.token) return data

      let found = data.peers.length >= 20
      for (let i = 0; !found && i < data.peers.length; i++) {
        found = data.peers[i].publicKey.equals(keyPair.publicKey)
      }

      if (!found) return data

      const m = {
        timestamp: Date.now(),
        publicKey: keyPair.publicKey,
        origin: true,
        signature: null
      }

      m.signature = PersistentNode.signUnannounce(target, m, data.to, data.from, keyPair.secretKey)

      const value = cenc.encode(messages.unannounce, m)
      unannounces.push(dht.request(target, 'unannounce', value, data.from, { token: data.token }))

      return data
    }
  }

  unannounce (target, keyPair, opts = {}) {
    return this.lookupAndUnannounce(target, keyPair, opts).finished()
  }

  announce (target, keyPair, nodes = [], opts = {}) {
    let value = null
    opts = { ...opts, commit }

    return opts.clear
      ? this.lookupAndUnannounce(target, keyPair, opts)
      : this.lookup(target, opts)

    function commit (reply, dht) {
      if (value === null) { // make it just in time so the timestamp is up to date
        const m = {
          timestamp: Date.now(),
          publicKey: keyPair.publicKey,
          nodes,
          origin: false,
          signature: null
        }

        m.signature = PersistentNode.signAnnounce(target, m, null, null, keyPair.secretKey)
        value = cenc.encode(messages.announce, m)
      }

      return dht.request(target, 'announce', value, reply.from, { token: reply.token })
    }
  }

  createServer (opts) {
    if (typeof opts === 'function') opts = { onconnection: opts }
    return new KATServer(this, opts)
  }

  static keyPair (seed) {
    const publicKey = Buffer.alloc(32)
    const secretKey = Buffer.alloc(64)
    if (seed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
    else sodium.crypto_sign_keypair(publicKey, secretKey)
    return { publicKey, secretKey }
  }
}

class KeepAliveTimer extends Timer {
  constructor (dht, target, addr) {
    super(3000, null, false)

    this.target = target
    this.addr = addr
    this.dht = dht
    this.expires = Date.now() + 10 * 60 * 1000
  }

  update () {
    if (Date.now() > this.expires) return this.stop()
    return this.dht.ping(this.addr)
  }
}

class KATServer extends EventEmitter {
  constructor (dht, opts = {}) {
    super()

    this.target = null
    this.keyPair = null
    this.noiseKeyPair = null
    this.dht = dht
    this.closestNodes = null
    this.nodes = null
    this.destroyed = false
    this.onauthenticate = opts.onauthentiate || allowAll

    this._keepAlives = null
    this._incomingHandshakes = new Set()
    this._servers = dht.servers
    this._listening = null
    this._resolveUpdatedOnce = null
    this._updatedOnce = new Promise((resolve) => { this._resolveUpdatedOnce = resolve })
    this._interval = null

    this._updatedOnce.then(() => {
      if (!this.destroyed) this.emit('listening')
    })

    if (opts.onconnection) this.on('connection', opts.onconnection)
  }

  gc () {
    const now = Date.now()
    for (const hs of this._incomingHandshakes) {
      if (now < hs.added + SERVER_TIMEOUT) continue
      hs.holepunch.destroy()
      this._incomingHandshakes.delete(hs)
    }
  }

  async onconnect (req) {
    let m = null
    try {
      m = cenc.decode(messages.connectRelay, req.value)
    } catch {
      return
    }

    for (const hs of this._incomingHandshakes) {
      if (hs.noise.request.equals(m.noise)) {
        const value = cenc.encode(messages.connect, { noise: hs.noise.response, relayAuth: hs.localPayload.relayAuth })
        req.reply(value, { token: false, closerNodes: false, socket: hs.holepunch.socket })
        return
      }
    }

    const noise = new NoiseState(this.noiseKeyPair, null)
    const payload = noise.recv(m.noise)

    if (!payload) return

    if (!payload.address.port) payload.address.port = m.relayPort

    // if the remote peer do not agree on the relay port (in case of explicit ports) - drop message
    if (payload.address.port !== m.relayPort) return

    const relayAuth = Buffer.allocUnsafe(32)

    sodium.crypto_generichash(relayAuth, cenc.encode(messages.peerIPv4, payload.address), payload.relayAuth)

    // if the remote peer and relay do not agree on the address of the peer - drop message
    if (!relayAuth.equals(m.relayAuth)) {
      noise.destroy()
      return
    }

    let authenticated = false

    try {
      authenticated = !!(await this.onauthenticate(noise.remoteNoisePublicKey, payload))
    } catch {}

    if (this.destroyed || !authenticated) {
      noise.destroy()
      return
    }

    const addr = this.dht.remoteAddress()
    const signal = Buffer.allocUnsafe(32)
    const holepunch = new Holepuncher(addr)

    holepunch.setRemoteNetwork(payload)
    const localPayload = holepunch.bind()

    // reset auth token
    sodium.randombytes_buf(relayAuth)
    localPayload.relayAuth = relayAuth

    const hs = {
      added: Date.now(),
      noise,
      holepunch,
      payload,
      localPayload,
      signal
    }

    this._incomingHandshakes.add(hs)
    holepunch.connected.then((rawSocket) => {
      this._incomingHandshakes.delete(hs)
      if (!rawSocket) return

      const socket = new NoiseSecretStream(false, rawSocket, noise)

      if (this.emit('connection', socket)) return

      socket.on('error', noop)
      socket.destroy()
    })

    const noisePayload = noise.send(hs.localPayload)
    sodium.crypto_generichash_batch(signal, [noise.handshakeHash, relayAuth], NS_HOLEPUNCH)

    req.reply(cenc.encode(messages.connect, { noise: noisePayload, relayAuth }), { token: false, closerNodes: false, socket: hs.holepunch.socket })
  }

  async onholepunch (req) {
    for (const hs of this._incomingHandshakes) {
      if (hs.signal.equals(req.value)) {
        await hs.holepunch.holepunch()
        break
      }
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  close () {
    if (this._interval) clearInterval(this._interval)

    if (this._activeQuery) this._activeQuery.destroy()
    if (this._keepAlives) {
      for (const keepAlive of this._keepAlives) keepAlive.stop()
    }
    this._keepAlives = null
    this._servers.delete(this)
    this.destroyed = true

    return this._listening ? this._listening : Promise.resolve()
  }

  address () {
    if (!this.keyPair) {
      throw new Error('Server is not listening')
    }

    return {
      family: 'KATv1',
      address: this.dht.remoteAddress().host,
      publicKey: this.keyPair.publicKey
    }
  }

  listen (keyPair = this.dht.defaultKeyPair) {
    if (this.keyPair) {
      throw new Error('Server is already listening on a keyPair')
    }

    this._interval = setInterval(this.gc.bind(this), 5000)
    this._servers.add(this)

    this.target = hash(keyPair.publicKey)
    this.keyPair = keyPair
    this.noiseKeyPair = NoiseState.ed25519toCurve25519(keyPair)

    if (!this._listening) this._listening = this._updateNodes()
    return this._updatedOnce
  }

  async _updateNodes () {
    while (!this.destroyed) {
      try {
        await this._queryClosestGateways()
      } catch {
        await this._sleep(5000)
        continue
      }

      if (this.destroyed) break

      this._keepAlives = []
      const running = []

      for (const node of this.nodes) {
        const k = new KeepAliveTimer(this.dht, this.target, node)
        this._keepAlives.push(k)
        k.start()
        running.push(k.running)
      }

      for (const p of running) await p
    }
  }

  async _queryClosestGateways () {
    const q = this._activeQuery = this.dht.query(this.target, 'lookup', null, { nodes: this.closestNodes })
    await q.finished()

    if (q === this._activeQuery) this._activeQuery = null
    if (this.destroyed) return this._resolveUpdatedOnce(false)

    this.closestNodes = q.closestNodes

    const promises = []

    for (const reply of q.closestReplies.slice(0, 3)) {
      const m = {
        timestamp: Date.now(),
        publicKey: this.keyPair.publicKey,
        nodes: [reply.from],
        origin: true,
        signature: null
      }

      m.signature = PersistentNode.signAnnounce(this.target, m, reply.to, reply.from, this.keyPair.secretKey)

      promises.push(this.dht.request(this.target, 'announce', cenc.encode(messages.announce, m), reply.from, { token: reply.token }))
    }

    const nodes = []
    for (const p of promises) {
      try {
        nodes.push((await p).from)
      } catch {
        continue
      }
    }

    if (!nodes.length) throw new Error('All gateway requests failed')

    this.nodes = nodes
    this._resolveUpdatedOnce(true)
  }

  _sleep (ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }
}
