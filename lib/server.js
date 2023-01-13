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
const { ALREADY_LISTENING, NODE_DESTROYED } = require('./errors')
const { isBogon } = require('bogon')

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
    console.log('_addHandshake')

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

    const addresses4 = []
    const addresses6 = []

    const ourRemoteAddr = this.dht.remoteAddress()
    if (ourRemoteAddr) addresses4.push(ourRemoteAddr)

    // master single local address was: ipv4, skip internal, prefer en0 name, otherwise first host. If addr no found then localhost

    console.log('share local address?', this._shareLocalAddress)
    console.log('master: our local address', this.dht.localAddress())
    console.log('ourRemoteAddr', ourRemoteAddr)

    console.log('internal client socket address', this.dht.io.clientSocket.address())
    console.log('internal server socket address', this.dht.io.serverSocket.address())

    // on hosting providers this usually contains its remote IP addr (might be redundant as serverAddress is already the same remote IP addr?)
    for (const addr of this.dht.io.networkInterfaces) {
      if (addr.internal) continue // this is safe
      if (addr.name === 'en0') console.log('old mac fix?', addr.host)

      if (!this._shareLocalAddress && isBogon(addr.host)) {
        console.log('addr skipped', addr.host)
        continue
      }

      if (addr.name === 'enp4s0') continue

      // console.log('addr', addr.host)

      const address = { host: addr.host, port: this.dht.port }
      // const address = { host: addr.host, port: this.dht.io.serverSocket.address().port }
      if (addr.family === 4) addresses4.push(address)
      else addresses6.push(address)
    }

    if (error === ERROR.NONE) {
      hs.rawStream = this.dht._rawStreams.add({
        framed: true,
        firewall (socket, port, host) {
          console.log('raw stream firewall', { host, port })
          hs.onsocket(socket, port, host)
          return false
        }
      })

      hs.rawStream.on('error', autoDestroy)

      hs.onsocket = (socket, port, host) => {
        console.log('hs onsocket', { host, port })
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

    // master: [ { host: '192.168.0.23', port: 49737 } ]

    console.log(addresses4)
    console.log(addresses6)

    try {
      hs.reply = await handshake.send({
        error,
        firewall: ourRemoteAddr ? FIREWALL.OPEN : FIREWALL.UNKNOWN,
        holepunch: ourRemoteAddr ? null : { id, relays: this._announcer.relays },
        addresses4,
        addresses6,
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
    console.log('_onpeerhandshake', { noise, peerAddress }, Object.assign({}, req, { socket: '+', _io: '+' }))

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

    console.log('_onpeerholepunch', { id, peerAddress }, remotePayload, Object.assign({}, req, { socket: '+', _io: '+' }))

    const isServerRelay = this._announcer.isRelay(req.from)
    const { error, firewall, round, punching, addresses, remoteAddress, remoteToken } = remotePayload

    if (error !== ERROR.NONE) {
      // We actually do not need to set the round here, but just do it for consistency.
      if (round >= h.round) h.round = round
      return this._abort(h)
    }

    const token = h.payload.token(peerAddress)
    const echoed = isServerRelay && !!remoteToken && b4a.equals(token, remoteToken)
    console.log('_onpeerholepunch', { isServerRelay, echoed })

    // Update our heuristics here
    if (req.socket === p.socket) {
      console.log('req.socket same as p.socket')
      p.nat.add(req.to, req.from)
    }

    if (round >= h.round) {
      console.log('updating remote')
      h.round = round
      p.updateRemote({ punching, firewall, addresses, verified: echoed ? peerAddress.host : null })
    }

    // Wait for the analyzer to reach a conclusion...
    console.log('first analyze')
    let stable = await p.analyze(false)
    if (p.destroyed) return null
    console.log('after analyze')

    console.log({ remoteHolepunching: p.remoteHolepunching, stable })

    if (!p.remoteHolepunching && !stable) {
      stable = await p.analyze(true)
      if (p.destroyed) return null
      if (!stable) return this._abort(h)
    }

    // Fast mode! If we are consistent and the remote has opened a session to us (remoteAddress)
    // then fire a quick punch back. Note the await here just waits for the udp socket to flush.
    console.log({ isConsistent: isConsistent(p.nat.firewall), hasSameAddr: remoteAddress ? hasSameAddr(p.nat.addresses, remoteAddress) : false })
    if (isConsistent(p.nat.firewall) && remoteAddress && hasSameAddr(p.nat.addresses, remoteAddress)) {
      await p.ping(peerAddress)
      if (p.destroyed) return null
    }

    // Remote said they are punching (or willing to), so we will punch as well.
    // Note that this returns when the punching has STARTED, so no guarantee
    // we will have a connection after this promise etc.
    if (p.remoteHolepunching) {
      console.log('remote said they are punching!')

      // TODO: still continue here if a local connection might work, but then do not holepunch...
      if (!this.holepunch(p.remoteFirewall, p.nat.firewall, p.remoteAddresses, p.nat.addresses)) {
        console.log('do not holepunch here')
        return p.destroyed ? null : this._abort(h)
      }

      if (h.prepunching) {
        clearTimeout(h.prepunching)
        h.prepunching = null
      }

      console.log('punching')

      console.log('trying to open session', remoteAddress)
      await p.ping(peerAddress)
      await p.ping(remoteAddress)
      await p.ping({ host: remoteAddress.host, port: remoteAddress.port })
      await p.ping({ host: remoteAddress.host, port: peerAddress.port })
      await p.openSession({ host: remoteAddress.host, port: peerAddress.port })
      await p.openSession({ host: remoteAddress.host, port: peerAddress.port }, p.socket)
      await p.openSession({ host: remoteAddress.host, port: peerAddress.port }, this.dht.io.serverSocket)
      await p.openSession({ host: remoteAddress.host, port: peerAddress.port }, this.dht.io.clientSocket)
      await p.openSession({ host: remoteAddress.host, port: 49737 })
      await p.openSession({ host: remoteAddress.host, port: 49737 }, p.socket)
      await p.openSession({ host: remoteAddress.host, port: 49737 }, this.dht.io.serverSocket)
      await p.openSession({ host: remoteAddress.host, port: 49737 }, this.dht.io.clientSocket)

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
    console.log('_abort')

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

function noop () {}
