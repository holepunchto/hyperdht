const { EventEmitter } = require('events')

module.exports = class SocketWrap extends EventEmitter {
  constructor (socket, defaultTTL) {
    super()

    this.socket = socket
    this.ttl = defaultTTL

    this._defaultTTL = defaultTTL
    this._unwrapped = false
    this._pending = 0
    this._queue = []
    this._onflushbound = this._onflush.bind(this)
    this._onmessagebound = this.emit.bind(this, 'message')

    socket.on('message', this._onmessagebound)
  }

  unwrap () {
    this.socket.removeListener('message', this._onmessagebound)
    this._unwrapped = true
    this.ttl = this._defaultTTL
    this.socket.setTTL(this._defaultTTL)
    return this.socket
  }

  close () {
    this.socket.close()
    this._unwrapped = true
    while (this._queue.length) {
      const q = this._queue.pop()
      if (q.onflush) q.onflush(new Error('Socket closed'))
    }
  }

  send (buf, start, end, port, host, onflush = null) {
    this._send(this._queue.length > 0, this._defaultTTL, buf, start, end, port, host, onflush)
  }

  sendTTL (ttl, buf, start, end, port, host, onflush = null) {
    this._send(this._queue.length > 0, ttl, buf, start, end, port, host, onflush)
  }

  _send (requeue, ttl, buf, start, end, port, host, onflush) {
    if (!this._unwrapped && (this.ttl !== ttl || requeue)) {
      if (this._pending > 0 || requeue) {
        this._queue.push({ ttl, buf, start, end, port, host, onflush })
        return false
      }

      this.ttl = ttl
      this.socket.setTTL(ttl)
    }

    this._pending++
    this.socket.send(buf, start, end, port, host, onflush ? this._wrap(onflush) : this._onflushbound)
    return true
  }

  _wrap (onflush) {
    return (err) => {
      this._onflush(err)
      onflush(err)
    }
  }

  _onflush () {
    if (--this._pending > 0 || this._queue.length === 0) return

    while (true) {
      const { ttl, buf, start, end, port, host, onflush } = this._queue.shift()
      this._send(false, ttl, buf, start, end, port, host, onflush)
      if (this._queue.length === 0 || (this._queue[0].ttl !== this.ttl && !this._unwrapped)) return
    }
  }
}
