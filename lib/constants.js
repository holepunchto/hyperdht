const crypto = require('hypercore-crypto')

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

exports.BOOTSTRAP_NODES = global.Pear?.config.dht?.bootstrap || [
  '88.99.3.86@node1.hyperdht.org:49737',
  '142.93.90.113@node2.hyperdht.org:49737',
  '138.68.147.8@node3.hyperdht.org:49737'
]

exports.KNOWN_NODES = global.Pear?.config.dht?.nodes || []

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
  TRY_LATER: 3,
  // dht related
  SEQ_REUSED: 16,
  SEQ_TOO_LOW: 17
}

const [
  NS_ANNOUNCE,
  NS_UNANNOUNCE,
  NS_MUTABLE_PUT,
  NS_PEER_HANDSHAKE,
  NS_PEER_HOLEPUNCH
] = crypto.namespace('hyperswarm/dht', [
  COMMANDS.ANNOUNCE,
  COMMANDS.UNANNOUNCE,
  COMMANDS.MUTABLE_PUT,
  COMMANDS.PEER_HANDSHAKE,
  COMMANDS.PEER_HOLEPUNCH
])

exports.NS = {
  ANNOUNCE: NS_ANNOUNCE,
  UNANNOUNCE: NS_UNANNOUNCE,
  MUTABLE_PUT: NS_MUTABLE_PUT,
  PEER_HANDSHAKE: NS_PEER_HANDSHAKE,
  PEER_HOLEPUNCH: NS_PEER_HOLEPUNCH
}
