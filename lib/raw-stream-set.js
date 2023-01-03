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

    const stream = this._dht.udx.createStream(id, opts)
    this._streams.set(id, stream)

    stream.on('close', onclose)

    return stream

    function onclose () {
      self._streams.delete(id)
    }
  }

  async destroy () {
    const destroying = []

    for (const stream of this._streams.values()) {
      destroying.push(new Promise((resolve) => stream
        .once('close', resolve)
        .destroy()
      ))
    }

    await Promise.allSettled(destroying)
  }
}
