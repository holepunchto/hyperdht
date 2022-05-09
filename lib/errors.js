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
}
