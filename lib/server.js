const { EventEmitter } = require('events')
const safetyCatch = require('safety-catch')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const NoiseWrap = require('./noise-wrap')
const sodium = require('sodium-universal')
const Announcer = require('./announcer')
const { FIREWALL, PROTOCOL, ERROR } = require('./constants')

const HANDSHAKE_CLEAR_WAIT = 10000

module.exports = class Server extends EventEmitter {
  constructor (dht, opts = {}) {
    super()

    this.dht = dht
    this.target = null

    this.relayAddresses = null // TODO: populate this
    this.closed = false
    this.firewall = opts.firewall || (() => false)
    this.holepunch = opts.holepunch || (() => true)
    this.handshake = opts.handshake || ((keyPair) => new NoiseWrap(keyPair, null))

    this._protocols = PROTOCOL.TCP | PROTOCOL.UTP
    this._shareLocalAddress = opts.shareLocalAddress !== false
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

  onrawconnection (rawSocket) {
    this.emit('rawConnection', rawSocket)
  }

  address () {
    if (!this._keyPair) return null

    return {
      publicKey: this._keyPair.publicKey,
      host: this.dht.host,
      port: this.dht.port
    }
  }

  close () {
    if (this._closing) return this._closing
    this._closing = this._close()
    return this._closing
  }

  async _close () {
    this.closed = true

    if (!this._announcer) return

    this.dht.listening.delete(this)
    this.dht._router.delete(this._announcer.target)

    while (this._holepunches.length > 0) {
      const h = this._holepunches.pop()
      if (h && h.pair) h.pair.destroy()
      if (h && h.clearing) clearTimeout(h.clearing)
    }

    this._connects.clear()

    await this._announcer.stop()
    this._announcer = null

    this.emit('close')
  }

  async listen (keyPair = this.dht.defaultKeyPair) {
    if (this._announcer) throw new Error('Already listening')
    if (this.dht.destroyed) throw new Error('Node destroyed')

    this.target = hash(keyPair.publicKey)

    this._keyPair = keyPair
    this._announcer = new Announcer(this.dht, this._keyPair, this.target)

    this.dht._router.set(this.target, {
      relay: null,
      record: this._announcer.record,
      onpeerhandshake: this._onpeerhandshake.bind(this),
      onpeerholepunch: this._onpeerholepunch.bind(this)
    })

    try {
      await this._announcer.start()
    } catch (err) {
      await this._announcer.stop()
      this._announcer = null
      throw err
    }

    if (this.dht.destroyed) throw new Error('Node destroyed')

    this.dht.listening.add(this)
    this.emit('listening')
  }

  async _addHandshake (k, noise, clientAddress, req) {
    const handshake = this.handshake(this._keyPair)
    // TODO: verify that this isn't a flooding vector
    const remotePayload = await handshake.recv(noise)
    const serverAddress = req.to

    if (!remotePayload) return null

    let id = this._holepunches.indexOf(null)
    if (id === -1) id = this._holepunches.push(null) - 1

    const fw = this.firewall(handshake.remotePublicKey, remotePayload, clientAddress)

    const hs = {
      round: 0,
      reply: null,
      pair: null,
      protocols: remotePayload.protocols & this._protocols,
      firewalled: (!fw || !fw.then) ? Promise.resolve(fw) : fw.catch(toTrue),
      clearing: null
    }

    this._connects.set(k, hs)
    this._holepunches[id] = hs

    if (await hs.firewalled) {
      this._clearLater(hs, id, k)
      return null
    }
    if (this.closed) {
      return null
    }

    const error = remotePayload.version === 1
      ? hs.protocols === 0 ? ERROR.ABORTED : ERROR.NONE
      : ERROR.VERSION_MISMATCH

    const addresses = []
    const ourLocalAddr = this._shareLocalAddress ? this.dht._sockets.localServerAddress() : null
    const ourRemoteAddr = this.dht._sockets.remoteServerAddress()

    if (ourRemoteAddr) addresses.push(ourRemoteAddr)
    if (ourLocalAddr) addresses.push(ourLocalAddr) // for now always share local addrs, in the future we can do some filtering

    hs.reply = await handshake.send({
      error,
      firewall: this.dht.firewalled ? FIREWALL.UNKNOWN : FIREWALL.OPEN,
      protocols: this._protocols,
      holepunch: this.dht.firewalled ? { id, relays: this._announcer.relays } : null,
      addresses: addresses.length ? addresses : null
    })

    const h = await handshake.final()

    if (error !== ERROR.NONE) {
      // TODO: strictly better to clear it later for caching, but whatevs, this is easy
      this._clearLater(hs, id, k)
      return hs
    }

    const pair = hs.pair = this.dht._sockets.pair(h)

    pair.remoteFirewall = remotePayload.firewall

    pair.onconnection = (rawSocket, data, ended, handshake) => {
      this._clearLater(hs, id, k)

      if (handshake.hash) {
        this.onconnection(new NoiseSecretStream(false, rawSocket, {
          handshake,
          data,
          ended
        }))
      } else {
        this.onrawconnection(rawSocket, data, ended)
      }
    }

    pair.ondestroy = () => {
      this._clearLater(hs, id, k)
    }

    if (pair.connect(remotePayload.addresses, clientAddress, serverAddress)) {
      return hs
    }

    pair.open()
    return hs
  }

  _clearLater (hs, id, k) {
    if (hs.clearing) return
    hs.clearing = setTimeout(() => this._clear(hs, id, k), HANDSHAKE_CLEAR_WAIT)
  }

  _clear (hs, id, k) {
    if (id >= this._holepunches.length || this._holepunches[id] !== hs) return

    this._holepunches[id] = null
    while (this._holepunches.length > 0 && this._holepunches[this._holepunches.length - 1] === null) {
      this._holepunches.pop()
    }
    this._connects.delete(k)
  }

  async _onpeerhandshake ({ noise, peerAddress }, req) {
    const k = noise.toString('hex')
    let h = this._connects.get(k)

    if (!h) {
      h = await this._addHandshake(k, noise, peerAddress, req)
      if (!h) return null
    }

    if (await h.firewalled) return null
    if (this.closed) return null

    return { socket: h.pair && h.pair.socket, noise: h.reply }
  }

  async _onpeerholepunch ({ id, peerAddress, payload }, req) {
    const h = id < this._holepunches.length ? this._holepunches[id] : null
    if (!h) return null

    if (await h.firewalled) return null
    if (this.closed) return null

    const p = h.pair
    if (!p.socket) return this._abort(h) // not opened

    const remotePayload = p.payload.decrypt(payload)
    if (!remotePayload) return null

    const isServerRelay = this._announcer.isRelay(req.from)
    const { error, firewall, round, punching, addresses, remoteAddress, remoteToken } = remotePayload

    if (error !== ERROR.NONE) {
      // We actually do not need to set the round here, but just do it for consistency.
      if (round >= h.round) h.round = round
      return this._abort(h)
    }

    const token = p.payload.token(peerAddress)
    const echoed = isServerRelay && !!remoteToken && token.equals(remoteToken)

    // Update our heuristics here
    if (req.socket === p.socket) {
      p.nat.add(req.to, req.from)
    }

    if (round >= h.round) {
      h.round = round
      p.updateRemote({ punching, firewall, addresses, verified: echoed ? peerAddress.host : null })
    }

    // Wait for the analyzer to reach a conclusion...
    await p.nat.analyzing
    if (p.destroyed) return null

    if (!p.remoteHolepunching && p.unstable()) {
      const reopened = await p.reopen()
      if (p.destroyed) return null
      if (!reopened) return this._abort(h)
    }

    // Fast mode! If we are consistent and the remote has opened a session to us (remoteAddress)
    // then fire a quick punch back. Note the await here just waits for the udp socket to flush.
    if (isConsistent(p.nat.firewall) && remoteAddress && hasSameAddr(p.nat.addresses, remoteAddress)) {
      await p.ping(peerAddress)
      if (p.destroyed) return null
    }

    // Remote said they are punching (or willing to), so we will punch as well.
    // Note that this returns when the punching has STARTED, so no guarantee
    // we will have a connection after this promise etc.
    if (p.remoteHolepunching) {
      // TODO: still continue here if a local connection might work, but then do not holepunch...
      if (!this.holepunch(p.remoteFirewall, p.nat.firewall, p.remoteAddresses, p.nat.addresses)) {
        return p.destroyed ? null : this._abort(h)
      }

      const punching = await p.punch()
      if (p.destroyed) return null
      if (!punching) return this._abort(h)
    }

    // Freeze that analysis as soon as we have a result we are giving to the other peer
    if (p.nat.firewall !== FIREWALL.UNKNOWN) {
      p.nat.freeze()
    }

    return {
      socket: p.socket,
      payload: p.payload.encrypt({
        error: ERROR.NONE,
        firewall: p.nat.firewall,
        round: h.round,
        connected: p.connected,
        punching: p.punching,
        addresses: p.nat.addresses,
        remoteAddress: null,
        token: isServerRelay ? token : null,
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
      round: h.round,
      connected: false,
      punching: false,
      addresses: null,
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

function hasSameAddr (addrs, other) {
  for (const addr of addrs) {
    if (addr.port === other.port && addr.host === other.host) return true
  }
  return false
}

function toTrue (err) {
  safetyCatch(err)
  return true
}
