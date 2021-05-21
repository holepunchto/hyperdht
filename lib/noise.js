const cenc = require('compact-encoding')
const sodium = require('sodium-universal')
const { getHandshakeHash } = require('noise-protocol/symmetric-state')
const noiseProtocol = require('noise-protocol')
const messages = require('./messages')

const EMPTY = Buffer.alloc(0)

module.exports = class NoiseState {
  constructor (keyPair, remotePublicKey) {
    this.isInitiator = !!remotePublicKey
    this.request = null
    this.response = null
    this.publicKey = keyPair.publicKey
    this.remotePublicKey = remotePublicKey
    this.handshakeHash = null
    this.tx = null
    this.rx = null
    this.noise = noiseProtocol.initialize('IK', this.isInitiator, EMPTY, keyPair, null, remotePublicKey)
  }

  send (payload) {
    const localNoisePayload = cenc.encode(messages.noisePayload, payload)
    const buf = Buffer.allocUnsafe(128 + localNoisePayload.byteLength)

    const split = noiseProtocol.writeMessage(this.noise, localNoisePayload, buf)
    if (split) this._onhandshake(split)

    this.response = buf.subarray(0, noiseProtocol.writeMessage.bytes)

    return this.response
  }

  recv (request, autoDestroy = true) {
    const remoteNoisePayload = Buffer.allocUnsafe(request.byteLength)

    try {
      const split = noiseProtocol.readMessage(this.noise, request, remoteNoisePayload)
      if (split) this._onhandshake(split)
    } catch {
      if (autoDestroy) this.destroy()
      return null
    }

    this.request = request
    if (this.remotePayloadKey === null) this.remotePublicKey = Buffer.from(this.noise.rs)

    try {
      return messages.noisePayload.decode({ start: 0, end: noiseProtocol.readMessage.bytes, buffer: remoteNoisePayload })
    } catch {
      return null
    }
  }

  destroy () {
    if (this.noise) noiseProtocol.destroy(this.noise)
    this.noise = null
  }

  _onhandshake (split) {
    const tx = Buffer.from(split.tx)
    const rx = Buffer.from(split.rx)
    const handshakeHash = Buffer.allocUnsafe(64)

    getHandshakeHash(this.noise.symmetricState, handshakeHash)

    sodium.sodium_free(split.tx)
    sodium.sodium_free(split.rx)

    this.handshakeHash = handshakeHash
    this.tx = tx
    this.rx = rx

    this.destroy()
  }
}
