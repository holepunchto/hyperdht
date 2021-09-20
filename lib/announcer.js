const safetyCatch = require('safety-catch')
const Sleeper = require('./sleeper')

module.exports = class Announcer {
  constructor (dht, keyPair, target) {
    this.dht = dht
    this.keyPair = keyPair
    this.target = target
    this.relays = []
    this.stopped = false

    this._refreshing = false
    this._closestNodes = null
    this._active = null
    this._sleeper = new Sleeper()

    this._serverRelays = [
      new Map(),
      new Map(),
      new Map()
    ]
  }

  isRelay (addr) {
    const id = addr.host + ':' + addr.port
    const [a, b, c] = this._serverRelays
    return a.has(id) || b.has(id) || c.has(id)
  }

  refresh () {
    if (this.stopped) return
    this._refreshing = true
  }

  async start () {
    if (this.stopped) return
    this._active = this._update()
    await this._active
    if (this.stopped) return
    this._active = this._background()
  }

  async stop () {
    this.stopped = true
    this._sleeper.resume()
    await this._active
    await this._unannounceAll(this._serverRelays[2].values())
  }

  async _background () {
    while (!this.stopped) {
      try {
        this._refreshing = false

        // ~5min +-
        for (let i = 0; i < 100 && !this.stopped && !this._refreshing; i++) {
          const pings = []

          for (const node of this._serverRelays[2].values()) {
            pings.push(this.dht.ping(node))
          }

          const pongs = await allFastest(pings)
          const relays = []

          for (let i = 0; i < pongs.length && relays.length < 3; i++) {
            relays.push(pongs[i].from)
          }

          await this._sleeper.pause(3000)
        }
        if (!this.stopped) await this._update()
      } catch (err) {
        safetyCatch(err)
      }
    }
  }

  async _update () {
    const self = this
    const target = this.target
    const relays = []

    this._cycle()

    const q = this.dht.query({ command: 'lookup', target: this.target, nodes: this._closestNodes })

    try {
      await q.finished()
    } catch {
      // ignore failures...
    }

    if (this.stopped) return

    const ann = []
    const top = q.closestReplies.slice(0, 5)

    for (const msg of top) {
      ann.push(this._commit(msg, relays))
    }

    await Promise.allSettled(ann)
    if (this.stopped) return

    this._closestNodes = q.closestNodes
    this.relays = relays

    const removed = []
    for (const [key, value] of this._serverRelays[1]) {
      if (!this._serverRelays[2].has(key)) removed.push(value)
    }

    await this._unannounceAll(removed)
  }

  _unannounceAll (relays) {
    const unann = []
    for (const r of relays) unann.push(this._unannounce(r))
    return Promise.allSettled(unann)
  }

  _unannounce (to) {
    return this.dht.request({
      token: null,
      command: 'unannounce',
      target: this.target,
      value: null
    }, to)
  }

  async _commit (msg, relays) {
    const res = await this.dht.request({
      token: msg.token,
      command: 'announce',
      target: this.target,
      value: this.keyPair.publicKey
    }, msg.from)

    if (res.error !== 0) return

    this._serverRelays[2].set(msg.from.host + ':' + msg.from.port, msg.from)

    if (relays.length < 3) {
      relays.push({ relayAddress: msg.from, peerAddress: msg.to })
    }

    if (relays.length === 3) {
      this.relays = relays
    }
  }

  _cycle () {
    const tmp = this._serverRelays[0]
    this._serverRelays[0] = this._serverRelays[1]
    this._serverRelays[1] = this._serverRelays[2]
    this._serverRelays[2] = tmp
    tmp.clear()
  }
}

function allFastest (ps) {
  const result = []
  let ticks = ps.length + 1

  return new Promise((resolve) => {
    for (const p of ps) p.then(push, tick)
    tick()

    function push (v) {
      result.push(v)
      tick()
    }

    function tick () {
      if (--ticks === 0) resolve(result)
    }
  })
}
