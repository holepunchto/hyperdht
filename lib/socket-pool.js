const b4a = require('b4a')

const LINGER_TIME = 3000

module.exports = class SocketPool {
  constructor (dht, host) {
    this._dht = dht
    this._sockets = new Map()
    this._lingering = new Set() // updated by the ref
    this._host = host

    this.routes = new SocketRoutes(this)
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

  setReusable (socket, bool) {
    const ref = this.lookup(socket)
    if (ref) ref.reusable = bool
  }

  acquire () {
    // TODO: Enable socket reuse
    return new SocketRef(this)
  }

  async destroy () {
    const closing = []

    for (const ref of this._sockets.values()) {
      ref._unlinger()
      closing.push(ref.socket.close())
    }

    await Promise.allSettled(closing)
  }
}

class SocketRoutes {
  constructor (pool) {
    this._pool = pool
    this._routes = new Map()
  }

  add (publicKey, rawStream) {
    if (rawStream.socket) this._onconnect(publicKey, rawStream)
    else rawStream.on('connect', this._onconnect.bind(this, publicKey, rawStream))
  }

  get (publicKey) {
    const id = b4a.toString(publicKey, 'hex')
    const route = this._routes.get(id)
    if (!route) return null
    return route
  }

  _onconnect (publicKey, rawStream) {
    const id = b4a.toString(publicKey, 'hex')
    const socket = rawStream.socket

    let route = this._routes.get(id)

    if (!route) {
      const gc = () => {
        if (this._routes.get(id) === route) this._routes.delete(id)
        socket.removeListener('close', gc)
      }

      route = {
        socket,
        address: { host: rawStream.remoteHost, port: rawStream.remotePort },
        gc
      }

      this._routes.set(id, route)
      socket.on('close', gc)
    }

    this._pool.setReusable(socket, true)

    rawStream.on('error', () => {
      this._pool.setReusable(socket, false)
      if (!route) route = this._routes.get(id)
      if (route && route.socket === socket) route.gc()
    })
  }
}

// TODO: we should just make some "user data" object on udx to allow to attach this info
class SocketRef {
  constructor (pool) {
    this._pool = pool

    // Events
    this.onholepunchmessage = noop

    // Whether it should teardown immediately or wait a bit
    this.reusable = false

    this.socket = pool._dht.udx.createSocket()
    this.socket
      .on('close', this._onclose.bind(this))
      .on('message', this._onmessage.bind(this))
      .on('idle', this._onidle.bind(this))
      .on('busy', this._onbusy.bind(this))
      .bind(0, this._pool._host)

    this._refs = 1
    this._released = false
    this._closed = false

    this._timeout = null
    this._wasBusy = false

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
    this._wasBusy = true
    this._unlinger()
  }

  _reset () {
    this.onholepunchmessage = noop
  }

  _closeMaybe () {
    if (this._refs === 0 && this.socket.idle && !this._timeout) this._close()
  }

  _lingeringClose () {
    this._pool._lingering.delete(this)
    this._timeout = null
    this._closeMaybe()
  }

  _close () {
    this._unlinger()

    if (this.reusable && this._wasBusy) {
      this._wasBusy = false
      this._pool._lingering.add(this)
      this._timeout = setTimeout(this._lingeringClose.bind(this), LINGER_TIME)
      return
    }

    this._closed = true
    this.socket.close()
  }

  _unlinger () {
    if (this._timeout !== null) {
      clearTimeout(this._timeout)
      this._pool._lingering.delete(this)
      this._timeout = null
    }
  }

  get free () {
    return this._refs === 0
  }

  active () {
    this._refs++
    this._unlinger()
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

function noop () {}
