const EventEmitter = require('events')
const b4a = require('b4a')
const errors = require('./errors')

module.exports = class ConnectionPool extends EventEmitter {
  constructor(dht) {
    super()

    this._dht = dht
    this._servers = new Map()
    this._connecting = new Map()
    this._connections = new Map()
  }

  _attachServer(server) {
    const keyString = b4a.toString(server.publicKey, 'hex')

    this._servers.set(keyString, server)

    server
      .on('close', () => {
        this._servers.delete(keyString)
      })
      .on('connection', (socket) => {
        this._attachStream(socket, true)
      })
  }

  _attachStream(stream, opened) {
    const existing = this.get(stream.remotePublicKey)

    if (existing) {
      const keepNew =
        stream.isInitiator === existing.isInitiator ||
        b4a.compare(stream.publicKey, stream.remotePublicKey) > 0

      if (keepNew) {
        let closed = false

        const onclose = () => {
          closed = true
        }

        existing
          .on('error', noop)
          .on('close', () => {
            if (closed) return

            stream.off('error', noop).off('close', onclose)

            this._attachStream(stream, opened)
          })
          .destroy(errors.DUPLICATE_CONNECTION())

        stream.on('error', noop).on('close', onclose)
      } else {
        stream.on('error', noop).destroy(errors.DUPLICATE_CONNECTION())
      }

      return
    }

    const keyString = b4a.toString(stream.remotePublicKey, 'hex')
    const session = new ConnectionRef(this, keyString, stream)

    if (opened) {
      this._connections.set(keyString, session)

      stream.on('close', () => session.gc())

      this.emit('connection', stream, session)
    } else {
      this._connecting.set(keyString, session)

      stream
        .on('error', noop)
        .on('close', () => session.gc())
        .on('open', () => {
          opened = true
          if (this._connecting.get(keyString) !== session) return

          this._connecting.delete(keyString)
          this._connections.set(keyString, session)

          stream.off('error', noop)

          this.emit('connection', stream, session)
        })
    }

    return session
  }

  get connecting() {
    return this._connecting.size
  }

  get connections() {
    return this._connections.values()
  }

  has(publicKey) {
    return this.get(publicKey) !== null
  }

  get(publicKey) {
    const keyString = b4a.toString(publicKey, 'hex')

    const existing = this._connections.get(keyString) || this._connecting.get(keyString)
    if (!existing) return null
    if (existing.destroying) {
      existing.gc()
      return null
    }

    return existing._stream
  }
}

class ConnectionRef {
  constructor(pool, keyString, stream) {
    this._pool = pool
    this.keyString = keyString
    this._stream = stream
    this._refs = 0
  }

  active() {
    this._refs++
  }

  inactive() {
    this._refs--
  }

  release() {
    this._stream.destroy()
  }

  get destroying() {
    return this._stream.destroying || this._stream.destroyed
  }

  gc() {
    if (this._pool._connections.get(this.keyString) === this) {
      this._pool._connections.delete(this.keyString)
    }

    if (this._pool._connecting.get(this.keyString) === this) {
      this._pool._connecting.delete(this.keyString)
    }
  }
}

function noop() {}
