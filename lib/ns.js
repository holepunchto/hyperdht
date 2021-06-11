const sodium = require('sodium-universal')

const NS = Buffer.alloc(128)
const NS_ANNOUNCE = NS.subarray(0, 32)
const NS_UNANNOUNCE = NS.subarray(32, 64)
const NS_HOLEPUNCH = NS.subarray(64, 96)
const NS_MUTABLE = NS.subarray(96, 128)

sodium.crypto_generichash(NS_ANNOUNCE, Buffer.from('hyperswarm_announce'))
sodium.crypto_generichash(NS_UNANNOUNCE, Buffer.from('hyperswarm_unannounce'))
sodium.crypto_generichash(NS_HOLEPUNCH, Buffer.from('hyperswarm_holepunch'))
sodium.crypto_generichash(NS_MUTABLE, Buffer.from('hyperswarm_mutable'))

module.exports = { NS_ANNOUNCE, NS_UNANNOUNCE, NS_MUTABLE, NS_HOLEPUNCH }
