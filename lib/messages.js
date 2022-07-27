const c = require('compact-encoding')
const net = require('compact-encoding-net')

const ipv4 = {
  ...net.ipv4Address,
  decode (state) {
    const ip = net.ipv4Address.decode(state)
    return {
      host: ip.host,
      port: ip.port
    }
  }
}

const ipv4Array = c.array(ipv4)

const ipv6 = {
  ...net.ipv6Address,
  decode (state) {
    const ip = net.ipv6Address.decode(state)
    return {
      host: ip.host,
      port: ip.port
    }
  }
}

const ipv6Array = c.array(ipv6)

exports.handshake = {
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

const udxInfo = {
  preencode (state, m) {
    state.end += 2 // version + features
    c.uint.preencode(state, m.id)
    c.uint.preencode(state, m.seq)
  },
  encode (state, m) {
    c.uint.encode(state, 1)
    c.uint.encode(state, m.reusableSocket ? 1 : 0)
    c.uint.encode(state, m.id)
    c.uint.encode(state, m.seq)
  },
  decode (state) {
    const version = c.uint.decode(state)
    const features = c.uint.decode(state)

    return {
      version,
      reusableSocket: (features & 1) !== 0,
      id: c.uint.decode(state),
      seq: c.uint.decode(state)
    }
  }
}

const secretStreamInfo = {
  preencode (state, m) {
    c.uint.preencode(state, 1)
  },
  encode (state, m) {
    c.uint.encode(state, 1)
  },
  decode (state) {
    return {
      version: c.uint.decode(state)
    }
  }
}

exports.noisePayload = {
  preencode (state, m) {
    state.end += 4 // version + flags + error + firewall
    if (m.holepunch) holepunchInfo.preencode(state, m.holepunch)
    if (m.addresses4 && m.addresses4.length) ipv4Array.preencode(state, m.addresses4)
    if (m.addresses6 && m.addresses6.length) ipv6Array.preencode(state, m.addresses6)
    if (m.udx) udxInfo.preencode(state, m.udx)
    if (m.secretStream) secretStreamInfo.preencode(state, m.secretStream)
  },
  encode (state, m) {
    let flags = 0

    if (m.holepunch) flags |= 1
    if (m.addresses4 && m.addresses4.length) flags |= 2
    if (m.addresses6 && m.addresses6.length) flags |= 4
    if (m.udx) flags |= 8
    if (m.secretStream) flags |= 16

    c.uint.encode(state, 1) // version
    c.uint.encode(state, flags)
    c.uint.encode(state, m.error)
    c.uint.encode(state, m.firewall)

    if (m.holepunch) holepunchInfo.encode(state, m.holepunch)
    if (m.addresses4 && m.addresses4.length) ipv4Array.encode(state, m.addresses4)
    if (m.addresses6 && m.addresses6.length) ipv6Array.encode(state, m.addresses6)
    if (m.udx) udxInfo.encode(state, m.udx)
    if (m.secretStream) secretStreamInfo.encode(state, m.secretStream)
  },
  decode (state) {
    const version = c.uint.decode(state)

    if (version !== 1) {
      // Do not attempt to decode but return this back to the user so they can
      // actually handle it
      return {
        version,
        error: 0,
        firewall: 0,
        holepunch: null,
        addresses4: [],
        addresses6: [],
        udx: null,
        secretStream: null
      }
    }

    const flags = c.uint.decode(state)

    return {
      version,
      error: c.uint.decode(state),
      firewall: c.uint.decode(state),
      holepunch: (flags & 1) !== 0 ? holepunchInfo.decode(state) : null,
      addresses4: (flags & 2) !== 0 ? ipv4Array.decode(state) : [],
      addresses6: (flags & 4) !== 0 ? ipv6Array.decode(state) : [],
      udx: (flags & 8) !== 0 ? udxInfo.decode(state) : null,
      secretStream: (flags & 16) !== 0 ? secretStreamInfo.decode(state) : null
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
    state.end += 4 // flags + error + firewall + round
    if (m.addresses) ipv4Array.preencode(state, m.addresses)
    if (m.remoteAddress) state.end += 6
    if (m.token) state.end += 32
    if (m.remoteToken) state.end += 32
  },
  encode (state, m) {
    const flags = (m.connected ? 1 : 0) |
      (m.punching ? 2 : 0) |
      (m.addresses ? 4 : 0) |
      (m.remoteAddress ? 8 : 0) |
      (m.token ? 16 : 0) |
      (m.remoteToken ? 32 : 0)

    c.uint.encode(state, flags)
    c.uint.encode(state, m.error)
    c.uint.encode(state, m.firewall)
    c.uint.encode(state, m.round)

    if (m.addresses) ipv4Array.encode(state, m.addresses)
    if (m.remoteAddress) ipv4.encode(state, m.remoteAddress)
    if (m.token) c.fixed32.encode(state, m.token)
    if (m.remoteToken) c.fixed32.encode(state, m.remoteToken)
  },
  decode (state) {
    const flags = c.uint.decode(state)

    return {
      error: c.uint.decode(state),
      firewall: c.uint.decode(state),
      round: c.uint.decode(state),
      connected: (flags & 1) !== 0,
      punching: (flags & 2) !== 0,
      addresses: (flags & 4) !== 0 ? ipv4Array.decode(state) : null,
      remoteAddress: (flags & 8) !== 0 ? ipv4.decode(state) : null,
      token: (flags & 16) !== 0 ? c.fixed32.decode(state) : null,
      remoteToken: (flags & 32) !== 0 ? c.fixed32.decode(state) : null
    }
  }
}

const peer = exports.peer = {
  preencode (state, m) {
    state.end += 32
    ipv4Array.preencode(state, m.relayAddresses)
  },
  encode (state, m) {
    c.fixed32.encode(state, m.publicKey)
    ipv4Array.encode(state, m.relayAddresses)
  },
  decode (state) {
    return {
      publicKey: c.fixed32.decode(state),
      relayAddresses: ipv4Array.decode(state)
    }
  }
}

exports.peers = c.array(peer)

exports.announce = {
  preencode (state, m) {
    state.end++ // flags
    if (m.peer) peer.preencode(state, m.peer)
    if (m.refresh) state.end += 32
    if (m.signature) state.end += 64
  },
  encode (state, m) {
    const flags = (m.peer ? 1 : 0) | (m.refresh ? 2 : 0) | (m.signature ? 4 : 0)
    c.uint.encode(state, flags)
    if (m.peer) peer.encode(state, m.peer)
    if (m.refresh) c.fixed32.encode(state, m.refresh)
    if (m.signature) c.fixed64.encode(state, m.signature)
  },
  decode (state) {
    const flags = c.uint.decode(state)

    return {
      peer: (flags & 1) !== 0 ? peer.decode(state) : null,
      refresh: (flags & 2) !== 0 ? c.fixed32.decode(state) : null,
      signature: (flags & 4) !== 0 ? c.fixed64.decode(state) : null
    }
  }
}

exports.mutableSignable = {
  preencode (state, m) {
    c.uint.preencode(state, m.seq)
    c.buffer.preencode(state, m.value)
  },
  encode (state, m) {
    c.uint.encode(state, m.seq)
    c.buffer.encode(state, m.value)
  },
  decode (state) {
    return {
      seq: c.uint.decode(state),
      value: c.buffer.decode(state)
    }
  }
}

exports.mutablePutRequest = {
  preencode (state, m) {
    c.fixed32.preencode(state, m.publicKey)
    c.uint.preencode(state, m.seq)
    c.buffer.preencode(state, m.value)
    c.fixed64.preencode(state, m.signature)
  },
  encode (state, m) {
    c.fixed32.encode(state, m.publicKey)
    c.uint.encode(state, m.seq)
    c.buffer.encode(state, m.value)
    c.fixed64.encode(state, m.signature)
  },
  decode (state) {
    return {
      publicKey: c.fixed32.decode(state),
      seq: c.uint.decode(state),
      value: c.buffer.decode(state),
      signature: c.fixed64.decode(state)
    }
  }
}

exports.mutableGetResponse = {
  preencode (state, m) {
    c.uint.preencode(state, m.seq)
    c.buffer.preencode(state, m.value)
    c.fixed64.preencode(state, m.signature)
  },
  encode (state, m) {
    c.uint.encode(state, m.seq)
    c.buffer.encode(state, m.value)
    c.fixed64.encode(state, m.signature)
  },
  decode (state) {
    return {
      seq: c.uint.decode(state),
      value: c.buffer.decode(state),
      signature: c.fixed64.decode(state)
    }
  }
}
