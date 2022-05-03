module.exports = class SocketPool {
  constructor (dht) {
    const self = this

    this._dht = dht
    this._socket = null

    this._sockets = new Set()
    this._free = new Set()

    if (dht.io.serverSocket !== null) onlistening()
    else dht.once('listening', onlistening)

    function onlistening () {
      self._socket = new SocketHolder(self, { socket: dht.io.serverSocket })
    }
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

  acquire () {
    let [socket] = this._free

    if (socket) this._free.delete(socket)
    else socket = new SocketHolder(this)

    return socket
  }

  destroy () {
    for (const holder of this._sockets) holder.socket.close()
  }
}

class SocketHolder {
  constructor (pool, options = {}) {
    const { socket } = options

    this._pool = pool

    // Events
    this.onholepunchmessage = noop

    if (socket) this.socket = socket
    else {
      this.socket = pool._dht._udx.createSocket()
      this.socket
        .on('message', this._onmessage.bind(this))
        .bind()
    }

    this.socket
      .on('close', this._onclose.bind(this))

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

  _reset () {
    this.onholepunchmessage = noop
  }

  get free () {
    return this._pool._free.has(this)
  }

  address () {
    return this.socket.address()
  }

  release () {
    this._pool._free.add(this)
    this._reset()
  }
}

function noop () {}
