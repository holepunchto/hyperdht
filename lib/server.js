const { EventEmitter } = require('events')
const safetyCatch = require('safety-catch')
const NoiseSecretStream = require('noise-secret-stream')
const NoiseWrap = require('./noise-wrap')
const sodium = require('sodium-universal')
const Announcer = require('./announcer')

const PROBE = 0
const PUNCH = 1
const ABORT = 2

class ServerConnector {
  constructor (server) {
    this.server = server
    this.connects = new Map()
    this.holepunches = []
    this.destroyed = false
  }

  destroy () {
    this.destroyed = true

    while (this.holepunches.length > 0) {
      const h = this.holepunches.pop()
      if (h && h.pair) h.pair.destroy()
    }

    this.connects.clear()
  }

  _clear (hs, id, k) {
    if (id >= this.holepunches.length || this.holepunches[id] !== hs) return

    this.holepunches[id] = null
    while (this.holepunches.length > 0 && this.holepunches[this.holepunches.length - 1] === null) {
      this.holepunches.pop()
    }
    this.connects.delete(k)
  }

  async _addHandshake (k, noise, peerAddress) {
    const handshake = new NoiseWrap(this.server.keyPair, null)
    const remotePayload = handshake.recv(noise)

    if (!remotePayload) return null

    let id = this.holepunches.indexOf(null)
    if (id === -1) id = this.holepunches.push(null) - 1

    const reply = handshake.send({
      firewalled: this.server.dht.firewalled,
      id,
      relays: this.server.announcer.relays
    })

    const h = handshake.final()
    const fw = this.server.firewall(h.remotePublicKey, remotePayload, peerAddress)
    const hs = {
      reply,
      pair: null,
      firewalled: (!fw || !fw.then) ? Promise.resolve(fw) : fw.catch(toTrue)
    }

    this.connects.set(k, hs)
    this.holepunches[id] = hs

    if (await hs.firewalled) {
      this._clear(id, k)
      return null
    }
    if (this.destroyed) {
      return null
    }

    const pair = hs.pair = this.server.dht._sockets.pair(h)

    pair.onconnection = (rawSocket, data, ended, handshake) => {
      this._clear(hs, id, k)

      const encryptedSocket = new NoiseSecretStream(false, rawSocket, {
        handshake,
        data,
        ended
      })

      this.server.onconnection(encryptedSocket)
    }

    pair.ondestroy = () => {
      this._clear(hs, id, k)
    }

    if (!this.server.dht.firewalled) {
      return hs
    }

    if (!remotePayload.firewalled) {
      // TODO: like in the client, pass forward which protocol to use etc etc
      pair.connect(remotePayload.address || peerAddress)
      return hs
    }

    pair.open()
    return hs
  }

  async onconnect ({ noise, peerAddress }) {
    const k = noise.toString('hex')
    let h = this.connects.get(k)

    if (!h) {
      h = await this._addHandshake(k, noise, peerAddress)
      if (!h) return null
    }

    if (await h.firewalled) return null
    if (this.destroyed) return null

    return { socket: h.pair && h.pair.socket, noise: h.reply }
  }

  async onholepunch ({ id, peerAddress, payload }, req) {
    const h = id < this.holepunches.length ? this.holepunches[id] : null
    if (!h) return null

    if (await h.firewalled) return null
    if (this.destroyed) return null

    const p = h.pair
    if (!p.socket) return abort(h) // not opened

    const remotePayload = p.payload.decrypt(payload)
    if (!remotePayload) return null

    const isServerRelay = this.server.announcer.isRelay(req.from)
    const { status, nat, address, remoteAddress, remoteToken } = remotePayload

    if (status === ABORT) return abort(h)

    const token = p.payload.token(peerAddress)
    const echoed = isServerRelay && !!remoteToken && token.equals(remoteToken)

    // Update our heuristics here
    if (req.socket === p.socket) {
      p.nat.add(req.to, req.from)
    }
    if (p.remoteNat === 0 && nat !== 0 && address && (p.remoteNat !== 1 || address.port !== 0)) {
      p.remoteNat = nat
      p.remoteAddress = address
    }
    if (echoed && p.remoteAddress && p.remoteAddress.host === peerAddress.host) {
      p.remoteVerified = true
    }
    if (status === PUNCH) {
      p.remoteHolepunching = true
    }

    // Wait for the analyzer to reach a conclusion...
    await p.nat.analyzing
    if (p.destroyed) return null

    // Bail if non-holepunchable and we cannot recover from that...
    if (p.remoteNat >= 2 && p.nat.type >= 2) {
      if (!(await p.reopen())) {
        return abort(h)
      }
    }

    // Fast mode! If we are consistent and the remote has opened a session to us (remoteAddress)
    // then fire a quick punch back. Note the await here just waits for the udp socket to flush.
    if (p.nat.type === 1 && remoteAddress && sameAddr(p.nat.address, remoteAddress)) {
      await p.ping(peerAddress)
      if (p.destroyed) return null
    }

    // Remote said they are punching (or willing to), and we have verified their IP so we will
    // punch as well. Note that this returns when the punching has STARTED, so we no guarantee
    // we will have a connection after this promise etc.
    if (p.remoteHolepunching && p.remoteVerified) {
      // TODO: still continue here if a local connection might work, but then do not holepunch...
      if (!this.server.holepunch(p.remoteNat, p.nat.type, p.remoteAddress, p.address)) {
        return abort(h)
      }
      await p.punch()
      if (p.destroyed) return null
    }

    return {
      socket: p.socket,
      payload: p.payload.encrypt({
        status: p.punching ? PUNCH : PROBE,
        nat: p.nat.type,
        address: p.nat.address,
        remoteAddress: null,
        token: (isServerRelay && !p.remoteVerified) ? token : null,
        remoteToken: remotePayload.token
      })
    }
  }
}

module.exports = class Server extends EventEmitter {
  constructor (dht, opts = {}) {
    super()

    this.dht = dht
    this.sockets = dht._sockets
    this.keyPair = null
    this.announcer = null
    this.connector = new ServerConnector(this)

    this.firewall = opts.firewall || (() => false)
    this.holepunch = opts.holepunch || (() => true)
  }

  onconnection (encryptedSocket) {
    this.emit('connection', encryptedSocket)
  }

  close () {
    if (!this.announcer) return Promise.resolve()
    this._router.delete(this.announcer.target)
    this.connector.destroy()
    return this.announcer.stop()
  }

  listen (keyPair) {
    if (this.announcer) return Promise.reject(new Error('Already listening'))

    const target = hash(keyPair.publicKey)

    this.keyPair = keyPair
    this.announcer = new Announcer(this.dht, this.keyPair, target)
    this.connector = new ServerConnector(this)

    this.dht._router.set(target, {
      relay: null,
      server: this.connector
    })

    return this.announcer.start()
  }
}

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}

function sameAddr (a, b) {
  return a.host === b.host && a.port === b.port
}

function abort (h) {
  if (!h.pair.payload) {
    h.pair.destroy()
    return null
  }

  const payload = h.pair.payload.encrypt({
    status: ABORT,
    nat: 0,
    address: null,
    remoteAddress: null,
    token: null,
    remoteToken: null
  })

  h.pair.destroy()

  return { socket: null, payload }
}

function toTrue (err) {
  safetyCatch(err)
  return true
}
