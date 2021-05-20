const utp = require('utp-native')
const os = require('os')
const Timer = require('./timer')

const BIRTHDAY_SOCKETS = 256
const HOLEPUNCH = Buffer.from([0])
const HOLEPUNCH_TTL = 5
const DEFAULT_TTL = 64

const NAT_OPEN = Symbol.for('NAT_OPEN')
const NAT_UNKNOWN = Symbol.for('NAT_UNKNOWN')
const NAT_PORT_RANDOMIZED = Symbol.for('NAT_PORT_RANDOMIZED')

module.exports = class Holepuncher {
  constructor (address, onconnected) {
    const self = this

    this.address = address
    this.socket = null

    this.localNetwork = null
    this.remoteNetwork = null
    this.localFriendly = false
    this.remoteFriendly = false
    this.lan = false
    this.onconnected = onconnected || noop

    this._onmessage = onmessage
    this._allSockets = []
    this._holepunchTimer = null
    this._lanTimer = null
    this._stopped = false
    this._isClient = false

    // async states
    this._openingSessions = null
    this._holepunching = null
    this._resolveConnection = null
    this._connection = new Promise((resolve) => { this._resolveConnection = resolve })
    this._onconnection = onconnection

    function onconnection (rawSocket) {
      const socket = this

      socket.setTTL(DEFAULT_TTL)
      socket.firewall(true)
      self._stop(null)

      self.onconnected(rawSocket)
    }

    function onmessage (buf, rinfo) {
      self.onmessage(buf, rinfo, this)
    }
  }

  onmessage (buf, rinfo, socket) {
    if (buf.byteLength > 1) return
    if (!this._stopped) this._stop(socket)

    if (!this._isClient) {
      socket.send(HOLEPUNCH, 0, 1, rinfo.port, rinfo.address)
      return
    }

    if (this._resolveConnection !== null) {
      this._resolveConnection(socket.connect(rinfo.port, rinfo.address))
      this._resolveConnection = null
      this._stop(null)
    }
  }

  connected () {
    return this._connection
  }

  get holepunchable () {
    return this.localFriendly || this.remoteFriendly || this.lan
  }

  bind () {
    if (this.socket) return this.localNetwork
    if (this.address.type === NAT_UNKNOWN) return null

    this._isClient = this.remoteNetwork === null
    this.socket = this._createSocket()

    // TODO: OPEN_NAT should reuse the socket from the dht and/or tcp

    const localAddresses = (this._isClient || this.remoteNetwork.address.host === this.address.host)
      ? [{ host: localIP(), port: this.socket.address().port }]
      : []

    this.localNetwork = {
      firewall: this.address.type,
      address: {
        host: this.address.host,
        port: 0
      },
      localAddresses,
      relayAuth: null // upstream populates this, added for consistency
    }
    if (this.remoteNetwork !== null) this._ready()

    return this.localNetwork
  }

  setRemoteNetwork (r) {
    // TODO: check if localAddresses contain any non bogon addresses and bail if so
    this.remoteNetwork = r
    if (this.localNetwork !== null) this._ready()
  }

  _ready () {
    this.localFriendly = isFriendly(this.localNetwork.firewall)
    this.remoteFriendly = isFriendly(this.remoteNetwork.firewall)
    this.lan = this.localNetwork.address.host === this.remoteNetwork.address.host && this.remoteNetwork.localAddresses.length > 0
  }

  openSessions () {
    if (this._openingSessions) return this._openingSessions
    this._openingSessions = this._openSessions()
    return this._openingSessions
  }

  async _openSessions () {
    if (!this.socket) throw new Error('Socket not bound')

    if (this.lan) {
      // TODO: try all local addrs
      await holepunch(this.socket, this.remoteNetwork.localAddresses[0], true)
      if (this._stopped) return this._allSockets.length
    }

    if (!this.localFriendly && !this.remoteFriendly) return this.lan ? 1 : 0

    this._bindAllSockets()

    if (this._stopped) return this._allSockets.length

    for (const socket of this._allSockets) {
      await holepunch(socket, this.remoteNetwork.address, true)
    }

    return this._allSockets.length
  }

  _bindAllSockets () {
    const count = (this.remoteFriendly && !this.localFriendly) ? BIRTHDAY_SOCKETS : 1

    while (this._allSockets.length < count && !this._stopped) {
      if (!this._createSocket()) break
    }
  }

  holepunch () {
    if (this._holepunching) return this._holepunching
    this._holepunching = this._holepunch()
    return this._holepunching
  }

  _createSocket () {
    const socket = utp()
    socket.bind(0)
    socket.on('error', noop)
    try {
      socket.address()
    } catch {
      return null
    }
    socket.firewall(false)
    socket.on('message', this._onmessage)
    socket.on('connection', this._onconnection)
    this._allSockets.push(socket)
    return socket
  }

  async _holepunch () {
    if (this._openingSessions) await this._openingSessions
    if (this._stopped) return

    this.socket.setTTL(DEFAULT_TTL)

    // TODO: if we reuse the socket from the DHT we can short circuit here
    // if (this.address.type === NAT_OPEN && !this._isClient) return

    this._bindAllSockets()
    if (this._stopped) return

    if (!this.localFriendly && !this.remoteFriendly && !this.lan) return

    const otherRemoteAddress = this.remoteNetwork.address

    if (this.localFriendly && this.remoteFriendly) {
      this._holepunchTimer = new Timer(1000, () => holepunch(this.socket, otherRemoteAddress, false))
    } else if (this.remoteFriendly) {
      this._holepunchTimer = new Timer(20, holepunchRoundRobin(this._allSockets, otherRemoteAddress), false)
    } else if (this.localFriendly) {
      this._holepunchTimer = new Timer(10, () => holepunch(this.socket, { host: otherRemoteAddress.host, port: randomPort() }, false))
    }

    if (this.lan) {
      this._lanTimer = new Timer(1000, () => holepunch(this.socket, this.remoteNetwork.localAddresses[0], false))
      await this._lanTimer.start()
      if (this._stopped) return
    }

    if (this._holepunchTimer) await this._holepunchTimer.start()
  }

  _stop (bestSocket) {
    if (this._holepunchTimer !== null) this._holepunchTimer.stop()
    if (this._lanTimer !== null) this._lanTimer.stop()

    this.socket = bestSocket

    this._stopped = true
    this._holepunchTimer = null
    this._lanTimer = null

    for (const socket of this._allSockets) {
      if (socket !== bestSocket) socket.close()
    }

    this._allSockets = []
    if (this.socket) this.socket.setTTL(DEFAULT_TTL)
  }

  destroy () {
    if (!this.socket) return
    this._stop(null)
  }
}

