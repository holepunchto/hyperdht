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
const { NS_HOLEPUNCH } = require('./lib/ns')

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

  async destroy () {
    if (this.persistent !== null) this.persistent.destroy()
    this.persistent = null
    const promises = []
    for (const server of this.servers) {
      promises.push(server.close())
    }
    await Promise.allSettled(promises)
    return super.destroy()
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
      case 'immutable_get': return this.persistent.onimmutableget(req)
      case 'immutable_put': return this.persistent.onimmutableput(req)
      case 'mutable_get': return this.persistent.onmutableget(req)
      case 'mutable_put': return this.persistent.onmutableput(req)
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
    // TODO: rework this so connectRaw starts the stream instead (and rename connectRaw)
    // not public api so not semver

    const s = new NoiseSecretStream(true, null, { autoStart: false, remotePublicKey: publicKey })

    this.connectRaw(publicKey, opts)
      .then(([rawSocket, opts]) => { s.start(rawSocket, opts) }, (err) => s.destroy(err))

    return s
  }

  async connectRaw (publicKey, opts = {}) {
    const remoteNoisePublicKey = Buffer.alloc(32)
    const localKeyPair = opts.keyPair || (opts.secretKey ? opts : this.defaultKeyPair)
    const noiseKeyPair = NoiseState.ed25519toCurve25519(localKeyPair)

    sodium.crypto_sign_ed25519_pk_to_curve25519(remoteNoisePublicKey, publicKey)

    const target = hash(publicKey)
    const noise = new NoiseState(noiseKeyPair, remoteNoisePublicKey)

    await this.sampledNAT()

    const addr = this.remoteAddress()
    const holepunch = new Holepuncher(addr)
    const onmessage = this.onmessage.bind(this)

    const localPayload = holepunch.bind()
    const socket = holepunch.socket
    
    const value = cenc.encode(messages.connect, { noise: noise.send(localPayload), relayAuth: localPayload.relayAuth })
    const query = this.query(target, 'connect', value, { socket, nodes: opts.nodes, map: mapConnect })

    let error = null
    
    const timeout = setTimeout(ontimeout, CLIENT_TIMEOUT)

    // forward incoming messages to the dht
    socket.on('message', onmessage)

    localPayload.publicKey = localKeyPair.publicKey
    localPayload.relayAuth = Buffer.allocUnsafe(32)

    sodium.randombytes_buf(localPayload.relayAuth)



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

      const opts = {
        handshake: {
          tx: noise.tx,
          rx: noise.rx,
          handshakeHash: noise.handshakeHash,
          publicKey: localKeyPair.publicKey,
          remotePublicKey: publicKey
        }
      }

      return [rawSocket, opts]
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

  async immutableGet (hash, opts = {}) {
    if (Buffer.isBuffer(hash) === false) throw new Error('hash must be a buffer')
    const query = this.query(hash, 'immutable_get', null, {
      closestNodes: opts.closestNodes,
      map: mapImmutable
    })
    const check = Buffer.allocUnsafe(32)
    for await (const node of query) {
      const { value } = node
      sodium.crypto_generichash(check, value)
      if (check.equals(hash)) return node
    }
    throw Error('Not found')
  }

  async immutablePut (value, opts = {}) {
    if (Buffer.isBuffer(value) === false) throw new Error('value must be a buffer')
    if (value.length > PUT_VALUE_MAX_SIZE) {
      throw new Error(`Value size must be <= ${PUT_VALUE_MAX_SIZE}`)
    }
    const hash = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(hash, value)
    const query = this.query(hash, 'immutable_get', null, {
      closestNodes: opts.closestNodes,
      map: mapImmutable,
      commit (node, dht) {
        return dht.request(hash, 'immutable_put', value, node.from, {
          token: node.token
        })
      }
    })
    await query.finished()
    return { hash, closestNodes: query.closestNodes }
  }

  async mutableGet (publicKey, { seq = 0, latest = true, closestNodes = [] } = {}) {
    if (Buffer.isBuffer(publicKey) === false) throw new Error('publicKey must be a buffer')
    if (typeof seq !== 'number') throw new Error('seq should be a number')
    const hash = Buffer.alloc(32)
    sodium.crypto_generichash(hash, publicKey)
    const query = this.query(hash, 'mutable_get', cenc.encode(cenc.uint, seq), {
      closestNodes,
      map: mapMutable
    })
    const userSeq = seq
    let topSeq = seq
    let result = null
    for await (const node of query) {
      const { id, value, signature, seq: storedSeq, ...meta } = node
      if (storedSeq >= userSeq && PersistentNode.verifyMutable(signature, storedSeq, value, publicKey)) {
        if (latest === false) return { id, value, signature, seq: storedSeq, ...meta }
        if (storedSeq >= topSeq) {
          topSeq = storedSeq
          result = { id, value, signature, seq: storedSeq, ...meta }
        }
      }
    }
    if (!result) throw Error('Not found')
    return result
  }

  async mutablePut (keyPair, value, opts = {}) {
    if (Buffer.isBuffer(value) === false) throw new Error('value must be a buffer')
    if (value.length > PUT_VALUE_MAX_SIZE) {
      throw new Error(`Value size must be <= ${PUT_VALUE_MAX_SIZE}`)
    }

    const { seq = 0, closestNodes = [] } = opts
    if (typeof seq !== 'number') throw new Error('seq should be a number')
    const { secretKey, publicKey } = keyPair
    if (Buffer.isBuffer(publicKey) === false) throw new Error('keyPair.publicKey is required')
    if (Buffer.isBuffer(secretKey) === false) throw new Error('keyPair.secretKey is required')

    const hash = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(hash, publicKey)

    const signature = PersistentNode.signMutable(seq, value, keyPair.secretKey)

    const msg = cenc.encode(messages.mutablePutRequest, {
      value, signature, seq, publicKey
    })
    // use seq = 0, for the query part here, as we don't care about the actual values
    const query = this.query(hash, 'mutable_get', cenc.encode(cenc.uint, 0), {
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

  createServer (opts, onconnection) {
    if (typeof opts === 'function') return this.createServer({}, opts)
    if (typeof onconnection === 'function') opts = { ...opts, onconnection }
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
    this.firewall = opts.firewall || allowAll

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
    const remotePublicKey = payload.publicKey
    const relayAuth = Buffer.allocUnsafe(32)

    if (!remotePublicKey) {
      noise.destroy()
      return
    }

    // we can just use the relayauth buffer here instead of allocing a new one
    sodium.crypto_sign_ed25519_pk_to_curve25519(relayAuth, remotePublicKey)
    if (!relayAuth.equals(noise.remotePublicKey)) {
      noise.destroy()
      return
    }

    if (!payload) {
      noise.destroy()
      return
    }

    if (!payload.address.port) payload.address.port = m.relayPort

    // if the remote peer do not agree on the relay port (in case of explicit ports) - drop message
    if (payload.address.port !== m.relayPort) {
      noise.destroy()
      return
    }

    sodium.crypto_generichash(relayAuth, cenc.encode(messages.peerIPv4, payload.address), payload.relayAuth)

    // if the remote peer and relay do not agree on the address of the peer - drop message
    if (!relayAuth.equals(m.relayAuth)) {
      noise.destroy()
      return
    }

    let authenticated = false

    try {
      authenticated = !!(await this.firewall(remotePublicKey, payload))
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

    if (!localPayload) {
      noise.destroy()
      return // TODO: reply back with an error instead? (we are out of resources)
    }

    // since we are doing IK they other side already knows our noise key
    // send back the ed key, that corresponds to that for good messure like the client does
    localPayload.publicKey = this.keyPair.publicKey

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

      const opts = {
        handshake: {
          tx: noise.tx,
          rx: noise.rx,
          handshakeHash: noise.handshakeHash,
          publicKey: this.keyPair.publicKey,
          remotePublicKey: payload.publicKey
        }
      }

      const socket = new NoiseSecretStream(false, rawSocket, opts)

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

    const done = this._listening ? this._listening : Promise.resolve()

    if (!this.destroyed) done.then(() => this.emit('close'))
    this.destroyed = true

    return done
  }

  address () {
    if (!this.keyPair) {
      throw new Error('Server is not listening')
    }

    const addr = this.dht.remoteAddress()

    return {
      ...addr,
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

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}

function noop () {}

function allowAll () {
  return true
}

function mapImmutable (node) {
  if (!node.value) return null
  return {
    id: node.id,
    value: node.value,
    token: node.token,
    from: node.from,
    to: node.to
  }
}

function mapMutable (node) {
  if (!node.value) return null
  try {
    const { value, signature, seq } = cenc.decode(messages.mutableGetResponse, node.value)
    return {
      id: node.id,
      value,
      signature,
      seq,
      token: node.token,
      from: node.from,
      to: node.to
    }
  } catch {
    return null
  }
}

function mapLookup (node) {
  if (!node.value) return null
  try {
    return {
      id: node.id,
      token: node.token,
      from: node.from,
      to: node.to,
      peers: cenc.decode(messages.lookup, node.value)
    }
  } catch {
    return null
  }
}

function mapConnect (node) {
  if (!node.value) return null

  try {
    return {
      from: node.from,
      token: node.token,
      connect: cenc.decode(messages.connectRelay, node.value)
    }
  } catch {
    return null
  }
}
