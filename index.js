const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const KAT = require('./kat')

module.exports = class HyperDHT extends DHT {
  constructor (opts) {
    super(opts)

    this.kat = new KAT(this)
    this.on('request', this._ondhtrequest)
    this.on('persistent', this._ondhtpersistent)
  }

  _ondhtpersistent () {
    this.kat.onpersistent()
  }

  _ondhtrequest (req) {
    switch (req.command) {
      case 'kat_lookup': return this.kat.onlookup(req)
      case 'kat_announce': return this.kat.onannounce(req)
      case 'kat_session': return this.kat.onsession(req)
      case 'kat_keep_alive': return this.kat.onkeepalive(req)
      case 'kat_connect': return this.kat.onconnect(req)
      case 'kat_relay_connect': return this.kat.onrelayconnect(req)
      case 'kat_holepunch': return this.kat.onholepunch(req)
      case 'kat_relay_holepunch': return this.kat.onrelayholepunch(req)
    }

    req.error(DHT.UNKNOWN_COMMAND)
  }

  static keyPair () {
    const publicKey = Buffer.alloc(32)
    const secretKey = Buffer.alloc(64)
    sodium.crypto_sign_keypair(publicKey, secretKey)
    return { publicKey, secretKey }
  }

}