function isFriendly (type) {
  return type !== NAT_UNKNOWN && type !== NAT_PORT_RANDOMIZED
}

function noop () {}

function holepunch (socket, addr, lowTTL) {
  return new Promise((resolve) => {
    if (lowTTL) socket.setTTL(HOLEPUNCH_TTL)
    socket.send(HOLEPUNCH, 0, 1, addr.port, addr.host, (err) => {
      if (lowTTL) socket.setTTL(DEFAULT_TTL)
      resolve(!err)
    })
  })
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

function holepunchRoundRobin (list, address) {
  let i = 0
  let first = true

  return function holepuncher () {
    const socket = list[i++]
    if (first) {
      first = false
      socket.setTTL(HOLEPUNCH_TTL)
    }
    if (i === list.length) {
      i = 0
      socket.setTTL(DEFAULT_TTL)
    }
    return holepunch(socket, address, false)
  }
}

function randomPort () {
  return 1000 + (Math.random() * 64536) | 0
}

// start()

// async function start () {
//   const Holepuncher = module.exports

//   const a = new Holepuncher({
//     type: Symbol.for('NAT_PORT_RANDOMIZED'),
//     host: '127.0.0.1',
//     port: 9090
//   })

//   const b = new Holepuncher({
//     type: Symbol.for('NAT_PORT_RANDOMIZED'),
//     host: '128.0.0.1',
//     port: 42442
//   }, function (rawSocket) {
//     console.log('(incoming raw socket)')

//     rawSocket.on('data', function (data) {
//       console.log('-->', data)
//     })

//     rawSocket.on('end', function () {
//       console.log('(end)')
//     })
//   })

//   b.setRemoteNetwork(a.bind())
//   a.setRemoteNetwork(b.bind())

//   console.log(a.holepunchable, b.holepunchable)
//   console.log(a.localNetwork)
//   console.log(b.localNetwork)

//   await Promise.all([a.openSessions(), b.openSessions()])

//   await Promise.all([a.holepunch(), b.holepunch()])

//   const s = await a.connected()

//   console.log('connected:', !!s)

//   s.write('hello')
//   s.write(' ')
//   s.write('world')
// }
