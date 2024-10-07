const b4a = require('b4a')
const Nat = require('./nat')
const Sleeper = require('./sleeper')
const { FIREWALL } = require('./constants')

const BIRTHDAY_SOCKETS = 256
const HOLEPUNCH = b4a.from([0])
const HOLEPUNCH_TTL = 5
const DEFAULT_TTL = 64
const MAX_REOPENS = 3

module.exports = class Holepuncher {
  constructor (dht, session, isInitiator, remoteFirewall = FIREWALL.UNKNOWN) {
    const holder = dht._socketPool.acquire()

    this.dht = dht
    this.session = session

    this.nat = new Nat(dht, session, holder.socket)
    this.nat.autoSample()

    this.isInitiator = isInitiator

    // events
    this.onconnect = noop
    this.onabort = noop

    this.punching = false
    this.connected = false
    this.destroyed = false
    this.randomized = false

    // track remote state
    this.remoteFirewall = remoteFirewall
    this.remoteAddresses = []
    this.remoteHolepunching = false

    this._sleeper = new Sleeper()
    this._reopening = null
    this._timeout = null
    this._punching = null
    this._allHolders = []
    this._holder = this._addRef(holder)
  }

  get socket () {
    return this._holder.socket
  }

  updateRemote ({ punching, firewall, addresses, verified }) {
    const remoteAddresses = []

    if (addresses) {
      for (const addr of addresses) {
        remoteAddresses.push({
          host: addr.host,
          port: addr.port,
          verified: (verified === addr.host) || this._isVerified(addr.host)
        })
      }
    }

    this.remoteFirewall = firewall
    this.remoteAddresses = remoteAddresses
    this.remoteHolepunching = punching
  }

  _isVerified (host) {
    for (const addr of this.remoteAddresses) {
      if (addr.verified && addr.host === host) {
        return true
      }
    }
    return false
  }

  ping (addr, socket = this._holder.socket) {
    return holepunch(socket, addr, false)
  }

  openSession (addr, socket = this._holder.socket) {
    return holepunch(socket, addr, true)
  }

  async analyze (allowReopen) {
    await this.nat.analyzing
    if (this._unstable()) {
      if (!allowReopen) return false
      if (!this._reopening) this._reopening = this._reopen()
      return this._reopening
    }
    return true
  }

  _unstable () {
    // TODO!!: We need an additional heuristic here... If we were NOT random in the past we should also do this.
    const firewall = this.nat.firewall
    return (this.remoteFirewall >= FIREWALL.RANDOM && firewall >= FIREWALL.RANDOM) || firewall === FIREWALL.UNKNOWN
  }

  _reset () {
    const prev = this._holder

    this._allHolders.pop()
    this._holder = this._addRef(this.dht._socketPool.acquire())

    prev.release()
    this.nat.destroy()

    this.nat = new Nat(this.dht, this.session, this._holder.socket)
    // TODO: maybe make auto sampling configurable somehow?
    this.nat.autoSample()
  }

  _addRef (ref) {
    this._allHolders.push(ref)
    ref.onholepunchmessage = (msg, rinfo) => this._onholepunchmessage(msg, rinfo, ref)
    return ref
  }

  _onholepunchmessage (_, addr, ref) {
    if (!this.isInitiator) { // TODO: we don't need this if we had a way to connect a socket to many hosts
      holepunch(ref.socket, addr, false) // never fails
      return
    }

    if (this.connected) return

    this.connected = true
    this.punching = false

    for (const r of this._allHolders) {
      if (r === ref) continue
      r.release()
    }

    this._allHolders[0] = ref
    while (this._allHolders.length > 1) this._allHolders.pop()

    this._decrementRandomized()
    this.onconnect(ref.socket, addr.port, addr.host)
  }

  _done () {
    return this.destroyed || this.connected
  }

  async _reopen () {
    for (let i = 0; this._unstable() && i < MAX_REOPENS && !this._done() && !this.punching; i++) {
      this._reset()
      await this.nat.analyzing
    }

    return coerceFirewall(this.nat.firewall) === FIREWALL.CONSISTENT
  }

  punch () {
    if (!this._punching) this._punching = this._punch()
    return this._punching
  }

  async _punch () {
    if (this._done() || !this.remoteAddresses.length) return false

    this.punching = true

    // Coerce into consistency for now. Obvs we could make this this more efficient if we use that info
    // but that's seldomly used since those will just use tcp most of the time.

    const local = coerceFirewall(this.nat.firewall)
    const remote = coerceFirewall(this.remoteFirewall)

    // Note that most of these async functions are meant to run in the background
    // which is why we don't await them here and why they are not allowed to throw

    let remoteVerifiedAddress = null
    for (const addr of this.remoteAddresses) {
      if (addr.verified) {
        remoteVerifiedAddress = addr
        break
      }
    }

    if (local === FIREWALL.CONSISTENT && remote === FIREWALL.CONSISTENT) {
      this.dht.stats.punches.consistent++
      this._consistentProbe()
      return true
    }

    if (!remoteVerifiedAddress) return false

    if (local === FIREWALL.CONSISTENT && remote >= FIREWALL.RANDOM) {
      this.dht.stats.punches.random++
      this._incrementRandomized()
      this._randomProbes(remoteVerifiedAddress)
      return true
    }

    if (local >= FIREWALL.RANDOM && remote === FIREWALL.CONSISTENT) {
      this.dht.stats.punches.random++
      this._incrementRandomized()
      await this._openBirthdaySockets(remoteVerifiedAddress)
      if (this.punching) this._keepAliveRandomNat(remoteVerifiedAddress)
      return true
    }

    return false
  }

  // Note that this never throws so it is safe to run in the background
  async _consistentProbe () {
    // Here we do the sleep first because the "fast open" mode in the server just fired a ping
    if (!this.isInitiator) await this._sleeper.pause(1000)

    let tries = 0

    while (this.punching && tries++ < 10) {
      for (const addr of this.remoteAddresses) {
        // only try unverified addresses every 4 ticks
        if (!addr.verified && ((tries & 3) !== 0)) continue
        await holepunch(this._holder.socket, addr, false)
      }
      if (this.punching) await this._sleeper.pause(1000)
    }

    this._autoDestroy()
  }

  // Note that this never throws so it is safe to run in the background
  async _randomProbes (remoteAddr) {
    let tries = 1750 // ~35s

    while (this.punching && tries-- > 0) {
      const addr = { host: remoteAddr.host, port: randomPort() }
      await holepunch(this._holder.socket, addr, false)
      if (this.punching) await this._sleeper.pause(20)
    }

    this._autoDestroy()
  }

  // Note that this never throws so it is safe to run in the background
  async _keepAliveRandomNat (remoteAddr) {
    let i = 0
    let lowTTLRounds = 1

    // TODO: experiment with this here. We just bursted all the messages in
    // openOtherSockets to ensure the sockets are open, so it's potentially
    // a good idea to slow down for a bit.
    await this._sleeper.pause(100)

    let tries = 1750 // ~35s

    while (this.punching && tries-- > 0) {
      if (i === this._allHolders.length) {
        i = 0
        if (lowTTLRounds > 0) lowTTLRounds--
      }

      await holepunch(this._allHolders[i++].socket, remoteAddr, lowTTLRounds > 0)
      if (this.punching) await this._sleeper.pause(20)
    }

    this._autoDestroy()
  }

  async _openBirthdaySockets (remoteAddr) {
    while (this.punching && this._allHolders.length < BIRTHDAY_SOCKETS) {
      const ref = this._addRef(this.dht._socketPool.acquire())
      await holepunch(ref.socket, remoteAddr, HOLEPUNCH_TTL)
    }
  }

  _autoDestroy () {
    if (!this.connected) this.destroy()
  }

  _incrementRandomized () {
    if (!this.randomized) {
      this.randomized = true
      this.dht._randomPunches++
    }
  }

  _decrementRandomized () {
    if (this.randomized) {
      this.dht._lastRandomPunch = Date.now()
      this.randomized = false
      this.dht._randomPunches--
    }
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.punching = false

    for (const ref of this._allHolders) ref.release()
    this._allHolders = []
    this.nat.destroy()

    if (!this.connected) {
      this._decrementRandomized()
      this.onabort()
    }
  }

  static ping (socket, addr) {
    return holepunch(socket, addr, false)
  }

  static localAddresses (socket) {
    return localAddresses(socket)
  }

  static matchAddress (myAddresses, externalAddresses) {
    return matchAddress(myAddresses, externalAddresses)
  }
}

