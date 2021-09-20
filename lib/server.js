const { EventEmitter } = require('events')
const NoiseState = require('noise-handshake')
const curve = require('noise-curve-ed')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const Holepuncher = require('./holepuncher')
const messages = require('./messages')
const Announcer = require('./announcer')

const NOISE_PROLOUGE = Buffer.alloc(0)
const SERVER_TIMEOUT = 30000

const PROBE = 0
const PUNCH = 1
const ABORT = 2

class ServerConnector {
  constructor (server) {
    this.server = server
    this.connects = new Map()
    this.holepunches = []
  }

  async _addHandshake (k, noise) {
    const handshake = new NoiseState('IK', false, this.server.keyPair, { curve })
    const relays = this.server.announcer.relays

    handshake.initialise(NOISE_PROLOUGE)

    let remotePayload = null
    try {
      remotePayload = c.decode(messages.noisePayload, handshake.recv(noise))
    } catch {
      return null
    }

    // TODO: run firewall function also obvs

    let id = this.holepunches.indexOf(null)
    if (id === -1) id = this.holepunches.push(null) - 1

    const payload = c.encode(messages.noisePayload, { id, relays })
    const reply = handshake.send(payload)

    const hs = {
      id,
      handshake,
      relays,
      reply,
      punch: null,
      firewalled: null,
      destroy: null,
      timeout: null,
      destroyed: false
    }

    this.connects.set(k, hs)
    this.holepunches[id] = hs

    const destroy = (abort) => {
      if (hs.destroyed) return
      hs.destroyed = true

      if (id >= this.holepunches.length || this.holepunches[id] !== hs) return
      clearTimeout(hs.timeout)

      this.holepunches[id] = null
      while (this.holepunches.length > 0 && this.holepunches[this.holepunches.length - 1] === null) {
        this.holepunches.pop()
      }
      this.connects.delete(k)
      if (abort && hs.punch) hs.punch.destroy()
    }

    hs.destroy = destroy.bind(null, true)
    hs.timeout = setTimeout(hs.destroy, SERVER_TIMEOUT)

    const fw = this.server.firewall(handshake.rs)

    hs.firewalled = (!fw || !fw.then) ? Promise.resolve(fw) : fw

    try {
      if (await hs.firewalled) {
        hs.destroy()
        return null
      }
    } catch (err) {
      hs.destroy()
      throw err
    }

    if (hs.destroyed) return null

    hs.punch = new Holepuncher(this.server.dht, false, handshake.digest)
    hs.punch.connected.then(function (rawSocket) {
      if (!rawSocket) return
      destroy(false)
      console.log('Server got UTP connection!')
    })

    return hs
  }

  async onconnect (noise) {
    const k = noise.toString('hex')
    let h = this.connects.get(k)

    if (!h) {
      h = await this._addHandshake(k, noise)
      if (!h) return null
    }

    if (await h.firewalled) return null

    return { socket: h.punch.socket, noise: h.reply }
  }

  async onholepunch ({ id, peerAddress, payload }, req) {
    const h = id < this.holepunches.length ? this.holepunches[id] : null
    if (!h) return null
    if (await h.firewalled) return null

    const p = h.punch
    const remotePayload = p.decryptPayload(payload)
    if (!remotePayload) return null

    const isServerRelay = this.server.announcer.isRelay(req.from)
    const { status, nat, address, remoteAddress, remoteToken } = remotePayload

    if (status === ABORT) return abort(h)

    const token = p.token(peerAddress)
    const echoed = isServerRelay && !!remoteToken && token.equals(remoteToken)

    // Update our heuristics here
    if (req.socket === p.socket) {
      p.nat.add(req.to, req.from)
    }
    if (p.remoteNat === 0 && nat !== 0 && address && (p.remoteNat !== 1 || address.port !== 0)) {
      p.remoteNat = nat
      p.remoteAddress = address
    }
    if (echoed && p.remoteAddress && p.remoteAddress.host === peerAddress.host) {
      p.remoteVerified = true
    }
    if (status === PUNCH) {
      p.remoteHolepunching = true
    }

    // Wait for the analyzer to reach a conclusion...
    await nat.analyzing

    // Bail if non-holepunchable and we cannot recover from that...
    if (p.remoteNat >= 2 && p.nat.type >= 2) {
      if (!(await p.reroll())) {
        return abort(h)
      }
    }

    // Fast mode! If we are consistent and the remote has opened a session to us (remoteAddress)
    // then fire a quick punch back. Note the await here just waits for the udp socket to flush.
    if (p.nat.type === 1 && remoteAddress && sameAddr(p.nat.address, remoteAddress)) {
      await p.ping(peerAddress)
    }

    // TODO: remove this debug stuff when it is stable
    // console.log('remote:', {
    //   remotePayload,
    //   peerAddress,
    //   echoed,
    //   token,
    //   remoteToken,
    //   remoteNat: p.remoteNat,
    //   remoteAddress: p.remoteAddress,
    //   remoteHolepunching: p.remoteHolepunching,
    //   remoteVerified: p.remoteVerified
    // })
    // console.log('local:', {
    //   relay: req.from,
    //   isServerRelay,
    //   nat: p.nat.type,
    //   address: p.nat.address,
    //   holepunching: !!p.started,
    //   samples: p.nat._sampler._samples
    // })

    // Remote said they are punching (or willing to), and we have verified their IP so we will
    // punch as well. Note that this returns when the punching has STARTED, so we no guarantee
    // we will have a connection after this promise etc.
    if (p.remoteHolepunching && p.remoteVerified) {
      // TODO: still continue here if a local connection might work, but then do not holepunch...
      if (!this.server.holepunch(p.remoteNat, p.nat.type, p.remoteAddress, p.address)) {
        return abort(h)
      }
      await p.start()
    }

    return {
      socket: p.socket,
      payload: p.encryptPayload({
        status: p.started ? PUNCH : PROBE,
        nat: p.nat.type,
        address: p.nat.address,
        remoteAddress: null,
        token: (isServerRelay && !p.remoteVerified) ? token : null,
        remoteToken: remotePayload.token
      })
    }
  }
}

module.exports = class Server extends EventEmitter {
  constructor (dht, opts = {}) {
    super()

    this.dht = dht
    this.keyPair = null
    this.announcer = null

    this.firewall = opts.firewall || (() => false)
    this.holepunch = opts.holepunch || (() => true)
  }

  close () {
    if (!this.announcer) return Promise.resolve()
    return this.announcer.stop()
  }

  listen (keyPair) {
    if (this.announcer) return Promise.reject(new Error('Already listening'))

    const target = hash(keyPair.publicKey)

    this.keyPair = keyPair
    this.announcer = new Announcer(this.dht, this.keyPair, target)
    this.dht._router.set(target, {
      relay: null,
      server: new ServerConnector(this)
    })

    return this.announcer.start()
  }
}

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}

function sameAddr (a, b) {
  return a.host === b.host && a.port === b.port
}

function abort (h) {
  const payload = h.punch.encryptPayload({
    status: ABORT,
    nat: 0,
    address: null,
    remoteAddress: null,
    token: null,
    remoteToken: null
  })

  h.destroy()

  return { socket: null, payload }
}
