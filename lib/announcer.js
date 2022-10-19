const safetyCatch = require('safety-catch')
const c = require('compact-encoding')
const Sleeper = require('./sleeper')
const m = require('./messages')
const Persistent = require('./persistent')
const { COMMANDS } = require('./constants')

module.exports = class Announcer {
  constructor (dht, keyPair, target, opts = {}) {
    this.dht = dht
    this.keyPair = keyPair
    this.target = target
    this.relays = []
    this.stopped = false
    this.record = c.encode(m.peer, { publicKey: keyPair.publicKey, relayAddresses: [] })

    this._refreshing = false
    this._closestNodes = null
    this._active = null
    this._sleeper = new Sleeper()
    this._signAnnounce = opts.signAnnounce || Persistent.signAnnounce
    this._signUnannounce = opts.signUnannounce || Persistent.signUnannounce

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
          if (this.stopped) return

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
    const relays = []

    this._cycle()

    const q = this.dht.findPeer(this.target, { hash: false, nodes: this._closestNodes })

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

  async _unannounce (to) {
    const unann = {
      peer: {
        publicKey: this.keyPair.publicKey,
        relayAddresses: []
      },
      refresh: null,
      signature: null
    }

    const { from, token, value } = await this.dht.request({
      token: null,
      command: COMMANDS.FIND_PEER,
      target: this.target,
      value: null
    }, to)

    if (!token || !from.id || !value) return

    unann.signature = await this._signUnannounce(this.target, token, from.id, unann, this.keyPair)

    await this.dht.request({
      token,
      command: COMMANDS.UNANNOUNCE,
      target: this.target,
      value: c.encode(m.announce, unann)
    }, to)
  }

  async _commit (msg, relays) {
    const ann = {
      peer: {
        publicKey: this.keyPair.publicKey,
        relayAddresses: []
      },
      refresh: null,
      signature: null
    }

    ann.signature = await this._signAnnounce(this.target, msg.token, msg.from.id, ann, this.keyPair)

    const res = await this.dht.request({
      token: msg.token,
      command: COMMANDS.ANNOUNCE,
      target: this.target,
      value: c.encode(m.announce, ann)
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
