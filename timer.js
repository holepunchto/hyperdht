module.exports = class Timer {
  constructor (ms, work, eager = true) {
    this.ms = ms
    this.running = null
    this.eager = eager
    this._work = work
    this._timeout = null
    this._done = null
  }

  update () {
    return this._work()
  }

  async start () {
    if (this.running) return
    this.running = new Promise((resolve) => { this._done = resolve })

    const self = this
    if (this.eager) await this.update()
    queue()

    function loop () {
      const p = self.update()
      if (p && p.then) p.then(queue, queue)
      else queue()
    }

    function queue () {
      if (!self.running) return
      self._timeout = setTimeout(loop, self.ms)
    }
  }

  stop () {
    this._done()
    this.running = null
    clearTimeout(this._timeout)
  }
}
