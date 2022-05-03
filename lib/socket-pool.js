module.exports = class SocketPool {
  constructor (dht) {
    const self = this

    this._dht = dht
    this._socket = null

    this._sockets = new Set()
    this._free = new Set()
    this._pairers = new Map()
    this._ids = new Set()

    if (dht.io.serverSocket !== null) onlistening()
    else dht.once('listening', onlistening)

    function onlistening () {
      self._socket = new SocketHolder(self, { socket: dht.io.serverSocket })
    }
  }

  _onmessage (holder, data, address) {
    this._dht.onmessage(holder.socket, data, address)
  }

  _onpreconnect (holder, id, address) {
    const pairer = this._pairers.get(id)
    if (!pairer) return

    pairer(holder, { port: address.port, host: address.address })

    this._pairers.delete(id)
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

  connect (localId, remoteId, port, host) {
    return this._socket.connect(localId, remoteId, port, host)
  }

  pair (id, handler) {
    this._pairers.set(id, handler)
  }

  unpair (id) {
    this._pairers.delete(id)
  }

  destroy () {
    for (const holder of this._sockets) holder.socket.close()
  }

  reserveId () {
    while (true) {
      const id = (Math.random() * 0x100000000) >>> 0
      if (this._ids.has(id)) continue
      this._ids.add(id)
      return id
    }
  }

  releaseId (id) {
    return this._ids.delete(id)
  }
}

class SocketHolder {
  constructor (pool, options = {}) {
    const { socket } = options

    this._pool = pool

    this._streams = new Set()

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
      .on('preconnect', this._onpreconnect.bind(this))

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

  _onpreconnect (id, address) {
    this._pool._onpreconnect(this, id, address)
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

  connect (localId, remoteId, port, host) {
    const self = this

    const stream = this._pool._dht._udx.createStream(localId)
    this._streams.add(stream)

    stream
      .on('close', onclose)
      .connect(this.socket, remoteId, port, host)

    return stream

    function onclose () {
      self._streams.delete(stream)
      self._pool.releaseId(localId)
    }
  }

  release () {
    this._pool._free.add(this)
    this._reset()
  }
}

function noop () {}
