const sodium = require('sodium-universal')
const { holepunchPayload } = require('./messages')

const NS_HOLEPUNCH = Buffer.alloc(32)
sodium.crypto_generichash(NS_HOLEPUNCH, Buffer.from('hyperswarm_holepunch'))

module.exports = class HolepunchPayload {
  constructor (handshakeHash) {
    this._sharedSecret = Buffer.allocUnsafe(32)
    this._localSecret = Buffer.allocUnsafe(32)

    sodium.randombytes_buf(this._localSecret)
    sodium.crypto_generichash(this._sharedSecret, handshakeHash, NS_HOLEPUNCH)
  }

  decrypt (buffer) {
    const state = { start: 24, end: buffer.byteLength - 16, buffer }

    if (state.end <= state.start) return null

    const nonce = buffer.subarray(0, 24)
    const msg = state.buffer.subarray(state.start, state.end)
    const cipher = state.buffer.subarray(state.start)

    if (!sodium.crypto_secretbox_open_easy(msg, cipher, nonce, this._sharedSecret)) return null

    try {
      return holepunchPayload.decode(state)
    } catch {
      return null
    }
  }

  encrypt (payload) {
    const state = { start: 24, end: 24, buffer: null }
    holepunchPayload.preencode(state, payload)
    state.buffer = Buffer.allocUnsafe(state.end + 16)

    const nonce = state.buffer.subarray(0, 24)
    const msg = state.buffer.subarray(state.start, state.end)
    const cipher = state.buffer.subarray(state.start)

    holepunchPayload.encode(state, payload)
    sodium.randombytes_buf(nonce)
    sodium.crypto_secretbox_easy(cipher, msg, nonce, this._sharedSecret)

    return state.buffer
  }

  token (addr) {
    const out = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(out, Buffer.from(addr.host), this._localSecret)
    return out
  }
}
