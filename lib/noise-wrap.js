const NoiseSecretStream = require('noise-secret-stream')
const NoiseHandshake = require('noise-handshake')
const curve = require('noise-curve-ed')
const c = require('compact-encoding')
const messages = require('./messages')

const NOISE_PROLOUGE = Buffer.alloc(0)

module.exports = class NoiseWrap {
  constructor (keyPair, remotePublicKey) {
    this.isInitiator = !!remotePublicKey
    this.keyPair = keyPair
    this.handshake = new NoiseHandshake('IK', this.isInitiator, keyPair, { curve })
    this.handshake.initialise(NOISE_PROLOUGE, remotePublicKey)
  }

  send (payload) {
    const buf = c.encode(messages.noisePayload, payload)
    return this.handshake.send(buf)
  }

  recv (buf) {
    try {
      return c.decode(messages.noisePayload, this.handshake.recv(buf))
    } catch {
      return null
    }
  }

  final () {
    return {
      isInitiator: this.isInitiator,
      id: NoiseSecretStream.id(this.handshake.hash),
      publicKey: this.keyPair.publicKey,
      remotePublicKey: toBuffer(this.handshake.rs),
      hash: toBuffer(this.handshake.hash),
      rx: toBuffer(this.handshake.rx),
      tx: toBuffer(this.handshake.tx)
    }
  }
}

function toBuffer (uint) {
  return Buffer.from(uint.buffer, uint.byteOffset, uint.byteLength)
}
