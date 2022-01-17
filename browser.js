const sodium = require('sodium-universal')
const Buffer = require('b4a')

module.exports = class DHT {
  constructor () {
    throw new Error(
      'Cannot use DHT in a browser context, use a dht-relay instead'
    )
  }

  static keyPair (seed) {
    const publicKey = Buffer.alloc(32)
    const secretKey = Buffer.alloc(64)
    if (seed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
    else sodium.crypto_sign_keypair(publicKey, secretKey)
    return { publicKey, secretKey }
  }
}
