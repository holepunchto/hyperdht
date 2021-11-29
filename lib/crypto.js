const sodium = require('sodium-universal')

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}

function createKeyPair (seed) {
  const publicKey = Buffer.alloc(32)
  const secretKey = Buffer.alloc(64)
  if (seed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  else sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

module.exports = {
  hash,
  createKeyPair
}
