const { EventEmitter, once } = require('events')
const b4a = require('b4a')
const relay = require('blind-relay')

module.exports = class RelayPool {
  constructor(dht) {
    this._dht = dht
    this._entries = new Map()
  }

  pair(publicKey, opts) {
    return this._get(publicKey, opts.keepAlive).pair(opts)
  }

  async destroy() {
    const closing = []

    for (const entry of this._entries.values()) {
      closing.push(entry.destroy())
    }

    await Promise.allSettled(closing)
  }

  _get(publicKey, keepAlive) {
    const keyString = b4a.toString(publicKey, 'hex')
    let entry = this._entries.get(keyString)

    if (!entry || entry.destroyed) {
      entry = new RelayPoolEntry(this, keyString, publicKey, keepAlive)
      this._entries.set(keyString, entry)
    } else {
      entry.setKeepAlive(keepAlive)
    }

    return entry
  }

  _delete(entry) {
    if (this._entries.get(entry.keyString) === entry) this._entries.delete(entry.keyString)
  }
}

class RelayPoolEntry {
  constructor(pool, keyString, publicKey, keepAlive) {
    this.pool = pool
    this.keyString = keyString
    this.socket = pool._dht.connect(publicKey)
    this.client = relay.Client.from(this.socket, { id: this.socket.publicKey })
    this.pairings = new Map()
    this.destroyed = false

    this._onclose = this._onclose.bind(this)
    this.socket.once('close', this._onclose)
    this.socket.on('error', noop)
    this.setKeepAlive(keepAlive)
  }

  setKeepAlive(keepAlive) {
    this.socket.setKeepAlive(keepAlive)
  }

  pair({ isInitiator, token, stream }) {
    const request = this.client.pair(isInitiator, token, stream)
    const pairing = new RelayPoolPairing(this, token, request)

    this.pairings.set(pairing.keyString, pairing)

    return pairing
  }

  release(pairing, unpair) {
    if (!this.pairings.delete(pairing.keyString)) return

    if (unpair && !this.destroyed) {
      try {
        this.client.unpair(pairing.token)
      } catch {}
    }

    this._closeMaybe(unpair)
  }

  close(graceful = true) {
    if (this.destroyed) return

    this.destroyed = true
    this.pool._delete(this)
    this.socket.off('close', this._onclose)
    if (graceful) this.socket.end()
    else this.socket.destroy()
  }

  async destroy() {
    if (this.destroyed) return

    this.destroyed = true
    this.pool._delete(this)

    for (const pairing of this.pairings.values()) {
      pairing.detach()
    }

    this.pairings.clear()
    this.socket.off('close', this._onclose)

    const closed = this.socket.destroyed ? null : once(this.socket, 'close')
    this.socket.destroy()
    if (closed) await closed
  }

  _closeMaybe(graceful) {
    if (this.pairings.size === 0) this.close(graceful)
  }

  _onclose() {
    this.destroyed = true
    this.pool._delete(this)

    for (const pairing of this.pairings.values()) {
      pairing.destroy()
    }

    this.pairings.clear()
  }
}

class RelayPoolPairing extends EventEmitter {
  constructor(entry, token, request) {
    super()

    this.entry = entry
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
    return this.entry.socket
  }

  release() {
    this._release(true)
  }

  detach() {
    this._release(false)
  }

  destroy() {
    this._release(false)
    this.request.stream.destroy()
  }

  _release(unpair) {
    if (this.released) return
    this.released = true

    this.request.off('data', this._ondata)
    this.request.off('error', this._onerror)
    this.request.on('error', noop)

    this.entry.release(this, unpair)
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
