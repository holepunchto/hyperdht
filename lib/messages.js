const { ipv4, ipv4Array } = require('dht-rpc/lib/peer') // TODO: move to module or something
const c = require('compact-encoding')

exports.connect = {
  preencode (state, m) {
    state.end += 1 + 1 + (m.peerAddress ? 6 : 0) + (m.relayAddress ? 6 : 0)
    c.buffer.preencode(state, m.noise)
  },
  encode (state, m) {
    const flags = (m.peerAddress ? 1 : 0) | (m.relayAddress ? 2 : 0)

    c.uint.encode(state, flags)
    c.uint.encode(state, m.mode)
    c.buffer.encode(state, m.noise)

    if (m.peerAddress) ipv4.encode(state, m.peerAddress)
    if (m.relayAddress) ipv4.encode(state, m.relayAddress)
  },
  decode (state) {
    const flags = c.uint.decode(state)

    return {
      mode: c.uint.decode(state),
      noise: c.buffer.decode(state),
      peerAddress: (flags & 1) ? ipv4.decode(state) : null,
      relayAddress: (flags & 2) ? ipv4.decode(state) : null
    }
  }
}

exports.noisePayload = {
  preencode (state, m) {
    c.uint.preencode(state, 0) // flags
    c.uint.preencode(state, m.id)
  },
  encode (state, m) {
    c.uint.encode(state, 0)
    c.uint.encode(state, m.id)
  },
  decode (state) {
    const flags = c.uint.decode(state)

    return {
      id: c.uint.decode(state)
    }
  }
}

exports.holepunchPayload = {
  preencode (state, m) {
    state.end += 1 + 1 + 1 + (m.address ? 6 : 0) + (m.remoteAddress ? 6 : 0) + (m.token ? 32 : 0) + (m.remoteToken ? 32 : 0)
  },
  encode (state, m) {
    const flags = (m.address ? 1 : 0) | (m.remoteAddress ? 2 : 0) | (m.token ? 4 : 0) | (m.remoteToken ? 8 : 0)

    c.uint.encode(state, flags)
    c.uint.encode(state, m.status)
    c.uint.encode(state, m.nat)
    if (m.address) ipv4.encode(state, m.address)
    if (m.remoteAddress) ipv4.encode(state, m.remoteAddress)
    if (m.token) c.fixed32.encode(state, m.token)
    if (m.remoteToken) c.fixed32.encode(state, m.remoteToken)
  },
  decode (state) {
    const flags = c.uint.decode(state)

    return {
      status: c.uint.decode(state),
      nat: c.uint.decode(state),
      address: (flags & 1) ? ipv4.decode(state) : null,
      remoteAddress: (flags & 2) ? ipv4.decode(state) : null,
      token: (flags & 4) ? c.fixed32.decode(state) : null,
      remoteToken: (flags & 8) ? c.fixed32.decode(state) : null
    }
  }
}

exports.holepunch = {
  preencode (state, m) {
    state.end += 2
    c.uint.preencode(state, m.id)
    c.buffer.preencode(state, m.payload)
    if (m.peerAddress) ipv4.preencode(state, m.peerAddress)
  },
  encode (state, m) {
    const flags = m.peerAddress ? 1 : 0
    c.uint.encode(state, flags)
    c.uint.encode(state, m.mode)
    c.uint.encode(state, m.id)
    c.buffer.encode(state, m.payload)
    if (m.peerAddress) ipv4.encode(state, m.peerAddress)
  },
  decode (state) {
    const flags = c.uint.decode(state)
    return {
      mode: c.uint.decode(state),
      id: c.uint.decode(state),
      payload: c.buffer.decode(state),
      peerAddress: (flags & 1) ? ipv4.decode(state) : null
    }
  }
}

exports.findPeer = {
  preencode (state, m) {
    ipv4Array.preencode(state, m.nodes)
  },
  encode (state, m) {
    ipv4Array.encode(state, m.nodes)
  },
  decode (state) {
    return {
      nodes: ipv4Array.decode(state)
    }
  }
}
