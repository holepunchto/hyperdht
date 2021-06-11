const sodium = require('sodium-universal')

const NS_ANNOUNCE = Buffer.allocUnsafe(32)
const NS_UNANNOUNCE = Buffer.allocUnsafe(32)
const NS_HOLEPUNCH = Buffer.allocUnsafe(32)
const NS_MUTABLE = Buffer.allocUnsafe(32)

sodium.crypto_generichash(NS_ANNOUNCE, Buffer.from('hyperswarm_announce'))
sodium.crypto_generichash(NS_UNANNOUNCE, Buffer.from('hyperswarm_unannounce'))
sodium.crypto_generichash(NS_ANNOUNCE, Buffer.from('hyperswarm_holepunch'))
sodium.crypto_generichash(NS_UNANNOUNCE, Buffer.from('hyperswarm_mutable'))

module.exports = { NS_ANNOUNCE, NS_UNANNOUNCE, NS_MUTABLE, NS_HOLEPUNCH }
