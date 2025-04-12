const { EventEmitter } = require('events')
const safetyCatch = require('safety-catch')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const b4a = require('b4a')
const relay = require('blind-relay')
const NoiseWrap = require('./noise-wrap')
const Announcer = require('./announcer')
const { FIREWALL, ERROR } = require('./constants')
const { unslabbedHash } = require('./crypto')
const SecurePayload = require('./secure-payload')
const Holepuncher = require('./holepuncher')
const { isPrivate } = require('bogon')
const { ALREADY_LISTENING, NODE_DESTROYED, KEYPAIR_ALREADY_USED } = require('./errors')

const HANDSHAKE_CLEAR_WAIT = 10000
const HANDSHAKE_INITIAL_TIMEOUT = 10000

module.exports = class Server extends EventEmitter {
  constructor (dht, opts = {}) {
    super()

    this.dht = dht
    this.target = null

    this.closed = false
    this.firewall = opts.firewall || (() => false)
    this.holepunch = opts.holepunch || (() => true)
    this.relayThrough = opts.relayThrough || null
    this.relayKeepAlive = opts.relayKeepAlive || 5000
    this.pool = opts.pool || null
    this.createHandshake = opts.createHandshake || defaultCreateHandshake
    this.createSecretStream = opts.createSecretStream || defaultCreateSecretStream
    this.suspended = false

    this._shareLocalAddress = opts.shareLocalAddress !== false
    this._reusableSocket = !!opts.reusableSocket
    this._neverPunch = opts.holepunch === false // useful for fully disabling punching
    this._keyPair = null
    this._announcer = null
    this._connects = new Map()
    this._holepunches = []
    this._listening = null
    this._closing = null
  }

  get listening () {
    return this._listening !== null
  }

  get publicKey () {
    return this._keyPair && this._keyPair.publicKey
  }

  get relayAddresses () {
    return this._announcer ? this._announcer.relayAddresses : []
  }

  onconnection (encryptedSocket) {
    this.emit('connection', encryptedSocket)
  }

  async suspend ({ log = noop } = {}) {
    log('Suspending hyperdht server')
    if (this._listening !== null) await this._listening
    log('Suspending hyperdht server (post listening)')
    this.suspended = true
    this._clearAll()
    return this._announcer ? this._announcer.suspend({ log }) : Promise.resolve()
  }

  async resume () {
    if (this._listening !== null) await this._listening
    this.suspended = false
    return this._announcer ? this._announcer.resume() : Promise.resolve()
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

  _gc () {
    this.dht.listening.delete(this)
    if (this.target) this.dht._router.delete(this.target)
  }

  async _stopListening () {
    try {
      if (this._announcer) await this._announcer.stop()
    } catch {
      // ignore
    }

    this._announcer = null
    this._listening = null
    this._keyPair = null
  }

  async _close () {
    if (this._listening === null) {
      this.closed = true
      this.emit('close')
      return
    }

    try {
      await this._listening
    } catch {}

    this._gc()
    this._clearAll()

    await this._stopListening()

    this.closed = true
    this.emit('close')
  }

  _clearAll () {
    while (this._holepunches.length > 0) {
      const h = this._holepunches.pop()
      if (h && h.puncher) h.puncher.destroy()
      if (h && h.clearing) clearTimeout(h.clearing)
      if (h && h.prepunching) clearTimeout(h.prepunching)
      if (h && h.rawStream) h.rawStream.destroy()
    }

    this._connects.clear()
  }

  async listen (keyPair = this.dht.defaultKeyPair, opts = {}) {
    if (this._listening !== null) throw ALREADY_LISTENING()
    if (this.dht.destroyed) throw NODE_DESTROYED()

    this._listening = this._listen(keyPair, opts)
    await this._listening
    return this
  }

  async _listen (keyPair, opts) {
    // From now on, the DHT object which created me is responsible for closing me
    this.dht.listening.add(this)

    try {
      await this.dht.bind()
      if (this._closing) return

      for (const s of this.dht.listening) {
        if (s._keyPair && b4a.equals(s._keyPair.publicKey, keyPair.publicKey)) {
          throw KEYPAIR_ALREADY_USED()
        }
      }

      this.target = unslabbedHash(keyPair.publicKey)
      this._keyPair = keyPair
      this._announcer = new Announcer(this.dht, keyPair, this.target, opts)

      this.dht._router.set(this.target, {
        relay: null,
        record: this._announcer.record,
        onpeerhandshake: this._onpeerhandshake.bind(this),
        onpeerholepunch: this._onpeerholepunch.bind(this)
      })

      // warm it up for now
      this._localAddresses().catch(safetyCatch)

      await this._announcer.start()
    } catch (err) {
      await this._stopListening()
      this._gc()
      throw err
    }

    if (this._closing) return
    if (this.suspended) await this._announcer.suspend()

    if (this._closing) return
    if (this.dht.destroyed) throw NODE_DESTROYED()

    if (this.pool) this.pool._attachServer(this)

    this.emit('listening')
  }

  refresh () {
    if (this._announcer) this._announcer.refresh()
  }

  notifyOnline () {
    if (this._announcer) this._announcer.online.notify()
  }

  _localAddresses () {
    return this.dht.validateLocalAddresses(Holepuncher.localAddresses(this.dht.io.serverSocket))
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
      encryptedSocket: null,
      prepunching: null,
      firewalled: true,
      clearing: null,
      onsocket: null,

      // Relay state
      relayTimeout: null,
      relayToken: null,
      relaySocket: null,
      relayClient: null,
      relayPaired: false
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

    if (this._closing || this.suspended) return null

    try {
      hs.firewalled = await this.firewall(handshake.remotePublicKey, remotePayload, clientAddress)
    } catch (err) {
      safetyCatch(err)
    }

    if (this._closing || this.suspended) return null

    if (hs.firewalled) {
      this._clearLater(hs, id, k)
      return null
    }

    const error = remotePayload.version === 1
      ? (remotePayload.udx ? ERROR.NONE : ERROR.ABORTED)
      : ERROR.VERSION_MISMATCH

    const addresses = []
    const ourRemoteAddr = this.dht.remoteAddress()
    const ourLocalAddrs = this._shareLocalAddress ? await this._localAddresses() : null

    if (this._closing || this.suspended) return null

    if (ourRemoteAddr) addresses.push(ourRemoteAddr)
    if (ourLocalAddrs) addresses.push(...ourLocalAddrs)

    if (error === ERROR.NONE) {
      hs.rawStream = this.dht.createRawStream({
        framed: true,
        firewall (socket, port, host) {
          // Check if the traffic originated from the socket on which we're expecting relay traffic. If so,
          // we haven't hole punched yet and the other side is just sending us traffic through the relay.
          if (hs.relaySocket && isRelay(hs.relaySocket, socket, port, host)) {
            return false
          }

          hs.onsocket(socket, port, host)
          return false
        }
      })

      hs.rawStream.on('error', autoDestroy)

      hs.onsocket = (socket, port, host) => {
        if (hs.rawStream === null) return // Already hole punched

        this._clearLater(hs, id, k)

        if (hs.prepunching) {
          clearTimeout(hs.prepunching)
          hs.prepunching = null
        }

        if (this._reusableSocket && remotePayload.udx.reusableSocket) {
          this.dht._socketPool.routes.add(handshake.remotePublicKey, hs.rawStream)
        }

        hs.rawStream.removeListener('error', autoDestroy)

        if (hs.rawStream.connected) {
          const remoteChanging = hs.rawStream.changeRemote(socket, remotePayload.udx.id, port, host)

          if (remoteChanging) remoteChanging.catch(safetyCatch)
        } else {
          hs.rawStream.connect(socket, remotePayload.udx.id, port, host)
          hs.encryptedSocket = this.createSecretStream(false, hs.rawStream, {
            handshake: h,
            keepAlive: this.dht.connectionKeepAlive
          })

          this.onconnection(hs.encryptedSocket)
        }

        if (hs.puncher) {
          hs.puncher.onabort = noop
          hs.puncher.destroy()
        }

        hs.rawStream = null
      }

      function autoDestroy () {
        if (hs.puncher) hs.puncher.destroy()
      }
    }

    const relayThrough = selectRelay(this.relayThrough)

    if (relayThrough) hs.relayToken = relay.token()

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
        secretStream: {},
        relayThrough: relayThrough
          ? { publicKey: relayThrough, token: hs.relayToken }
          : null
      })
    } catch (err) {
      safetyCatch(err)
      hs.rawStream.destroy()
      this._clearLater(hs, id, k)
      return null
    }

    if (this._closing || this.suspended) {
      hs.rawStream.destroy()
      return null
    }

    const h = handshake.final()

    if (error !== ERROR.NONE) {
      hs.rawStream.destroy()
      this._clearLater(hs, id, k)
      return hs
    }

    if (relayThrough || remotePayload.relayThrough) {
      this._relayConnection(hs, relayThrough, remotePayload, h)
    }

    if (remotePayload.firewall === FIREWALL.OPEN || direct) {
      const sock = direct ? socket : this.dht.socket
      this.dht.stats.punches.open++
      hs.onsocket(sock, clientAddress.port, clientAddress.host)
      return hs
    }

    const onabort = () => {
      if (hs.prepunching) clearTimeout(hs.prepunching)
      hs.prepunching = null
      hs.rawStream.on('close', () => this._clearLater(hs, id, k))
      if (hs.relayToken === null) hs.rawStream.destroy()
    }

    if (!direct && clientAddress.host === serverAddress.host) {
      const clientAddresses = remotePayload.addresses4.filter(onlyPrivateHosts)

      if (clientAddresses.length > 0 && this._shareLocalAddress) {
        const myAddresses = await this._localAddresses()
        const addr = Holepuncher.matchAddress(myAddresses, clientAddresses)

        if (addr) {
          hs.prepunching = setTimeout(onabort, HANDSHAKE_INITIAL_TIMEOUT)
          return hs
        }
      }
    }

    if (this._closing || this.suspended) return null

    if (ourRemoteAddr || this._neverPunch) {
      hs.prepunching = setTimeout(onabort, HANDSHAKE_INITIAL_TIMEOUT)
      return hs
    }

    hs.payload = new SecurePayload(h.holepunchSecret)
    hs.puncher = new Holepuncher(this.dht, this.dht.session(), false, remotePayload.firewall)

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
    if (hs.clearing) clearTimeout(hs.clearing)

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

    if (this._closing !== null || this.suspended) return null

    return { socket: h.puncher && h.puncher.socket, noise: h.reply }
  }

  async _onpeerholepunch ({ id, peerAddress, payload }, req) {
    const h = id < this._holepunches.length ? this._holepunches[id] : null
    if (!h) return null

    if (!peerAddress || this._closing !== null || this.suspended) return null

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

      if (p.remoteFirewall >= FIREWALL.RANDOM || p.nat.firewall >= FIREWALL.RANDOM) {
        if (this.dht._randomPunches >= this.dht._randomPunchLimit || (Date.now() - this.dht._lastRandomPunch) < this.dht._randomPunchInterval) {
          if (!h.relayToken) return this._abort(h, ERROR.TRY_LATER)
          return {
            socket: p.socket,
            payload: h.payload.encrypt({
              error: ERROR.TRY_LATER,
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

  _abort (h, error = ERROR.ABORTED) {
    if (!h.payload) {
      if (h.puncher) h.puncher.destroy()
      return null
    }

    const payload = h.payload.encrypt({
      error,
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

  _relayConnection (hs, relayThrough, remotePayload, h) {
    let isInitiator
    let publicKey
    let token

    if (relayThrough) {
      isInitiator = true
      publicKey = relayThrough
      token = hs.relayToken
    } else {
      isInitiator = false
      publicKey = remotePayload.relayThrough.publicKey
      token = remotePayload.relayThrough.token
    }

    hs.relayToken = token
    hs.relaySocket = this.dht.connect(publicKey)
    hs.relaySocket.setKeepAlive(this.relayKeepAlive)
    hs.relayClient = relay.Client.from(hs.relaySocket, { id: hs.relaySocket.publicKey })
    hs.relayTimeout = setTimeout(onabort, 15000)

    hs.relayClient
      .pair(isInitiator, token, hs.rawStream)
      .on('error', onabort)
      .on('data', (remoteId) => {
        if (hs.relayTimeout) clearRelayTimeout(hs)
        if (hs.rawStream === null) {
          onabort(null)
          return
        }

        hs.relayPaired = true

        if (hs.prepunching) clearTimeout(hs.prepunching)
        hs.prepunching = null

        const {
          remotePort,
          remoteHost,
          socket
        } = hs.relaySocket.rawStream

        hs.rawStream
          .on('close', () => hs.relaySocket.destroy())
          .connect(socket, remoteId, remotePort, remoteHost)

        hs.encryptedSocket = this.createSecretStream(false, hs.rawStream, { handshake: h })

        this.onconnection(hs.encryptedSocket)
      })

    function onabort () {
      if (hs.relayTimeout) clearRelayTimeout(hs)
      const socket = hs.relaySocket
      hs.relayToken = null
      hs.relaySocket = null
      if (socket) socket.destroy()
    }
  }
}

function clearRelayTimeout (hs) {
  clearTimeout(hs.relayTimeout)
  hs.relayTimeout = null
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

function onlyPrivateHosts (addr) {
  return isPrivate(addr.host)
}

function isRelay (relaySocket, socket, port, host) {
  const stream = relaySocket.rawStream
  if (!stream) return false
  if (stream.socket !== socket) return false
  return port === stream.remotePort && host === stream.remoteHost
}

function selectRelay (relayThrough) {
  if (typeof relayThrough === 'function') relayThrough = relayThrough()
  if (relayThrough === null) return null
  if (Array.isArray(relayThrough)) return relayThrough[Math.floor(Math.random() * relayThrough.length)]
  return relayThrough
}

function noop () {}
