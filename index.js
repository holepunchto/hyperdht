const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const { EventEmitter } = require('events')
const NoiseState = require('noise-handshake')
const curve = require('noise-curve-ed')
const c = require('compact-encoding')
const HolepunchRouter = require('./lib/route')
const messages = require('./lib/messages')
const AddressSet = require('./lib/address-set')
const Holepuncher = require('./lib/holepuncher')

const NOISE_PROLOUGE = Buffer.alloc(0)
const SERVER_TIMEOUT = new Error('Server handshake timed out')

class ServerHandshake {
  constructor (dht, noiseRequest, keyPair, opts) {
    this.responder = new NoiseState('IK', false, keyPair, { curve })
    this.responder.initialise(NOISE_PROLOUGE)

    this.noiseRequest = noiseRequest
    this.noiseReply = null

    const remotePayload = c.decode(messages.noisePayload, this.responder.recv(noiseRequest))

    this.id = opts.id || 0
    this.remoteId = remotePayload.id

    const payload = c.encode(messages.noisePayload, { id: this.id })

    this.noiseReply = this.responder.send(payload)
    this.punch = new Holepuncher(dht, this.responder.digest)
    this.ondestroy = opts.ondestroy || noop

    this._timeout = setTimeout(this.destroy.bind(this), 30000, SERVER_TIMEOUT)
  }

  destroy (err) {
    clearTimeout(this._timeout)
    this._timeout = null
    this.ondestroy()
  }
}

class Server {
  constructor (dht) {
    this.dht = dht
    this.keyPair = null
    this.relayNodes = new AddressSet()
  }

  async announce () {
    const relayNodes = this.relayNodes
    const publicKey = this.keyPair.publicKey
    const target = hash(publicKey)

    relayNodes.gc()

    const q = this.dht.query({ command: 'lookup', target }, {
      async commit (msg, dht) {
        const res = await this.dht.request({
          token: msg.token,
          command: 'announce',
          target,
          value: publicKey
        }, msg.from)

        if (res.error === 0) {
          relayNodes.add(msg.from.host, msg.from.port)
        }

        return res
      }
    })

    await q.finished()
  }

  listen (keyPair) {
    this.keyPair = keyPair

    const handshakes = new Map()
    const relayNodes = this.relayNodes
    const dht = this.dht

    this.dht._router.set(hash(keyPair.publicKey), {
      relay: null,
      onconnect (noise) {
        const k = noise.toString('hex')
        let h = handshakes.get(k)

        if (!h) {
          h = new ServerHandshake(dht, noise, keyPair, {
            id: 42,
            ondestroy () {
              if (handshakes.get(k) === h) handshakes.delete(k)
            }
          })

          handshakes.set(k, h)
        }

        return { socket: h.punch.socket, noise: h.noiseReply }
      },
      async onholepunch (hp, req) {
        for (const h of handshakes.values()) {
          if (h.id !== hp.id) continue

          const isOwnRelay = relayNodes.has(req.from.host, req.from.port)
          const remotePayload = h.punch.decryptPayload(hp.payload)

          if (!remotePayload) return null

          console.log('server holepunch -->', remotePayload)

          const token = h.punch.token(hp.peerAddress)
          const remoteHostVerified = !!remotePayload.remoteToken && token.equals(remotePayload.remoteToken)
          const nat = h.punch.nat

          console.log('server says', { remoteHostVerified })

          nat.add(req.to, req.from)

          // Wait for the analyzer to reach a conclusion...
          // We might want to make this more fancy and use a SignalPromise to have it wait max for a timeout etc
          await nat.analyzing

          const payload = {
            status: remotePayload.status,
            nat: nat.type,
            address: nat.address,
            remoteAddress: null,
            token: (isOwnRelay && !remoteHostVerified) ? token : null,
            remoteToken: remotePayload.token
          }

          console.log('server payload', payload)

          return {
            socket: h.punch.socket,
            payload: h.punch.encryptPayload(payload)
          }
        }

        return null
      }
    })

    return this.announce()
  }
}

