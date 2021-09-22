const sodium = require('sodium-universal')
const NoiseSecretStream = require('noise-secret-stream')
const NoiseWrap = require('./noise-wrap')
const Sleeper = require('./sleeper')

const PROBE = 0
const PUNCH = 1
const ABORT = 2

module.exports = class Client {
  constructor (dht, publicKey, keyPair, opts = {}) {
    this.dht = dht
    this.keyPair = keyPair
    this.target = hash(publicKey)
    this.handshake = new NoiseWrap(keyPair, publicKey)
    this.remoteId = 0
    this.query = null
    this.pair = null
    this.error = null
    this.destroyed = false
    this.sleeper = new Sleeper()
    this.holepunch = opts.holepunch || (() => true)

    this.noiseRequest = this.handshake.send({
      firewalled: dht.firewalled,
      id: 0,
      relays: []
    })

    this.encryptedSocket = null
  }

  connect () {
    this.encryptedSocket = new NoiseSecretStream(true, null, {
      autoStart: false
    })

    this.connectSocket()

    return this.encryptedSocket
  }

  async connectSocket () {
    try {
      await this.findAndConnect()
    } catch (err) {
      this.destroy(err)
    }
  }

  async findAndConnect () {
    this.query = this.dht.query({ command: 'find_peer', target: this.target })

    let found = null
    for await (const data of this.query) {
      if (data.value) {
        found = data
        break
      }
    }

    this.query = null

    if (!found) {
      throw new Error('Could not find peer')
    }

    return this.connectThrough(found)
  }

  _pickServerRelay (relays, clientRelay) {
    for (const r of relays) {
      if (!diffAddress(r.relayAddress, clientRelay)) return r
    }
    return relays[0]
  }

  async connectThrough (node) {
    const clientRelayAddress = node.from

    const connect = await this._connect(this.noiseRequest, clientRelayAddress)
    if (this._done()) return

    this.pair = this.dht._sockets.pair(this.handshake.final())

    this.pair.onconnection = (rawSocket, data, ended, handshake) => {
      this.encryptedSocket.start(rawSocket, {
        handshake,
        data,
        ended
      })
    }

    this.pair.ondestroy = () => {
      this.destroy()
    }

    let { serverAddress, relayed, payload } = connect

    if (!this.dht.firewalled && payload.firewalled) {
      // Remote will connect to us, do nothing as we'll get a connection or timeout
      return
    }

    if (!relayed || !payload.relays.length || !payload.firewalled) {
      const addr = payload.address || serverAddress
      // TODO: check what protocol to use now ie, if (supportsTCP) connect(addr, TCP)
      this.pair.connect(addr)
      return
    }

    this.pair.open()

    const serverRelay = this._pickServerRelay(payload.relays, clientRelayAddress)
    const one = await this._roundOne(serverAddress, serverRelay, true)
    if (!one || this._done()) return

    const { token, peerAddress } = one

    // TODO: still continue here if a local connection might work, but then do not holepunch...
    if (!this.holepunch(this.pair.remoteNat, this.pair.nat.type, this.pair.remoteAddress, this.pair.nat.address)) {
      await this._abort(serverRelay, new Error('Client aborted holepunch'))
    }

    // If the relay the server picked is the same as the relay the client picked,
    // then we can use the peerAddress that round one indicates the server wants to use.
    // This shaves off a roundtrip if the server chose to reroll its socket due to some NAT
    // issue with the first one it picked (ie mobile nat inconsistencies...).
    // If the relays were different, then the server would not have a UDP session open on this address
    // to the client relay, which round2 uses.
    if (!diffAddress(serverRelay.relayAddress, clientRelayAddress) && diffAddress(serverAddress, peerAddress)) {
      serverAddress = peerAddress
      await this.pair.openSession(serverAddress)
      if (this._done()) return
    }

    await this._roundTwo(serverAddress, token, clientRelayAddress)
    this._done()
  }

  async _roundOne (serverAddress, serverRelay, retry) {
    // Open a quick low ttl session against what we think is the server
    await this.pair.openSession(serverAddress)

    if (this._done()) return null

    const reply = await this._holepunch(serverRelay.peerAddress, serverRelay.relayAddress, {
      status: PROBE,
      nat: this.pair.nat.type,
      address: this.pair.nat.address,
      remoteAddress: serverAddress,
      token: null,
      remoteToken: null
    })

    if (this._done()) return null

    const { peerAddress } = reply
    const { address, token } = reply.payload

    this.pair.nat.add(reply.to, reply.from)

    // Open another quick low ttl session against what the server says their address is,
    // if they haven't said they are random yet
    if (this.pair.remoteNat < 2 && address && address.host && address.port && diffAddress(address, serverAddress)) {
      await this.pair.openSession(address)
      if (this._done()) return null
    }

    // If the remote told us they didn't know their nat type yet, give them a chance to figure it out
    // They might say this to see if the "fast mode" punch comes through first.
    if (this.pair.remoteNat === 0) {
      await this.sleeper.pause(1000)
      if (this._done()) return null
    }

    await this.pair.nat.analyzing
    if (this._done()) return null

    if (this.pair.remoteNat >= 2 && this.pair.nat.type >= 2) {
      if ((await this.pair.reopen()) && !this._done()) return this._roundOne(serverAddress, serverRelay, false)
    }

    if ((this.pair.remoteNat === 0 || !token) && retry) {
      return this._roundOne(serverAddress, serverRelay, false)
    }

    if (this.pair.remoteNat === 0 || this.pair.nat.type === PROBE) {
      await this._abort(serverRelay, new Error('Holepunching probe did not finish in time'))
    }
    if (this.pair.remoteNat >= 2 && this.pair.nat.type >= 2) {
      await this._abort(serverRelay, new Error('Both remote and local NATs are randomized'))
    }

    return { token, peerAddress }
  }

  async _roundTwo (serverAddress, remoteToken, clientRelay) {
    await this._holepunch(serverAddress, clientRelay, {
      status: PUNCH,
      nat: this.pair.nat.type,
      address: this.pair.nat.address,
      remoteAddress: null,
      token: this.pair.payload.token(serverAddress),
      remoteToken
    })

    if (!this.pair.remoteVerified) {
      // TODO: if the remote changed their address here should we ping them one final time?
      throw new Error('Could not verify remote address')
    }
    if (!this.pair.remoteHolepunching) {
      throw new Error('Remote is not holepunching')
    }

    await this.pair.punch()
  }

  async _abort ({ peerAddress, relayAddress }, err) {
    try {
      await this._holepunch(peerAddress, relayAddress, {
        status: ABORT,
        nat: 0,
        address: null,
        remoteAddress: null,
        token: null,
        remoteToken: null
      })
    } catch {}
    throw err
  }

  async _connect (noise, relay) {
    const connect = await this.dht._router.connect(this.target, { noise }, relay)
    const payload = this.handshake.recv(connect.noise)

    if (!payload) {
      throw new Error('Noise handshake failed')
    }

    this.remoteId = payload.id // TODO: maybe just inline this in payloads?

    return {
      ...connect,
      payload
    }
  }

  async _holepunch (peerAddress, relayAddr, payload) {
    const holepunch = await this.dht._router.holepunch(this.target, {
      id: this.remoteId,
      payload: this.pair.payload.encrypt(payload),
      peerAddress,
      socket: this.pair.socket
    }, relayAddr)

    const remotePayload = this.pair.payload.decrypt(holepunch.payload)
    if (!remotePayload) {
      throw new Error('Invalid holepunch payload')
    }

    const { status, nat, address, remoteToken } = remotePayload
    if (status === ABORT) {
      throw new Error('Remote aborted')
    }

    const echoed = !!(remoteToken && payload.token && remoteToken.equals(payload.token))

    // TODO: move these conditions to a function, if not complex, as they are used in both client/server
    if (this.pair.remoteNat === 0 && nat !== 0 && address && (this.pair.remoteNat !== 1 || address.port !== 0)) {
      this.pair.remoteNat = nat
      this.pair.remoteAddress = address
    }
    if (echoed && this.pair.remoteAddress && this.pair.remoteAddress.host === peerAddress.host) {
      this.pair.remoteVerified = true
    }
    if (status === PUNCH) {
      this.pair.remoteHolepunching = true
    }

    return {
      ...holepunch,
      payload: remotePayload
    }
  }

  _done () {
    if (this.connection) return true
    if (this.destroyed) throw this.error
    return false
  }

  destroy (error = new Error('Handshake aborted')) {
    if (this.destroyed) return
    this.destroyed = true
    if (this.pair) this.pair.destroy()
    if (this.query) this.query.destroy()
    this.sleeper.resume()
    this.error = error
    if (this.encryptedSocket) this.encryptedSocket.destroy(error)
  }
}

function diffAddress (a, b) {
  return a.host !== b.host || a.port !== b.port
}

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}
