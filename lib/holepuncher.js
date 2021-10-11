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

// TODO: It is really annoying that we have to deal with lowTTL being stateful
// we should research if we get around that somehow with some native code

module.exports = class Holepuncher {
  constructor (dht, handshakeHash) {
    this.dht = dht
    this.sharedSecret = Buffer.allocUnsafe(32)
    this.secret = Buffer.allocUnsafe(32)
    this.paused = 0

    sodium.randombytes_buf(this.secret)
    sodium.crypto_generichash(this.sharedSecret, handshakeHash, NS_HOLEPUNCH)

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

    this.socket = utp()
    this.socket.on('message', function (buf, rinfo) {
      if (buf.byteLength > 1) dht.onmessage(this, buf, rinfo)
      else self.onmessage(this, buf, rinfo)
    })

    this.nat = new Nat(this.dht, this.socket)

    // Always do eager auto sampling for now...
    this.nat.autoSample()
  }

  onmessage (socket, buf, rinfo) {
    console.log('got holepunch releated message from', rinfo)
  }

  ping (addr, socket = this.socket) {
    return holepunch(socket, addr, false)
  }

  openSession (addr, socket = this.socket) {
    return holepunch(socket, addr, true)
  }

  punch () {
    console.log('ready to punch big time')
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
    if (lowTTL) socket.setTTL(HOLEPUNCH_TTL)
    socket.send(HOLEPUNCH, 0, 1, addr.port, addr.host, (err) => {
      if (lowTTL) socket.setTTL(DEFAULT_TTL)
      resolve(!err)
    })
  })
}
