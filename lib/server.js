const { EventEmitter } = require('events')
const safetyCatch = require('safety-catch')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const b4a = require('b4a')
const NoiseWrap = require('./noise-wrap')
const Announcer = require('./announcer')
const { FIREWALL, ERROR } = require('./constants')
const { hash } = require('./crypto')
const SecurePayload = require('./secure-payload')
const Holepuncher = require('./holepuncher')
const DebuggingStream = require('debugging-stream')
const { isPrivate } = require('bogon')
const { ALREADY_LISTENING, NODE_DESTROYED } = require('./errors')

const HANDSHAKE_CLEAR_WAIT = 10000
const HANDSHAKE_INITIAL_TIMEOUT = 10000

module.exports = class Server extends EventEmitter {
  constructor (dht, opts = {}) {
    super()

    this.dht = dht
    this.target = null

    this.relayAddresses = null // TODO: populate this
    this.closed = false
    this.firewall = opts.firewall || (() => false)
    this.holepunch = opts.holepunch || (() => true)
    this.createHandshake = opts.createHandshake || defaultCreateHandshake
    this.createSecretStream = opts.createSecretStream || defaultCreateSecretStream

    this._shareLocalAddress = opts.shareLocalAddress !== false
    this._reusableSocket = !!opts.reusableSocket
    this._keyPair = null
    this._announcer = null
    this._connects = new Map()
    this._holepunches = []
    this._listening = false
    this._closing = null
  }

  get publicKey () {
    return this._keyPair && this._keyPair.publicKey
  }

  onconnection (encryptedSocket) {
    this.emit('connection', encryptedSocket)
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

    if (!this._listening) return

    this.dht.listening.delete(this)
    this.dht._router.delete(this.target)

    while (this._holepunches.length > 0) {
      const h = this._holepunches.pop()
      if (h && h.puncher) h.puncher.destroy()
      if (h && h.clearing) clearTimeout(h.clearing)
      if (h && h.prepunching) clearTimeout(h.prepunching)
    }

    this._connects.clear()

    await this._announcer.stop()
    this._announcer = null

    this.emit('close')
  }

  async listen (keyPair = this.dht.defaultKeyPair, opts = {}) {
    if (this._listening) throw ALREADY_LISTENING()
    if (this.dht.destroyed) throw NODE_DESTROYED()

    this.target = hash(keyPair.publicKey)

    this._keyPair = keyPair
    this._announcer = new Announcer(this.dht, keyPair, this.target, opts)

    this.dht._router.set(this.target, {
      relay: null,
      record: this._announcer.record,
      onpeerhandshake: this._onpeerhandshake.bind(this),
      onpeerholepunch: this._onpeerholepunch.bind(this)
    })

    this._listening = true

    try {
      await this._announcer.start()
    } catch (err) {
      await this._announcer.stop()
      this._announcer = null
      this._listening = false
      throw err
    }

    if (this.dht.destroyed) throw NODE_DESTROYED()

    this.dht.listening.add(this)
    this.emit('listening')

    return this
  }

  refresh () {
    if (this._announcer) this._announcer.refresh()
  }

  async _addHandshake (k, noise, clientAddress, { from, to: serverAddress, socket }, direct) {
    let id = this._holepunches.indexOf(null)
    if (id === -1) id = this._holepunches.push(null) - 1

    const hs = {
      round: 0,
      reply: null,
      puncher: null,
      payload: null,
      rawStream: null,
      prepunching: null,
      firewalled: true,
      clearing: null,
      onsocket: null
    }

    this._holepunches[id] = hs

    const handshake = this.createHandshake(this._keyPair, null)

    let remotePayload
    try {
      remotePayload = await handshake.recv(noise)
    } catch (err) {
      safetyCatch(err)
      this._clearLater(hs, id, k)
      return null
    }

    try {
      hs.firewalled = await this.firewall(handshake.remotePublicKey, remotePayload, clientAddress)
    } catch (err) {
      safetyCatch(err)
    }

    if (hs.firewalled) {
      this._clearLater(hs, id, k)
      return null
    }

    if (this.closed) return null

    const error = remotePayload.version === 1
      ? (remotePayload.udx ? ERROR.NONE : ERROR.ABORTED)
      : ERROR.VERSION_MISMATCH

    const addresses = []
    const ourRemoteAddr = this.dht.remoteAddress()
    const ourLocalAddrs = this._shareLocalAddress ? Holepuncher.localAddresses(this.dht.io.serverSocket) : null

    if (ourRemoteAddr) addresses.push(ourRemoteAddr)
    if (ourLocalAddrs) addresses.push(...ourLocalAddrs)

    if (error === ERROR.NONE) {
      hs.rawStream = this.dht._rawStreams.add({
        framed: true,
        firewall (socket, port, host) {
          hs.onsocket(socket, port, host)
          return false
        }
      })

      hs.rawStream.on('error', autoDestroy)

      hs.onsocket = (socket, port, host) => {
        this._clearLater(hs, id, k)

        const rawStream = this.dht._debugStream !== null
          ? new DebuggingStream(hs.rawStream, this.dht._debugStream)
          : hs.rawStream

        if (this._reusableSocket && remotePayload.udx.reusableSocket) {
          this.dht._socketPool.routes.add(handshake.remotePublicKey, hs.rawStream)
        }

        hs.rawStream.removeListener('error', autoDestroy)
        hs.rawStream.connect(socket, remotePayload.udx.id, port, host)

        this.onconnection(this.createSecretStream(false, rawStream, { handshake: h }))

        if (hs.puncher) {
          hs.puncher.onabort = noop
          hs.puncher.destroy()
        }
      }

      function autoDestroy () {
        if (hs.puncher) hs.puncher.destroy()
      }
    }

    try {
      hs.reply = await handshake.send({
        error,
        firewall: ourRemoteAddr ? FIREWALL.OPEN : FIREWALL.UNKNOWN,
        holepunch: ourRemoteAddr ? null : { id, relays: this._announcer.relays },
        addresses4: addresses,
        addresses6: null,
        udx: {
          reusableSocket: this._reusableSocket,
          id: hs.rawStream ? hs.rawStream.id : 0,
          seq: 0
        },
        secretStream: {}
      })
    } catch (err) {
      safetyCatch(err)
      hs.rawStream.destroy()
      this._clearLater(hs, id, k)
      return null
    }

    if (this.dht._debugHandshakeLatency !== null) {
      const [start, end] = this.dht._debugHandshakeLatency
      await sleep(start + Math.round(Math.random() * (end - start)))
    }

    const h = handshake.final()

    if (error !== ERROR.NONE) {
      this._clearLater(hs, id, k)
      return hs
    }

    if (remotePayload.firewall === FIREWALL.OPEN || direct) {
      const sock = direct ? socket : this.dht.socket
      hs.onsocket(sock, clientAddress.port, clientAddress.host)
      return hs
    }

    if (!direct && clientAddress.host === serverAddress.host) {
      const clientAddresses = remotePayload.addresses4.filter(onlyPrivateHosts)

      if (clientAddresses.length > 0) {
        const myAddresses = Holepuncher.localAddresses(this.dht.io.serverSocket)
        const addr = Holepuncher.matchAddress(myAddresses, clientAddresses)

        if (addr) {
          const socket = this.dht.io.serverSocket
          hs.onsocket(socket, addr.port, addr.host)
          return hs
        }
      }
    }

    if (ourRemoteAddr) {
      return hs
    }

    // TODO: direct connection etc

    hs.payload = new SecurePayload(h.holepunchSecret)
    hs.puncher = new Holepuncher(this.dht, this.dht.session(), false, remotePayload.firewall)

    const onabort = () => {
      if (hs.prepunching) clearTimeout(hs.prepunching)
      hs.prepunching = null
      hs.rawStream.destroy()
      this._clearLater(hs, id, k)
    }

    hs.puncher.onconnect = hs.onsocket
    hs.puncher.onabort = onabort
    hs.prepunching = setTimeout(hs.puncher.destroy.bind(hs.puncher), HANDSHAKE_INITIAL_TIMEOUT)

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
    const k = b4a.toString(noise, 'hex')

    // The next couple of statements MUST run within the same tick to prevent
    // a malicious peer from flooding us with handshakes.
    let p = this._connects.get(k)
    if (!p) {
      p = this._addHandshake(k, noise, peerAddress || req.from, req, !peerAddress)
      this._connects.set(k, p)
    }

    const h = await p
    if (!h) return null

    if (this.closed) return null

    return { socket: h.puncher && h.puncher.socket, noise: h.reply }
  }

  async _onpeerholepunch ({ id, peerAddress, payload }, req) {
    const h = id < this._holepunches.length ? this._holepunches[id] : null
    if (!h) return null

    if (!peerAddress || this.closed) return null

    const p = h.puncher
    if (!p || !p.socket) return this._abort(h) // not opened

    const remotePayload = h.payload.decrypt(payload)
    if (!remotePayload) return null

    const isServerRelay = this._announcer.isRelay(req.from)
    const { error, firewall, round, punching, addresses, remoteAddress, remoteToken } = remotePayload

    if (error !== ERROR.NONE) {
      // We actually do not need to set the round here, but just do it for consistency.
      if (round >= h.round) h.round = round
      return this._abort(h)
    }

    const token = h.payload.token(peerAddress)
    const echoed = isServerRelay && !!remoteToken && b4a.equals(token, remoteToken)

    // Update our heuristics here
    if (req.socket === p.socket) {
      p.nat.add(req.to, req.from)
    }

    if (round >= h.round) {
      h.round = round
      p.updateRemote({ punching, firewall, addresses, verified: echoed ? peerAddress.host : null })
    }

    // Wait for the analyzer to reach a conclusion...
    let stable = await p.analyze(false)
    if (p.destroyed) return null

    if (!p.remoteHolepunching && !stable) {
      stable = await p.analyze(true)
      if (p.destroyed) return null
      if (!stable) return this._abort(h)
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

      if (h.prepunching) {
        clearTimeout(h.prepunching)
        h.prepunching = null
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
      payload: h.payload.encrypt({
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
    if (!h.payload) {
      if (h.puncher) h.puncher.destroy()
      return null
    }

    const payload = h.payload.encrypt({
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

    h.puncher.destroy()

    return { socket: this.dht.socket, payload }
  }
}

function isConsistent (fw) {
  return fw === FIREWALL.OPEN || fw === FIREWALL.CONSISTENT
}

function hasSameAddr (addrs, other) {
  if (addrs === null) return false

  for (const addr of addrs) {
    if (addr.port === other.port && addr.host === other.host) return true
  }
  return false
}

function defaultCreateHandshake (keyPair, remotePublicKey) {
  return new NoiseWrap(keyPair, remotePublicKey)
}

function defaultCreateSecretStream (isInitiator, rawStream, opts) {
  return new NoiseSecretStream(isInitiator, rawStream, opts)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function onlyPrivateHosts (addr) {
  return isPrivate(addr.host)
}

function noop () {}
