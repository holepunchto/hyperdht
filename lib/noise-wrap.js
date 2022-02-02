const NoiseSecretStream = require('@hyperswarm/secret-stream')
const NoiseHandshake = require('noise-handshake')
const curve = require('noise-curve-ed')
const c = require('compact-encoding')
const b4a = require('b4a')
const sodium = require('sodium-universal')
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
    const payload = c.decode(messages.noisePayload, this.handshake.recv(buf))
    this.remotePublicKey = b4a.toBuffer(this.handshake.rs)
    return payload
  }

  final () {
    if (!this.handshake.complete) throw new Error('Handshake did not finish')

    const holepunchSecret = Buffer.allocUnsafe(32)

    sodium.crypto_generichash(holepunchSecret, this.handshake.hash, NS.PEER_HOLEPUNCH)

    return {
      isInitiator: this.isInitiator,
      publicKey: this.keyPair.publicKey,
      remotePublicKey: this.remotePublicKey,
      remoteId: NoiseSecretStream.id(this.handshake.hash, !this.isInitiator),
      holepunchSecret,
      hash: b4a.toBuffer(this.handshake.hash),
      rx: b4a.toBuffer(this.handshake.rx),
      tx: b4a.toBuffer(this.handshake.tx)
    }
  }
}
