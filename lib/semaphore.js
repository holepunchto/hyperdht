const DONE = Promise.resolve(true)
const DESTROYED = Promise.resolve(false)

module.exports = class Semaphore {
  constructor(limit = 1) {
    this.limit = limit
    this.active = 0
    this.waiting = []

    this.flushedPromise = null
    this.flushedResolve = null

    this.destroyed = false

    this._onwait = this._queueWaiting.bind(this)
    this._onflush = this._queueFlushed.bind(this)
  }

  _queueWaiting(resolve) {
    this.waiting.push(resolve)
  }

  _queueFlushed(resolve) {
    this.flushedResolve = resolve
  }

  wait() {
    if (this.destroyed === true) return DESTROYED

    if (this.active < this.limit && this.waiting.length === 0) {
      this.active++
      return DONE
    }

    return new Promise(this._onwait)
  }

  signal() {
    if (this.destroyed === true) return

    this.active--
    while (this.active < this.limit && this.waiting.length > 0 && this.destroyed === false) {
      this.active++
      this.waiting.shift()(true)
    }

    if (this.active === 0 && this.flushedResolve) {
      const resolve = this.flushedResolve
      this.flushedResolve = null
      this.flushedPromise = null
      resolve(true)
    }
  }

  async flush() {
    if (this.destroyed === true) return
    if (this.active === 0) return
    if (this.flushedPromise) return this.flushedPromise
    this.flushedPromise = new Promise(this._onflush)
    return this.flushedPromise
  }

  destroy() {
    this.destroyed = true
    this.active = 0
    while (this.waiting.length) this.waiting.pop()(false)
    if (this.flushedResolve) this.flushedResolve(false)
  }
}
