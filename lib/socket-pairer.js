const net = require('net')
const utp = require('utp-native')
const os = require('os')
const { isBogon, isPrivate } = require('bogon')
const Nat = require('./nat')
const Payload = require('./secure-payload')
const SocketWrap = require('./socket-wrap')
const Sleeper = require('./sleeper')
const { FIREWALL } = require('./constants')

const SERVER_CONNECTION_TIMEOUT = 6000
const INITIAL_PAIRING_TIMEOUT = 10000
const BIRTHDAY_SOCKETS = 256
const HOLEPUNCH = Buffer.from([0])
const HOLEPUNCH_TTL = 5
const DEFAULT_TTL = 64
const MAX_REOPENS = 3

class Pair {
  constructor (sockets, handshake) {
    this.handshake = handshake
    this.socket = null
    this.nat = null

    // TODO: While conveinent to have the payload stored and instantiated
    // by the socket pairer it might make a lot more sense to just do that
    // in ./connect.js and ./server.js as it is quite confusing currently
    // that it is still valid to use are you destroy this object!
    this.payload = null

    // events
    this.onconnection = noop
    this.ondestroy = noop

    // conditions
    this.destroyed = false
    this.punching = false
    this.connected = false
    this.holepunched = false

    // track remote state
    this.remoteFirewall = FIREWALL.UNKNOWN
    this.remoteAddresses = []
    this.remoteHolepunching = false

    this._timeout = setTimeout(destroy, INITIAL_PAIRING_TIMEOUT, this)
    this._sleeper = null
    this._reopening = null
    this._started = null
    this._sockets = sockets
    this._allSockets = []
    this._onutpconnectionbound = null
    this._onmessagebound = null
    this._directConnections = []
  }

  get connecting () {
    return this._directConnections.length > 0
  }

  open () {
    if (this.socket) return this.socket

    const self = this
    const dht = this._sockets.dht

    this.payload = new Payload(this.handshake.hash)

    this._sleeper = new Sleeper()
    this._onmessagebound = onmessage
    this._onutpconnectionbound = onconnection
    this._reset()

    function onconnection (rawSocket) {
      self._onutpconnection(this, rawSocket)
    }

    function onmessage (buf, rinfo) {
      if (buf.byteLength > 1 && this === self.socket) dht.onmessage(this, buf, rinfo)
      else self._onmessage(this, buf, rinfo)
    }

    return this.socket
  }

  unstable () {
    // TODO!!: We need an additional heuristic here... If we were NOT random in the past we should also do this.
    const firewall = this.nat.firewall
    return (this.remoteFirewall >= FIREWALL.RANDOM && firewall >= FIREWALL.RANDOM) || firewall === FIREWALL.UNKNOWN
  }

  async reopen () {
    if (!this._reopening) this._reopening = this._reopen()
    await this._reopening
    return coerceFirewall(this.nat.firewall) === FIREWALL.CONSISTENT
  }

  async _reopen () {
    for (let i = 0; this.unstable() && i < MAX_REOPENS && !this.destroyed; i++) {
      this._reset()
      await this.nat.analyzing
    }
  }

  updateRemote ({ punching, firewall, addresses, verified }) {
    const remoteAddresses = []

    if (addresses) {
      for (const addr of addresses) {
        let v = verified === addr.host

        if (!v) {
          for (const old of this.remoteAddresses) {
            if (old.verified && old.host === addr.host) {
              v = true
              break
            }
          }
        }

        remoteAddresses.push({
          host: addr.host,
          port: addr.port,
          verified: v
        })
      }
    }

    this.remoteFirewall = firewall
    this.remoteAddresses = remoteAddresses
    this.remoteHolepunching = punching
  }

  ping (addr, socket = this.socket) {
    return holepunch(socket, addr, false)
  }

  openSession (addr, socket = this.socket) {
    return holepunch(socket, addr, true)
  }

  punch () {
    if (!this._punching) this._punching = this._punch()
    return this._punching
  }

  async _punch () {
    if (this.destroyed || !this.remoteAddresses.length) return false
    this.punching = true

    clearTimeout(this._timeout)
    this._timeout = null

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
      this._consistentProbe()
      return true
    }

    if (!remoteVerifiedAddress) return false

    if (local === FIREWALL.CONSISTENT && remote >= FIREWALL.RANDOM) {
      this._randomProbes(remoteVerifiedAddress)
      return true
    }

