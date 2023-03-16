const { hash, createKeyPair } = require('./lib/crypto')

module.exports = class Stub {
  constructor () {
    throw new Error('hyperdht is not supported in browsers')
  }

  static keyPair (seed) {
    return createKeyPair(seed)
  }

  static hash (data) {
    return hash(data)
  }
}
