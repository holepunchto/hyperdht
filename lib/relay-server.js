const { EventEmitter, once } = require('events')
const { Server: BlindRelayServer } = require('blind-relay')

module.exports = class RelayServer extends EventEmitter {
  constructor(dht, opts = {}) {
    super()

    this.dht = dht
    this.closed = false

    this._server = dht.createServer(this._onconnection.bind(this))
    this._relay = new BlindRelayServer({
      createStream:
        opts.createStream || ((streamOpts) => dht.createRawStream({ ...streamOpts, framed: true }))
    })
    this._closing = null
    this._serverClosed = false

    this._server.once('close', () => {
      this._serverClosed = true

      if (this._closing) return

      this._closing = this._closeRelay(false)
      this._closing.catch((err) => {
        if (this.listenerCount('error') > 0) this.emit('error', err)
      })
    })
  }

  get listening() {
    return this._server.listening
  }

  get publicKey() {
    return this._server.publicKey
  }

  get sessions() {
    return this._relay.sessions
  }

  get stats() {
    return this._relay.stats
  }

  address() {
    return this._server.address()
  }

  async listen(keyPair = this.dht.defaultKeyPair, opts = {}) {
    await this._server.listen(keyPair, opts)
    this.emit('listening')
    return this
  }

  close(opts = {}) {
    if (this._closing) return this._closing
    this._closing = this._close(!!opts.force)
    return this._closing
  }

  async _close(force) {
    if (!this._serverClosed) {
      await this._server.close()
    }

    await this._closeRelay(force)
  }

  async _closeRelay(force) {
    if (force) await this._forceCloseRelay()
    else await this._relay.close()

    if (!this.closed) {
      this.closed = true
      this.emit('close')
    }
  }

  _onconnection(socket) {
    if (this.closed || this._closing) {
      socket.destroy()
      return
    }

    const session = this._relay.accept(socket, { id: socket.remotePublicKey })

    session.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', err)
    })

    this.emit('session', session, socket)
  }

  async _forceCloseRelay() {
    const sessions = [...this._relay.sessions]
    const closing = []

    for (const session of sessions) {
      if (!session.closed) closing.push(once(session, 'close'))

      session.destroy()

      if (session.stream && !session.stream.destroyed) {
        session.stream.on('error', noop)
        session.stream.destroy()
      }
    }

    await Promise.allSettled(closing)
    await this._relay.close()
  }
}

function noop() {}
