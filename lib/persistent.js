const DHT = require('dht-rpc')
const sodium = require('sodium-universal')
const cenc = require('compact-encoding')
const Cache = require('xache')
const RecordCache = require('record-cache')
const { Hypersign } = require('@hyperswarm/hypersign')
const messages = require('./messages')
const { INVALID_SEQ, SEQ_TOO_LOW } = require('./errors')
const TMP = Buffer.allocUnsafe(32)
const SIGNATURE_TIMEOUT = 1 * 60 * 1000

const NS_ANNOUNCE = Buffer.allocUnsafe(32)
const NS_UNANNOUNCE = Buffer.allocUnsafe(32)

sodium.crypto_generichash(NS_ANNOUNCE, Buffer.from('hyperswarm_announce'))
sodium.crypto_generichash(NS_UNANNOUNCE, Buffer.from('hyperswarm_unannounce'))

const rawArray = cenc.array(cenc.raw)
const hypersign = new Hypersign()

module.exports = class PersistentNode {
  constructor (dht) {
    const maxSize = 65536
    const maxAge = 20 * 60 * 1000

    this.dht = dht
    this.forwards = new Cache({ maxSize, maxAge })
    this.mutables = new Cache({ maxSize: maxSize / 2, maxAge })
    this.immutables = new Cache({ maxSize: maxSize / 2, maxAge })
    this.records = new RecordCache({ maxSize, maxAge })
  }

  _isSelf (node) {
    DHT.id(node, TMP)
    return this.dht.id.equals(TMP)
  }

  onget (req, { mutable }) {
    if (!req.target) return req.reply(null)
    const store = mutable ? this.mutables : this.immutables
    const k = req.target.toString('hex')
    const value = store.get(k)
    if (!value) return req.reply(Buffer.from('')) // empty response so initial puts can still find nodes
    const response = mutable ? cenc.encode(messages.mutableRes, value) : value
    return req.reply(response)
  }

  onput (req, { mutable }) {
    if (!req.target || !req.value) return req.reply(null)
    const store = mutable ? this.mutables : this.immutables
    if (mutable === false) {
      const k = req.target.toString('hex')
      store.set(k, req.value)
      return req.reply(null)
    }
    const { seq, value, signature, salt } = cenc.decode(messages.mutableRes, req.value)
    if (!value || !signature) return req.reply(null)
    const publicKey = req.target
    const key = salt
      ? publicKey.toString('hex') + salt.toString('hex')
      : publicKey.toString('hex')
    const local = store.get(key)
    const msg = hypersign.signable(value, { salt, seq })
    const verified = sodium.crypto_sign_verify_detached(signature, msg, publicKey)

    if (verified === false) return // timeout
    if (local) {
      if (local.value && local.seq === seq && Buffer.compare(value, local.value) !== 0) {
        return req.error(INVALID_SEQ)
      }
      if (seq <= local.seq) return req.error(SEQ_TOO_LOW)
    }

    store.set(key, { value, salt, signature, seq })
    return req.reply(null)
  }

  onlookup (req) {
    if (!req.target) return req.reply(null)

    const k = req.target.toString('hex')
    const records = this.records.get(k, 20)
    const fwd = this.forwards.get(k)

    if (fwd && records.length < 20) records.push(fwd.record)

    req.reply(records.length ? cenc.encode(rawArray, records) : null)
  }

  onannounce (req) {
    if (!req.target || !req.token || !req.value) return

    let m = null

    try {
      m = cenc.decode(messages.announce, req.value)
    } catch {
      return
    }

    const now = Date.now()

    if (now > m.timestamp + SIGNATURE_TIMEOUT || now < m.timestamp - SIGNATURE_TIMEOUT) {
      return
    }

    const signable = m.origin
      ? annSignable(req.target, m, req.from, req.to)
      : annSignable(req.target, m, null, null)

    if (!sodium.crypto_sign_verify_detached(m.signature, signable, m.publicKey)) {
      return
    }

    if (m.nodes.length > 3) m.nodes = m.nodes.slice(0, 3)

    sodium.crypto_generichash(TMP, m.publicKey)

    const k = req.target.toString('hex')
    const announceSelf = m.origin && TMP.equals(req.target)
    const record = cenc.encode(messages.record, m)

    if (announceSelf) {
      this.forwards.set(k, { from: req.from, record })
      this.records.remove(k, m.publicKey)
    } else {
      this.records.add(k, m.publicKey, record)
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  unannounce (target, publicKey) {
    const k = target.toString('hex')
    sodium.crypto_generichash(TMP, publicKey)

    if (TMP.equals(target)) this.forwards.delete(k)
    this.records.remove(k, publicKey)
  }

  onunannounce (req) {
    if (!req.target || !req.token || !req.value) return

    let m = null

    try {
      m = cenc.decode(messages.unannounce, req.value)
    } catch {
      return
    }

    const now = Date.now()

    if (now > m.timestamp + SIGNATURE_TIMEOUT || now < m.timestamp - SIGNATURE_TIMEOUT) {
      return
    }

    const signable = m.origin
      ? unannSignable(req.target, m, req.from, req.to)
      : unannSignable(req.target, m, null, null)

    if (!sodium.crypto_sign_verify_detached(m.signature, signable, m.publicKey)) {
      return
    }

    sodium.crypto_generichash(TMP, m.publicKey)

    const k = req.target.toString('hex')
    const announceSelf = m.origin && TMP.equals(req.target)

    if (announceSelf) this.forwards.delete(k)
    this.records.remove(k, m.publicKey)

    req.reply(null, { token: false, closerNodes: false })
  }

  onconnect (req) {
    if (!req.target) return

    const fwd = this.forwards && this.forwards.get(req.target.toString('hex'))

    if (!fwd || !req.value) {
      req.reply(null, { token: false })
      return
    }

    let value = null

    try {
      const m = cenc.decode(messages.connect, req.value)

      sodium.crypto_generichash(m.relayAuth, cenc.encode(messages.peerIPv4, req.from), m.relayAuth)
      value = cenc.encode(messages.connectRelay, { noise: m.noise, relayPort: req.from.port, relayAuth: m.relayAuth })
    } catch {
      return
    }

    this.dht.request(req.target, 'relay_connect', value, fwd.from, { retry: false }).then(onreply, noop)

    function onreply (res) {
      let value = null

      try {
        const m = cenc.decode(messages.connect, res.value)
        const relay = { host: fwd.from.host, port: res.from.port }

        sodium.crypto_generichash(m.relayAuth, cenc.encode(messages.peerIPv4, relay), m.relayAuth)
        value = cenc.encode(messages.connectRelay, { noise: m.noise, relayPort: relay.port, relayAuth: m.relayAuth })
      } catch {
        return
      }

      req.reply(value, { token: true, closerNodes: false })
    }
  }

  onholepunch (req) {
    if (!req.target) return

    const fwd = this.forwards && this.forwards.get(req.target.toString('hex'))

    if (!fwd || !req.value || !req.token) {
      req.reply(null, { token: false })
      return
    }

    this.dht.request(req.target, 'relay_holepunch', req.value, fwd.from, { retry: false }).then(onreply, noop)

    function onreply (res) {
      req.reply(res.value, { token: false, closerNodes: false })
    }
  }

  destroy () {
    this.records.destroy()
    this.forwards.destroy()
  }

  static signAnnounce (target, m, from, to, secretKey) {
    const signature = Buffer.allocUnsafe(64)
    sodium.crypto_sign_detached(signature, annSignable(target, m, from, to), secretKey)
    return signature
  }

  static signUnannounce (target, m, from, to, secretKey) {
    const signature = Buffer.allocUnsafe(64)
    sodium.crypto_sign_detached(signature, unannSignable(target, m, from, to), secretKey)
    return signature
  }
}

function annSignable (target, ann, from, to) {
  const state = { start: 0, end: 0, buffer: Buffer.allocUnsafe(96) }

  cenc.fixed32.encode(state, target)
  cenc.uint.encode(state, ann.timestamp)
  messages.peerIPv4Array.encode(state, ann.nodes)

  if (from) {
    messages.peerIPv4.encode(state, from)
    messages.peerIPv4.encode(state, to)
  }

  const out = state.buffer.subarray(0, 32)
  sodium.crypto_generichash(out, state.buffer.subarray(0, state.start), NS_ANNOUNCE)
  return out
}

function unannSignable (target, unann, from, to) {
  const state = { start: 0, end: 0, buffer: Buffer.allocUnsafe(96) }

  cenc.fixed32.encode(state, target)
  cenc.uint.encode(state, unann.timestamp)

  if (from) {
    messages.peerIPv4.encode(state, from)
    messages.peerIPv4.encode(state, to)
  }

  const out = state.buffer.subarray(0, 32)
  sodium.crypto_generichash(out, state.buffer.subarray(0, state.start), NS_UNANNOUNCE)
  return out
}

function noop () {}
