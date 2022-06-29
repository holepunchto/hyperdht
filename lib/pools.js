const b4a = require('b4a')

class SocketPool {
  constructor (dht) {
    this._dht = dht
    this._sockets = new Map()
  }

  _onmessage (ref, data, address) {
    this._dht.onmessage(ref.socket, data, address)
  }

  _add (ref) {
    this._sockets.set(ref.socket, ref)
  }

  _remove (ref) {
    this._sockets.delete(ref.socket)
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
    this._byPublicKey = new Map()
  }

  add (encryptedStream) {
    const id = b4a.toString(encryptedStream.remotePublicKey.publicKey)

    let all = this._byPublicKey.get(id)

    if (!all) {
      all = []
      this._byPublicKey.set(id, all)
    }

    // usually very small, so just using an array
    all.push(encryptedStream)

    encryptedStream.on('close', () => {
      const i = all.indexOf(encryptedStream)
      if (i > -1) all.splice(i, 1)
      if (all.length > 0) return

      this._byPublicKey.delete(id)

      const errored = !!(encryptedStream._readableState.error || encryptedStream._writableState.error)
      if (errored) return

      const ref = this._pool.lookup(encryptedStream.rawStream.socket)
      if (ref) ref.linger = true
    })
  }

  get (publicKey) {
    const id = b4a.toString(publicKey)
    const all = this._byPublicKey.get(id)
    if (!all) return null
    return all[all.length - 1]
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
    if (this.free) this._close()
  }

  _reset () {
    this.onholepunchmessage = noop
  }

  _closeMaybe () {
    if (this._refs === 0 && this.socket.idle) this._close()
  }

  _close () {
    if (this.linger) {
      this.linger = false
      this.timeout = setTimeout(this._closeMaybe.bind(this), 5000)
      return
    }
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
