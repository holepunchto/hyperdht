const safetyCatch = require('safety-catch')
const c = require('compact-encoding')
const Signal = require('signal-promise')
const { encodeUnslab } = require('./encode')
const Sleeper = require('./sleeper')
const m = require('./messages')
const Persistent = require('./persistent')
const { COMMANDS } = require('./constants')

const MIN_ACTIVE = 3

module.exports = class Announcer {
  constructor (dht, keyPair, target, opts = {}) {
    this.dht = dht
    this.keyPair = keyPair
    this.target = target
    this.relays = []
    this.relayAddresses = []
    this.stopped = false
    this.suspended = false
    this.record = encodeUnslab(m.peer, { publicKey: keyPair.publicKey, relayAddresses: [] })
    this.online = new Signal()

    this._refreshing = false
    this._closestNodes = null
    this._active = null
    this._sleeper = new Sleeper()
    this._resumed = new Signal()
    this._signAnnounce = opts.signAnnounce || Persistent.signAnnounce
    this._signUnannounce = opts.signUnannounce || Persistent.signUnannounce
    this._updating = null
    this._activeQuery = null
    this._unannouncing = null

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

  async suspend ({ log = noop } = {}) {
    if (this.suspended) return
    this.suspended = true

    log('Suspending announcer')

    // Suspend has its own sleep logic
    // so we don't want to hang on this one
    this.online.notify()

    if (this._activeQuery) this._activeQuery.destroy()

    this._sleeper.resume()
    if (this._updating) await this._updating
    log('Suspending announcer (post update)')

    if (this.suspended === false || this.stopped) return

    log('Suspending announcer (pre unannounce)')
    await this._unannounceCurrent()
    log('Suspending announcer (post unannounce)')
  }

  resume () {
    if (!this.suspended) return
    this.suspended = false

    this.refresh()
    this._sleeper.resume()
    this._resumed.notify()
  }

  refresh () {
    if (this.stopped) return
    this._refreshing = true
  }

  async start () {
    if (this.stopped) return
    this._active = this._runUpdate()
    await this._active
    if (this.stopped) return
    this._active = this._background()
  }

  async stop () {
    this.stopped = true
    this.online.notify() // Break out of the _background loop if we're offline
    this._sleeper.resume()
    this._resumed.notify()
    await this._active
    await this._unannounceCurrent()
  }

  async _unannounceCurrent () {
    while (this._unannouncing !== null) await this._unannouncing
    const un = this._unannouncing = this._unannounceAll(this._serverRelays[2].values())
    await this._unannouncing
    if (un === this._unannouncing) this._unannouncing = null
  }

  async _background () {
    while (!this.dht.destroyed && !this.stopped) {
      try {
        this._refreshing = false

        // ~5min +-
        for (let i = 0; i < 100 && !this.stopped && !this._refreshing && !this.suspended; i++) {
          const pings = []

          for (const node of this._serverRelays[2].values()) {
            pings.push(this.dht.ping(node))
          }

          const active = await resolved(pings)
          if (active < Math.min(pings.length, MIN_ACTIVE)) {
            this.refresh() // we lost too many relay nodes, retry all
          }

          if (this.stopped) return

          if (!this.suspended && !this._refreshing) await this._sleeper.pause(3000)
        }

        while (!this.stopped && this.suspended) await this._resumed.wait()

        if (!this.stopped) await this._runUpdate()

        while (!this.dht.online && !this.stopped && !this.suspended) {
          // Being offline can make _background repeat very quickly
          // So wait until we're back online
          await this.online.wait()
        }
      } catch (err) {
        safetyCatch(err)
      }
    }
  }

  async _runUpdate () {
    this._updating = this._update()
    await this._updating
    this._updating = null
  }

  async _update () {
    while (this._unannouncing) await this._unannouncing

    this._cycle()

    const q = this._activeQuery = this.dht.findPeer(this.target, { hash: false, nodes: this._closestNodes })

    try {
      await q.finished()
    } catch {
      // ignore failures...
    }

    this._activeQuery = null

    if (this.stopped || this.suspended) return

    const ann = []
    const replies = pickBest(q.closestReplies)

    const relays = []
    const relayAddresses = []

    if (!this.dht.firewalled) {
      const addr = this.dht.remoteAddress()
      if (addr) relayAddresses.push(addr)
    }

    for (const msg of replies) {
      ann.push(this._commit(msg, relays, relayAddresses))
    }

    await Promise.allSettled(ann)
    if (this.stopped || this.suspended) return

    this._closestNodes = q.closestNodes
    this.relays = relays
    this.relayAddresses = relayAddresses

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

  async _commit (msg, relays, relayAddresses) {
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

    if (relayAddresses.length < 3) relayAddresses.push({ host: msg.from.host, port: msg.from.port })
    relays.push({ relayAddress: msg.from, peerAddress: msg.to })

    this._serverRelays[2].set(msg.from.host + ':' + msg.from.port, msg.from)
  }

  _cycle () {
    const tmp = this._serverRelays[0]
    this._serverRelays[0] = this._serverRelays[1]
    this._serverRelays[1] = this._serverRelays[2]
    this._serverRelays[2] = tmp
    tmp.clear()
  }
}

function resolved (ps) {
  let replied = 0
  let ticks = ps.length + 1

  return new Promise((resolve) => {
    for (const p of ps) p.then(push, tick)
    tick()

    function push (v) {
      replied++
      tick()
    }

    function tick () {
      if (--ticks === 0) resolve(replied)
    }
  })
}

function pickBest (replies) { // TODO: pick the ones closest to us RTT wise
  return replies.slice(0, 3)
}

function noop () {}
