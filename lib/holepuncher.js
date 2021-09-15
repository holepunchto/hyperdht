const EventEmitter = require('events')
const utp = require('utp-native')
const sodium = require('sodium-universal')
const Nat = require('./nat')
const messages = require('./messages')

const BIRTHDAY_SOCKETS = 256
const HOLEPUNCH = Buffer.from([0])
const HOLEPUNCH_TTL = 5
const DEFAULT_TTL = 64
const MAX_REROLLS = 3

const NS_HOLEPUNCH = Buffer.alloc(32)
sodium.crypto_generichash(NS_HOLEPUNCH, Buffer.from('hyperswarm_holepunch'))

class SocketWrap extends EventEmitter {
  constructor (socket) {
    super()

    this.socket = socket
    this.ttl = DEFAULT_TTL

    this._unwrapped = false
    this._pending = 0
    this._queue = []
    this._onflushbound = this._onflush.bind(this)
    this._onmessagebound = this.emit.bind(this, 'message')

    socket.on('message', this._onmessagebound)
  }

  unwrap () {
    this.socket.removeListener('message', this._onmessagebound)
    this._unwrapped = true
    this.ttl = 64
    return this.socket
  }

  close () {
    this.socket.close()
    this._unwrapped = true
    while (this._queue.length) {
      const q = this._queue.pop()
      if (q.onflush) q.onflush(new Error('Socket closed'))
    }
  }

  send (buf, start, end, port, host, onflush = null) {
    this._send(this._queue.length > 0, DEFAULT_TTL, buf, start, end, port, host, onflush)
  }

  sendTTL (ttl, buf, start, end, port, host, onflush = null) {
    this._send(this._queue.length > 0, ttl, buf, start, end, port, host, onflush)
  }

  _send (requeue, ttl, buf, start, end, port, host, onflush) {
    if (!this._unwrapped && (this.ttl !== ttl || requeue)) {
      if (this._pending > 0 || requeue) {
        this._queue.push({ ttl, buf, start, end, port, host, onflush })
        return false
      }

      this.ttl = ttl
      this.socket.setTTL(ttl)
    }

    this._pending++
    this.socket.send(buf, start, end, port, host, onflush ? this._wrap(onflush) : this._onflushbound)
    return true
  }

  _wrap (onflush) {
    return (err) => {
      this._onflush(err)
      onflush(err)
    }
  }

  _onflush () {
    if (--this._pending > 0 || this._queue.length === 0) return

    while (true) {
      const { ttl, buf, start, end, port, host, onflush } = this._queue.shift()
      this._send(false, ttl, buf, start, end, port, host, onflush)
      if (this._queue.length === 0 || (this._queue[0].ttl !== this.ttl && !this._unwrapped)) return
    }
  }
}

