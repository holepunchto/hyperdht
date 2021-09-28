const Sampler = require('nat-sampler')

const UNKNOWN = 0
const OPEN = 1
const CONSISTENT = 2
const RANDOM = 3

module.exports = class Nat {
  constructor (dht, socket) {
    this.dht = dht
    this.socket = socket

    this._visited = new Map()
    this._resolve = null
    this._minSamples = 4
    this._sampler = new Sampler()
    this._autoSampling = false

    this.analyzing = new Promise((resolve) => { this._resolve = resolve })
  }

  get type () {
    if (this.dht.firewalled === false) return OPEN

    if (this._sampler.size >= this._minSamples) {
      return this._sampler.port ? CONSISTENT : RANDOM
    }

    if (this._sampler.size === 3 && this._sampler.port) {
      return CONSISTENT
    }

    // TODO: if a !== b !== c also return random

    return RANDOM
  }

  get address () {
    const host = this._sampler.host
    return host ? { host, port: this._sampler.port } : null
  }

  destroy () {
    this._autoSampling = true
    this._minSamples = 0
    this._resolve()
  }

  autoSample (retry = true) {
    if (this._autoSampling) return
    this._autoSampling = true

    const self = this
    const socket = this.socket
    const maxPings = this._minSamples

    let skip = this.dht.nodes.length >= 8 ? 5 : 0
    let pending = 0

    // TODO: it would be best to pick the nodes to help us based on latency to us
    // That should reduce connect latency in general. We should investigate tracking that later on.
    for (let node = this.dht.nodes.latest; node && this._sampler.size + pending < maxPings; node = node.prev) {
      if (skip > 0) {
        skip--
        continue
      }

      const ref = node.host + ':' + node.port

      if (this._visited.has(ref)) continue
      this._visited.set(ref, 1)

      pending++
      this.dht.request({ token: null, command: 'ping', target: null, value: null }, node, { socket, retry: false })
        .then(onpong, onskip)
    }

    pending++
    onskip()

    function onpong (res) {
      self.add(res.to, res.from)
      onskip()
    }

    function onskip () {
      if (--pending === 0 && self._sampler.size < self._minSamples) {
        if (retry) {
          self._autoSampling = false
          self.autoSample(false)
          return
        }
        self._resolve()
      }
    }
  }

  add (addr, from) {
    const ref = from.host + ':' + from.port

    if (this._visited.get(ref) === 2) return false
    this._visited.set(ref, 2)

    this._sampler.add(addr.host, addr.port)

    if (this._sampler.size === 3 && this._sampler.port !== 0) {
      this._resolve()
    } else if (this._sampler.size >= this._minSamples) {
      this._resolve()
    }
  }
}
