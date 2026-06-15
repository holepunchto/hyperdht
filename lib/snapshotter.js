const safetyCatch = require('safety-catch')
const Signal = require('signal-promise')
const Sleeper = require('./sleeper')

module.exports = class Snapshotter {
  constructor(dht, namespace, key, interval, snapshot) {
    this.dht = dht
    this.namespace = namespace
    this.key = key
    this.interval = interval
    this.snapshot = snapshot
    this.sleeper = new Sleeper()
    this.stopped = false
    this.suspended = false
    this._resumed = new Signal()
  }

  async start() {
    const n = await this.dht.db.namespace(this.namespace)

    while (!this.dht.destroyed && !this.stopped) {
      try {
        if (!this.suspended) await n.put([{ key: this.key, value: await this.snapshot() }])
      } catch (err) {
        safetyCatch(err)
      }

      if (this.dht.destroyed || this.stopped) break

      if (this.suspended) {
        await this._resumed.wait()
      } else {
        await this.sleeper.pause(this.interval)
      }
    }
  }

  suspend() {
    if (this.suspended) return
    this.suspended = true
    this.sleeper.resume()
  }

  resume() {
    if (!this.suspended) return
    this.suspended = false
    this._resumed.notify()
  }

  async stop() {
    this.stopped = true
    this.sleeper.resume()
    this._resumed.notify()
  }
}