module.exports = class Holepuncher {
  constructor (dht, isInitiator, handshakeHash) {
    const self = this

    this.isInitiator = isInitiator
    this.dht = dht
    this.socket = null
    this.nat = null
    this.rawSocket = null

    // conditions
    this.destroyed = false
    this.punching = false
    this.started = null
    this.rerolling = null

    let onconnect = null
    this.connected = new Promise((resolve) => { onconnect = resolve })

    // track remote state
    this.remoteNat = 0
    this.remoteHolepunching = false
    this.remoteAddress = null
    this.remoteVerified = false

    this._sharedSecret = Buffer.allocUnsafe(32)
    this._secret = Buffer.allocUnsafe(32)
    this._allSockets = []
    this._onconnect = onconnect
    this._onconnectionbound = onconnection
    this._onmessagebound = onmessage

    sodium.randombytes_buf(this._secret)
    sodium.crypto_generichash(this._sharedSecret, handshakeHash, NS_HOLEPUNCH)

    this._reset()

    function onconnection (rawSocket) {
      self.onconnection(this, rawSocket)
    }

    function onmessage (buf, rinfo) {
      if (buf.byteLength > 1 && this === self.socket) dht.onmessage(this, buf, rinfo)
      else self.onmessage(this, buf, rinfo)
    }
  }

  _reset () {
    if (this.socket) {
      // we should never hit this condition, but just to assert if we do...
      if (this._allSockets.length > 1) {
        throw new Error('Can only reset a single socket')
      }
      this.socket.close()
      this._allSockets.pop()
    }

    this.socket = this._makeSocket()
    this._allSockets.push(this.socket)
    this.nat = new Nat(this.dht, this.socket)

    // TODO: maybe make auto sampling configurable somehow?
    this.nat.autoSample()
  }

  onconnection (utp, rawSocket) {
    // TODO: unsure if this is needed by the extra tick added by
    // the onconnect promise resolve makes me think that it is
    // TODO: also validate address when we start validating below
    rawSocket.on('error', noop)

    utp.firewall(true)

    this.rawSocket = rawSocket
    this._onconnect(rawSocket)
  }

  // Note that this never throws so it is safe to run in the background
  async onmessage (socket, buf, rinfo) {
    // TODO: try to filter out spoofed messages, but remoteAddress is not always set
    // so skipping for now.

    // make sure we only hit this path if we are punching (shutdown clear this bool)
    if (!this.punching) return

    this._shutdown(socket)

    console.log('got holepunch releated message from', rinfo, this._allSockets.length)

    if (this.isInitiator) {
      console.log('client should connect to', rinfo)
      const utp = socket.unwrap()
      const c = utp.connect(rinfo.port, rinfo.address)
      this.onconnection(utp, c)
      return
    }

    // Switch to slow pings to the other side, until they ping us back
    // with a connection
    while (!this.destroyed && !this.rawSocket) {
      await holepunch(socket, { host: rinfo.address, port: rinfo.port }, false)
      if (!this.destroyed && !this.rawSocket) await this._sleep(1000)
    }
  }

  reroll () {
    if (!this.rerolling) this.rerolling = this._reroll()
    return this.rerolling
  }

  async _reroll () {
    for (let i = 0; i < this.nat.type >= 2 && i < MAX_REROLLS && !this.destroyed; i++) {
      console.log('bad looking socket... try rerolling it')
      this._reset()
      await this.nat.analyzing
      if (this.destroyed) return false
      console.log('after reroll... nat=', this.nat.type)
    }
    return this.nat.type === 1
  }

  start () {
    if (!this.started) this.started = this._start()
    return this.started
  }

  async _start () {
    if (this.destroyed) return
    this.punching = true

    console.log('starting punching...', this.nat.type, this.remoteNat)

    // Note that most of these async functions are meant to run in the background
    // which is why we don't await them here and why they are not allowed to throw

    if (this.nat.type === 1 && this.remoteNat === 1) {
      this._consistentProbe()
    } else if (this.nat.type === 1 && this.remoteNat >= 2) {
      this._randomProbes()
    } else if (this.nat.type >= 2 && this.remoteNat === 1) {
      await this._openBirthdaySockets()
      if (this.punching) this._keepAliveRandomNat()
    }
  }

  async _consistentProbe () {
    while (this.punching) {
      // Here we do the sleep first because the "fast open" mode in the server just fired a ping
      if (!this.isInitiator) await this._sleep(1000)
      if (this.punching) await holepunch(this.socket, this.remoteAddress, false)
    }
  }

  // Note that this never throws so it is safe to run in the background
  async _randomProbes () {
    while (this.punching) {
      const addr = { host: this.remoteAddress.host, port: randomPort() }
      await holepunch(this.socket, addr, false)
      if (this.punching) await this._sleep(20)
    }
  }

  // Note that this never throws so it is safe to run in the background
  async _keepAliveRandomNat () {
    let i = 0
    let lowTTLRounds = 1

    // TODO: experiment with this here. We just bursted all the messages in
    // openOtherSockets to ensure the sockets are open, so it's potentially
    // a good idea to slow down for a bit.
    await this._sleep(100)

    while (this.punching) {
      if (i === this._allSockets.length) {
        i = 0
        if (lowTTLRounds > 0) lowTTLRounds--
      }

      await holepunch(this._allSockets[i++], this.remoteAddress, lowTTLRounds > 0)
      if (this.punching) await this._sleep(20)
    }
  }

  async _openBirthdaySockets () {
    while (this.punching && this._allSockets.length < BIRTHDAY_SOCKETS) {
      const socket = this._makeSocket()
      this._allSockets.push(socket)
      await holepunch(socket, this.remoteAddress, HOLEPUNCH_TTL)
    }
  }

  _sleep (ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  _makeSocket () {
    const socket = utp()
    socket.bind(0)
    socket.on('connection', this._onconnectionbound)
    if (!this.isInitiator) socket.firewall(false)
    const wrap = new SocketWrap(socket)
    wrap.on('message', this._onmessagebound)
    return wrap
  }

  ping (addr, socket = this.socket) {
    return holepunch(socket, addr, false)
  }

  openSession (addr, socket = this.socket) {
    return holepunch(socket, addr, true)
  }

  _shutdown (skip) {
    this.nat.destroy()
    this.punching = false
    for (const socket of this._allSockets) {
      if (socket === skip) continue
      socket.close()
    }
    if (skip) this._allSockets[0] = skip
    const len = skip ? 1 : 0
    while (this._allSockets.length > len) this._allSockets.pop()
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    if (this.rawSocket) this.rawSocket.destroy()
    this._onconnect(null)
    this._shutdown(null)
  }

  decryptPayload (buffer) {
    const state = { start: 24, end: buffer.byteLength - 16, buffer }

    if (state.end <= state.start) return null

    const nonce = buffer.subarray(0, 24)
    const msg = state.buffer.subarray(state.start, state.end)
    const cipher = state.buffer.subarray(state.start)

    if (!sodium.crypto_secretbox_open_easy(msg, cipher, nonce, this._sharedSecret)) return null

    try {
      return messages.holepunchPayload.decode(state)
    } catch {
      return null
    }
  }

  encryptPayload (payload) {
    const state = { start: 24, end: 24, buffer: null }
    messages.holepunchPayload.preencode(state, payload)
    state.buffer = Buffer.allocUnsafe(state.end + 16)

    const nonce = state.buffer.subarray(0, 24)
    const msg = state.buffer.subarray(state.start, state.end)
    const cipher = state.buffer.subarray(state.start)

    messages.holepunchPayload.encode(state, payload)
    sodium.randombytes_buf(nonce)
    sodium.crypto_secretbox_easy(cipher, msg, nonce, this._sharedSecret)

    return state.buffer
  }

  token (addr) {
    const out = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(out, Buffer.from(addr.host), this._secret)
    return out
  }
}

function holepunch (socket, addr, lowTTL) {
  return new Promise((resolve) => {
    socket.sendTTL(lowTTL ? HOLEPUNCH_TTL : DEFAULT_TTL, HOLEPUNCH, 0, 1, addr.port, addr.host, (err) => {
      resolve(!err)
    })
  })
}

function randomPort () {
  return 1000 + (Math.random() * 64536) | 0
}

function noop () {}
