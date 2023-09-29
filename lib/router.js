const c = require('compact-encoding')
const Cache = require('xache')
const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const { handshake, holepunch } = require('./messages')
const { COMMANDS } = require('./constants')
const { BAD_HANDSHAKE_REPLY, BAD_HOLEPUNCH_REPLY } = require('./errors')

const FROM_CLIENT = 0
const FROM_SERVER = 1
const FROM_RELAY = 2
const FROM_SECOND_RELAY = 3
const REPLY = 4

// TODO: While the current design is very trustless in regards to clients/servers trusting the DHT,
// we should add a bunch of rate limits everywhere, especially including here to avoid bad users
// using a DHT node to relay traffic indiscriminately using the connect/holepunch messages.
// That's mostly from an abuse POV as none of the messsages do amplication.

module.exports = class Router {
  constructor (dht, opts) {
    this.dht = dht
    this.forwards = new Cache(opts.forwards)
  }

  set (target, state) {
    if (state.onpeerhandshake) {
      this.forwards.retain(toString(target), state)
    } else {
      this.forwards.set(toString(target), state)
    }
  }

  get (target) {
    return this.forwards.get(toString(target))
  }

  delete (target) {
    this.forwards.delete(toString(target))
  }

  destroy () {
    this.forwards.destroy()
  }

  async peerHandshake (target, { noise, peerAddress, relayAddress, socket, session }, to) {
    const dht = this.dht

    const requestValue = c.encode(handshake, {
      mode: FROM_CLIENT,
      noise,
      peerAddress,
      relayAddress
    })

    const res = await dht.request({ command: COMMANDS.PEER_HANDSHAKE, target, value: requestValue }, to, { socket, session })

    const hs = decode(handshake, res.value)
    if (!hs || hs.mode !== REPLY || (to.host !== res.from.host || to.port !== res.from.port) || !hs.noise) {
      throw BAD_HANDSHAKE_REPLY()
    }

    return {
      noise: hs.noise,
      relayed: !!hs.peerAddress,
      serverAddress: hs.peerAddress || to,
      clientAddress: res.to
    }
  }

  async onpeerhandshake (req) {
    const hs = req.value && decode(handshake, req.value)
    if (!hs) return

    const { mode, noise, peerAddress, relayAddress } = hs

    const state = req.target && this.get(req.target)
    const isServer = !!(state && state.onpeerhandshake)
    const relay = state && state.relay

    if (isServer) {
      let reply = null
      try {
        reply = noise && await state.onpeerhandshake({ noise, peerAddress }, req)
      } catch (e) {
        safetyCatch(e)
        return
      }
      if (!reply || !reply.noise) return
      const opts = { socket: reply.socket, closerNodes: false, token: false }

      switch (mode) {
        case FROM_CLIENT: {
          req.reply(c.encode(handshake, { mode: REPLY, noise: reply.noise, peerAddress: null }), opts)
          return
        }
        case FROM_RELAY: {
          req.relay(c.encode(handshake, { mode: FROM_SERVER, noise: reply.noise, peerAddress }), req.from, opts)
          return
        }
        case FROM_SECOND_RELAY: {
          if (!relayAddress) return
          req.relay(c.encode(handshake, { mode: FROM_SERVER, noise: reply.noise, peerAddress }), relayAddress, opts)
          return // eslint-disable-line
        }
      }
    } else {
      switch (mode) {
        case FROM_CLIENT: {
          // TODO: if no relay is known route closer to the target instead of timing out
          if (!noise) return
          if (!relay && !relayAddress) { // help the user route
            req.reply(null, { token: false, closerNodes: true })
            return
          }
          req.relay(c.encode(handshake, { mode: FROM_RELAY, noise, peerAddress: req.from, relayAddress: null }), relayAddress || relay)
          return
        }
        case FROM_RELAY: {
          if (!relay || !noise) return
          req.relay(c.encode(handshake, { mode: FROM_SECOND_RELAY, noise, peerAddress, relayAddress: req.from }), relay)
          return
        }
        case FROM_SERVER: {
          if (!peerAddress || !noise) return
          req.reply(c.encode(handshake, { mode: REPLY, noise, peerAddress: req.from, relayAddress: null }), { to: peerAddress, closerNodes: false, token: false })
          return // eslint-disable-line
        }
      }
    }
  }

  async peerHolepunch (target, { id, payload, peerAddress, socket, session }, to) {
    const dht = this.dht
    const requestValue = c.encode(holepunch, {
      mode: FROM_CLIENT,
      id,
      payload,
      peerAddress
    })

    const res = await dht.request({ command: COMMANDS.PEER_HOLEPUNCH, target, value: requestValue }, to, { socket, session })

    const hp = decode(holepunch, res.value)
    if (!hp || hp.mode !== REPLY || (to.host !== res.from.host || to.port !== res.from.port)) {
      throw BAD_HOLEPUNCH_REPLY()
    }

    return {
      from: res.from,
      to: res.to,
      payload: hp.payload,
      peerAddress: hp.peerAddress || to
    }
  }

  async onpeerholepunch (req) {
    const hp = req.value && decode(holepunch, req.value)
    if (!hp) return

    const { mode, id, payload, peerAddress } = hp

    const state = req.target && this.get(req.target)
    const isServer = !!(state && state.onpeerholepunch)
    const relay = state && state.relay

    switch (mode) {
      case FROM_CLIENT: {
        if (!peerAddress && !relay) return
        req.relay(c.encode(holepunch, { mode: FROM_RELAY, id, payload, peerAddress: req.from }), peerAddress || relay)
        return
      }
      case FROM_RELAY: {
        if (!isServer || !peerAddress) return
        let reply = null
        try {
          reply = await state.onpeerholepunch({ id, payload, peerAddress }, req)
        } catch (e) {
          safetyCatch(e)
          return
        }
        if (!reply) return
        const opts = { socket: reply.socket, closerNodes: false, token: false }
        req.relay(c.encode(holepunch, { mode: FROM_SERVER, id: 0, payload: reply.payload, peerAddress }), req.from, opts)
        return
      }
      case FROM_SERVER: {
        req.reply(c.encode(holepunch, { mode: REPLY, id, payload, peerAddress: req.from }), { to: peerAddress, closerNodes: false, token: false })
        return // eslint-disable-line
      }
    }
  }
}

function decode (enc, val) {
  try {
    return c.decode(enc, val)
  } catch {
    return null
  }
}

function toString (t) {
  return typeof t === 'string' ? t : b4a.toString(t, 'hex')
}
