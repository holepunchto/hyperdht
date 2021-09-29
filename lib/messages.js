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

const relayInfo = {
  preencode (state, m) {
    state.end += 12
  },
  encode (state, m) {
    ipv4.encode(state, m.relayAddress)
    ipv4.encode(state, m.peerAddress)
  },
  decode (state) {
    return {
      relayAddress: ipv4.decode(state),
      peerAddress: ipv4.decode(state)
    }
  }
}

const relayInfoArray = c.array(relayInfo)

const holepunchInfo = {
  preencode (state, m) {
    c.uint.preencode(state, m.id)
    relayInfoArray.preencode(state, m.relays)
  },
  encode (state, m) {
    c.uint.encode(state, m.id)
    relayInfoArray.encode(state, m.relays)
  },
  decode (state) {
    return {
      id: c.uint.decode(state),
      relays: relayInfoArray.decode(state)
    }
  }
}

exports.noisePayload = {
  preencode (state, m) {
    state.end += 5 // version + flags + error + firewall + protocols
    if (m.holepunch) holepunchInfo.preencode(state, m.holepunch)
    if (m.addresses) ipv4Array.preencode(state, m.addresses)
  },
  encode (state, m) {
    const flags = (m.holepunch ? 1 : 0) | (m.addresses ? 2 : 0)

    c.uint.encode(state, 1) // version

    c.uint.encode(state, flags)
    c.uint.encode(state, m.error)
    c.uint.encode(state, m.firewall)
    c.uint.encode(state, m.protocols)

    if (m.holepunch) holepunchInfo.encode(state, m.holepunch)
    if (m.addresses) ipv4Array.encode(state, m.addresses)
  },
  decode (state) {
    const version = c.uint.decode(state)
    if (version !== 1) { // do not attempt to decode but return this back to the user so they can actually handle it
      return { version, error: 0, firewall: 0, protocols: 0, holepunch: null, addresses: null }
    }

    const flags = c.uint.decode(state)

    return {
      version,
      error: c.uint.decode(state),
      firewall: c.uint.decode(state),
      protocols: c.uint.decode(state),
      holepunch: (flags & 1) !== 0 ? holepunchInfo.decode(state) : null,
      addresses: (flags & 2) !== 0 ? ipv4Array.decode(state) : null
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

exports.holepunchPayload = {
  preencode (state, m) {
    state.end += 3 // flags + error + firewall
    if (m.address) state.end += 6
    if (m.remoteAddress) state.end += 6
    if (m.token) state.end += 32
    if (m.remoteToken) state.end += 32
  },
  encode (state, m) {
    const flags = (m.punching ? 1 : 0) | (m.address ? 2 : 0) | (m.remoteAddress ? 4 : 0) | (m.token ? 8 : 0) | (m.remoteToken ? 16 : 0)

    c.uint.encode(state, flags)
    c.uint.encode(state, m.error)
    c.uint.encode(state, m.firewall)

    if (m.address) ipv4.encode(state, m.address)
    if (m.remoteAddress) ipv4.encode(state, m.remoteAddress)
    if (m.token) c.fixed32.encode(state, m.token)
    if (m.remoteToken) c.fixed32.encode(state, m.remoteToken)
  },
  decode (state) {
    const flags = c.uint.decode(state)

    return {
      error: c.uint.decode(state),
      firewall: c.uint.decode(state),
      punching: (flags & 1) !== 0,
      address: (flags & 2) !== 0 ? ipv4.decode(state) : null,
      remoteAddress: (flags & 4) !== 0 ? ipv4.decode(state) : null,
      token: (flags & 8) !== 0 ? c.fixed32.decode(state) : null,
      remoteToken: (flags & 16) !== 0 ? c.fixed32.decode(state) : null
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
