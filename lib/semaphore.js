const DONE = Promise.resolve(true)
const DESTROYED = Promise.resolve(false)

module.exports = class Semaphore {
  constructor (limit = 1) {
    this.limit = limit
    this.active = 0
    this.waiting = []
    this.destroyed = false

    this._onwait = (resolve) => { this.waiting.push(resolve) }
  }

  wait () {
    if (this.destroyed === true) return DESTROYED

    if (this.active < this.limit && this.waiting.length === 0) {
      this.active++
      return DONE
    }

    return new Promise(this._onwait)
  }

  signal () {
    if (this.destroyed === true) return

    this.active--
    while (this.active < this.limit && this.waiting.length > 0 && this.destroyed === false) {
      this.active++
      this.waiting.shift()(true)
    }
  }

  async flush () {
    if (this.destroyed === true) return
    this.limit = 1
    await this.wait()
    this.signal()
  }

  destroy () {
    this.destroyed = true
    this.active = 0
    while (this.waiting.length) this.waiting.pop()(false)
  }
}
