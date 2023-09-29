const EventEmitter = require('events')
const b4a = require('b4a')
const errors = require('./errors')

module.exports = class ConnectionPool extends EventEmitter {
  constructor (dht) {
    super()

    this._dht = dht
    this._servers = new Map()
    this._connecting = new Map()
    this._connections = new Map()
  }

  _attachServer (server) {
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

  _attachStream (stream, opened) {
    const existing = this.get(stream.remotePublicKey)

    if (existing) {
      const keepNew = stream.isInitiator === existing.isInitiator || b4a.compare(stream.publicKey, stream.remotePublicKey) > 0

      if (keepNew) {
        let closed = false

        const onclose = () => {
          closed = true
        }

        existing
          .on('error', noop)
          .on('close', () => {
            if (closed) return

            stream
              .off('error', noop)
              .off('close', onclose)

            this._attachStream(stream, opened)
          })
          .destroy(errors.DUPLICATE_CONNECTION())

        stream
          .on('error', noop)
          .on('close', onclose)
      } else {
        stream
          .on('error', noop)
          .destroy(errors.DUPLICATE_CONNECTION())
      }

      return
    }

    const session = new ConnectionRef(this, stream)

    const keyString = b4a.toString(stream.remotePublicKey, 'hex')

    if (opened) {
      this._connections.set(keyString, session)

      stream.on('close', () => {
        this._connections.delete(keyString)
      })

      this.emit('connection', stream, session)
    } else {
      this._connecting.set(keyString, session)

      stream
        .on('error', noop)
        .on('close', () => {
          if (opened) this._connections.delete(keyString)
          else this._connecting.delete(keyString)
        })
        .on('open', () => {
          opened = true

          this._connecting.delete(keyString)
          this._connections.set(keyString, session)

          stream.off('error', noop)

          this.emit('connection', stream, session)
        })
    }

    return session
  }

  get connecting () {
    return this._connecting.size
  }

  get connections () {
    return this._connections.values()
  }

  has (publicKey) {
    const keyString = b4a.toString(publicKey, 'hex')

    return this._connections.has(keyString) || this._connecting.has(keyString)
  }

  get (publicKey) {
    const keyString = b4a.toString(publicKey, 'hex')

    const existing = this._connections.get(keyString) || this._connecting.get(keyString)

    return existing?._stream || null
  }
}

class ConnectionRef {
  constructor (pool, stream) {
    this._pool = pool
    this._stream = stream
    this._refs = 0
  }

  active () {
    this._refs++
  }

  inactive () {
    this._refs--
  }

  release () {
    this._stream.destroy()
  }
}

function noop () {}
