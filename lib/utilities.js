const sodium = require('sodium-universal')
const cenc = require('compact-encoding')
const messages = require('./messages')

const NS_HOLEPUNCH = hash(Buffer.from('hyperswarm_holepunch'))
const NS_SIGNATURE = hash(Buffer.from('hyperswarm_signature'))

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}

function noop () {}

function allowAll () {
  return true
}

function mapImmutable (node) {
  if (!node.value) return null
  return {
    id: node.id,
    value: node.value,
    token: node.token,
    from: node.from,
    to: node.to
  }
}

function mapMutable (node) {
  if (!node.value) return null
  try {
    const { value, signature, seq, publicKey } = cenc.decode(messages.mutable, node.value)
    return {
      id: node.id,
      value,
      signature,
      seq,
      publicKey,
      payload: node.value,
      token: node.token,
      from: node.from,
      to: node.to
    }
  } catch {
    return null
  }
}

function mapLookup (node) {
  if (!node.value) return null
  try {
    return {
      id: node.id,
      token: node.token,
      from: node.from,
      to: node.to,
      peers: cenc.decode(messages.lookup, node.value)
    }
  } catch {
    return null
  }
}

function mapConnect (node) {
  if (!node.value) return null

  try {
    return {
      from: node.from,
      token: node.token,
      connect: cenc.decode(messages.connectRelay, node.value)
    }
  } catch {
    return null
  }
}

module.exports = {
  hash, noop, allowAll, mapImmutable, mapMutable, mapLookup, mapConnect, NS_HOLEPUNCH, NS_SIGNATURE
}