module.exports = class HyperDHT extends DHT {
  constructor (opts) {
    super(opts)

    this._router = new HolepunchRouter(this)
  }

  onrequest (req) {
    console.log('onrequest', req.command)

    switch (req.command) {
      case 'lookup': {
        this._onlookup(req)
        break
      }
      case 'announce': {
        this._onannounce(req)
        break
      }
      case 'find_peer': {
        this._onfindpeer(req)
        break
      }
      case 'connect': {
        this._router.onconnect(req)
        break
      }
      case 'holepunch': {
        this._router.onholepunch(req)
        break
      }
      default: {
        return false
      }
    }

    return true
  }

  _onfindpeer (req) {
    if (!req.target) return

    const r = this._router.get(req.target)

    if (r) {
      req.reply(Buffer.from('ok'))
      return
    }

    req.reply(null)
  }

  _onlookup (req) {
    if (!req.target) return

    const a = this._router.get(req.target)
    console.log('onlookup', !!a)

    req.reply(null)
  }

  _onannounce (req) {
    if (!req.target) return

    const existing = this._router.get(req.target)
    if (existing) {
      clearTimeout(existing.timeout)
    }

    const c = {
      relay: req.from,
      server: null,
      timeout: null
    }

    c.timeout = setTimeout(() => {
      if (this._router.get(req.target) === c) {
        this._router.delete(req.target)
      }
    }, 10 * 60 * 1000)

    this._router.set(req.target, c)

    req.reply(null)
  }

  connect (publicKey) {
    return this._connect(publicKey)
  }

  async _connect (publicKey) {
    const target = hash(publicKey)
    const q = this.query({ command: 'find_peer', target })

    const keyPair = createKeyPair()
    const initiator = new NoiseState('IK', true, keyPair, { curve })

    initiator.initialise(NOISE_PROLOUGE, publicKey)

    const payload = c.encode(messages.noisePayload, {
      id: 0
    })

    const message = initiator.send(payload)

    let found = null
    for await (const data of q) {
      if (data.value) {
        found = data
        break
      }
    }

    if (!found) {
      throw new Error('Not found')
    }

    const connect = await this._router.connect(this, target, { noise: message }, found.from)

    let remotePayload = null

    try {
      remotePayload = c.decode(messages.noisePayload, initiator.recv(connect.noise))
    } catch (err) {
      // TODO: this should be tried across more peers instead
      throw err
    }

    console.log('connect response -->', connect, 'remote payload:', remotePayload, 'was relayed?', !!connect.serverRelayAddress)

    const remoteId = remotePayload.id
    const { serverAddress } = connect
    const punch = new Holepuncher(this, initiator.digest)

    // Open a quick low ttl session against what we think is the server
    await punch.openSession(connect.serverAddress)

    const first = await this._holepunch(punch, target, remoteId, serverAddress, connect.serverRelayAddress, {
      status: 0,
      nat: punch.nat.type,
      address: punch.nat.address,
      remoteAddress: connect.serverAddress,
      token: null,
      remoteToken: null
    })

    punch.remoteNat = first.payload.nat
    punch.nat.add(first.to, first.from)

    // Open another quick low ttl session against what the server says their addr is, if they haven't said they are random yet
    if (punch.remoteNat < 2 && first.payload.address && diffAddress(first.payload.address, serverAddress)) {
      await punch.openSession(first.payload.address)
    }

    // If the remote told us they didn't know their nat type yet, give them a chance to figure it out
    // They might say this to see if the "fast mode" punch comes through first.
    if (punch.remoteNat === 0) {
      // TODO: make this timeout cancel on stream close, if the user wants to cancel this connection
      await new Promise(resolve, setTimeout(resolve, 1000))
    }

    await punch.nat.analyzing

    if (punch.nat.type === 0) {
      // Can't figure out our nat, so abort for now
      // TODO: we might be able to infer more info here
      await this._holepunch(punch, target, remoteId, serverAddress, connect.serverRelayAddress, {
        status: 2,
        nat: 0,
        address: null,
        remoteAddress: null,
        token: null,
        remoteToken: null
      })

      punch.destroy()

      throw new Error('Could not determine local nat type in time')
    }

    console.log('her nu')
    return
    console.log('client holepunch: -->', punchPayload)

    {
      const buf = punch.encryptPayload({
        status: 0,
        nat: punch.nat.type,
        address: punch.nat.address,
        remoteAddress: null,
        token: punch.token(punchPayload.address),
        remoteToken: punchPayload.token
      })

    console.log('\n\nclient is sending holepunch #2\n')
      const h = await this._router.holepunch(this, target, { id: remotePayload.id, payload: buf, peerAddress: connect.serverAddress }, connect.clientRelayAddress)
      const punchPayload2 = punch.decryptPayload(h.payload)

      console.log('client holepunch: -->', punchPayload2)
    }
  }

  async _holepunch (punch, target, id, peerAddress, relayAddr, payload) {
    const res = await this._router.holepunch(this, target, {
      id,
      payload: punch.encryptPayload(payload),
      peerAddress,
      socket: punch.socket
    }, relayAddr)

    const remotePayload = punch.decryptPayload(res.payload)
    if (!remotePayload) {
      throw new Error('Invalid holepunch payload')
    }

    return {
      from: res.from,
      to: res.to,
      peerAddress: res.peerAddress,
      payload: remotePayload
    }
  }

  createServer () {
    const server = new Server(this)
    return server
  }

  static keyPair (seed) {
    return createKeyPair(seed)
  }
}

function diffAddress (a, b) {
  return a.host !== b.host || a.port !== b.port
}

function createKeyPair (seed) {
  const publicKey = Buffer.alloc(32)
  const secretKey = Buffer.alloc(64)
  if (seed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  else sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}

function decode (enc, buf) {
  try {
    return c.decode(enc, buf)
  } catch {
    return null
  }
}

function noop () {}
