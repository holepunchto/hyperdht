const { FIREWALL } = require('../lib/constants')

module.exports = class Nat {
  constructor (dht, session, socket) {
    this._samplesHost = []
    this._samplesFull = []
    this._visited = new Map()
    this._resolve = null
    this._minSamples = 4
    this._autoSampling = false

    this.dht = dht
    this.session = session
    this.socket = socket

    this.sampled = 0
    this.firewall = dht.firewalled ? FIREWALL.UNKNOWN : FIREWALL.OPEN
    this.addresses = null

    this.analyzing = new Promise((resolve) => { this._resolve = resolve })
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

    // TODO 2: try to pick nodes with different IPs as well, as that'll help multi IP cell connections...
    // If we expose this from the nat sampler then the DHT should be able to help us filter out scams as well...

    for (let node = this.dht.nodes.latest; node && this.sampled + pending < maxPings; node = node.prev) {
      if (skip > 0) {
        skip--
        continue
      }

      const ref = node.host + ':' + node.port

      if (this._visited.has(ref)) continue
      this._visited.set(ref, 1)

      pending++
      this.session.ping(node, { socket, retry: false }).then(onpong, onskip)
    }

    pending++
    onskip()

    function onpong (res) {
      self.add(res.to, res.from)
      onskip()
    }

    function onskip () {
      if (--pending === 0 && self.sampled < self._minSamples) {
        if (retry) {
          self._autoSampling = false
          self.autoSample(false)
          return
        }
        self._resolve()
      }
    }
  }

  destroy () {
    this._autoSampling = true
    this._minSamples = 0
    this._resolve()
  }

  unfreeze () {
    this.frozen = false
    this._updateFirewall()
    this._updateAddresses()
  }

  freeze () {
    this.frozen = true
  }

  _updateFirewall () {
    if (!this.dht.firewalled) {
      this.firewall = FIREWALL.OPEN
      return
    }

    if (this.sampled < 3) return

    const max = this._samplesFull[0].hits

    if (max >= 3) {
      this.firewall = FIREWALL.CONSISTENT
      return
    }

    if (max === 1) {
      this.firewall = FIREWALL.RANDOM
      return
    }

    // else max === 2

    // 1 host, >= 4 total samples ie, 2 bad ones -> random
    if (this._samplesHost.length === 1 && this.sampled > 3) {
      this.firewall = FIREWALL.RANDOM
      return
    }

    // double hit on two different ips -> assume consistent
    if (this._samplesHost.length > 1 && this._samplesFull[1].hits > 1) {
      this.firewall = FIREWALL.CONSISTENT
      return
    }

    // (4 is just means - all the samples we expect) - no decision - assume random
    if (this.sampled > 4) {
      this.firewall = FIREWALL.RANDOM
    }
  }

  _updateAddresses () {
    if (this.firewall === FIREWALL.UNKNOWN) {
      this.addresses = null
      return
    }

    if (this.firewall === FIREWALL.RANDOM) {
      this.addresses = [this._samplesHost[0]]
      return
    }

    if (this.firewall === FIREWALL.CONSISTENT) {
      this.addresses = []
      for (const addr of this._samplesFull) {
        if (addr.hits >= 2 || this.addresses.length < 2) this.addresses.push(addr)
      }
    }
  }

  update () {
    if (this.dht.firewalled && this.firewall === FIREWALL.OPEN) {
      this.firewall = FIREWALL.UNKNOWN
    }
    this._updateFirewall()
    this._updateAddresses()
  }

  add (addr, from) {
    const ref = from.host + ':' + from.port

    if (this._visited.get(ref) === 2) return
    this._visited.set(ref, 2)

    addSample(this._samplesHost, addr.host, 0)
    addSample(this._samplesFull, addr.host, addr.port)

    if ((++this.sampled >= 3 || !this.dht.firewalled) && !this.frozen) {
      this.update()
    }

    if ((this.firewall === FIREWALL.CONSISTENT || this.firewall === FIREWALL.OPEN)) {
      this._resolve()
    } else if (this.sampled >= this._minSamples) {
      this._resolve()
    }
  }
}

function addSample (samples, host, port) {
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]

    if (s.port !== port || s.host !== host) continue
    s.hits++

    for (; i > 0; i--) {
      const prev = samples[i - 1]
      if (prev.hits >= s.hits) return
      samples[i - 1] = s
      samples[i] = prev
    }

    return
  }

  samples.push({
    host,
    port,
    hits: 1
  })
}
