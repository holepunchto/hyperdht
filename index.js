const { EventEmitter } = require('events')
const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const cenc = require('compact-encoding')
const NoiseSecretStream = require('noise-secret-stream')
const Timer = require('./lib/timer')
const Cache = require('xache')
const Holepuncher = require('./lib/holepuncher')
const messages = require('./lib/messages')
const NoiseState = require('./lib/noise')

const BOOTSTRAP_NODES = [
  { host: 'testnet1.hyperdht.org', port: 49736 },
  { host: 'testnet2.hyperdht.org', port: 49736 },
  { host: 'testnet3.hyperdht.org', port: 49736 }
]

const SERVER_TIMEOUT = 20000
const CLIENT_TIMEOUT = 25000

const ANNOUNCE_SELF = Buffer.from('hyperswarm_announce_self\n')
const HOLEPUNCH = Buffer.from('hyperswarm_holepunch\n')

const BAD_ADDR = new Error('Relay and remote peer does not agree on their public address')
const NOT_HOLEPUNCHABLE = new Error('Both networks are not holepunchable')
const TIMEOUT = new Error('Holepunch attempt timed out')

module.exports = class HyperDHT extends DHT {
  constructor (opts) {
    super({ bootstrap: BOOTSTRAP_NODES, ...opts })

    this.cache = null
    this.defaultClientKeyPair = opts.keyPair || HyperDHT.keyPair(opts.seed)
    this.servers = new Set()

    this.on('request', this._ondhtrequest)
    this.on('persistent', this._ondhtpersistent)
  }

  destroy () {
    if (this.cache !== null) this.cache.destroy()
    super.destroy()
  }

  _ondhtpersistent () {
    this.cache = new Cache({ maxSize: 65536, maxAge: 45 * 60 * 1000 })
  }

  _ondhtrequest (req) {
    switch (req.command) {
      case 'lookup': return this._onlookup(req)
      case 'announce': return this._onannounce(req)
      case 'announce_self': return this._onannounceself(req)
      case 'connect': return this._onconnect(req)
      case 'relay_connect': return this._onrelayconnect(req)
      case 'holepunch': return this._onholepunch(req)
      case 'relay_holepunch': return this._onrelayholepunch(req)
    }

    /*
      mutable_get
      mutable_put
      immutable_get
      immutable_put

      lookup
      announce
      announce_self / session
      keep_alive <-- badly named
    */

    req.error(DHT.UNKNOWN_COMMAND)
  }

  _onlookup (req) {
    console.log('onlookup')
    req.reply(null)
  }

  _onannounce (req) {
    console.log('onann')
  }

  async _onconnect (req) {
    if (!req.target) return

    const s = this._getAnnounceSelf(req.target)

    if (!s || !req.value) {
      req.reply(null, { token: false })
      return
    }

    let value = null

    try {
      const m = cenc.decode(messages.connect, req.value)

      sodium.crypto_generichash(m.relayAuth, cenc.encode(messages.peerIPv4, req.from), m.relayAuth)
      value = cenc.encode(messages.connectRelay, { noise: m.noise, relayPort: req.from.port, relayAuth: m.relayAuth })
    } catch {
      return
    }

    try {
      const res = await this.request(req.target, 'relay_connect', value, s.address, { retry: false })
      const m = cenc.decode(messages.connect, res.value)
      const relay = { host: s.address.host, port: res.from.port }

      sodium.crypto_generichash(m.relayAuth, cenc.encode(messages.peerIPv4, relay), m.relayAuth)
      value = cenc.encode(messages.connectRelay, { noise: m.noise, relayPort: relay.port, relayAuth: m.relayAuth })
    } catch {
      return
    }

    req.reply(value, { token: true, closerNodes: false })
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

  async _onholepunch (req) {
    if (!req.target) return

    const s = this._getAnnounceSelf(req.target)

    if (!s || !req.value || !req.token) {
      req.reply(null, { token: false })
      return
    }

    let res = null

    try {
      res = await this.request(req.target, 'relay_holepunch', req.value, s.address, { retry: false })
    } catch {
      return
    }

    req.reply(res.value, { token: false, closerNodes: false })
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

  _onannounceself (req) {
    if (!this.id || !req.value || !req.token) return

    let m = null
    try {
      m = cenc.decode(messages.announceSelf, req.value)
    } catch {
      return
    }

    const out = Buffer.allocUnsafe(32)
    sodium.crypto_generichash_batch(out, [ANNOUNCE_SELF, this.id, req.token])

    if (!sodium.crypto_sign_verify_detached(m.signature, out, m.publicKey)) {
      return
    }

    this._setAnnounceSelf(hash(m.publicKey), {
      expires: Date.now() + 45 * 60 * 1000,
      address: req.from
    })

    req.reply(null, { token: false })
  }

  _setAnnounceSelf (target, data) {
    this.cache.set('announce_self/' + target.toString('hex'), data)
  }

  _getAnnounceSelf (target) {
    const s = this.cache && this.cache.get('announce_self/' + target.toString('hex'))
    if (!s || s.expires < Date.now()) return null
    return s
  }

  connect (publicKey, keyPair) {
    return NoiseSecretStream.async(this.connectRaw(publicKey, keyPair))
  }

  async connectRaw (publicKey, keyPair = this.defaultClientKeyPair) {
    const remoteNoisePublicKey = Buffer.alloc(32)
    const noiseKeyPair = NoiseState.ed25519toCurve25519(keyPair)

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
    const query = this.query(target, 'connect', value, { socket })

    let error = null

    for await (const data of query) {
      if (!data.value) continue

      let m = null
      try {
        m = cenc.decode(messages.connectRelay, data.value)
      } catch {
        continue
      }

      const payload = noise.recv(m.noise, false)
      if (!payload) continue
      if (!payload.address.port) payload.address.port = m.relayPort

      const relayAuth = Buffer.allocUnsafe(32)
      sodium.crypto_generichash(relayAuth, cenc.encode(messages.peerIPv4, payload.address), payload.relayAuth)
      holepunch.setRemoteNetwork(payload)

      if (!relayAuth.equals(m.relayAuth) || payload.address.port !== m.relayPort) {
        error = BAD_ADDR
        break
      }

      if (!holepunch.holepunchable) {
        error = NOT_HOLEPUNCHABLE
        break
      }

      sodium.crypto_generichash_batch(relayAuth, [HOLEPUNCH, payload.relayAuth], noise.handshakeHash)

      await holepunch.openSessions()

      try {
        await this.request(target, 'holepunch', relayAuth, data.from, { socket, token: data.token })
      } catch {
        break
      }

      socket.removeListener('message', onmessage)

      await holepunch.holepunch()
      const rawSocket = await holepunch.connected()

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

  lookup (publicKey, opts) {
    const target = hash(publicKey)
    return this.query(target, 'lookup', null, opts)
  }

  createServer (opts) {
    if (typeof opts === 'function') opts = { onconnection: opts }
    const s = new KATServer(this, opts)
    this.servers.add(s)
    return s
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
    this.expires = Date.now() + 30 * 60 * 1000
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
    this.gateways = null
    this.destroyed = false
    this.onauthenticate = opts.onauthentiate || allowAll
    if (opts.onconnection) this.on('connection', opts.onconnection)

    this._keepAlives = null
    this._incomingHandshakes = new Set()
    this._servers = dht.servers
    this._listening = null
    this._resolveUpdatedOnce = null
    this._updatedOnce = new Promise((resolve) => { this._resolveUpdatedOnce = resolve })
    this._interval = setTimeout(this.gc.bind(this), 5000)

    this._updatedOnce.then(() => {
      if (!this.destroyed) this.emit('listening')
    })
  }

  gc () {
    const now = Date.now()
    for (const hs of this._incomingHandshakes) {
      if (hs.added + SERVER_TIMEOUT < now) continue
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
    holepunch.connected().then((rawSocket) => {
      this._incomingHandshakes.delete(hs)
      if (!rawSocket) return

      const socket = new NoiseSecretStream(false, rawSocket, noise)

      if (!this.emit('connection', socket)) {
        socket.on('error', noop)
        socket.destroy()
        return
      }
    })

    const noisePayload = noise.send(hs.localPayload)
    sodium.crypto_generichash_batch(signal, [HOLEPUNCH, relayAuth], noise.handshakeHash)

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
    clearInterval(this._interval)

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

  listen (keyPair) {
    if (this.keyPair) {
      throw new Error('Server is already listening on a keyPair')
    }

    this.target = hash(keyPair.publicKey)
    this.keyPair = keyPair
    this.noiseKeyPair = NoiseState.ed25519toCurve25519(keyPair)

    if (!this._listening) this._listening = this._updateGateways()
    return this._updatedOnce
  }

  async _updateGateways () {
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

      for (const g of this.gateways) {
        const k = new KeepAliveTimer(this.dht, this.target, g)
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

    this.closestNodes = q.closest

    const promises = []

    for (const gateway of q.closest.slice(0, 3)) {
      const m = {
        publicKey: this.keyPair.publicKey,
        signature: Buffer.allocUnsafe(64)
      }

      const out = Buffer.allocUnsafe(32)
      sodium.crypto_generichash_batch(out, [ANNOUNCE_SELF, gateway.id, gateway.token])
      sodium.crypto_sign_detached(m.signature, out, this.keyPair.secretKey)

      promises.push(this.dht.request(null, 'announce_self', cenc.encode(messages.announceSelf, m), gateway))
    }

    const gateways = []
    for (const p of promises) {
      try {
        gateways.push((await p).from)
      } catch {
        continue
      }
    }

    if (!gateways.length) throw new Error('All gateway requests failed')

    this.gateways = gateways
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
