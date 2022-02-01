const sodium = require('sodium-universal')
const b4a = require('b4a')
const { holepunchPayload } = require('./messages')

module.exports = class HolepunchPayload {
  constructor (holepunchSecret) {
    this._sharedSecret = holepunchSecret
    this._localSecret = b4a.allocUnsafe(32)

    sodium.randombytes_buf(this._localSecret)
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
    state.buffer = b4a.allocUnsafe(state.end + 16)

    const nonce = state.buffer.subarray(0, 24)
    const msg = state.buffer.subarray(state.start, state.end)
    const cipher = state.buffer.subarray(state.start)

    holepunchPayload.encode(state, payload)
    sodium.randombytes_buf(nonce)
    sodium.crypto_secretbox_easy(cipher, msg, nonce, this._sharedSecret)

    return state.buffer
  }

  token (addr) {
    const out = b4a.allocUnsafe(32)
    sodium.crypto_generichash(out, b4a.from(addr.host), this._localSecret)
    return out
  }
}
