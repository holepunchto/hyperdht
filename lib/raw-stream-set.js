module.exports = class RawStreamSet {
  constructor (dht) {
    this._dht = dht

    this._streams = new Map()
  }

  add (opts) {
    const self = this

    let id
    while (true) {
      id = (Math.random() * 0x100000000) >>> 0
      if (this._streams.has(id)) continue
      break
    }

    const stream = this._dht._udx.createStream(id, opts)
    this._streams.set(id, stream)

    stream
      .on('close', onclose)
      .on('connect', onconnect)

    return stream

    function onclose () {
      self._streams.delete(id)
    }

    async function onconnect () {
      const {
        remoteHost: host,
        remotePort: port
      } = stream

      for (let mtu = 1400; mtu > 1200; mtu -= 100) {
        try {
          await self._dht.ping({ host, port }, { size: mtu - 12 /* overhead */ })
          stream.setMTU(mtu)
          break
        } catch {}
      }
    }
  }
}
