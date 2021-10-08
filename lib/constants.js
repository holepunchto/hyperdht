const sodium = require('sodium-universal')

exports.FIREWALL = {
  UNKNOWN: 0,
  OPEN: 1,
  CONSISTENT: 2,
  RANDOM: 3
}

exports.ERROR = {
  NONE: 0,
  ABORTED: 1,
  VERSION_MISMATCH: 2
}

exports.PROTOCOL = {
  TCP: 1,
  UTP: 2
}

exports.BOOTSTRAP_NODES = [
  { host: '88.99.3.86', port: 10001 }
]

const ns = Buffer.alloc(64)

exports.NS = {
  ANNOUNCE: ns.subarray(0, 32),
  UNANNOUNCE: ns.subarray(32, 64)
}

sodium.crypto_generichash(exports.NS.ANNOUNCE, Buffer.from('hyperswarm_announce'))
sodium.crypto_generichash(exports.NS.UNANNOUNCE, Buffer.from('hyperswarm_unannounce'))
