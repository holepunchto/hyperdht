const { DHT } = require('dht-rpc')
const recordCache = require('record-cache')
const { Input, Output } = require('./messages')
const peers = require('ipv4-peers')

module.exports = opts => new HyperDHT(opts)

class HyperDHT extends DHT {
  constructor (opts) {
    super(opts)

    const cache = recordCache({
      maxSize: 65536,
      maxAge: 12 * 60 * 1000
    })

    this._cache = cache
    this.once('close', cache.destroy.bind(cache))

    this.command('peers', {
      inputEncoding: Input,
      outputEncoding: Output,
      update: (query, cb) => cb(null, runPeers(this, query.value.type, query)),
      query: (query, cb) => cb(null, runPeers(this, 0, query))
    })
  }

  lookup (key, query, cb) {
    if (typeof query === 'function') return this.lookup(key, null, query)
    if (!query) query = {}
    return this.query('peers', key, query, cb)
  }

  announce (key, ann, cb) {
    if (typeof ann === 'function') return this.announce(key, null, ann)
    if (!ann) ann = {}
    ann.type = 1
    return this.queryAndUpdate('peers', key, ann, cb)
  }

  unannounce (key, ann, cb) {
    if (typeof ann === 'function') return this.unannounce(key, null, ann)
    if (!ann) ann = {}
    ann.type = 2
    this.update('peers', key, ann, cb)
  }
}

function runPeers (self, type, query) {
  const value = query.value || {}
  const from = {
    port: value.port || query.node.port,
    host: query.node.host
  }

  const localRecord = value.localAddress
  const remoteRecord = peers.encode([ from ])

  const remoteCache = query.target.toString('hex')
  const localCache = localRecord &&
    remoteCache + '@local.' + localRecord.slice(0, 2).toString('hex')

  switch (type) {
    case 0:
      const local = localCache ? filter(self._cache.get(localCache, 64), localRecord) : []
      const remote = filter(self._cache.get(remoteCache, 128 - local.length), remoteRecord)
      self.emit('lookup', query.target, from)
      return {
        peers: remote.length ? Buffer.concat(remote) : null,
        localPeers: local.length ? Buffer.concat(local) : null
      }

    case 1:
      if (remoteRecord) self._cache.add(remoteCache, remoteRecord)
      if (localRecord) self._cache.add(localCache, localRecord)
      self.emit('announce', query.target, from)
      return null

    case 2:
      if (remoteRecord) self._cache.remove(remoteCache, remoteRecord)
      if (localRecord) self._cache.remove(localCache, localRecord)
      self.emit('unannounce', query.target, from)
      return null
  }

  return null
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