    if (local >= FIREWALL.RANDOM && remote === FIREWALL.CONSISTENT) {
      await this._openBirthdaySockets(remoteVerifiedAddress)
      if (this.punching) this._keepAliveRandomNat(remoteVerifiedAddress)
      return true
    }

    return false
  }

  async _consistentProbe () {
    // Here we do the sleep first because the "fast open" mode in the server just fired a ping
    if (!this.handshake.isInitiator) await this._sleeper.pause(1000)

    let tries = 0

    while (this.punching && tries++ < 10) {
      for (const addr of this.remoteAddresses) {
        // only try unverified addresses every 4 ticks
        if (!addr.verified && ((tries & 3) !== 0)) continue
        await holepunch(this.socket, addr, false)
      }
      if (this.punching) await this._sleeper.pause(1000)
    }

    this._autoDestroy()
  }

  _autoDestroy () {
    if (this.connected || this._timeout) return
    this.destroy()
  }

  // Note that this never throws so it is safe to run in the background
  async _randomProbes (remoteAddr) {
    let tries = 1750 // ~35s

    while (this.punching && tries-- > 0) {
      const addr = { host: remoteAddr.host, port: randomPort() }
      await holepunch(this.socket, addr, false)
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
      if (i === this._allSockets.length) {
        i = 0
        if (lowTTLRounds > 0) lowTTLRounds--
      }

      await holepunch(this._allSockets[i++], remoteAddr, lowTTLRounds > 0)
      if (this.punching) await this._sleeper.pause(20)
    }

    this._autoDestroy()
  }

  async _openBirthdaySockets (remoteAddr) {
    while (this.punching && this._allSockets.length < BIRTHDAY_SOCKETS) {
      const socket = this._makeSocket()
      this._allSockets.push(socket)
      await holepunch(socket, remoteAddr, HOLEPUNCH_TTL)
    }
  }

  _ontcpconnection (rawSocket, data, ended) {
    if (this.connected) {
      rawSocket.on('error', noop)
      rawSocket.destroy()
      return
    }

    this.connected = true
    this._shutdown(null)
    this._destroyOtherConnections(rawSocket)

    this.onconnection(rawSocket, data, ended, this.handshake)
  }

  _onutpconnection (utp, rawSocket) {
    if (this.connected) {
      rawSocket.on('error', noop)
      rawSocket.destroy()
      return
    }

    utp.firewall(true)
    utp.close() // TODO: when pooling, do not close these, but add to pool instead...

    this.connected = true
    this._shutdown(this._findWrap(utp))
    this._destroyOtherConnections(rawSocket)

    this.onconnection(rawSocket, null, false, this.handshake)
  }

  _destroyOtherConnections (rawSocket) {
    while (this._directConnections.length) {
      const other = this._directConnections.pop()
      if (other !== rawSocket) other.destroy()
    }
  }

  _shutdown (skip) {
    if (this._timeout) clearTimeout(this._timeout)
    this._timeout = null

    if (this.nat) this.nat.destroy()
    this.punching = false

    for (const socket of this._allSockets) {
      if (socket === skip) continue
      socket.close()
    }
    if (skip) this._allSockets[0] = skip
    const len = skip ? 1 : 0
    while (this._allSockets.length > len) this._allSockets.pop()

    // If we are waiting for a connection - ie a non destructive shutdown
    // without a current connecion, set the server timeout...
    if (!this.destroyed && !this.connected) {
      this._timeout = setTimeout(destroy, SERVER_CONNECTION_TIMEOUT, this)
    }

    if (this._sleeper) this._sleeper.resume()
  }

  // Note that this never throws so it is safe to run in the background
  async _onmessage (socket, buf, rinfo) {
    // TODO: try to filter out spoofed messages, but remoteAddress is not always set
    // so skipping for now.

    // make sure we only hit this path once...
    if (this.destroyed || this.connected || this.holepunched) return

    this.holepunched = true
    // TODO: _shutdown here sets punching to false.
    // We should NOT do that if the next if does not fire as there is a edge
    // condition where that might result in the server layer replying back with
    // { connected: false, punching: false } potentially confusing the client
    // when in fact it should say { connected: false, punching: true } as it is still
    // punching just with the low interval stuff below. Solution is to decouple the internals
    // here from the punching flag
    this._shutdown(socket)

    if (this.handshake.isInitiator) {
      const utp = socket.unwrap()
      const c = utp.connect(rinfo.port, rinfo.address)
      this._onutpconnection(utp, c)
      return
    }

    // Switch to slow pings to the other side, until they ping us back
    // with a connection
    while (!this.destroyed && !this.connected) {
      await holepunch(socket, { host: rinfo.address, port: rinfo.port }, false)
      if (!this.destroyed && !this.connected) await this._sleeper.pause(1000)
    }
  }

  _findWrap (utp) {
    for (const wrap of this._allSockets) {
      if (wrap.socket === utp) return wrap
    }
    throw new Error('Wrap not found')
  }

  _makeSocket () {
    const socket = utp()
    socket.bind(0)
    socket.on('connection', this._onutpconnectionbound)
    if (!this.handshake.isInitiator) socket.firewall(false)
    const wrap = new SocketWrap(socket, DEFAULT_TTL)
    wrap.on('message', this._onmessagebound)
    return wrap
  }

  _reset () {
    if (this.socket) {
      // we should never hit this condition, but just to assert if we do...
      if (this._allSockets.length > 1) {
        throw new Error('Can only reset a single socket')
      }
      this.socket.close()
      this._allSockets.pop()
    }

    this.socket = this._makeSocket()
    this._allSockets.push(this.socket)

    this.nat = new Nat(this._sockets.dht, this.socket)

    // TODO: maybe make auto sampling configurable somehow?
    this.nat.autoSample()
  }

  // "to" is the dht node's observation of our address - we can't trust that 100% but can expect it be correct most of the time
  // "from" is the dht node's obersation of the remote's address - same trust
  // To deal with this trust level we always allow the peer to tell us what they think their address is and check the
  // DHT heuristic as well.
  connect (addrs, from, to) {
    if (!addrs) return false

    // Just try one for now
    let localAddress = null
    let address = null

    for (const addr of addrs) {
      if (addr.port === 0) {
        continue
      }

      if (isPrivate(addr.host) && addr.port) {
        if (!localAddress) localAddress = addr
        continue
      }

      if (isBogon(addr.host) || !addr.port) {
        continue
      }

      address = addr
      break
    }

    if (!address) address = from

    // TODO: if this is a common mistake that two lan computers can have dual IPs we should make this better
    // like, do some stuff to check the range of the remote host and ours and if they overlap
    const sameNetwork = address.host === this._sockets.dht.host || address.host === to.host
    const firewall = this.nat ? this.nat.firewall : (this._sockets.dht.firewalled ? FIREWALL.UNKNOWN : FIREWALL.OPEN)

    if (sameNetwork && localAddress) {
      this._connect(localAddress)
    }

    if (this.remoteFirewall === FIREWALL.OPEN && firewall === FIREWALL.OPEN) {
      if (this.isInititator) this._connect(address)
      return true
    }

    if (this.remoteFirewall === FIREWALL.OPEN) {
      this._connect(address)
      return true
    }

    return firewall === FIREWALL.OPEN
  }

  _connect (addr) {
    const self = this
    const rawSocket = net.connect(addr.port, addr.host)

    this._directConnections.push(rawSocket)

    rawSocket.on('connect', onconnect)
    rawSocket.on('error', onerror)
    rawSocket.on('close', gc)

    function onerror () {
      rawSocket.destroy()
    }

    function onconnect () {
      gc()
      self._ontcpconnection(rawSocket, null, false)
    }

    function gc () {
      rawSocket.removeListener('connect', onconnect)
      rawSocket.removeListener('error', onerror)
      rawSocket.removeListener('close', gc)

      const i = self._directConnections.indexOf(rawSocket)
      if (i === -1) return

      self._directConnections[i] = self._directConnections[self._directConnections.length - 1]
      self._directConnections.pop()
    }
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true

    this._shutdown(null)
    this.ondestroy()

    const i = this._sockets._pairs.indexOf(this)
    if (i === -1) return
    this._sockets._pairs[i] = this._sockets._pairs[this._sockets._pairs.length - 1]
    this._sockets._pairs.pop()
  }
}

