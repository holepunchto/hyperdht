const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const cenc = require('compact-encoding')
const NoiseSecretStream = require('noise-secret-stream')
const dgram = require('dgram')
const Timer = require('./lib/timer')
const KATSessionStore = require('./lib/kat-session-store')
const Holepuncher = require('./lib/holepuncher')
const messages = require('./lib/messages')
const NoiseState = require('./lib/noise')

const BOOTSTRAP_NODES = [
  { host: 'testnet1.hyperdht.org', port: 49736 },
  { host: 'testnet2.hyperdht.org', port: 49736 },
  { host: 'testnet3.hyperdht.org', port: 49736 }
]

const ANNOUNCE_SELF = Buffer.from('hyperswarm_announce_self\n')
const HOLEPUNCH = Buffer.from('hyperswarm_holepunch\n')

const BAD_ADDR = new Error('Relay and remote peer does not agree on their public address')
const NOT_HOLEPUNCHABLE = new Error('Both networks are not holepunchable')
const TIMEOUT = new Error('Holepunch attempt timed out')

module.exports = class HyperDHT extends DHT {
  constructor (opts) {
    super({ bootstrap: BOOTSTRAP_NODES, ...opts })

    this.sessionStore = null
    this.clientSessions = new Set()

    this.on('request', this._ondhtrequest)
    this.on('persistent', this._ondhtpersistent)
  }

  _ondhtpersistent () {
    this.sessionStore = new KATSessionStore(7000)
  }

  _ondhtrequest (req) {
    switch (req.command) {
      case 'lookup': return this._onlookup(req)
      case 'announce': return this._onannounce(req)
      case 'announce_self': return this._onannounceself(req)
      case 'keep_alive': return this._onkeepalive(req)
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

    const s = this.sessionStore && this.sessionStore.get(req.target)

    if (!s || !req.value || !req.target) {
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
    for (const s of this.clientSessions) {
      if (s.target.equals(req.target)) { // found session
        s.onconnect(req)
        return
      }
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  async _onholepunch (req) {
    if (!req.target) return

    const s = this.sessionStore && this.sessionStore.get(req.target)

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

    req.reply(null, { token: false, closerNodes: false })
  }

  _onrelayholepunch (req) {
    if (!req.target || !req.value) return

    for (const s of this.clientSessions) {
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

    this.sessionStore.set(hash(m.publicKey), {
      expires: Date.now() + 45 * 60 * 1000,
      address: req.from
    })

    req.reply(null, { token: false })
  }

  _onkeepalive (req) {
    if (!req.value || req.value.byteLength !== 32) return
    const s = this.sessionStore.get(req.value)
    if (!s || Date.now() > s.expires || req.from.port !== s.address.port || req.from.host !== s.address.host) return
    this.sessionStore.set(req.value, s)
    req.reply(null, { token: false })
  }

  connect (publicKey, keyPair) {
    return NoiseSecretStream.async(this.connectRaw(publicKey, keyPair))
  }

  async connectRaw (publicKey, keyPair) {
    const remoteNoisePublicKey = Buffer.alloc(32)
    const noiseKeyPair = signKeyPairToNoise(keyPair)

    sodium.crypto_sign_ed25519_pk_to_curve25519(remoteNoisePublicKey, publicKey)

    const target = hash(publicKey)
    const noise = new NoiseState(noiseKeyPair, remoteNoisePublicKey)

    await this.sampledNAT()

    const addr = this.remoteAddress()
    const holepunch = new Holepuncher(addr)
    const onmessage = this.onmessage.bind(this)

    const localPayload = holepunch.bind()
    const socket = holepunch.socket

    // forward incoming messages to the dht
    socket.on('message', onmessage)

    localPayload.relayAuth = Buffer.allocUnsafe(32)

    sodium.randombytes_buf(localPayload.relayAuth)

    const value = cenc.encode(messages.connect, { noise: noise.send(localPayload), relayAuth: localPayload.relayAuth })
    let error = null

    for await (const data of this.query(target, 'connect', value, { socket })) {
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

      // [isInitiator, rawSocket, noise]
      return [true, rawSocket, noise]
    }

    socket.removeListener('message', onmessage)
    holepunch.destroy()
    noise.destroy()

    if (!error) error = new Error('Could not connect to peer')
    throw error
  }

  lookup (publicKey, opts) {
    const target = hash(publicKey)
    return this.query(target, 'lookup', null, opts)
  }

  listen (keyPair, onconnection) {
    const s = new KATSession(this, keyPair, onconnection)
    this.clientSessions.add(s)
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
    return this.dht.request(null, 'keep_alive', this.target, this.addr)
  }
}

class KATSession {
  constructor (dht, keyPair, onconnection) {
    this.target = hash(keyPair.publicKey)
    this.keyPair = keyPair
    this.noiseKeyPair = signKeyPairToNoise(keyPair)
    this.dht = dht
    this.nodes = null
    this.gateways = null
    this.destroyed = false
    this.onconnection = onconnection || noop

    this._keepAlives = null
    this._incomingHandshakes = new Set()
    this._sessions = dht.clientSessions
    this._started = null
    this._resolveUpdatedOnce = null
    this._updatedOnce = new Promise((resolve) => { this._resolveUpdatedOnce = resolve })
  }

  onconnect (req) {
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

    const addr = this.dht.remoteAddress()
    const signal = Buffer.allocUnsafe(32)
    const holepunch = new Holepuncher(addr)

    holepunch.connected().then((rawSocket) => {
      if (!rawSocket) return

      if (this.onconnection === noop) {
        rawSocket.on('error', noop)
        rawSocket.destroy()
        return
      }

      const socket = new NoiseSecretStream(false, rawSocket, noise)
      this.onconnection(socket)
    })

    holepunch.setRemoteNetwork(payload)
    const localPayload = holepunch.bind()

    // reset auth token
    sodium.randombytes_buf(relayAuth)
    localPayload.relayAuth = relayAuth

    const hs = {
      noise,
      holepunch,
      payload,
      localPayload,
      signal
    }

    this._incomingHandshakes.add(hs)

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

  destroy () {
    this._sessions.delete(this)
    this.destroyed = true
  }

  start () {
    if (this._started) return this._started
    this._started = this._updateGateways()
    return this._started
  }

  flush () {
    if (!this._started) this.start()
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
    const q = this.dht.query(this.target, 'lookup', null, { nodes: this.nodes })
    await q.finished()

    this.nodes = q.closest

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


function signKeyPairToNoise (keyPair) {
  const noiseKeys = { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(32) }
  sodium.crypto_sign_ed25519_pk_to_curve25519(noiseKeys.publicKey, keyPair.publicKey)
  sodium.crypto_sign_ed25519_sk_to_curve25519(noiseKeys.secretKey, keyPair.secretKey)
  return noiseKeys
}

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}

function noop () {}
