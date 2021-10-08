const c = require('compact-encoding')
const sodium = require('sodium-universal')
const RecordCache = require('record-cache')
const m = require('./messages')
const { NS } = require('./constants')

const EMPTY = Buffer.alloc(0)
const TMP = Buffer.allocUnsafe(32)

const rawArray = c.array(c.raw)

module.exports = class Persistent {
  constructor (dht, { maxSize, maxAge }) {
    this.dht = dht
    this.records = new RecordCache({ maxSize, maxAge })
  }

  onlookup (req) {
    if (!req.target) return

    const k = req.target.toString('hex')
    const records = this.records.get(k, 20)
    const fwd = this.dht._router.get(k)

    if (fwd && records.length < 20) records.push(fwd.record)

    req.reply(records.length ? c.encode(rawArray, records) : null)
  }

  onfindpeer (req) {
    if (!req.target) return
    const fwd = this.dht._router.get(req.target)
    req.reply(fwd ? fwd.record : null)
  }

  unannounce (target, publicKey) {
    const k = target.toString('hex')
    sodium.crypto_generichash(TMP, publicKey)

    if (TMP.equals(target)) this.dht._router.delete(k)
    this.records.remove(k, publicKey)
  }

  onunannounce (req) {
    if (!req.target || !req.token) return

    const unann = decode(m.unannounce, req.value)
    if (unann === null) return

    const { peer, signature } = unann
    if (!peer || !signature) return

    const signable = annSignable(req.target, req.token, this.dht.id, unann, NS.UNANNOUNCE)

    if (!sodium.crypto_sign_verify_detached(signature, signable, peer.publicKey)) {
      return
    }

    this.unannounce(req.target, peer.publicKey)
    req.reply(null, { token: false, closerNodes: false })
  }

  onannounce (req) {
    if (!req.target || !req.token) return

    const ann = decode(m.announce, req.value)
    if (ann === null) return

    const signable = annSignable(req.target, req.token, this.dht.id, ann, NS.ANNOUNCE)
    const { peer, refresh, signature } = ann

    if (!peer) {
      if (!refresh) return
      console.log('check refresh token')
      return
    }

    if (!sodium.crypto_sign_verify_detached(signature, signable, peer.publicKey)) {
      return
    }

    if (peer.relayAddresses.length > 3) {
      peer.relayAddresses = peer.relayAddresses.slice(0, 3)
    }

    sodium.crypto_generichash(TMP, peer.publicKey)

    const k = req.target.toString('hex')
    const announceSelf = TMP.equals(req.target)
    const record = c.encode(m.peer, peer)

    if (announceSelf) {
      this.dht._router.set(k, {
        relay: req.from,
        record,
        onconnect: null,
        onholepunch: null
      })
      this.records.remove(k, peer.publicKey)
    } else {
      this.records.add(k, peer.publicKey, record)
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  static signAnnounce (target, token, id, ann, secretKey) {
    const signature = Buffer.allocUnsafe(64)
    sodium.crypto_sign_detached(signature, annSignable(target, token, id, ann, NS.ANNOUNCE), secretKey)
    return signature
  }

  static signUnannounce (target, token, id, ann, secretKey) {
    const signature = Buffer.allocUnsafe(64)
    sodium.crypto_sign_detached(signature, annSignable(target, token, id, ann, NS.UNANNOUNCE), secretKey)
    return signature
  }
}

function annSignable (target, token, id, ann, ns) {
  const hash = Buffer.allocUnsafe(32)

  sodium.crypto_generichash_batch(hash, [
    target,
    id,
    token,
    c.encode(m.peer, ann.peer), // note that this is the partial encoding of the announce message so we could just use that for perf
    ann.refresh || EMPTY
  ], ns)

  return hash
}

function decode (enc, val) {
  try {
    return val && c.decode(enc, val)
  } catch {
    return null
  }
}
