const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const cenc = require('compact-encoding')
const dgram = require('dgram')
const Timer = require('./timer')
const KATSessionStore = require('./kat-session-store')
const messages = require('./messages')
const NoiseState = require('./noise')

const KAT_SESSION = Buffer.from('kat_session\n')
const KAT_HOLEPUNCH = Buffer.from('kat_holepunch\n')

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
    return this.dht.request(null, 'kat_keep_alive', this.target, this.addr)
  }
}

class KATSession {
  constructor (kat, keyPair) {
    this.target = hash(keyPair.publicKey)
    this.keyPair = keyPair
    this.noiseKeyPair = signKeyPairToNoise(keyPair)
    this.dht = kat.dht
    this.nodes = null
    this.gateways = null
    this.destroyed = false

    this._keepAlives = null
    this._incomingHandshakes = new Set()
    this._sessions = kat.clientSessions
    this._started = null
    this._resolveUpdatedOnce = null
    this._updatedOnce = new Promise((resolve) => { this._resolveUpdatedOnce = resolve })
  }

  onconnect (req) {
    let m = null
    try {
      m = cenc.decode(messages.katConnectRelay, req.value)
    } catch {
      return
    }

    for (const hs of this._incomingHandshakes) {
      if (hs.noise.request.equals(m.noise)) {
        const value = cenc.encode(messages.katConnect, { noise: hs.noise.response, relayAuth: hs.localPayload.relayAuth })
        req.reply(value, { token: false, closerNodes: false, socket: hs.socket })
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
    const socket = dgram.createSocket('udp4')
    const signal = Buffer.allocUnsafe(32)

    // reset auth token
    sodium.randombytes_buf(relayAuth)

    const localPayload = {
      firewall: addr.type,
      address: { host: addr.host, port: 0 },
      localAddresses: [],
      relayAuth
    }

    const hs = {
      noise,
      socket,
      payload,
      localPayload,
      signal
    }

    this._incomingHandshakes.add(hs)

    const noisePayload = noise.send(hs.localPayload)
    sodium.crypto_generichash_batch(signal, [KAT_HOLEPUNCH, relayAuth], noise.handshakeHash)

    req.reply(cenc.encode(messages.katConnect, { noise: noisePayload, relayAuth }), { token: false, closerNodes: false, socket: hs.socket })
  }

  onholepunch (req) {
    for (const hs of this._incomingHandshakes) {
      if (hs.signal.equals(req.value)) {
        console.log('server ready to holepunch', hs.payload, hs.localPayload)
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
    const q = this.dht.query(this.target, 'kat_lookup', null, { nodes: this.nodes })
    await q.finished()

    this.nodes = q.closest

    const promises = []

    for (const gateway of q.closest.slice(0, 3)) {
      const m = {
        publicKey: this.keyPair.publicKey,
        signature: Buffer.allocUnsafe(64)
      }

      const out = Buffer.allocUnsafe(32)
      sodium.crypto_generichash_batch(out, [KAT_SESSION, gateway.id, gateway.token])
      sodium.crypto_sign_detached(m.signature, out, this.keyPair.secretKey)

      promises.push(this.dht.request(null, 'kat_session', cenc.encode(messages.katSession, m), gateway))
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

module.exports = class KAT {
  constructor (dht) {
    this.dht = dht
    this.sessionStore = null
    this.clientSessions = new Set()
  }

  onpersistent () {
    this.sessionStore = new KATSessionStore(7000)
  }

  onlookup (req) {
    console.log('onlookup')
    req.reply(null)
  }

  onannounce (req) {
    console.log('onann')
  }

  async onconnect (req) {
    if (!req.target) return

    const s = this.sessionStore && this.sessionStore.get(req.target)

    if (!s || !req.value || !req.target) {
      req.reply(null, { token: false })
      return
    }

    let value = null

    try {
      const m = cenc.decode(messages.katConnect, req.value)

      sodium.crypto_generichash(m.relayAuth, cenc.encode(messages.peerIPv4, req.from), m.relayAuth)
      value = cenc.encode(messages.katConnectRelay, { noise: m.noise, relayPort: req.from.port, relayAuth: m.relayAuth })
    } catch {
      return
    }

    try {
      const res = await this.dht.request(req.target, 'kat_relay_connect', value, s.address, { retry: false })
      const m = cenc.decode(messages.katConnect, res.value)
      const relay = { host: s.address.host, port: res.from.port }

      sodium.crypto_generichash(m.relayAuth, cenc.encode(messages.peerIPv4, relay), m.relayAuth)
      value = cenc.encode(messages.katConnectRelay, { noise: m.noise, relayPort: relay.port, relayAuth: m.relayAuth })
    } catch {
      return
    }


    req.reply(value, { token: true, closerNodes: false })
  }

  onrelayconnect (req) {
    for (const s of this.clientSessions) {
      if (s.target.equals(req.target)) { // found session
        s.onconnect(req)
        return
      }
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  async onholepunch (req) {
    if (!req.target) return

    const s = this.sessionStore && this.sessionStore.get(req.target)

    if (!s || !req.value || !req.token) {
      req.reply(null, { token: false })
      return
    }

    let res = null

    try {
      res = await this.dht.request(req.target, 'kat_relay_holepunch', req.value, s.address, { retry: false })
    } catch {
      return
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  onrelayholepunch (req) {
    if (!req.target || !req.value) return

    for (const s of this.clientSessions) {
      if (s.target.equals(req.target)) {
        s.onholepunch(req)
        return
      }
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  onsession (req) {
    if (!this.dht.id || !req.value || !req.token) return

    let m = null
    try {
      m = cenc.decode(messages.katSession, req.value)
    } catch {
      return
    }

    const out = Buffer.allocUnsafe(32)
    sodium.crypto_generichash_batch(out, [KAT_SESSION, this.dht.id, req.token])

    if (!sodium.crypto_sign_verify_detached(m.signature, out, m.publicKey)) {
      return
    }

    this.sessionStore.set(hash(m.publicKey), {
      expires: Date.now() + 45 * 60 * 1000,
      address: req.from
    })

    req.reply(null, { token: false })
  }

  onkeepalive (req) {
    if (!req.value || req.value.byteLength !== 32) return
    const s = this.sessionStore.get(req.value)
    if (!s || Date.now() > s.expires || req.from.port !== s.address.port || req.from.host !== s.address.host) return
    this.sessionStore.set(req.value, s)
    req.reply(null, { token: false })
  }

  async connect (publicKey, keyPair, opts) {
    const remoteNoisePublicKey = Buffer.alloc(32)
    const noiseKeyPair = signKeyPairToNoise(keyPair)

    sodium.crypto_sign_ed25519_pk_to_curve25519(remoteNoisePublicKey, publicKey)

    const target = hash(publicKey)
    const noise = new NoiseState(noiseKeyPair, remoteNoisePublicKey)

    // TODO: wait for the firewall heurtistic to populate first
    // which is much faster than waiting for full bootstrap
    await this.dht.ready()

    const addr = this.dht.remoteAddress()

    const socket = dgram.createSocket('udp4')
    const onmessage = this.dht.onmessage.bind(this.dht)

    // forward incoming messages to the dht
    socket.on('message', onmessage)

    const localPayload = {
      firewall: addr.type,
      address: { host: addr.host, port: 0 },
      localAddresses: [],
      relayAuth: Buffer.allocUnsafe(32)
    }

    sodium.randombytes_buf(localPayload.relayAuth)

    const value = cenc.encode(messages.katConnect, { noise: noise.send(localPayload), relayAuth: localPayload.relayAuth })

    for await (const data of this.dht.query(target, 'kat_connect', value, { socket })) {
      if (!data.value) continue

      let m = null
      try {
        m = cenc.decode(messages.katConnectRelay, data.value)
      } catch {
        continue
      }

      const payload = noise.recv(m.noise, false)
      if (!payload) continue

      if (!payload.address.port) payload.address.port = m.relayPort

      if (payload.address.port !== m.relayPort) {
        throw new Error('Relay and remote peer does not agree on their public address')
      }

      const relayAuth = Buffer.allocUnsafe(32)
      sodium.crypto_generichash(relayAuth, cenc.encode(messages.peerIPv4, payload.address), payload.relayAuth)

      if (!relayAuth.equals(m.relayAuth)) {
        throw new Error('Relay and remote peer does not agree on their public address')
      }

      sodium.crypto_generichash_batch(relayAuth, [KAT_HOLEPUNCH, payload.relayAuth], noise.handshakeHash)

      await this.dht.request(target, 'kat_holepunch', relayAuth, data.from, { socket, token: data.token })

      socket.removeListener('message', onmessage)

      console.log('-->', localPayload, payload, socket.address())
      return
    }

    noise.destroy()
  }

  lookup (publicKey, opts) {
    const target = hash(publicKey)
    return this.dht.query(target, 'kat_lookup', null, opts)
  }

  listen (keyPair) {
    const s = new KATSession(this, keyPair)
    this.clientSessions.add(s)
    return s
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
