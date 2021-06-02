const dgram = require('dgram')

const BIRTHDAY_SOCKETS = 256
const HOLEPUNCH = Buffer.from([0])
const HOLEPUNCH_TTL = 5
const DEFAULT_TTL = 64

module.exports = class Holepuncher {
  constructor (socket, localNetwork, remoteNetwork) {
    this.socket = socket || dgram.createSocket('udp4')
    this.localNetwork = localNetwork
    this.remoteNetwork = remoteNetwork
    this.localFriendly = isFriendly(this.localNetwork.firewall)
    this.remoteFriendly = isFriendly(this.remoteNetwork.firewall)
    this.lan = this.localNetwork.address.host === this.remoteNetwork.address.host && this.remoteNetwork.localAddresses.length > 0

    this._allSockets = [this.socket]
    this._autoClose = !socket
    this._binding = socket ? Promise.resolve(true) : null
    this._openingSessions = null
    this._holepunching = null
  }

  bind () {
    if (this._binding) return this._binding
    this._binding = bind(this.socket)
    return this._binding
  }

  openSessions () {
    if (this._openingSessions) return this._openingSessions
    this._openingSessions = this._openSessions()
    return this._openingSessions
  }

  async _openSessions () {
    // if (this._stopped) return

    if (this.lan) {
      this.socket.setTTL(HOLEPUNCH_TTL)
      await holepunch(this.socket, this.remoteNetwork.localAddresses[0])
      this.socket.setTTL(DEFAULT_TTL)
    }

    // if (this._stopped) return this._rpcs.length

    if (!this.localFriendly && !this.remoteFriendly) {
      if (!this.lan) {
        throw new Error('Both peers have none friendly NATs (port randomized), holepunch not currently supported')
      }
      return
    }

    const count = (this.remoteFriendly && !this.localFriendly) ? BIRTHDAY_SOCKETS : 1

    while (this._allSockets.length < count) {
      const socket = await bind(dgram.createSocket('udp4'))
      if (!socket) break
      this._allSockets.push(socket)
    }

    // if (this._stopped) return this._rpcs.length

    for (const socket of this._allSockets) {
      socket.setTTL(HOLEPUNCH_TTL)
      await holepunch(socket, this.remoteNetwork.address)
      socket.setTTL(DEFAULT_TTL)
    }

    return this._allSockets.length
  }

  holepunch () {
    if (this._holepunching) return this._holepunching
    this._holepunching = this._holepunch()
    return this._holepunching
  }


  async _holepunch () {
    // if (this._stopped) return

    if (!this.localFriendly && !this.remoteFriendly) {
      if (!this.lan) {
        throw new Error('Both peers have none friendly NATs (port randomized), holepunch not currently supported')
      }
      return
    }

    const remoteAddress = this.remoteNetwork.address

    if (this.localFriendly && this.remoteFriendly) {
      this._holepunchTimer = new Timer(1000, () => this._rpcs[0].holepunch(remoteAddress))
    } else if (remoteFriendly) {
      this._holepunchTimer = new Timer(20, holebunchRoundRobin(this._rpcs, remoteAddress), false)
    } else if (localFriendly) {
      this._holepunchTimer = new Timer(10, () => this._rpcs[0].holepunch({ host: remoteAddress.host, port: randomPort() }))
    }

    let error = null

    try {
      if (lan) {
        this._lanTimer = new Timer(1000, () => this._rpcs[0].holepunch(this.remoteNetwork.localAddresses[0]))
        await this._lanTimer.start()
      }

      if (this._stopped) return

      if (this._holepunchTimer) await this._holepunchTimer.start()
    } catch (err) {
      error = err
    }

    try {
      await signal
    } catch (err) {
      error = err
    }

  }

  async destroy () {
    if (!this._autoClose) return
    if (this._binding) await this._binding
    this.socket.close()
  }
}

function isLAN (localNetwork, remoteNetwork) {
  return this.localNetwork.address.host === this.remoteNetwork.address.host && this.remoteNetwork.localAddresses.length > 0
}

function isFriendly (type) {
  return type !== DHT.NAT_UNKNOWN && type !== DHT.NAT_PORT_RANDOMIZED
}

function bind (socket) {
  return new Promise((resolve, reject) => {
    socket.on('listening', onlistening)
    socket.on('error', onerror)
    socket.bind(0)

    function onlistening () {
      socket.removeListener('listening', onlistening)
      socket.removeListener('error', onerror)
      resolve(socket)
    }

    function onerror () {
      socket.removeListener('listening', onlistening)
      socket.removeListener('error', onerror)
      resolve(null)
    }
  })
}

function holepunch (socket, addr) {
  return new Promise((resolve) => {
    socket.send(HOLEPUNCH, 0, 1, addr.host, addr.port, (err) => resolve(!err))
  })
}

function holepunchRoundRobin (list, remoteAddress) {
  let i = 0
  let ttl = HOLEPUNCH_TTL

  return function holepuncher () {
    const socket = list[i++]
    if (i === list.length) {
      i = 0
      socket.setTTL(DEFAULT_TTL)
    }
    return holepunch(socket, remoteAddress)
  }
}
const h = new module.exports()

h.bind().then(function () {
  console.log('??', h.socket.address())
})
