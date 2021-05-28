const cenc = require('compact-encoding')
const DHT = require('dht-rpc')
const { peerIPv4, peerIPv4Array } = require('dht-rpc/lib/messages') // TODO: move to module or something

exports.peerIPv4 = peerIPv4
exports.peerIPv4Array = peerIPv4Array

exports.record = {
  preencode (state, m) {
    state.end += 32 + 1 + m.nodes.length * 6
  },
  encode (state, m) {
    cenc.fixed32.encode(state, m.publicKey)
    peerIPv4Array.encode(state, m.nodes)
  },
  decode (state) {
    return {
      publicKey: cenc.fixed32.decode(state),
      nodes: peerIPv4Array.decode(state)
    }
  }
}

exports.lookup = cenc.array(exports.record)

exports.announce = {
  preencode (state, m) {
    state.end += 32 + 64 + 1
    cenc.uint.preencode(state, m.timestamp)
    peerIPv4Array.preencode(state, m.nodes)
  },
  encode (state, m) {
    cenc.uint.encode(state, m.timestamp)
    cenc.fixed32.encode(state, m.publicKey)
    peerIPv4Array.encode(state, m.nodes)
    cenc.bool.encode(state, m.origin)
    cenc.fixed64.encode(state, m.signature)
  },
  decode (state) {
    return {
      timestamp: cenc.uint.decode(state),
      publicKey: cenc.fixed32.decode(state),
      nodes: peerIPv4Array.decode(state),
      origin: cenc.bool.decode(state),
      signature: cenc.fixed64.decode(state)
    }
  }
}

exports.announceSelf = {
  preencode (state, m) {
    state.end += 32 + 64
  },
  encode (state, m) {
    cenc.fixed32.encode(state, m.publicKey)
    cenc.fixed64.encode(state, m.signature)
  },
  decode (state) {
    return {
      publicKey: cenc.fixed32.decode(state),
      signature: cenc.fixed64.decode(state)
    }
  }
}

exports.connectRelay = {
  preencode (state, m) {
    cenc.buffer.preencode(state, m.noise)
    state.end += 32 + 2
  },
  encode (state, m) {
    cenc.buffer.encode(state, m.noise)
    cenc.uint16.encode(state, m.relayPort)
    cenc.fixed32.encode(state, m.relayAuth)
  },
  decode (state) {
    return {
      noise: cenc.buffer.decode(state),
      relayPort: cenc.uint16.decode(state),
      relayAuth: cenc.fixed32.decode(state)
    }
  }
}

exports.connect = {
  preencode (state, m) {
    cenc.buffer.preencode(state, m.noise)
    state.end += 32
  },
  encode (state, m) {
    cenc.buffer.encode(state, m.noise)
    cenc.fixed32.encode(state, m.relayAuth)
  },
  decode (state) {
    return {
      noise: cenc.buffer.decode(state),
      relayAuth: cenc.fixed32.decode(state)
    }
  }
}

exports.noisePayload = {
  preencode (state, p) {
    state.end += 2 // version + firewall
    peerIPv4Array.preencode(state, p.localAddresses)
    peerIPv4.preencode(state, p.address)
    if (p.relayAuth) state.end += 32
  },
  encode (state, p) {
    state.buffer[state.start++] = 0
    state.buffer[state.start++] = natToInt(p.firewall)
    peerIPv4Array.encode(state, p.localAddresses)
    peerIPv4.encode(state, p.address)
    if (p.relayAuth) cenc.fixed32.encode(state, p.relayAuth)
  },
  decode (state) {
    const version = cenc.uint.decode(state)
    if (version !== 0) throw new Error('Unsupported version')

    return {
      firewall: intToNat(cenc.uint.decode(state)),
      localAddresses: peerIPv4Array.decode(state),
      address: peerIPv4.decode(state),
      relayAuth: state.end > state.start ? cenc.fixed32.decode(state) : null
    }
  }
}

function intToNat (type) {
  switch (type) {
    case 0: return DHT.NAT_UNKNOWN
    case 1: return DHT.NAT_OPEN
    case 2: return DHT.NAT_PORT_CONSISTENT
    case 3: return DHT.NAT_PORT_INCREMENTING
    case 4: return DHT.NAT_PORT_RANDOMIZED
  }

  throw new Error('Unknown NAT type')
}

function natToInt (type) {
  switch (type) {
    case DHT.NAT_UNKNOWN: return 0
    case DHT.NAT_OPEN: return 1
    case DHT.NAT_PORT_CONSISTENT: return 2
    case DHT.NAT_PORT_INCREMENTING: return 3
    case DHT.NAT_PORT_RANDOMIZED: return 4
  }

  throw new Error('Unknown NAT type')
}
