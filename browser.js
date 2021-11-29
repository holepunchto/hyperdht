module.exports = class Stub {
  constructor () {
    throw new Error('@hyperswarm/dht is not supported in browsers')
  }
}
