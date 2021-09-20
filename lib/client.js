const NoiseState = require('noise-handshake')
const curve = require('noise-curve-ed')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const Holepuncher = require('./holepuncher')
const Sleeper = require('./sleeper')
const messages = require('./messages')

const NOISE_PROLOUGE = Buffer.alloc(0)
const CONNECT_TIMEOUT = 40000

const PROBE = 0
const PUNCH = 1
const ABORT = 2

module.exports = class Client {
  constructor (dht, publicKey, keyPair, opts = {}) {
    this.dht = dht
    this.target = hash(publicKey)
    this.handshake = new NoiseState('IK', true, keyPair, { curve })
    this.handshake.initialise(NOISE_PROLOUGE, publicKey)
    this.remoteId = 0
    this.query = null
    this.punch = null
    this.error = null
    this.destroyed = false
    this.sleeper = new Sleeper()
    this.holepunch = opts.holepunch || (() => true)

    const payload = c.encode(messages.noisePayload, { id: 0, relays: [] })
    this.noiseRequest = this.handshake.send(payload)
  }

  async connect () {
    const destroy = () => this.destroy(new Error('Connect attempt timed out'))
    const timeout = setTimeout(destroy, CONNECT_TIMEOUT)

    try {
      await this.findAndConnect()
    } catch (err) {
      this.destroy(err)
    } finally {
      clearTimeout(timeout)
    }

    if (this.error) throw this.error
    if (!this.punch || !this.punch.rawSocket) {
      throw new Error('Connect finished without a socket')
    }

    return {
      rawSocket: this.punch.rawSocket
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

    let { serverAddress, relayed, payload } = connect

    if (!relayed || !payload.relays.length) { // or is TCP etc etc etc
      throw new Error('TODO: connect directly to server atm')
    }

    this.punch = new Holepuncher(this.dht, true, this.handshake.digest)

    const serverRelay = this._pickServerRelay(payload.relays, clientRelayAddress)
    const one = await this._roundOne(serverAddress, serverRelay, true)
    if (!one || this._done()) return console.log('return now', !!one, one)

    const { token, peerAddress } = one

    // TODO: still continue here if a local connection might work, but then do not holepunch...
    if (!this.holepunch(this.punch.remoteNat, this.punch.nat.type, this.punch.remoteAddress, this.punch.nat.address)) {
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
      await this.punch.openSession(serverAddress)
      if (this._done()) return
    }

    await this._roundTwo(serverAddress, token, clientRelayAddress)
    if (this._done()) return

    await this.punch.connected
    this._done()
  }

  async _roundOne (serverAddress, serverRelay, retry) {
    console.log('begin round one!')

    // Open a quick low ttl session against what we think is the server
    await this.punch.openSession(serverAddress)

    if (this._done()) return null

    const reply = await this._holepunch(serverRelay.peerAddress, serverRelay.relayAddress, {
      status: PROBE,
      nat: this.punch.nat.type,
      address: this.punch.nat.address,
      remoteAddress: serverAddress,
      token: null,
      remoteToken: null
    })

    if (this._done()) return null

    const { peerAddress } = reply
    const { address, token } = reply.payload

    this.punch.nat.add(reply.to, reply.from)

    // Open another quick low ttl session against what the server says their address is,
    // if they haven't said they are random yet
    if (this.punch.remoteNat < 2 && address && address.host && address.port && diffAddress(address, serverAddress)) {
      await this.punch.openSession(address)
      if (this._done()) return null
    }

    // If the remote told us they didn't know their nat type yet, give them a chance to figure it out
    // They might say this to see if the "fast mode" punch comes through first.
    if (this.punch.remoteNat === 0) {
      await this.sleeper.pause(1000)
      if (this._done()) return null
    }

    await this.punch.nat.analyzing
    if (this._done()) return null

    if (this.punch.remoteNat >= 2 && this.punch.nat.type >= 2) {
      if ((await this.punch.reroll()) && !this._done()) return this._roundOne(serverAddress, serverRelay, false)
    }

    if ((this.punch.remoteNat === 0 || !token) && retry) {
      return this._roundOne(serverAddress, serverRelay, false)
    }

    if (this.punch.remoteNat === 0 || this.punch.nat.type === PROBE) {
      await this._abort(serverRelay, new Error('Holepunching probe did not finish in time'))
    }
    if (this.punch.remoteNat >= 2 && this.punch.nat.type >= 2) {
      await this._abort(serverRelay, new Error('Both remote and local NATs are randomized'))
    }

    return { token, peerAddress }
  }

  async _roundTwo (serverAddress, remoteToken, clientRelay) {
    console.log('begin round two!', remoteToken)

    await this._holepunch(serverAddress, clientRelay, {
      status: PUNCH,
      nat: this.punch.nat.type,
      address: this.punch.nat.address,
      remoteAddress: null,
      token: this.punch.token(serverAddress),
      remoteToken
    })

    if (!this.punch.remoteVerified) {
      // TODO: if the remote changed their address here should we ping them one final time?
      throw new Error('Could not verify remote address')
    }
    if (!this.punch.remoteHolepunching) {
      throw new Error('Remote is not holepunching')
    }

    await this.punch.start()

    console.log('round two:', {
      remoteNat: this.punch.remoteNat,
      remoteHolepunching: this.punch.remoteHolepunching,
      remoteAddress: this.punch.remoteAddress,
      remoteVerified: this.punch.remoteVerified
    })
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
    const payload = c.decode(messages.noisePayload, this.handshake.recv(connect.noise))

    this.remoteId = payload.id // TODO: maybe just inline this in payloads?
require('util').inspect.defaultOptions.depth = 42
console.log('connect payload', payload)
    return {
      ...connect,
      payload
    }
  }

  async _holepunch (peerAddress, relayAddr, payload) {
    const holepunch = await this.dht._router.holepunch(this.target, {
      id: this.remoteId,
      payload: this.punch.encryptPayload(payload),
      peerAddress,
      socket: this.punch.socket
    }, relayAddr)

    const remotePayload = this.punch.decryptPayload(holepunch.payload)
    if (!remotePayload) {
      throw new Error('Invalid holepunch payload')
    }

    const { status, nat, address, remoteToken } = remotePayload
    if (status === ABORT) {
      throw new Error('Remote aborted')
    }

    const echoed = !!(remoteToken && payload.token && remoteToken.equals(payload.token))

    // TODO: move these conditions to a function, if not complex, as they are used in both client/server
    if (this.punch.remoteNat === 0 && nat !== 0 && address && (this.punch.remoteNat !== 1 || address.port !== 0)) {
      this.punch.remoteNat = nat
      this.punch.remoteAddress = address
    }
    if (echoed && this.punch.remoteAddress && this.punch.remoteAddress.host === peerAddress.host) {
      this.punch.remoteVerified = true
    }
  if (remoteToken && !this.punch.remoteVerified) {
    console.log('not verified!', remoteToken, payload, peerAddress, this.punch.remoteAddress)
  }
    if (status === PUNCH) {
      this.punch.remoteHolepunching = true
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
    if (this.punch) this.punch.destroy()
    if (this.query) this.query.destroy()
    this.sleeper.resume()
    this.error = error
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
