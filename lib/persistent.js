const c = require('compact-encoding')
const sodium = require('sodium-universal')
const RecordCache = require('record-cache')
const Cache = require('xache')
const b4a = require('b4a')
const unslab = require('unslab')

const { encodeUnslab } = require('./encode')
const m = require('./messages')
const { NS, ERROR } = require('./constants')

const EMPTY = b4a.alloc(0)
const TMP = b4a.allocUnsafe(32)

const rawArray = c.array(c.raw)

module.exports = class Persistent {
  constructor (dht, opts) {
    this.dht = dht
    this.records = new RecordCache(opts.records)
    this.refreshes = new Cache(opts.refreshes)
    this.mutables = new Cache(opts.mutables)
    this.immutables = new Cache(opts.immutables)
  }

  onlookup (req) {
    if (!req.target) return

    const k = b4a.toString(req.target, 'hex')
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
    const k = b4a.toString(target, 'hex')
    sodium.crypto_generichash(TMP, publicKey)

    if (b4a.equals(TMP, target)) this.dht._router.delete(k)
    this.records.remove(k, publicKey)
  }

  onunannounce (req) {
    if (!req.target || !req.token) return

    const unann = decode(m.announce, req.value)
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

  _onrefresh (token, req) {
    sodium.crypto_generichash(TMP, token)
    const activeRefresh = b4a.toString(TMP, 'hex')

    const r = this.refreshes.get(activeRefresh)
    if (!r) return

    const { announceSelf, k, record } = r
    const publicKey = record.subarray(0, 32)

    if (announceSelf) {
      this.dht._router.set(k, {
        relay: req.from,
        record,
        onconnect: null,
        onholepunch: null
      })
      this.records.remove(k, publicKey)
    } else {
      this.records.add(k, publicKey, record)
    }

    this.refreshes.delete(activeRefresh)
    this.refreshes.set(b4a.toString(token, 'hex'), r)

    req.reply(null, { token: false, closerNodes: false })
  }

  onannounce (req) {
    if (!req.target || !req.token || !this.dht.id) return

    const ann = decode(m.announce, req.value)
    if (ann === null) return

    const signable = annSignable(req.target, req.token, this.dht.id, ann, NS.ANNOUNCE)
    const { peer, refresh, signature } = ann

    if (!peer) {
      if (!refresh) return
      this._onrefresh(refresh, req)
      return
    }

    if (!signature || !sodium.crypto_sign_verify_detached(signature, signable, peer.publicKey)) {
      return
    }

    // TODO: it would be potentially be more optimal to allow more than 3 addresses here for a findPeer response
    // and only use max 3 for a lookup reply
    if (peer.relayAddresses.length > 3) {
      peer.relayAddresses = peer.relayAddresses.slice(0, 3)
    }

    sodium.crypto_generichash(TMP, peer.publicKey)

    const k = b4a.toString(req.target, 'hex')
    const announceSelf = b4a.equals(TMP, req.target)
    const record = encodeUnslab(m.peer, peer)

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

    if (refresh) {
      this.refreshes.set(b4a.toString(refresh, 'hex'), { k, record, announceSelf })
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  onmutableget (req) {
    if (!req.target || !req.value) return

    let seq = 0
    try {
      seq = c.decode(c.uint, req.value)
    } catch {
      return
    }

    const k = b4a.toString(req.target, 'hex')
    const value = this.mutables.get(k)

    if (!value) {
      req.reply(null)
      return
    }

    const localSeq = c.decode(c.uint, value)
    req.reply(localSeq < seq ? null : value)
  }

  onmutableput (req) {
    if (!req.target || !req.token || !req.value) return

    const p = decode(m.mutablePutRequest, req.value)
    if (!p) return

    const { publicKey, seq, value, signature } = p

    const hash = b4a.allocUnsafe(32)
    sodium.crypto_generichash(hash, publicKey)
    if (!b4a.equals(hash, req.target)) return

    if (!value || !verifyMutable(signature, seq, value, publicKey)) return

    const k = b4a.toString(hash, 'hex')
    const local = this.mutables.get(k)

    if (local) {
      const existing = c.decode(m.mutableGetResponse, local)
      if (existing.value && existing.seq === seq && b4a.compare(value, existing.value) !== 0) {
        req.error(ERROR.SEQ_REUSED)
        return
      }
      if (seq < existing.seq) {
        req.error(ERROR.SEQ_TOO_LOW)
        return
      }
    }

    this.mutables.set(k, encodeUnslab(m.mutableGetResponse, { seq, value, signature }))
    req.reply(null)
  }

  onimmutableget (req) {
    if (!req.target) return

    const k = b4a.toString(req.target, 'hex')
    const value = this.immutables.get(k)

    req.reply(value || null)
  }

  onimmutableput (req) {
    if (!req.target || !req.token || !req.value) return

    const hash = b4a.alloc(32)
    sodium.crypto_generichash(hash, req.value)
    if (!b4a.equals(hash, req.target)) return

    const k = b4a.toString(hash, 'hex')
    this.immutables.set(k, unslab(req.value))

    req.reply(null)
  }

  destroy () {
    this.records.destroy()
    this.refreshes.destroy()
    this.mutables.destroy()
    this.immutables.destroy()
  }

  static signMutable (seq, value, keyPair) {
    const signable = b4a.allocUnsafe(32 + 32)
    const hash = signable.subarray(32)

    signable.set(NS.MUTABLE_PUT, 0)

    sodium.crypto_generichash(hash, c.encode(m.mutableSignable, { seq, value }))
    return sign(signable, keyPair)
  }

  static verifyMutable (signature, seq, value, publicKey) {
    return verifyMutable(signature, seq, value, publicKey)
  }

  static signAnnounce (target, token, id, ann, keyPair) {
    return sign(annSignable(target, token, id, ann, NS.ANNOUNCE), keyPair)
  }

  static signUnannounce (target, token, id, ann, keyPair) {
    return sign(annSignable(target, token, id, ann, NS.UNANNOUNCE), keyPair)
  }
}

function verifyMutable (signature, seq, value, publicKey) {
  const signable = b4a.allocUnsafe(32 + 32)
  const hash = signable.subarray(32)

  signable.set(NS.MUTABLE_PUT, 0)

  sodium.crypto_generichash(hash, c.encode(m.mutableSignable, { seq, value }))
  return sodium.crypto_sign_verify_detached(signature, signable, publicKey)
}

function annSignable (target, token, id, ann, ns) {
  const signable = b4a.allocUnsafe(32 + 32)
  const hash = signable.subarray(32)

  signable.set(ns, 0)

  sodium.crypto_generichash_batch(hash, [
    target,
    id,
    token,
    c.encode(m.peer, ann.peer), // note that this is the partial encoding of the announce message so we could just use that for perf
    ann.refresh || EMPTY
  ])

  return signable
}

function sign (signable, keyPair) {
  if (keyPair.sign) {
    return keyPair.sign(signable)
  }
  const secretKey = keyPair.secretKey ? keyPair.secretKey : keyPair
  const signature = b4a.allocUnsafe(64)
  sodium.crypto_sign_detached(signature, signable, secretKey)
  return signature
}

function decode (enc, val) {
  try {
    return val && c.decode(enc, val)
  } catch (err) {
    return null
  }
}
