const safetyCatch = require('safety-catch')
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
  }

  async start() {
    const n = await this.dht.db.namespace(this.namespace)

    while (!this.dht.destroyed && !this.stopped) {
      try {
        await n.put([{ key: this.key, value: await this.snapshot() }])
      } catch (err) {
        safetyCatch(err)
      }

      if (this.dht.destroyed || this.stopped) break

      await this.sleeper.pause(this.interval)
    }
  }

  async stop() {
    this.stopped = true
    this.sleeper.resume()
  }
}
