const { EventEmitter } = require('events')
const safetyCatch = require('safety-catch')
const NoiseSecretStream = require('noise-secret-stream')
const NoiseWrap = require('./noise-wrap')
const sodium = require('sodium-universal')
const Announcer = require('./announcer')
const { FIREWALL, PROTOCOL, ERROR } = require('./constants')

module.exports = class Server extends EventEmitter {
  constructor (dht, opts = {}) {
    super()

    this.dht = dht

    this.closed = false
    this.firewall = opts.firewall || (() => false)
    this.holepunch = opts.holepunch || (() => true)

    this._protocols = PROTOCOL.TCP | PROTOCOL.UTP
    this._keyPair = null
    this._announcer = null
    this._connects = new Map()
    this._holepunches = []
    this._closing = null
  }

  get publicKey () {
    return this._keyPair && this._keyPair.publicKey
  }

  onconnection (encryptedSocket) {
    this.emit('connection', encryptedSocket)
  }

  close () {
    if (this._closing) return this._closing
    this._closing = this._close()
    return this._closing
  }

  async _close () {
    this.closed = true

    if (!this._announcer) return Promise.resolve()
    this.dht._router.delete(this._announcer.target)

    while (this._holepunches.length > 0) {
      const h = this._holepunches.pop()
      if (h && h.pair) h.pair.destroy()
    }

    this._connects.clear()

    await this._announcer.stop()
    this._announcer = null

    this.emit('close')
  }

  listen (keyPair = this.dht.defaultKeyPair) {
    if (this._announcer) return Promise.reject(new Error('Already listening'))

    const target = hash(keyPair.publicKey)

    this._keyPair = keyPair
    this._announcer = new Announcer(this.dht, this._keyPair, target)

    this.dht._router.set(target, {
      relay: null,
      onconnect: this._onconnect.bind(this),
      onholepunch: this._onholepunch.bind(this)
    })

    return this._announcer.start()
  }

  async _addHandshake (k, noise, peerAddress) {
    const handshake = new NoiseWrap(this._keyPair, null)
    const remotePayload = handshake.recv(noise)

    if (!remotePayload) return null

    let id = this._holepunches.indexOf(null)
    if (id === -1) id = this._holepunches.push(null) - 1

    const fw = this.firewall(handshake.remotePublicKey, remotePayload, peerAddress)

    const hs = {
      reply: null,
      pair: null,
      protocols: remotePayload.protocols & this._protocols,
      firewalled: (!fw || !fw.then) ? Promise.resolve(fw) : fw.catch(toTrue)
    }

    this._connects.set(k, hs)
    this._holepunches[id] = hs

    if (await hs.firewalled) {
      this._clear(id, k)
      return null
    }
    if (this.closed) {
      return null
    }

    const error = remotePayload.version === 1
      ? hs.protocols === 0 ? ERROR.ABORTED : ERROR.NONE
      : ERROR.VERSION_MISMATCH

    hs.reply = handshake.send({
      error,
      firewall: this.dht.firewalled ? FIREWALL.UNKNOWN : FIREWALL.OPEN,
      protocols: this._protocols,
      holepunch: this.dht.firewalled ? { id, relays: this._announcer.relays } : null
    })

    const h = handshake.final()

    if (error !== ERROR.NONE) {
      // TODO: strictly better to clear it later for caching, but whatevs, this is easy
      this._clear(hs, id, k)
      return hs
    }

    const pair = hs.pair = this.dht._sockets.pair(h)

    pair.onconnection = (rawSocket, data, ended, handshake) => {
      this._clear(hs, id, k)

      const encryptedSocket = new NoiseSecretStream(false, rawSocket, {
        handshake,
        data,
        ended
      })

      this.onconnection(encryptedSocket)
    }

    pair.ondestroy = () => {
      this._clear(hs, id, k)
    }

    if (!this.dht.firewalled) {
      return hs
    }

    if (remotePayload.firewall === FIREWALL.OPEN) {
      // TODO: like in the client, pass forward which protocol to use etc etc
      pair.connect(remotePayload.address || peerAddress)
      return hs
    }

    pair.open()
    return hs
  }

  _clear (hs, id, k) {
    if (id >= this._holepunches.length || this._holepunches[id] !== hs) return

    this._holepunches[id] = null
    while (this._holepunches.length > 0 && this._holepunches[this._holepunches.length - 1] === null) {
      this._holepunches.pop()
    }
    this._connects.delete(k)
  }

  async _onconnect ({ noise, peerAddress }) {
    const k = noise.toString('hex')
    let h = this._connects.get(k)

    if (!h) {
      h = await this._addHandshake(k, noise, peerAddress)
      if (!h) return null
    }

    if (await h.firewalled) return null
    if (this.closed) return null

    return { socket: h.pair && h.pair.socket, noise: h.reply }
  }

  async _onholepunch ({ id, peerAddress, payload }, req) {
    const h = id < this._holepunches.length ? this._holepunches[id] : null
    if (!h) return null

    if (await h.firewalled) return null
    if (this.closed) return null

    const p = h.pair
    if (!p.socket) return this._abort(h) // not opened

    const remotePayload = p.payload.decrypt(payload)
    if (!remotePayload) return null

    const isServerRelay = this._announcer.isRelay(req.from)
    const { error, firewall, punching, address, remoteAddress, remoteToken } = remotePayload

    if (error !== ERROR.NONE) return this._abort(h)

    const token = p.payload.token(peerAddress)
    const echoed = isServerRelay && !!remoteToken && token.equals(remoteToken)

    // Update our heuristics here
    if (req.socket === p.socket) {
      p.nat.add(req.to, req.from)
    }
    // Allow the client to set this once during probe and once during punch phase...
    if ((p.remoteFirewall === FIREWALL.UNKNOWN || punching) && firewall !== FIREWALL.UNKNOWN && address) {
      p.remoteFirewall = firewall
      p.remoteAddress = address
    }
    if (echoed && p.remoteAddress && p.remoteAddress.host === peerAddress.host) {
      p.remoteVerified = true
    }
    if (punching) {
      p.remoteHolepunching = true
    }

    // Wait for the analyzer to reach a conclusion...
    await p.nat.analyzing
    if (p.destroyed) return null

    // Bail if non-holepunchable and we cannot recover from that...
    if (!punching && p.remoteFirewall >= FIREWALL.RANDOM && p.nat.firewall >= FIREWALL.RANDOM) {
      if (!(await p.reopen())) {
        return p.destroyed ? null : this._abort(h)
      }
    }

    // Fast mode! If we are consistent and the remote has opened a session to us (remoteAddress)
    // then fire a quick punch back. Note the await here just waits for the udp socket to flush.
    if (isConsistent(p.nat.firewall) && remoteAddress && sameAddr(p.nat.address, remoteAddress)) {
      await p.ping(peerAddress)
      if (p.destroyed) return null
    }

    // Remote said they are punching (or willing to), and we have verified their IP so we will
    // punch as well. Note that this returns when the punching has STARTED, so we no guarantee
    // we will have a connection after this promise etc.
    if (p.remoteHolepunching && p.remoteVerified) {
      // TODO: still continue here if a local connection might work, but then do not holepunch...
      if (!this.holepunch(p.remoteFirewall, p.nat.firewall, p.remoteAddress, p.address)) {
        return p.destroyed ? null : this._abort(h)
      }

      await p.punch()
      if (p.destroyed) return null
    }

    return {
      socket: p.socket,
      payload: p.payload.encrypt({
        error: ERROR.NONE,
        firewall: p.nat.firewall,
        punching: p.punching,
        address: p.nat.address,
        remoteAddress: null,
        token: (isServerRelay && !p.remoteVerified) ? token : null,
        remoteToken: remotePayload.token
      })
    }
  }

  _abort (h) {
    if (!h.pair.payload) {
      h.pair.destroy()
      return null
    }

    const payload = h.pair.payload.encrypt({
      error: ERROR.ABORTED,
      firewall: FIREWALL.UNKNOWN,
      punching: false,
      address: null,
      remoteAddress: null,
      token: null,
      remoteToken: null
    })

    h.pair.destroy()

    return { socket: this.dht.socket, payload }
  }
}

function isConsistent (fw) {
  return fw === FIREWALL.OPEN || fw === FIREWALL.CONSISTENT
}

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}

function sameAddr (a, b) {
  return a.host === b.host && a.port === b.port
}

function toTrue (err) {
  safetyCatch(err)
  return true
}
