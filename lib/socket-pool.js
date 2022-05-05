const { once } = require('events')

module.exports = class SocketPool {
  constructor (dht) {
    this._dht = dht

    this._sockets = new Set()
    this._free = new Set()
  }

  _onmessage (holder, data, address) {
    this._dht.onmessage(holder.socket, data, address)
  }

  _add (holder) {
    this._sockets.add(holder)
  }

  _remove (holder) {
    this._sockets.delete(holder)
    this._free.delete(holder)
  }

  _release (holder) {
    if (this._sockets.has(holder)) this._free.add(holder)
  }

  acquire () {
    return new SocketHolder(this)

    // TODO: Enable socket reuse

    // let [socket] = this._free

    // if (socket) this._free.delete(socket)
    // else socket = new SocketHolder(this)

    // return socket
  }

  async destroy () {
    const closing = []

    for (const { socket } of this._sockets) {
      socket.close()
      closing.push(once(socket, 'close'))
    }

    await Promise.allSettled(closing)
  }
}

class SocketHolder {
  constructor (pool) {
    this._pool = pool

    // Events
    this.onholepunchmessage = noop

    this.socket = pool._dht._udx.createSocket()
    this.socket
      .on('close', this._onclose.bind(this))
      .on('message', this._onmessage.bind(this))
      .on('idle', this._onidle.bind(this))
      .bind()

    this._pool._add(this)
  }

  _onclose () {
    this._pool._remove(this)
  }

  _onmessage (data, address) {
    if (data.byteLength > 1) {
      this._pool._onmessage(this, data, address)
    } else {
      this.onholepunchmessage(data, { port: address.port, host: address.address }, this)
    }
  }

  _onidle () {
    if (this.free) this._close()
  }

  _reset () {
    this.onholepunchmessage = noop
  }

  _close () {
    this._pool._free.delete(this)
    this.socket.close()
  }

  get free () {
    return this._pool._free.has(this)
  }

  address () {
    return this.socket.address()
  }

  release () {
    this._reset()

    if (this.socket.idle) this._close()
    else this._pool._release(this)
  }
}

function noop () {}