module.exports = class SocketPairer {
  constructor (dht, server) {
    this.dht = dht

    this._server = server
    this._destroying = null
    this._server.on('connection', this.onconnection.bind(this))
    this._pairs = []
    this._incoming = []
  }

  _notify (inc) {
    for (let i = 0; i < this._pairs.length; i++) {
      const p = this._pairs[i]
      if (!p.handshake.remoteId.equals(inc.id)) continue

      this._pairs[i] = this._pairs[this._pairs.length - 1]
      this._pairs.pop()

      const { rawSocket, data, ended } = this._finalize(inc)
      p._ontcpconnection(rawSocket, data, ended)
      return
    }

    this._incoming.push(inc)
  }

  _addPair (p) {
    for (let i = 0; i < this._incoming.length; i++) {
      const inc = this._incoming[i]
      if (!inc.id.equals(p.handshake.remoteId)) continue

      this._incoming[i] = this._incoming[this._incoming.length - 1]
      this._incoming.pop()

      if (p.destroyed || p.connected) {
        inc.onclose()
        return
      }

      const { rawSocket, data, ended } = this._finalize(inc)
      p._ontcpconnection(rawSocket, data, ended)
      return
    }

    if (p.destroyed || p.connected) return
    this._pairs.push(p)
  }

  _finalize (inc) {
    clearTimeout(inc.timeout)
    inc.timeout = null

    inc.rawSocket.removeListener('readable', inc.onreadable)
    inc.rawSocket.removeListener('end', inc.onend)
    inc.rawSocket.removeListener('error', inc.onclose)
    inc.rawSocket.removeListener('close', inc.onclose)

    return inc
  }

  onconnection (rawSocket) {
    const self = this

    const inc = {
      id: null,
      rawSocket,
      data: null,
      ended: false,
      onreadable,
      onclose,
      onend,
      timeout: null
    }

    inc.timeout = setTimeout(onclose, SERVER_CONNECTION_TIMEOUT)

    rawSocket.on('readable', onreadable)
    rawSocket.on('end', onend)
    rawSocket.on('error', onclose)
    rawSocket.on('close', onclose)

    function onclose () {
      self._finalize(inc)

      rawSocket.on('error', noop)
      rawSocket.destroy()

      if (!inc.id) return
      const i = self._incoming.indexOf(inc)
      if (i === -1) return
      self._incoming[i] = self._incoming[self._incoming.length - 1]
      self._incoming.pop()
    }

    function onend () {
      inc.ended = true
    }

    function onreadable () {
      const next = rawSocket.read()
      inc.data = inc.data ? Buffer.concat([next, inc.data]) : next

      if (!inc.data || inc.data.byteLength < 35) { // 3 byte prefix + 32 id
        return
      }

      rawSocket.removeListener('readable', onreadable)
      inc.id = inc.data.subarray(3, 35)

      self._notify(inc)
    }
  }

  pair (handshake) {
    const p = new Pair(this, handshake)
    // Add it NT to give the user a chance to add listeners
    process.nextTick(addPunchNT, p)
    return p
  }

  remoteServerAddress () {
    const port = this._server.address().port

    if (!this.dht.host) return null
    if (!this.dht.port) return null
    if (this.dht.firewalled) return null
    if (port !== this.dht.port) return null

    return {
      host: this.dht.host,
      port
    }
  }

  localServerAddress () {
    return {
      host: localIP(), // we should cache this i think for some time / based on some heuristics...
      port: this._server.address().port
    }
  }

  destroy () {
    if (this._destroying) return this._destroying
    this._destroying = new Promise((resolve) => { this._server.close(() => resolve()) })
    return this._destroying
  }
}

function localIP () {
  const nets = os.networkInterfaces()
  for (const n of Object.keys(nets)) {
    for (const i of nets[n]) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
}

function holepunch (socket, addr, lowTTL) {
  return new Promise((resolve) => {
    socket.sendTTL(lowTTL ? HOLEPUNCH_TTL : DEFAULT_TTL, HOLEPUNCH, 0, 1, addr.port, addr.host, (err) => {
      resolve(!err)
    })
  })
}

function randomPort () {
  return 1000 + (Math.random() * 64536) | 0
}

function noop () {}

function addPunchNT (p) {
  p._sockets._addPair(p)
}

function destroy (p) {
  p.destroy()
}

function coerceFirewall (fw) {
  return fw === FIREWALL.OPEN ? FIREWALL.CONSISTENT : fw
}
