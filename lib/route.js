const c = require('compact-encoding')
const safetyCatch = require('safety-catch')
const { connect, holepunch } = require('./messages')

const FROM_CLIENT = 0
const FROM_SERVER = 1
const FROM_RELAY = 2
const FROM_SECOND_RELAY = 3
const REPLY = 4

// TODO: While the current design is very trustless in regards to clients/servers trusting the DHT,
// we should add a bunch of rate limits everywhere, especially including here to avoid bad users
// using a DHT node to relay traffic indiscriminately using the connect/holepunch messages.
// That's mostly from an abuse POV as none of the messsages do amplication.

module.exports = class HolepunchRouter {
  constructor (dht) {
    this.dht = dht
    this.forwards = new Map()
  }

  set (target, state) {
    this.forwards.set(target.toString('hex'), state)
  }

  get (target) {
    return this.forwards.get(target.toString('hex'))
  }

  delete (target) {
    this.forwards.delete(target.toString('hex'))
  }

  async connect (target, { noise, peerAddress, relayAddress }, to) {
    const dht = this.dht
    const requestValue = c.encode(connect, {
      mode: FROM_CLIENT,
      noise,
      peerAddress,
      relayAddress
    })

    const res = await dht.request({ command: 'connect', target, value: requestValue }, to)

    const con = decode(connect, res.value)
    if (!con || con.mode !== REPLY || (to.host !== res.from.host || to.port !== res.from.port) || !con.noise) {
      throw new Error('Bad connect reply')
    }

    return {
      noise: con.noise,
      relayed: !!con.peerAddress,
      serverAddress: con.peerAddress || to,
      clientAddress: res.to
    }
  }

  async onconnect (req) {
    const con = req.value && decode(connect, req.value)
    if (!con) return

    const { mode, noise, peerAddress, relayAddress } = con

    const state = req.target && this.forwards.get(req.target.toString('hex'))
    const isServer = !!(state && state.server)
    const relay = state && state.relay

    if (isServer) {
      let reply = null
      try {
        reply = noise && await state.server.onconnect({ noise, peerAddress }, req)
      } catch (e) {
        safetyCatch(e)
        return
      }
      if (!reply || !reply.noise) return
      const opts = { socket: reply.socket, closerNodes: false, token: false }

      switch (mode) {
        case FROM_CLIENT: {
          req.reply(c.encode(connect, { mode: REPLY, noise: reply.noise, peerAddress: null }), opts)
          return
        }
        case FROM_RELAY: {
          req.relay(c.encode(connect, { mode: FROM_SERVER, noise: reply.noise, peerAddress }), req.from, opts)
          return
        }
        case FROM_SECOND_RELAY: {
          if (!relayAddress) return
          req.relay(c.encode(connect, { mode: FROM_SERVER, noise: reply.noise, peerAddress }), relayAddress, opts)
          return
        }
      }
    } else {
      switch (mode) {
        case FROM_CLIENT: {
          if ((!relay && !relayAddress) || !noise) return
          req.relay(c.encode(connect, { mode: FROM_RELAY, noise, peerAddress: req.from, relayAddress: null }), relayAddress || relay)
          return
        }
        case FROM_RELAY: {
          if (!relay || !noise) return
          req.relay(c.encode(connect, { mode: FROM_SECOND_RELAY, noise, peerAddress, relayAddress: req.from }), relay)
          return
        }
        case FROM_SERVER: {
          if (!peerAddress || !noise) return
          req.reply(c.encode(connect, { mode: REPLY, noise, peerAddress: req.from, relayAddress: null }), { to: peerAddress, closerNodes: false, token: false })
          return
        }
      }
    }
  }

  async holepunch (target, { id, payload, peerAddress, socket }, to) {
    const dht = this.dht
    const requestValue = c.encode(holepunch, {
      mode: FROM_CLIENT,
      id,
      payload,
      peerAddress
    })

    const res = await dht.request({ command: 'holepunch', target, value: requestValue }, to, { socket })

    const hp = decode(holepunch, res.value)
    if (!hp || hp.mode !== REPLY || (to.host !== res.from.host || to.port !== res.from.port)) {
      throw new Error('Bad holepunch reply')
    }

    return {
      from: res.from,
      to: res.to,
      payload: hp.payload,
      peerAddress: hp.peerAddress
    }
  }

  async onholepunch (req) {
    const hp = req.value && decode(holepunch, req.value)
    if (!hp) return

    const { mode, id, payload, peerAddress } = hp

    const state = req.target && this.forwards.get(req.target.toString('hex'))
    const isServer = !!(state && state.server)
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
          reply = await state.server.onholepunch({ id, payload, peerAddress }, req)
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
        return
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