function holepunch (socket, addr, lowTTL) {
  return socket.send(HOLEPUNCH, addr.port, addr.host, lowTTL ? HOLEPUNCH_TTL : DEFAULT_TTL)
}

function randomPort () {
  return 1000 + (Math.random() * 64536) | 0
}

function coerceFirewall (fw) {
  return fw === FIREWALL.OPEN ? FIREWALL.CONSISTENT : fw
}

function localAddresses (socket) {
  const addrs = []
  const { host, port } = socket.address()

  if (host === '127.0.0.1') return [{ host, port }]

  for (const n of socket.udx.networkInterfaces()) {
    if (n.family !== 4 || n.internal) continue

    addrs.push({ host: n.host, port })
  }

  if (addrs.length === 0) {
    addrs.push({ host: '127.0.0.1', port })
  }

  return addrs
}

function matchAddress (localAddresses, remoteLocalAddresses) {
  if (remoteLocalAddresses.length === 0) return null

  let best = { segment: 1, addr: null }

  for (const localAddress of localAddresses) {
    // => 192.168.122.238
    const a = localAddress.host.split('.')

    for (const remoteAddress of remoteLocalAddresses) {
      // => 192.168.0.23
      // => 192.168.122.1
      const b = remoteAddress.host.split('.')

      // Matches 192.*.*.*
      if (a[0] === b[0]) {
        if (best.segment === 1) best = { segment: 2, addr: remoteAddress }

        // Matches 192.168.*.*
        if (a[1] === b[1]) {
          if (best.segment === 2) best = { segment: 3, addr: remoteAddress }

          // Matches 192.168.122.*
          if (a[2] === b[2]) return remoteAddress
        }
      }
    }
  }

  return best.addr
}

function noop () {}
