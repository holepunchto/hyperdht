const sodium = require('sodium-universal')

const COMMANDS = exports.COMMANDS = {
  PEER_HANDSHAKE: 0,
  PEER_HOLEPUNCH: 1,
  FIND_PEER: 2,
  LOOKUP: 3,
  ANNOUNCE: 4,
  UNANNOUNCE: 5,
  MUTABLE_PUT: 6,
  MUTABLE_GET: 7,
  IMMUTABLE_PUT: 8,
  IMMUTABLE_GET: 9
}

exports.BOOTSTRAP_NODES = [
  { host: 'testnet1.hyperdht.org', port: 49736 },
  { host: 'testnet2.hyperdht.org', port: 49736 },
  { host: 'testnet3.hyperdht.org', port: 49736 }
]

exports.FIREWALL = {
  UNKNOWN: 0,
  OPEN: 1,
  CONSISTENT: 2,
  RANDOM: 3
}

exports.ERROR = {
  // noise / connection related
  NONE: 0,
  ABORTED: 1,
  VERSION_MISMATCH: 2,
  // dht related
  SEQ_REUSED: 16,
  SEQ_TOO_LOW: 17
}

exports.PROTOCOL = {
  TCP: 1,
  UTP: 2
}

const slab = Buffer.alloc(192)
const NS = slab.subarray(0, 32)

exports.NS = {
  ANNOUNCE: slab.subarray(32, 64),
  UNANNOUNCE: slab.subarray(64, 96),
  MUTABLE_PUT: slab.subarray(96, 128),
  PEER_HANDSHAKE: slab.subarray(128, 160),
  PEER_HOLEPUNCH: slab.subarray(160, 192)
}

sodium.crypto_generichash(NS, Buffer.from('hyperswarm/dht'))
sodium.crypto_generichash(exports.NS.ANNOUNCE, Buffer.from([COMMANDS.ANNOUNCE]), NS)
sodium.crypto_generichash(exports.NS.UNANNOUNCE, Buffer.from([COMMANDS.UNANNOUNCE]), NS)
sodium.crypto_generichash(exports.NS.MUTABLE_PUT, Buffer.from([COMMANDS.MUTABLE_PUT]), NS)
sodium.crypto_generichash(exports.NS.PEER_HANDSHAKE, Buffer.from([COMMANDS.PEER_HANDSHAKE]), NS)
sodium.crypto_generichash(exports.NS.PEER_HOLEPUNCH, Buffer.from([COMMANDS.PEER_HOLEPUNCH]), NS)
