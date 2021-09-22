const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const SocketPairer = require('./lib/socket-pairer')
const Router = require('./lib/route')
const Server = require('./lib/server')
const { dual } = require('bind-easy')

const BOOTSTRAP_NODES = [
  { host: '88.99.3.86', port: 10001 }
]

module.exports = class HyperDHT extends DHT {
  constructor (opts = {}) {
    super({ bootstrap: BOOTSTRAP_NODES, ...opts, bind })

    const self = this
    const port = opts.port || opts.bind || 49737

    this._router = new Router(this)
    this._sockets = null

    async function bind () {
      const { server, socket } = await dual(port)
      self._sockets = new SocketPairer(self, server)
      return socket
    }
  }

  createServer (opts, onconnection) {
    if (typeof opts === 'function') return this.createServer({}, opts)
    const s = new Server(this, opts)
    if (onconnection) s.on('connection', onconnection)
    return s
  }

  onrequest (req) {
    switch (req.command) {
      case 'lookup': {
        this._onlookup(req)
        break
      }
      case 'announce': {
        this._onannounce(req)
        break
      }
      case 'unannounce': {
        this._onunannounce(req)
        break
      }
      case 'find_peer': {
        this._onfindpeer(req)
        break
      }
      case 'connect': {
        this._router.onconnect(req)
        break
      }
      case 'holepunch': {
        this._router.onholepunch(req)
        break
      }
      default: {
        return false
      }
    }

    return true
  }

  _onfindpeer (req) {
    if (!req.target) return

    const r = this._router.get(req.target)

    if (r) {
      req.reply(Buffer.from('ok'))
      return
    }

    req.reply(null)
  }

  _onlookup (req) {
    if (!req.target) return

    const a = this._router.get(req.target)
    console.log('onlookup', !!a)

    req.reply(null)
  }

  _onunannounce (req) {
    if (!req.target) return
    const existing = this._router.get(req.target)
    if (existing) {
      clearTimeout(existing.timeout)
      this._router.delete(req.target)
    }
    req.reply(null)
  }

  _onannounce (req) {
    if (!req.target || !req.token) return

    const existing = this._router.get(req.target)
    if (existing) {
      clearTimeout(existing.timeout)
    }

    const c = {
      relay: req.from,
      server: null,
      timeout: null
    }

    c.timeout = setTimeout(() => {
      if (this._router.get(req.target) === c) {
        this._router.delete(req.target)
      }
    }, 10 * 60 * 1000)

    this._router.set(req.target, c)

    req.reply(null)
  }

  static keyPair (seed) {
    return createKeyPair(seed)
  }
}

function createKeyPair (seed) {
  const publicKey = Buffer.alloc(32)
  const secretKey = Buffer.alloc(64)
  if (seed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  else sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}
