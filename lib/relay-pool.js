const { EventEmitter } = require('events')
const b4a = require('b4a')
const relay = require('blind-relay')

// Direct upgrade is observed locally first; keep the relay pairing briefly so
// the peer can finish switching direct before the relay receives an unpair.
const DIRECT_UPGRADE_UNPAIR_DELAY = 10000

module.exports = class RelayPool {
  constructor(dht) {
    this._dht = dht
    this._connections = new Map()
  }

  pair(publicKey, opts) {
    return this._get(publicKey, opts.keepAlive).pair(opts)
  }

  async destroy() {
    const closing = []

    for (const connection of this._connections.values()) {
      closing.push(connection.destroy())
    }

    await Promise.allSettled(closing)
  }

  _get(publicKey, keepAlive) {
    const keyString = b4a.toString(publicKey, 'hex')
    let connection = this._connections.get(keyString)

    if (connection && !connection.reusable) {
      connection.destroy().catch(noop)
      connection = null
    }

    if (!connection) {
      connection = new RelayPoolConnection(this, keyString, publicKey, keepAlive)
      this._connections.set(keyString, connection)
    } else {
      connection.setKeepAlive(keepAlive)
    }

    return connection
  }

  _delete(connection) {
    if (this._connections.get(connection.keyString) === connection) {
      this._connections.delete(connection.keyString)
    }
  }
}

class RelayPoolConnection {
  constructor(pool, keyString, publicKey, keepAlive) {
    this.pool = pool
    this.keyString = keyString
    this.socket = pool._dht.connect(publicKey)
    this.client = relay.Client.from(this.socket, { id: this.socket.publicKey })
    this.pairings = new Map()
    this.pendingReleaseTimers = new Set()
    this.destroyed = false
    this.keepAlive = keepAlive

    this._onclose = this._onclose.bind(this)
    this.socket.once('close', this._onclose)
    this.socket.on('error', noop)
    this.socket.setKeepAlive(this.keepAlive)
  }

  get reusable() {
    return (
      !this.destroyed && !this.socket.destroyed && !this.socket.destroying && !this.client.closed
    )
  }

  pair({ isInitiator, token, stream }) {
    const request = this.client.pair(isInitiator, token, stream)
    const pairing = new RelayPoolPairing(this, token, request)

    this.pairings.set(pairing.keyString, pairing)

    return pairing
  }

  setKeepAlive(keepAlive) {
    if (keepAlive >= this.keepAlive) return

    this.keepAlive = keepAlive
    this.socket.setKeepAlive(this.keepAlive)
  }

  release(pairing, unpair, delay = 0) {
    if (!this.pairings.delete(pairing.keyString)) return

    if (unpair && delay > 0 && !this.destroyed) {
      const timer = setTimeout(() => {
        this.pendingReleaseTimers.delete(timer)
        if (!this.destroyed) unpairRelay(this.client, pairing.token)
        this._closeMaybe(unpair)
      }, delay)

      this.pendingReleaseTimers.add(timer)
      if (timer.unref) timer.unref()
      return
    }

    if (unpair && !this.destroyed) unpairRelay(this.client, pairing.token)

    this._closeMaybe(unpair)
  }

  close(graceful = true) {
    if (!this._closeState()) return

    if (graceful) this.socket.end()
    else this.socket.destroy()
  }

  async destroy() {
    if (!this._closeState()) return

    this._releasePairings(false)
    const closed = this.socket.destroyed
      ? null
      : new Promise((resolve) => this.socket.once('close', resolve))
    this.socket.destroy()
    if (closed) await closed
  }

  _closeMaybe(graceful) {
    if (this.pairings.size === 0 && this.pendingReleaseTimers.size === 0) this.close(graceful)
  }

  _clearPendingReleaseTimers() {
    for (const timer of this.pendingReleaseTimers) clearTimeout(timer)
    this.pendingReleaseTimers.clear()
  }

  _onclose() {
    if (!this._closeState()) return

    this._releasePairings(true)
  }

  _closeState() {
    if (this.destroyed) return false

    this.destroyed = true
    this.pool._delete(this)
    this._clearPendingReleaseTimers()
    this.socket.off('close', this._onclose)

    return true
  }

  _releasePairings(destroy) {
    for (const pairing of this.pairings.values()) {
      if (destroy) pairing.destroy()
      else pairing.detach()
    }

    this.pairings.clear()
  }
}

class RelayPoolPairing extends EventEmitter {
  constructor(connection, token, request) {
    super()

    this.connection = connection
    this.token = token
    this.keyString = token.toString('hex')
    this.request = request
    this.released = false

    this._ondata = this._ondata.bind(this)
    this._onerror = this._onerror.bind(this)

    request.on('data', this._ondata)
    request.on('error', this._onerror)
  }

  get socket() {
    return this.connection.socket
  }

  release() {
    this._release(true)
  }

  closePairing() {
    this._release(true, DIRECT_UPGRADE_UNPAIR_DELAY)
  }

  detach() {
    this._release(false)
  }

  destroy() {
    this._release(false)
    this.request.stream.destroy()
  }

  _release(unpair, delay = 0) {
    if (this.released) return
    this.released = true

    this.request.off('data', this._ondata)
    this.request.off('error', this._onerror)
    this.request.on('error', noop)

    this.connection.release(this, unpair, delay)
  }

  _ondata(data) {
    this.emit('data', data)
  }

  _onerror(err) {
    if (this.listenerCount('error') === 0) return
    this.emit('error', err)
  }
}

function noop() {}

function unpairRelay(client, token) {
  try {
    client.unpair(token)
  } catch {}
}
