const b4a = require('b4a')

const MAX_LINGERS = 10
const LINGER_TIME = 3000

class SocketPool {
  constructor (dht) {
    this._dht = dht
    this._sockets = new Map()
    this._lingering = new Set() // updated by the ref
  }

  _onmessage (ref, data, address) {
    this._dht.onmessage(ref.socket, data, address)
  }

  _add (ref) {
    this._sockets.set(ref.socket, ref)
  }

  _remove (ref) {
    this._sockets.delete(ref.socket)
    this._lingering.delete(ref)
  }

  lookup (socket) {
    return this._sockets.get(socket) || null
  }

  acquire () {
    // TODO: Enable socket reuse
    return new SocketRef(this)
  }

  async destroy () {
    const closing = []

    for (const { timeout, socket } of this._sockets) {
      if (timeout) clearTimeout(timeout)
      closing.push(socket.close())
    }

    await Promise.allSettled(closing)
  }
}

class ConnectionPool {
  constructor (pool) {
    this._pool = pool
    this._routes = new Map()
  }

  add (publicKey, rawStream, socket) {
    const id = b4a.toString(publicKey, 'hex')

    let route = this._routes.get(id)

    if (!route) {
      route = {
        socket,
        address: { host: rawStream.remoteHost, port: rawStream.remotePort }
      }

      this._routes.set(id, route)
      socket.on('close', () => {
        this._routes.delete(id)
      })
    }

    rawStream.on('error', () => {
      const ref = this._pool.lookup(socket)
      if (ref) ref.linger = false
    })
  }

  get (publicKey) {
    const id = b4a.toString(publicKey, 'hex')
    const route = this._routes.get(id)
    if (!route) return null
    return route
  }
}

// TODO: we should just make some "user data" object on udx to allow to attach this info
class SocketRef {
  constructor (pool) {
    this._pool = pool

    // Events
    this.onholepunchmessage = noop

    // Whether it should teardown immediately or wait a bit
    this.linger = false
    this.timeout = null

    this.socket = pool._dht._udx.createSocket()
    this.socket
      .on('close', this._onclose.bind(this))
      .on('message', this._onmessage.bind(this))
      .on('idle', this._onidle.bind(this))
      .on('busy', this._onbusy.bind(this))
      .bind()

    this._refs = 1
    this._released = false
    this._closed = false

    // Only one destination supported atm
    this._publicKey = null

    this._pool._add(this)
  }

  _onclose () {
    this._pool._remove(this)
  }

  _onmessage (data, address) {
    if (data.byteLength > 1) {
      this._pool._onmessage(this, data, address)
    } else {
      this.onholepunchmessage(data, address, this)
    }
  }

  _onidle () {
    this._closeMaybe()
  }

  _onbusy () {
    this.linger = true
  }

  _reset () {
    this.onholepunchmessage = noop
  }

  _closeMaybe () {
    if (this._refs === 0 && this.socket.idle && !this.timeout) this._close()
  }

  _lingeringClose () {
    this._pool._lingering.delete(this)
    this.timeout = null
    this._closeMaybe()
  }

  _close () {
    console.log('...', this.linger)
    if (this.linger && this._pool._lingering.size < MAX_LINGERS) {
      this.linger = false
      this._pool._lingering.add(this)
      console.log('lingering socket...')
      this.timeout = setTimeout(this._lingeringClose.bind(this), LINGER_TIME)
      return
    }

    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
// console.log('fully closing')
    this._closed = true
    this.socket.close()
  }

  get free () {
    return this._refs === 0
  }

  active () {
    this._refs++

    if (this.timeout !== null) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
  }

  inactive () {
    this._refs--
    this._closeMaybe()
  }

  address () {
    return this.socket.address()
  }

  release () {
    if (this._released) return

    this._released = true
    this._reset()

    this._refs--
    this._closeMaybe()
  }
}

module.exports = { SocketPool, ConnectionPool }

function noop () {}
