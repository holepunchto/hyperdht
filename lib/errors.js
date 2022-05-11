module.exports = class DHTError extends Error {
  constructor (msg, code) {
    super(`${code}: ${msg}`)
    this.code = code

    if (Error.captureStackTrace) {
      const ctor = this.constructor
      Error.captureStackTrace(this, ctor[code] || ctor)
    }
  }

  get name () {
    return 'DHTError'
  }

  static BAD_HANDSHAKE_REPLY (msg = 'Bad handshake reply') {
    return new DHTError(msg, 'BAD_HANDSHAKE_REPLY')
  }

  static BAD_HOLEPUNCH_REPLY (msg = 'Bad holepunch reply') {
    return new DHTError(msg, 'BAD_HOLEPUNCH_REPLY')
  }

  static HANDSHAKE_UNFINISHED (msg = 'Handshake did not finish') {
    return new DHTError(msg, 'HANDSHAKE_UNFINISHED')
  }

  static ALREADY_LISTENING (msg = 'Already listening') {
    return new DHTError(msg, 'ALREADY_LISTENING')
  }

  static NODE_DESTROYED (msg = 'Node destroyed') {
    return new DHTError(msg, 'NODE_DESTROYED')
  }
}
