const { DHT } = require('dht-rpc')
const recordCache = require('record-cache')
const { PeersInput, PeersOutput } = require('./messages')
const peers = require('ipv4-peers')

const DEFAULT_BOOTSTRAP = [
  'bootstrap1.hyperdht.org:49737',
  'bootstrap2.hyperdht.org:49737',
  'bootstrap3.hyperdht.org:49737'
]

module.exports = opts => new HyperDHT(opts)

class HyperDHT extends DHT {
  constructor (opts) {
    if (!opts) opts = {}
    if (opts.bootstrap === undefined) opts.bootstrap = DEFAULT_BOOTSTRAP

    super(opts)

    const peers = recordCache({
      maxSize: 65536,
      maxAge: 12 * 60 * 1000
    })

    this._peers = peers

    const onpeers = this._onpeers.bind(this)

    this.once('close', peers.destroy.bind(peers))
    this.command('peers', {
      inputEncoding: PeersInput,
      outputEncoding: PeersOutput,
      update: onpeers,
      query: onpeers
    })
  }

  lookup (key, opts, cb) {
    if (typeof opts === 'function') return this.lookup(key, null, opts)
    if (!opts) opts = {}

    const query = {
      port: opts.port,
      localAddress: encodeAddress(opts.localAddress)
    }

    return this.query('peers', key, opts, cb).map(mapPeers.bind(null, query.localAddress))
  }

  announce (key, opts, cb) {
    if (typeof opts === 'function') return this.announce(key, null, opts)
    if (!opts) opts = {}

    const ann = {
      port: opts.port,
      localAddress: encodeAddress(opts.localAddress)
    }

    return this.queryAndUpdate('peers', key, ann, cb).map(mapPeers.bind(null, ann.localAddress))
  }

  unannounce (key, opts, cb) {
    if (typeof opts === 'function') return this.unannounce(key, null, opts)
    if (!opts) opts = {}

    const ann = {
      port: opts.port,
      localAddress: encodeAddress(opts.localAddress),
      unannounce: true
    }

    this.update('peers', key, ann, cb)
  }

  _onpeers (query, cb) {
    const value = query.value || {}
    const from = {
      port: value.port || query.node.port,
      host: query.node.host
    }

    if (!(from.port > 0 && from.port < 65536)) return cb(new Error('Invalid port'))

    const localRecord = value.localAddress
    const remoteRecord = peers.encode([ from ])

    const remoteCache = query.target.toString('hex')
    const localCache = localRecord &&
      remoteCache + '@local.' + localRecord.slice(0, 2).toString('hex')

    const localSuffix = localRecord && localRecord.slice(2)

    if (query.type === DHT.QUERY) {
      const local = localCache ? filter(this._peers.get(localCache, 64), localSuffix) : []
      const remote = filter(this._peers.get(remoteCache, 128 - local.length), remoteRecord)
      this.emit('lookup', query.target, from)

      return cb(null, {
        peers: remote.length ? Buffer.concat(remote) : null,
        localPeers: local.length ? Buffer.concat(local) : null
      })
    }

    if (value.unannounce) {
      if (remoteRecord) this._peers.remove(remoteCache, remoteRecord)
      if (localRecord) this._peers.remove(localCache, localSuffix)
      this.emit('unannounce', query.target, from)
    } else {
      if (remoteRecord) this._peers.add(remoteCache, remoteRecord)
      if (localRecord) this._peers.add(localCache, localSuffix)
      this.emit('announce', query.target, from)
    }

    cb(null, null)
  }
}

function encodeAddress (addr) {
  return addr ? peers.encode([ addr ]) : null
}

function filter (list, item) {
  if (!item) return list

  for (var i = 0; i < list.length; i++) {
    if (list[i].equals(item)) {
      list[i] = list[list.length - 1]
      list.pop()
      break
    }
  }

  return list
}

function mapPeers (prefix, data) {
  const v = data.value
  if (!v || (!v.peers && !v.localPeers)) return null

  try {
    return {
      node: data.node,
      peers: v.peers && peers.decode(v.peers),
      localPeers: prefix && v.localPeers && decodeLocalPeers(prefix, v.localPeers)
    }
  } catch (err) {
    return null
  }
}

function decodeLocalPeers (prefix, buf) {
  const host = prefix[0] + '.' + prefix[1] + '.'
  const peers = []

  if (buf.length & 3) return null

  for (var i = 0; i < buf.length; i += 4) {
    const port = buf.readUInt16BE(i + 2)
    if (!port) return null
    peers.push({
      host: host + buf[i] + '.' + buf[i + 1],
      port
    })
  }

  return peers
}
