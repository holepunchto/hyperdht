const EventEmitter = require('events')
const utp = require('utp-native')
const sodium = require('sodium-universal')
const Nat = require('./nat')
const messages = require('./messages')

const BIRTHDAY_SOCKETS = 256
const HOLEPUNCH = Buffer.from([0])
const HOLEPUNCH_TTL = 5
const DEFAULT_TTL = 64

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
  constructor (dht, handshakeHash) {
    this.dht = dht
    this.sharedSecret = Buffer.allocUnsafe(32)
    this.secret = Buffer.allocUnsafe(32)

    sodium.randombytes_buf(this.secret)
    sodium.crypto_generichash(this.sharedSecret, handshakeHash, NS_HOLEPUNCH)

    this.started = null

    // track remote state
    this.remoteNat = 0
    this.remoteHolepunching = false
    this.remoteAddress = null
    this.remoteVerified = false

    this.socket = null
    this.nat = null

    this.reset()
  }

  reset () {
    if (this.socket !== null) {
      throw new Error('TODO: implement reset socket logic')
    }

    const dht = this.dht
    const self = this

    const socket = utp()
    socket.bind(0)

    this.socket = new SocketWrap(socket)
    this.socket.on('message', function (buf, rinfo) {
      if (buf.byteLength > 1) dht.onmessage(this, buf, rinfo)
      else self.onmessage(this, buf, rinfo)
    })

    this.nat = new Nat(this.dht, this.socket)

    // TODO: maybe make auto sampling configurable somehow?
    this.nat.autoSample()
  }

  onmessage (socket, buf, rinfo) {
    console.log('got holepunch releated message from', rinfo)
  }

  start () {
    if (this.started) return this.started
    this.started = this._start()
    return this.started
  }

  async _start () {
    console.log('starting punching...')
  }

  ping (addr, socket = this.socket) {
    return holepunch(socket, addr, false)
  }

  openSession (addr, socket = this.socket) {
    return holepunch(socket, addr, true)
  }

  destroy () {
    this.nat.destroy()
    this.socket.close()
  }

  decryptPayload (buffer) {
    const state = { start: 24, end: buffer.byteLength - 16, buffer }

    if (state.end <= state.start) return null

    const nonce = buffer.subarray(0, 24)
    const msg = state.buffer.subarray(state.start, state.end)
    const cipher = state.buffer.subarray(state.start)

    if (!sodium.crypto_secretbox_open_easy(msg, cipher, nonce, this.sharedSecret)) return null

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
    sodium.crypto_secretbox_easy(cipher, msg, nonce, this.sharedSecret)

    return state.buffer
  }

  token (addr) {
    const out = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(out, Buffer.from(addr.host), this.secret)
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
