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
  { host: '88.99.3.86', port: 10001 }
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

const ns = Buffer.alloc(160)

exports.NS = {
  ANNOUNCE: ns.subarray(0, 32),
  UNANNOUNCE: ns.subarray(32, 64),
  MUTABLE_PUT: ns.subarray(64, 96),
  PEER_HANDSHAKE: ns.subarray(96, 128),
  PEER_HOLEPUNCH: ns.subarray(128, 160)
}

const NS = Buffer.from('hyperswarm')

sodium.crypto_generichash_batch(exports.NS.ANNOUNCE, [NS, Buffer.from([COMMANDS.ANNOUNCE])])
sodium.crypto_generichash_batch(exports.NS.UNANNOUNCE, [NS, Buffer.from([COMMANDS.UNANNOUNCE])])
sodium.crypto_generichash_batch(exports.NS.MUTABLE_PUT, [NS, Buffer.from([COMMANDS.MUTABLE_PUT])])
sodium.crypto_generichash_batch(exports.NS.PEER_HANDSHAKE, [NS, Buffer.from([COMMANDS.PEER_HANDSHAKE])])
sodium.crypto_generichash_batch(exports.NS.PEER_HOLEPUNCH, [NS, Buffer.from([COMMANDS.PEER_HOLEPUNCH])])
