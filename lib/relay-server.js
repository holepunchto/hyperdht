const { EventEmitter } = require('events')
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

    this._server.once('close', () => {
      if (this.closed) return
      this.closed = true
      if (!this._closing) this._relay.close().catch(noop)
      this.emit('close')
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

  address() {
    return this._server.address()
  }

  async listen(keyPair = this.dht.defaultKeyPair, opts = {}) {
    await this._server.listen(keyPair, opts)
    this.emit('listening')
    return this
  }

  close() {
    if (this._closing) return this._closing
    this._closing = this._close()
    return this._closing
  }

  async _close() {
    await this._server.close()
    await this._relay.close()

    if (!this.closed) {
      this.closed = true
      this.emit('close')
    }
  }

  _onconnection(socket) {
    if (this.closed) {
      socket.destroy()
      return
    }

    const session = this._relay.accept(socket, { id: socket.remotePublicKey })

    session.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', err)
    })

    this.emit('session', session, socket)
  }
}

function noop() {}
