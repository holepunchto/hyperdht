const sodium = require('sodium-universal')

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

const ns = Buffer.alloc(128)

exports.NS = {
  ANNOUNCE: ns.subarray(0, 32),
  UNANNOUNCE: ns.subarray(32, 64),
  MUTABLE: ns.subarray(64, 96),
  HOLEPUNCH: ns.subarray(96, 128)
}

sodium.crypto_generichash(exports.NS.ANNOUNCE, Buffer.from('hyperswarm_announce'))
sodium.crypto_generichash(exports.NS.UNANNOUNCE, Buffer.from('hyperswarm_unannounce'))
sodium.crypto_generichash(exports.NS.MUTABLE, Buffer.from('hyperswarm_mutable'))
sodium.crypto_generichash(exports.NS.HOLEPUNCH, Buffer.from('hyperswarm_holepunch'))
