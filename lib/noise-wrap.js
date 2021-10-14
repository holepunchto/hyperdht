const NoiseSecretStream = require('@hyperswarm/secret-stream')
const NoiseHandshake = require('noise-handshake')
const curve = require('noise-curve-ed')
const c = require('compact-encoding')
const messages = require('./messages')
const { NS } = require('./constants')

const NOISE_PROLOUGE = NS.PEER_HANDSHAKE

module.exports = class NoiseWrap {
  constructor (keyPair, remotePublicKey) {
    this.isInitiator = !!remotePublicKey
    this.remotePublicKey = remotePublicKey
    this.keyPair = keyPair
    this.handshake = new NoiseHandshake('IK', this.isInitiator, keyPair, { curve })
    this.handshake.initialise(NOISE_PROLOUGE, remotePublicKey)
  }

  send (payload) {
    const buf = c.encode(messages.noisePayload, payload)
    return this.handshake.send(buf)
  }

  recv (buf) {
    let payload = null

    try {
      payload = c.decode(messages.noisePayload, this.handshake.recv(buf))
    } catch {
      return null
    }

    this.remotePublicKey = toBuffer(this.handshake.rs)
    return payload
  }

  final () {
    if (!this.handshake.complete) throw new Error('Handshake did not finish')

    return {
      isInitiator: this.isInitiator,
      publicKey: this.keyPair.publicKey,
      remotePublicKey: this.remotePublicKey,
      remoteId: NoiseSecretStream.id(this.handshake.hash, !this.isInitiator),
      hash: toBuffer(this.handshake.hash),
      rx: toBuffer(this.handshake.rx),
      tx: toBuffer(this.handshake.tx)
    }
  }
}

function toBuffer (uint) {
  return Buffer.from(uint.buffer, uint.byteOffset, uint.byteLength)
}
